/**
 * Client side of the calendar integration.
 *
 * Everything here goes through the server routes, because the refresh token
 * lives only there. The one exception is the enabled flag, which is ordinary
 * user data on google_calendars and protected by row-level security like
 * anything else.
 */

import { supabase } from './supabase'

export interface CalendarRow {
  calendar_id: string
  summary: string
  enabled: boolean
  last_synced_at: string | null
}

export interface CalendarState {
  connected: boolean
  expired?: boolean
  pushEnabled?: boolean
  hasPushCalendar?: boolean
  calendars: CalendarRow[]
  error?: string
}

async function bearer(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

/**
 * One token refresh at a time, shared by every caller.
 *
 * A failed `refreshSession()` does NOT mean the session is gone. It reports
 * that *our particular attempt* failed, and auth-js deliberately keeps the
 * session alive in three cases that happen constantly here:
 *
 *   - another client rotated the token while ours was in flight and had ours
 *     discarded — a second tab, the installed PWA, the other device, or this
 *     tab's own 30s auto-refresh ticker;
 *   - the network blipped, which is retryable by definition;
 *   - the refresh was proactive (within 90s of expiry) and the access token is
 *     still perfectly valid.
 *
 * So when the refresh reports failure, ask storage what actually survived
 * rather than believing it. Whoever won the race left a good token behind.
 *
 * It is also bounded. A refresh that cannot reach the network retries with
 * backoff behind a lock, and an unbounded wait on it leaves the sheet on
 * "Loading…" forever — the stored token is worth trying long before that.
 */
let refreshing: Promise<string | null> | null = null

const REFRESH_TIMEOUT_MS = 6_000

function refreshOnce(): Promise<string | null> {
  refreshing ??= (async () => {
    try {
      const refreshed = await Promise.race([
        supabase.auth.refreshSession().then((r) => r.data.session?.access_token),
        new Promise<undefined>((r) => setTimeout(r, REFRESH_TIMEOUT_MS)),
      ])
      return refreshed ?? (await bearer())
    } catch {
      return await bearer()
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/**
 * Call a server route, refreshing the session if it is rejected.
 *
 * An access token that expires between `getSession()` and the server reading
 * it, or one rotated out from under us mid-race, produces a 401 while the user
 * is still entirely signed in. Both are transient, so both are worth retrying;
 * only a genuinely absent session earns the "sign in again" message. Getting
 * that distinction wrong is worse than it sounds: auth-js caches a refresh
 * failure for a minute, so one bogus verdict repeats on every attempt until
 * the cooldown lapses.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const send = async (token: string) =>
    fetch(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    })

  const token = await bearer()
  if (!token) throw new Error('not signed in')

  let res = await send(token)

  for (let attempt = 0; res.status === 401 && attempt < 2; attempt++) {
    // the second round gives a concurrent refresh time to land
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400))
    const fresh = await refreshOnce()
    if (!fresh) throw new Error('session expired — sign in again')
    res = await send(fresh)
  }

  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return (await res.json()) as T
}

/** A top-level navigation, so the token rides in the URL rather than a header. */
export async function connectUrl(): Promise<string> {
  // A stale token here sends the user to Google and fails at the callback,
  // after they have already granted consent — refresh before leaving the page.
  const token = await refreshOnce()
  if (!token) throw new Error('not signed in')
  return `/api/google/connect?token=${encodeURIComponent(token)}`
}

export const getCalendars = () => call<CalendarState>('/api/google/calendars')

export const disconnect = () =>
  call<{ connected: boolean }>('/api/google/disconnect', { method: 'POST' })

export interface SyncResult {
  connected: boolean
  expired?: boolean
  written?: number
  removed?: number
  failures?: string[]
  push?: {
    created: number
    updated: number
    deleted: number
    reconsent?: boolean
    error?: string
  }
}

export const syncNow = () =>
  call<SyncResult>('/api/google/sync', { method: 'POST' })

export async function setCalendarEnabled(
  calendarId: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('google_calendars')
    .update({ enabled })
    .eq('calendar_id', calendarId)
  if (error) throw error
}

/**
 * Turn pushing on or off. Not a table update like the calendar checkboxes,
 * because the flag lives on google_connections, which the client cannot read.
 */
export const setPushEnabled = (enabled: boolean) =>
  call<{ push_enabled: boolean }>('/api/google/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
