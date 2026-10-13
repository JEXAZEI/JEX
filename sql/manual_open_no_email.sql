-- ============================================================
-- manual_open_no_email.sql
--
-- Pressing "Open now" emailed every student who had turned on email
-- notifications, plus the Secretary, Treasurer and Compliance Officer.
-- That is one email per opted-in account per open, against the EmailJS
-- plan's monthly limit, for news everyone in the room already has. A
-- scheduled open was already in-app only (server_events_batch4.sql).
--
-- Now a manual open is the same: logged, and noticed in the app, with no
-- email. Closing trading and starting or ending practice mode still email,
-- as before.
--
-- The change is in jex_ev_session's six-argument form, which is what
-- rpc_admin_save_session calls. Refuses to run, changing nothing, unless it
-- is the version server_events_batch4.sql created. Safe to run twice.
-- ============================================================

do $mig$
declare
  v_oid oid; v_src text; v_def text; v_nl text; v_n int;
  v_anchor text := '  perform jex_ev_session(p_by, p_old, p_new, p_old_practice, p_new_practice, p_started, true);';
begin
  select p.oid, p.prosrc, pg_get_functiondef(p.oid) into v_oid, v_src, v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'jex_ev_session'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_by text, p_old text, p_new text, p_old_practice boolean, p_new_practice boolean, p_started bigint';
  if v_oid is null then
    raise exception 'ABORT: jex_ev_session (six arguments) not found -- run server_events_batch4.sql first. Nothing changed.';
  end if;

  if position('manual open' in v_src) > 0 then
    raise notice 'A manual open already sends no email -- skipped.';
  else
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    if v_n <> 1 then
      raise exception 'ABORT: jex_ev_session is not the version server_events_batch4.sql created (expected its one line once, found %). Nothing changed -- paste this error back.', v_n;
    end if;
    v_nl := case when position(chr(13) in v_src) > 0 then chr(13) || chr(10) else chr(10) end;
    execute replace(v_def, v_src, replace(v_src, v_anchor,
         '  -- A manual open is noticed in the app only, like a scheduled one' || v_nl
      || '  -- (manual_open_no_email.sql). Closes and practice mode still email.' || v_nl
      || '  perform jex_ev_session(p_by, p_old, p_new, p_old_practice, p_new_practice, p_started,' || v_nl
      || '                         coalesce(p_new, '''') <> ''open'' or p_old is not distinct from ''open'');'));
  end if;

  execute 'revoke execute on function public.jex_ev_session(text,text,text,boolean,boolean,bigint) from public, anon, authenticated';
  raise notice 'A manual open is now in-app only.';
end
$mig$;

-- ── verification ──
-- manual_open_emails     should be false
-- manual_close_emails    should be true: closing trading still emails
-- callable_from_the_web  should be false
select
  (select position('manual open' in prosrc) = 0 from pg_proc
    where proname = 'jex_ev_session' and pronargs = 6)                           as manual_open_emails,
  (select position('<> ''open''' in prosrc) > 0 from pg_proc
    where proname = 'jex_ev_session' and pronargs = 6)                           as manual_close_emails,
  (select has_function_privilege('authenticated', 'public.jex_ev_session(text,text,text,boolean,boolean,bigint)', 'execute')
       or has_function_privilege('anon', 'public.jex_ev_session(text,text,text,boolean,boolean,bigint)', 'execute'))
                                                                                 as callable_from_the_web;
