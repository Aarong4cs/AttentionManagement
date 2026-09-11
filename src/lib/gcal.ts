/**
 * Turning Google Calendar events into timeline rows.
 *
 * Pure: no network, no database, no clock of its own. Everything here is the
 * part of the integration most likely to be wrong in ways that only show up as
 * a rejected insert or a block in the wrong place, so it is kept testable
 * without any of the machinery around it.
 */

// explicit extension: this module is imported directly by the node test
// runner, which does not resolve extensionless relative paths the way Vite does
import { MAX_ESTIMATE_MINUTES } from './constants.ts'
import type { DateOnly } from './types'

/** Only the fields this app reads. Google sends a great deal more. */
export interface GoogleEvent {
  id: string
  status?: string
  summary?: string
  etag?: string
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
}

export interface MirroredTask {
  external_id: string
  external_etag: string | null
  title: string
  due_at: string
  estimated_minutes: number
}

export type Mapped =
  | { kind: 'task'; task: MirroredTask }
  | { kind: 'delete'; externalId: string }
  /** All-day events, and anything without a usable interval. */
  | { kind: 'skip'; externalId: string; why: string }

const MS_PER_MINUTE = 60_000

/**
 * The sync window, snapped to month boundaries.
 *
 * Google requires identical query parameters on every incremental request, so a
 * window of "today − 30 days" would invalidate the sync token every morning and
 * degrade the whole thing into a permanent full resync. Snapping means it moves
 * once a month, deliberately.
 */
export function syncWindow(today: Date): {
  windowStart: DateOnly
  windowEnd: DateOnly
  timeMin: string
  timeMax: string
} {
  const y = today.getUTCFullYear()
  const m = today.getUTCMonth()
  const start = new Date(Date.UTC(y, m - 1, 1))
  // day 0 of month+4 is the last day of month+3
  const end = new Date(Date.UTC(y, m + 4, 0))
  return {
    windowStart: start.toISOString().slice(0, 10),
    windowEnd: end.toISOString().slice(0, 10),
    timeMin: start.toISOString(),
    timeMax: new Date(end.getTime() + 86_399_000).toISOString(),
  }
}

/** Has the window moved since this sync token was issued? */
export function windowChanged(
  stored: { windowStart: string | null; windowEnd: string | null },
  current: { windowStart: string; windowEnd: string },
): boolean {
  return (
    stored.windowStart !== current.windowStart ||
    stored.windowEnd !== current.windowEnd
  )
}

/**
 * One event, mapped.
 *
 * The clamps here are not defensive padding — each one corresponds to a CHECK
 * the insert would otherwise violate, taking the whole sync down with it:
 * title must be 1..500 characters, and estimated_minutes must be 1..1440.
 */
export function mapEvent(event: GoogleEvent): Mapped {
  if (event.status === 'cancelled') {
    return { kind: 'delete', externalId: event.id }
  }

  const startAt = event.start?.dateTime
  const endAt = event.end?.dateTime

  // An all-day event has `date` rather than `dateTime`. It has no place on a
  // 24-hour column, so it is skipped rather than stretched across one.
  if (!startAt || !endAt) {
    return { kind: 'skip', externalId: event.id, why: 'all-day or undated' }
  }

  const start = new Date(startAt)
  const end = new Date(endAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { kind: 'skip', externalId: event.id, why: 'unparseable times' }
  }

  const rawMinutes = Math.round((end.getTime() - start.getTime()) / MS_PER_MINUTE)
  if (rawMinutes <= 0) {
    return { kind: 'skip', externalId: event.id, why: 'zero or negative length' }
  }

  // A multi-day timed event would exceed the column it is drawn on, and the
  // CHECK caps it at a day regardless.
  const minutes = Math.min(rawMinutes, MAX_ESTIMATE_MINUTES)

  // Google allows an untitled event; the title CHECK does not.
  const title = (event.summary ?? '').trim().slice(0, 500) || '(no title)'

  return {
    kind: 'task',
    task: {
      external_id: event.id,
      external_etag: event.etag ?? null,
      title,
      due_at: start.toISOString(),
      estimated_minutes: minutes,
    },
  }
}
