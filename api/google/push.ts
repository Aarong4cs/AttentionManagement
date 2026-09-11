import { admin, json, unauthorised, userFromRequest } from '../_lib/auth.js'

/**
 * Turn pushing on or off.
 *
 * google_connections is invisible to the client by design, so this cannot be a
 * plain table update the way the calendar checkboxes are.
 */
export async function POST(req: Request): Promise<Response> {
  const userId = await userFromRequest(req)
  if (!userId) return unauthorised()

  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean }
  const enabled = body.enabled === true

  const db = admin()
  const { error } = await db
    .from('google_connections')
    .update({ push_enabled: enabled })
    .eq('user_id', userId)
  if (error) return json({ error: error.message }, 500)
  return json({ push_enabled: enabled })
}
