import type { FormEvent } from 'react'
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
}: {
  tasks: readonly Task[]
  runningTaskId: Uuid | null
  title: string
  onTitleChange: (v: string) => void
  onAdd: (e: FormEvent) => void
  onToggle: (task: Task) => void
  onComplete: (task: Task) => void
  onClearCompleted: () => void
}) {
  const hasCompleted = tasks.some((t) => t.completed_at)

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
        <ul className="seq">
          {tasks.map((task) => {
            const isOn = runningTaskId === task.id
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
                  onClick={() => onToggle(task)}
                >
                  {isOn ? 'Stop' : 'Start'}
                </button>
              </li>
            )
          })}
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
