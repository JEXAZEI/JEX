-- ============================================================
-- server_events_batch2.sql
--
-- Server-recorded events, batch 2 of 4 (see SERVER_EVENTS_PLAN.md): the
-- fifteen officer and market-control functions now write their own
-- activity-log entries and notifications, in the same transaction as the
-- action, from what they actually did. Requires server_events_batch1.sql
-- (it reuses jex_log, jex_notify, jex_notify_holders and jex_fmt).
--
-- Until now the browser that clicked the button wrote them afterwards -- and
-- for the circuit breaker, whichever student's browser noticed the move did,
-- sending one notification per student through a limit meant for one person.
--
-- ── What changes ──
--
--   session open / pause / close   logged, everyone told, officers given
--                                  their role's to-do -- once, when the status
--                                  really changes, however it was changed
--   practice mode on / off         everyone told
--   halt / resume                  logged, holders and everyone else told
--   delist (admin or reviewed)     logged, holders, cancelled orders and paid
--                                  shareholders told
--   relist                         the company told it can reapply
--   IPO approve / reject           logged, the applicant told
--   share class approve / remove   logged
--   registration approval          logged
--   snapshot restore               logged
--   minutes                        logged, everyone told
--   announcement                   logged
--   flag resolve                   logged
--   day orders expiring at close   each owner told
--
-- ── Short-squeeze alert ──
--
-- Was decided in each open browser, deduplicated per browser, so every open
-- tab could send its own copy to every student -- as a "halt", which emails.
-- Now rpc_check_short_squeeze(ticker) re-checks the condition on the
-- server's own data (price up more than 10% on the session open, short
-- interest of 15% or more -- students' and funds' shorts) and claims the
-- alert for that company for the day, so it is sent once. Its own type,
-- 'squeeze', which is not emailed. Adds jex_companies.squeeze_alert_date.
--
-- ── Safety ──
--
-- Refuses to run, changing nothing, unless every one of the fifteen is
-- byte-for-byte the production version this was written and tested against,
-- and every edit's anchor occurs exactly once. Safe to run twice. Recording
-- is best-effort: a failure is a WARNING and never undoes the action.
-- ============================================================

do $mig$
declare
  r record;
  e record;
  v_plan jsonb;
  v_src text; v_fp text; v_new text; v_nl text; v_a text; v_i text;
  v_n int;
  v_patched int := 0;
