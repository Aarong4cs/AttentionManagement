import { useEffect, useState } from 'react'

/**
 * A ticking clock for repaint only.
 *
 * Elapsed time is always `now - started_at`, recomputed from the stored
 * timestamp on every render. This interval never accumulates anything, so a tab
 * suspended by iOS for four hours repaints once on resume with the correct four
 * extra hours rather than having silently lost them.
 */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    // a resumed tab should correct immediately, not on the next tick
    const onWake = () => setNow(new Date())
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [intervalMs])

  return now
}
