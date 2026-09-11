/**
 * Recurrence expansion and materialization.
 *
 * Occurrences are MATERIALIZED as real task rows, not computed on read. The
 * reason is history: if occurrences were derived from the current rule, moving
 * standup from 09:00 to 10:00 would retroactively rewrite every past day to
 * claim it was always at 10:00. Old timelines have to be a record, not a
 * function of today's settings.
 *
 * Expansion runs here rather than in Postgres because a mature RRULE
 * implementation already exists in JS. The unique index on
 * (recurrence_id, occurrence_date) is the entire concurrency-control story —
 * running this on every app open, from both devices at once, is safe.
 */

import { RRule } from 'rrule'
import { supabase } from './supabase'
import { ranksBetween } from './rank'
import { addDays, todayIn, zonedInstant } from './time'
import { MATERIALIZE_HORIZON_DAYS } from './constants'
import type { DateOnly, Recurrence, Task } from './types'

export interface Occurrence {
  date: DateOnly
  /** null => this occurrence is a SEQUENCE task, not a scheduled block. */
  dueAt: Date | null
}

const asDay = (d: Date): DateOnly => d.toISOString().slice(0, 10)

/**
 * Occurrence dates in [from, to], inclusive.
 *
 * The rule is expanded as floating local dates: `rrule` is driven entirely in
 * UTC and the resulting Dates are read back as calendar dates only. The
 * wall-clock time is applied afterwards via zonedInstant, which is what keeps
 * "09:00" meaning 09:00 across a DST boundary.
 */
export function expandOccurrences(
  rec: Pick<Recurrence, 'rrule' | 'dtstart' | 'until' | 'time_of_day' | 'timezone'>,
  from: DateOnly,
  to: DateOnly,
): Occurrence[] {
  const [dy, dm, dd] = rec.dtstart.split('-').map(Number)
  const rule = new RRule({
    ...RRule.parseString(rec.rrule),
    dtstart: new Date(Date.UTC(dy, dm - 1, dd)),
  })

  const hardEnd = rec.until && rec.until < to ? rec.until : to
  if (hardEnd < from) return []

  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = hardEnd.split('-').map(Number)

  return rule
    .between(
      new Date(Date.UTC(fy, fm - 1, fd)),
      new Date(Date.UTC(ty, tm - 1, td)),
      true, // inclusive
    )
    .map((d) => {
      const date = asDay(d)
      return {
        date,
        dueAt: rec.time_of_day
          ? zonedInstant(date, rec.time_of_day, rec.timezone)
          : null,
      }
    })
}

/**
 * Generate missing task rows for one recurrence, forward only.
 *
 * Deliberately never backfills. If the app goes unopened for a month, that
 * month's timelines show no scheduled occurrences — which is correct.
 * Backfilling would manufacture a month of un-done tasks that were never
 * actually planned.
 *
 * Returns the number of rows inserted (0 when already up to date).
 */
export async function materialize(
  rec: Recurrence,
  horizonDays: number = MATERIALIZE_HORIZON_DAYS,
): Promise<number> {
  if (rec.deleted_at) return 0

  const today = todayIn(rec.timezone)
  const from = rec.materialized_until
    ? maxDay(addDays(rec.materialized_until, 1), today)
    : maxDay(rec.dtstart, today)
  const to = addDays(today, horizonDays)
  if (from > to) return 0

  const occurrences = expandOccurrences(rec, from, to)
  if (occurrences.length === 0) {
    await setMaterializedUntil(rec.id, to)
    return 0
  }

  // Every occurrence gets its own rank, scheduled ones included: rank is the
  // tiebreak between blocks sharing a due_at, which is what gives the
  // side-by-side lanes a stable order. Sequence occurrences additionally use it
  // as their position in the manual order, appended after everything present.
  const ranks = await ranksAfterSequence(occurrences.length)

  const rows = occurrences.map((o, i) => ({
    id: crypto.randomUUID(),
    title: rec.title,
    notes: rec.notes,
    due_at: o.dueAt ? o.dueAt.toISOString() : null,
    estimated_minutes: rec.estimated_minutes,
    rank: ranks[i],
    completed_at: null,
    deleted_at: null,
    recurrence_id: rec.id,
    occurrence_date: o.date,
  }))

  // ignoreDuplicates + the unique index makes this idempotent and race-safe.
  const { data, error } = await supabase
    .from('tasks')
    .upsert(rows, {
      onConflict: 'recurrence_id,occurrence_date',
      ignoreDuplicates: true,
    })
    .select('id')
  if (error) throw error

  await setMaterializedUntil(rec.id, to)
  return data?.length ?? 0
}

/** Materialize every active recurrence. Safe to call on app open. */
export async function materializeAll(): Promise<number> {
  const { data, error } = await supabase
    .from('recurrences')
    .select('*')
    .is('deleted_at', null)
  if (error) throw error

  let inserted = 0
  for (const rec of data as Recurrence[]) inserted += await materialize(rec)
  return inserted
}

/**
 * "Edit all future" — untouched future occurrences are regenerated; past,
 * completed, detached, and trailed ones are left exactly as they were.
 */
export async function rewriteFuture(rec: Recurrence): Promise<number> {
  const today = todayIn(rec.timezone)

  const { data: candidates, error } = await supabase
    .from('tasks')
    .select('id, time_entries(id)')
    .eq('recurrence_id', rec.id)
    .gte('occurrence_date', today)
    .eq('detached', false)
    .is('completed_at', null)
    .is('deleted_at', null)
  if (error) throw error

  type WithEntries = { id: string; time_entries: { id: string }[] }
  const disposable = (candidates as unknown as WithEntries[])
    .filter((t) => t.time_entries.length === 0)
    .map((t) => t.id)

  if (disposable.length > 0) {
    const { error: delError } = await supabase
      .from('tasks')
      .delete()
      .in('id', disposable)
    if (delError) throw delError
  }

  await setMaterializedUntil(rec.id, addDays(today, -1))
  return materialize({ ...rec, materialized_until: addDays(today, -1) })
}

// ---------------------------------------------------------------------------

const maxDay = (a: DateOnly, b: DateOnly): DateOnly => (a > b ? a : b)

async function setMaterializedUntil(id: string, day: DateOnly): Promise<void> {
  const { error } = await supabase
    .from('recurrences')
    .update({ materialized_until: day })
    .eq('id', id)
  if (error) throw error
}

async function ranksAfterSequence(n: number): Promise<string[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select('rank')
    .is('due_at', null)
    .is('deleted_at', null)
    .order('rank', { ascending: false })
    .limit(1)
  if (error) throw error
  const last = (data as Pick<Task, 'rank'>[])[0]?.rank ?? null
  return ranksBetween(last, null, n)
}
