-- ============================================================
-- server_events_batch4.sql
--
-- Server-recorded events, batch 4 of 4 (see SERVER_EVENTS_PLAN.md): close
-- the doors. Requires batches 1-3, and the page update that stopped calling
-- the two general-purpose writers.
--
-- ── 1. Only the server writes the activity log and notifications ──
--
-- rpc_log_activity and rpc_push_notification can no longer be called from
-- the web. Every event the app records is now written by the function that
-- did the thing. They are kept (not dropped), so this can be undone with two
-- grants.
--
-- ── 2. The scheduler finishes what it starts ──
--
-- A scheduled or timed open set the session open and nothing else: queued
-- after-hours orders went live only if some open browser happened to notice
-- the change, and stayed queued if none did. A scheduled close never expired
-- day orders in the database at all -- browsers marked them expired on screen
-- only, so they carried into the next session and could fill there.
-- rpc_session_tick now, on the change itself:
--   open    turns after-hours orders live and tells each owner
--   close   expires day orders and tells each owner
-- and logs the open or close, telling students in the app -- no email (a
-- weekly schedule would otherwise email everyone twice a school day).
--
-- ── 3. A manual open tells after-hours owners ──
--
-- rpc_admin_save_session turned after-hours orders live itself, so the
-- page's activation call found none left and their owners were never told.
--
-- ── 4. A failed notification no longer loses its log entry ──
--
-- Each notification is written on its own; if one fails it is a WARNING and
-- the rest of the event -- its log entry included -- stands.
--
-- Refuses to run, changing nothing, unless both edited functions are the
-- production versions this was tested against. Safe to run twice.
-- ============================================================

do $mig$
declare
  r record;
  e record;
  v_plan jsonb;
  v_src text; v_fp text; v_new text; v_nl text; v_a text; v_ins text; v_i text;
  v_n int;
  v_patched int := 0;
begin
  -- function, fingerprint, text only the patched version contains, the text
  -- to find (with indentation; {nl} is the function's own line ending), the
  -- text to put, and before / after / replace.
  select jsonb_agg(to_jsonb(p) order by p.seq) into v_plan
    from (values
   (1, 'rpc_admin_save_session', '051cfc4f13f920f07a5fe27e37f6b349', 'v_activated',
    '  v_was jex_session%rowtype;', '  v_activated jsonb;', 'after'),
   (2, 'rpc_admin_save_session', '051cfc4f13f920f07a5fe27e37f6b349', 'v_activated',
    '    update jex_limit_orders set status = ''open'' where status = ''after_hours'';',
    '    with done as (update jex_limit_orders set status = ''open'' where status = ''after_hours''{nl}'
      || '      returning id, user_id, ticker, qty, limit_price, side){nl}'
      || '    select coalesce(jsonb_agg(to_jsonb(done.*)), ''[]''::jsonb) into v_activated from done;{nl}'
      || '    perform jex_ev_after_hours_active(v_activated);', 'replace'),
   (3, 'rpc_session_tick', 'dec464d75ad045c29d6f2893119c67b8', 'jex_ev_session_tick',
    '  select * into v_session from jex_session where id = 1;',
    '  perform jex_ev_session_tick(v_session.status, v_session.session_started_at);', 'before')
    ) as p(seq, fn, md5, done, anchor, ins, pos);

  -- ── check: batches 1-3 are in, and each function is done or exactly as expected ──
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'jex_ev_after_hours_active') then
    raise exception 'ABORT: run server_events_batch1.sql, batch2 and batch3 first. Nothing changed.';
  end if;
  for r in select distinct x.fn, x.md5, x.done from jsonb_to_recordset(v_plan) as x(seq int, fn text, md5 text, done text, anchor text, ins text, pos text) loop
    v_src := null; v_fp := null;
    select p.prosrc, md5(replace(p.prosrc, chr(13), '')) into v_src, v_fp
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn;
    if v_src is null then raise exception 'ABORT: % not found. Nothing changed.', r.fn; end if;
    if position(r.done in v_src) > 0 then continue; end if;
    if v_fp <> r.md5 then
      raise exception 'ABORT: % is not the version this was written against (md5 %). Nothing changed -- paste this error back.', r.fn, v_fp;
    end if;
    v_nl := case when position(chr(13) in v_src) > 0 then chr(13) || chr(10) else chr(10) end;
    for e in select * from jsonb_to_recordset(v_plan) as x(seq int, fn text, md5 text, done text, anchor text, ins text, pos text) where x.fn = r.fn order by x.seq loop
      v_a := replace(e.anchor, '{nl}', v_nl);
      v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
      if v_n <> 1 then
        raise exception 'ABORT: expected edit % anchor exactly once in %, found %. Nothing changed.', e.seq, r.fn, v_n;
      end if;
    end loop;
  end loop;

  -- ── 4. notifications: one at a time, email optional ──
  -- The full version takes p_email. The old four-argument form keeps its
  -- meaning (email under the usual rules) for every existing caller.
  execute $fn$
