-- Stop bookkeeping columns from counting as a change.
--
-- moddatetime fired on every UPDATE, so recording that an entry had been pushed
-- to Google also bumped updated_at. The push decides what to send by comparing
-- updated_at against google_synced_at, so stamping a row made it look changed
-- again immediately — re-pushing every finished entry on every pass, for ever,
-- against Google's rate limits, with nothing visibly wrong.
--
-- Naming the columns makes updated_at mean "the user's data changed" rather
-- than "some column was written", which is what every reader already assumed.

drop trigger if exists time_entries_moddatetime on public.time_entries;

create trigger time_entries_moddatetime
  before update of task_id, started_at, ended_at, edited_at, deleted_at
  on public.time_entries
  for each row execute procedure extensions.moddatetime(updated_at);
