-- Schema assertions for Attention Management.
--
-- Paste the whole file into the Supabase dashboard SQL editor and run it.
-- The final SELECT returns one row per check, failures first.
--
-- Every check runs inside ONE function and results accumulate in a local
-- variable — no tables, temporary or otherwise, because cross-statement table
-- visibility is not reliable in the dashboard's session. All fixture data is
-- written inside a transaction that ROLLS BACK, so nothing survives the run.
--
-- Run against a throwaway project or a local db: it inserts into auth.users.

begin;

create or replace function public._run_assertions()
returns table (status text, check_name text)
language plpgsql
as $fn$
declare
  res       text[] := '{}';
  orig_role text   := current_user;
  u1        uuid   := '11111111-1111-1111-1111-111111111111';
  u2        uuid   := '22222222-2222-2222-2222-222222222222';
  t_seq     uuid   := 'aaaa0001-0000-0000-0000-000000000001';
  t_sched   uuid   := 'aaaa0001-0000-0000-0000-000000000002';
  t_auto    uuid   := 'aaaa0001-0000-0000-0000-000000000030';
  t_edit    uuid   := 'aaaa0001-0000-0000-0000-000000000040';
  e_mid     uuid   := 'bbbb0001-0000-0000-0000-000000000001';
  e_night   uuid   := 'bbbb0001-0000-0000-0000-000000000004';
  e_auto    uuid   := 'bbbb0001-0000-0000-0000-000000000005';
  e_edit    uuid   := 'bbbb0001-0000-0000-0000-000000000006';
  rec1      uuid   := 'cccc0001-0000-0000-0000-000000000001';
  v_uid     uuid;
  v_ts      timestamptz;
  v_int     integer;
  v_txt     text;
