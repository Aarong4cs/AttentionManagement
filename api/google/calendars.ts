import { admin, json, unauthorised, userFromRequest } from '../_lib/auth.js'
import { accessToken, listCalendars } from '../_lib/google.js'

/** Refresh the calendar list from Google, preserving which are enabled. */
export async function GET(req: Request): Promise<Response> {
  const userId = await userFromRequest(req)
  if (!userId) return unauthorised()

  const db = admin()
  const { data: conn } = await db
    .from('google_connections')
    .select('refresh_token, push_enabled, app_calendar_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (!conn) return json({ connected: false, calendars: [] })

  try {
    const token = await accessToken(conn.refresh_token)
    /*
     * Never offer the calendar this app writes to. Ticking it would pull our
     * own pushed events straight back in as read-only mirrors, duplicating
     * every block and then mirroring the mirrors on the next push.
     */
    const calendars = (await listCalendars(token)).filter(
      (c) => c.id !== conn.app_calendar_id,
    )
    await db.from('google_calendars').upsert(
      calendars.map((c) => ({ user_id: userId, calendar_id: c.id, summary: c.summary })),
      { onConflict: 'user_id,calendar_id', ignoreDuplicates: false },
    )
    // and drop it if an earlier version already recorded it
    if (conn.app_calendar_id) {
      await db
        .from('google_calendars')
        .delete()
        .eq('user_id', userId)
        .eq('calendar_id', conn.app_calendar_id)
    }
  } catch (e) {
    // A dead refresh token is the expected failure here — say so plainly rather
    // than returning an empty list that looks like "no calendars".
    return json(
      { connected: false, expired: true, error: e instanceof Error ? e.message : String(e) },
      200,
    )
  }

  let list = db
    .from('google_calendars')
    .select('calendar_id, summary, enabled, last_synced_at')
    .eq('user_id', userId)
  if (conn.app_calendar_id) list = list.neq('calendar_id', conn.app_calendar_id)
  const { data } = await list.order('summary')
  return json({
    connected: true,
    pushEnabled: conn.push_enabled === true,
    hasPushCalendar: conn.app_calendar_id !== null,
    calendars: data ?? [],
  })
}
