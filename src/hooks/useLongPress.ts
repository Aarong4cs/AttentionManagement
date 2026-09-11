import { useRef, type PointerEvent as ReactPointerEvent } from 'react'

/** Movement beyond this cancels the press — it was a drag, not a hold. */
const SLOP_PX = 8
const HOLD_MS = 500

/**
 * Long-press as the touch equivalent of right-click.
 *
 * Blocks are also draggable, so a hold must be distinguishable from the start
 * of a drag: moving more than a few pixels cancels it. Without that, every
 * drag would open a menu on the way past.
 */
export function useLongPress(onHold: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)

  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    origin.current = null
  }

  return {
    onPointerDown(e: ReactPointerEvent) {
      if (e.pointerType === 'mouse') return // mouse gets contextmenu instead
      origin.current = { x: e.clientX, y: e.clientY }
      const { clientX, clientY } = e
      timer.current = setTimeout(() => onHold(clientX, clientY), HOLD_MS)
    },
    onPointerMove(e: ReactPointerEvent) {
      if (!origin.current) return
      const dx = Math.abs(e.clientX - origin.current.x)
      const dy = Math.abs(e.clientY - origin.current.y)
      if (dx > SLOP_PX || dy > SLOP_PX) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
  }
}
