-- Attention Management — initial schema
--
-- Design notes live in the plan; the load-bearing ones are repeated inline where
-- the SQL would otherwise look arbitrary.
--
-- Order: extensions -> helpers -> tables -> indexes -> triggers -> RLS -> realtime.

create extension if not exists moddatetime with schema extensions;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

-- Start of a local calendar day as an absolute instant.
-- timezone(text, timestamp) is IMMUTABLE, so this is safe in indexes/generated
-- expressions if we ever need it there.
create or replace function public.day_start(p_day date, p_tz text)
returns timestamptz
language sql
immutable
as $$
  select timezone(p_tz, p_day::timestamp)
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- Exists so day boundaries are computable server-side. One row per user.

create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  timezone   text        not null default 'America/New_York',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A bad timezone string silently breaks every day boundary downstream, so it is
-- rejected at write time rather than discovered later as mis-drawn blocks.
create or replace function public.validate_timezone()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'unknown timezone: %', new.timezone
      using errcode = 'invalid_parameter_value';
  end if;
  return new;
end $$;

create trigger profiles_validate_timezone
  before insert or update of timezone on public.profiles
  for each row execute function public.validate_timezone();

-- Every auth user needs a profile, or they have no timezone and no day boundaries.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- recurrences
-- ---------------------------------------------------------------------------
-- The rule. Generates rows in tasks; never rendered directly.

create table public.recurrences (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid()
                       references auth.users(id) on delete cascade,
  title              text not null check (length(btrim(title)) between 1 and 500),
  notes              text,
  estimated_minutes  integer check (estimated_minutes > 0 and estimated_minutes <= 1440),

  rrule              text not null,   -- RFC 5545, e.g. FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
  dtstart            date not null,
  until              date,            -- NULL = open-ended

  -- NULL => occurrences are SEQUENCE tasks (no fixed time, trailable).
  -- Set  => occurrences are SCHEDULED blocks on the timeline.
  time_of_day        time,

  -- Anchor zone for expansion. "09:00 every weekday" is a different UTC instant
  -- either side of a DST change; expanding in UTC drifts an hour twice a year.
  timezone           text not null,

  materialized_until date,            -- how far ahead rows have been generated
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint scheduled_recurrence_needs_estimate
    check (time_of_day is null or estimated_minutes is not null)
);

create trigger recurrences_validate_timezone
  before insert or update of timezone on public.recurrences
  for each row execute function public.validate_timezone();

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
-- Concrete schedulable things. One-off tasks and generated occurrences share
-- this table, so the panes never need to know the difference.

create table public.tasks (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid()
                      references auth.users(id) on delete cascade,
  title             text not null check (length(btrim(title)) between 1 and 500),
  notes             text,

  due_at            timestamptz,   -- NULL => sequence task; else block START
  estimated_minutes integer check (estimated_minutes > 0 and estimated_minutes <= 1440),

  -- Fractional index key. COLLATE "C" is mandatory: under the default ICU/locale
  -- collation Postgres does not compare these bytewise and ORDER BY rank
  -- silently returns the wrong order. Deliberately NOT unique — a unique
  -- constraint would reject legitimate offline syncs. Order by (rank, id).
  rank              text collate "C" not null,

  completed_at      timestamptz,   -- completion, independent of logged time
  deleted_at        timestamptz,

  -- recurrence linkage
  recurrence_id     uuid references public.recurrences(id) on delete set null,
  occurrence_date   date,
  detached          boolean not null default false,

  -- Maintained by trigger, not GENERATED: timestamptz + interval is STABLE, not
  -- IMMUTABLE (month/day components depend on TimeZone), so Postgres rejects it
  -- in a generated column. A trigger gives the same indexable end instant.
  scheduled_end     timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- a scheduled block cannot be drawn without a height
  constraint scheduled_needs_estimate
    check (due_at is null or estimated_minutes is not null),
  constraint occurrence_pairing
    check ((recurrence_id is null) = (occurrence_date is null))
);

create or replace function public.set_scheduled_end()
returns trigger
language plpgsql
as $$
begin
  new.scheduled_end := case
    when new.due_at is null then null
    else new.due_at + make_interval(mins => new.estimated_minutes)
  end;
  return new;
end $$;

create trigger tasks_set_scheduled_end
  before insert or update of due_at, estimated_minutes on public.tasks
  for each row execute function public.set_scheduled_end();

-- ---------------------------------------------------------------------------
-- time_entries
-- ---------------------------------------------------------------------------
-- One row per trailed block. Many rows per task per day.

create table public.time_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid()
                references auth.users(id) on delete cascade,

  -- RESTRICT, not CASCADE: trailed blocks are a permanent record. Task removal
  -- goes through tasks.deleted_at instead.
  task_id     uuid not null references public.tasks(id) on delete restrict,

  started_at  timestamptz not null,  -- client clock; the timeline's truth
  ended_at    timestamptz,           -- NULL => CURRENTLY RUNNING
  edited_at   timestamptz,           -- NULL => never hand-corrected
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),  -- server clock; skew detection
  updated_at  timestamptz not null default now(),

  constraint ends_after_start check (ended_at is null or ended_at > started_at),

  -- timestamptz - timestamptz -> interval and date_part over interval are both
  -- IMMUTABLE, so unlike scheduled_end this one can be a real generated column.
  duration_seconds integer generated always as (
    case when ended_at is null then null
         else extract(epoch from (ended_at - started_at))::int end
  ) stored
);

