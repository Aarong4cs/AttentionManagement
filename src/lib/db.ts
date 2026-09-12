/**
 * Query primitives. No React, no UI concerns.
 *
 * Write-locally-first is the caller's job: every mutation here takes a
 * client-generated id so the local cache can reference the row before it exists
 * on the server.
 */

import { supabase } from './supabase'
import { rankAppend, rankBetween } from './rank'
import { clippedMs } from './time'
import { MAX_ESTIMATE_MINUTES, STALE_TIMER_HOURS } from './constants'
import type { Rank } from './rank'
import type { Block, DateOnly, Profile, Task, TimeEntry, Uuid } from './types'
import { buildBlocks, emptySnapshot, type EntryRow, type Snapshot } from './offline'

type Rank_ = Rank
export const newId = (): Uuid => crypto.randomUUID()

/**
 * A complete task row from the few fields a caller actually cares about.
 *
 * Optimistic writes need a whole Task, and spelling out every column at each
 * call site means every schema addition breaks them all. This has happened
 * three times.
 */
export function draftTask(
  fields: Pick<Task, 'id' | 'user_id' | 'title' | 'rank'> & Partial<Task>,
): Task {
  const now = new Date().toISOString()
  return {
    notes: null,
    due_at: null,
    estimated_minutes: null,
    completed_at: null,
    deleted_at: null,
    recurrence_id: null,
    occurrence_date: null,
    detached: false,
    scheduled_end: null,
    color: null,
    priority: null,
    source: null,
    external_id: null,
    external_etag: null,
    external_calendar: null,
    google_event_id: null,
    google_synced_at: null,
    created_at: now,
    updated_at: now,
    ...fields,
  }
}

// ---------------------------------------------------------------------------
// running timer
// ---------------------------------------------------------------------------

/**
 * The running timer is a row with ended_at IS NULL — never an in-memory object
 * and never a counter, so nothing is lost when iOS suspends the tab. A partial
 * unique index guarantees at most one row comes back.
 */
export async function getRunningEntry(): Promise<TimeEntry | null> {
  const { data, error } = await supabase
    .from('time_entries')
    .select('*')
    .is('ended_at', null)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw error
  return data
}

/** Elapsed ms, always derived from the stored start instant. */
export function elapsedMs(entry: TimeEntry, now: Date = new Date()): number {
  const end = entry.ended_at ? new Date(entry.ended_at) : now
  return end.getTime() - new Date(entry.started_at).getTime()
}

/** A running entry this old was almost certainly forgotten, not worked. */
export function isStale(entry: TimeEntry, now: Date = new Date()): boolean {
  if (entry.ended_at) return false
  return elapsedMs(entry, now) > STALE_TIMER_HOURS * 3_600_000
}

/** Postgres unique_violation — two devices raced to own the running timer. */
export const UNIQUE_VIOLATION = '23505'

export async function startTrail(
  taskId: Uuid,
  startedAt: Date = new Date(),
): Promise<TimeEntry> {
  return startTrailAt(newId(), taskId, startedAt)
}

/**
 * Start a trail with a caller-supplied id and start instant. Offline replay
 * needs both: the id so the local cache could already reference the row, and
 * the instant so a timer started an hour ago offline does not land as "now".
 */
