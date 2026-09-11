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

/**
 * Read-only on the user's own calendars, and write access ONLY to calendars
 * this app created. `calendar.app.created` cannot touch an existing calendar at
 * all, so a bug here can never damage real appointments — which a blanket
 * `calendar` scope would happily allow.
 */
export const SCOPE = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.app.created',
].join(' ')

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

// ---------------------------------------------------------------------------
// writing, but only to a calendar this app made
// ---------------------------------------------------------------------------

/** Raised when the stored grant predates the write scope. */
export class NeedsReconsent extends Error {}

async function write(
  token: string,
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  // 404 on a delete means the user already removed it in Google; that is the
  // outcome we wanted, not a failure.
  if (method === 'DELETE' && (res.ok || res.status === 404 || res.status === 410)) {
    return {}
  }
  if (res.status === 401 || res.status === 403) {
    throw new NeedsReconsent(
      'Google refused the write. Reconnect to grant calendar access.',
    )
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as Record<string, unknown>
}

export async function createAppCalendar(
  token: string,
  summary: string,
  timeZone: string,
): Promise<string> {
  const made = await write(token, '/calendars', 'POST', {
    summary,
    description: 'Time tracked in Attention Management. Written by the app.',
    timeZone,
  })
  const id = made.id
  if (typeof id !== 'string') throw new Error('calendar insert returned no id')
  return id
}

/** Does this calendar still exist? A user can delete it in Google at any time. */
export async function calendarExists(token: string, calendarId: string): Promise<boolean> {
  const res = await fetch(`${API}/calendars/${encodeURIComponent(calendarId)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return res.ok
}

export async function insertEvent(
  token: string,
  calendarId: string,
  event: { summary: string; start: string; end: string },
): Promise<string> {
  const made = await write(
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    'POST',
    {
      summary: event.summary,
      start: { dateTime: event.start },
      end: { dateTime: event.end },
    },
  )
  const id = made.id
  if (typeof id !== 'string') throw new Error('event insert returned no id')
  return id
}

export async function updateEvent(
  token: string,
  calendarId: string,
  eventId: string,
  event: { summary: string; start: string; end: string },
): Promise<void> {
  await write(
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    'PUT',
    {
      summary: event.summary,
      start: { dateTime: event.start },
      end: { dateTime: event.end },
    },
  )
}

export async function deleteEvent(
  token: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  await write(
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    'DELETE',
  )
}
