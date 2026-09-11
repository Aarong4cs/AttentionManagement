/**
 * blocksInRange / blocksForDay against the live project.
 *
 * This is the most intricate query in the codebase: an overlap predicate, an
 * .or() clause so running entries survive filtering, and a tasks!inner join.
 * These shapes return WRONG ROWS rather than erroring when they are wrong,
 * so they need real data rather than a type-check.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { supabase } from '../src/lib/supabase'
import { blocksForDay, blocksInRange } from '../src/lib/db'
import { zonedDayEnd, zonedDayStart } from '../src/lib/time'

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

const MARK = `[btest ${Date.now()}]`
const taskIds: string[] = []
const entryIds: string[] = []
let uid = ''

async function mkTask(
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID()
  const { error } = await supabase.from('tasks').insert({
    id,
    user_id: uid,
    title: `${MARK} ${title}`,
    rank: `z${taskIds.length}`,
    ...extra,
  })
  if (error) throw error
  taskIds.push(id)
  return id
}

async function mkEntry(taskId: string, start: string, end: string | null) {
  const id = crypto.randomUUID()
  const { error } = await supabase.from('time_entries').insert({
    id,
    user_id: uid,
    task_id: taskId,
    started_at: start,
    ended_at: end,
  })
  if (error) throw error
  entryIds.push(id)
  return id
}

beforeAll(async () => {
  const { error } = await supabase.auth.signInWithPassword({
    email: creds.TEST_USER_EMAIL,
    password: creds.TEST_USER_PASSWORD,
  })
  if (error) throw new Error(`sign-in failed: ${error.message}`)
  uid = (await supabase.auth.getUser()).data.user!.id

  const { data: stray } = await supabase
    .from('time_entries')
    .select('id')
    .is('ended_at', null)
    .is('deleted_at', null)
  for (const s of stray ?? []) {
    await supabase
      .from('time_entries')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', s.id)
  }
})

afterAll(async () => {
  if (entryIds.length) await supabase.from('time_entries').delete().in('id', entryIds)
  if (taskIds.length) await supabase.from('tasks').delete().in('id', taskIds)
  await supabase.auth.signOut()
})

const mine = (bs: Awaited<ReturnType<typeof blocksInRange>>) =>
  bs.filter((b) => b.title.startsWith(MARK))

describe('scheduled blocks', () => {
  it('returns a block overlapping the range, with its computed end', async () => {
    await mkTask('standup', {
      due_at: '2026-05-04T13:00:00Z',
      estimated_minutes: 30,
    })
    const blocks = mine(
      await blocksInRange(
        new Date('2026-05-04T00:00:00Z'),
        new Date('2026-05-05T00:00:00Z'),
      ),
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('scheduled')
    expect(blocks[0].end!.toISOString()).toBe('2026-05-04T13:30:00.000Z')
    expect(blocks[0].running).toBe(false)
  })

  it('excludes a block entirely outside the range', async () => {
    const blocks = mine(
      await blocksInRange(
        new Date('2026-05-06T00:00:00Z'),
        new Date('2026-05-07T00:00:00Z'),
      ),
    )
    expect(blocks).toHaveLength(0)
  })

  it('includes a block that only partially overlaps the range start', async () => {
    // starts before the window, ends inside it
    await mkTask('overlapper', {
      due_at: '2026-05-09T23:45:00Z',
      estimated_minutes: 60,
    })
    const blocks = mine(
      await blocksInRange(
        new Date('2026-05-10T00:00:00Z'),
        new Date('2026-05-11T00:00:00Z'),
      ),
    )
    expect(blocks.map((b) => b.title)).toContain(`${MARK} overlapper`)
  })
})

describe('trailed blocks', () => {
  it('returns a closed entry with the task title from the join', async () => {
    const t = await mkTask('deep work')
    await mkEntry(t, '2026-05-12T14:00:00Z', '2026-05-12T15:30:00Z')
    const blocks = mine(
      await blocksInRange(
        new Date('2026-05-12T00:00:00Z'),
        new Date('2026-05-13T00:00:00Z'),
      ),
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('trailed')
    expect(blocks[0].title).toBe(`${MARK} deep work`)
    expect(blocks[0].edited).toBe(false)
  })

  it('returns an entry spanning local midnight from BOTH days', async () => {
    const t = await mkTask('night owl')
    // 23:40 -> 00:20 local New York
    await mkEntry(t, '2026-05-15T03:40:00Z', '2026-05-15T04:20:00Z')

    const d1 = mine(
      await blocksInRange(zonedDayStart('2026-05-14', TZ), zonedDayEnd('2026-05-14', TZ)),
    )
    const d2 = mine(
      await blocksInRange(zonedDayStart('2026-05-15', TZ), zonedDayEnd('2026-05-15', TZ)),
    )
    expect(d1.map((b) => b.title)).toContain(`${MARK} night owl`)
    expect(d2.map((b) => b.title)).toContain(`${MARK} night owl`)
  })

  it('clips a midnight-spanning block 20/20 across the two day columns', async () => {
    const all = await blocksInRange(
      zonedDayStart('2026-05-14', TZ),
      zonedDayEnd('2026-05-15', TZ),
    )
    const block = mine(all).find((b) => b.title.endsWith('night owl'))!
    const d1s = zonedDayStart('2026-05-14', TZ)
    const d1e = zonedDayEnd('2026-05-14', TZ)
    const d2s = zonedDayStart('2026-05-15', TZ)
    const d2e = zonedDayEnd('2026-05-15', TZ)

    expect(blocksForDay([block], d1s, d1e).length).toBe(1)
    expect(blocksForDay([block], d2s, d2e).length).toBe(1)
    expect(block.end!.getTime() - block.start.getTime()).toBe(40 * 60_000)
  })
})

describe('running entries', () => {
  it('includes a currently-running entry (exercises the .or clause)', async () => {
    const t = await mkTask('running now')
    const started = new Date(Date.now() - 30 * 60_000)
    await mkEntry(t, started.toISOString(), null)

    const blocks = mine(
      await blocksInRange(new Date(Date.now() - 3600_000), new Date(Date.now() + 3600_000)),
    )
    const b = blocks.find((x) => x.title.endsWith('running now'))
    expect(b).toBeDefined()
    expect(b!.running).toBe(true)
    expect(b!.end).toBeNull()
  })

  it('includes a timer that has been running for five days', async () => {
    // the forgotten-timer case the 12h stale warning exists for
    await supabase.from('time_entries').delete().in('id', entryIds.slice(-1))
    entryIds.pop()

    const t = await mkTask('forgotten')
    const started = new Date(Date.now() - 5 * 86_400_000)
    await mkEntry(t, started.toISOString(), null)

    const blocks = mine(
      await blocksInRange(new Date(Date.now() - 3600_000), new Date(Date.now() + 3600_000)),
    )
    expect(blocks.map((b) => b.title)).toContain(`${MARK} forgotten`)
  })
})
