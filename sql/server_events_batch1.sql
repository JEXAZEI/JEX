-- ============================================================
-- server_events_batch1.sql
--
-- Server-recorded events, batch 1 of 4 (see SERVER_EVENTS_PLAN.md): the
-- eleven money-and-positions functions now write their own activity-log
-- entries and notifications, in the same transaction as the action, with
-- text built from what they actually did.
--
-- Until now the browser did it: the app called the function, then called
-- rpc_log_activity and rpc_push_notification to describe the result. That is
-- why a student could describe a fill, a dividend or a margin call that never
-- happened. After this, for these eleven, the description comes from the
-- function that did the thing.
--
-- ── What this adds ──
--
--   jex_fmt          money as the app shows it: '$' + two decimals
--   jex_log          an activity entry on the hash chain, written by
--                    'server' -- a writer rpc_log_activity can never record,
--                    since it always records a real account
--   jex_notify       one notification, emailed under the same rules as
--                    rpc_push_notification (full text: the server wrote it)
--   jex_notify_holders  every student holding a ticker
--   jex_ev_*         one per event, holding that event's wording
--   rpc_server_events  which functions now record their own events, so the
--                    page stops doing it for those and nothing is recorded
--                    twice. It reads the function bodies, so later batches
--                    extend it without changing it.
--
-- None of the helpers can be called from the web: execute is revoked from
-- public, anon and authenticated, and only the functions below call them.
--
-- ── What changes in the eleven ──
--
-- One line each: a call to that event's jex_ev_* function, placed after the
-- function's last write. jex_log takes the chain lock; taking it before a
-- function had finished locking its rows would let two of them deadlock.
-- Nothing else in them changes -- verified by running every one on a copy of
-- production's code and comparing every balance, holding, short, price,
-- order and trade before and after.
--
-- Recording is best-effort, exactly as the page's was: a failure to write an
-- entry or a notification is raised as a WARNING and never undoes a trade.
--
-- ── Wording ──
--
-- Word for word what the page sends today, with three deliberate changes:
--   * a dividend paid after Treasurer approval used to notify holders with a
--     shorter message than one paid directly, and its log entry named the
--     Treasurer as the company. Both paths now get the full message and the
--     company's owner.
--   * a limit order that fills the moment it is placed was never logged --
--     the page logged fills only from its periodic check. Every fill is
--     logged now.
--   * an order's owner is notified (and emailed) when an order that was
--     resting fills, as before -- not for one that fills a second after they
--     placed it, while they are looking at the confirmation.
--
-- ── Safety ──
--
-- Refuses to run, changing nothing, unless every one of the eleven is
-- byte-for-byte the production version this was written and tested against.
-- Safe to run twice: a function that already records its events is skipped.
-- ============================================================

