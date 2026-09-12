import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { clearLocal } from '../lib/offline'
import { syncNow } from '../lib/gcalClient'
import { useTheme, type Theme } from '../hooks/useTheme'

const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

export default function Settings({
  email,
  onClose,
  onOpenCalendar,
  onChanged,
}: {
  email: string
  onClose: () => void
  onOpenCalendar: () => void
  onChanged: () => void
}) {
  const { theme, setTheme } = useTheme()
  const [syncing, setSyncing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2>Settings</h2>
          <button className="link" onClick={onClose}>
            close
          </button>
        </header>

        <section className="setting">
          <h3>Signed in as</h3>
          <p className="setting-value">{email}</p>
        </section>

        <section className="setting">
          <h3>Theme</h3>
          <div className="segmented" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={theme === t.id ? 'on' : ''}
                aria-pressed={theme === t.id}
                onClick={() => setTheme(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="muted hint">
            System follows your device. The choice is remembered on this device
            only.
          </p>
        </section>

        <section className="setting">
          <h3>Google Calendar</h3>
          <div className="row">
            <button
              className="chip"
              onClick={() => {
                onClose()
                onOpenCalendar()
              }}
            >
              Manage calendars…
            </button>
            <button
              className="chip"
              disabled={syncing}
              onClick={async () => {
                setSyncing(true)
                setNote(null)
                setFailed(false)
                try {
                  const r = await syncNow()
                  if (!r.connected) {
                    setNote('Not connected. Open Manage calendars to connect.')
                    setFailed(true)
                  } else {
                    /*
                     * A per-calendar failure and a push that needs re-consent
                     * are the two things worth saying out loud; everything else
                     * is just a count nobody acts on.
                     */
                    const trouble = [
                      ...(r.failures ?? []),
                      r.push?.reconsent
                        ? 'Reconnect to allow writing to Google.'
                        : (r.push?.error ?? ''),
                    ].filter(Boolean)
                    setFailed(trouble.length > 0)
                    setNote(trouble.length ? trouble.join('; ') : 'Synced.')
                  }
                  onChanged()
                } catch (e) {
                  setFailed(true)
                  setNote(e instanceof Error ? e.message : String(e))
                } finally {
                  setSyncing(false)
                }
              }}
            >
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
          {note && <p className={failed ? 'error' : 'muted hint'}>{note}</p>}
        </section>

        <section className="setting">
          <button
            className="chip danger"
            onClick={() => {
              // the cache and queue belong to whoever was signed in
              clearLocal()
              void supabase.auth.signOut()
            }}
          >
            Sign out
          </button>
        </section>
      </div>
    </div>
  )
}
