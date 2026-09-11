import { useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { insertionIndex } from '../lib/layout'
import { useLongPress } from '../hooks/useLongPress'
import type { Task, Uuid } from '../lib/types'

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
}: {
  tasks: readonly Task[]
  runningTaskId: Uuid | null
  title: string
  onTitleChange: (v: string) => void
  onAdd: (e: FormEvent) => void
  onToggle: (task: Task) => void
  onComplete: (task: Task) => void
  onClearCompleted: () => void
  onMove: (taskId: Uuid, before: string | null, after: string | null) => void
  onMenu: (task: Task, x: number, y: number) => void
}) {
  const rows = useRef(new Map<Uuid, HTMLLIElement>())
  const [dragId, setDragId] = useState<Uuid | null>(null)
  const [insertAt, setInsertAt] = useState<number | null>(null)

  const hasCompleted = tasks.some((t) => t.completed_at)
  const others = tasks.filter((t) => t.id !== dragId)

  /**
   * Pointer events rather than HTML5 drag-and-drop: the latter does not fire on
   * iOS at all, and this has to work on the phone first.
   */
  function onPointerDown(e: PointerEvent<HTMLButtonElement>, task: Task) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragId(task.id)
    setInsertAt(tasks.findIndex((t) => t.id === task.id))
  }

  function onPointerMove(e: PointerEvent<HTMLButtonElement>) {
    if (!dragId) return
    // midpoints of every row EXCEPT the one in hand, so the result is an index
    // into that list and names the two neighbours directly
    const midpoints = others
      .map((t) => rows.current.get(t.id))
      .filter((el): el is HTMLLIElement => Boolean(el))
      .map((el) => {
        const r = el.getBoundingClientRect()
        return r.top + r.height / 2
      })
    setInsertAt(insertionIndex(midpoints, e.clientY))
  }

  function onPointerUp(e: PointerEvent<HTMLButtonElement>) {
    if (dragId && insertAt !== null) {
      const before = others[insertAt - 1]?.rank ?? null
      const after = others[insertAt]?.rank ?? null
      const current = tasks.findIndex((t) => t.id === dragId)
      const unchanged =
        others[insertAt - 1]?.id === tasks[current - 1]?.id &&
        others[insertAt]?.id === tasks[current + 1]?.id
      if (!unchanged) onMove(dragId, before, after)
    }
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setDragId(null)
    setInsertAt(null)
  }

  return (
    <section className="pane sequence">
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
        <ul className={dragId ? 'seq is-dragging' : 'seq'}>
          {others.map((task, i) => (
            <RowGroup
              key={task.id}
              showLine={insertAt === i}
              task={task}
              rows={rows}
              dragId={dragId}
              runningTaskId={runningTaskId}
              onToggle={onToggle}
              onComplete={onComplete}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onMenu={onMenu}
            />
          ))}
          {insertAt === others.length && <li className="drop-line" aria-hidden="true" />}
          {dragId &&
            tasks
              .filter((t) => t.id === dragId)
              .map((task) => (
                <RowGroup
                  key={task.id}
                  showLine={false}
                  task={task}
                  rows={rows}
                  dragId={dragId}
                  runningTaskId={runningTaskId}
                  onToggle={onToggle}
                  onComplete={onComplete}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onMenu={onMenu}
                />
              ))}
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
  showLine,
  rows,
  dragId,
  runningTaskId,
  onToggle,
  onComplete,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onMenu,
}: {
  task: Task
  showLine: boolean
  rows: React.RefObject<Map<Uuid, HTMLLIElement>>
  dragId: Uuid | null
  runningTaskId: Uuid | null
  onToggle: (t: Task) => void
  onComplete: (t: Task) => void
  onPointerDown: (e: PointerEvent<HTMLButtonElement>, t: Task) => void
  onPointerMove: (e: PointerEvent<HTMLButtonElement>) => void
  onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void
  onMenu: (task: Task, x: number, y: number) => void
}) {
  const isOn = runningTaskId === task.id
  const isDragged = dragId === task.id
  const hold = useLongPress((x, y) => onMenu(task, x, y))
  return (
    <>
      {showLine && <li className="drop-line" aria-hidden="true" />}
      <li
        ref={(el) => {
          if (el) rows.current.set(task.id, el)
          else rows.current.delete(task.id)
        }}
        className={[task.completed_at ? 'done' : '', isDragged ? 'is-dragged' : '']
          .filter(Boolean)
          .join(' ')}
        data-color={task.color ?? undefined}
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
          onPointerDown={(e) => onPointerDown(e, task)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          ⠿
        </button>
        <input
          type="checkbox"
          checked={task.completed_at !== null}
          onChange={() => onComplete(task)}
          aria-label={`Complete ${task.title}`}
        />
        <span className="title">{task.title}</span>
        <button className={isOn ? 'toggle on' : 'toggle'} onClick={() => onToggle(task)}>
          {isOn ? 'Stop' : 'Start'}
        </button>
      </li>
    </>
  )
}
