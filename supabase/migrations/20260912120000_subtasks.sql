-- Subtasks: the checkable steps under a task.
--
-- These replace the free-text description, which was already being written as
-- numbered steps. tasks.notes stays where it is rather than being dropped: the
-- app stops reading it, but nothing that was written there is destroyed.
--
-- A table, not a list stored on the task. Edits are queued offline on two
-- devices, so ticking step 2 on the phone and step 3 on the Mac must both
-- survive. One row per step makes each tick its own write; an array on the
-- task is rewritten whole, and whichever device synced last would win.

create table public.subtasks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid()
               references auth.users(id) on delete cascade,
  task_id    uuid not null references public.tasks(id) on delete cascade,
  title      text not null check (length(btrim(title)) between 1 and 500),
  -- the same fractional keys as tasks.rank, and COLLATE "C" for the same
  -- reason: any other collation silently misorders them
  rank       text collate "C" not null,
  done_at    timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subtasks_task
  on public.subtasks (task_id, rank)
  where deleted_at is null;

alter table public.subtasks enable row level security;

-- Owning the row is not enough. A policy that only compared user_id would let a
-- client hang a step off someone else's task id: the row carries the caller's
-- own user_id and passes. The parent task has to be the caller's as well.
create policy "own subtasks" on public.subtasks
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.tasks t
      where t.id = subtasks.task_id
        and t.user_id = (select auth.uid())
    )
  );

grant select, insert, update, delete on public.subtasks to authenticated;

-- Scoped to the columns that are the user's data, as 20260911150000 does for
-- time_entries, so bookkeeping writes never count as a change.
create trigger subtasks_moddatetime
  before update of task_id, title, rank, done_at, deleted_at
  on public.subtasks
  for each row execute procedure extensions.moddatetime(updated_at);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.subtasks';
  end if;
end $$;
