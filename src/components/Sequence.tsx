import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { insertionIndex } from '../lib/layout'
import { useLongPress } from '../hooks/useLongPress'
import type { Task, Uuid } from '../lib/types'

/**
 * A drag in progress. Everything here is measured once, when the grip is
 * pressed, and never again.
 *
 * `mids` is the row midpoints of the ORIGINAL list, and the pointer is mapped
 * against those for the whole gesture. Measuring live would feed back on
 * itself: the rows move as the gap opens, which moves the midpoints, which
 * moves the gap. Freezing the coordinate system is what stops it oscillating
 * on the boundary between two rows.
 */
type Drag = {
  id: Uuid
  /** index of the dragged row in the original list */
  from: number
  /**
   * The positions this row is allowed to take, as original indices, `hi`
   * exclusive. A P1 cannot be dragged in among the P3s: the list is sorted by
   * priority first, so a row dropped outside its group would be sorted
   * straight back and the rank written for it would have been derived from two
   * neighbours in no particular order. Priority is changed from the menu.
   */
  lo: number
  hi: number
  mids: number[]
  /** the floating row's box, so it sits exactly over the list it came from */
  left: number
  width: number
  height: number
  offsetY: number
  scroller: HTMLElement | null
  scrollTop: number
}

/** Where the pointer says the row belongs, in original-list coordinates. */
function targetIndex(drag: Drag, clientY: number): number {
  const scrolled = (drag.scroller?.scrollTop ?? 0) - drag.scrollTop
  const raw = insertionIndex(drag.mids, clientY + scrolled)
  // the row follows the pointer, but the slot stops at its group's edges
  return Math.min(Math.max(raw, drag.lo), drag.hi)
}

/** ...and the same thing as an index into the list without the dragged row. */
function slotIndex(drag: Drag, clientY: number): number {
  const to = targetIndex(drag, clientY)
  return to > drag.from ? to - 1 : to
}

