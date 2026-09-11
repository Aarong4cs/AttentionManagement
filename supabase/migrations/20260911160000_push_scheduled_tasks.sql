-- Push scheduled blocks too, not only tracked time.
--
-- The original ask was for what is traced AND added here to appear in Google.
-- Only trailed blocks were being sent, so a block created on the timeline never
-- showed up.

alter table public.tasks
  add column google_event_id  text,
  add column google_synced_at timestamptz;

-- The same trap the time_entries trigger had: moddatetime fired on every
-- UPDATE, so stamping a row as pushed bumped updated_at — the column the push
-- compares to decide what to send — and every task would be re-pushed for ever.
-- Naming the columns keeps updated_at meaning "the user's data changed".
--
-- The inbound Google sync writes title/due_at/estimated_minutes, which are
-- listed, so a mirrored event that moves in Google still counts as changed.
drop trigger if exists tasks_moddatetime on public.tasks;

create trigger tasks_moddatetime
  before update of
    title, notes, due_at, estimated_minutes, rank, completed_at, deleted_at,
    color, priority, recurrence_id, occurrence_date, detached, external_etag
  on public.tasks
  for each row execute procedure extensions.moddatetime(updated_at);

-- Scheduled blocks that are ours, needing work. Mirrored Google events are
-- excluded: sending them back would duplicate every appointment the user
-- already has.
create index tasks_pending_push
  on public.tasks (user_id, updated_at)
  where source is null
    and due_at is not null
    and (google_synced_at is null or updated_at > google_synced_at);
