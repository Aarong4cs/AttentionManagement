/**
 * Sending tracked time out to the calendar this app created.
 *
 * The inbound direction mirrors Google's events; this one writes ours. They
 * never touch the same event, which is why neither needs to know about the
 * other and why there is no conflict resolution anywhere in this file.
 */

import {
  NeedsReconsent,
  calendarExists,
  createAppCalendar,
  deleteEvent,
  insertEvent,
  updateEvent,
} from './google.ts'
import { PUSH_CALENDAR_NAME, pushAction, type PushableEntry } from '../../src/lib/gcal.ts'
import type { admin } from './auth.ts'

type Db = ReturnType<typeof admin>

/** Rows the push needs, with the owning task's title and timestamp joined in. */
interface Joined {
  id: string
  started_at: string
  ended_at: string | null
  deleted_at: string | null
  updated_at: string
  google_event_id: string | null
  google_synced_at: string | null
  tasks: { title: string; updated_at: string } | null
}

export interface PushResult {
  created: number
  updated: number
  deleted: number
  reconsent?: boolean
  error?: string
}

/**
 * The calendar we own, creating it on first use.
 *
 * Creating it at connect time would leave an empty calendar sitting in Google
 * for anyone who never tracks anything. It is also re-created if the user
 * deleted it there, which is easier to recover from than to detect later.
 */
async function ensureCalendar(
  db: Db,
  userId: string,
  token: string,
  stored: string | null,
  timeZone: string,
): Promise<string> {
  if (stored && (await calendarExists(token, stored))) return stored

  const id = await createAppCalendar(token, PUSH_CALENDAR_NAME, timeZone)
  await db
    .from('google_connections')
    .update({ app_calendar_id: id })
    .eq('user_id', userId)

  if (stored && stored !== id) {
    // The old calendar is gone, so every event id that pointed into it is
    // meaningless. Clearing them makes the next pass re-create the lot rather
    // than fail on each one.
    await db
      .from('time_entries')
      .update({ google_event_id: null, google_synced_at: null })
      .eq('user_id', userId)
      .not('google_event_id', 'is', null)
  }
  return id
}

export async function pushEntries(
  db: Db,
  userId: string,
  token: string,
  connection: { app_calendar_id: string | null; push_enabled: boolean },
  timeZone: string,
): Promise<PushResult> {
  const result: PushResult = { created: 0, updated: 0, deleted: 0 }
  if (!connection.push_enabled) return result

  // Everything finished or deleted that might need work. The comparison of
  // timestamps happens in pushAction, which is pure and tested.
  const { data, error } = await db
    .from('time_entries')
    .select(
      'id, started_at, ended_at, deleted_at, updated_at, google_event_id, google_synced_at, tasks(title, updated_at)',
    )
    .eq('user_id', userId)
    .or('google_event_id.not.is.null,deleted_at.is.null')
    .order('started_at', { ascending: false })
    .limit(500)
  if (error) return { ...result, error: error.message }

  const rows = (data ?? []) as unknown as Joined[]

  let calendarId: string
  try {
    calendarId = await ensureCalendar(
      db,
      userId,
      token,
      connection.app_calendar_id,
      timeZone,
    )
  } catch (e) {
    if (e instanceof NeedsReconsent) return { ...result, reconsent: true, error: e.message }
    return { ...result, error: e instanceof Error ? e.message : String(e) }
  }

  for (const row of rows) {
    const entry: PushableEntry = {
      id: row.id,
      started_at: row.started_at,
      ended_at: row.ended_at,
      deleted_at: row.deleted_at,
      updated_at: row.updated_at,
      google_event_id: row.google_event_id,
      google_synced_at: row.google_synced_at,
      title: row.tasks?.title ?? 'Tracked time',
      taskUpdatedAt: row.tasks?.updated_at ?? row.updated_at,
    }

    const action = pushAction(entry)
    if (action.kind === 'skip') continue

    try {
      if (action.kind === 'create') {
        const eventId = await insertEvent(token, calendarId, {
          summary: action.summary,
          start: action.start,
          end: action.end,
        })
        await stamp(db, action.entryId, eventId)
        result.created++
      } else if (action.kind === 'update') {
        await updateEvent(token, calendarId, action.eventId, {
          summary: action.summary,
          start: action.start,
          end: action.end,
        })
        await stamp(db, action.entryId, action.eventId)
        result.updated++
      } else {
        await deleteEvent(token, calendarId, action.eventId)
        await db
          .from('time_entries')
          .update({ google_event_id: null, google_synced_at: null })
          .eq('id', action.entryId)
        result.deleted++
      }
    } catch (e) {
      if (e instanceof NeedsReconsent) {
        return { ...result, reconsent: true, error: e.message }
      }
      // One bad row must not strand the rest; it will be retried next pass.
      result.error = e instanceof Error ? e.message : String(e)
    }
  }

  return result
}

/**
 * Record that the pushed copy matches this row.
 *
 * This relies on the moddatetime trigger being scoped to the columns that carry
 * the user's data, so writing these two does NOT bump updated_at. Without that,
 * stamping a row would make it look changed again the instant it was recorded,
 * and every finished entry would be re-pushed on every pass for ever.
 */
async function stamp(db: Db, entryId: string, eventId: string): Promise<void> {
  await db
    .from('time_entries')
    .update({ google_event_id: eventId, google_synced_at: new Date().toISOString() })
    .eq('id', entryId)
}
