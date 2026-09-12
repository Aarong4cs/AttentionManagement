/**
 * Steps under a task, applied optimistically.
 *
 * The same guarantees every other op has: a queued change shows at once,
 * replaying the queue over its own result changes nothing, and a snapshot
 * cached before this feature existed still loads.
 */
import { describe, expect, it } from 'vitest'
import { applyOps, emptySnapshot, type PendingOp, type Snapshot } from '../src/lib/offline'
import type { Subtask } from '../src/lib/types'

const at = '2026-09-12T10:00:00.000Z'
const base: Snapshot = { ...emptySnapshot, subtasks: [] }

const step = (id: string, rank: string, extra: Partial<Subtask> = {}): Subtask => ({
  id,
  user_id: 'u',
  task_id: 't',
  title: `step ${id}`,
  rank,
  done_at: null,
  deleted_at: null,
  created_at: at,
  updated_at: at,
  ...extra,
})

const create = (s: Subtask): PendingOp => ({ op: 'createSubtask', at, subtask: s })

describe('subtask ops', () => {
  it('shows a created step at once', () => {
    const s = applyOps(base, [create(step('a', 'a0'))])
    expect(s.subtasks.map((x) => x.id)).toEqual(['a'])
  })

  it('does not duplicate a step when the queue is replayed over its result', () => {
    const ops = [create(step('a', 'a0'))]
    expect(applyOps(applyOps(base, ops), ops).subtasks).toHaveLength(1)
  })

  it('ticks and unticks', () => {
    const made = applyOps(base, [create(step('a', 'a0'))])
    const ticked = applyOps(made, [{ op: 'toggleSubtask', at, subtaskId: 'a', doneAt: at }])
    expect(ticked.subtasks[0].done_at).toBe(at)
    const unticked = applyOps(ticked, [
      { op: 'toggleSubtask', at, subtaskId: 'a', doneAt: null },
    ])
    expect(unticked.subtasks[0].done_at).toBeNull()
  })

  it('renames in place', () => {
    const s = applyOps(base, [
      create(step('a', 'a0')),
      { op: 'renameSubtask', at, subtaskId: 'a', title: 'renamed' },
    ])
    expect(s.subtasks[0].title).toBe('renamed')
  })

  it('drops a deleted step from view', () => {
    const s = applyOps(base, [
      create(step('a', 'a0')),
      create(step('b', 'a1')),
      { op: 'deleteSubtask', at, subtaskId: 'a' },
    ])
    expect(s.subtasks.map((x) => x.id)).toEqual(['b'])
  })

  it('keeps steps in rank order however they arrived', () => {
    const s = applyOps(base, [create(step('b', 'a1')), create(step('a', 'a0'))])
    expect(s.subtasks.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('accepts a snapshot cached before steps existed', () => {
    const legacy: Partial<Snapshot> = { ...emptySnapshot }
    delete legacy.subtasks
    expect(applyOps(legacy as Snapshot, []).subtasks).toEqual([])
  })
})
