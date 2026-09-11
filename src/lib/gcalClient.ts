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
 * Call a server route, refreshing the session once if it is rejected.
 *
 * getSession() returns whatever is in storage, which after an hour is an
 * expired access token — the server then refuses it and the sheet shows a bare
 * 401 while the app around it still looks signed in. Refreshing and retrying
 * once turns that into nothing the user ever sees.
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

  if (res.status === 401) {
    const { data, error } = await supabase.auth.refreshSession()
    const fresh = data.session?.access_token
    if (error || !fresh) throw new Error('session expired — sign in again')
    res = await send(fresh)
  }

  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return (await res.json()) as T
}

/** A top-level navigation, so the token rides in the URL rather than a header. */
export async function connectUrl(): Promise<string> {
  // A stale token here sends the user to Google and fails at the callback,
  // after they have already granted consent — refresh before leaving the page.
  const { data } = await supabase.auth.refreshSession()
  const token = data.session?.access_token ?? (await bearer())
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