export async function startTrailAt(
  id: Uuid,
  taskId: Uuid,
  startedAt: Date,
): Promise<TimeEntry> {
  const { data, error } = await supabase
    .from('time_entries')
    .insert({
      id,
      task_id: taskId,
      started_at: startedAt.toISOString(),
      ended_at: null,
      edited_at: null,
      deleted_at: null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

/**
 * Stop a running entry.
 *
 * The guard keeps this from re-closing an entry at a later time than it really
 * ended, but that means the update legitimately matches nothing — the auto-stop
 * trigger closes the entry when its task is completed, so a queued stop can
 * arrive to find the work already done. That is success, not failure: with
 * .single() it raised PGRST116, which is not a constraint violation, so the
 * offline queue treated it as retryable and stalled permanently behind it.
 */
export async function stopTrail(
  entryId: Uuid,
  endedAt: Date = new Date(),
): Promise<TimeEntry | null> {
  const { data, error } = await supabase
    .from('time_entries')
    .update({ ended_at: endedAt.toISOString() })
    .eq('id', entryId)
    .is('ended_at', null)
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}

/**
 * Resolve two entries that both claim to be running after an offline sync.
 *
 * The earlier start wins. The loser is closed at the winner's start so the two
 * don't overlap, and edited_at is set EXPLICITLY: its ended_at is going from
 * NULL, which the mark_entry_edited trigger correctly classifies as a normal
 * stop — but this end instant was reconstructed by us, not observed, so it
 * should carry the same mark as a hand-correction.
 *
 * Returns the loser so the caller can surface the collision rather than
 * resolving it silently.
 */
export async function reconcileRunningCollision(
  a: TimeEntry,
  b: TimeEntry,
): Promise<{ kept: TimeEntry; closed: TimeEntry }> {
  const [kept, loser] =
    new Date(a.started_at) <= new Date(b.started_at) ? [a, b] : [b, a]

  // The CHECK requires ended_at > started_at; if the loser started at or after
  // the winner there is no positive interval to keep, so drop it instead.
  if (new Date(loser.started_at) >= new Date(kept.started_at)) {
    const { data, error } = await supabase
      .from('time_entries')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', loser.id)
      .select()
      .single()
    if (error) throw error
    return { kept, closed: data }
  }

  const { data, error } = await supabase
    .from('time_entries')
    .update({ ended_at: kept.started_at, edited_at: new Date().toISOString() })
    .eq('id', loser.id)
    .select()
    .single()
  if (error) throw error
  return { kept, closed: data }
}

// ---------------------------------------------------------------------------
// timeline / sequence reads
// ---------------------------------------------------------------------------

/**
 * Every block intersecting [start, end). Day view is the one-column case of
 * week view — same query, narrower range.
 *
 * Two round trips for a whole week, not fourteen: the caller buckets into day
 * columns and clips each block to the column it is drawn in.
 */
export async function fetchRangeRows(
  start: Date,
  end: Date,
): Promise<{ rangeTasks: Task[]; entries: EntryRow[] }> {
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  // A scheduled block cannot be longer than MAX_ESTIMATE_MINUTES, so anything
  // overlapping `start` must begin within one day before it. This bound keeps
  // the (user_id, due_at, scheduled_end) index selective.
  const earliestDueAt = new Date(
    start.getTime() - MAX_ESTIMATE_MINUTES * 60_000,
  ).toISOString()

  const scheduled = supabase
    .from('tasks')
    .select('*')
    .is('deleted_at', null)
    .not('due_at', 'is', null)
    .lt('due_at', endIso)
    .gt('due_at', earliestDueAt)
    .gt('scheduled_end', startIso)
    .order('due_at')
    .order('rank')
    .order('id')

  // Overlap, with no lookback window on started_at. An earlier version bounded
  // started_at for index selectivity, which silently dropped any entry longer
  // than the window — including a timer left running for days. The
  // (user_id, ended_at) index makes `ended_at > start` selective instead, and
  // running entries (ended_at NULL) are covered by their own partial index.
  const trailed = supabase
    .from('time_entries')
    .select('*, tasks!inner(title, completed_at, color)')
    .is('deleted_at', null)
    .lt('started_at', endIso)
    .or(`ended_at.is.null,ended_at.gt.${startIso}`)
    .order('started_at')

  const [s, t] = await Promise.all([scheduled, trailed])
  if (s.error) throw s.error
  if (t.error) throw t.error

  type Joined = TimeEntry & {
    tasks: { title: string; completed_at: string | null; color: string | null }
  }
  const entries: EntryRow[] = (t.data as unknown as Joined[]).map((e) => {
    const { tasks, ...row } = e
    // denormalised here so a trailed block can still be drawn from cache,
    // where there is no join to re-run
    return {
      ...row,
      title: tasks.title,
      taskCompleted: tasks.completed_at !== null,
      color: tasks.color,
    }
  })

  return { rangeTasks: s.data as Task[], entries }
}

/**
 * Every block intersecting [start, end). Day view is the one-column case of
 * week view — same query, narrower range.
 *
 * Two round trips for a whole week, not fourteen: the caller buckets into day
 * columns and clips each block to the column it is drawn in.
 */
export async function blocksInRange(start: Date, end: Date): Promise<Block[]> {
  const rows = await fetchRangeRows(start, end)
  return buildBlocks({ ...emptySnapshot, ...rows })
}

/** Everything the panes need, in one pass, for caching as a unit. */
export async function fetchSnapshot(
  today: DateOnly,
  start: Date,
  end: Date,
): Promise<Snapshot> {
  const [profile, tasks, rows, running] = await Promise.all([
    getProfile(),
    getSequence(today),
    fetchRangeRows(start, end),
    getRunningEntry(),
  ])
  return {
    profile,
    tasks,
    rangeTasks: rows.rangeTasks,
    entries: rows.entries,
    running,
    fetchedAt: new Date().toISOString(),
  }
}

/** Blocks overlapping one day column, for rendering. */
export function blocksForDay(
  blocks: readonly Block[],
  dayStart: Date,
  dayEnd: Date,
  now: Date = new Date(),
): Block[] {
  return blocks.filter(
    (b) => clippedMs(b.start, b.end ?? now, dayStart, dayEnd) > 0,
  )
}

/**
 * The sequence pane. Completed tasks are NOT filtered out — they keep their
 * rank and position, struck through by the renderer.
 *
 * `today` scopes recurring occurrences to their own date. Without it a daily
 * rule dumps its whole materialized horizon into the pane at once — sixty
 * copies of "review inbox" ahead of everything real. One-off tasks have no
 * occurrence_date and are always shown.
 */
export async function getSequence(today?: DateOnly): Promise<Task[]> {
  let query = supabase
    .from('tasks')
    .select('*')
    .is('due_at', null)
    .is('deleted_at', null)
  if (today) {
    query = query.or(`recurrence_id.is.null,occurrence_date.eq.${today}`)
  }
  const { data, error } = await query
    // the manual order, and only that — see the sort in applyOps
    .order('rank')
    .order('id')
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

/**
 * A move is one row. That is the whole point of fractional ranking.
 *
 * `exact` replays an already-decided rank: the key was computed from the
 * neighbours the device could see at the time, and recomputing it now against a
 * changed list would move the task somewhere the user never asked for.
 */
export async function moveTask(
  taskId: Uuid,
  before: Rank_ | null,
  after: Rank_ | null,
  exact?: Rank_,
): Promise<Task> {
  const { data, error } = await supabase
    .from('tasks')
    .update({ rank: exact ?? rankBetween(before, after) })
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw error
  return data
}

/**
 * Completing a task also closes any running entry — but that happens in the
 * database (tasks_autostop), not here, so a completion synced from the other
 * device closes the timer too.
 */
export async function completeTask(
  taskId: Uuid,
  completedAt: Date = new Date(),
): Promise<Task | null> {
  const { data, error } = await supabase
    .from('tasks')
    .update({ completed_at: completedAt.toISOString() })
    .eq('id', taskId)
    // keeps the trigger's old.completed_at IS NULL guard meaningful. Matching
    // nothing means it was already complete, which is the desired end state.
    .is('completed_at', null)
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}

/** Soft delete. Hard DELETE is refused by the FK when entries exist. */
export async function deleteTask(taskId: Uuid): Promise<void> {
  const { error } = await supabase
    .from('tasks')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', taskId)
  if (error) throw error
}

/**
 * Manual "clear completed" for the sequence pane.
 *
 * Completed tasks keep their rank and stay in place, so the pane would grow
 * without bound; this is the release valve. Scoped to SEQUENCE tasks (due_at is
 * null) on purpose — clearing a completed *scheduled* task would erase its block
 * from past timelines, which is not what completing something should ever do.
 *
 * Soft delete, so the trailed blocks recording the work survive.
 */
export async function clearCompleted(): Promise<Uuid[]> {
  const { data, error } = await supabase
    .from('tasks')
    .update({ deleted_at: new Date().toISOString() })
    .is('due_at', null)
    .is('deleted_at', null)
    .not('completed_at', 'is', null)
    .select('id')
  if (error) throw error
  return (data ?? []).map((t) => t.id)
}

/** Append a new sequence task after everything currently in the pane. */
export async function createTask(title: string): Promise<Task> {
  const { data: existing, error: readError } = await supabase
    .from('tasks')
    .select('rank')
    .is('due_at', null)
    .is('deleted_at', null)
    .order('rank')
  if (readError) throw readError

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      id: newId(),
      title,
      rank: rankAppend((existing ?? []).map((t) => t.rank)),
    })
    .select()
    .single()
  if (error) throw error
  return data
}

/** Undo a completion. The auto-stop trigger does not reopen the closed entry. */
export async function uncompleteTask(taskId: Uuid): Promise<Task> {
  const { data, error } = await supabase
    .from('tasks')
    .update({ completed_at: null })
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw error
  return data
}

/** The signed-in user's profile. Its timezone defines where every day begins. */
export async function getProfile(): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').select('*').single()
  if (error) throw error
  return data
}

/** Insert an already-built task row, for offline replay. */
export async function createTaskRow(task: Task): Promise<Task> {
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      id: task.id,
      title: task.title,
      notes: task.notes,
      due_at: task.due_at,
      estimated_minutes: task.estimated_minutes,
      rank: task.rank,
      completed_at: task.completed_at,
      color: task.color,
      priority: task.priority,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

/** Move or resize a scheduled block: due_at is the start, the estimate the length. */
export async function rescheduleTask(
  taskId: Uuid,
  start: Date,
  minutes: number,
): Promise<Task> {
  const { data, error } = await supabase
    .from('tasks')
    .update({ due_at: start.toISOString(), estimated_minutes: minutes })
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw error
  return data
}

/**
 * Correct a trailed block's times.
 *
 * The mark_entry_edited trigger sets edited_at for this, because the new times
 * were reconstructed rather than observed, and the renderer draws such a block
 * differently. Nothing here needs to say so.
 */
export async function adjustEntry(
  entryId: Uuid,
  start: Date,
  end: Date,
): Promise<TimeEntry> {
  const { data, error } = await supabase
    .from('time_entries')
    .update({ started_at: start.toISOString(), ended_at: end.toISOString() })
    .eq('id', entryId)
    .select()
    .single()
  if (error) throw error
  return data
}

/** Soft-delete one trailed block, leaving its task alone. */
export async function deleteEntry(entryId: Uuid): Promise<void> {
  const { error } = await supabase
    .from('time_entries')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', entryId)
  if (error) throw error
}

/** Rename a task. */
export async function renameTask(taskId: Uuid, title: string): Promise<Task> {
  const { data, error } = await supabase
    .from('tasks')
    .update({ title })
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw error
  return data
}

/** Recolour a task. `null` returns it to the default. */
export async function recolorTask(
  taskId: Uuid,
  color: string | null,
): Promise<Task> {
  const { data, error } = await supabase
    .from('tasks')
    .update({ color })
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw error
  return data
}

/** Tag a task P1..P5, or `null` to clear it. */
export async function setPriority(
  taskId: Uuid,
  priority: number | null,
): Promise<Task> {
  const { data, error } = await supabase
    .from('tasks')
    .update({ priority })
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw error
  return data
}

/** Set a task's description. Empty means none, not an empty string. */
export async function setNotes(taskId: Uuid, notes: string): Promise<Task> {
  const trimmed = notes.trim()
  const { data, error } = await supabase
    .from('tasks')
    .update({ notes: trimmed === '' ? null : trimmed })
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw error
  return data
}
