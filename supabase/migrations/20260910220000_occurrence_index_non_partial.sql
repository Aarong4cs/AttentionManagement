-- Make the occurrence index usable as an ON CONFLICT target.
--
-- Materialization relies on
--   upsert(rows, { onConflict: 'recurrence_id,occurrence_date',
--                  ignoreDuplicates: true })
-- being idempotent, so that expanding a rule on every app open — from either
-- device, concurrently — can never duplicate an occurrence.
--
-- That never worked. The index was PARTIAL, and ON CONFLICT against a partial
-- index requires the index predicate to be restated in the conflict target,
-- which PostgREST's on_conflict parameter cannot express. Every materialize()
-- call failed with "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification".
--
-- Dropping the predicate makes the index a valid conflict target. Two
-- consequences, both wanted:
--
--   * one-off tasks have (recurrence_id, occurrence_date) = (NULL, NULL), and
--     NULLs are distinct in a unique index, so they remain unconstrained
--   * a soft-deleted occurrence now blocks its own re-creation. Deleting one
--     occurrence of a recurring task should not be undone by the next
--     materialization pass, so this is the correct behaviour rather than a
--     side effect to work around.

drop index if exists public.tasks_one_row_per_occurrence;

create unique index tasks_one_row_per_occurrence
  on public.tasks (recurrence_id, occurrence_date);
