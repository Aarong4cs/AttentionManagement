/**
 * The presets offered when the list is empty, each with its emoji.
 *
 * The emoji is matched by name, not stored: it belongs to the activity, so a
 * preset called "Eating" shows 🍽️ whether it came from the suggestions or was
 * typed in by hand. A preset with any other name simply has none.
 */
export const DEFAULT_PRESETS = [
  { title: 'Resting', emoji: '🛋️' },
  { title: 'Leisure', emoji: '🎮' },
  { title: 'Eating', emoji: '🍽️' },
  { title: 'Commuting', emoji: '🚗' },
] as const

const byName = new Map<string, string>(
  DEFAULT_PRESETS.map((p) => [p.title.toLowerCase(), p.emoji]),
)

/** The emoji for a default preset, by name; null for any other preset. */
export function presetEmoji(title: string): string | null {
  return byName.get(title.trim().toLowerCase()) ?? null
}