begin
  -- The edits: function, its production fingerprint, the text to find (with
  -- its indentation; {nl} is the function's own line ending), the line to
  -- add, and whether it goes before or after. Held here, inside the block,
  -- because the SQL editor does not promise separate statements share a
  -- connection -- a temporary table made by one was gone for the next.
  select jsonb_agg(to_jsonb(p) order by p.seq) into v_plan
    from (values
 (1, 'rpc_admin_save_session', 'a46cb0851b5b36e7b1b71162f0e2a7d6',
  '  v_session record;', '  v_was jex_session%rowtype;', 'after'),
   (2, 'rpc_admin_save_session', 'a46cb0851b5b36e7b1b71162f0e2a7d6',
  '  update jex_session set', '  select * into v_was from jex_session where id = 1 for update;', 'before'),
   (3, 'rpc_admin_save_session', 'a46cb0851b5b36e7b1b71162f0e2a7d6',
  '  return jsonb_build_object(''session'', to_jsonb(v_session));',
  '  perform jex_ev_session(v_uid, v_was.status, v_session.status, v_was.practice_mode, v_session.practice_mode, v_was.session_started_at);', 'before'),
   (4, 'rpc_expire_day_orders', '987cee18fe3c791b4fc4d5fa908c38c1',
  '  return jsonb_build_object(''expired'', v_ids);', '  perform jex_ev_day_orders_expired(v_ids);', 'before'),
   (5, 'rpc_admin_halt_stock', '9ffdde5af93c78a9afc8fc82dd324df6',
  '  return jsonb_build_object(''halt'', v_row,', '  perform jex_ev_halt(p_ticker, v_reason, v_halted_by, v_uid, p_system_triggered);', 'before'),
   (6, 'rpc_admin_resume_stock', '808ff8190dae60932a62733d80c4581c',
  '  return jsonb_build_object(''resumed'', true,', '  perform jex_ev_resume(p_ticker, v_uid, p_system_triggered);', 'before'),
   (7, 'rpc_admin_delist_company', '55647c94db778a8b2a89995fa1ddf7ca',
  '  return jsonb_build_object(''delisted'', true,', '  perform jex_ev_delist(p_ticker, v_cancelled_orders);', 'before'),
   (8, 'rpc_admin_relist_company', '550ad00fed6d5dfcb3155d40df98a66f',
  '  return jsonb_build_object(''shares_avail'',', '  perform jex_ev_relist(p_ticker, v_co.owner_id, v_co.name);', 'before'),
   (9, 'rpc_review_delisting', '95244c26ac11d556c01fc8270d5fea4d',
  '  return jsonb_build_object({nl}    ''approved'', true,',
  '  perform jex_ev_delisting_settled(v_app.ticker, v_app.kind, v_price, v_payouts, v_cancelled_orders);', 'before'),
   (10, 'rpc_review_ipo', 'ef6e57bb2f99e693978ec2d74de63a10',
  '    return jsonb_build_object(''approved'', true, ''company'', v_co,',
  '    perform jex_ev_ipo(true, v_app.user_id, v_app.name, v_app.ticker, v_app.price);', 'before'),
   (11, 'rpc_review_ipo', 'ef6e57bb2f99e693978ec2d74de63a10',
  '    return jsonb_build_object(''approved'', false, ''user_id'', v_app.user_id,',
  '    perform jex_ev_ipo(false, v_app.user_id, v_app.name, v_app.ticker, v_app.price);', 'before'),
   (12, 'rpc_review_class_application', '6afdba4564a6de15c10e331c2e7a6111',
  '      return jsonb_build_object(''approved'', true, ''is_conversion'', true,',
  '      perform jex_ev_class_approved(v_app.company_name, v_app.proposed_ticker, v_app.class, true);', 'before'),
   (13, 'rpc_review_class_application', '6afdba4564a6de15c10e331c2e7a6111',
  '      return jsonb_build_object(''approved'', true, ''is_conversion'', false,',
  '      perform jex_ev_class_approved(v_app.company_name, v_app.proposed_ticker, v_app.class, false);', 'before'),
   (14, 'rpc_admin_remove_share_class', 'e7d0dd0f9095ebf409d4e8947c48d7be',
  '  return jsonb_build_object(''removed'', true,',
  '  perform jex_ev_class_removed(p_ticker, v_is_conversion, v_meta.class, v_meta.company_name);', 'before'),
   (15, 'approve_registration', '23360fd00ea284218a7e4812f225f362',
  '  return jsonb_build_object(', '  perform jex_ev_registration(v_user.id, v_user.name, v_user.role, p_starting_cash);', 'before'),
   (16, 'rpc_admin_restore_snapshot', '8701746e9d0e9b653e29e76e7a95db94',
  '  return jsonb_build_object(''restored_users'',', '  perform jex_ev_snapshot_restored(v_uid, v_snap.label);', 'before'),
   (17, 'rpc_post_minutes', '9320caac984d16568250e6e612b205e3',
  '  return v_row;', '  perform jex_ev_minutes(v_uid, v_name, v_row->>''title'');', 'before'),
   (18, 'rpc_post_announcement', '6762cb14191428af93a843bb5f8b6ece',
  '  return v_row;', '  perform jex_ev_announcement(v_uid, v_name, v_row->>''title'');', 'before'),
   (19, 'rpc_admin_resolve_flag', 'ef2c36ae735f9a49f5c06f4de5df07e8',
  '  return jsonb_build_object(''resolved'', true);', '  perform jex_ev_flag_resolved(p_flag_id, p_action, p_note, v_uid, v_name);', 'before')
    ) as p(seq, fn, md5, anchor, ins, pos);

  -- ── 1. batch 1 is in, and every function is done or exactly as expected ──
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'jex_log') then
    raise exception 'ABORT: run server_events_batch1.sql first. Nothing changed.';
  end if;
  for r in select distinct x.fn, x.md5 from jsonb_to_recordset(v_plan) as x(seq int, fn text, md5 text, anchor text, ins text, pos text) loop
    v_src := null; v_fp := null;
    select p.prosrc, md5(replace(p.prosrc, chr(13), '')) into v_src, v_fp
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn;
    if v_src is null then raise exception 'ABORT: % not found. Nothing changed.', r.fn; end if;
    if position('jex_ev_' in v_src) > 0 then continue; end if;
    if v_fp <> r.md5 then
      raise exception 'ABORT: % is not the version this was written against (md5 %). Nothing changed -- paste this error back.', r.fn, v_fp;
    end if;
    v_nl := case when position(chr(13) in v_src) > 0 then chr(13) || chr(10) else chr(10) end;
    for e in select * from jsonb_to_recordset(v_plan) as x(seq int, fn text, md5 text, anchor text, ins text, pos text) where x.fn = r.fn order by x.seq loop
      v_a := replace(e.anchor, '{nl}', v_nl);
      v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
      if v_n <> 1 then
        raise exception 'ABORT: expected edit % anchor exactly once in %, found %. Nothing changed.', e.seq, r.fn, v_n;
      end if;
    end loop;
  end loop;

  -- ── 2. the short-squeeze claim ──
  execute 'alter table public.jex_companies add column if not exists squeeze_alert_date date';

  -- ── 3. helpers and one function per event, holding its wording ──
  execute $fn$
