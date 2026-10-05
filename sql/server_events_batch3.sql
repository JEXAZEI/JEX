-- ============================================================
-- server_events_batch3.sql
--
-- Server-recorded events, batch 3 of 4 (see SERVER_EVENTS_PLAN.md): the
-- company and student actions -- the last ones the page still logged or
-- notified about itself. Requires batches 1 and 2.
--
--   votes posted / closed         logged, holders / voters told
--   news                          holders told when the author ticks "Notify
--                                 all shareholders" -- rpc_notify_news_holders,
--                                 the author only, within 10 minutes, once
--   financials                    logged, holders told
--   founder invites, answers,     the other side told, joins and removals
--   removals                      logged
--   founder share requests,       logged, the student told
--   grants and refusals
--   share-class applications      logged
--   delisting applications        logged, holders told
--   dividend approval requests    the Treasurer told; a refusal tells the
--                                 company
--   account flags, bug reports    logged, the Chairman and President told
--   funds created                 logged
--   limit orders placed           logged
--   price alerts                  the owner told
--   after-hours orders            each owner told when theirs goes live
--
-- After this, nothing the page does needs it to write a log entry or a
-- notification. Batch 4 takes that ability away.
--
-- Refuses to run, changing nothing, unless every function is byte-for-byte
-- the production version this was written and tested against and every
-- edit's anchor occurs exactly once. Safe to run twice. Recording is
-- best-effort: a failure is a WARNING and never undoes the action.
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
  -- its indentation), the line to add, and whether it goes before or after.
  -- Held inside the block: the SQL editor does not promise separate
  -- statements share a connection.
  select jsonb_agg(to_jsonb(p) order by p.seq) into v_plan
    from (values
   (1, 'rpc_activate_after_hours_orders', 'd5f083087fc2207df4b21680d1c58d47',
    '  return jsonb_build_object(''activated'', v_rows);', '  perform jex_ev_after_hours_active(v_rows);', 'before'),
   (2, 'rpc_close_vote', 'a9a109e39ce298dcd2c3f0099b0b492b',
    '  return jsonb_build_object(''closed'', true);', '  perform jex_ev_vote_closed(p_vote_id);', 'before'),
   (3, 'rpc_create_fund', '8be5c36e333762a5581103e23ffe7d8d',
    '  return v_row;', '  perform jex_ev_fund_created(v_uid, v_name, v_row->>''name'', (v_row->>''fee_pct'')::numeric);', 'before'),
   (4, 'rpc_flag_account', 'b2bf97198f0e98f4b699b0d570158e07',
    '  return v_row;', '  perform jex_ev_flagged(v_uid, v_name, p_target_id, p_target_type, v_target_name, v_reason);', 'before'),
   (5, 'rpc_place_limit_order', '436dddeccdc36166291111e95e7a67ce',
    '  return jsonb_build_object(''order'', v_order, ''status'', ''open'');',
    '  perform jex_ev_limit_order(v_uid, p_fund_id, p_side, p_qty, p_ticker, p_limit_price);', 'before'),
   (6, 'rpc_post_financials', '3a8190ce9b608574c51c236efc26b7b8',
    '  return jsonb_build_object(''financials'', v_financials, ''entry'', v_entry);',
    '  perform jex_ev_financials(p_ticker, v_co.name, v_entry->>''period'', p_revenue, p_profit);', 'before'),
   (7, 'rpc_post_vote', 'd7d78bac966f7884acaec2ba87115c77',
    '  return v_row;', '  perform jex_ev_vote_posted(v_uid, v_co.name, p_ticker, v_row->>''question'');', 'before'),
   (8, 'rpc_reject_dividend_approval', '7b5cd3163ef9c784f6aff131b15d2caf',
    '  return jsonb_build_object(''rejected'', true);', '  perform jex_ev_div_rejected(p_id);', 'before'),
   (9, 'rpc_remove_founder', '8c6f73a4cba7d95d972c75e381ec07db',
    '  return jsonb_build_object(''removed'', true,', '  perform jex_ev_founder_removed(v_uid, v_member.student_id, v_member.company_user_id);', 'before'),
   (10, 'rpc_request_delisting', '50abba746601a31b30dbc056c9c0b6c1',
    '  return v_row;', '  perform jex_ev_delist_requested(p_ticker, v_co.name, p_kind, v_reason);', 'before'),
   (11, 'rpc_request_dividend_approval', '1c273947612124eb9e083905f2c9df5c',
    '  return v_row;', '  perform jex_ev_div_requested(p_ticker, v_co.name, v_total, p_per_share);', 'before'),
   (12, 'rpc_request_founder_allocation', '459eaa262f7683c4ed8df50886cb5ba5',
    '  return v_row;', '  perform jex_ev_alloc_requested(p_ticker, v_company_name, p_shares, v_student.name);', 'before'),
   (13, 'rpc_respond_to_invite', '0aeaac2d5a90d91c54be0b1ff43773f6',
    '  return jsonb_build_object(''status'',', '  perform jex_ev_invite_answered(v_uid, v_member.company_user_id, p_accept);', 'before'),
   (14, 'rpc_review_founder_allocation', '5e7f78f04dfdd9c775b7d82c9a47eba8',
    '    return jsonb_build_object(''approved'', false);',
    '    perform jex_ev_alloc_reviewed(false, v_alloc.student_id, v_alloc.student_name, v_alloc.shares, v_alloc.company_name, v_alloc.ticker);', 'before'),
   (15, 'rpc_review_founder_allocation', '5e7f78f04dfdd9c775b7d82c9a47eba8',
    '  return jsonb_build_object(''approved'', true, ''holdings'',',
    '  perform jex_ev_alloc_reviewed(true, v_alloc.student_id, v_alloc.student_name, v_alloc.shares, v_alloc.company_name, v_alloc.ticker);', 'before'),
   (16, 'rpc_send_founder_invite', 'c0080b298f14e68086ec69c8d23d119e',
    '  return v_row;', '  perform jex_ev_invite_sent(v_caller_id, p_student_id, p_owner_id);', 'before'),
   (17, 'rpc_submit_bug_report', '2d35840c1503326c5a55b57143cccb49',
    '  return v_row;', '  perform jex_ev_bug_report(v_uid, v_name, v_desc);', 'before'),
   (18, 'rpc_submit_class_application', 'a411ccffa3c851555f77ec6a02538bf7',
    '  return v_row;', '  perform jex_ev_class_applied(v_uid, v_co.name, p_class, v_proposed, p_parent_ticker, coalesce(p_convert, false));', 'before'),
   (19, 'rpc_trigger_price_alert', '5a04b57ec64dab9e3d7a5e270476d5dd',
    '  return jsonb_build_object(''triggered'', true,',
    '  perform jex_ev_price_alert(v_alert.user_id, v_alert.ticker, v_alert.direction, v_alert.target_price, v_price);', 'before')
    ) as p(seq, fn, md5, anchor, ins, pos);

  -- ── 1. batches 1 and 2 are in, and every function is done or exactly as expected ──
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'jex_notify_students') then
    raise exception 'ABORT: run server_events_batch1.sql and server_events_batch2.sql first. Nothing changed.';
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

  -- ── 2. the news claim ──
  execute 'alter table public.jex_news add column if not exists holders_notified_at timestamptz';

  -- ── 3. one function per event, holding its wording ──

  -- The company a company account owns. An owner can own a share-class
  -- listing as well (ACME.B has the same owner as ACME), and picking by owner
  -- alone takes whichever row comes first -- "joined Acme Corp (Class B) as a
  -- founder". The base listing first, then the oldest.
  execute $fn$