create or replace function public.jex_notify(p_user_id text, p_type text, p_message text, p_ticker text, p_email boolean)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare
  v_recipient jex_users%rowtype;
  v_sess jex_session%rowtype;
  v_secret text; v_addr text;
  v_msg text := left(btrim(coalesce(p_message, '')), 500);
  v_important text[] := array['dividend','halt','stop_loss','ipo','session','limit_fill',
    'founder_alloc','bug_report','contact_admin','margin_call'];
begin
  select * into v_recipient from jex_users where id = p_user_id;
  if not found or v_msg = '' then return; end if;
  -- On its own: a notification that cannot be written is a WARNING, and the
  -- event that sent it -- its log entry and every other notice -- stands.
  begin
    insert into jex_notifications (id, user_id, type, message, ticker, read, ts, sent_by, created_at)
      values (gen_random_uuid()::text, p_user_id, p_type, v_msg, p_ticker, false,
        to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI AM'), 'server', now());
  exception when others then
    raise warning 'notification to % not written: %', p_user_id, sqlerrm;
    return;
  end;
  begin
    if p_email and v_recipient.email_notifications and p_type = any(v_important) then
      v_addr := coalesce(v_recipient.notification_email, v_recipient.email);
      if v_addr is not null then
        select * into v_sess from jex_session where id = 1;
        select emailjs_access_token into v_secret from jex_email_secrets where id = 1;
        if v_sess.emailjs_service_id is not null and v_sess.emailjs_template_id is not null
           and v_sess.emailjs_public_key is not null and v_secret is not null then
          perform net.http_post(
            url := 'https://api.emailjs.com/api/v1.0/email/send',
            body := jsonb_build_object(
              'service_id', v_sess.emailjs_service_id, 'template_id', v_sess.emailjs_template_id,
              'user_id', v_sess.emailjs_public_key, 'accessToken', v_secret,
              'template_params', jsonb_build_object(
                'to_email', v_addr, 'to_name', v_recipient.name,
                'subject', 'JEX Alert — ' || left(regexp_replace(v_msg, '[\x00-\x1f]', '', 'g'), 60),
                'message', v_msg, 'ticker', coalesce(p_ticker, ''),
                'app_url', coalesce(v_sess.emailjs_site_url, ''))),
            headers := jsonb_build_object('Content-Type', 'application/json'));
        end if;
      end if;
    end if;
  exception when others then
    null; -- email is best-effort; the notification row stands
  end;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_notify(p_user_id text, p_type text, p_message text, p_ticker text default null)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_notify(p_user_id, p_type, p_message, p_ticker, true);
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_notify_students(p_type text, p_message text, p_ticker text,
                                                      p_skip_holders_of text, p_email boolean)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_id text;
begin
  for v_id in select id from jex_users
               where role = 'student' and status = 'approved'
                 and (p_skip_holders_of is null or coalesce((holdings->>p_skip_holders_of)::numeric, 0) <= 0)
               order by id loop
    perform jex_notify(v_id, p_type, p_message, p_ticker, p_email);
  end loop;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_notify_students(p_type text, p_message text, p_ticker text default null,
                                                      p_skip_holders_of text default null)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_notify_students(p_type, p_message, p_ticker, p_skip_holders_of, true);
end;
$body$;
$fn$;

  -- ── 2. the session event, for a person or the schedule ──
  execute $fn$
create or replace function public.jex_ev_session(p_by text, p_old text, p_new text, p_old_practice boolean,
                                                 p_new_practice boolean, p_started bigint, p_email boolean)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text; v_desc text; v_mins numeric; v_plural text; v_id text; v_role text; v_msg text;
begin
  select name into v_name from jex_users where id = p_by;
  if p_new is distinct from p_old and p_new in ('open', 'paused', 'closed') then
    -- A person: "Session open by Chair". The schedule or a timer: "Session
    -- opened on schedule".
    v_desc := case when p_by is null
                   then 'Session ' || case p_new when 'open' then 'opened' else p_new end || ' on schedule'
                   else 'Session ' || p_new || coalesce(' by ' || v_name, '') end;
    if p_new = 'closed' and p_old = 'open' and p_started is not null then
      v_mins := round((extract(epoch from clock_timestamp()) * 1000 - p_started) / 60000);
      v_plural := case when v_mins <> 1 then 's' else '' end;
      if v_mins between 0 and 1440 then
        v_desc := v_desc || ' — ran for ' || v_mins || ' minute' || v_plural;
      end if;
    end if;
    perform jex_log('session', v_desc, null, p_by, v_name, null);
    if p_new in ('open', 'closed') then
      v_msg := case when p_new = 'open' then '🟢 Trading session is now open!' else '🔴 Trading session has closed.' end;
      perform jex_notify_students('session', v_msg, null, null, p_email);
      for v_id, v_role in select id, role from jex_users
                           where role in ('secretary', 'treasurer', 'compliance_officer') order by id loop
        v_msg := case when p_new = 'open' then
                   case v_role when 'secretary' then '📋 Session opened — post any meeting minutes or official notices now.'
                               when 'treasurer' then '💰 Session opened — monitor company cash levels and dividend activity.'
                               else '🔍 Session opened — watch for unusual trading patterns or price anomalies.' end
                 else
                   case v_role when 'secretary' then '📋 Session closed — prepare and post meeting minutes for today''s session.'
                               when 'treasurer' then '📊 Session closed — review the cash flow report and check for budget warnings.'
                               else '🔍 Session closed — review the activity log for any suspicious patterns.' end
                 end;
        perform jex_notify(v_id, 'session', v_msg, null, p_email);
      end loop;
    end if;
  end if;
  if coalesce(p_new_practice, false) is distinct from coalesce(p_old_practice, false) then
    v_msg := case when p_new_practice then '🎮 Practice mode started — trades do not count toward rankings.'
                  else '✅ Practice mode ended — real trading resumes.' end;
    perform jex_notify_students('session', v_msg, null, null, p_email);
  end if;
exception when others then raise warning 'session event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_session(p_by text, p_old text, p_new text, p_old_practice boolean,
                                                 p_new_practice boolean, p_started bigint)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_ev_session(p_by, p_old, p_new, p_old_practice, p_new_practice, p_started, true);
