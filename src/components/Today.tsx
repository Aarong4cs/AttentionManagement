import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useNow } from '../hooks/useNow'
import { useOfflineData } from '../hooks/useOfflineData'
import { elapsedMs, getProfile, isStale, newId } from '../lib/db'
import { minutesBetween } from '../lib/layout'
import { buildBlocks, clearLocal, loadSnapshot } from '../lib/offline'
import { rankAppend, rankBetween } from '../lib/rank'
import { materializeAll } from '../lib/recurrence'
import { STALE_TIMER_HOURS, WEEK_STARTS_ON } from '../lib/constants'
import { addDays, startOfWeek, todayIn, zonedDayEnd, zonedDayStart } from '../lib/time'
import type { Block, Task } from '../lib/types'
import Timeline, { type TimelineDay } from './Timeline'
import Sequence from './Sequence'
import Recurrences from './Recurrences'

function hhmmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

/**
 * The timezone decides where every day begins, so the panes cannot render
 * without it. Reading it from cache is synchronous, which means a cold offline
 * start renders immediately instead of waiting on a network call that will not
 * answer. The device zone is the last resort on a first ever run.
 */
function cachedZone(): string {
  return (
    loadSnapshot().profile?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone
  )
}

export default function Today({ email }: { email: string }) {
  const [tz, setTz] = useState<string>(cachedZone)
  const [day, setDay] = useState<string>(() => todayIn(cachedZone()))
  const [title, setTitle] = useState('')
  const [tab, setTab] = useState<'timeline' | 'sequence'>('timeline')
  const [view, setView] = useState<'day' | 'week'>('day')
  const [showRules, setShowRules] = useState(false)
  const now = useNow()

  useEffect(() => {
    // correct the cached zone from the server whenever that becomes possible
    getProfile()
      .then((p) => {
        if (p.timezone !== cachedZone()) {
          setTz(p.timezone)
          setDay(todayIn(p.timezone))
        }
        // expanding on every open is safe: the unique occurrence index makes
        // materialization idempotent, from either device, concurrently
        return materializeAll()
      })
      .catch(() => {
        // offline: the cached zone stands until the network returns
      })
  }, [])

  // One source of truth for what is on screen: the query range and the columns
  // derive from the same list, so they cannot disagree.
  const dayKeys = useMemo(() => {
    if (view === 'day') return [day]
    const first = startOfWeek(day, WEEK_STARTS_ON)
    return Array.from({ length: 7 }, (_, i) => addDays(first, i))
  }, [day, view])

  const rangeStart = zonedDayStart(dayKeys[0], tz)
  const rangeEnd = zonedDayEnd(dayKeys[dayKeys.length - 1], tz)

  const data = useOfflineData(todayIn(tz), rangeStart, rangeEnd)
  const { view: snap, enqueue } = data
  const blocks = useMemo(() => buildBlocks(snap), [snap])

  function onAdd(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    setTitle('')
    const task: Task = {
      id: newId(),
      user_id: snap.profile?.id ?? '',
      title: t,
      notes: null,
      due_at: null,
      estimated_minutes: null,
      rank: rankAppend(snap.tasks.map((x) => x.rank)),
      completed_at: null,
      deleted_at: null,
      recurrence_id: null,
      occurrence_date: null,
      detached: false,
      scheduled_end: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    enqueue({ op: 'createTask', at: new Date().toISOString(), task })
  }

  function toggle(task: Task) {
    const at = new Date().toISOString()
    const running = snap.running
    if (running?.task_id === task.id) {
      enqueue({ op: 'stopTrail', at, entryId: running.id, endedAt: at })
      return
    }
    if (running) enqueue({ op: 'stopTrail', at, entryId: running.id, endedAt: at })
    enqueue({
      op: 'startTrail',
      at,
      entryId: newId(),
      taskId: task.id,
      startedAt: at,
    })
  }

  /**
   * A scheduled block is a task's due_at plus its estimate; a trailed block is
   * an entry's two timestamps. Same gesture, different rows.
   */
  function onReschedule(block: Block, start: Date, end: Date) {
    const at = new Date().toISOString()
    enqueue(
      block.kind === 'scheduled'
        ? {
            op: 'rescheduleTask',
            at,
            taskId: block.taskId,
            startedAt: start.toISOString(),
            minutes: minutesBetween(start, end),
          }
        : {
            op: 'adjustEntry',
            at,
            entryId: block.id,
            startedAt: start.toISOString(),
            endedAt: end.toISOString(),
          },
    )
  }

  /**
   * Deleting a scheduled block removes the task; deleting a trailed block
   * removes only that record of time, leaving the task alone. Both are soft
   * deletes, so a trailed block's task keeps the rest of its history.
   */
  function onDeleteBlock(block: Block) {
    const at = new Date().toISOString()
    enqueue(
      block.kind === 'scheduled'
        ? { op: 'deleteTask', at, taskId: block.taskId }
        : { op: 'deleteEntry', at, entryId: block.id },
    )
  }

  function onComplete(task: Task) {
    const at = new Date().toISOString()
    enqueue(
      task.completed_at
        ? { op: 'uncompleteTask', at, taskId: task.id }
        : { op: 'completeTask', at, taskId: task.id, completedAt: at },
    )
  }

  const today = todayIn(tz)
  const runningTask = snap.running
    ? snap.tasks.find((t) => t.id === snap.running!.task_id)
    : null

  const fmt = (key: string, opts: Intl.DateTimeFormatOptions) =>
    new Date(`${key}T12:00:00Z`).toLocaleDateString([], { ...opts, timeZone: 'UTC' })

  const columns: TimelineDay[] = dayKeys.map((key) => ({
    key,
    start: zonedDayStart(key, tz),
    end: zonedDayEnd(key, tz),
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
            <button className="link" onClick={() => setDay(today)}>
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
          <button
            className="link"
            onClick={() => {
              clearLocal()
              void supabase.auth.signOut()
            }}
          >
            {email} · sign out
          </button>
        </div>
      </header>

      {(!data.online || data.pending > 0) && (
        <p className={data.online ? 'syncbar syncing' : 'syncbar offline'}>
          {data.online
            ? `Syncing ${data.pending} change${data.pending === 1 ? '' : 's'}…`
            : data.pending > 0
              ? `Offline · ${data.pending} change${
                  data.pending === 1 ? '' : 's'
                } saved here, will sync`
              : 'Offline · showing the last saved view'}
        </p>
      )}

      {snap.running && (
        <section className="running">
          <span className="dot" aria-hidden="true" />
          <span className="what">{runningTask?.title ?? 'Running'}</span>
          <span className="clock">{hhmmss(elapsedMs(snap.running, now))}</span>
          <button className="stop" onClick={() => runningTask && toggle(runningTask)}>
            Stop
          </button>
        </section>
      )}

      {snap.running && isStale(snap.running, now) && (
        <p className="warn">
          Running over {STALE_TIMER_HOURS} hours — did you forget to stop it?
        </p>
      )}

      <nav className="tabs">
        <button className={tab === 'timeline' ? 'on' : ''} onClick={() => setTab('timeline')}>
          Timeline
        </button>
        <button className={tab === 'sequence' ? 'on' : ''} onClick={() => setTab('sequence')}>
          Sequence
        </button>
      </nav>

      <div className={`panes show-${tab}`}>
        <section className="pane timeline-pane">
          <Timeline
            days={columns}
            blocks={blocks}
            now={now}
            tz={tz}
            onReschedule={onReschedule}
            onDelete={onDeleteBlock}
          />
        </section>

        <Sequence
          tasks={snap.tasks}
          runningTaskId={snap.running?.task_id ?? null}
          title={title}
          onTitleChange={setTitle}
          onAdd={onAdd}
          onToggle={toggle}
          onComplete={onComplete}
          onClearCompleted={() =>
            enqueue({
              op: 'clearCompleted',
              at: new Date().toISOString(),
              taskIds: snap.tasks.filter((t) => t.completed_at).map((t) => t.id),
            })
          }
          onMove={(id, before, after) =>
            enqueue({
              op: 'moveTask',
              at: new Date().toISOString(),
              taskId: id,
              rank: rankBetween(before, after),
            })
          }
        />
      </div>

      {data.error && <p className="error">{data.error}</p>}

      {showRules && (
        <Recurrences tz={tz} onClose={() => setShowRules(false)} onChanged={data.refresh} />
      )}
    </div>
  )
}
