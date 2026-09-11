import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useNow } from '../hooks/useNow'
import {
  UNIQUE_VIOLATION,
  clearCompleted,
  completeTask,
  createTask,
  elapsedMs,
  getRunningEntry,
  getSequence,
  isStale,
  startTrail,
  stopTrail,
  uncompleteTask,
} from '../lib/db'
import { STALE_TIMER_HOURS } from '../lib/constants'
import type { Task, TimeEntry } from '../lib/types'

function hhmmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

export default function Today({ email }: { email: string }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [running, setRunning] = useState<TimeEntry | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const now = useNow()

  const load = useCallback(async () => {
    try {
      const [seq, run] = await Promise.all([getSequence(), getRunningEntry()])
      setTasks(seq)
      setRunning(run)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()

    // Realtime is the fast path; the refetch below is the correctness path.
    // iOS drops this socket constantly, so never rely on it alone.
    const channel = supabase
      .channel('attention-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entries' }, load)
      .subscribe()

    const onWake = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)

    return () => {
      supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [load])

  async function toggle(task: Task) {
    const wasRunning = running
    // optimistic: the block should appear to start the instant it is tapped
    setRunning(
      wasRunning?.task_id === task.id
        ? null
        : ({
            id: 'optimistic',
            task_id: task.id,
            started_at: new Date().toISOString(),
            ended_at: null,
          } as TimeEntry),
    )
    try {
      if (wasRunning?.task_id === task.id) {
        await stopTrail(wasRunning.id)
      } else {
        if (wasRunning) await stopTrail(wasRunning.id)
        await startTrail(task.id)
      }
      await load()
    } catch (e) {
      const code = (e as { code?: string })?.code
      if (code === UNIQUE_VIOLATION) {
        setError('Another device already has a timer running. Reloaded.')
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
      await load()
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    setTitle('')
    try {
      await createTask(t)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onComplete(task: Task) {
    try {
      if (task.completed_at) await uncompleteTask(task.id)
      else await completeTask(task.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const runningTask = running ? tasks.find((t) => t.id === running.task_id) : null
  const hasCompleted = tasks.some((t) => t.completed_at)

  return (
    <main className="app">
      <header className="bar">
        <h1>Attention Management</h1>
        <button className="link" onClick={() => supabase.auth.signOut()}>
          {email} · sign out
        </button>
      </header>

      {running && (
        <section className="running">
          <span className="dot" aria-hidden="true" />
          <span className="what">{runningTask?.title ?? 'Running'}</span>
          <span className="clock">{hhmmss(elapsedMs(running, now))}</span>
        </section>
      )}

      {running && isStale(running, now) && (
        <p className="warn">
          This timer has been running over {STALE_TIMER_HOURS} hours — did you
          forget to stop it?
        </p>
      )}

      <form className="add" onSubmit={onAdd}>
        <input
          value={title}
          placeholder="Add a task to the sequence"
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit">Add</button>
      </form>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="muted">No sequence tasks yet.</p>
      ) : (
        <ul className="seq">
          {tasks.map((task) => {
            const isOn = running?.task_id === task.id
            return (
              <li key={task.id} className={task.completed_at ? 'done' : undefined}>
                <input
                  type="checkbox"
                  checked={task.completed_at !== null}
                  onChange={() => onComplete(task)}
                  aria-label={`Complete ${task.title}`}
                />
                <span className="title">{task.title}</span>
                <button
                  className={isOn ? 'toggle on' : 'toggle'}
                  onClick={() => toggle(task)}
                >
                  {isOn ? 'Stop' : 'Start'}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {hasCompleted && (
        <button
          className="link clear"
          onClick={async () => {
            await clearCompleted()
            await load()
          }}
        >
          Clear completed
        </button>
      )}

      {error && <p className="error">{error}</p>}
    </main>
  )
}
