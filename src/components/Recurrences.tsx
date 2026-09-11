import { useEffect, useState, type FormEvent } from 'react'
import {
  createRecurrence,
  deleteRecurrence,
  listRecurrences,
} from '../lib/recurrence'
import type { Recurrence, Task } from '../lib/types'

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

/**
 * A deliberately small set of rules. Anything RFC 5545 can express is storable —
 * the column holds a raw RRULE — but a freeform rule builder is a project of its
 * own and these four cover ordinary use.
 */
function presets(tz: string) {
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(new Date())
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short)
  const todayCode = WEEKDAY_CODES[index === -1 ? 0 : index]

  return [
    { id: 'daily', label: 'Every day', rrule: 'FREQ=DAILY' },
    { id: 'weekdays', label: 'Weekdays', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    { id: 'weekly', label: `Weekly on ${short}`, rrule: `FREQ=WEEKLY;BYDAY=${todayCode}` },
    { id: 'monthly', label: 'Monthly', rrule: 'FREQ=MONTHLY' },
  ]
}

function describe(rec: Recurrence): string {
  const r = rec.rrule
  const freq = r.includes('FREQ=DAILY')
    ? 'Every day'
    : r.includes('BYDAY=MO,TU,WE,TH,FR')
      ? 'Weekdays'
      : r.includes('FREQ=WEEKLY')
        ? 'Weekly'
        : r.includes('FREQ=MONTHLY')
          ? 'Monthly'
          : r
  if (!rec.time_of_day) return `${freq} · in the sequence`
  const [h, m] = rec.time_of_day.split(':').map(Number)
  const suffix = h < 12 ? 'am' : 'pm'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${freq} at ${hour}:${String(m).padStart(2, '0')}${suffix} · ${rec.estimated_minutes}m`
}

export default function Recurrences({
  tz,
  seed,
  onClose,
  onChanged,
}: {
  tz: string
  /** Opened from a task's menu: prefill the form with it. */
  seed?: Task | null
  onClose: () => void
  onChanged: () => void
}) {
  const [rules, setRules] = useState<Recurrence[]>([])
  const [title, setTitle] = useState(seed?.title ?? '')
  const [preset, setPreset] = useState('daily')
  const [scheduled, setScheduled] = useState(seed?.due_at != null)
  const [time, setTime] = useState('09:00')
  const [estimate, setEstimate] = useState(String(seed?.estimated_minutes ?? 30))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const options = presets(tz)

  const reload = () =>
    listRecurrences()
      .then(setRules)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))

  useEffect(() => {
    reload()
  }, [])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    setBusy(true)
    setError(null)
    try {
      await createRecurrence({
        title: t,
        rrule: options.find((o) => o.id === preset)!.rrule,
        timeOfDay: scheduled ? `${time}:00` : null,
        estimatedMinutes: scheduled ? Number(estimate) : null,
        timezone: tz,
      })
      setTitle('')
      await reload()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(rec: Recurrence) {
    try {
      await deleteRecurrence(rec)
      await reload()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label="Repeating tasks"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2>Repeating</h2>
          <button className="link" onClick={onClose}>
            close
          </button>
        </header>

        <form className="rule-form" onSubmit={onCreate}>
          <input
            value={title}
            placeholder="What repeats?"
            onChange={(e) => setTitle(e.target.value)}
          />

          <div className="row">
            <select value={preset} onChange={(e) => setPreset(e.target.value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>

            <label className="check">
              <input
                type="checkbox"
                checked={scheduled}
                onChange={(e) => setScheduled(e.target.checked)}
              />
              at a set time
            </label>
          </div>

          {scheduled ? (
            <div className="row">
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              <input
                type="number"
                min="1"
                max="1440"
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
                aria-label="Estimated minutes"
              />
              <span className="muted">min</span>
            </div>
          ) : (
            <p className="muted hint">
              Lands in the sequence each day instead of on the timeline, so you
              can trail time against it.
            </p>
          )}

          <button type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add repeating task'}
          </button>
        </form>

        {rules.length === 0 ? (
          <p className="muted">No repeating tasks yet.</p>
        ) : (
          <ul className="rules">
            {rules.map((rec) => (
              <li key={rec.id}>
                <div className="rule-text">
                  <span className="title">{rec.title}</span>
                  <span className="muted">{describe(rec)}</span>
                </div>
                <button className="link" onClick={() => onDelete(rec)}>
                  stop
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}
