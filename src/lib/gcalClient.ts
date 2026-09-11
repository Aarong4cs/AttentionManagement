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
  calendars: CalendarRow[]
  error?: string
}

async function bearer(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await bearer()
  if (!token) throw new Error('not signed in')
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return (await res.json()) as T
}

/** A top-level navigation, so the token rides in the URL rather than a header. */
export async function connectUrl(): Promise<string> {
  const token = await bearer()
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
