/**
 * Replaying the offline queue.
 *
 * Ops go back to the server in the order they were made. A failure is either
 * retryable (the network is still down — stop, keep the queue, try later) or
 * permanent (the server refused it, and it will refuse it every time). A
 * permanent failure MUST drop the op: leaving it at the head of the queue would
 * block every later write forever, which is the classic way an offline queue
 * quietly stops syncing.
 */

import { supabase } from './supabase'
import {
  UNIQUE_VIOLATION,
  adjustEntry,
  completeTask,
  createSubtaskRow,
  createTaskRow,
  deleteEntry,
  deleteSubtask,
  deleteTask,
  moveTask,
  recolorTask,
  renameSubtask,
  renameTask,
  rescheduleTask,
  setPriority,
  setSubtaskDone,
  startTrailAt,
  stopTrail,
  uncompleteTask,
} from './db'
import { loadQueue, saveQueue, type PendingOp } from './offline'

export interface FlushResult {
  applied: number
  /** Ops the server refused outright; they are gone, and worth telling about. */
  rejected: { op: PendingOp; message: string }[]
  /** True when the queue still has work because the network is unavailable. */
  stalled: boolean
  /**
   * Why the queue stopped, when it stopped for a reason other than being
   * offline. A queue that stalls silently looks exactly like one that is
   * working, so this must reach the UI rather than being swallowed.
   */
  stallReason: string | null
}

/** Codes that mean "this will never succeed" — retrying only stalls the queue. */
const PERMANENT = new Set([
  // PostgREST: an update matched no rows. Belt and braces alongside the
  // maybeSingle() calls in db.ts, because one of these stalling the queue takes
  // every later write down with it.
  'PGRST116',
  '23514', // check_violation — e.g. trailing a scheduled task
  '23502', // not_null_violation
  '23503', // foreign_key_violation — the task was deleted elsewhere
  '22007', // invalid datetime
  '42501', // insufficient_privilege
])

function isPermanent(error: unknown): boolean {
  const code = (error as { code?: string })?.code
  if (!code) return false
  if (PERMANENT.has(code)) return true
  // a duplicate means the op already landed, so treat it as done, not stuck
  return code === UNIQUE_VIOLATION
}

async function run(op: PendingOp): Promise<void> {
  switch (op.op) {
    case 'createTask':
      await createTaskRow(op.task)
      return
    case 'moveTask':
      await moveTask(op.taskId, null, null, op.rank)
      return
    case 'completeTask':
      await completeTask(op.taskId, new Date(op.completedAt))
      return
    case 'uncompleteTask':
      await uncompleteTask(op.taskId)
      return
    case 'deleteTask':
      await deleteTask(op.taskId)
      return
    case 'clearCompleted': {
      if (op.taskIds.length === 0) return
      const { error } = await supabase
        .from('tasks')
        .update({ deleted_at: op.at })
        .in('id', op.taskIds)
      if (error) throw error
      return
    }
    case 'startTrail':
      await startTrailAt(op.entryId, op.taskId, new Date(op.startedAt))
      return
    case 'stopTrail':
      await stopTrail(op.entryId, new Date(op.endedAt))
      return
    case 'rescheduleTask':
      await rescheduleTask(op.taskId, new Date(op.startedAt), op.minutes)
      return
    case 'adjustEntry':
      await adjustEntry(op.entryId, new Date(op.startedAt), new Date(op.endedAt))
      return
    case 'deleteEntry':
      await deleteEntry(op.entryId)
      return
    case 'renameTask':
      await renameTask(op.taskId, op.title)
      return
    case 'recolorTask':
      await recolorTask(op.taskId, op.color)
      return
    case 'setPriority':
      await setPriority(op.taskId, op.priority)
      return
    case 'createSubtask':
      await createSubtaskRow(op.subtask)
      return
    case 'toggleSubtask':
      await setSubtaskDone(op.subtaskId, op.doneAt)
      return
    case 'renameSubtask':
      await renameSubtask(op.subtaskId, op.title)
      return
    case 'deleteSubtask':
      await deleteSubtask(op.subtaskId)
      return
  }
}

/**
 * Push the queue to the server. Safe to call at any time; a no-op when the
 * queue is empty or the browser reports itself offline.
 */
export async function flush(): Promise<FlushResult> {
  const result: FlushResult = {
    applied: 0,
    rejected: [],
    stalled: false,
    stallReason: null,
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    result.stalled = loadQueue().length > 0
    return result
  }

  /*
   * Re-read storage on every iteration. An earlier version held the queue in a
   * local array and wrote the remainder back, which silently DISCARDED anything
   * enqueue() appended while this was awaiting the network — and a single drag
   * enqueues two operations in quick succession, so the second was routinely
   * lost. Operations are only ever appended, so dropping the head from whatever
   * storage currently holds is always the right edit.
   */
  for (;;) {
    const queue = loadQueue()
    if (queue.length === 0) return result
    const head = queue[0]

    try {
      await run(head)
      result.applied++
    } catch (error) {
      if (!isPermanent(error)) {
        // still offline, or the server is unreachable: keep the queue intact
        result.stalled = true
        const code = (error as { code?: string })?.code
        result.stallReason = `${head.op}: ${
          error instanceof Error ? error.message : String(error)
        }${code ? ` (${code})` : ''}`
        return result
      }
      const code = (error as { code?: string })?.code
      if (code !== UNIQUE_VIOLATION) {
        result.rejected.push({
          op: head,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    saveQueue(loadQueue().slice(1))
  }
}