create or replace function public.jex_company_of(p_owner text)
 returns jex_companies language sql stable security definer set search_path to 'public'
as $body$
  select c.* from jex_companies c
   where c.owner_id = p_owner
   order by exists (select 1 from jex_share_classes sc where sc.ticker = c.ticker and sc.ticker <> sc.parent_ticker),
            c.created_at, c.ticker
   limit 1;
$body$;
$fn$;
  execute $fn$
create or replace function public.jex_ev_after_hours_active(p_orders jsonb)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare o jsonb;
begin
  for o in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) loop
    perform jex_notify(o->>'user_id', 'after_hours',
      '⏰ Your after-hours ' || (o->>'side') || ' order for ' || (o->>'qty') || '×' || (o->>'ticker') || ' @ '
        || jex_fmt((o->>'limit_price')::numeric) || ' is now active', o->>'ticker');
  end loop;
exception when others then raise warning 'after-hours activation not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_vote_closed(p_vote text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v record; v_id text;
begin
  select * into v from jex_votes where id = p_vote;
  -- Everyone who voted, once each.
  for v_id in select distinct voter_id from jex_vote_ballots where vote_id = p_vote and voter_id is not null order by voter_id loop
    perform jex_notify(v_id, 'vote_closed', '🗳️ Vote closed: "' || v.question || '" — ' || v.company_name, v.parent_ticker);
  end loop;
