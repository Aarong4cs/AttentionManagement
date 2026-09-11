import { useCallback, useEffect, useState } from 'react'
import {
  connectUrl,
  disconnect,
  getCalendars,
  setCalendarEnabled,
  setPushEnabled,
  syncNow,
  type CalendarState,
} from '../lib/gcalClient'

export default function GoogleCalendar({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged: () => void
}) {
  const [state, setState] = useState<CalendarState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await getCalendars())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    // fetching the calendar list is exactly the external-system sync the rule
    // is there to allow
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
  }, [load])

  async function toggle(calendarId: string, enabled: boolean) {
    setBusy(true)
    try {
      await setCalendarEnabled(calendarId, enabled)
      await load()
      // turning one on should show its events without waiting for the next
      // ordinary refresh
      await syncNow()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label="Google Calendar"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2>Google Calendar</h2>
          <button className="link" onClick={onClose}>
            close
          </button>
        </header>

        {state === null ? (
          <p className="muted">Loading…</p>
        ) : !state.connected ? (
          <>
            <p className="muted hint">
              {state.expired
                ? 'The connection expired. Reconnect to keep showing your calendar.'
                : 'Show your calendar events on the timeline. Read-only — nothing here changes anything in Google.'}
            </p>
            <button
              onClick={async () => {
                try {
                  window.location.href = await connectUrl()
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                }
              }}
            >
              {state.expired ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
            </button>
          </>
        ) : (
          <>
            <p className="muted hint">
              Events from the calendars you tick appear on the timeline. They
              cannot be moved, renamed or deleted here — Google owns them.
            </p>

            {state.calendars.length === 0 ? (
              <p className="muted">No calendars found.</p>
            ) : (
              <ul className="rules">
                {state.calendars.map((c) => (
                  <li key={c.calendar_id}>
                    <label className="check grow">
                      <input
                        type="checkbox"
                        checked={c.enabled}
                        disabled={busy}
                        onChange={(e) => toggle(c.calendar_id, e.target.checked)}
                      />
                      <span className="rule-text">
                        <span className="title">{c.summary}</span>
                        {c.last_synced_at && (
                          <span className="muted">
                            synced {new Date(c.last_synced_at).toLocaleString()}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            <div className="push">
              <label className="check grow">
                <input
                  type="checkbox"
                  checked={state.pushEnabled === true}
                  disabled={busy}
                  onChange={async (e) => {
                    setBusy(true)
                    try {
                      await setPushEnabled(e.target.checked)
                      await load()
                      if (e.target.checked) await syncNow()
                      onChanged()
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err))
                    } finally {
                      setBusy(false)
                    }
                  }}
                />
                <span className="rule-text">
                  <span className="title">Send my tracked time to Google</span>
                  <span className="muted">
                    Creates a separate “Attention Management” calendar. Nothing
                    is written to your own calendars.
                  </span>
                </span>
              </label>
            </div>

            <div className="row">
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    const r = await syncNow()
                    const trouble = [
                      ...(r.failures ?? []),
                      r.push?.reconsent
                        ? 'Reconnect to allow writing to Google.'
                        : (r.push?.error ?? ''),
                    ].filter(Boolean)
                    if (trouble.length) setError(trouble.join('; '))
                    await load()
                    onChanged()
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Sync now
              </button>
              {/*
                Re-granting scopes must not mean disconnecting: that would drop
                every mirrored row and pull the whole calendar again. Connecting
                over an existing link just replaces the refresh token.
              */}
              <button
                className="chip"
                disabled={busy}
                onClick={async () => {
                  try {
                    window.location.href = await connectUrl()
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e))
                  }
                }}
              >
                Reconnect
              </button>
              <button
                className="chip danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await disconnect()
                    await load()
                    onChanged()
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Disconnect
              </button>
            </div>
          </>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}