create or replace function public.jex_notify_students(p_type text, p_message text, p_ticker text default null,
                                                      p_skip_holders_of text default null)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_id text;
begin
  -- The page's pushNotificationToAll: every approved student, optionally
  -- skipping those who hold a ticker (they were told separately).
  for v_id in select id from jex_users
               where role = 'student' and status = 'approved'
                 and (p_skip_holders_of is null or coalesce((holdings->>p_skip_holders_of)::numeric, 0) <= 0)
               order by id loop
    perform jex_notify(v_id, p_type, p_message, p_ticker);
  end loop;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_session(p_by text, p_old text, p_new text, p_old_practice boolean,
                                                 p_new_practice boolean, p_started bigint)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text; v_desc text; v_mins numeric; v_plural text; v_id text; v_role text; v_msg text;
begin
  select name into v_name from jex_users where id = p_by;
  -- Only a real change: saving the settings of an open session is not a
  -- second opening.
  if p_new is distinct from p_old and p_new in ('open', 'paused', 'closed') then
    v_desc := 'Session ' || p_new || coalesce(' by ' || v_name, '');
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
      perform jex_notify_students('session', v_msg);
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
        perform jex_notify(v_id, 'session', v_msg);
      end loop;
    end if;
  end if;
  if coalesce(p_new_practice, false) is distinct from coalesce(p_old_practice, false) then
    v_msg := case when p_new_practice then '🎮 Practice mode started — trades do not count toward rankings.'
                  else '✅ Practice mode ended — real trading resumes.' end;
    perform jex_notify_students('session', v_msg);
  end if;
exception when others then raise warning 'session event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_day_orders_expired(p_orders jsonb)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare o jsonb;
begin
  for o in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) loop
    perform jex_notify(o->>'user_id', 'limit_fill',
      '📋 Day order expired at session close: ' || (o->>'qty') || '×' || (o->>'ticker') || ' @ ' || jex_fmt((o->>'limit_price')::numeric),
      o->>'ticker');
  end loop;
exception when others then raise warning 'day order expiry not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_halt(p_ticker text, p_reason text, p_halted_by text, p_by text, p_system boolean)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_by text := case when p_system then null else p_by end;
begin
  -- A circuit-breaker halt is the exchange's, not whichever browser noticed.
  perform jex_log('halt', p_ticker || ' trading halted — ' || p_reason, p_ticker, v_by, p_halted_by, null);
  perform jex_notify_holders(p_ticker, 'halt', '⚠️ Trading halted on ' || p_ticker || ': ' || p_reason);
  perform jex_notify_students('halt', '⚠️ ' || p_ticker || ' trading has been halted: ' || p_reason, null, p_ticker);
exception when others then raise warning 'halt event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_resume(p_ticker text, p_by text, p_system boolean)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text;
begin
  if p_system then
    perform jex_log('resume', p_ticker || ' trading resumed', p_ticker, null, 'System (Circuit Breaker)', null);
  else
    select name into v_name from jex_users where id = p_by;
    perform jex_log('resume', p_ticker || ' trading resumed', p_ticker, p_by, v_name, null);
  end if;
  perform jex_notify_students('resume', '✅ ' || p_ticker || ' trading has resumed');
