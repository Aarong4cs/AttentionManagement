import { admin, json, unauthorised, userFromRequest } from '../_lib/auth.js'
import {
  SyncTokenExpired,
  accessToken,
  listEvents,
} from '../_lib/google.js'
import { mapEvent, syncWindow, windowChanged, type GoogleEvent } from '../../src/lib/gcal.js'
import { pushEntries } from '../_lib/push.js'

interface CalendarRow {
  calendar_id: string
  summary: string
  sync_token: string | null
  window_start: string | null
  window_end: string | null
}

/**
 * Pull changes for every enabled calendar.
 *
 * Called by the client on load, on focus, and from a button — there is no cron.
 * Vercel's Hobby plan caps cron at once a day, and for a single-user app
 * calendar freshness only matters while someone is looking at it anyway.
 */
export async function POST(req: Request): Promise<Response> {
  const userId = await userFromRequest(req)
  if (!userId) return unauthorised()

  const db = admin()
  const { data: conn } = await db
    .from('google_connections')
    .select('refresh_token, app_calendar_id, push_enabled')
    .eq('user_id', userId)
    .maybeSingle()
  if (!conn) return json({ connected: false, synced: 0 })

  const { data: profile } = await db
    .from('profiles')
    .select('timezone')
    .eq('id', userId)
    .maybeSingle()
  const timeZone = profile?.timezone ?? 'UTC'

  const { data: calendars } = await db
    .from('google_calendars')
    .select('calendar_id, summary, sync_token, window_start, window_end')
    .eq('user_id', userId)
    .eq('enabled', true)
  let token: string
  try {
    token = await accessToken(conn.refresh_token)
  } catch (e) {
    return json(
      { connected: true, expired: true, error: e instanceof Error ? e.message : String(e) },
      200,
    )
  }

  // Pushing runs even with no calendars ticked: the two directions are
  // independent, and someone may want to send their tracked time out without
  // pulling anything in.
  const push = await pushEntries(db, userId, token, conn, timeZone)

  if (!calendars || calendars.length === 0) {
    return json({ connected: true, written: 0, removed: 0, calendars: 0, push })
  }

  const window = syncWindow(new Date())
  let written = 0
  let removed = 0
  const failures: string[] = []

  for (const cal of calendars as CalendarRow[]) {
    try {
      const result = await syncCalendar(db, userId, token, cal, window)
      written += result.written
      removed += result.removed
    } catch (e) {
      // One unreachable calendar must not stop the others.
      failures.push(`${cal.summary}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return json({ connected: true, written, removed, failures, push })
}

async function syncCalendar(
  db: ReturnType<typeof admin>,
  userId: string,
  token: string,
  cal: CalendarRow,
  window: ReturnType<typeof syncWindow>,
): Promise<{ written: number; removed: number }> {
  // The sync token is only valid for the exact query it was issued under, so a
  // moved window has to re-baseline rather than quietly return wrong results.
  const stale = windowChanged(
    { windowStart: cal.window_start, windowEnd: cal.window_end },
    window,
  )
  let syncToken = stale ? null : cal.sync_token

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await pull(db, userId, token, cal, window, syncToken)
    } catch (e) {
      if (!(e instanceof SyncTokenExpired) || attempt === 1) throw e
      // 410: the token is dead. Drop what it produced and start clean, or the
      // mirror would keep rows Google has since deleted.
      await db
        .from('tasks')
        .delete()
        .eq('user_id', userId)
        .eq('source', 'google')
        .eq('external_calendar', cal.calendar_id)
      syncToken = null
    }
  }
  return { written: 0, removed: 0 }
}

async function pull(
  db: ReturnType<typeof admin>,
  userId: string,
  token: string,
  cal: CalendarRow,
  window: ReturnType<typeof syncWindow>,
  syncToken: string | null,
): Promise<{ written: number; removed: number }> {
  let pageToken: string | undefined
  let nextSyncToken: string | undefined
  let written = 0
  let removed = 0

  do {
    // Incremental requests must carry the same parameters as the initial one,
    // so the two shapes are built from one place.
    const params: Record<string, string> = syncToken
      ? { syncToken, singleEvents: 'true', maxResults: '250' }
      : {
          timeMin: window.timeMin,
          timeMax: window.timeMax,
          singleEvents: 'true',
          maxResults: '250',
        }
    if (pageToken) params.pageToken = pageToken

    const page = await listEvents(token, cal.calendar_id, params)
    const upserts: Record<string, unknown>[] = []
    const deletes: string[] = []

    for (const raw of page.items ?? []) {
      const mapped = mapEvent(raw as GoogleEvent)
      if (mapped.kind === 'delete') deletes.push(mapped.externalId)
      else if (mapped.kind === 'task') {
        upserts.push({
          user_id: userId,
          source: 'google',
          external_id: mapped.task.external_id,
          external_calendar: cal.calendar_id,
          external_etag: mapped.task.external_etag,
          title: mapped.task.title,
          due_at: mapped.task.due_at,
          estimated_minutes: mapped.task.estimated_minutes,
          // rank is NOT NULL and only orders the sequence, which a scheduled
          // task never appears in; it still breaks ties between blocks sharing
          // a start time.
          rank: 'g0',
          deleted_at: null,
        })
      }
      // 'skip' is silent on purpose: all-day events are not an error.
    }

    if (upserts.length > 0) {
      // Only Google's own fields are listed above, so colour and priority set
      // locally survive every sync.
      const { error } = await db
        .from('tasks')
        .upsert(upserts, { onConflict: 'user_id,source,external_id' })
      if (error) throw new Error(`upsert failed: ${error.message}`)
      written += upserts.length
    }

    if (deletes.length > 0) {
      const { error } = await db
        .from('tasks')
        .delete()
        .eq('user_id', userId)
        .eq('source', 'google')
        .in('external_id', deletes)
      if (error) throw new Error(`delete failed: ${error.message}`)
      removed += deletes.length
    }

    pageToken = page.nextPageToken
    // Present only on the last page; keeping it means the next run is incremental.
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken
  } while (pageToken)

  await db
    .from('google_calendars')
    .update({
      sync_token: nextSyncToken ?? null,
      window_start: window.windowStart,
      window_end: window.windowEnd,
      last_synced_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('calendar_id', cal.calendar_id)

  return { written, removed }
}
