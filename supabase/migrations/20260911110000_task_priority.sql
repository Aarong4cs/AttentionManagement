-- Optional priority tag, P1 (highest) through P5.
--
-- NULL means untagged, which sorts after every tagged task rather than being
-- treated as a sixth level. The manual rank still decides order WITHIN a
-- priority, so tagging groups the list without throwing away the ordering that
-- was arranged by hand.

alter table public.tasks
  add column priority smallint
  check (priority is null or priority between 1 and 5);

-- The sequence pane reads (priority nulls last, rank, id). Matching the index
-- to that keeps it a single ordered scan.
drop index if exists public.tasks_sequence;

create index tasks_sequence
  on public.tasks (user_id, priority nulls last, rank, id)
  where due_at is null and deleted_at is null;