exception when others then raise warning 'resume event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_delist(p_ticker text, p_orders jsonb)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_co text; o jsonb;
begin
  select name into v_co from jex_companies where ticker = p_ticker;
  for o in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) loop
    perform jex_notify(o->>'user_id', 'halt', '📋 Limit order cancelled — ' || p_ticker || ' has been delisted.', p_ticker);
  end loop;
  perform jex_notify_holders(p_ticker, 'halt', '⚠️ ' || v_co || ' (' || p_ticker || ') has been delisted from JEX.');
  perform jex_log('ipo', v_co || ' (' || p_ticker || ') delisted', p_ticker, null, null, null);
exception when others then raise warning 'delist event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_relist(p_ticker text, p_owner text, p_name text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_notify(p_owner, 'ipo',
    '🔄 Your company ' || p_name || ' has been reset — you can now submit a new IPO application.', p_ticker);
exception when others then raise warning 'relist event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_delisting_settled(p_ticker text, p_kind text, p_price numeric, p_payouts jsonb, p_orders jsonb)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare o jsonb; v_q numeric;
begin
  for o in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) loop
    perform jex_notify(o->>'user_id', 'halt', '📋 Limit order cancelled — ' || p_ticker || ' has been delisted.', p_ticker);
  end loop;
  -- Students only: a fund's payout row carries no id.
  for o in select * from jsonb_array_elements(coalesce(p_payouts, '[]'::jsonb)) loop
    continue when o->>'id' is null;
    v_q := (o->>'qty')::numeric;
    perform jex_notify(o->>'id', 'halt',
      '💵 ' || p_ticker || ' delisted — you were paid ' || jex_fmt((o->>'paid')::numeric) || ' for ' || trim_scale(v_q)::text
        || ' share' || case when v_q = 1 then '' else 's' end || '.', p_ticker);
  end loop;
  perform jex_log('ipo',
    p_ticker || ' delisted — ' || case p_kind when 'going_private' then 'Going private' when 'bankruptcy' then 'Bankruptcy' else coalesce(p_kind, '') end
      || ' at ' || jex_fmt(p_price) || ' per share', p_ticker, null, null, null);
exception when others then raise warning 'delisting event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_ipo(p_approved boolean, p_user text, p_name text, p_ticker text, p_price numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  if p_approved then
    perform jex_log('ipo', p_name || ' (' || p_ticker || ') listed on JEX @ ' || jex_fmt(p_price), p_ticker, p_user, null, p_price);
    perform jex_notify(p_user, 'ipo', '🎉 Your IPO has been approved! ' || p_name || ' (' || p_ticker || ') is now listed on JEX.', p_ticker);
  else
    perform jex_notify(p_user, 'ipo', '❌ Your IPO application for ' || p_name || ' was rejected.');
  end if;
exception when others then raise warning 'ipo event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_class_approved(p_company text, p_ticker text, p_class text, p_conversion boolean)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_log('class_approved',
    case when p_conversion then p_company || ' ' || p_ticker || ' converted to Class ' || p_class
         else p_company || ' Class ' || p_class || ' (' || p_ticker || ') listed' end,
    p_ticker, null, null, null);
exception when others then raise warning 'class approval event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_class_removed(p_ticker text, p_conversion boolean, p_class text, p_company text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_log('class_removed',
    case when p_conversion then 'Class ' || p_class || ' stripped from' else 'Share class ' || p_ticker || ' removed from' end
      || ' ' || coalesce(p_company, ''),
    p_ticker, null, null, null);
exception when others then raise warning 'class removal event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_registration(p_user text, p_name text, p_role text, p_cash numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_log('registration', p_name || ' approved (' || p_role || ') with ' || jex_fmt(p_cash), null, p_user, p_name, p_cash);
exception when others then raise warning 'registration event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_snapshot_restored(p_by text, p_label text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text;
begin
  select name into v_name from jex_users where id = p_by;
  perform jex_log('snapshot', 'Snapshot restored: ' || coalesce(p_label, ''), null, p_by, v_name, null);