begin
  ---------------------------------------------------------------- fixtures
  insert into auth.users (id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  values (u1, 'authenticated', 'authenticated', 'one@test.local', '', now(), now(), now()),
         (u2, 'authenticated', 'authenticated', 'two@test.local', '', now(), now(), now());

  select count(*) into v_int from public.profiles where id in (u1, u2);
  res := array_append(res, case when v_int = 2 then 'PASS|' else 'FAIL|' end
              || '0. signup trigger creates a profile per user');

  update public.profiles set timezone = 'America/New_York' where id = u1;

  ------------------------------------------------ 1. one running timer only
  insert into public.tasks (id, user_id, title, rank) values (t_seq, u1, 'Inbox', 'a1');
  insert into public.time_entries (id, user_id, task_id, started_at)
  values (e_mid, u1, t_seq, now() - interval '10 minutes');

  begin
    insert into public.time_entries (id, user_id, task_id, started_at)
    values ('bbbb0001-0000-0000-0000-000000000002', u1, t_seq, now());
    res := array_append(res, 'FAIL|1. a second running timer is rejected (23505)');
  exception when unique_violation then
    res := array_append(res, 'PASS|1. a second running timer is rejected (23505)');
  end;

  insert into public.tasks (id, user_id, title, rank)
  values ('aaaa0002-0000-0000-0000-000000000001', u2, 'Their task', 'a1');
  begin
    insert into public.time_entries (id, user_id, task_id, started_at)
    values ('bbbb0002-0000-0000-0000-000000000001', u2,
            'aaaa0002-0000-0000-0000-000000000001', now());
    res := array_append(res, 'PASS|1b. the running-timer index is per-user, not global');
  exception when others then
    res := array_append(res, 'FAIL|1b. the running-timer index is per-user, not global');
  end;

  ------------------------------------------- 2. sequence-only trailing
  insert into public.tasks (id, user_id, title, rank, due_at, estimated_minutes)
  values (t_sched, u1, 'Standup', 'a2', '2026-06-10T13:00:00Z', 30);

  begin
    insert into public.time_entries (id, user_id, task_id, started_at)
    values ('bbbb0001-0000-0000-0000-000000000003', u1, t_sched, now());
    res := array_append(res, 'FAIL|2. starting a trail on a scheduled task is rejected');
  exception when check_violation then
    res := array_append(res, 'PASS|2. starting a trail on a scheduled task is rejected');
  end;

  begin
    update public.tasks set due_at = '2026-06-11T13:00:00Z', estimated_minutes = 30
     where id = t_seq;
    res := array_append(res, 'PASS|2b. a task with history may still be scheduled afterwards');
    update public.tasks set due_at = null, estimated_minutes = null where id = t_seq;
  exception when others then
    res := array_append(res, 'FAIL|2b. a task with history may still be scheduled afterwards');
  end;

  ------------------------------------------------- 3 & 4. midnight
  update public.time_entries
     set started_at = '2026-06-11T03:40:00Z', ended_at = '2026-06-11T04:20:00Z'
   where id = e_mid;

  select duration_seconds into v_int from public.time_entries where id = e_mid;
  res := array_append(res, case when v_int = 2400 then 'PASS|' else 'FAIL|' end
              || '3. a midnight-spanning entry is ONE row of 40 minutes');

  select count(*) into v_int from public.time_entries
   where user_id = u1 and deleted_at is null
     and started_at < public.day_start('2026-06-11', 'America/New_York')
     and coalesce(ended_at, now()) > public.day_start('2026-06-10', 'America/New_York');
  res := array_append(res, case when v_int = 1 then 'PASS|' else 'FAIL|' end
              || '3b. it is returned by the 2026-06-10 range query');

  select count(*) into v_int from public.time_entries
   where user_id = u1 and deleted_at is null
     and started_at < public.day_start('2026-06-12', 'America/New_York')
     and coalesce(ended_at, now()) > public.day_start('2026-06-11', 'America/New_York');
  res := array_append(res, case when v_int = 1 then 'PASS|' else 'FAIL|' end
              || '3c. and by the 2026-06-11 range query');

  select extract(epoch from
           least(ended_at, public.day_start('2026-06-11', 'America/New_York'))
         - greatest(started_at, public.day_start('2026-06-10', 'America/New_York')))
    into v_int from public.time_entries where id = e_mid;
  res := array_append(res, case when v_int = 1200 then 'PASS|' else 'FAIL|' end
              || '3d. day one clips to 20 minutes');

  select extract(epoch from
           least(ended_at, public.day_start('2026-06-12', 'America/New_York'))
         - greatest(started_at, public.day_start('2026-06-11', 'America/New_York')))
    into v_int from public.time_entries where id = e_mid;
  res := array_append(res, case when v_int = 1200 then 'PASS|' else 'FAIL|' end
              || '3e. day two clips to 20 minutes');

  insert into public.time_entries (id, user_id, task_id, started_at)
  values (e_night, u1, t_seq, now() - interval '20 hours');
  select count(*) into v_int from public.time_entries
   where user_id = u1 and ended_at is null and deleted_at is null
     and started_at < now() and coalesce(ended_at, now()) > date_trunc('day', now());
  res := array_append(res, case when v_int = 1 then 'PASS|' else 'FAIL|' end
              || '4. a timer running since yesterday appears in the current day range');

  ------------------------------------------ 6. materialization idempotency
  insert into public.recurrences (id, user_id, title, rrule, dtstart, timezone,
                                  time_of_day, estimated_minutes)
  values (rec1, u1, 'Standup', 'FREQ=WEEKLY;BYDAY=MO', '2026-06-01',
          'America/New_York', '09:00:00', 15);
  insert into public.tasks (id, user_id, title, rank, due_at, estimated_minutes,
                            recurrence_id, occurrence_date)
  values ('aaaa0001-0000-0000-0000-000000000010', u1, 'Standup', 'b1',
          '2026-06-08T13:00:00Z', 15, rec1, '2026-06-08');

  begin
    insert into public.tasks (id, user_id, title, rank, due_at, estimated_minutes,
                              recurrence_id, occurrence_date)
    values ('aaaa0001-0000-0000-0000-000000000011', u1, 'Standup', 'b2',
            '2026-06-08T13:00:00Z', 15, rec1, '2026-06-08');
    res := array_append(res, 'FAIL|6. re-materializing the same occurrence is rejected (23505)');
  exception when unique_violation then
    res := array_append(res, 'PASS|6. re-materializing the same occurrence is rejected (23505)');
  end;

  ------------------------------------------------- 8. C collation on rank
  -- Z(0x5A) precedes a(0x61) bytewise. Under en_US ICU, case is a secondary
  -- weight and 'aa' would sort first. This pair discriminates; a0/a0V/a1 does not.
  insert into public.tasks (id, user_id, title, rank) values
    ('aaaa0001-0000-0000-0000-000000000020', u1, 'upper', 'Zz'),
    ('aaaa0001-0000-0000-0000-000000000021', u1, 'lower', 'aa');
  select string_agg(title, ',' order by rank, id) into v_txt
    from public.tasks where user_id = u1 and rank in ('Zz', 'aa');
  res := array_append(res, case when v_txt = 'upper,lower' then 'PASS|' else 'FAIL|' end
              || '8. ORDER BY rank is bytewise -- C collation is in effect');

  --------------------------------------------------- 13. auto-stop
  insert into public.tasks (id, user_id, title, rank) values (t_auto, u1, 'Autostop me', 'c1');
  update public.time_entries set ended_at = now() - interval '19 hours' where id = e_night;
  insert into public.time_entries (id, user_id, task_id, started_at)
  values (e_auto, u1, t_auto, '2026-06-20T10:00:00Z');

  update public.tasks set completed_at = '2026-06-20T10:45:00Z' where id = t_auto;

  select ended_at into v_ts from public.time_entries where id = e_auto;
  res := array_append(res, case when v_ts = '2026-06-20T10:45:00Z' then 'PASS|' else 'FAIL|' end
              || '13. completing closes the running entry at completed_at, not now()');

  select edited_at into v_ts from public.time_entries where id = e_auto;
  res := array_append(res, case when v_ts is null then 'PASS|' else 'FAIL|' end
              || '13b. an auto-stopped entry is NOT marked edited');

  update public.tasks set completed_at = '2026-06-21T10:45:00Z' where id = t_auto;
  select ended_at into v_ts from public.time_entries where id = e_auto;
  res := array_append(res, case when v_ts = '2026-06-20T10:45:00Z' then 'PASS|' else 'FAIL|' end
              || '13c. re-completing an already-completed task is a no-op for entries');

  --------------------------------------------------- 14. edit marking
  insert into public.tasks (id, user_id, title, rank) values (t_edit, u1, 'Edit me', 'c2');
  insert into public.time_entries (id, user_id, task_id, started_at)
  values (e_edit, u1, t_edit, '2026-06-22T10:00:00Z');

  update public.time_entries set ended_at = '2026-06-22T11:00:00Z' where id = e_edit;
  select edited_at into v_ts from public.time_entries where id = e_edit;
  res := array_append(res, case when v_ts is null then 'PASS|' else 'FAIL|' end
              || '14. stopping a running timer is not an edit');

  update public.time_entries set ended_at = '2026-06-22T11:30:00Z' where id = e_edit;
  select edited_at into v_ts from public.time_entries where id = e_edit;
  res := array_append(res, case when v_ts is not null then 'PASS|' else 'FAIL|' end
              || '14b. changing an already-set ended_at IS an edit');

  update public.time_entries set edited_at = null, started_at = '2026-06-22T09:55:00Z'
   where id = e_edit;
  select edited_at into v_ts from public.time_entries where id = e_edit;
  res := array_append(res, case when v_ts is not null then 'PASS|' else 'FAIL|' end
              || '14c. moving started_at IS an edit');

  ------------------------------------- 15. completed tasks keep their place
  select count(*) into v_int from public.tasks
   where id = t_auto and due_at is null and deleted_at is null and completed_at is not null;
  res := array_append(res, case when v_int = 1 then 'PASS|' else 'FAIL|' end
              || '15. a completed sequence task is still a sequence row');

  select rank into v_txt from public.tasks where id = t_auto;
  res := array_append(res, case when v_txt = 'c1' then 'PASS|' else 'FAIL|' end
              || '15b. completing a task does not change its rank');

  ----------------------------------------- 10. history survives deletion
  begin
    delete from public.tasks where id = t_edit;
    res := array_append(res, 'FAIL|10. hard-deleting a task with history is refused (RESTRICT)');
  exception when foreign_key_violation then
    res := array_append(res, 'PASS|10. hard-deleting a task with history is refused (RESTRICT)');
  end;

  update public.tasks set deleted_at = now() where id = t_edit;
  select count(*) into v_int from public.time_entries
   where task_id = t_edit and deleted_at is null;
  res := array_append(res, case when v_int = 1 then 'PASS|' else 'FAIL|' end
              || '10b. soft-deleting the task leaves its entries queryable');

  --------------------------------------------- 12. timezone day boundaries
  res := array_append(res, case when public.day_start('2026-06-10', 'America/New_York')
                         = '2026-06-10T04:00:00Z' then 'PASS|' else 'FAIL|' end
              || '12. EDT day starts at 04:00Z');
  res := array_append(res, case when public.day_start('2026-01-10', 'America/New_York')
                         = '2026-01-10T05:00:00Z' then 'PASS|' else 'FAIL|' end
              || '12b. EST day starts at 05:00Z');
  res := array_append(res, case when public.day_start('2026-03-09', 'America/New_York')
                       - public.day_start('2026-03-08', 'America/New_York')
                         = interval '23 hours' then 'PASS|' else 'FAIL|' end
              || '12c. the spring-forward day is 23 hours long');
  res := array_append(res, case when public.day_start('2026-11-02', 'America/New_York')
                       - public.day_start('2026-11-01', 'America/New_York')
                         = interval '25 hours' then 'PASS|' else 'FAIL|' end
              || '12d. the fall-back day is 25 hours long');

  ------------------------------------------------- constraint sanity
  begin
    insert into public.tasks (id, user_id, title, rank, due_at)
    values ('aaaa0001-0000-0000-0000-000000000050', u1, 'No estimate', 'd1', now());
    res := array_append(res, 'FAIL|16. a scheduled task must carry an estimate (block height)');
  exception when check_violation then
    res := array_append(res, 'PASS|16. a scheduled task must carry an estimate (block height)');
  end;

  begin
    insert into public.tasks (id, user_id, title, rank, occurrence_date)
    values ('aaaa0001-0000-0000-0000-000000000051', u1, 'Orphan', 'd2', '2026-06-01');
    res := array_append(res, 'FAIL|17. occurrence_date and recurrence_id must be set together');
  exception when check_violation then
    res := array_append(res, 'PASS|17. occurrence_date and recurrence_id must be set together');
  end;

  begin
    update public.profiles set timezone = 'Mars/Olympus' where id = u1;
    res := array_append(res, 'FAIL|18. an unknown timezone is rejected');
  exception when invalid_parameter_value then
    res := array_append(res, 'PASS|18. an unknown timezone is rejected');
  end;

  select scheduled_end into v_ts from public.tasks where id = t_sched;
  res := array_append(res, case when v_ts = '2026-06-10T13:30:00Z' then 'PASS|' else 'FAIL|' end
              || '19. scheduled_end = due_at + estimated_minutes');

  update public.tasks set estimated_minutes = 60 where id = t_sched;
  select scheduled_end into v_ts from public.tasks where id = t_sched;
  res := array_append(res, case when v_ts = '2026-06-10T14:00:00Z' then 'PASS|' else 'FAIL|' end
              || '19b. scheduled_end follows a changed estimate');

  ------------------------------------------------------------ 9. RLS
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- If auth.uid() is NULL the RLS checks below would pass vacuously, so prove
  -- the claims actually took effect before trusting any of them.
  select auth.uid() into v_uid;
  res := array_append(res, case when v_uid = u1 then 'PASS|' else 'FAIL|' end
              || '9pre. auth.uid() reflects the injected JWT claims');

  select count(*) into v_int from public.tasks where user_id = u2;
  res := array_append(res, case when v_int = 0 then 'PASS|' else 'FAIL|' end
              || '9. user one cannot see user two tasks');

  select count(*) into v_int from public.tasks;
  res := array_append(res, case when v_int > 0 then 'PASS|' else 'FAIL|' end
              || '9b. user one can see their own tasks');

  select count(*) into v_int from public.profiles;
  res := array_append(res, case when v_int = 1 then 'PASS|' else 'FAIL|' end
              || '9c. profiles are scoped to the caller');

  begin
    update public.tasks set user_id = u2 where id = t_seq;
    get diagnostics v_int = row_count;
    res := array_append(res, case when v_int = 0 then 'PASS|' else 'FAIL|' end
                || '9d. WITH CHECK blocks reassigning user_id');
  exception when insufficient_privilege or check_violation then
    res := array_append(res, 'PASS|9d. WITH CHECK blocks reassigning user_id');
  end;

  insert into public.tasks (id, title, rank)
  values ('aaaa0001-0000-0000-0000-000000000060', 'Defaulted owner', 'e1');
  select user_id into v_uid from public.tasks
   where id = 'aaaa0001-0000-0000-0000-000000000060';
  res := array_append(res, case when v_uid = u1 then 'PASS|' else 'FAIL|' end
              || '9e. user_id defaults to auth.uid()');

  perform set_config('role', orig_role, true);

  ------------------------------------------------------------ report
  return query
  select split_part(t.x, '|', 1)::text,
         substr(t.x, strpos(t.x, '|') + 1)::text
    from unnest(res) with ordinality as t(x, ord)
   order by (split_part(t.x, '|', 1) = 'FAIL') desc, t.ord;
end
$fn$;

select * from public._run_assertions();

rollback;