do $mig$
declare
  r record;
  v_nl text;
  v_n int;
  v_src text;
  v_fp text;
  v_want text;
  v_patched int := 0;
  -- name, fingerprint, anchor, inserted call, 'before' or 'after' the anchor
  v_plan text[][] := array[
    ['admin_adjust_cash', 'eda6a5279db7030149872d372069743c',
     'return v_new_cash;',
     'perform jex_ev_balance_adj(p_target_id, p_op, p_amount, v_target_cash, v_new_cash);', 'before'],
    ['rpc_fund_deposit', 'bc6874d5f3dcf21135ead8db387a76af',
     'return jsonb_build_object(''cash'', round(v_cash - p_amount, 2), ''fund_units'', v_fund_units,',
     'perform jex_ev_fund_deposit(v_uid, p_fund_id, p_amount);', 'before'],
    ['rpc_fund_withdraw', 'f756b2c5b7d551461662495358ce4d5b',
     'return jsonb_build_object(''cash'', round(v_cash + v_net, 2), ''fund_units'', v_fund_units,',
     'perform jex_ev_fund_withdraw(v_uid, p_fund_id, v_net, v_fee);', 'before'],
    ['rpc_pay_dividend', '2de33cbffa3dcf528c923b450829cf30',
     'return jsonb_build_object(''new_prices'', v_new_prices, ''fund_payouts'', v_fund_pays,',
     'perform jex_ev_dividend(p_ticker, p_per_share, v_total, v_co.owner_id, v_new_prices);', 'before'],
    ['rpc_fill_limit_vs_pool', '3c7a9d15ed472a43084ee3867bd5b90e',
     'where id = p_order_id;',
     'perform jex_ev_pool_fill(v_order.side, v_order.qty, v_order.ticker, v_order.fund_id, v_order.user_id, v_new_price, v_order.created_at);', 'after'],
    ['rpc_match_limit_order_book', '0ae04b4a26b2a97afa68454d6d50a35c',
     'returning to_jsonb(jex_trades.*) into v_trade;',
     'perform jex_ev_book_match(v_bid.fund_id, v_bid.user_id, v_ask.fund_id, v_ask.user_id, v_fill_qty, p_ticker, v_fill_price);', 'after'],
    ['rpc_trigger_stop_loss', '9015820b08e8a3ec76f1a8bd37d7e5a5',
     'returning to_jsonb(jex_trades.*) into v_trade;',
     'perform jex_ev_stop_loss(v_sl.user_id, v_sl.ticker, v_sell_qty, v_new_price, v_sl.trigger_price);', 'after'],
    ['rpc_margin_call_short', 'f3989a70fcbc9cd18e50ef9f8d80a365',
     'select to_jsonb(t) into v_trade from jex_trades t where t.id = v_trade_id;',
     'perform jex_ev_margin_call(p_user_id, null, p_ticker, v_qty, v_new_price, v_avg, v_pnl, v_coll);', 'after'],
    ['rpc_margin_call_fund_short', '3e8637d58af48a0d62893bda33d55621',
     'returning to_jsonb(jex_trades.*) into v_trade;',
     'perform jex_ev_margin_call(null, p_fund_id, p_ticker, v_qty, v_new_price, v_avg, v_pnl, v_coll);', 'after'],
    ['rpc_convert_share_class', '3f6e55c182ad34f2556ee9dcaa0cdc2c',
     'update jex_companies set shares = shares + v_new where ticker = v_meta.parent_ticker;',
     'perform jex_ev_class_convert(v_uid, p_qty, v_meta.ticker, v_new, v_meta.parent_ticker);', 'after'],
    ['rpc_adjust_stock_price', '3f313b67ffa61e06ea9b9e14aef8ae78',
     'return jsonb_build_object(''price'', v_new_price, ''price_history'', v_new_price_history, ''old_price'', v_co.price,',
     'perform jex_ev_price_adj(p_ticker, p_pct, p_reason, v_uid, v_new_price - v_co.price);', 'before']
  ];
  i int;
begin
  -- ── 1. every function is either already done or exactly the expected version ──
  for i in 1 .. array_length(v_plan, 1) loop
    v_src := null; v_fp := null;
    select p.prosrc, md5(replace(p.prosrc, chr(13), '')) into v_src, v_fp
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_plan[i][1];
    if v_src is null then
      raise exception 'ABORT: % not found. Nothing changed.', v_plan[i][1];
    end if;
    if position('jex_ev_' in v_src) = 0 then
      v_want := v_plan[i][2];
      if v_fp <> v_want then
        raise exception 'ABORT: % is not the version this was written against (md5 %). Nothing changed -- paste this error back.', v_plan[i][1], v_fp;
      end if;
      v_n := (length(v_src) - length(replace(v_src, v_plan[i][3], ''))) / length(v_plan[i][3]);
      if v_n <> 1 then
        raise exception 'ABORT: expected the anchor exactly once in %, found %. Nothing changed.', v_plan[i][1], v_n;
      end if;
    end if;
  end loop;

  -- ── 2. the helpers ──
  execute $fn$
create or replace function public.jex_fmt(p numeric) returns text
 language sql immutable set search_path to 'public'
as $body$ select '$' || to_char(round(coalesce(p, 0), 2), 'FM999999999990.00') $body$;
$fn$;

  execute $fn$
