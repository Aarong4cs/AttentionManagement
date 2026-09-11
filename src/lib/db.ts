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
import type { Block, Task, TimeEntry, Uuid } from './types'

type Rank_ = Rank
export const newId = (): Uuid => crypto.randomUUID()

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
  const { data, error } = await supabase
    .from('time_entries')
    .insert({
      id: newId(),
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

export async function stopTrail(
  entryId: Uuid,
  endedAt: Date = new Date(),
): Promise<TimeEntry> {
  const { data, error } = await supabase
    .from('time_entries')
    .update({ ended_at: endedAt.toISOString() })
    .eq('id', entryId)
    .is('ended_at', null) // don't silently re-close an already-stopped entry
    .select()
    .single()
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
export async function blocksInRange(start: Date, end: Date): Promise<Block[]> {
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  // A scheduled block cannot be longer than MAX_ESTIMATE_MINUTES, so anything
  // overlapping `start` must begin within one day before it. This bound keeps
  // the (user_id, due_at, scheduled_end) index selective.
  const earliestDueAt = new Date(
    start.getTime() - MAX_ESTIMATE_MINUTES * 60_000,
  ).toISOString()

  // Deleting a task erases its scheduled blocks from EVERY day, including past
  // ones — a deletion means it should not have been there. Completion does not:
  // a completed task keeps its block and is drawn struck through. Its trailed
  // blocks survive either way (the entry query below does not filter on
  // tasks.deleted_at), because those are a record of what actually happened.
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

  const trailed = supabase
    .from('time_entries')
    .select('*, tasks!inner(title, completed_at)')
    .is('deleted_at', null)
    .lt('started_at', endIso)
    // running entries (ended_at NULL) must survive this filter
    .or(`ended_at.is.null,ended_at.gt.${startIso}`)
    .gte('started_at', new Date(start.getTime() - 2 * 86_400_000).toISOString())
    .order('started_at')

  const [s, t] = await Promise.all([scheduled, trailed])
  if (s.error) throw s.error
  if (t.error) throw t.error

  const blocks: Block[] = []

  for (const task of s.data as Task[]) {
    blocks.push({
      kind: 'scheduled',
      id: task.id,
      taskId: task.id,
      title: task.title,
      start: new Date(task.due_at!),
      end: new Date(task.scheduled_end!),
      running: false,
      completed: task.completed_at !== null,
      edited: false,
    })
  }

  type JoinedEntry = TimeEntry & {
    tasks: { title: string; completed_at: string | null }
  }
  for (const entry of t.data as unknown as JoinedEntry[]) {
    blocks.push({
      kind: 'trailed',
      id: entry.id,
      taskId: entry.task_id,
      title: entry.tasks.title,
      start: new Date(entry.started_at),
      end: entry.ended_at ? new Date(entry.ended_at) : null,
      running: entry.ended_at === null,
      completed: entry.tasks.completed_at !== null,
      edited: entry.edited_at !== null,
    })
  }

  return blocks
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
 */
export async function getSequence(): Promise<Task[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .is('due_at', null)
    .is('deleted_at', null)
    .order('rank')
    .order('id')
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

/** A move is one row. That is the whole point of fractional ranking. */
export async function moveTask(
  taskId: Uuid,
  before: Rank_ | null,
  after: Rank_ | null,
): Promise<Task> {
  const { data, error } = await supabase
    .from('tasks')
    .update({ rank: rankBetween(before, after) })
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
): Promise<Task> {
  const { data, error } = await supabase
    .from('tasks')
    .update({ completed_at: completedAt.toISOString() })
    .eq('id', taskId)
    .is('completed_at', null) // keep the trigger's old.completed_at IS NULL guard meaningful
    .select()
    .single()
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
