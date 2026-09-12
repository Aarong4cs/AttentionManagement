import type { Preset } from '../lib/types'

/**
 * One button per preset, under the sequence.
 *
 * Press one to start its timer, press the lit one to stop it — the same as
 * Start and Stop on a sequence row. There is no tick and nothing to clear: a
 * preset is something you do again, not something you finish.
 */
export default function PresetGrid({
  presets,
  runningPresetId,
  onPress,
}: {
  presets: readonly Preset[]
  runningPresetId: string | null
  onPress: (preset: Preset) => void
}) {
  return (
    <section className="presets" aria-label="Presets">
      <h3>Presets</h3>
      {presets.length === 0 ? (
        <p className="muted hint">Add presets in Settings.</p>
      ) : (
        <div className="preset-grid">
          {presets.map((p) => {
            const on = runningPresetId === p.id
            return (
              <button
                key={p.id}
                className={on ? 'preset-button on' : 'preset-button'}
                aria-pressed={on}
                onClick={() => onPress(p)}
              >
                {p.title}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
