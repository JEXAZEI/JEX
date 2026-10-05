-- ============================================================
-- smoke_server_events.sql
--
-- CHANGES NOTHING. It ends with an error on purpose: everything it did is
-- rolled back, emails included (pg_net only sends after a commit).
--
-- The live test of the server-recorded events. As real accounts from your
-- own data, it:
--   1. adjusts a student's balance by +$0.01, as an officer   (batch 1)
--   2. posts an announcement, as the same officer             (batch 2)
--   3. files a bug report, as a student                       (batch 3)
--   4. checks the web really cannot write the log             (batch 4)
-- then reports what the server wrote -- and, if it wrote nothing, the error
-- that stopped it.
--
-- Read the result in the error message: it starts "SMOKE TEST RESULT
-- (rolled back -- nothing was kept)". Every line should say ok.
-- ============================================================

do $smoke$
declare
  v_officer record; v_student record; v_t0 timestamptz := now();   -- transaction start: notifications are stamped with it
  v_out text := ''; v_n int; v_types text; v_err text; v_ok boolean := true;
  v_broken int;
begin
  select id, name, auth_uid into v_officer from jex_users
   where role in ('chairman','president') and auth_uid is not null order by role, created_at limit 1;
  select id, name, auth_uid into v_student from jex_users
   where role = 'student' and status = 'approved' and auth_uid is not null order by created_at limit 1;
  if v_officer.id is null or v_student.id is null then
    raise exception 'SMOKE TEST: needs a Chairman/President and an approved student who have signed in at least once.';
  end if;

  -- Act as the officer, the way a signed-in browser is identified.
  perform set_config('request.jwt.claim.sub', v_officer.auth_uid::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_officer.auth_uid)::text, true);
  begin
    perform admin_adjust_cash(v_student.id, 'add', 0.01);
    v_out := v_out || E'\n  balance adjustment ran';
  exception when others then
    v_ok := false; v_out := v_out || E'\n  FAILED balance adjustment: ' || sqlerrm;
  end;
  begin
    perform rpc_post_announcement('Smoke test', 'This is rolled back and never shown.', 'info');
    v_out := v_out || E'\n  announcement ran';
  exception when others then
    v_ok := false; v_out := v_out || E'\n  FAILED announcement: ' || sqlerrm;
  end;

  -- Act as the student.
  perform set_config('request.jwt.claim.sub', v_student.auth_uid::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_student.auth_uid)::text, true);
  begin
    perform rpc_submit_bug_report('Smoke test of the server-recorded events -- rolled back.', null, null);
    v_out := v_out || E'\n  bug report ran';
  exception when others then
    v_ok := false; v_out := v_out || E'\n  FAILED bug report: ' || sqlerrm;
  end;

  -- What the server wrote.
  select count(*), coalesce(string_agg(distinct type, ', ' order by type), '')
    into v_n, v_types
    from jex_activity where logged_by = 'server' and created_at >= v_t0;
  v_out := v_out || E'\n' || case when v_n >= 3 and v_types like '%announcement%' and v_types like '%balance_adj%'
                                   and v_types like '%bug_report%' then 'ok   ' else 'BAD  ' end
         || 'log entries written by the server: ' || v_n || ' (' || v_types || ')';
  if v_n < 3 then v_ok := false; end if;

  select count(*) into v_n from jex_notifications where sent_by = 'server' and created_at >= v_t0 and type = 'bug_report';
  v_out := v_out || E'\n' || case when v_n >= 1 then 'ok   ' else 'BAD  ' end
         || 'bug report notices to the Chairman/President: ' || v_n;
  if v_n < 1 then v_ok := false; end if;

  select count(*) into v_broken from (
    select prev_hash, lag(coalesce(entry_hash, id)) over (order by created_at) as before, created_at
      from jex_activity where type <> 'snapshot') c
   where c.created_at >= v_t0 and c.before is not null and c.prev_hash is distinct from c.before;
  v_out := v_out || E'\n' || case when v_broken = 0 then 'ok   ' else 'BAD  ' end || 'chain breaks among them: ' || v_broken;

  -- If the server wrote nothing, call its log helper directly to see why.
  if not v_ok then
    begin
      perform jex_log('smoke', 'direct call', null, null, null, null);
      v_out := v_out || E'\n  jex_log on its own works -- the problem is in the event functions';
    exception when others then
      v_out := v_out || E'\n  jex_log on its own fails: ' || sqlerrm;
    end;
  end if;

  -- The doors.
  v_out := v_out || E'\n' || case when not has_function_privilege('authenticated', 'public.rpc_log_activity(text,text,text,text,text,numeric)', 'execute')
                                   and not has_function_privilege('anon', 'public.rpc_log_activity(text,text,text,text,text,numeric)', 'execute')
                                   and not has_function_privilege('authenticated', 'public.rpc_push_notification(text,text,text,text)', 'execute')
                                   and not has_function_privilege('anon', 'public.rpc_push_notification(text,text,text,text)', 'execute')
                                  then 'ok   ' else 'BAD  ' end || 'the web cannot write the log or notifications';

  raise exception 'SMOKE TEST RESULT (rolled back -- nothing was kept):%', v_out;
end
$smoke$;