export default function Sequence({
  tasks,
  runningTaskId,
  title,
  onTitleChange,
  onAdd,
  onToggle,
  onComplete,
  onClearCompleted,
  onMove,
  onMenu,
  onRename,
  running,
}: {
  tasks: readonly Task[]
  runningTaskId: Uuid | null
  title: string
  onTitleChange: (v: string) => void
  onAdd: (e: FormEvent) => void
  onToggle: (task: Task) => void
  onComplete: (task: Task) => void
  onClearCompleted: () => void
  onMove: (taskId: Uuid, before: Task | null, after: Task | null) => void
  onMenu: (task: Task, x: number, y: number) => void
  onRename: (taskId: Uuid, title: string) => void
  /** The running-timer banner, rendered here so it sits above the add form. */
  running?: ReactNode
}) {
  const rows = useRef(new Map<Uuid, HTMLLIElement>())
  const list = useRef<HTMLUListElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [pointerY, setPointerY] = useState(0)
  // the window handlers close over one `drag`; the latest pointer must come
  // from a ref or pointerup commits a stale position
  const pointerRef = useRef(0)
  const tasksRef = useRef(tasks)
  const moveRef = useRef(onMove)
  useEffect(() => {
    tasksRef.current = tasks
    moveRef.current = onMove
  })

  const hasCompleted = tasks.some((t) => t.completed_at)
  // the description of whatever is being tracked right now
  const runningTask = runningTaskId
    ? tasks.find((t) => t.id === runningTaskId)
    : undefined

  const dragged = drag ? tasks.find((t) => t.id === drag.id) : undefined
  const others = drag ? tasks.filter((t) => t.id !== drag.id) : tasks
  const slot = drag ? slotIndex(drag, pointerY) : -1

  /**
   * Pointer events rather than HTML5 drag-and-drop: the latter does not fire on
   * iOS at all, and this has to work on the phone first.
   */
  function beginDrag(e: PointerEvent<HTMLButtonElement>, task: Task) {
    e.preventDefault()
    e.stopPropagation()
    const from = tasks.findIndex((t) => t.id === task.id)
    const self = rows.current.get(task.id)?.getBoundingClientRect()
    const box = list.current?.getBoundingClientRect()
    if (from < 0 || !self || !box) return
    // the group is contiguous, because the list is sorted by priority first
    const same = (t: Task) => (t.priority ?? null) === (task.priority ?? null)
    let lo = from
    let hi = from
    while (lo > 0 && same(tasks[lo - 1])) lo--
    while (hi < tasks.length - 1 && same(tasks[hi + 1])) hi++
    setDrag({
      id: task.id,
      from,
      lo,
      hi: hi + 1,
      mids: tasks.map((t) => {
        const r = rows.current.get(t.id)?.getBoundingClientRect()
        return r ? r.top + r.height / 2 : Infinity
      }),
      left: box.left,
      width: box.width,
      height: self.height,
      offsetY: e.clientY - self.top,
      scroller: list.current?.closest('.sequence') ?? null,
      scrollTop: list.current?.closest('.sequence')?.scrollTop ?? 0,
    })
    pointerRef.current = e.clientY
    setPointerY(e.clientY)
  }

  /*
   * Tracked on the window, not the grip.
   *
   * The row is pulled out of the list the moment the drag starts, which
   * unmounts the element the gesture began on and takes any pointer capture
   * with it — the handle would go dead on the first move. The window does not
   * care what happened to the element.
   */
  useEffect(() => {
    if (!drag) return

    const move = (e: globalThis.PointerEvent) => {
      pointerRef.current = e.clientY
      setPointerY(e.clientY)
    }
    const up = () => {
      const all = tasksRef.current
      const rest = all.filter((t) => t.id !== drag.id)
      const at = slotIndex(drag, pointerRef.current)
      const before = rest[at - 1] ?? null
      const after = rest[at] ?? null
      const unchanged =
        before?.id === all[drag.from - 1]?.id && after?.id === all[drag.from + 1]?.id
      if (!unchanged) moveRef.current(drag.id, before, after)
      setDrag(null)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [drag])

  return (
    <section className="pane sequence">
      {running}

      {runningTask?.notes && (
        <section className="running-notes" aria-live="polite">
          <h3>{runningTask.title}</h3>
          {/* pre-wrap, so a list of steps stays a list of steps */}
          <p>{runningTask.notes}</p>
        </section>
      )}

      <form className="add" onSubmit={onAdd}>
        <input
          value={title}
          placeholder="Add a task"
          onChange={(e) => onTitleChange(e.target.value)}
        />
        <button type="submit">Add</button>
      </form>

      {tasks.length === 0 ? (
        <p className="muted">Nothing in the sequence.</p>
      ) : (
        <ul className={drag ? 'seq is-dragging' : 'seq'} ref={list}>
          {/*
            The dragged row leaves the list and a slot of its exact height
            takes its place, so the rows around it settle into the order they
            will actually be in. Releasing only writes down what is already
            on screen.
          */}
          {others.map((task, i) => (
            <Fragment key={task.id}>
              {i === slot && (
                <li className="seq-slot" style={{ height: drag?.height }} aria-hidden="true" />
              )}
              <RowGroup
                task={task}
                rows={rows}
                runningTaskId={runningTaskId}
                onToggle={onToggle}
                onComplete={onComplete}
                onPointerDown={beginDrag}
                onMenu={onMenu}
                onRename={onRename}
              />
            </Fragment>
          ))}
          {slot === others.length && (
            <li className="seq-slot" style={{ height: drag?.height }} aria-hidden="true" />
          )}
        </ul>
      )}

      {/*
        The row in hand, following the pointer. A copy rather than the original
        element: the original has to leave the list for the others to close up
        behind it.
      */}
      {drag && dragged && (
        <ul
          className="seq seq-float"
          aria-hidden="true"
          style={{ left: drag.left, width: drag.width, top: pointerY - drag.offsetY }}
        >
          <RowGroup
            task={dragged}
            rows={{ current: new Map() }}
            runningTaskId={runningTaskId}
            onToggle={() => {}}
            onComplete={() => {}}
            onPointerDown={() => {}}
            onMenu={() => {}}
            onRename={() => {}}
          />
        </ul>
      )}

      {hasCompleted && (
        <button className="link clear" onClick={onClearCompleted}>
          Clear completed
        </button>
      )}
    </section>
  )
}

function RowGroup({
  task,
  rows,
  runningTaskId,
  onToggle,
  onComplete,
  onPointerDown,
  onMenu,
  onRename,
}: {
  task: Task
  rows: React.RefObject<Map<Uuid, HTMLLIElement>>
  runningTaskId: Uuid | null
  onToggle: (t: Task) => void
  onComplete: (t: Task) => void
  onPointerDown: (e: PointerEvent<HTMLButtonElement>, t: Task) => void
  onMenu: (task: Task, x: number, y: number) => void
  onRename: (taskId: Uuid, title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.title)
  const isOn = runningTaskId === task.id
  const hold = useLongPress((x, y) => onMenu(task, x, y))
  return (
    <>
      <li
        ref={(el) => {
          if (el) rows.current.set(task.id, el)
          else rows.current.delete(task.id)
        }}
        className={task.completed_at ? 'done' : undefined}
        data-color={task.color ?? undefined}
        data-priority={task.priority ?? undefined}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu(task, e.clientX, e.clientY)
        }}
        onPointerDown={hold.onPointerDown}
        onPointerMove={hold.onPointerMove}
        onPointerUp={hold.onPointerUp}
        onPointerCancel={hold.onPointerCancel}
      >
        <button
          className="grip"
          aria-label={`Reorder ${task.title}`}
          onPointerDown={(e) => {
            // the row listens for a long-press; the grip is unambiguously a drag
            e.stopPropagation()
            onPointerDown(e, task)
          }}
        >
          ⠿
        </button>
        <input
          type="checkbox"
          checked={task.completed_at !== null}
          onChange={() => onComplete(task)}
          aria-label={`Complete ${task.title}`}
        />
        {task.priority !== null && (
          <span className="prio-tag" data-priority={task.priority}>
            P{task.priority}
          </span>
        )}
        {editing ? (
          <form
            className="title-edit"
            onSubmit={(e) => {
              e.preventDefault()
              const next = draft.trim()
              if (next && next !== task.title) onRename(task.id, next)
              setEditing(false)
            }}
          >
            <input
              autoFocus
              value={draft}
              aria-label={`Rename ${task.title}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDraft(task.title)
                  setEditing(false)
                }
              }}
              onBlur={(e) => {
                const next = e.target.value.trim()
                if (next && next !== task.title) onRename(task.id, next)
                setEditing(false)
              }}
            />
          </form>
        ) : (
          <button
            className="title"
            onClick={() => {
              setDraft(task.title)
              setEditing(true)
            }}
          >
            {task.title}
          </button>
        )}
        <button className={isOn ? 'toggle on' : 'toggle'} onClick={() => onToggle(task)}>
          {isOn ? 'Stop' : 'Start'}
        </button>
      </li>
    </>
  )
}
