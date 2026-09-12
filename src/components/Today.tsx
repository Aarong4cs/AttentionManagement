import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNow } from '../hooks/useNow'
import { useOfflineData } from '../hooks/useOfflineData'
import {
  draftPreset,
  draftSubtask,
  draftTask,
  elapsedMs,
  getProfile,
  isStale,
  newId,
} from '../lib/db'
import { minutesBetween } from '../lib/layout'
import { buildBlocks, loadSnapshot } from '../lib/offline'
import { rankAppend, rankBetween, ranksBetween } from '../lib/rank'
import { STALE_TIMER_HOURS, WEEK_STARTS_ON } from '../lib/constants'
import { addDays, startOfWeek, todayIn, zonedDayEnd, zonedDayStart } from '../lib/time'
import type { Block, Preset, Subtask, Task, Uuid } from '../lib/types'
import Timeline, { type TimelineDay } from './Timeline'
import Sequence from './Sequence'
import TaskMenu, { type MenuTarget } from './TaskMenu'
import GoogleCalendar from './GoogleCalendar'
import Settings from './Settings'
import Subtasks from './Subtasks'

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
  const [showCalendar, setShowCalendar] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [slowSync, setSlowSync] = useState(false)
  const [menu, setMenu] = useState<(MenuTarget & { fromSequence: boolean }) | null>(
    null,
  )
  /** The task whose steps sheet is open. */
  const [stepsFor, setStepsFor] = useState<Uuid | null>(null)
  const now = useNow()

  useEffect(() => {
    // correct the cached zone from the server whenever that becomes possible
    getProfile()
      .then((p) => {
        if (p.timezone !== cachedZone()) {
          setTz(p.timezone)
          setDay(todayIn(p.timezone))
        }
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

  /*
   * A preset's task lives in snap.tasks — it has no due date, and the timer
   * banner reads its name from there — but it is not part of the sequence.
   * Filtered once, here, so nothing that works on the sequence ever sees one.
   */
  const sequenceTasks = useMemo(
    () => snap.tasks.filter((t) => t.preset_id === null),
    [snap.tasks],
  )

  /**
   * A sync that finishes in a few hundred milliseconds should not announce
   * itself. Every drag enqueues an operation, and flashing a banner for each
   * one is noise. Being offline is different — that state is worth stating
   * immediately, because it changes what the user should expect.
   */
  useEffect(() => {
    if (!data.online || data.pending === 0) {
      // oxlint-disable-next-line react/set-state-in-effect
      setSlowSync(false)
      return
    }
    const timer = setTimeout(() => setSlowSync(true), 700)
    return () => clearTimeout(timer)
  }, [data.online, data.pending])

  function onAdd(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    setTitle('')
    const task = draftTask({
      id: newId(),
      user_id: snap.profile?.id ?? '',
      title: t,
      rank: rankAppend(snap.tasks.map((x) => x.rank)),
    })
    enqueue({ op: 'createTask', at: new Date().toISOString(), task })
  }

  /** A click on empty track: a scheduled block, so it lands on the timeline. */
  function onCreateAt(start: Date, end: Date, title: string, color: string | null) {
    const at = new Date().toISOString()
    // the draft was resized on the grid, so its own end is the estimate
    const minutes = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000))
    enqueue({
      op: 'createTask',
      at,
      task: draftTask({
        id: newId(),
        user_id: snap.profile?.id ?? '',
        title,
        color,
        rank: rankAppend(snap.tasks.map((x) => x.rank)),
        due_at: start.toISOString(),
        estimated_minutes: minutes,
        // mirrors the trigger, so the block draws at its full height at once
        scheduled_end: end.toISOString(),
      }),
    })
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

  function openBlockMenu(block: Block, x: number, y: number) {
    const task = snap.tasks.find((t) => t.id === block.taskId)
    setMenu({
      taskId: block.taskId,
      title: block.title,
      color: block.color,
      priority: task?.priority ?? null,
      // only a trailed block has a single record of time to remove
      entryId: block.kind === 'trailed' ? block.id : undefined,
      readOnly: block.source !== null,
      x,
      y,
      /*
       * Deleting a task belongs to the sequence — except for a scheduled block,
       * which is never IN the sequence: getSequence only returns tasks with no
       * due_at. Withholding it there left blocks created on the timeline with no
       * way to be deleted at all.
       *
       * A trailed block still only offers removing that record of time, because
       * its task does live in the sequence.
       */
      fromSequence: block.kind === 'scheduled' && block.source === null,
    })
  }

  function openTaskMenu(task: Task, x: number, y: number) {
    setMenu({
      taskId: task.id,
      title: task.title,
      color: task.color,
      priority: task.priority,
      x,
      y,
      fromSequence: true,
    })
  }

  /**
   * Start a preset's timer. Each preset is backed by one task, made the first
   * time it runs and reused after that, so all of its time stays together. If
   * two devices each made one while offline, the oldest is the one reused.
   */
  function startPreset(preset: Preset) {
    const at = new Date().toISOString()
    let task = snap.tasks
      .filter((t) => t.preset_id === preset.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
    if (!task) {
      task = draftTask({
        id: newId(),
        user_id: snap.profile?.id ?? '',
        title: preset.title,
        rank: rankAppend(snap.tasks.map((x) => x.rank)),
        preset_id: preset.id,
      })
      enqueue({ op: 'createTask', at, task })
    }
    // picking the one already running leaves it running rather than stopping it
    if (snap.running?.task_id === task.id) return
    toggle(task)
  }

  function toggleSubtask(step: Subtask) {
    const at = new Date().toISOString()
    enqueue({ op: 'toggleSubtask', at, subtaskId: step.id, doneAt: step.done_at ? null : at })
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
            <button className="accent" onClick={() => setDay(today)}>
              Today
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
          <button className="chip" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </header>

      {(!data.online || slowSync) && (
        <p
          className={data.online ? 'syncbar syncing' : 'syncbar offline'}
          role="status"
        >
          {data.online
            ? `Syncing ${data.pending} change${data.pending === 1 ? '' : 's'}…`
            : data.pending > 0
              ? `Offline · ${data.pending} change${
                  data.pending === 1 ? '' : 's'
                } saved here, will sync`
              : 'Offline · showing the last saved view'}
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
            onMenu={openBlockMenu}
            onCreate={onCreateAt}
          />
        </section>

        <Sequence
          tasks={sequenceTasks}
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
              taskIds: sequenceTasks.filter((t) => t.completed_at).map((t) => t.id),
            })
          }
          onMenu={openTaskMenu}
          subtasks={snap.subtasks}
          onToggleSubtask={toggleSubtask}
          running={
            snap.running ? (
              <>
                <section className="running">
                  <span className="dot" aria-hidden="true" />
                  <span className="what">{runningTask?.title ?? 'Running'}</span>
                  <span className="clock">{hhmmss(elapsedMs(snap.running, now))}</span>
                  <button
                    className="stop"
                    onClick={() => runningTask && toggle(runningTask)}
                  >
                    Stop
                  </button>
                </section>
                {isStale(snap.running, now) && (
                  <p className="warn">
                    Running over {STALE_TIMER_HOURS} hours — did you forget to stop it?
                  </p>
                )}
              </>
            ) : null
          }
          onRename={(taskId, title) =>
            enqueue({ op: 'renameTask', at: new Date().toISOString(), taskId, title })
          }
          onMove={(id, before, after) => {
            const at = new Date().toISOString()
            enqueue({
              op: 'moveTask',
              at,
              taskId: id,
              rank: rankBetween(before?.rank ?? null, after?.rank ?? null),
            })
          }}
        />
      </div>

      {data.error && <p className="error">{data.error}</p>}

      {menu && (
        <TaskMenu
          target={menu}
          onClose={() => setMenu(null)}
          onRename={(taskId, title) =>
            enqueue({ op: 'renameTask', at: new Date().toISOString(), taskId, title })
          }
          onRecolor={(taskId, color) =>
            enqueue({ op: 'recolorTask', at: new Date().toISOString(), taskId, color })
          }
          onPrioritise={(taskId, priority) =>
            enqueue({ op: 'setPriority', at: new Date().toISOString(), taskId, priority })
          }
          onSubtasks={
            // steps show under the timer, and only a sequence task can run
            sequenceTasks.some((t) => t.id === menu.taskId) ? setStepsFor : undefined
          }
          presets={snap.profile?.presets_enabled ? snap.presets : undefined}
          runningPresetId={runningTask?.preset_id ?? null}
          onStartPreset={startPreset}
          onDeleteTask={
            // deleting the whole task belongs to the sequence; the timeline
            // only ever removes a single record of time
            menu.fromSequence
              ? (taskId) =>
                  enqueue({ op: 'deleteTask', at: new Date().toISOString(), taskId })
              : undefined
          }
          onDeleteEntry={(entryId) =>
            enqueue({ op: 'deleteEntry', at: new Date().toISOString(), entryId })
          }
        />
      )}

      {stepsFor &&
        (() => {
          const task = snap.tasks.find((t) => t.id === stepsFor)
          if (!task) return null
          const steps = snap.subtasks.filter((x) => x.task_id === task.id)
          return (
            <Subtasks
              task={task}
              steps={steps}
              onClose={() => setStepsFor(null)}
              onAdd={(title) =>
                enqueue({
                  op: 'createSubtask',
                  at: new Date().toISOString(),
                  subtask: draftSubtask({
                    id: newId(),
                    user_id: snap.profile?.id ?? '',
                    task_id: task.id,
                    title,
                    rank: rankAppend(steps.map((x) => x.rank)),
                  }),
                })
              }
              onToggle={toggleSubtask}
              onRename={(step, title) =>
                enqueue({
                  op: 'renameSubtask',
                  at: new Date().toISOString(),
                  subtaskId: step.id,
                  title,
                })
              }
              onDelete={(step) =>
                enqueue({
                  op: 'deleteSubtask',
                  at: new Date().toISOString(),
                  subtaskId: step.id,
                })
              }
            />
          )
        })()}

      {showSettings && (
        <Settings
          email={email}
          onClose={() => setShowSettings(false)}
          onOpenCalendar={() => setShowCalendar(true)}
          onChanged={data.refresh}
          presets={snap.presets}
          presetsEnabled={snap.profile?.presets_enabled ?? false}
          onTogglePresets={(enabled) =>
            enqueue({ op: 'setPresetsEnabled', at: new Date().toISOString(), enabled })
          }
          onAddPresets={(titles) => {
            const at = new Date().toISOString()
            // one key per title, so a batch keeps the order it was given in
            const last = snap.presets[snap.presets.length - 1]?.rank ?? null
            const keys = ranksBetween(last, null, titles.length)
            titles.forEach((title, i) =>
              enqueue({
                op: 'createPreset',
                at,
                preset: draftPreset({
                  id: newId(),
                  user_id: snap.profile?.id ?? '',
                  title,
                  rank: keys[i],
                }),
              }),
            )
          }}
          onDeletePreset={(preset) =>
            enqueue({ op: 'deletePreset', at: new Date().toISOString(), presetId: preset.id })
          }
        />
      )}

      {showCalendar && (
        <GoogleCalendar
          onClose={() => setShowCalendar(false)}
          onChanged={data.refresh}
        />
      )}

    </div>
  )
}