exception when others then raise warning 'snapshot event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_minutes(p_by text, p_name text, p_title text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_log('minutes', 'Meeting minutes posted: ' || p_title, null, p_by, p_name, null);
  perform jex_notify_students('minutes', '📋 New meeting minutes posted: ' || p_title);
exception when others then raise warning 'minutes event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_announcement(p_by text, p_name text, p_title text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_log('announcement', 'Announcement posted: ' || p_title, null, p_by, p_name, null);
exception when others then raise warning 'announcement event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_flag_resolved(p_flag text, p_action text, p_note text, p_by text, p_name text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_target text;
begin
  select target_name into v_target from jex_flags where id = p_flag;
  perform jex_log('flag_resolve',
    p_name || ' ' || case when p_action = 'resolved' then 'resolved' else 'dismissed' end || ' flag on ' || coalesce(v_target, '')
      || case when coalesce(p_note, '') <> '' then ' — ' || p_note else '' end,
    null, p_by, p_name, null);
exception when others then raise warning 'flag event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_squeeze(p_ticker text, p_name text, p_chg numeric, p_short numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  -- Its own type, not 'halt': nothing was halted, and it is not emailed.
  perform jex_notify_students('squeeze',
    '🔥 Short squeeze alert: ' || p_name || ' (' || p_ticker || ') is up ' || round(p_chg * 100) || '% with '
      || round(p_short * 100) || '% short interest. Short sellers may be forced to cover.');
exception when others then raise warning 'squeeze alert not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.rpc_check_short_squeeze(p_ticker text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $body$
declare
  v_uid text; v_co record; v_open numeric; v_first numeric; v_last numeric;
  v_chg numeric; v_short numeric; v_pct numeric;
  v_today date := (now() at time zone 'America/Phoenix')::date;
begin
  select id into v_uid from jex_users where auth_uid = auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if (select status from jex_session where id = 1) is distinct from 'open' then
    return jsonb_build_object('sent', false, 'reason', 'session_not_open');
  end if;
  select * into v_co from jex_companies where ticker = p_ticker;
  if not found or v_co.status <> 'listed' or coalesce(v_co.is_index_fund, false) or coalesce(v_co.shares, 0) <= 0 then
    return jsonb_build_object('sent', false, 'reason', 'not_listed');
  end if;
  if v_co.squeeze_alert_date = v_today then
    return jsonb_build_object('sent', false, 'reason', 'already_sent');
  end if;

  -- Short interest: every open short, students' and funds'.
  select coalesce((select sum(coalesce((shorts->p_ticker->>'qty')::numeric, 0)) from jex_users where role = 'student'), 0)
       + coalesce((select sum(coalesce((shorts->p_ticker->>'qty')::numeric, 0)) from jex_funds), 0)
    into v_short;
  v_pct := v_short / v_co.shares;

  -- The page's "today": against the session open, or the whole history
  -- when there is no open recorded.
  select (session_open_prices->>p_ticker)::numeric into v_open from jex_session where id = 1;
  if coalesce(v_open, 0) > 0 then
    v_chg := (v_co.price - v_open) / v_open;
  elsif jsonb_array_length(coalesce(v_co.price_history, '[]'::jsonb)) >= 2 then
    v_first := (v_co.price_history->0->>'p')::numeric;
    v_last := (v_co.price_history->-1->>'p')::numeric;
    v_chg := case when coalesce(v_first, 0) > 0 then (v_last - v_first) / v_first else 0 end;
  else
    v_chg := 0;
  end if;
  if v_pct < 0.15 or v_chg <= 0.10 then
    return jsonb_build_object('sent', false, 'reason', 'not_crossed');
  end if;

  -- Once per company per Arizona day, however many browsers ask at once.
  update jex_companies set squeeze_alert_date = v_today
   where ticker = p_ticker and squeeze_alert_date is distinct from v_today;
  if not found then return jsonb_build_object('sent', false, 'reason', 'already_sent'); end if;
  perform jex_ev_squeeze(p_ticker, v_co.name, v_chg, v_pct);
  return jsonb_build_object('sent', true);