exception when others then raise warning 'vote close not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_fund_created(p_by text, p_name text, p_fund text, p_fee numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_log('fund_create', p_name || ' launched a new fund: ' || p_fund || ' (' || trim_scale(p_fee)::text || '% performance fee)',
    null, p_by, p_name, null);
exception when others then raise warning 'fund creation not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_flagged(p_by text, p_name text, p_target text, p_type text, p_target_name text, p_reason text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_target text; v_id text;
begin
  -- A company is named as the company, as the page names it.
  v_target := case when p_type = 'company'
                   then coalesce((jex_company_of(p_target)).name, 'Unknown')
                   else coalesce(p_target_name, 'Unknown') end;
  for v_id in select id from jex_users where role in ('chairman', 'president') order by id loop
    perform jex_notify(v_id, 'flag', '🚩 Compliance flag: ' || v_target || ' (' || p_type || ') — ' || p_reason);
  end loop;
  perform jex_log('flag', '🚩 ' || p_name || ' flagged ' || v_target || ' (' || p_type || '): ' || p_reason, null, p_by, p_name, null);
exception when others then raise warning 'flag not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_limit_order(p_by text, p_fund text, p_side text, p_qty integer, p_ticker text, p_price numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text; v_who text;
begin
  select name into v_name from jex_users where id = p_by;
  v_who := case when p_fund is not null then coalesce((select name from jex_funds where id = p_fund), 'a fund') else v_name end;
  perform jex_log('limit_order', v_who || ' placed limit ' || p_side || ' ' || p_qty || '×' || p_ticker || ' @ ' || jex_fmt(p_price),
    p_ticker, p_by, v_name, p_price);
exception when others then raise warning 'limit order not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_financials(p_ticker text, p_co text, p_period text, p_revenue numeric, p_profit numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_notify_holders(p_ticker, 'financials',
    '📊 ' || p_co || ' (' || p_ticker || ') posted financial results for ' || p_period || ': Revenue ' || jex_fmt(p_revenue)
      || ', Profit ' || jex_fmt(p_profit));
  perform jex_log('financials', p_co || ' posted financials for ' || p_period || ' — Rev ' || jex_fmt(p_revenue) || ', Profit ' || jex_fmt(p_profit),
    p_ticker, null, null, p_revenue);
exception when others then raise warning 'financials not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_vote_posted(p_by text, p_co text, p_ticker text, p_question text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text;
begin
  select name into v_name from jex_users where id = p_by;
  perform jex_log('vote', p_co || ' posted vote: ' || p_question, p_ticker, p_by, v_name, null);
  perform jex_notify_holders(p_ticker, 'vote', '🗳️ ' || p_co || ' posted a vote: ' || p_question);
exception when others then raise warning 'vote not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_div_rejected(p_id text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare d record;
begin
  select * into d from jex_dividend_approvals where id = p_id;
  perform jex_notify(d.requested_by, 'div_approval',
    '❌ Your dividend request for ' || d.company_name || ' was rejected by the Treasurer.', d.ticker);
exception when others then raise warning 'dividend refusal not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_founder_removed(p_by text, p_student text, p_company_user text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_by_name text; v_student text; v_co jex_companies;
begin
  select name into v_by_name from jex_users where id = p_by;
  select name into v_student from jex_users where id = p_student;
  v_co := jex_company_of(p_company_user);
  perform jex_notify(p_student, 'invite', '❌ You have been removed as a founder of ' || v_co.name || '.', v_co.ticker);
  perform jex_log('cofound', coalesce(v_student, 'This founder') || ' removed as founder of ' || v_co.name, v_co.ticker, p_by, v_by_name, null);
exception when others then raise warning 'founder removal not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_delist_requested(p_ticker text, p_co text, p_kind text, p_reason text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_label text := case p_kind when 'going_private' then 'Going private' when 'bankruptcy' then 'Bankruptcy' else p_kind end;
begin
  -- Shareholders hear it the moment it is filed, not once trading stops.
  perform jex_notify_holders(p_ticker, 'halt',
    '📋 ' || p_co || ' (' || p_ticker || ') has applied to delist — ' || v_label || '. Reason: ' || p_reason);
  perform jex_log('ipo', p_co || ' (' || p_ticker || ') applied to delist (' || v_label || ')', p_ticker, null, null, null);
