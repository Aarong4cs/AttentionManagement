/**
 * Offline writes.
 *
 * CLAUDE.md's rule is: server is truth, local is cache, write locally first.
 * So a mutation is recorded as a typed operation, appended to a durable queue,
 * and applied to the cached snapshot for display. The queue is replayed against
 * the server when the network comes back.
 *
 * The queue holds descriptions of intent rather than closures, because it has
 * to survive the tab being killed — which iOS does constantly. What the user
 * sees is always `applyOps(snapshot, queue)`: a pure function, so the optimistic
 * view is testable without a browser or a network.
 */

import type { Block, Profile, Task, TimeEntry, Uuid } from './types'

export interface EntryRow extends TimeEntry {
  /** Denormalised at fetch time so a trailed block can be drawn from cache. */
  title: string
  taskCompleted: boolean
  color: string | null
}

export interface Snapshot {
  profile: Profile | null
  /** Sequence tasks (due_at null). */
  tasks: Task[]
  /** Scheduled tasks overlapping the viewed range. */
  rangeTasks: Task[]
  /** Trailed entries overlapping the viewed range. */
  entries: EntryRow[]
  running: TimeEntry | null
  fetchedAt: string | null
}

export const emptySnapshot: Snapshot = {
  profile: null,
  tasks: [],
  rangeTasks: [],
  entries: [],
  running: null,
  fetchedAt: null,
}

export type PendingOp =
  | { op: 'createTask'; at: string; task: Task }
  | { op: 'moveTask'; at: string; taskId: Uuid; rank: string }
  | { op: 'completeTask'; at: string; taskId: Uuid; completedAt: string }
  | { op: 'uncompleteTask'; at: string; taskId: Uuid }
  | { op: 'deleteTask'; at: string; taskId: Uuid }
  | { op: 'clearCompleted'; at: string; taskIds: Uuid[] }
  | { op: 'startTrail'; at: string; entryId: Uuid; taskId: Uuid; startedAt: string }
  | { op: 'stopTrail'; at: string; entryId: Uuid; endedAt: string }
  | {
      op: 'rescheduleTask'
      at: string
      taskId: Uuid
      startedAt: string
      minutes: number
    }
  | { op: 'adjustEntry'; at: string; entryId: Uuid; startedAt: string; endedAt: string }
  | { op: 'deleteEntry'; at: string; entryId: Uuid }
  | { op: 'renameTask'; at: string; taskId: Uuid; title: string }
  | { op: 'recolorTask'; at: string; taskId: Uuid; color: string | null }

// ---------------------------------------------------------------------------
// the optimistic view
// ---------------------------------------------------------------------------

const alive = <T extends { deleted_at: string | null }>(rows: T[]) =>
  rows.filter((r) => r.deleted_at === null)

/**
 * The snapshot as it would look once every queued op has reached the server.
 *
 * Pure. Ops are applied in order, and each is written to mirror what the
 * database would actually do — including the auto-stop trigger, so a task
 * completed offline shows its timer stopped rather than still running.
 */
