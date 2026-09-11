/**
 * Local-day arithmetic.
 *
 * Day boundaries are computed in the user's timezone (profiles.timezone), not
 * the device's, so a phone and a laptop in different zones agree about which day
 * a block belongs to.
 */

import type { DateOnly } from './types'

/** Offset (ms) between UTC and `tz` at the given instant. */
function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p: Record<string, string> = {}
  for (const part of dtf.formatToParts(at)) {
    if (part.type !== 'literal') p[part.type] = part.value
  }
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    // en-US with hour12:false renders midnight as "24"
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  )
  return asUtc - at.getTime()
}

/**
 * The absolute instant of a local wall-clock time in `tz`.
 *
 * This is the conversion recurrence expansion needs: "09:00 every weekday" is a
 * wall-clock rule, and 09:00 local is a different UTC instant either side of a
 * DST change. Adding hours to local midnight would drift by an hour on the two
 * transition days; resolving the whole wall time at once does not.
 */
export function zonedInstant(
  day: DateOnly,
  time: string | null,
  tz: string,
): Date {
  const [y, m, d] = day.split('-').map(Number)
  const [hh = 0, mm = 0, ss = 0] = (time ?? '00:00:00').split(':').map(Number)
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss)
  // Two passes: the first offset is sampled at the wrong instant near a DST
  // boundary, the second is sampled at (approximately) the right one.
  let ts = naive - tzOffsetMs(new Date(naive), tz)
  ts = naive - tzOffsetMs(new Date(ts), tz)
  return new Date(ts)
}

/** The instant local midnight begins on `day` in `tz`. */
export function zonedDayStart(day: DateOnly, tz: string): Date {
  return zonedInstant(day, null, tz)
}

/** Local midnight at the end of `day` — i.e. the start of the next day. */
export function zonedDayEnd(day: DateOnly, tz: string): Date {
  return zonedDayStart(addDays(day, 1), tz)
}

export function addDays(day: DateOnly, n: number): DateOnly {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.toISOString().slice(0, 10)
}

/** `day` shifted to the start of its week, honouring WEEK_STARTS_ON. */
export function startOfWeek(day: DateOnly, weekStartsOn: number): DateOnly {
  const [y, m, d] = day.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
  const delta = (dow - weekStartsOn + 7) % 7
  return addDays(day, -delta)
}

/** Today's calendar date in `tz`. */
export function todayIn(tz: string): DateOnly {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/**
 * Portion of [start, end) falling inside [winStart, winEnd), in ms.
 * A block spanning midnight contributes to both days; this is why per-day
 * totals must clip rather than summing duration_seconds.
 */
export function clippedMs(
  start: Date,
  end: Date,
  winStart: Date,
  winEnd: Date,
): number {
  const lo = Math.max(start.getTime(), winStart.getTime())
  const hi = Math.min(end.getTime(), winEnd.getTime())
  return Math.max(0, hi - lo)
}

/**
 * A block's time range, in the profile's timezone.
 *
 * Collapses a shared meridiem ("9:00–9:30 AM" rather than "9:00 AM–9:30 AM")
 * because a week column is about 5rem wide and the repetition costs more than
 * it explains. Locales that format 24-hour produce no meridiem at all, so the
 * parts are read rather than assumed.
 */
export function formatRange(
  start: Date,
  end: Date | null,
  tz: string,
  locale?: string,
): string {
  const at = (d: Date) => {
    const parts = new Intl.DateTimeFormat(locale ? [locale] : [], {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
    }).formatToParts(d)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    return { time: `${get('hour')}:${get('minute')}`, period: get('dayPeriod') }
  }

  const a = at(start)
  const suffix = (p: string) => (p ? ` ${p}` : '')
  if (!end) return `${a.time}${suffix(a.period)}–now`

  const b = at(end)
  return a.period === b.period
    ? `${a.time}–${b.time}${suffix(b.period)}`
    : `${a.time}${suffix(a.period)}–${b.time}${suffix(b.period)}`
}
