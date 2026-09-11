import { admin, json, unauthorised, userFromRequest } from '../_lib/auth.ts'

/**
 * Forget the connection and everything it mirrored.
 *
 * Mirrored rows are hard-deleted rather than soft-deleted: they were never the
 * user's data, and leaving tombstones would make a later reconnect ambiguous.
 */
export async function POST(req: Request): Promise<Response> {
  const userId = await userFromRequest(req)
  if (!userId) return unauthorised()

  const db = admin()
  await db.from('tasks').delete().eq('user_id', userId).eq('source', 'google')
  await db.from('google_calendars').delete().eq('user_id', userId)
  await db.from('google_connections').delete().eq('user_id', userId)
  return json({ connected: false })
}
