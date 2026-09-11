import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { dragBlock, layoutDay, nowOffset } from '../lib/layout'
import { formatRange } from '../lib/time'
import { useLongPress } from '../hooks/useLongPress'
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

/**
 * Below this, a block is not tall enough for two lines of text and switches to
 * a single row. 24 minutes is about 25px on a 24-hour column.
 */
const TWO_LINE_MINUTES = 24

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
type Grab = {
  block: Block
  mode: 'move' | 'start' | 'end'
  originY: number
  /** ms represented by one pixel, measured from the rendered column */
  msPerPx: number
  start: Date
  end: Date
}

export default function Timeline({
  days,
  blocks,
  now,
  tz,
  onReschedule,
  onDelete,
  onMenu,
}: {
  days: readonly TimelineDay[]
  blocks: readonly Block[]
  now: Date
  tz: string
  onReschedule?: (block: Block, start: Date, end: Date) => void
  onDelete?: (block: Block) => void
  onMenu?: (block: Block, x: number, y: number) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)
  const [grab, setGrab] = useState<Grab | null>(null)
  const [preview, setPreview] = useState<{ start: Date; end: Date } | null>(null)
  const holdTarget = useRef<Block | null>(null)
  const hold = useLongPress((x, y) => {
    // a hold is not a drag: drop whatever the pointer had picked up
    setGrab(null)
    setPreview(null)
    if (holdTarget.current) onMenu?.(holdTarget.current, x, y)
  })

  /**
   * Pointer events, as with the sequence: HTML5 drag-and-drop does not fire on
   * iOS. The pixel-to-time scale is measured from the column actually rendered
   * rather than assumed, so it stays correct at any zoom or viewport.
   */
  function beginDrag(
    e: ReactPointerEvent<HTMLElement>,
    block: Block,
    mode: Grab['mode'],
    day: TimelineDay,
  ) {
    if (!onReschedule || block.running) return
    e.preventDefault()
    e.stopPropagation()
    const column = (e.currentTarget as HTMLElement).closest('.tl-col')
    if (!column) return
    const height = column.getBoundingClientRect().height
    if (height <= 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setGrab({
      block,
      mode,
      originY: e.clientY,
      msPerPx: (day.end.getTime() - day.start.getTime()) / height,
      start: block.start,
      end: block.end ?? now,
    })
    setPreview({ start: block.start, end: block.end ?? now })
  }

  function moveDrag(e: ReactPointerEvent<HTMLElement>) {
    if (!grab) return
    const deltaMs = (e.clientY - grab.originY) * grab.msPerPx
    setPreview(dragBlock(grab.start, grab.end, deltaMs, grab.mode))
  }

  function endDrag(e: ReactPointerEvent<HTMLElement>) {
    if (grab && preview) {
      const moved =
        preview.start.getTime() !== grab.start.getTime() ||
        preview.end.getTime() !== grab.end.getTime()
      if (moved) onReschedule?.(grab.block, preview.start, preview.end)
    }
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    setGrab(null)
    setPreview(null)
  }

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
            // while dragging, lay out against the previewed times so the block
            // follows the pointer instead of snapping back on release
            const shown = grab && preview
              ? blocks.map((b) =>
                  b.kind === grab.block.kind && b.id === grab.block.id
                    ? { ...b, start: preview.start, end: preview.end }
                    : b,
                )
              : blocks
            const positioned = layoutDay(shown, d.start, d.end, now)
            return (
              <div key={d.key} className={d.isToday ? 'tl-col is-today' : 'tl-col'}>
                {HOURS.map((h) => (
                  <div key={h} className="hour" style={{ top: `${(h / 24) * 100}%` }} />
                ))}

                {positioned.map(({ block, top, height, lane, lanes }) => {
                  const width = 100 / lanes
                  const range = formatRange(block.start, block.end, tz)
                  return (
                    <div
                      key={`${block.kind}-${block.id}`}
                      className={[
                        'block',
                        block.kind,
                        height * 24 * 60 < TWO_LINE_MINUTES ? 'is-short' : '',
                        // a lane inside a week column is ~40px: showing "10:…"
                        // beside "see…" helps nobody, so the name takes it all
                        days.length > 1 && lanes > 1 ? 'is-narrow' : '',
                        block.running ? 'is-running' : '',
                        block.completed ? 'is-done' : '',
                        onReschedule && !block.running ? 'is-draggable' : '',
                        grab?.block.id === block.id ? 'is-grabbed' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{
                        top: `${top * 100}%`,
                        height: `${height * 100}%`,
                        left: `${lane * width}%`,
                        width: `${width}%`,
                      }}
                      title={`${block.title} — ${range}`}
                      data-color={block.color ?? undefined}
                      onContextMenu={(e) => {
                        if (!onMenu) return
                        e.preventDefault()
                        onMenu(block, e.clientX, e.clientY)
                      }}
                      onPointerDown={(e) => {
                        hold.onPointerDown(e)
                        holdTarget.current = block
                        beginDrag(e, block, 'move', d)
                      }}
                      onPointerMove={(e) => {
                        hold.onPointerMove(e)
                        moveDrag(e)
                      }}
                      onPointerUp={(e) => {
                        hold.onPointerUp()
                        endDrag(e)
                      }}
                      onPointerCancel={(e) => {
                        hold.onPointerCancel()
                        endDrag(e)
                      }}
                    >
                      <span className="block-title">{block.title}</span>
                      <span className="block-time">{range}</span>

                      {onReschedule && !block.running && (
                        <>
                          <span
                            className="grab-edge top"
                            onPointerDown={(e) => beginDrag(e, block, 'start', d)}
                            onPointerMove={moveDrag}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                          />
                          <span
                            className="grab-edge bottom"
                            onPointerDown={(e) => beginDrag(e, block, 'end', d)}
                            onPointerMove={moveDrag}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                          />
                        </>
                      )}

                      {onDelete && (
                        <button
                          className="block-delete"
                          aria-label={`Delete ${block.title}`}
                          // the block itself begins a drag on pointerdown
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            onDelete(block)
                          }}
                        >
                          ×
                        </button>
                      )}
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
