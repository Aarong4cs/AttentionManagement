import { useEffect, useRef } from 'react'
import { layoutDay, nowOffset } from '../lib/layout'
import type { Block } from '../lib/types'

const HOURS = Array.from({ length: 24 }, (_, h) => h)

function hourLabel(h: number): string {
  if (h === 0) return ''
  const suffix = h < 12 ? 'am' : 'pm'
  return `${h % 12 === 0 ? 12 : h % 12}${suffix}`
}

/**
 * Times MUST be formatted in the profile's timezone, not the browser's. The
 * grid is laid out in the profile's zone, so the device's zone prints a label
 * that contradicts the gridline it sits on.
 */
function clock(d: Date, tz: string): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz })
}

export interface TimelineDay {
  key: string
  start: Date
  end: Date
  label: string
  isToday: boolean
}

/**
 * One scroller, N day columns. The day view is simply the one-column case, so
 * both views share all of this and the single range query that feeds it.
 */
export default function Timeline({
  days,
  blocks,
  now,
  tz,
}: {
  days: readonly TimelineDay[]
  blocks: readonly Block[]
  now: Date
  tz: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)

  const todayCol = days.find((d) => d.isToday)
  const marker = todayCol ? nowOffset(todayCol.start, todayCol.end, now) : null

  // bring the current time into view once, rather than fighting the user's
  // scrolling on every tick
  useEffect(() => {
    if (scrolled.current || marker === null || !scroller.current) return
    const el = scroller.current
    const body = el.querySelector('.tl-body') as HTMLElement | null
    if (!body) return
    el.scrollTop = Math.max(0, marker * body.offsetHeight - el.clientHeight / 2)
    scrolled.current = true
  }, [marker])

  return (
    <div className="timeline" ref={scroller}>
      <div
        // week columns are too narrow for a second line of text; the title wins
        // and the full range stays available on hover
        className={days.length > 1 ? 'tl dense' : 'tl'}
        style={{ ['--cols' as string]: String(days.length) }}
      >
        {days.length > 1 && (
          <div className="tl-head">
            <div className="tl-gutter-head" />
            {days.map((d) => (
              <div key={d.key} className={d.isToday ? 'tl-day is-today' : 'tl-day'}>
                {d.label}
              </div>
            ))}
          </div>
        )}

        <div className="tl-body">
          <div className="tl-gutter">
            {HOURS.map((h) => (
              <span key={h} className="hour-label" style={{ top: `${(h / 24) * 100}%` }}>
                {hourLabel(h)}
              </span>
            ))}
            {marker !== null && (
              <span className="now-time" style={{ top: `${marker * 100}%` }}>
                {clock(now, tz)}
              </span>
            )}
          </div>

          {days.map((d) => {
            const positioned = layoutDay(blocks, d.start, d.end, now)
            return (
              <div key={d.key} className={d.isToday ? 'tl-col is-today' : 'tl-col'}>
                {HOURS.map((h) => (
                  <div key={h} className="hour" style={{ top: `${(h / 24) * 100}%` }} />
                ))}

                {positioned.map(({ block, top, height, lane, lanes }) => {
                  const width = 100 / lanes
                  return (
                    <div
                      key={`${block.kind}-${block.id}`}
                      className={[
                        'block',
                        block.kind,
                        block.running ? 'is-running' : '',
                        block.completed ? 'is-done' : '',
                        block.edited ? 'is-edited' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{
                        top: `${top * 100}%`,
                        height: `${height * 100}%`,
                        left: `${lane * width}%`,
                        width: `${width}%`,
                      }}
                      title={`${block.title} — ${clock(block.start, tz)}${
                        block.end ? `–${clock(block.end, tz)}` : ' (running)'
                      }`}
                    >
                      <span className="block-title">{block.title}</span>
                      <span className="block-time">
                        {clock(block.start, tz)}
                        {block.edited && ' · edited'}
                      </span>
                    </div>
                  )
                })}

                {d.isToday && marker !== null && (
                  <div className="now" style={{ top: `${marker * 100}%` }} />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
