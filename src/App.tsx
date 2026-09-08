import { useEffect, useState } from 'react'

type ClientStatus =
  | { state: 'checking' }
  | { state: 'ready'; url: string }
  | { state: 'error'; message: string }

/**
 * The Supabase module throws on import when the env vars are missing, so it is
 * imported dynamically here — a missing key shows up as a readable message
 * instead of a blank page.
 */
function useSupabaseStatus(): ClientStatus {
  const [status, setStatus] = useState<ClientStatus>({ state: 'checking' })

  useEffect(() => {
    let cancelled = false

    async function check() {
      try {
        const { supabase, supabaseUrl } = await import('./lib/supabase')
        // Local-only call: reads any persisted session, no network required.
        // It proves the client constructed and its auth module is wired up.
        const { error } = await supabase.auth.getSession()
        if (error) throw error
        if (!cancelled) setStatus({ state: 'ready', url: supabaseUrl })
      } catch (err) {
        if (!cancelled) {
          setStatus({
            state: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    check()
    return () => {
      cancelled = true
    }
  }, [])

  return status
}

export default function App() {
  const status = useSupabaseStatus()

  return (
    <main className="page">
      <h1>Attention Management</h1>
      <p className="status" data-state={status.state}>
        {status.state === 'checking' && 'Checking Supabase client…'}
        {status.state === 'ready' && `Supabase client ready — ${status.url}`}
        {status.state === 'error' && `Supabase client failed: ${status.message}`}
      </p>
    </main>
  )
}
