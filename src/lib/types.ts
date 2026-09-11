/**
 * Row types and derived view models.
 *
 * The shapes come from ./database.types.ts, which is GENERATED — regenerate it
 * with `npm run db:types` after every migration and never edit it by hand. This
 * file holds only the aliases and the view models the UI works in.
 */

import type { Database } from './database.types'

export type { Database }

type Tables = Database['public']['Tables']

export type Profile = Tables['profiles']['Row']
export type Recurrence = Tables['recurrences']['Row']
export type Task = Tables['tasks']['Row']
export type TimeEntry = Tables['time_entries']['Row']

export type ProfileUpdate = Tables['profiles']['Update']
export type RecurrenceInsert = Tables['recurrences']['Insert']
export type RecurrenceUpdate = Tables['recurrences']['Update']
export type TaskInsert = Tables['tasks']['Insert']
export type TaskUpdate = Tables['tasks']['Update']
export type TimeEntryInsert = Tables['time_entries']['Insert']
export type TimeEntryUpdate = Tables['time_entries']['Update']

/** Semantic aliases for the string-typed columns, to keep signatures readable. */
export type Uuid = string
/** ISO 8601 with offset, e.g. 2026-09-08T14:30:00.000Z */
export type Timestamptz = string
/** YYYY-MM-DD */
export type DateOnly = string
/** HH:MM:SS */
export type TimeOnly = string

// ---------------------------------------------------------------------------
// Derived view models
// ---------------------------------------------------------------------------

/** What the timeline draws. `scheduled` comes from tasks, `trailed` from entries. */
export type BlockKind = 'scheduled' | 'trailed'

export interface Block {
  kind: BlockKind
  id: Uuid
  taskId: Uuid
  title: string
  /** Absolute interval. May extend outside the day column being drawn. */
  start: Date
  /** null only for a running trailed block. */
  end: Date | null
  running: boolean
  completed: boolean
  /** Trailed blocks only: the end instant was reconstructed, not observed. */
  edited: boolean
}
