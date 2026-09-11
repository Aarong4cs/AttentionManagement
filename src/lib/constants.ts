/** A running entry older than this is almost certainly one you forgot to stop. */
export const STALE_TIMER_HOURS = 12

/**
 * How far ahead recurrence occurrences are materialized. Bounds how far forward
 * the week view can scroll before hitting empty columns.
 */
export const MATERIALIZE_HORIZON_DAYS = 60

/** 1 = Monday. Used for week-view column boundaries. */
export const WEEK_STARTS_ON = 1 as const

/** Longest block the schema accepts, mirroring the estimated_minutes CHECK. */
export const MAX_ESTIMATE_MINUTES = 1440

/**
 * The closed colour palette, mirroring the CHECK on tasks.color. Names rather
 * than hex values so light and dark can render the same token differently.
 * `null` is the default, which is deliberately not one of these: scheduled and
 * trailed blocks must stay distinguishable from each other.
 */
export const TASK_COLORS = ['slate', 'blue', 'violet', 'teal', 'amber', 'rose'] as const
export type TaskColor = (typeof TASK_COLORS)[number]
