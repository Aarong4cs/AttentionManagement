import { useEffect, useRef, useState } from 'react'
import { TASK_COLORS } from '../lib/constants'

export interface MenuTarget {
  taskId: string
  title: string
  color: string | null
  priority: number | null
  /** A trailed block also offers removing just that record of time. */
  entryId?: string
  x: number
  y: number
}

export default function TaskMenu({
  target,
  onClose,
  onRename,
  onRecolor,
  onPrioritise,
  onRepeat,
  onDeleteTask,
  onDeleteEntry,
}: {
  target: MenuTarget
  onClose: () => void
  onRename: (taskId: string, title: string) => void
  onRecolor: (taskId: string, color: string | null) => void
  onPrioritise: (taskId: string, priority: number | null) => void
  onRepeat: (taskId: string) => void
  /** Omitted on the timeline: removing a whole task belongs to the sequence. */
  onDeleteTask?: (taskId: string) => void
  onDeleteEntry?: (entryId: string) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(target.title)
  const box = useRef<HTMLDivElement>(null)

  // keep the menu on screen when opened near an edge
  const [pos, setPos] = useState({ left: target.x, top: target.y })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(target.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - r.height - 8)),
    })
  }, [target.x, target.y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="menu-backdrop" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={box}
        className="menu"
        role="menu"
        style={{ left: pos.left, top: pos.top }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {renaming ? (
          <form
            className="menu-rename"
            onSubmit={(e) => {
              e.preventDefault()
              const next = name.trim()
              if (next && next !== target.title) onRename(target.taskId, next)
              onClose()
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Task name"
            />
            <button type="submit">Save</button>
          </form>
        ) : (
          <>
            <div className="menu-title">{target.title}</div>

            <button role="menuitem" onClick={() => setRenaming(true)}>
              Rename
            </button>

            <div className="menu-colors" role="group" aria-label="Colour">
              <button
                className={`swatch default${target.color === null ? ' on' : ''}`}
                aria-label="Default colour"
                onClick={() => {
                  onRecolor(target.taskId, null)
                  onClose()
                }}
              />
              {TASK_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch${target.color === c ? ' on' : ''}`}
                  data-color={c}
                  aria-label={c}
                  onClick={() => {
                    onRecolor(target.taskId, c)
                    onClose()
                  }}
                />
              ))}
            </div>

            <div className="menu-priority" role="group" aria-label="Priority">
              <button
                className={`prio none${target.priority === null ? ' on' : ''}`}
                aria-label="No priority"
                onClick={() => {
                  onPrioritise(target.taskId, null)
                  onClose()
                }}
              >
                —
              </button>
              {[1, 2, 3, 4, 5].map((p) => (
                <button
                  key={p}
                  className={`prio${target.priority === p ? ' on' : ''}`}
                  data-priority={p}
                  aria-label={`Priority ${p}`}
                  onClick={() => {
                    onPrioritise(target.taskId, p)
                    onClose()
                  }}
                >
                  P{p}
                </button>
              ))}
            </div>

            <button
              role="menuitem"
              onClick={() => {
                onRepeat(target.taskId)
                onClose()
              }}
            >
              Make repeating…
            </button>

            {onDeleteEntry && target.entryId && (
              <button
                role="menuitem"
                className="danger"
                onClick={() => {
                  onDeleteEntry(target.entryId!)
                  onClose()
                }}
              >
                Delete this time block
              </button>
            )}

            {onDeleteTask && (
              <button
                role="menuitem"
                className="danger"
                onClick={() => {
                  onDeleteTask(target.taskId)
                  onClose()
                }}
              >
                Delete task
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
