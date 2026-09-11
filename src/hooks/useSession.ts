import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export interface SessionState {
  session: Session | null
  loading: boolean
}

/** How long to wait for auth before rendering with whatever we have. */
const AUTH_SETTLE_MS = 2500

/**
 * The session gate.
 *
 * getSession() reads from storage, but if the stored token has expired it tries
 * to refresh it over the network — which simply hangs when offline. Waiting on
 * it alone leaves a cold offline start stuck on "Loading…" forever, with every
 * queued write sitting on disk and unreachable.
 *
 * So: take whichever signal arrives first, and stop waiting after a timeout
 * regardless. onAuthStateChange emits the stored session during initialisation
 * and does not need the network to do it.
 */
export function useSession(): SessionState {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const settle = (s: Session | null) => {
      if (cancelled) return
      setSession(s)
      setLoading(false)
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => settle(s))

    supabase.auth
      .getSession()
      .then(({ data }) => settle(data.session))
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    // offline cold start: stop blocking even if auth never answers
    const timer = setTimeout(() => {
      if (!cancelled) setLoading(false)
    }, AUTH_SETTLE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
      sub.subscription.unsubscribe()
    }
  }, [])

  return { session, loading }
}
