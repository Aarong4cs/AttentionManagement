import { TASK_COLORS } from '../lib/constants'

/**
 * Naming and colouring a block that has already been placed.
 *
 * This is the only point in the flow that wants a keyboard, which is the whole
 * reason it is a separate step: placing a block on a phone means aiming at a
 * row of the grid, and a field that focused itself on touch put the keyboard
 * over the target. Nothing is written until Save.
 */
export default function NewBlock({
  range,
  title,
  color,
  onTitleChange,
  onColorChange,
  onCancel,
  onSave,
}: {
  range: string
  /* held by the timeline, so closing this does not discard what is in it */
  title: string
  color: string | null
  onTitleChange: (v: string) => void
  onColorChange: (v: string | null) => void
  onCancel: () => void
  onSave: () => void
}) {
  const name = title.trim()

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <form
        className="sheet"
        aria-label="New block"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (name) onSave()
        }}
      >
        <header className="sheet-head">
          <h2>New block</h2>
          <button type="button" className="link" onClick={onCancel}>
            close
          </button>
        </header>

        <p className="muted hint">{range}</p>

        <input
          type="text"
          autoFocus
          value={title}
          placeholder="What is it?"
          onChange={(e) => onTitleChange(e.target.value)}
        />

        <div className="setting">
          <h3>Colour</h3>
          <div className="menu-colors" role="group" aria-label="Colour">
            <button
              type="button"
              className={`swatch default${color === null ? ' on' : ''}`}
              aria-label="Default colour"
              onClick={() => onColorChange(null)}
            />
            {TASK_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch${color === c ? ' on' : ''}`}
                data-color={c}
                aria-label={c}
                onClick={() => onColorChange(c)}
              />
            ))}
          </div>
        </div>

        <div className="row">
          <button type="submit" disabled={!name}>
            Save block
          </button>
          <button type="button" className="chip" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
