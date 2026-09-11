import { userFromRequest, unauthorised } from '../_lib/auth.ts'
import { consentUrl } from '../_lib/google.ts'

/**
 * Start the consent flow.
 *
 * The Supabase access token arrives as a query parameter rather than a header,
 * because this is a top-level navigation — the browser sends no Authorization
 * header when following a link. It is round-tripped through Google's `state` so
 * the callback knows whose account it is completing.
 */
export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const faked = new Request(req.url, {
    headers: { authorization: `Bearer ${token}` },
  })
  const userId = await userFromRequest(faked)
  if (!userId) return unauthorised()

  return Response.redirect(consentUrl(req, token), 302)
}
