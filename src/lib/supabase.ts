import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local, then restart the dev server.',
  )
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    // Single user, two devices: keep the session across reloads and refresh it
    // in the background so a suspended iOS tab comes back authenticated.
    persistSession: true,
    autoRefreshToken: true,
  },
})

export const supabaseUrl = url
