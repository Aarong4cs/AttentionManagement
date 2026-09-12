import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { dragBlock, layoutDay, nowOffset, snap } from '../lib/layout'
import { formatRange, timeOfDay } from '../lib/time'
import { useLongPress } from '../hooks/useLongPress'
import NewBlock from './NewBlock'
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
  return timeOfDay(d, tz)
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
  /** null while dragging the draft, which is not a block until it is saved */
  block: Block | null
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
  onCreate?: (start: Date, end: Date, title: string, color: string | null) => void
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
  /*
   * An unsaved block. It exists only on screen: you place and size it first,
   * and nothing is written until the sheet is filled in and saved. Opening a
   * focused field the instant you touch the grid put a keyboard over the very
   * thing you were trying to aim at.
   */
  const [draft, setDraft] = useState<{
    day: TimelineDay
    start: Date
    end: Date
  } | null>(null)
  const [editing, setEditing] = useState(false)
  /*
   * The draft's name and colour live out here, not in the sheet.
   *
   * They decide whether the draft is worth keeping: an untouched one is just a
   * rectangle you put down and walked away from, and a press elsewhere throws
   * it away. Once it has a name or a colour it is work, and only Discard
   * removes it. Keeping them here also means closing the sheet does not lose
   * what was typed into it.
   */
  const [draftTitle, setDraftTitle] = useState('')
  const [draftColor, setDraftColor] = useState<string | null>(null)
  const touched = draftTitle.trim() !== '' || draftColor !== null

  const clearDraft = useCallback(() => {
    setDraft(null)
    setEditing(false)
    setDraftTitle('')
    setDraftColor(null)
  }, [])
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
    block: Block | null,
    mode: Grab['mode'],
    day: TimelineDay,
    range?: { start: Date; end: Date },
  ) {
    if (block && (!onReschedule || block.running)) return
    e.preventDefault()
    e.stopPropagation()
    // one thing in hand at a time: reaching for a real block abandons a draft
    // nobody has bothered to name
    if (block && draft && !touched) clearDraft()
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
      start: range?.start ?? block!.start,
      end: range?.end ?? block!.end ?? now,
    })
    setPreview(range ?? { start: block!.start, end: block!.end ?? now })
  }

  // Escape drops an unsaved draft, the same way it dismissed the old field
  useEffect(() => {
    if (!draft) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearDraft()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, clearDraft])

  /*
   * A press anywhere outside the timeline puts an unnamed draft away.
   *
   * Only an unnamed one: the point of placing first and naming second is that
   * a block costs nothing until you commit to it, and that only holds if
   * walking away is free. Once it has a name or a colour, walking away would
   * throw work out, so it stays until Discard.
   */
  useEffect(() => {
    if (!draft || touched) return
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest('.timeline-pane, .sheet-backdrop, .menu')) return
      clearDraft()
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [draft, touched, clearDraft])

  const todayCol = days.find((d) => d.isToday)
  const marker = todayCol ? nowOffset(todayCol.start, todayCol.end, now) : null

  /*
   * A coarser clock, for layout only.
   *
   * `now` ticks every second because the elapsed-time readout needs it. Layout
   * does not: a day column is 96rem tall, so a running block grows about a
   * hundredth of a pixel per second. Re-clipping and re-laning every block in
   * the week sixty times a minute produced no visible change at all. Twice a
   * minute is still under one pixel of drift.
   */
  const layoutNow = useMemo(
    () => new Date(Math.floor(now.getTime() / 30_000) * 30_000),
    [now],
  )

  // one substitution for the whole grid, rather than one per column
  const shown = useMemo(
    () =>
      grab?.block && preview
        ? blocks.map((b) =>
            b.kind === grab.block!.kind && b.id === grab.block!.id
              ? { ...b, start: preview.start, end: preview.end }
              : b,
          )
        : blocks,
    [blocks, grab, preview],
  )

  const byDay = useMemo(
    () => days.map((d) => layoutDay(shown, d.start, d.end, layoutNow)),
    [days, shown, layoutNow],
  )

  /*
   * Where the draft is right now, which mid-drag is not where it is stored.
   * `draft.day` only catches up on release, so gating the render on it drew
   * the block in the column it came FROM, at an offset measured against that
   * column — off the end of it, and so invisible, until the pointer came up.
   */
  const draftLive = draft && grab && !grab.block && preview ? preview : draft
  const draftDay = draftLive
    ? (days.find((x) => draftLive.start >= x.start && draftLive.start < x.end) ??
       draft?.day)
    : null

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
      if (next && grab.block) {
        const moved =
          next.start.getTime() !== grab.start.getTime() ||
          next.end.getTime() !== grab.end.getTime()
        if (moved) rescheduleRef.current?.(grab.block, next.start, next.end)
      } else if (next) {
        // the draft is not persisted, so a move is just its new position —
        // including into another column, which the day it lands in decides
        setDraft((d) =>
          d
            ? {
                day:
                  daysRef.current.find(
                    (x) => next.start >= x.start && next.start < x.end,
                  ) ?? d.day,
                start: next.start,
                end: next.end,
              }
            : d,
        )
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
    <>
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

          {days.map((d, dayIndex) => {
            // while dragging, laid out against the previewed times so the
            // block follows the pointer instead of snapping back on release
            const positioned = byDay[dayIndex]
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
                  // a second tap repositions the one draft rather than
                  // opening another; whatever it has been given comes with it
                  setDraft({
                    day: d,
                    start: new Date(at),
                    end: new Date(at + NEW_BLOCK_MINUTES * 60_000),
                  })
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
                  /*
                   * A draft takes the timeline over until it is put away. One
                   * block is in play at a time, so the rest stop offering
                   * anything and say so by dimming.
                   */
                  const busy = draft !== null
                  const canDrag =
                    Boolean(onReschedule) && !block.running && !readOnly && !busy
                  const canDelete =
                    Boolean(onDelete) && block.kind === 'trailed' && !readOnly && !busy
                  return (
                    <div
                      key={`${block.kind}-${block.id}`}
                      className={[
                        'block-wrap',
                        grab?.block?.id === block.id ? 'is-grabbed' : '',
                        busy ? 'is-muted' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{
                        top: `${top * 100}%`,
                        height: `${height * 100}%`,
                        left: `${lane * width}%`,
                        width: `${width}%`,
                      }}
                    >
                      <div
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
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        title={`${block.title} — ${range}`}
                        data-color={block.color ?? undefined}
                        onContextMenu={(e) => {
                          if (!onMenu || busy) return
                          e.preventDefault()
                          onMenu(block, e.clientX, e.clientY)
                        }}
                        onPointerDown={(e) => {
                          if (busy) return
                          hold.onPointerDown(e)
                          holdTarget.current = block
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
                      </div>

                      {/*
                        Outside the block, under its bottom-right corner.
                        Inside, the grip and the × collided on anything short,
                        and both competed with the resize strips for the same
                        few pixels. Out here their room does not depend on how
                        long the block happens to be.
                      */}
                      {(canDrag || canDelete) && (
                        <div className="block-controls">
                          {canDelete && (
                            <button
                              className="block-delete"
                              aria-label={`Delete ${block.title}`}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation()
                                onDelete?.(block)
                              }}
                            >
                              ×
                            </button>
                          )}
                          {canDrag && (
                            <span
                              className="block-grip"
                              role="button"
                              aria-label={`Move ${block.title}`}
                              onPointerDown={(e) => beginDrag(e, block, 'move', d)}
                            >
                              ⠿
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}

                {draft && draftLive && draftDay?.key === d.key && (() => {
                  const span = d.end.getTime() - d.start.getTime()
                  // mid-gesture the preview leads, exactly as a block's does
                  const live = draftLive
                  const top = (live.start.getTime() - d.start.getTime()) / span
                  const height = (live.end.getTime() - live.start.getTime()) / span
                  return (
                    <div
                      className="block-wrap is-drafting"
                      style={{
                        top: `${top * 100}%`,
                        height: `${height * 100}%`,
                        left: 0,
                        width: '100%',
                      }}
                    >
                      <div
                        className={
                          touched
                            ? 'block draft-block is-draggable is-named'
                            : 'block draft-block is-draggable'
                        }
                        data-color={draftColor ?? undefined}
                      >
                        <span className="block-title">
                          {draftTitle.trim() || 'New block'}
                        </span>
                        <span className="block-time">
                          {formatRange(live.start, live.end, tz)}
                        </span>
                        <span
                          className="grab-edge top"
                          onPointerDown={(e) => beginDrag(e, null, 'start', d, live)}
                        />
                        <span
                          className="grab-edge bottom"
                          onPointerDown={(e) => beginDrag(e, null, 'end', d, live)}
                        />
                      </div>
                      <div className="block-controls">
                        <span
                          className="block-grip"
                          role="button"
                          aria-label="Move the new block"
                          onPointerDown={(e) => beginDrag(e, null, 'move', d, live)}
                        >
                          ⠿
                        </span>
                      </div>
                    </div>
                  )
                })()}

                {d.isToday && marker !== null && (
                  <div className="now" style={{ top: `${marker * 100}%` }} />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>

    {/*
      Pinned under the grid rather than drawn inside the draft: a 30-minute
      block is about 30px tall, and in the week view a column is narrower
      than these two buttons. Down here it is the same size and in the same
      place whatever you have drawn, and on a phone it is under your thumb.
    */}
    {draft && (
      <div className="draft-bar">
        <span className="draft-range">
          {formatRange(draft.start, draft.end, tz)}
        </span>
        <button className="discard" onClick={clearDraft}>
          Discard
        </button>
        <button className="accent" onClick={() => setEditing(true)}>
          {touched ? 'Edit…' : 'Name it…'}
        </button>
      </div>
    )}

    {draft && editing && (
      <NewBlock
        range={formatRange(draft.start, draft.end, tz)}
        title={draftTitle}
        color={draftColor}
        onTitleChange={setDraftTitle}
        onColorChange={setDraftColor}
        onCancel={() => setEditing(false)}
        onSave={() => {
          onCreate?.(draft.start, draft.end, draftTitle.trim(), draftColor)
          clearDraft()
        }}
      />
    )}
    </>
  )
}
