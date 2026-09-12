-- Preset tasks: quick-start activities like resting, eating or commuting.
--
-- Picking one starts its timer straight away. Time has to belong to a task —
-- time_entries.task_id is NOT NULL — so each preset is backed by one hidden
-- task, made the first time it runs and reused after that, which keeps all of a
-- preset's time together.
--
-- The preset and its task are separate rows on purpose. Deleting a task erases
-- its blocks from past timelines; deleting a preset must not erase the time
-- already tracked under it. So removing a preset soft-deletes only the preset.
-- Its task keeps preset_id, which keeps it out of the sequence and keeps its
-- history on the timeline.

create table public.presets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid()
               references auth.users(id) on delete cascade,
  title      text not null check (length(btrim(title)) between 1 and 500),
  rank       text collate "C" not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index presets_user
  on public.presets (user_id, rank)
  where deleted_at is null;

alter table public.presets enable row level security;

create policy "own presets" on public.presets
  for all to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.presets to authenticated;

create trigger presets_moddatetime
  before update of title, rank, deleted_at
  on public.presets
  for each row execute procedure extensions.moddatetime(updated_at);

-- Deliberately no unique index on preset_id. Two devices that each start a new
-- preset for the first time while offline would each create its task. With a
-- unique index the second insert is refused, the timer queued against it then
-- fails its foreign key and is dropped — silently losing tracked time. A rare
-- duplicate task is the cheaper failure; the client reuses the oldest.
alter table public.tasks
  add column preset_id uuid references public.presets(id) on delete set null;

create index tasks_preset
  on public.tasks (preset_id)
  where preset_id is not null;

-- Off until switched on, so the task menu looks exactly as it did.
alter table public.profiles
  add column presets_enabled boolean not null default false;

-- Membership is checked per table: adding one that is already published fails,
-- and would take the whole migration down with it.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['presets', 'profiles'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
