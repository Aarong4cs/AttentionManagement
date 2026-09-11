// Verifies the browser-facing anon key is safely scoped: with no session, RLS
// must expose nothing and accept nothing. Hits the live project, so this is
// separate from `npm test` (which is offline and pure).
//
//   npm run test:rls
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = Object.fromEntries(
  readFileSync(join(root, '.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
  console.error('.env.local is missing Supabase config')
  process.exit(1)
}

const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

let fails = 0
const check = (ok, msg, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

for (const table of ['tasks', 'time_entries', 'recurrences', 'profiles']) {
  const { data, error } = await sb.from(table).select('*')
  check(
    (data ?? []).length === 0,
    `anon SELECT on ${table} returns nothing`,
    error ? error.code : `${(data ?? []).length} rows`,
  )
}

const { error: insErr } = await sb
  .from('tasks')
  .insert({ id: crypto.randomUUID(), title: 'anon should not manage this', rank: 'a0' })
check(insErr !== null, 'anon INSERT on tasks is rejected', insErr?.code ?? 'NO ERROR')

const { data: sess } = await sb.auth.getSession()
check(sess.session === null, 'no session without signing in')

console.log(fails === 0 ? '\nanon access is correctly locked down\n' : `\n${fails} FAILED\n`)
process.exit(fails === 0 ? 0 : 1)
