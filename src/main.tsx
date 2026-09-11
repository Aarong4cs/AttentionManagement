import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './App.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'

// autoUpdate: a personal single-user app has no reason to prompt about a new
// version. Supabase data is never precached — only the shell is — so the
// server stays the only source of truth for anything that matters.
registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
