import { admin, json, unauthorised, userFromRequest } from '../_lib/auth.ts'
import { accessToken, listCalendars } from '../_lib/google.ts'

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
    const calendars = await listCalendars(token)
    await db.from('google_calendars').upsert(
      calendars.map((c) => ({ user_id: userId, calendar_id: c.id, summary: c.summary })),
      { onConflict: 'user_id,calendar_id', ignoreDuplicates: false },
    )
  } catch (e) {
    // A dead refresh token is the expected failure here — say so plainly rather
    // than returning an empty list that looks like "no calendars".
    return json(
      { connected: false, expired: true, error: e instanceof Error ? e.message : String(e) },
      200,
    )
  }

  const { data } = await db
    .from('google_calendars')
    .select('calendar_id, summary, enabled, last_synced_at')
    .eq('user_id', userId)
    .order('summary')
  return json({
    connected: true,
    pushEnabled: conn.push_enabled === true,
    hasPushCalendar: conn.app_calendar_id !== null,
    calendars: data ?? [],
  })
}
