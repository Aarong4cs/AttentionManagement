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

for (const table of ['tasks', 'time_entries', 'recurrences', 'profiles', 'subtasks', 'presets']) {
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

/*
 * google_connections holds a Google refresh token. RLS is enabled with NO
 * policies, so it must be unreadable even by the signed-in owner — scoping to
 * the user is not enough when the user is a browser. This is the one table
 * where "your own row" is still the wrong answer.
 */
if (env.TEST_USER_EMAIL && env.TEST_USER_PASSWORD) {
  const { error: signInError } = await sb.auth.signInWithPassword({
    email: env.TEST_USER_EMAIL,
    password: env.TEST_USER_PASSWORD,
  })
  check(!signInError, 'signed in for the authenticated checks')

  const { data: conns, error: connErr } = await sb.from('google_connections').select('*')
  check(
    (conns ?? []).length === 0,
    'a signed-in client reads NOTHING from google_connections',
    connErr ? connErr.code : `${(conns ?? []).length} rows`,
  )

  const { error: writeErr } = await sb
    .from('google_connections')
    .insert({ user_id: (await sb.auth.getUser()).data.user.id, refresh_token: 'x' })
  check(writeErr !== null, 'and cannot write one either', writeErr?.code ?? 'NO ERROR')

  // the picker's table, by contrast, is ordinary user data
  const { error: calErr } = await sb.from('google_calendars').select('*')
  check(calErr === null, 'but google_calendars is readable by its owner')

  /*
   * Steps are ordinary user data — but only under a task you own. A policy that
   * compared user_id alone would accept a step hung off a stranger's task,
   * because the row would carry the caller's own id.
   */
  const { data: parent, error: parentErr } = await sb
    .from('tasks')
    .insert({ title: 'rls subtask probe', rank: 'a0' })
    .select('id')
    .single()
  check(!parentErr, 'made a parent task for the step checks', parentErr?.code ?? '')
  if (parent) {
    const { error: ownErr } = await sb
      .from('subtasks')
      .insert({ task_id: parent.id, title: 'a step', rank: 'a0' })
    check(ownErr === null, 'can add a step to your own task', ownErr?.code ?? '')
    const { data: back } = await sb.from('subtasks').select('id').eq('task_id', parent.id)
    check((back ?? []).length === 1, 'and read it back', `${(back ?? []).length} rows`)
    await sb.from('subtasks').delete().eq('task_id', parent.id)
    await sb.from('tasks').delete().eq('id', parent.id)
  }
  const { error: strayErr } = await sb
    .from('subtasks')
    .insert({ task_id: crypto.randomUUID(), title: 'orphan', rank: 'a0' })
  check(strayErr !== null, 'cannot hang a step off a task that is not yours', strayErr?.code ?? 'NO ERROR')

  await sb.auth.signOut()
} else {
  check(false, 'TEST_USER_* needed for the authenticated checks')
}

console.log(fails === 0 ? '\nanon access is correctly locked down\n' : `\n${fails} FAILED\n`)
process.exit(fails === 0 ? 0 : 1)
