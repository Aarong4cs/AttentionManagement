-- Pushing tracked time out to a Google calendar we create and own.
--
-- This is NOT two-way sync. Two independent one-way flows: their calendars come
-- in read-only, and our trailed blocks go out to a calendar this app created.
-- No event is owned by both sides, so there is nothing to reconcile — none of
-- the conflict resolution or echo-loop suppression real two-way sync needs.

alter table public.google_connections
  -- the secondary calendar this app created; null until the first push
  add column app_calendar_id text,
  -- pushing is opt-in: writing into someone's calendar uninvited is a surprise
  add column push_enabled boolean not null default false;

alter table public.time_entries
  add column google_event_id  text,
  -- when the pushed copy last matched this row; compared against updated_at to
  -- decide whether anything needs sending
  add column google_synced_at timestamptz;

-- The push scans for work: entries that have never been sent, or whose local
-- row has moved on since. Partial, because a finished entry that is already
-- in step is the overwhelmingly common case and does not need indexing.
create index time_entries_pending_push
  on public.time_entries (user_id, updated_at)
  where ended_at is not null
    and (google_synced_at is null or updated_at > google_synced_at);

-- Deleting locally has to delete in Google too, and a soft-deleted row still
-- carries the id of the event to remove.
create index time_entries_pushed_deleted
  on public.time_entries (user_id)
  where deleted_at is not null and google_event_id is not null;
