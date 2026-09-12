import { useState, type FormEvent } from 'react'
import type { Subtask, Task } from '../lib/types'

/**
 * A list of steps to tick off.
 *
 * Used twice: under the timer, where it is only for ticking, and in the sheet,
 * where steps are also renamed and removed. Passing onRename and onDelete is
 * what turns the first into the second.
 */
export function Checklist({
  steps,
  onToggle,
  onRename,
  onDelete,
}: {
  steps: readonly Subtask[]
  onToggle: (step: Subtask) => void
  onRename?: (step: Subtask, title: string) => void
  onDelete?: (step: Subtask) => void
}) {
  return (
    <ul className="checklist">
      {steps.map((step) => (
        <Step
          key={step.id}
          step={step}
          onToggle={onToggle}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </ul>
  )
}

function Step({
  step,
  onToggle,
  onRename,
  onDelete,
}: {
  step: Subtask
  onToggle: (step: Subtask) => void
  onRename?: (step: Subtask, title: string) => void
  onDelete?: (step: Subtask) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(step.title)
  const done = step.done_at !== null

  function commit() {
    const next = draft.trim()
    if (next && next !== step.title) onRename?.(step, next)
    setEditing(false)
  }

  const box = (
    <input
      type="checkbox"
      checked={done}
      onChange={() => onToggle(step)}
      aria-label={step.title}
    />
  )

  return (
    <li className={done ? 'done' : undefined}>
      {!onRename ? (
        // the whole line is the target: under the timer, a thumb is aiming at it
        <label className="step-label">
          {box}
          <span className="step-title">{step.title}</span>
        </label>
      ) : editing ? (
        <>
          {box}
          <input
            className="step-edit"
            type="text"
            autoFocus
            value={draft}
            aria-label={`Rename ${step.title}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              }
              if (e.key === 'Escape') {
                setDraft(step.title)
                setEditing(false)
              }
            }}
            onBlur={commit}
          />
        </>
      ) : (
        <>
          {box}
          <button
            className="step-title"
            onClick={() => {
              setDraft(step.title)
              setEditing(true)
            }}
          >
            {step.title}
          </button>
        </>
      )}
      {onDelete && (
        <button
          className="step-delete"
          aria-label={`Delete ${step.title}`}
          onClick={() => onDelete(step)}
        >
          ×
        </button>
      )}
    </li>
  )
}

/**
 * Writing the steps for one task.
 *
 * They replace the free-text description, which was already being used for
 * numbered steps — this makes each one real, so it can be ticked on its own.
 */
export default function Subtasks({
  task,
  steps,
  onAdd,
  onToggle,
  onRename,
  onDelete,
  onClose,
}: {
  task: Task
  steps: readonly Subtask[]
  onAdd: (title: string) => void
  onToggle: (step: Subtask) => void
  onRename: (step: Subtask, title: string) => void
  onDelete: (step: Subtask) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const done = steps.filter((x) => x.done_at !== null).length

  function add(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    onAdd(t)
    // stay in the field: steps usually go in several at a time
    setTitle('')
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label={`Steps for ${task.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2>{task.title}</h2>
          <button className="link" onClick={onClose}>
            close
          </button>
        </header>

        {steps.length > 0 ? (
          <>
            <p className="muted hint">
              {done} of {steps.length} done
            </p>
            <Checklist
              steps={steps}
              onToggle={onToggle}
              onRename={onRename}
              onDelete={onDelete}
            />
          </>
        ) : (
          <p className="muted hint">
            Break it into steps small enough to tick off. They show under the timer
            while you work on it.
          </p>
        )}

        <form className="add" onSubmit={add}>
          <input
            type="text"
            autoFocus
            value={title}
            placeholder="Add a step"
            onChange={(e) => setTitle(e.target.value)}
          />
          <button type="submit" disabled={!title.trim()}>
            Add
          </button>
        </form>
      </div>
    </div>
  )
}
