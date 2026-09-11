import { supabase } from '../lib/supabase'
import { clearLocal } from '../lib/offline'
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
}: {
  email: string
  onClose: () => void
  onOpenCalendar: () => void
}) {
  const { theme, setTheme } = useTheme()

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
          <button
            className="chip"
            onClick={() => {
              onClose()
              onOpenCalendar()
            }}
          >
            Manage calendars…
          </button>
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
