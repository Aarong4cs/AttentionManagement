/**
 * The offline queue must never lose an operation.
 *
 * flush() awaits the network between operations, and enqueue() can append at
 * any moment during that. An earlier version held the queue in a local array
 * and wrote the remainder back, which discarded anything appended meanwhile —
 * and a single drag enqueues two operations in quick succession, so the second
 * was routinely lost with no error anywhere.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ran: string[] = []

vi.mock('../src/lib/db', () => {
  // vi.fn so individual tests can make one reject
  const slow = (name: string) =>
    vi.fn(async () => {
      ran.push(name)
      await new Promise((r) => setTimeout(r, 30))
    })
  return {
    UNIQUE_VIOLATION: '23505',
    createTaskRow: slow('createTask'),
    moveTask: slow('moveTask'),
    setPriority: slow('setPriority'),
    completeTask: slow('completeTask'),
    uncompleteTask: slow('uncompleteTask'),
    deleteTask: slow('deleteTask'),
    startTrailAt: slow('startTrail'),
    stopTrail: slow('stopTrail'),
    rescheduleTask: slow('rescheduleTask'),
    adjustEntry: slow('adjustEntry'),
    deleteEntry: slow('deleteEntry'),
    recolorTask: slow('recolorTask'),
    renameTask: slow('renameTask'),
  }
})
vi.mock('../src/lib/supabase', () => ({ supabase: {} }))

// a Map-backed localStorage, since this runs under node
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage

const { flush } = await import('../src/lib/sync')
const { loadQueue, saveQueue } = await import('../src/lib/offline')

const move = (taskId: string) => ({
  op: 'moveTask' as const, at: 'x', taskId, rank: 'a1',
})
const prio = (taskId: string) => ({
  op: 'setPriority' as const, at: 'x', taskId, priority: 1,
})

beforeEach(() => {
  store.clear()
  ran.length = 0
  // node's navigator.onLine is undefined, and flush guards on `=== false`
  // specifically, so it proceeds as though online without any stubbing
})

describe('flush', () => {
  it('runs everything already queued', async () => {
    saveQueue([move('a'), prio('a')])
    const result = await flush()
    expect(ran).toEqual(['moveTask', 'setPriority'])
    expect(result.applied).toBe(2)
    expect(loadQueue()).toEqual([])
  })

  it('does not discard an operation appended mid-flush', async () => {
    saveQueue([move('a')])
    const running = flush()
    // exactly what a drag does: a second op lands while the first is in flight
    await new Promise((r) => setTimeout(r, 10))
    saveQueue([...loadQueue(), prio('a')])
    await running

    expect(ran).toContain('setPriority')
    expect(loadQueue()).toEqual([])
  })

  it('leaves the queue intact when the network fails', async () => {
    const db = await import('../src/lib/db')
    vi.mocked(db.moveTask).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    saveQueue([move('a'), prio('a')])
    const result = await flush()
    expect(result.stalled).toBe(true)
    expect(result.stallReason).toContain('moveTask')
    expect(loadQueue()).toHaveLength(2)
  })

  it('drops an operation the server will never accept, and continues', async () => {
    const db = await import('../src/lib/db')
    vi.mocked(db.moveTask).mockRejectedValueOnce(
      Object.assign(new Error('check_violation'), { code: '23514' }),
    )
    saveQueue([move('a'), prio('a')])
    const result = await flush()
    expect(result.rejected).toHaveLength(1)
    expect(ran).toContain('setPriority') // the queue did not stall behind it
    expect(loadQueue()).toEqual([])
  })
})
