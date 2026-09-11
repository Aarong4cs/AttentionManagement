-- Google Calendar mirror, read-only.
--
-- Google owns these events; this app displays them. A mirrored row is an
-- artifact on the timeline rather than a task you manage, which is why nothing
-- here has any notion of writing back.

-- ---------------------------------------------------------------------------
-- the connection: the one secret in the system
-- ---------------------------------------------------------------------------
-- RLS is enabled with NO policies, so `authenticated` cannot read this table at
-- all — not even its own row. That is the point: a refresh token has no reason
-- to reach the browser, and the only code that needs it runs with the service
-- role. Scoping to the owner would not be enough here.

create table public.google_connections (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  google_email  text,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.google_connections enable row level security;
-- deliberately no policies

create trigger google_connections_moddatetime
  before update on public.google_connections
  for each row execute procedure extensions.moddatetime(updated_at);

-- ---------------------------------------------------------------------------
-- per-calendar selection and sync state
-- ---------------------------------------------------------------------------
-- Readable by its owner, because the picker needs it. Holds no secret.

create table public.google_calendars (
  user_id        uuid not null default auth.uid()
                   references auth.users(id) on delete cascade,
  calendar_id    text not null,
  summary        text not null,
  enabled        boolean not null default false,

  sync_token     text,
  -- The window the sync_token was issued under. Google requires identical query
  -- parameters on every incremental request, so a window that moved would
  -- invalidate the token silently. Storing it makes a re-baseline detectable
  -- rather than mysterious.
  window_start   date,
  window_end     date,
  last_synced_at timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, calendar_id)
);

alter table public.google_calendars enable row level security;

create policy "own calendars" on public.google_calendars
  for all to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.google_calendars to authenticated;

create trigger google_calendars_moddatetime
  before update on public.google_calendars
  for each row execute procedure extensions.moddatetime(updated_at);

-- ---------------------------------------------------------------------------
-- tasks gains its mirror columns
-- ---------------------------------------------------------------------------
-- Structurally the same shape as recurrence occurrences: an external key plus a
-- unique index, so re-syncing is idempotent rather than duplicating.

alter table public.tasks
  add column source            text
    check (source is null or source = 'google'),
  add column external_id       text,
  add column external_etag     text,
  add column external_calendar text;

-- Non-partial so it can serve as an ON CONFLICT target. The occurrence index
-- had to be rebuilt for exactly this reason; there is no sense repeating it.
-- Rows with no external id keep (user_id, NULL, NULL), and NULLs are distinct
-- in a unique index, so ordinary tasks are unconstrained.
create unique index tasks_one_row_per_external
  on public.tasks (user_id, source, external_id);

-- A mirrored event is always scheduled, so the timeline range query is the one
-- that matters and tasks_scheduled_range already covers it. This index is for
-- the sync itself, which works calendar by calendar.
create index tasks_external_calendar
  on public.tasks (user_id, external_calendar)
  where source is not null and deleted_at is null;
