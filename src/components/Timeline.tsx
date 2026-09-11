import { useEffect, useRef } from 'react'
import { layoutDay, nowOffset } from '../lib/layout'
import type { Block } from '../lib/types'

const HOURS = Array.from({ length: 24 }, (_, h) => h)

function label(h: number): string {
  if (h === 0) return ''
  const suffix = h < 12 ? 'am' : 'pm'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}${suffix}`
}

/**
 * Times MUST be formatted in the profile's timezone, not the browser's. The
 * grid is laid out in the profile's zone, so using the device's zone here
 * prints a label that contradicts the gridline it sits on.
 */
function clock(d: Date, tz: string): string {
  return d.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  })
}

export default function Timeline({
  blocks,
  dayStart,
  dayEnd,
  now,
  tz,
  onToggle,
}: {
  blocks: readonly Block[]
  dayStart: Date
  dayEnd: Date
  now: Date
  tz: string
  onToggle?: (taskId: string) => void
}) {
  const positioned = layoutDay(blocks, dayStart, dayEnd, now)
  const marker = nowOffset(dayStart, dayEnd, now)
  const scroller = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)

  // bring the current time into view once, rather than fighting the user's
  // scrolling on every tick
  useEffect(() => {
    if (scrolled.current || marker === null || !scroller.current) return
    const el = scroller.current
    el.scrollTop = Math.max(0, marker * el.scrollHeight - el.clientHeight / 2)
    scrolled.current = true
  }, [marker])

  return (
    <div className="timeline" ref={scroller}>
      <div className="grid">
        {HOURS.map((h) => (
          <div className="hour" key={h} style={{ top: `${(h / 24) * 100}%` }}>
            <span className="hour-label">{label(h)}</span>
          </div>
        ))}

        {positioned.map(({ block, top, height, lane, lanes }) => {
          const width = 100 / lanes
          return (
            <button
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
              onClick={onToggle ? () => onToggle(block.taskId) : undefined}
              title={`${block.title} — ${clock(block.start, tz)}${
                block.end ? `–${clock(block.end, tz)}` : ' (running)'
              }`}
            >
              <span className="block-title">{block.title}</span>
              <span className="block-time">
                {clock(block.start, tz)}
                {block.edited && ' · edited'}
              </span>
            </button>
          )
        })}

        {marker !== null && (
          <div className="now" style={{ top: `${marker * 100}%` }}>
            <span className="now-time">{clock(now, tz)}</span>
          </div>
        )}
      </div>
    </div>
  )
}
