-- Make the overlap predicate indexable without a lookback window.
--
-- blocksInRange asks: started_at < range_end AND (ended_at IS NULL OR
-- ended_at > range_start). The existing (user_id, started_at) index gives no
-- useful lower bound, so the query previously carried a 2-day lookback on
-- started_at to stay selective — which silently DROPPED any entry longer than
-- that, including a timer left running over a long weekend. Wrong rows, no
-- error.
--
-- `ended_at > range_start` is itself highly selective (only recent entries
-- qualify), so indexing it lets the planner bound the scan directly. Combined
-- with the existing partial index for running entries, a BitmapOr covers both
-- arms of the OR and the lookback can be removed entirely.

create index time_entries_user_ended
  on public.time_entries (user_id, ended_at)
  where deleted_at is null;
