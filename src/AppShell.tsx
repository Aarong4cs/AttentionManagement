import { useSession } from './hooks/useSession'
import SignIn from './components/SignIn'
import Today from './components/Today'

/**
 * Everything below this module touches the Supabase client, which throws at
 * import time when the env vars are missing. App.tsx loads this lazily so a
 * misconfigured .env.local shows a message instead of a blank page.
 */
export default function AppShell() {
  const { session, loading } = useSession()

  if (loading) return <p className="muted center">Loading…</p>
  if (!session) return <SignIn />
  return <Today email={session.user.email ?? 'signed in'} />
}