export function applyOps(snapshot: Snapshot, ops: readonly PendingOp[]): Snapshot {
  let s: Snapshot = {
    ...snapshot,
    tasks: [...snapshot.tasks],
    rangeTasks: [...snapshot.rangeTasks],
    entries: [...snapshot.entries],
  }

  const patchTask = (id: Uuid, patch: Partial<Task>) => {
    const apply = (rows: Task[]) =>
      rows.map((t) => (t.id === id ? { ...t, ...patch } : t))
    s.tasks = apply(s.tasks)
    s.rangeTasks = apply(s.rangeTasks)
    s.entries = s.entries.map((e) =>
      e.task_id === id && patch.completed_at !== undefined
        ? { ...e, taskCompleted: patch.completed_at !== null }
        : e,
    )
  }

  const stopEntry = (entryId: Uuid, endedAt: string) => {
    s.entries = s.entries.map((e) =>
      e.id === entryId ? { ...e, ended_at: endedAt } : e,
    )
    if (s.running?.id === entryId) s.running = null
  }

  for (const op of ops) {
    switch (op.op) {
      case 'createTask':
        // Idempotent: the queue is held until the snapshot that already
        // contains these writes arrives, so an op can legitimately be applied
        // on top of its own result. Appending blindly would double the row.
        if (!s.tasks.some((t) => t.id === op.task.id)) {
          s.tasks = [...s.tasks, op.task]
        }
        break

      case 'moveTask':
        patchTask(op.taskId, { rank: op.rank })
        break

      case 'completeTask': {
        patchTask(op.taskId, { completed_at: op.completedAt })
        // mirrors the tasks_autostop trigger: completing closes the running
        // entry at completed_at, never at "now"
        const open = s.entries.find(
          (e) => e.task_id === op.taskId && e.ended_at === null,
        )
        if (open) stopEntry(open.id, op.completedAt)
        else if (s.running?.task_id === op.taskId) s.running = null
        break
      }

      case 'uncompleteTask':
        // the trigger does not reopen the entry it closed, and neither do we
        patchTask(op.taskId, { completed_at: null })
        break

      case 'deleteTask':
        patchTask(op.taskId, { deleted_at: op.at })
        break

      case 'clearCompleted':
        for (const id of op.taskIds) patchTask(id, { deleted_at: op.at })
        break

      case 'startTrail': {
        if (s.entries.some((e) => e.id === op.entryId)) {
          // already present from the server; just make sure it is the running
          // one, since a fetched row carries no notion of "current"
          const existing = s.entries.find((e) => e.id === op.entryId)!
          if (existing.ended_at === null) s.running = existing
          break
        }
        const task =
          s.tasks.find((t) => t.id === op.taskId) ??
          s.rangeTasks.find((t) => t.id === op.taskId)
        const entry: EntryRow = {
          id: op.entryId,
          user_id: task?.user_id ?? '',
          task_id: op.taskId,
          started_at: op.startedAt,
          ended_at: null,
          edited_at: null,
          deleted_at: null,
          created_at: op.at,
          updated_at: op.at,
          duration_seconds: null,
          title: task?.title ?? '',
          taskCompleted: task?.completed_at != null,
          color: task?.color ?? null,
        }
        s.entries = [...s.entries, entry]
        s.running = entry
        break
      }

      case 'stopTrail':
        stopEntry(op.entryId, op.endedAt)
        break

      case 'rescheduleTask':
        patchTask(op.taskId, {
          due_at: op.startedAt,
          estimated_minutes: op.minutes,
          // trigger-maintained on the server; mirrored so the block redraws at
          // its new length immediately rather than after the next fetch
          scheduled_end: new Date(
            new Date(op.startedAt).getTime() + op.minutes * 60_000,
          ).toISOString(),
        })
        break

      case 'adjustEntry':
        s.entries = s.entries.map((e) =>
          e.id === op.entryId
            ? {
                ...e,
                started_at: op.startedAt,
                ended_at: op.endedAt,
                // mirrors mark_entry_edited: these times were reconstructed
                edited_at: op.at,
              }
            : e,
        )
        if (s.running?.id === op.entryId) s.running = null
        break

      case 'renameTask':
        patchTask(op.taskId, { title: op.title })
        // the entry rows carry a denormalised title so blocks can be drawn from
        // cache; without this the timeline keeps the old name until a refetch
        s.entries = s.entries.map((e) =>
          e.task_id === op.taskId ? { ...e, title: op.title } : e,
        )
        break

      case 'recolorTask':
        patchTask(op.taskId, { color: op.color })
        break

      case 'deleteEntry':
        s.entries = s.entries.map((e) =>
          e.id === op.entryId ? { ...e, deleted_at: op.at } : e,
        )
        if (s.running?.id === op.entryId) s.running = null
        break
    }
  }

  s.tasks = alive(s.tasks)
  s.rangeTasks = alive(s.rangeTasks)
  s.entries = alive(s.entries)
  return s
}

/** Blocks for the timeline, built from rows rather than fetched as blocks. */
export function buildBlocks(snapshot: Snapshot): Block[] {
  const scheduled: Block[] = snapshot.rangeTasks
    .filter((t) => t.due_at !== null && t.scheduled_end !== null)
    .map((t) => ({
      kind: 'scheduled' as const,
      id: t.id,
      taskId: t.id,
      title: t.title,
      start: new Date(t.due_at!),
      end: new Date(t.scheduled_end!),
      running: false,
      completed: t.completed_at !== null,
      edited: false,
      color: t.color,
    }))

  const trailed: Block[] = snapshot.entries.map((e) => ({
    kind: 'trailed' as const,
    id: e.id,
    taskId: e.task_id,
    title: e.title,
    start: new Date(e.started_at),
    end: e.ended_at ? new Date(e.ended_at) : null,
    running: e.ended_at === null,
    completed: e.taskCompleted,
    edited: e.edited_at !== null,
    color: e.color,
  }))

  return [...scheduled, ...trailed]
}

// ---------------------------------------------------------------------------
// durability
// ---------------------------------------------------------------------------

const QUEUE_KEY = 'am.queue.v1'
const SNAPSHOT_KEY = 'am.snapshot.v1'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    // a private window, cleared site data, or a browser blocking storage
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // quota or blocked storage: the app still works, it just loses its cache
  }
}

export const loadQueue = (): PendingOp[] => read<PendingOp[]>(QUEUE_KEY, [])
export const saveQueue = (ops: readonly PendingOp[]): void => write(QUEUE_KEY, ops)
export const loadSnapshot = (): Snapshot => read<Snapshot>(SNAPSHOT_KEY, emptySnapshot)
export const saveSnapshot = (s: Snapshot): void => write(SNAPSHOT_KEY, s)

export function clearLocal(): void {
  try {
    localStorage.removeItem(QUEUE_KEY)
    localStorage.removeItem(SNAPSHOT_KEY)
  } catch {
    /* nothing to do */
  }
}
