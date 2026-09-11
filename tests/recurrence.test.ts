/**
 * Recurrence expansion and materialization.
 *
 * expandOccurrences is pure; materialize hits the live project. Both are
 * untested code paths, and the DST behaviour in particular is only observable
 * twice a year in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { supabase } from '../src/lib/supabase'
import { getSequence } from '../src/lib/db'
import { expandOccurrences, materialize, rewriteFuture } from '../src/lib/recurrence'
import { addDays, todayIn } from '../src/lib/time'
import type { Recurrence } from '../src/lib/types'

const TZ = 'America/New_York'
const creds = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const MARK = `[rtest ${Date.now()}]`
const recIds: string[] = []
let uid = ''

async function mkRecurrence(over: Partial<Recurrence> = {}): Promise<Recurrence> {
  const id = crypto.randomUUID()
  const row = {
    id,
    user_id: uid,
    title: `${MARK} ${over.title ?? 'standup'}`,
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    dtstart: todayIn(TZ),
    timezone: TZ,
    time_of_day: '09:00:00',
    estimated_minutes: 15,
    ...over,
  }
  const { data, error } = await supabase.from('recurrences').insert(row).select().single()
  if (error) throw error
  recIds.push(id)
  return data
}

beforeAll(async () => {
  const { error } = await supabase.auth.signInWithPassword({
    email: creds.TEST_USER_EMAIL,
    password: creds.TEST_USER_PASSWORD,
  })
  if (error) throw new Error(`sign-in failed: ${error.message}`)
  uid = (await supabase.auth.getUser()).data.user!.id
})

afterAll(async () => {
  if (recIds.length) {
    const { data: spawned } = await supabase
      .from('tasks')
      .select('id')
      .in('recurrence_id', recIds)
    const ids = (spawned ?? []).map((t) => t.id)
    if (ids.length) {
      await supabase.from('time_entries').delete().in('task_id', ids)
      await supabase.from('tasks').delete().in('id', ids)
    }
    await supabase.from('recurrences').delete().in('id', recIds)
  }
  await supabase.auth.signOut()
})

// --------------------------------------------------------------- pure

describe('expandOccurrences', () => {
  const weekly = {
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    dtstart: '2026-06-01',
    until: null,
    time_of_day: '09:00:00',
    timezone: TZ,
  }

  it('expands to the matching weekdays only', () => {
    const occ = expandOccurrences(weekly, '2026-06-01', '2026-06-30')
    expect(occ.map((o) => o.date)).toEqual([
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
      '2026-06-22',
      '2026-06-29',
    ])
  })

  it('stops at until', () => {
    const occ = expandOccurrences({ ...weekly, until: '2026-06-10' }, '2026-06-01', '2026-06-30')
    expect(occ.map((o) => o.date)).toEqual(['2026-06-01', '2026-06-08'])
  })

  it('returns nothing for a range before dtstart', () => {
    expect(expandOccurrences(weekly, '2026-05-01', '2026-05-20')).toEqual([])
  })

  it('gives sequence occurrences a null dueAt when there is no time of day', () => {
    const occ = expandOccurrences({ ...weekly, time_of_day: null }, '2026-06-01', '2026-06-09')
    expect(occ).toHaveLength(2)
    expect(occ.every((o) => o.dueAt === null)).toBe(true)
  })

  it('anchors the wall-clock time across a DST boundary', () => {
    // 2026-03-08 is US spring-forward. 09:00 local is 14:00Z before and 13:00Z after.
    const occ = expandOccurrences(
      { ...weekly, rrule: 'FREQ=DAILY', dtstart: '2026-03-06' },
      '2026-03-06',
      '2026-03-10',
    )
    const byDate = Object.fromEntries(occ.map((o) => [o.date, o.dueAt!.toISOString()]))
    expect(byDate['2026-03-07']).toBe('2026-03-07T14:00:00.000Z')
    expect(byDate['2026-03-09']).toBe('2026-03-09T13:00:00.000Z')
  })
})

// ------------------------------------------------------- against the db

describe('materialize', () => {
  it('creates occurrence rows and records how far it went', async () => {
    const rec = await mkRecurrence({ rrule: 'FREQ=DAILY', title: 'daily' })
    const n = await materialize(rec, 6)
    expect(n).toBeGreaterThan(0)

    const { data: rows } = await supabase
      .from('tasks')
      .select('occurrence_date, due_at, rank, recurrence_id')
      .eq('recurrence_id', rec.id)
      .order('occurrence_date')
    expect(rows!.length).toBe(n)
    expect(rows!.every((r) => r.due_at !== null)).toBe(true)
    expect(new Set(rows!.map((r) => r.rank)).size).toBe(rows!.length)

    const { data: after } = await supabase
      .from('recurrences')
      .select('materialized_until')
      .eq('id', rec.id)
      .single()
    expect(after!.materialized_until).toBe(addDays(todayIn(TZ), 6))
  })

  it('is idempotent — a second run inserts nothing', async () => {
    const rec = await mkRecurrence({ rrule: 'FREQ=DAILY', title: 'idempotent' })
    const first = await materialize(rec, 4)
    expect(first).toBeGreaterThan(0)

    const { data: reread } = await supabase
      .from('recurrences')
      .select('*')
      .eq('id', rec.id)
      .single()
    // re-running from a fresh read is the real-world case: app opens twice
    const second = await materialize({ ...reread!, materialized_until: null }, 4)
    expect(second).toBe(0)

    const { count } = await supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('recurrence_id', rec.id)
    expect(count).toBe(first)
  })

  it('never backfills the past', async () => {
    const rec = await mkRecurrence({
      rrule: 'FREQ=DAILY',
      title: 'no backfill',
      dtstart: addDays(todayIn(TZ), -30),
    })
    await materialize(rec, 3)

    const { data: rows } = await supabase
      .from('tasks')
      .select('occurrence_date')
      .eq('recurrence_id', rec.id)
      .order('occurrence_date')
    expect(rows!.length).toBeGreaterThan(0)
    expect(rows![0].occurrence_date! >= todayIn(TZ)).toBe(true)
  })

  it('creates sequence tasks when the rule has no time of day', async () => {
    const rec = await mkRecurrence({
      rrule: 'FREQ=DAILY',
      title: 'sequence rule',
      time_of_day: null,
      estimated_minutes: null,
    })
    await materialize(rec, 3)

    const { data: rows } = await supabase
      .from('tasks')
      .select('due_at, rank')
      .eq('recurrence_id', rec.id)
    expect(rows!.length).toBeGreaterThan(0)
    expect(rows!.every((r) => r.due_at === null)).toBe(true)
    expect(new Set(rows!.map((r) => r.rank)).size).toBe(rows!.length)
  })
})

describe('rewriteFuture', () => {
  it('moves untouched future occurrences to the new time', async () => {
    const rec = await mkRecurrence({ rrule: 'FREQ=DAILY', title: 'movable' })
    await materialize(rec, 4)

    const { data: before } = await supabase
      .from('tasks').select('due_at').eq('recurrence_id', rec.id)
    expect(before!.length).toBeGreaterThan(0)

    await supabase.from('recurrences')
      .update({ time_of_day: '15:00:00' }).eq('id', rec.id)
    const { data: moved } = await supabase
      .from('recurrences').select('*').eq('id', rec.id).single()
    await rewriteFuture(moved!)

    const { data: after } = await supabase
      .from('tasks').select('due_at').eq('recurrence_id', rec.id)
    expect(after!.length).toBeGreaterThan(0)
    // 15:00 in New York, whatever offset applies on the day
    for (const row of after!) {
      const hhmm = new Date(row.due_at!).toLocaleTimeString('en-GB', {
        timeZone: TZ, hour: '2-digit', minute: '2-digit',
      })
      expect(hhmm).toBe('15:00')
    }
  })

  it('leaves a completed occurrence untouched', async () => {
    const rec = await mkRecurrence({ rrule: 'FREQ=DAILY', title: 'completed survives' })
    await materialize(rec, 4)

    const { data: rows } = await supabase
      .from('tasks').select('id, due_at, occurrence_date')
      .eq('recurrence_id', rec.id).order('occurrence_date')
    const keeper = rows![0]
    await supabase.from('tasks')
      .update({ completed_at: new Date().toISOString() }).eq('id', keeper.id)

    await supabase.from('recurrences')
      .update({ time_of_day: '16:00:00' }).eq('id', rec.id)
    const { data: moved } = await supabase
      .from('recurrences').select('*').eq('id', rec.id).single()
    await rewriteFuture(moved!)

    const { data: still } = await supabase
      .from('tasks').select('id, due_at, completed_at').eq('id', keeper.id).maybeSingle()
    expect(still).not.toBeNull()
    expect(still!.due_at).toBe(keeper.due_at)
    expect(still!.completed_at).not.toBeNull()
  })

  it('leaves an occurrence that has logged time untouched', async () => {
    // sequence occurrences (no time_of_day) are the trailable ones
    const rec = await mkRecurrence({
      rrule: 'FREQ=DAILY', title: 'trailed survives',
      time_of_day: null, estimated_minutes: null,
    })
    await materialize(rec, 4)

    const { data: rows } = await supabase
      .from('tasks').select('id').eq('recurrence_id', rec.id).order('occurrence_date')
    const keeper = rows![0]
    const { error: entryErr } = await supabase.from('time_entries').insert({
      id: crypto.randomUUID(), user_id: uid, task_id: keeper.id,
      started_at: new Date(Date.now() - 7200_000).toISOString(),
      ended_at: new Date(Date.now() - 3600_000).toISOString(),
    })
    expect(entryErr).toBeNull()

    await supabase.from('recurrences').update({ title: `${MARK} renamed` }).eq('id', rec.id)
    const { data: moved } = await supabase
      .from('recurrences').select('*').eq('id', rec.id).single()
    await rewriteFuture(moved!)

    const { data: still } = await supabase
      .from('tasks').select('id').eq('id', keeper.id).maybeSingle()
    expect(still).not.toBeNull()
  })
})

describe('sequence occurrences are scoped to their own date', () => {
  it('shows only today, not the whole materialized horizon', async () => {
    const rec = await mkRecurrence({
      rrule: 'FREQ=DAILY',
      title: 'daily habit',
      time_of_day: null,
      estimated_minutes: null,
    })
    const made = await materialize(rec, 10)
    expect(made).toBeGreaterThan(5)

    const scoped = await getSequence(todayIn(TZ))
    const mine = scoped.filter((t) => t.recurrence_id === rec.id)
    expect(mine).toHaveLength(1)
    expect(mine[0].occurrence_date).toBe(todayIn(TZ))

    // unscoped still returns everything, which is what flooded the pane
    const all = await getSequence()
    expect(all.filter((t) => t.recurrence_id === rec.id).length).toBe(made)
  })

  it('keeps one-off tasks visible regardless of date scoping', async () => {
    const id = crypto.randomUUID()
    await supabase.from('tasks').insert({
      id, user_id: uid, title: `${MARK} one-off`, rank: 'zz9',
    })
    const scoped = await getSequence(todayIn(TZ))
    expect(scoped.map((t) => t.id)).toContain(id)
    await supabase.from('tasks').delete().eq('id', id)
  })
})