end;
$body$;
$fn$;

  -- Internal only (Supabase grants execute on new functions to anon and
  -- authenticated by default). The squeeze check is for signed-in users.
  execute 'revoke execute on function public.jex_notify_students(text,text,text,text),
    public.jex_ev_session(text,text,text,boolean,boolean,bigint), public.jex_ev_day_orders_expired(jsonb),
    public.jex_ev_halt(text,text,text,text,boolean), public.jex_ev_resume(text,text,boolean),
    public.jex_ev_delist(text,jsonb), public.jex_ev_relist(text,text,text),
    public.jex_ev_delisting_settled(text,text,numeric,jsonb,jsonb), public.jex_ev_ipo(boolean,text,text,text,numeric),
    public.jex_ev_class_approved(text,text,text,boolean), public.jex_ev_class_removed(text,boolean,text,text),
    public.jex_ev_registration(text,text,text,numeric), public.jex_ev_snapshot_restored(text,text),
    public.jex_ev_minutes(text,text,text), public.jex_ev_announcement(text,text,text),
    public.jex_ev_flag_resolved(text,text,text,text,text), public.jex_ev_squeeze(text,text,numeric,numeric)
    from public, anon, authenticated';
  execute 'revoke execute on function public.rpc_check_short_squeeze(text) from public, anon';
  execute 'grant execute on function public.rpc_check_short_squeeze(text) to authenticated';

  -- ── 4. the edits ──
  for r in select distinct x.fn from jsonb_to_recordset(v_plan) as x(seq int, fn text, md5 text, anchor text, ins text, pos text) order by x.fn loop
    select p.prosrc, pg_get_functiondef(p.oid) into v_src, v_i
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn;
    if position('jex_ev_' in v_src) > 0 then
      raise notice '% already records its events -- skipped.', r.fn;
      continue;
    end if;
    v_nl := case when position(chr(13) in v_src) > 0 then chr(13) || chr(10) else chr(10) end;
    v_new := v_src;
    for e in select * from jsonb_to_recordset(v_plan) as x(seq int, fn text, md5 text, anchor text, ins text, pos text) where x.fn = r.fn order by x.seq loop
      v_a := replace(e.anchor, '{nl}', v_nl);
      if e.pos = 'before' then
        v_new := replace(v_new, v_a, e.ins || v_nl || v_a);
      else
        v_new := replace(v_new, v_a, v_a || v_nl || e.ins);
      end if;
    end loop;
    execute replace(v_i, v_src, v_new);
    v_patched := v_patched + 1;
  end loop;

  raise notice 'Batch 2: % of 15 functions now record their own events.', v_patched;
end
$mig$;


-- ── verification ──
--
-- recording            the fifteen, each true once it records its own events
-- server_events        what the page will be told: batch 1's eleven, these
--                      fifteen and rpc_check_short_squeeze -- 27 in all
-- helpers_internal     anon and authenticated can call none of the helpers.
--                      Should be empty.
-- squeeze_check        signed-in users can ask, signed-out visitors cannot
-- server_entries_since entries the server itself has written so far
select
  (select jsonb_object_agg(p.proname, position('jex_ev_' in p.prosrc) > 0 order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('rpc_admin_save_session','rpc_expire_day_orders','rpc_admin_halt_stock',
                        'rpc_admin_resume_stock','rpc_admin_delist_company','rpc_admin_relist_company',
                        'rpc_review_delisting','rpc_review_ipo','rpc_review_class_application',
                        'rpc_admin_remove_share_class','approve_registration','rpc_admin_restore_snapshot',
                        'rpc_post_minutes','rpc_post_announcement','rpc_admin_resolve_flag'))  as recording,
  (select jsonb_array_length(to_jsonb(rpc_server_events())))                    as server_events,
  (select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'jex\_ev\_%'
          or p.proname in ('jex_log','jex_notify','jex_notify_holders','jex_notify_students','jex_fmt'))
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')))          as helpers_internal,
  (select jsonb_build_object(
     'signed_in', has_function_privilege('authenticated', 'public.rpc_check_short_squeeze(text)', 'execute'),
     'signed_out', has_function_privilege('anon', 'public.rpc_check_short_squeeze(text)', 'execute')))
                                                                                 as squeeze_check,
  (select count(*) from jex_activity where logged_by = 'server')                 as server_entries_since;
