import { admin, userFromRequest } from '../_lib/auth.ts'
import { accessToken, exchangeCode, listCalendars } from '../_lib/google.ts'

const home = () => (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '') || '/'

/**
 * Finish the consent flow.
 *
 * Stores the refresh token and pre-populates the calendar list so the settings
 * sheet has something to show immediately. Nothing is enabled by default —
 * mirroring every calendar someone happens to be subscribed to would be a
 * surprise, not a feature.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state') ?? ''
  const denied = url.searchParams.get('error')

  if (denied) return Response.redirect(`${home()}/?google=denied`, 302)
  if (!code) return Response.redirect(`${home()}/?google=error`, 302)

  const faked = new Request(req.url, {
    headers: { authorization: `Bearer ${state}` },
  })
  const userId = await userFromRequest(faked)
  if (!userId) return Response.redirect(`${home()}/?google=unauthorised`, 302)

  try {
    const { refreshToken, accessToken: fresh } = await exchangeCode(req, code)
    const db = admin()

    await db.from('google_connections').upsert(
      { user_id: userId, refresh_token: refreshToken, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )

    const calendars = await listCalendars(fresh)
    if (calendars.length > 0) {
      // `enabled` is deliberately omitted on conflict: re-connecting must not
      // silently re-enable calendars that were turned off.
      await db.from('google_calendars').upsert(
        calendars.map((c) => ({
          user_id: userId,
          calendar_id: c.id,
          summary: c.summary,
          enabled: c.primary === true,
        })),
        { onConflict: 'user_id,calendar_id', ignoreDuplicates: true },
      )
    }
    // keep the access token out of the redirect; the client re-syncs on load
    void accessToken
    return Response.redirect(`${home()}/?google=connected`, 302)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.redirect(
      `${home()}/?google=error&detail=${encodeURIComponent(message.slice(0, 200))}`,
      302,
    )
  }
}
