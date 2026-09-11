import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useNow } from '../hooks/useNow'
import {
  UNIQUE_VIOLATION,
  blocksInRange,
  clearCompleted,
  completeTask,
  createTask,
  elapsedMs,
  getProfile,
  getRunningEntry,
  getSequence,
  isStale,
  moveTask,
  startTrail,
  stopTrail,
  uncompleteTask,
} from '../lib/db'
import { STALE_TIMER_HOURS, WEEK_STARTS_ON } from '../lib/constants'
import { addDays, startOfWeek, todayIn, zonedDayEnd, zonedDayStart } from '../lib/time'
import type { Block, Task, TimeEntry } from '../lib/types'
import Timeline, { type TimelineDay } from './Timeline'
import { materializeAll } from '../lib/recurrence'
import Sequence from './Sequence'
import Recurrences from './Recurrences'

function hhmmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

export default function Today({ email }: { email: string }) {
  const [tz, setTz] = useState<string | null>(null)
  const [day, setDay] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [blocks, setBlocks] = useState<Block[]>([])
  const [running, setRunning] = useState<TimeEntry | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'timeline' | 'sequence'>('timeline')
  const [view, setView] = useState<'day' | 'week'>('day')
  const [showRules, setShowRules] = useState(false)
  const now = useNow()

  useEffect(() => {
    getProfile()
      .then((p) => {
        setTz(p.timezone)
        setDay(todayIn(p.timezone))
        // expanding on every open is safe: the unique occurrence index makes
        // materialization idempotent, from either device, concurrently
        return materializeAll()
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  // One source of truth for which days are on screen: the query range and the
  // columns are derived from the same list, so they cannot disagree.
  const dayKeys = useMemo(() => {
    if (!day) return []
    if (view === 'day') return [day]
    const first = startOfWeek(day, WEEK_STARTS_ON)
    return Array.from({ length: 7 }, (_, i) => addDays(first, i))
  }, [day, view])

  const load = useCallback(async () => {
    if (!tz || !day || dayKeys.length === 0) return
    try {
      const [seq, run, bs] = await Promise.all([
        getSequence(todayIn(tz)),
        getRunningEntry(),
        // the whole week in ONE query, bucketed into columns client-side
        blocksInRange(
          zonedDayStart(dayKeys[0], tz),
          zonedDayEnd(dayKeys[dayKeys.length - 1], tz),
        ),
      ])
      setTasks(seq)
      setRunning(run)
      setBlocks(bs)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [tz, day, dayKeys])

  useEffect(() => {
    // This is the external-system synchronisation the rule exists to allow:
    // an initial fetch plus a realtime subscription to the same source.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
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
    } catch (e) {
      const code = (e as { code?: string })?.code
      setError(
        code === UNIQUE_VIOLATION
          ? 'Another device already has a timer running. Reloaded.'
          : e instanceof Error
            ? e.message
            : String(e),
      )
    }
    await load()
  }

  async function guard(fn: () => Promise<unknown>) {
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function onAdd(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    setTitle('')
    guard(() => createTask(t))
  }

  if (!tz || !day) {
    return <p className="muted center">{error ?? 'Loading…'}</p>
  }

  const today = todayIn(tz)
  const runningTask = running ? tasks.find((t) => t.id === running.task_id) : null

  // formatted from each day's own noon-UTC instant, which lands on the right
  // calendar date in every zone
  const fmt = (key: string, opts: Intl.DateTimeFormatOptions) =>
    new Date(`${key}T12:00:00Z`).toLocaleDateString([], { ...opts, timeZone: 'UTC' })

  const columns: TimelineDay[] = dayKeys.map((key) => ({
    key,
    start: zonedDayStart(key, tz),
    end: zonedDayEnd(key, tz),
    // composed rather than one format call: some locales render the combined
    // form as "7 Mon", which reads wrong in a column header
    label: `${fmt(key, { weekday: 'short' })} ${fmt(key, { day: 'numeric' })}`,
    isToday: key === today,
  }))

  const showsToday = dayKeys.includes(today)
  const rangeLabel =
    view === 'day'
      ? day === today
        ? 'Today'
        : fmt(day, { weekday: 'short', month: 'short', day: 'numeric' })
      : `${fmt(dayKeys[0], { month: 'short', day: 'numeric' })} – ${fmt(
          dayKeys[dayKeys.length - 1],
          { month: 'short', day: 'numeric' },
        )}`

  return (
    <div className="app">
      <header className="bar">
        <div className="daynav">
          <button
            onClick={() => setDay(addDays(day, view === 'week' ? -7 : -1))}
            aria-label={view === 'week' ? 'Previous week' : 'Previous day'}
          >
            ‹
          </button>
          <span className="dayname">{rangeLabel}</span>
          <button
            onClick={() => setDay(addDays(day, view === 'week' ? 7 : 1))}
            aria-label={view === 'week' ? 'Next week' : 'Next day'}
          >
            ›
          </button>
          {!showsToday && (
            <button className="link" onClick={() => setDay(todayIn(tz))}>
              today
            </button>
          )}
        </div>

        <div className="viewswitch">
          <button className={view === 'day' ? 'on' : ''} onClick={() => setView('day')}>
            Day
          </button>
          <button className={view === 'week' ? 'on' : ''} onClick={() => setView('week')}>
            Week
          </button>
        </div>
        <div className="bar-right">
          <button className="link" onClick={() => setShowRules(true)}>
            repeating
          </button>
          <button className="link" onClick={() => supabase.auth.signOut()}>
            {email} · sign out
          </button>
        </div>
      </header>

      {running && (
        <section className="running">
          <span className="dot" aria-hidden="true" />
          <span className="what">{runningTask?.title ?? 'Running'}</span>
          <span className="clock">{hhmmss(elapsedMs(running, now))}</span>
          <button
            className="stop"
            onClick={() => runningTask && toggle(runningTask)}
          >
            Stop
          </button>
        </section>
      )}

      {running && isStale(running, now) && (
        <p className="warn">
          Running over {STALE_TIMER_HOURS} hours — did you forget to stop it?
        </p>
      )}

      <nav className="tabs">
        <button
          className={tab === 'timeline' ? 'on' : ''}
          onClick={() => setTab('timeline')}
        >
          Timeline
        </button>
        <button
          className={tab === 'sequence' ? 'on' : ''}
          onClick={() => setTab('sequence')}
        >
          Sequence
        </button>
      </nav>

      <div className={`panes show-${tab}`}>
        <section className="pane timeline-pane">
          <Timeline days={columns} blocks={blocks} now={now} tz={tz} />
        </section>

        <Sequence
          tasks={tasks}
          runningTaskId={running?.task_id ?? null}
          title={title}
          onTitleChange={setTitle}
          onAdd={onAdd}
          onToggle={toggle}
          onComplete={(t) =>
            guard(() => (t.completed_at ? uncompleteTask(t.id) : completeTask(t.id)))
          }
          onClearCompleted={() => guard(() => clearCompleted())}
          onMove={(id, before, after) => guard(() => moveTask(id, before, after))}
        />
      </div>

      {error && <p className="error">{error}</p>}

      {showRules && (
        <Recurrences tz={tz} onClose={() => setShowRules(false)} onChanged={load} />
      )}
    </div>
  )
}
