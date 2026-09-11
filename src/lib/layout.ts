/**
 * Turning blocks into positions on a day column.
 *
 * Everything here is pure: no dates from the ambient clock, no DOM. `now` is
 * passed in so a running block's growth is a function of render time rather
 * than hidden state, and so this is testable without a database.
 */

import type { Block } from './types'

export interface PositionedBlock {
  block: Block
  /** Fraction of the column, 0..1, measured from the top. */
  top: number
  height: number
  /** Which lane within its overlap cluster, and how many lanes that cluster has. */
  lane: number
  lanes: number
}

/** The visible interval of a block inside one day column, or null if it misses. */
function clip(
  block: Block,
  dayStart: Date,
  dayEnd: Date,
  now: Date,
): { start: number; end: number } | null {
  const rawEnd = block.end ?? now
  const start = Math.max(block.start.getTime(), dayStart.getTime())
  const end = Math.min(rawEnd.getTime(), dayEnd.getTime())
  return end > start ? { start, end } : null
}

/**
 * Position blocks within [dayStart, dayEnd), packing overlapping ones into
 * side-by-side lanes the way a calendar does.
 *
 * Blocks are clustered by actual overlap, so a cluster's lane count only
 * affects the blocks that genuinely collide — two separate pairs of
 * overlapping blocks do not force everything on the day into four lanes.
 */
export function layoutDay(
  blocks: readonly Block[],
  dayStart: Date,
  dayEnd: Date,
  now: Date,
): PositionedBlock[] {
  const span = dayEnd.getTime() - dayStart.getTime()
  if (span <= 0) return []

  const clipped = blocks
    .map((block) => ({ block, iv: clip(block, dayStart, dayEnd, now) }))
    .filter((x): x is { block: Block; iv: { start: number; end: number } } => x.iv !== null)
    // scheduled before trailed on equal starts keeps the plan behind the record
    .sort(
      (a, b) =>
        a.iv.start - b.iv.start ||
        Number(a.block.kind === 'trailed') - Number(b.block.kind === 'trailed') ||
        (a.block.id < b.block.id ? -1 : 1),
    )

  const out: PositionedBlock[] = []
  let cluster: typeof clipped = []
  let clusterEnd = -Infinity

  const flush = () => {
    if (cluster.length === 0) return
    // greedy lane assignment: first lane whose last block has already ended
    const laneEnds: number[] = []
    const assigned = cluster.map((item) => {
      let lane = laneEnds.findIndex((end) => end <= item.iv.start)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(item.iv.end)
      } else {
        laneEnds[lane] = item.iv.end
      }
      return { item, lane }
    })
    for (const { item, lane } of assigned) {
      out.push({
        block: item.block,
        top: (item.iv.start - dayStart.getTime()) / span,
        height: (item.iv.end - item.iv.start) / span,
        lane,
        lanes: laneEnds.length,
      })
    }
    cluster = []
    clusterEnd = -Infinity
  }

  for (const item of clipped) {
    if (cluster.length > 0 && item.iv.start >= clusterEnd) flush()
    cluster.push(item)
    clusterEnd = Math.max(clusterEnd, item.iv.end)
  }
  flush()

  return out
}

/** Fraction of the column where `now` sits, or null if it is not on this day. */
export function nowOffset(dayStart: Date, dayEnd: Date, now: Date): number | null {
  const span = dayEnd.getTime() - dayStart.getTime()
  const at = now.getTime() - dayStart.getTime()
  if (span <= 0 || at < 0 || at > span) return null
  return at / span
}

/**
 * Where a dragged row should land, given the vertical midpoints of the rows it
 * is being dragged past.
 *
 * `midpoints` MUST exclude the row being dragged: the answer is an index into
 * that reduced list, which is exactly what is needed to name the two
 * neighbours a new fractional rank goes between. Including the dragged row
 * would make an item dropped on itself appear to move.
 */
export function insertionIndex(midpoints: readonly number[], y: number): number {
  let i = 0
  while (i < midpoints.length && y > midpoints[i]) i++
  return i
}
