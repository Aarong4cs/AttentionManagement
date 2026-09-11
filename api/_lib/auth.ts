/**
 * Identifying the caller of a server route.
 *
 * These routes act with the service role, which bypasses row-level security
 * entirely. So the user id must come from a token the caller could not have
 * forged — never from the request body. A route that trusted a `user_id` field
 * would let anyone read or write anyone else's calendar.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

export function admin(): SupabaseClient {
  if (!url || !serviceKey) {
    throw new Error(
      'Server is missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
    )
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * The caller's user id, or null. Verified by asking Supabase to resolve the
 * bearer token; a token this app did not issue resolves to nothing.
 */
export async function userFromRequest(req: Request): Promise<string | null> {
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null

  const { data, error } = await admin().auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export const unauthorised = () => json({ error: 'not signed in' }, 401)
