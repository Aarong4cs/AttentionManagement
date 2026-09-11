/**
 * Talking to Google.
 *
 * The refresh token lives only here and in the database. It is exchanged for a
 * short-lived access token per request rather than stored, so nothing
 * long-lived is ever cached in a function instance.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const API = 'https://www.googleapis.com/calendar/v3'

/** Read-only, and nothing more: this integration never writes to Google. */
export const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

const clientId = () => process.env.GOOGLE_CLIENT_ID ?? ''
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET ?? ''

export function redirectUri(req: Request): string {
  const base =
    process.env.PUBLIC_BASE_URL ?? new URL(req.url).origin
  return `${base.replace(/\/$/, '')}/api/google/callback`
}

export function consentUrl(req: Request, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPE,
    // Both are required to be handed a refresh token at all: Google withholds
    // one unless offline access is requested, and reuses a previous grant
    // silently unless consent is forced.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${AUTH_URL}?${params}`
}

export async function exchangeCode(
  req: Request,
  code: string,
): Promise<{ refreshToken: string; accessToken: string }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    }),
  })
  const body = (await res.json()) as TokenResponse
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(body)}`)
  if (!body.refresh_token || !body.access_token) {
    // Almost always means the account already granted this client and Google
    // reused the grant. prompt=consent above is what prevents it.
    throw new Error('Google returned no refresh token; revoke access and retry')
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token }
}

export async function accessToken(refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
    }),
  })
  const body = (await res.json()) as TokenResponse
  if (!res.ok || !body.access_token) {
    throw new Error(`refresh failed: ${JSON.stringify(body)}`)
  }
  return body.access_token
}

/** Only what is read back; Google's token response carries more. */
interface TokenResponse {
  access_token?: string
  refresh_token?: string
  error?: string
  error_description?: string
}

interface CalendarListResponse {
  items?: {
    id?: string
    summary?: string
    summaryOverride?: string
    primary?: boolean
  }[]
}

export interface ListPage {
  items: unknown[]
  nextPageToken?: string
  nextSyncToken?: string
}

/** Raised for a 410, which means the sync token is dead and we must re-baseline. */
export class SyncTokenExpired extends Error {}

export async function listEvents(
  token: string,
  calendarId: string,
  params: Record<string, string>,
): Promise<ListPage> {
  const url = `${API}/calendars/${encodeURIComponent(calendarId)}/events?${new URLSearchParams(
    params,
  )}`
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (res.status === 410) throw new SyncTokenExpired('sync token expired')
  if (!res.ok) {
    throw new Error(`events.list ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as ListPage
}

export async function listCalendars(
  token: string,
): Promise<{ id: string; summary: string; primary?: boolean }[]> {
  const res = await fetch(`${API}/users/me/calendarList?minAccessRole=reader`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(`calendarList ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const body = (await res.json()) as CalendarListResponse
  return (body.items ?? [])
    .filter((c) => typeof c.id === 'string')
    .map((c) => ({
      id: c.id as string,
      summary: String(c.summaryOverride ?? c.summary ?? c.id),
      primary: c.primary === true,
    }))
}