end;
$body$;
$fn$;

  -- The scheduler's change. The orders move as part of the change -- if that
  -- fails, the tick fails and the next one retries -- and only telling people
  -- is best-effort.
  execute $fn$
create or replace function public.jex_ev_session_tick(p_old text, p_started bigint)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_new text; v_rows jsonb;
begin
  select status into v_new from jex_session where id = 1;
  if v_new = 'open' and p_old is distinct from 'open' then
    with done as (update jex_limit_orders set status = 'open' where status = 'after_hours'
                  returning id, user_id, ticker, qty, limit_price, side)
    select coalesce(jsonb_agg(to_jsonb(done.*)), '[]'::jsonb) into v_rows from done;
    begin
      perform jex_ev_after_hours_active(v_rows);
      perform jex_ev_session(null, p_old, v_new, null, null, null, false);
    exception when others then raise warning 'scheduled open not recorded: %', sqlerrm;
    end;
  elsif v_new = 'closed' and p_old = 'open' then
    with done as (update jex_limit_orders set status = 'expired' where status = 'open' and order_type = 'day'
                  returning id, user_id, ticker, qty, limit_price, side)
    select coalesce(jsonb_agg(to_jsonb(done.*)), '[]'::jsonb) into v_rows from done;
    begin
      perform jex_ev_day_orders_expired(v_rows);
      perform jex_ev_session(null, p_old, v_new, null, null, p_started, false);
    exception when others then raise warning 'scheduled close not recorded: %', sqlerrm;
    end;
  end if;