create or replace function public.jex_log(p_type text, p_description text, p_ticker text,
                                          p_subject_id text, p_subject_name text, p_amount numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare
  v_prev text; v_ts text;
  v_desc text := left(coalesce(p_description, ''), 500);
  v_ticker text := left(nullif(btrim(coalesce(p_ticker, '')), ''), 20);
  v_subject text := left(nullif(btrim(coalesce(p_subject_id, '')), ''), 100);
  v_subject_name text := left(nullif(btrim(coalesce(p_subject_name, '')), ''), 100);
begin
  -- Same chain as rpc_log_activity: one entry at a time, stamped under the
  -- lock, writer in the hash. The writer is 'server' -- rpc_log_activity
  -- records the calling account's id, so it can never produce this value.
  perform pg_advisory_xact_lock(hashtext('jex_activity_chain'));
  select coalesce(entry_hash, id) into v_prev
    from jex_activity where type <> 'snapshot'
    order by created_at desc nulls last limit 1;
  v_prev := coalesce(v_prev, 'genesis');
  v_ts := to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI:SS AM');
  insert into jex_activity (id, type, description, ticker, user_id, user_name, amount, ts,
                            prev_hash, entry_hash, logged_by, created_at)
  values (gen_random_uuid()::text, p_type, v_desc, v_ticker, v_subject, v_subject_name, p_amount, v_ts, v_prev,
    substr(md5(v_prev || p_type || v_desc || coalesce(p_amount::text, '') || v_ts
               || coalesce(v_subject, '') || coalesce(v_subject_name, '') || coalesce(v_ticker, '') || 'server'), 1, 8),
    'server', clock_timestamp());
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_notify(p_user_id text, p_type text, p_message text, p_ticker text default null)
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
  insert into jex_notifications (id, user_id, type, message, ticker, read, ts, sent_by, created_at)
    values (gen_random_uuid()::text, p_user_id, p_type, v_msg, p_ticker, false,
      to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI AM'), 'server', now());
  -- Email under rpc_push_notification's rules. The full text goes out: the
  -- server wrote it, nobody else.
  begin
    if v_recipient.email_notifications and p_type = any(v_important) then
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
create or replace function public.jex_notify_holders(p_ticker text, p_type text, p_message text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_id text;
begin
  -- The page's pushNotificationToHolders: every student holding any of it.
  for v_id in select id from jex_users
               where role = 'student' and coalesce((holdings->>p_ticker)::numeric, 0) > 0
               order by id loop
    perform jex_notify(v_id, p_type, p_message, p_ticker);
  end loop;
end;
$body$;
$fn$;

  -- ── 3. one function per event, holding its wording ──
  -- Each is best-effort: a failure is a WARNING, never an undone trade.

  execute $fn$
create or replace function public.jex_ev_balance_adj(p_target text, p_op text, p_amount numeric, p_prev numeric, p_new numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text;
begin
  select name into v_name from jex_users where id = p_target;
  perform jex_log('balance_adj',
    case p_op when 'add' then '+' || jex_fmt(p_amount) || ' added to ' || v_name
              when 'subtract' then '-' || jex_fmt(p_amount) || ' removed from ' || v_name
              else v_name || '''s balance set to ' || jex_fmt(p_new) end,
    null, p_target, v_name, p_new - p_prev);
exception when others then raise warning 'balance_adj event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_fund_deposit(p_user text, p_fund text, p_amount numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text; v_fund text;
begin
  select name into v_name from jex_users where id = p_user;
  select name into v_fund from jex_funds where id = p_fund;
  perform jex_log('fund_deposit', v_name || ' deposited ' || jex_fmt(p_amount) || ' into ' || v_fund,
    null, p_user, v_name, p_amount);
exception when others then raise warning 'fund_deposit event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_fund_withdraw(p_user text, p_fund text, p_net numeric, p_fee numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text; v_fund record;
begin
  select name into v_name from jex_users where id = p_user;
  select name, manager_name into v_fund from jex_funds where id = p_fund;
  perform jex_log('fund_withdraw',
    v_name || ' withdrew ' || jex_fmt(p_net) || ' from ' || v_fund.name
      || case when coalesce(p_fee, 0) > 0
              then ' (performance fee ' || jex_fmt(p_fee) || ' to ' || coalesce(v_fund.manager_name, '') || ')'
              else '' end,
    null, p_user, v_name, p_net);
exception when others then raise warning 'fund_withdraw event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_dividend(p_ticker text, p_per_share numeric, p_total numeric, p_owner text, p_new_prices jsonb)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_co text; v_owner text; v_note text := '';
begin
  select name into v_co from jex_companies where ticker = p_ticker;
  select name into v_owner from jex_users where id = p_owner;
  if p_new_prices ? p_ticker then
    v_note := ' ' || p_ticker || ' fell ' || jex_fmt(p_per_share) || ' to ' || jex_fmt((p_new_prices->>p_ticker)::numeric)
           || ' — the cash came out of the company, so your total is unchanged. That is what a dividend is.';
  end if;
  perform jex_log('dividend', v_co || ' paid dividend ' || jex_fmt(p_per_share) || '/share — total ' || jex_fmt(p_total),
    p_ticker, p_owner, v_owner, p_total);
  perform jex_notify_holders(p_ticker, 'dividend',
    '💰 ' || v_co || ' paid a dividend of ' || jex_fmt(p_per_share) || '/share.' || v_note);
exception when others then raise warning 'dividend event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_pool_fill(p_side text, p_qty integer, p_ticker text, p_fund text, p_user text, p_price numeric,
                                                   p_placed timestamptz)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_owner text;
begin
  if p_fund is not null then
    select coalesce((select name from jex_funds where id = p_fund), 'a fund') into v_owner;
  else
    select coalesce((select name from jex_users where id = p_user), 'someone') into v_owner;
  end if;
  perform jex_log('limit_fill',
    v_owner || '''s limit ' || p_side || ' ' || p_qty || '×' || p_ticker || ' filled vs JEX pool @ ' || jex_fmt(p_price),
    p_ticker, null, null, p_price);
  -- The owner is told when an order that was RESTING fills -- the page only
  -- ever sent this from its periodic check, never for an order filling the
  -- moment it is placed, while the student is watching the confirmation. A
  -- limit_fill is emailed, so without this every instant fill would be mail.
  if p_fund is null and (p_placed is null or p_placed < now() - interval '1 minute') then
    perform jex_notify(p_user, 'limit_fill',
      '⚡ Limit ' || p_side || ' filled: ' || p_qty || '×' || p_ticker || ' @ ' || jex_fmt(p_price), p_ticker);
  end if;
exception when others then raise warning 'limit_fill event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_book_match(p_bid_fund text, p_bid_user text, p_ask_fund text, p_ask_user text,
                                                    p_qty integer, p_ticker text, p_price numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_buyer text; v_seller text;
begin
  v_buyer := case when p_bid_fund is not null
                  then coalesce((select name from jex_funds where id = p_bid_fund), 'a fund')
                  else coalesce((select name from jex_users where id = p_bid_user), 'someone') end;
  v_seller := case when p_ask_fund is not null
                   then coalesce((select name from jex_funds where id = p_ask_fund), 'a fund')
                   else coalesce((select name from jex_users where id = p_ask_user), 'someone') end;
  -- The page has only ever logged a book match, never notified either side.
  perform jex_log('limit_fill',
    v_buyer || ' ↔ ' || v_seller || ': ' || p_qty || '×' || p_ticker || ' @ ' || jex_fmt(p_price),
    p_ticker, null, null, p_price);
exception when others then raise warning 'book match event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_stop_loss(p_user text, p_ticker text, p_qty integer, p_price numeric, p_trigger numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text;
begin
  select name into v_name from jex_users where id = p_user;
  perform jex_notify(p_user, 'stop_loss',
    '🛑 Stop-loss triggered: sold ' || p_qty || '×' || p_ticker || ' @ ' || jex_fmt(p_price)
      || ' (trigger: ' || jex_fmt(p_trigger) || ')', p_ticker);
  perform jex_log('stop_loss',
    coalesce(v_name, 'Someone') || ' stop-loss triggered on ' || p_ticker || ' @ ' || jex_fmt(p_price),
    p_ticker, p_user, coalesce(v_name, ''), p_qty * p_price);
exception when others then raise warning 'stop_loss event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_margin_call(p_user text, p_fund text, p_ticker text, p_qty numeric, p_price numeric,
                                                     p_avg numeric, p_pnl numeric, p_coll numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text; v_fund record; v_q text := trim_scale(p_qty)::text;
begin
  if p_fund is null then
    select name into v_name from jex_users where id = p_user;
    perform jex_notify(p_user, 'margin_call',
      '⚠️ Margin call: your short of ' || v_q || '×' || p_ticker || ' was closed at ' || jex_fmt(p_price)
        || ' (opened at ' || jex_fmt(p_avg) || '). Loss ' || jex_fmt(abs(p_pnl)) || ' of the ' || jex_fmt(p_coll) || ' you posted.',
      p_ticker);
    perform jex_log('margin_call',
      coalesce(v_name, 'Someone') || '''s short of ' || v_q || '×' || p_ticker || ' was closed by a margin call @ ' || jex_fmt(p_price),
      p_ticker, p_user, coalesce(v_name, ''), p_qty * p_price);
  else
    select name, manager_id into v_fund from jex_funds where id = p_fund;
    -- The manager is told; investors see it in the fund's activity, as before.
    if v_fund.manager_id is not null then
      perform jex_notify(v_fund.manager_id, 'margin_call',
        '⚠️ Margin call: ' || v_fund.name || '''s short of ' || v_q || '×' || p_ticker || ' was closed at ' || jex_fmt(p_price)
          || ' (opened at ' || jex_fmt(p_avg) || '). Loss ' || jex_fmt(abs(p_pnl)) || ' of the ' || jex_fmt(p_coll) || ' the fund posted.',
        p_ticker);
    end if;
    perform jex_log('margin_call',
      v_fund.name || '''s short of ' || v_q || '×' || p_ticker || ' was closed by a margin call @ ' || jex_fmt(p_price),
      p_ticker, v_fund.manager_id, v_fund.name, p_qty * p_price);
  end if;
exception when others then raise warning 'margin_call event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_class_convert(p_user text, p_qty integer, p_class text, p_received integer, p_parent text)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_name text;
begin
  select name into v_name from jex_users where id = p_user;
  perform jex_log('class_convert',
    v_name || ' converted ' || p_qty || ' ' || p_class || ' into ' || p_received || ' ' || p_parent,
    p_parent, p_user, v_name, null);
exception when others then raise warning 'class_convert event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.jex_ev_price_adj(p_ticker text, p_pct numeric, p_reason text, p_officer text, p_delta numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $body$
declare v_co text; v_officer text; v_msg text; v_id text;
begin
  select name into v_co from jex_companies where ticker = p_ticker;
  select name into v_officer from jex_users where id = p_officer;
  v_msg := case when p_pct >= 0 then '📈' else '📉' end || ' ' || v_co || ' (' || p_ticker || ') price '
        || case when p_pct >= 0 then 'boosted by +' else 'cut by ' end || trim_scale(abs(p_pct))::text || '%'
        || case when coalesce(p_reason, '') <> '' then ' — ' || btrim(p_reason) else '' end;
  -- Holders first, then every other approved student, once each -- the
  -- page's pushNotificationToHolders followed by pushNotificationToAll.
  perform jex_notify_holders(p_ticker, 'price_adj', v_msg);
  for v_id in select id from jex_users
               where role = 'student' and status = 'approved'
                 and coalesce((holdings->>p_ticker)::numeric, 0) <= 0
               order by id loop
    perform jex_notify(v_id, 'price_adj', v_msg, null);
  end loop;
  perform jex_log('price_adj', v_msg, p_ticker, p_officer, v_officer, p_delta);
exception when others then raise warning 'price_adj event not recorded: %', sqlerrm;
end;
$body$;
$fn$;

  execute $fn$
create or replace function public.rpc_server_events()
 returns text[] language sql stable security definer set search_path to 'public'
as $body$
  -- The page asks this once on load and skips its own log/notification
  -- call for every function named here. Read from the function bodies, so
  -- each later batch extends it without editing it.
  select coalesce(array_agg(p.proname::text order by p.proname), '{}')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~ 'perform jex_ev_'
     and p.proname not like 'jex\_%' and p.proname <> 'rpc_server_events';
$body$;
$fn$;

  -- Internal only. Supabase grants execute on new functions to anon and
  -- authenticated by default, so it is taken away explicitly.
  execute 'revoke execute on function public.jex_fmt(numeric), public.jex_log(text,text,text,text,text,numeric),
    public.jex_notify(text,text,text,text), public.jex_notify_holders(text,text,text),
    public.jex_ev_balance_adj(text,text,numeric,numeric,numeric), public.jex_ev_fund_deposit(text,text,numeric),
    public.jex_ev_fund_withdraw(text,text,numeric,numeric), public.jex_ev_dividend(text,numeric,numeric,text,jsonb),
    public.jex_ev_pool_fill(text,integer,text,text,text,numeric,timestamptz), public.jex_ev_book_match(text,text,text,text,integer,text,numeric),
    public.jex_ev_stop_loss(text,text,integer,numeric,numeric), public.jex_ev_margin_call(text,text,text,numeric,numeric,numeric,numeric,numeric),
    public.jex_ev_class_convert(text,integer,text,integer,text), public.jex_ev_price_adj(text,numeric,text,text,numeric)
    from public, anon, authenticated';
  execute 'grant execute on function public.rpc_server_events() to anon, authenticated';

  -- ── 4. one line into each of the eleven ──
  for i in 1 .. array_length(v_plan, 1) loop
    select p.prosrc, pg_get_functiondef(p.oid) as def into r
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_plan[i][1];
    if position('jex_ev_' in r.prosrc) > 0 then
      raise notice '% already records its events -- skipped.', v_plan[i][1];
      continue;
    end if;
    v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;
    if v_plan[i][5] = 'before' then
      execute replace(r.def, r.prosrc, replace(r.prosrc, v_plan[i][3],
        v_plan[i][4] || v_nl || '  ' || v_plan[i][3]));
    else
      execute replace(r.def, r.prosrc, replace(r.prosrc, v_plan[i][3],
        v_plan[i][3] || v_nl || '  ' || v_plan[i][4]));
    end if;
    v_patched := v_patched + 1;
  end loop;

  raise notice 'Batch 1: % of 11 functions now record their own events.', v_patched;
end
$mig$;

-- ── verification ──
--
-- recording            the eleven, each true once it records its own events
-- server_events        what the page will be told (rpc_server_events)
-- helpers_internal     anon and authenticated can call none of the helpers.
--                      Should be empty.
-- server_entries_since entries the server itself has written so far
select
  (select jsonb_object_agg(p.proname, position('jex_ev_' in p.prosrc) > 0 order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('admin_adjust_cash','rpc_fund_deposit','rpc_fund_withdraw','rpc_pay_dividend',
                        'rpc_fill_limit_vs_pool','rpc_match_limit_order_book','rpc_trigger_stop_loss',
                        'rpc_margin_call_short','rpc_margin_call_fund_short','rpc_convert_share_class',
                        'rpc_adjust_stock_price'))                                as recording,
  (select to_jsonb(rpc_server_events()))                                         as server_events,
  (select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'jex\_ev\_%' or p.proname in ('jex_log','jex_notify','jex_notify_holders','jex_fmt'))
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')))           as helpers_internal,
  (select count(*) from jex_activity where logged_by = 'server')                  as server_entries_since;
