import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'

/**
 * Manual sequence ordering.
 *
 * Keys are base-62 fractional indexes: a move is a single-row UPDATE that
 * depends only on the two neighbours the device could see, which is what makes
 * reordering survive offline edits. Integer positions would force renumbering
 * every following row — a multi-row write that two offline devices cannot merge.
 *
 * The matching column is `tasks.rank text COLLATE "C"`. The C collation is not
 * optional: under the default ICU collation Postgres does not compare these keys
 * bytewise and ORDER BY silently returns the wrong order.
 *
 * `rank` is deliberately not unique, so always sort by (rank, id) to break ties
 * deterministically after a concurrent offline move.
 */

export type Rank = string

/** A key ordering between two neighbours. Pass null for "start"/"end" of list. */
export function rankBetween(before: Rank | null, after: Rank | null): Rank {
  return generateKeyBetween(before ?? null, after ?? null)
}

/** `n` keys in order between two neighbours, for bulk insertion. */
export function ranksBetween(
  before: Rank | null,
  after: Rank | null,
  n: number,
): Rank[] {
  return generateNKeysBetween(before ?? null, after ?? null, n)
}

/** A key that sorts after everything in `ranks`. */
export function rankAppend(ranks: readonly Rank[]): Rank {
  const last = ranks.length > 0 ? ranks[ranks.length - 1] : null
  return generateKeyBetween(last, null)
}

/** Comparator matching the server's `ORDER BY rank, id`. */
export function byRank<T extends { rank: Rank; id: string }>(a: T, b: T): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
