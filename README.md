# Attention Management

A personal time-management PWA. Plan the day on a timeline, and record what
actually happened on it.

Two panes. **Timeline** shows the day (or the week, Google-Calendar style) with
scheduled blocks drawn at their time. **Sequence** is a manually ordered list of
tasks with no due date. Toggling a sequence task on starts a block drawing on
the timeline at the current time; toggling off freezes it. That block is a
permanent record of what you did, visually distinct from what you planned.

See `CLAUDE.md` for the design constraints this is built against.

## Stack

Vite + React + TypeScript, Supabase (Postgres + Auth), plain CSS, deployed to
Vercel. Installable, and works offline.

## Setup

```sh
npm install
cp .env.example .env.local     # then fill in the two values
npm run dev
```

Both values come from the Supabase dashboard under **Project Settings → API
Keys**. Use the publishable/anon key, never `service_role` — the anon key is
safe in the browser because every table is protected by row-level security.

To apply the schema to a fresh project:

```sh
npx supabase login
npx supabase link --project-ref <your-ref>
npm run db:push
npm run db:types                # regenerate after every migration
```

Then paste `supabase/tests/assertions.sql` into the dashboard SQL editor. It
runs ~48 checks inside a transaction that rolls back, and reports pass/fail as a
result table.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Typecheck and build |
| `npm run preview` | Serve the production build (needed to exercise the service worker) |
| `npm test` | Pure logic — offline, no network, no database |
| `npm run test:rls` | Confirms the anon key can read and write nothing |
| `npm run test:int` | Integration tests against the live project |
| `npm run test:all` | All three |
| `npm run db:push` | Apply migrations |
| `npm run db:types` | Regenerate `src/lib/database.types.ts` |

`test:int` and `test:rls` need `TEST_USER_EMAIL` and `TEST_USER_PASSWORD` in
`.env.local`. **Do not give them a `VITE_` prefix** — Vite inlines every
`VITE_*` variable into the client bundle, which would publish the password to
anyone who loads the page.

## Deploying

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the Vercel project
before the first build: they are read at build time, not at runtime, so a build
without them ships a broken bundle.

```sh
npx vercel login
npx vercel --prod
```

`vercel.json` keeps `sw.js`, `index.html` and the manifest uncacheable while
hashed assets under `/assets/` are immutable. That asymmetry matters: a
long-cached service worker can never update itself, and the app stays pinned to
an old version indefinitely.

## Notes

- Running timers are stored as a start timestamp, never a counter. iOS suspends
  background JS, and a counter silently loses time.
- Writes go to a durable local queue first and replay on reconnect, so the app
  works with no network and reconciles when it returns.
- `tasks.rank` is a fractional index under `COLLATE "C"`. The collation is not
  optional: the default ICU collation does not compare those keys bytewise and
  silently returns the wrong order.