exception when others then raise warning 'delisting application not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_div_requested(p_ticker text, p_co text, p_total numeric, p_per_share numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_treasurer text;
begin
  -- The Treasurer the page asked: the first one.
  select id into v_treasurer from jex_users where role = 'treasurer' order by created_at, id limit 1;
  if v_treasurer is not null then
    perform jex_notify(v_treasurer, 'div_approval',
      '💰 Dividend approval needed: ' || p_co || ' wants to pay ' || jex_fmt(p_total) || ' total (' || jex_fmt(p_per_share) || '/share)', p_ticker);
  end if;
exception when others then raise warning 'dividend request not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_alloc_requested(p_ticker text, p_co text, p_shares integer, p_student text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_class text;
begin
  select 'Class ' || class into v_class from jex_share_classes where ticker = p_ticker;
  perform jex_log('founder_alloc', p_co || ' requested ' || p_shares || ' ' || coalesce(v_class, 'base') || ' founder shares for ' || p_student,
    p_ticker, null, null, null);
exception when others then raise warning 'founder share request not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_invite_answered(p_by text, p_company_user text, p_accept boolean)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text; v_co record;
begin
  select name into v_name from jex_users where id = p_by;
  v_co := jex_company_of(p_company_user);
  if v_co.ticker is null then return; end if;
  if p_accept then
    perform jex_log('cofound', v_name || ' joined ' || v_co.name || ' as a founder', v_co.ticker, p_by, v_name, null);
    perform jex_notify(p_company_user, 'invite',
      '✅ ' || v_name || ' accepted your founder invitation and has joined ' || v_co.name || '!', v_co.ticker);
  else
    perform jex_notify(p_company_user, 'invite',
      '❌ ' || v_name || ' declined your founder invitation for ' || v_co.name || '.', v_co.ticker);
  end if;
exception when others then raise warning 'invitation answer not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_alloc_reviewed(p_approved boolean, p_student text, p_student_name text, p_shares integer,
                                                        p_co text, p_ticker text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  if p_approved then
    perform jex_notify(p_student, 'founder_alloc',
      '🎁 ' || p_shares || ' founder shares of ' || p_co || ' (' || p_ticker || ') have been added to your portfolio!', p_ticker);
    perform jex_log('founder_alloc', p_student_name || ' granted ' || p_shares || ' founder shares of ' || p_co, p_ticker, null, null, p_shares);
  else
    perform jex_notify(p_student, 'founder_alloc',
      '❌ Your founder share request for ' || p_shares || '×' || p_ticker || ' in ' || p_co || ' was rejected.');
  end if;
exception when others then raise warning 'founder share review not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_invite_sent(p_by text, p_student text, p_owner text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text; v_co jex_companies;
begin
  select name into v_name from jex_users where id = p_by;
  v_co := jex_company_of(p_owner);
  perform jex_notify(p_student, 'invite',
    '🤝 ' || v_name || ' has invited you to join ' || v_co.name || ' as a founder. Accept or decline below.', v_co.ticker);
exception when others then raise warning 'invitation not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_bug_report(p_by text, p_name text, p_desc text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_id text;
begin
  for v_id in select id from jex_users where role in ('chairman', 'president') order by id loop
    perform jex_notify(v_id, 'bug_report', '🐛 Bug report from ' || p_name || ': ' || left(p_desc, 80));
  end loop;
  perform jex_log('bug_report', '🐛 ' || p_name || ' reported a bug: ' || left(p_desc, 80), null, p_by, p_name, null);
exception when others then raise warning 'bug report not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_class_applied(p_by text, p_co text, p_class text, p_proposed text, p_parent text, p_convert boolean)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text;
begin
  -- A conversion of the existing stock was never logged when filed; only a
  -- new class is.
  if p_convert then return; end if;
  select name into v_name from jex_users where id = p_by;
  perform jex_log('class_app', v_name || ' applied for ' || p_co || ' Class ' || p_class || ' (' || p_proposed || ')', p_parent, p_by, v_name, null);
exception when others then raise warning 'class application not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_price_alert(p_user text, p_ticker text, p_direction text, p_target numeric, p_price numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
begin
  perform jex_notify(p_user, 'price_alert',
    '🎯 Price alert: ' || p_ticker || ' is ' || p_direction || ' ' || jex_fmt(p_target) || ' (now ' || jex_fmt(p_price) || ')', p_ticker);