end;
$body$;
$fn$;

  execute 'revoke execute on function public.jex_notify(text,text,text,text,boolean),
    public.jex_notify_students(text,text,text,text,boolean),
    public.jex_ev_session(text,text,text,boolean,boolean,bigint,boolean),
    public.jex_ev_session_tick(text,bigint)
    from public, anon, authenticated';

  -- ── 3. the edits ──
  for r in select distinct x.fn, x.done from jsonb_to_recordset(v_plan) as x(seq int, fn text, md5 text, done text, anchor text, ins text, pos text) order by x.fn loop
    select p.prosrc, pg_get_functiondef(p.oid) into v_src, v_i
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn;
    if position(r.done in v_src) > 0 then
      raise notice '% is already updated -- skipped.', r.fn;
      continue;
    end if;
    v_nl := case when position(chr(13) in v_src) > 0 then chr(13) || chr(10) else chr(10) end;
    v_new := v_src;
    for e in select * from jsonb_to_recordset(v_plan) as x(seq int, fn text, md5 text, done text, anchor text, ins text, pos text) where x.fn = r.fn order by x.seq loop
      v_a := replace(e.anchor, '{nl}', v_nl);
      v_ins := replace(e.ins, '{nl}', v_nl);
      v_new := case e.pos when 'before' then replace(v_new, v_a, v_ins || v_nl || v_a)
                          when 'after' then replace(v_new, v_a, v_a || v_nl || v_ins)
                          else replace(v_new, v_a, v_ins) end;
    end loop;
    execute replace(v_i, v_src, v_new);
    v_patched := v_patched + 1;
  end loop;

  -- ── 1. close the doors ──
  execute 'revoke execute on function public.rpc_log_activity(text,text,text,text,text,numeric),
    public.rpc_push_notification(text,text,text,text) from public, anon, authenticated';

  raise notice 'Batch 4: % of 2 functions updated; the web can no longer write the log or notifications.', v_patched;
end
$mig$;

-- ── verification ──
--
-- doors_closed         who can still call the two general-purpose writers.
--                      Should be {"rpc_log_activity": [], "rpc_push_notification": []}.
-- scheduler_finishes   the scheduler turns after-hours orders live and
--                      expires day orders itself. Should be true.
-- open_tells_owners    a manual open tells after-hours owners. Should be true.
-- helpers_internal     anon and authenticated can call none of the helpers.
--                      Should be empty.
-- still_calling_old    any function that still calls the two old writers.
--                      Should be empty.
select
  (select jsonb_object_agg(p.proname, (select coalesce(jsonb_agg(r.rolname order by r.rolname), '[]'::jsonb)
                                          from pg_roles r where r.rolname in ('public','anon','authenticated')
                                            and has_function_privilege(r.rolname, p.oid, 'execute')))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('rpc_log_activity','rpc_push_notification'))   as doors_closed,
  (select position('jex_ev_session_tick' in prosrc) > 0 from pg_proc where proname = 'rpc_session_tick')
                                                                                 as scheduler_finishes,
  (select position('jex_ev_after_hours_active' in prosrc) > 0 from pg_proc where proname = 'rpc_admin_save_session')
                                                                                 as open_tells_owners,
  (select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'jex\_ev\_%'
          or p.proname in ('jex_log','jex_notify','jex_notify_holders','jex_notify_students','jex_fmt','jex_company_of'))
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')))          as helpers_internal,
  (select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc ~ '\m(rpc_log_activity|rpc_push_notification)\s*\('
      and p.proname not in ('rpc_log_activity','rpc_push_notification'))         as still_calling_old;
