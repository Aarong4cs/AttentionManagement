/**
 * Authenticated end-to-end tests against the live Supabase project.
 *
 * These exercise src/lib/db.ts itself — not a reimplementation of it — so the
 * PostgREST filter and join syntax is covered, which is where the easy bugs are.
 *
 * Requires TEST_USER_EMAIL / TEST_USER_PASSWORD in .env.local. Those must NOT
 * carry a VITE_ prefix, or Vite would inline the password into the client
 * bundle. Every row created here is hard-deleted in cleanup.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { supabase } from '../src/lib/supabase'
import {
  clearCompleted,
  completeTask,
  createTask,
  elapsedMs,
  getRunningEntry,
  getSequence,
  isStale,
  moveTask,
  startTrail,
  stopTrail,
  uncompleteTask,
} from '../src/lib/db'
import { rankBetween } from '../src/lib/rank'
import type { Task } from '../src/lib/types'

const creds = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const MARK = `[itest ${Date.now()}]`
const created: string[] = []

async function track<T extends Task>(p: Promise<T>): Promise<T> {
  const t = await p
  created.push(t.id)
  return t
}

beforeAll(async () => {
  const { error } = await supabase.auth.signInWithPassword({
    email: creds.TEST_USER_EMAIL,
    password: creds.TEST_USER_PASSWORD,
  })
  if (error) throw new Error(`sign-in failed: ${error.message}`)

  // a leftover running timer from a previous run would fail every start
  const stray = await getRunningEntry()
  if (stray) await stopTrail(stray.id)
})

afterAll(async () => {
  // entries first: tasks are ON DELETE RESTRICT while entries reference them
  if (created.length > 0) {
    await supabase.from('time_entries').delete().in('task_id', created)
    await supabase.from('tasks').delete().in('id', created)
  }
  await supabase.auth.signOut()
})

describe('auth + RLS', () => {
  it('signs in and exposes a session', async () => {
    const { data } = await supabase.auth.getSession()
    expect(data.session).not.toBeNull()
    expect(data.session!.user.email).toBe(creds.TEST_USER_EMAIL)
  })
})

describe('tasks', () => {
  it('creates a sequence task and returns it from getSequence', async () => {
    const task = await track(createTask(`${MARK} first`))
    expect(task.due_at).toBeNull()
    expect(task.rank).toBeTruthy()
    expect(task.user_id).toBe((await supabase.auth.getUser()).data.user!.id)

    const seq = await getSequence()
    expect(seq.map((t) => t.id)).toContain(task.id)
  })

  it('appends each new task after the last', async () => {
    const a = await track(createTask(`${MARK} a`))
    const b = await track(createTask(`${MARK} b`))
    expect(b.rank > a.rank).toBe(true)
  })

  it('moves a task between two neighbours with a single-row update', async () => {
    const seq = (await getSequence()).filter((t) => t.title.startsWith(MARK))
    expect(seq.length).toBeGreaterThanOrEqual(3)
    const [first, second, third] = seq
    const moved = await moveTask(third.id, first.rank, second.rank)
    expect(moved.rank > first.rank).toBe(true)
    expect(moved.rank < second.rank).toBe(true)

    const after = (await getSequence()).filter((t) => t.title.startsWith(MARK))
    expect(after.map((t) => t.id)).toEqual([first.id, third.id, second.id])
  })
})

describe('the running timer', () => {
  it('starts, is readable as a row, and elapses from started_at', async () => {
    const task = await track(createTask(`${MARK} timer`))
    const entry = await startTrail(task.id)
    expect(entry.ended_at).toBeNull()
    expect(entry.duration_seconds).toBeNull()

    const running = await getRunningEntry()
    expect(running?.id).toBe(entry.id)

    // elapsed is derived, never stored
    const later = new Date(new Date(entry.started_at).getTime() + 90_000)
    expect(elapsedMs(entry, later)).toBe(90_000)
    expect(isStale(entry)).toBe(false)

    const stopped = await stopTrail(entry.id)
    expect(stopped.ended_at).not.toBeNull()
    expect(stopped.duration_seconds).toBeGreaterThanOrEqual(0)
    expect(stopped.edited_at).toBeNull() // stopping is not an edit
    expect(await getRunningEntry()).toBeNull()
  })

  it('rejects a second running timer', async () => {
    const a = await track(createTask(`${MARK} one`))
    const b = await track(createTask(`${MARK} two`))
    const first = await startTrail(a.id)
    await expect(startTrail(b.id)).rejects.toMatchObject({ code: '23505' })
    await stopTrail(first.id)
  })

  it('refuses to trail a scheduled task', async () => {
    const task = await track(createTask(`${MARK} scheduled`))
    await supabase
      .from('tasks')
      .update({ due_at: new Date().toISOString(), estimated_minutes: 30 })
      .eq('id', task.id)
    await expect(startTrail(task.id)).rejects.toMatchObject({ code: '23514' })
  })
})

describe('completion', () => {
  it('auto-stops a running entry at completed_at, not now()', async () => {
    const task = await track(createTask(`${MARK} autostop`))
    const entry = await startTrail(task.id)

    const at = new Date(Date.now() + 5_000)
    await completeTask(task.id, at)

    const { data } = await supabase
      .from('time_entries')
      .select('*')
      .eq('id', entry.id)
      .single()
    expect(new Date(data!.ended_at!).toISOString()).toBe(at.toISOString())
    expect(data!.edited_at).toBeNull()
    expect(await getRunningEntry()).toBeNull()
  })

  it('keeps a completed task in place at its original rank', async () => {
    const task = await track(createTask(`${MARK} stays`))
    const before = task.rank
    await completeTask(task.id)
    const seq = await getSequence()
    const found = seq.find((t) => t.id === task.id)
    expect(found).toBeDefined()
    expect(found!.rank).toBe(before)
    expect(found!.completed_at).not.toBeNull()
    await uncompleteTask(task.id)
  })

  it('clears completed sequence tasks and leaves their entries', async () => {
    const task = await track(createTask(`${MARK} clearme`))
    const entry = await startTrail(task.id)
    await stopTrail(entry.id)
    await completeTask(task.id)

    const cleared = await clearCompleted()
    expect(cleared).toContain(task.id)

    const seq = await getSequence()
    expect(seq.map((t) => t.id)).not.toContain(task.id)

    const { data } = await supabase
      .from('time_entries')
      .select('*')
      .eq('id', entry.id)
      .single()
    expect(data).not.toBeNull() // the record of the work survives
  })
})

describe('editing an entry', () => {
  it('marks a corrected end time as edited', async () => {
    const task = await track(createTask(`${MARK} edit`))
    const entry = await startTrail(task.id)
    await stopTrail(entry.id)

    const { data } = await supabase
      .from('time_entries')
      .update({ ended_at: new Date(Date.now() + 60_000).toISOString() })
      .eq('id', entry.id)
      .select()
      .single()
    expect(data!.edited_at).not.toBeNull()
  })
})

describe('rank helpers agree with the server', () => {
  it('generates a key that sorts between its neighbours under C collation', async () => {
    const seq = (await getSequence()).filter((t) => t.title.startsWith(MARK))
    const [a, b] = seq
    const mid = rankBetween(a.rank, b.rank)
    expect(mid > a.rank).toBe(true)
    expect(mid < b.rank).toBe(true)
  })
})