exception when others then raise warning 'price alert not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_news_holders(p_news text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare n record;
begin
  select * into n from jex_news where id = p_news;
  perform jex_notify_holders(n.ticker, 'news', '📰 ' || n.company_name || ': ' || n.headline);
exception when others then raise warning 'news notice not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  -- "Notify all shareholders" is the author's choice when posting, so it is a
  -- call of its own: only the author, only within 10 minutes of posting, and
  -- only once -- the text comes from the stored article, not the caller.
  execute $fn$
create or replace function public.rpc_notify_news_holders(p_news_id text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $body$
declare v_uid text;
begin
  select id into v_uid from jex_users where auth_uid = auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;
  update jex_news set holders_notified_at = now()
   where id = p_news_id and author_id = v_uid and holders_notified_at is null
     and (created_at is null or created_at > now() - interval '10 minutes');
  if not found then return jsonb_build_object('sent', false); end if;
  perform jex_ev_news_holders(p_news_id);
  return jsonb_build_object('sent', true);
end;
$body$;
$fn$;

  execute 'revoke execute on function public.jex_ev_after_hours_active(jsonb), public.jex_ev_vote_closed(text),
    public.jex_ev_fund_created(text,text,text,numeric), public.jex_ev_flagged(text,text,text,text,text,text),
    public.jex_ev_limit_order(text,text,text,integer,text,numeric), public.jex_ev_financials(text,text,text,numeric,numeric),
    public.jex_ev_vote_posted(text,text,text,text), public.jex_ev_div_rejected(text),
    public.jex_ev_founder_removed(text,text,text), public.jex_ev_delist_requested(text,text,text,text),
    public.jex_ev_div_requested(text,text,numeric,numeric), public.jex_ev_alloc_requested(text,text,integer,text),
    public.jex_ev_invite_answered(text,text,boolean), public.jex_ev_alloc_reviewed(boolean,text,text,integer,text,text),
    public.jex_ev_invite_sent(text,text,text), public.jex_ev_bug_report(text,text,text),
    public.jex_ev_class_applied(text,text,text,text,text,boolean), public.jex_ev_price_alert(text,text,text,numeric,numeric),
    public.jex_ev_news_holders(text), public.jex_company_of(text)
    from public, anon, authenticated';
  execute 'revoke execute on function public.rpc_notify_news_holders(text) from public, anon';
  execute 'grant execute on function public.rpc_notify_news_holders(text) to authenticated';

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

  raise notice 'Batch 3: % of 18 functions now record their own events.', v_patched;
end
$mig$;

-- ── verification ──
--
-- recording            the eighteen, each true once it records its own events
-- server_events        what the page will be told: batches 1-3 -- 46 in all
-- helpers_internal     anon and authenticated can call none of the helpers.
--                      Should be empty.
-- news_notify          signed-in users can ask, signed-out visitors cannot
-- server_entries_since entries the server itself has written so far
select
  (select jsonb_object_agg(p.proname, position('jex_ev_' in p.prosrc) > 0 order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('rpc_activate_after_hours_orders','rpc_close_vote','rpc_create_fund','rpc_flag_account',
                        'rpc_place_limit_order','rpc_post_financials','rpc_post_vote','rpc_reject_dividend_approval',
                        'rpc_remove_founder','rpc_request_delisting','rpc_request_dividend_approval',
                        'rpc_request_founder_allocation','rpc_respond_to_invite','rpc_review_founder_allocation',
                        'rpc_send_founder_invite','rpc_submit_bug_report','rpc_submit_class_application',
                        'rpc_trigger_price_alert'))                                     as recording,
  (select jsonb_array_length(to_jsonb(rpc_server_events())))                    as server_events,
  (select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'jex\_ev\_%'
          or p.proname in ('jex_log','jex_notify','jex_notify_holders','jex_notify_students','jex_fmt','jex_company_of'))
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')))          as helpers_internal,
  (select jsonb_build_object(
     'signed_in', has_function_privilege('authenticated', 'public.rpc_notify_news_holders(text)', 'execute'),
     'signed_out', has_function_privilege('anon', 'public.rpc_notify_news_holders(text)', 'execute')))
                                                                                 as news_notify,
  (select count(*) from jex_activity where logged_by = 'server')                 as server_entries_since;
