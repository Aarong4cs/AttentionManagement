import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { dragBlock, layoutDay, nowOffset, snap } from '../lib/layout'
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

/** A block created by clicking empty track, and the grid it lands on. */
const NEW_BLOCK_MINUTES = 30
const NEW_BLOCK_SNAP_MINUTES = 15

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
  /** the column the drag began in, so a sideways move can be measured */
  originDay: TimelineDay
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
  onCreate,
}: {
  days: readonly TimelineDay[]
  blocks: readonly Block[]
  now: Date
  tz: string
  onReschedule?: (block: Block, start: Date, end: Date) => void
  onDelete?: (block: Block) => void
  onMenu?: (block: Block, x: number, y: number) => void
  onCreate?: (start: Date, minutes: number, title: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)
  const [grab, setGrab] = useState<Grab | null>(null)
  const [preview, setPreview] = useState<{ start: Date; end: Date } | null>(null)
  // the window handlers close over one `grab`; the latest preview must come
  // from a ref or pointerup commits a stale position
  const previewRef = useRef<{ start: Date; end: Date } | null>(null)
  // the drag effect must depend on `grab` alone: re-registering window
  // listeners on every render would tear them down mid-gesture
  const daysRef = useRef(days)
  const rescheduleRef = useRef(onReschedule)
  useEffect(() => {
    daysRef.current = days
    rescheduleRef.current = onReschedule
  })
  const holdTarget = useRef<Block | null>(null)
  const [draft, setDraft] = useState<{ day: TimelineDay; start: Date; top: number } | null>(
    null,
  )
  const [draftTitle, setDraftTitle] = useState('')
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
    setGrab({
      block,
      mode,
      originY: e.clientY,
      msPerPx: (day.end.getTime() - day.start.getTime()) / height,
      originDay: day,
      start: block.start,
      end: block.end ?? now,
    })
    setPreview({ start: block.start, end: block.end ?? now })
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

  /*
   * The gesture is tracked on the window rather than on the block.
   *
   * Dragging sideways moves the block into a different day column, which
   * unmounts and remounts it — taking any pointer capture with it, so the drag
   * would go dead the moment it crossed a column and never commit. The window
   * does not care where the element went.
   */
  useEffect(() => {
    if (!grab) return

    /** Which day column the pointer is currently over, if any. */
    const dayUnder = (clientX: number): TimelineDay | null => {
      const cols = scroller.current?.querySelectorAll('.tl-col')
      if (!cols) return null
      for (let i = 0; i < cols.length; i++) {
        const r = cols[i].getBoundingClientRect()
        if (clientX >= r.left && clientX <= r.right) return daysRef.current[i] ?? null
      }
      return null
    }

    const onMove = (e: PointerEvent) => {
      let deltaMs = (e.clientY - grab.originY) * grab.msPerPx

      // The shift is the gap between the two columns' starts rather than a flat
      // 24h, so a block keeps its offset from midnight across a daylight-saving
      // change instead of sliding an hour.
      if (grab.mode === 'move') {
        const target = dayUnder(e.clientX)
        if (target) {
          deltaMs += target.start.getTime() - grab.originDay.start.getTime()
        }
      }

      const next = dragBlock(grab.start, grab.end, deltaMs, grab.mode)
      previewRef.current = next
      setPreview(next)
    }

    const onUp = () => {
      const next = previewRef.current
      if (next) {
        const moved =
          next.start.getTime() !== grab.start.getTime() ||
          next.end.getTime() !== grab.end.getTime()
        if (moved) rescheduleRef.current?.(grab.block, next.start, next.end)
      }
      previewRef.current = null
      setGrab(null)
      setPreview(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [grab])

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
              <div
                key={d.key}
                className={d.isToday ? 'tl-col is-today' : 'tl-col'}
                onClick={(e) => {
                  // only empty track, never a block or its controls
                  if (!onCreate || e.target !== e.currentTarget) return
                  const r = e.currentTarget.getBoundingClientRect()
                  const span = d.end.getTime() - d.start.getTime()
                  const at = snap(
                    d.start.getTime() + ((e.clientY - r.top) / r.height) * span,
                    NEW_BLOCK_SNAP_MINUTES,
                  )
                  setDraft({
                    day: d,
                    start: new Date(at),
                    top: (at - d.start.getTime()) / span,
                  })
                  setDraftTitle('')
                }}
              >
                {HOURS.map((h) => (
                  <div key={h} className="hour" style={{ top: `${(h / 24) * 100}%` }} />
                ))}

                {positioned.map(({ block, top, height, lane, lanes }) => {
                  const width = 100 / lanes
                  const range = formatRange(block.start, block.end, tz)
                  // Google owns a mirrored event. Anything that edited it here
                  // would be undone by the next sync, so none of it is offered
                  // — and it must not LOOK offered either.
                  const readOnly = block.source !== null
                  const canDrag = Boolean(onReschedule) && !block.running && !readOnly
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
                        canDrag ? 'is-draggable' : '',
                        readOnly ? 'is-external' : '',
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
                        if (canDrag) beginDrag(e, block, 'move', d)
                      }}
                      onPointerMove={hold.onPointerMove}
                      onPointerUp={hold.onPointerUp}
                      onPointerCancel={hold.onPointerCancel}
                    >
                      {readOnly && (
                        <span className="block-mark" aria-label="From Google Calendar">
                          ◷
                        </span>
                      )}
                      <span className="block-title">
                        {block.title}
                        {block.completesTask && (
                          <span className="done-badge"> (COMPLETED)</span>
                        )}
                      </span>
                      <span className="block-time">{range}</span>

                      {canDrag && (
                        <>
                          <span
                            className="grab-edge top"
                            onPointerDown={(e) => beginDrag(e, block, 'start', d)}
                          />
                          <span
                            className="grab-edge bottom"
                            onPointerDown={(e) => beginDrag(e, block, 'end', d)}
                          />
                        </>
                      )}

                      {/*
                        Only a trailed block: the × removes one record of time.
                        On a scheduled block it would delete the task, which now
                        belongs to the sequence alone.
                      */}
                      {onDelete && block.kind === 'trailed' && !readOnly && (
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

                {draft && draft.day.key === d.key && (
                  <form
                    className="draft"
                    style={{
                      top: `${draft.top * 100}%`,
                      height: `${(NEW_BLOCK_MINUTES / (24 * 60)) * 100}%`,
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onSubmit={(e) => {
                      e.preventDefault()
                      const t = draftTitle.trim()
                      if (t) onCreate?.(draft.start, NEW_BLOCK_MINUTES, t)
                      setDraft(null)
                    }}
                  >
                    <input
                      autoFocus
                      value={draftTitle}
                      placeholder={formatRange(
                        draft.start,
                        new Date(draft.start.getTime() + NEW_BLOCK_MINUTES * 60_000),
                        tz,
                      )}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => e.key === 'Escape' && setDraft(null)}
                      onBlur={() => {
                        const t = draftTitle.trim()
                        if (t) onCreate?.(draft.start, NEW_BLOCK_MINUTES, t)
                        setDraft(null)
                      }}
                    />
                  </form>
                )}

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
