import { Suspense, lazy } from 'react'

const AppShell = lazy(() => import('./AppShell'))

const configured =
  Boolean(import.meta.env.VITE_SUPABASE_URL) &&
  Boolean(import.meta.env.VITE_SUPABASE_ANON_KEY)

export default function App() {
  if (!configured) {
    return (
      <main className="app">
        <h1>Attention Management</h1>
        <p className="error">
          Missing Supabase config. Set VITE_SUPABASE_URL and
          VITE_SUPABASE_ANON_KEY in .env.local, then restart the dev server.
        </p>
      </main>
    )
  }

  return (
    <Suspense fallback={<p className="muted center">Loading…</p>}>
      <AppShell />
    </Suspense>
  )
}