-- ---------------------------------------------------------------------------
-- indexes
-- ---------------------------------------------------------------------------

-- At most one running timer per user, enforced by the database. This is what
-- makes "start on phone, see on laptop" unambiguous.
create unique index time_entries_one_running
  on public.time_entries (user_id)
  where ended_at is null and deleted_at is null;

-- Materialization idempotency: re-running expansion never duplicates.
create unique index tasks_one_row_per_occurrence
  on public.tasks (recurrence_id, occurrence_date)
  where recurrence_id is not null and deleted_at is null;

-- TIMELINE: day and week range scans.
create index tasks_scheduled_range
  on public.tasks (user_id, due_at, scheduled_end)
  where due_at is not null and deleted_at is null;

-- SEQUENCE pane, in order. No completed_at filter: completed tasks stay in place
-- at their original rank and are struck through by the renderer.
create index tasks_sequence
  on public.tasks (user_id, rank)
  where due_at is null and deleted_at is null;

create index time_entries_user_started
  on public.time_entries (user_id, started_at desc)
  where deleted_at is null;

create index time_entries_task
  on public.time_entries (task_id, started_at desc)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- behaviour triggers
-- ---------------------------------------------------------------------------

-- Trailing is for sequence tasks only. A CHECK cannot reference another table.
-- BEFORE INSERT only, deliberately: the rule is "you may not START a trail on a
-- scheduled task", not "a scheduled task may never have historical entries".
-- That lets a trailed sequence task later gain a due date without the database
-- rejecting the update or destroying what was already recorded.
create or replace function public.enforce_trail_target()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.tasks
              where id = new.task_id and due_at is not null) then
    raise exception 'cannot start a trail on a scheduled task (%)', new.task_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger time_entries_trail_target
  before insert on public.time_entries
  for each row execute function public.enforce_trail_target();

-- Completing a task closes its running entry, in the same transaction.
-- ended_at = completed_at, NOT now(): a completion syncing up from a device that
-- was offline should stop the timer when work actually finished, not when the
-- row reached the server. now() would silently inflate every offline completion.
create or replace function public.autostop_on_complete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.completed_at is not null and old.completed_at is null then
    update public.time_entries
       set ended_at = new.completed_at
     where task_id = new.id
       and ended_at is null
       and deleted_at is null
       -- guard the CHECK: never close an entry before it started
       and new.completed_at > started_at;
  end if;
  return new;
end $$;

create trigger tasks_autostop
  after update of completed_at on public.tasks
  for each row execute function public.autostop_on_complete();

-- Stopping a timer and correcting a block are both UPDATEs on the same columns,
-- so the difference is defined explicitly:
--   moving started_at                      -> edit
--   changing an ended_at that was ALREADY set -> edit
--   setting an ended_at that was NULL      -> the normal stop, not an edit
-- The offline-collision reconciler is the exception: it closes the losing entry
-- from NULL but must set edited_at itself, because that end instant was
-- reconstructed rather than observed. A caller-supplied edited_at is preserved.
create or replace function public.mark_entry_edited()
returns trigger
language plpgsql
as $$
begin
  if  new.started_at is distinct from old.started_at
   or (old.ended_at is not null and new.ended_at is distinct from old.ended_at)
  then
    new.edited_at := now();
  end if;
  return new;
end $$;

create trigger time_entries_mark_edited
  before update on public.time_entries
  for each row execute function public.mark_entry_edited();

-- updated_at maintenance
create trigger profiles_moddatetime
  before update on public.profiles
  for each row execute procedure extensions.moddatetime(updated_at);

create trigger recurrences_moddatetime
  before update on public.recurrences
  for each row execute procedure extensions.moddatetime(updated_at);

create trigger tasks_moddatetime
  before update on public.tasks
  for each row execute procedure extensions.moddatetime(updated_at);

create trigger time_entries_moddatetime
  before update on public.time_entries
  for each row execute procedure extensions.moddatetime(updated_at);

-- ---------------------------------------------------------------------------
-- row level security
-- ---------------------------------------------------------------------------
-- RLS is what makes the anon key safe to ship in the browser.
-- (select auth.uid()) rather than bare auth.uid(): Postgres hoists it into an
-- InitPlan and evaluates once per query instead of once per row.
-- WITH CHECK matters as much as USING — without it a row's user_id could be
-- updated to someone else's.

alter table public.profiles     enable row level security;
alter table public.recurrences  enable row level security;
alter table public.tasks        enable row level security;
alter table public.time_entries enable row level security;

create policy "own profile" on public.profiles
  for all to authenticated
  using      ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy "own recurrences" on public.recurrences
  for all to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own tasks" on public.tasks
  for all to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own time entries" on public.time_entries
  for all to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete
  on public.profiles, public.recurrences, public.tasks, public.time_entries
  to authenticated;

-- ---------------------------------------------------------------------------
-- realtime
-- ---------------------------------------------------------------------------
-- Guarded so the migration also applies to a bare Postgres without Supabase's
-- publication present.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table '
         || 'public.tasks, public.time_entries, public.recurrences';
  end if;
end $$;
