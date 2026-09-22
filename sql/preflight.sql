-- ============================================================
-- preflight.sql
--
-- READ ONLY. Changes nothing. Run it five minutes before class.
--
-- Not a migration and not a bug hunt. This answers one question: is the
-- exchange in a state where a class can actually happen right now.
--
-- Everything here is something that has either gone wrong on this exchange
-- already, or would stop a lesson dead. Read the columns top to bottom; every
-- one of them should say the boring thing.
--
-- Safe to run any number of times, during a session or outside one.
-- ============================================================

select jsonb_pretty(jsonb_build_object(

  -- ── 1. Can students get in and trade at all ──
  --
  -- dev_mode is the big one. It locks out everyone who is not a Chairman,
  -- President or test account, with "Developer mode -- exchange is currently
  -- closed for testing." If it is ever left on, nobody can sign in and there
  -- is nothing in the UI to suggest why.
  'can_class_start', jsonb_build_object(
    'dev_mode_MUST_BE_FALSE', (select coalesce(dev_mode, false) from jex_session where id = 1),
    'session_status',         (select status from jex_session where id = 1),
    'session_label',          (select label  from jex_session where id = 1),
    'practice_mode',          (select coalesce(practice_mode, false) from jex_session where id = 1),
    'halted_tickers',         (select coalesce(jsonb_agg(ticker order by ticker), '[]'::jsonb) from jex_halts)),

  -- ── 2. Is there anything to trade ──
  --
  -- Test-account companies are hidden from students while dev_mode is off, so
  -- "listed" and "listed AND visible to a student" are different numbers, and
  -- the second is the one that decides whether a lesson works.
  'what_students_can_see', (
    select jsonb_build_object(
      'tradeable_companies', count(*) filter (where not c.is_test_owned and not c.is_index),
      'index_funds',         count(*) filter (where c.is_index),
      'hidden_test_companies', count(*) filter (where c.is_test_owned),
      'tickers', coalesce(jsonb_agg(jsonb_build_object(
                   'ticker', c.ticker, 'price', c.price,
                   'visible_to_students', not c.is_test_owned)
                 order by c.ticker), '[]'::jsonb))
      from (select co.ticker, co.price, coalesce(co.is_index_fund,false) as is_index,
                   exists (select 1 from jex_users u
                            where u.id = co.owner_id and coalesce(u.is_test_account,false)) as is_test_owned
              from jex_companies co where co.status = 'listed') c),

  -- ── 3. Can each student actually participate ──
  --
  -- Someone with no cash and no holdings can watch, and nothing else.
  'students', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', u.name, 'cash', u.cash,
             'holds', coalesce(u.holdings, '{}'::jsonb) <> '{}'::jsonb,
             'can_participate', u.cash > 0 or coalesce(u.holdings,'{}'::jsonb) <> '{}'::jsonb)
           order by u.cash), '[]'::jsonb)
      from jex_users u
     where u.role in ('student','company') and not coalesce(u.is_test_account, false)
       and u.departed_at is null),

  -- ── 4. Do the books balance ──
  --
  -- The share register is the one that has actually gone wrong here: removing
  -- an account used to delete the shares it held. Both numbers should be 0.
  'books', jsonb_build_object(
    'shares_unaccounted_for', (
      select coalesce(sum(c.shares - c.shares_avail - h.u - h.f), 0)
        from jex_companies c
        cross join lateral (
          select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                            where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as u,
                 coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                            where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as f) h
       where c.status = 'listed' and not coalesce(c.is_index_fund, false)),
    'users_with_negative_cash', (select count(*) from jex_users where cash < 0),
    'funds_with_negative_cash', (select count(*) from jex_funds where cash < 0),
    'total_money_in_the_exchange', round(
        coalesce((select sum(cash) from jex_users), 0)
      + coalesce((select sum(coalesce(cash,0)) from jex_funds), 0)
      + coalesce((select sum(coalesce((v->>'collateral')::numeric,0))
                    from jex_users u, lateral jsonb_each(coalesce(u.shorts,'{}'::jsonb)) k(t,v)), 0)
      + coalesce((select sum(coalesce((v->>'collateral')::numeric,0))
                    from jex_funds f, lateral jsonb_each(coalesce(f.shorts,'{}'::jsonb)) k(t,v)), 0), 2)),

  -- ── 5. Is any price stranded outside its own band ──
  --
  -- A stranded price freezes the buy side: every buy refused, every sell
  -- filled, until it drifts back. Two separate bugs produced this.
  'stranded_prices', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'ticker', c.ticker, 'price', c.price,
             'band_low',  round(o.p * (1 - s.price_band_pct/100), 2),
             'band_high', round(o.p * (1 + s.price_band_pct/100), 2)) order by c.ticker), '[]'::jsonb)
      from jex_companies c
      join jex_session s on s.id = 1
      cross join lateral (select (s.session_open_prices->>c.ticker)::numeric as p) o
     where c.status = 'listed' and o.p is not null
       and (c.price > round(o.p * (1 + s.price_band_pct/100), 2)
         or c.price < round(o.p * (1 - s.price_band_pct/100), 2))),

  -- ── 6. Any short about to become somebody's bad afternoon ──
  'shorts', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'who', x.who, 'ticker', x.t, 'qty', x.qty,
             'loss_now', x.loss, 'margin_call_at', x.line,
             'past_the_line', x.loss >= x.line) order by x.who), '[]'::jsonb)
      from (
        select u.name as who, k.t, (k.v->>'qty')::numeric as qty,
               round((c.price - (k.v->>'avgPrice')::numeric) * (k.v->>'qty')::numeric, 2) as loss,
               round(coalesce((k.v->>'collateral')::numeric,0) * 0.8, 2) as line
          from jex_users u, lateral jsonb_each(coalesce(u.shorts,'{}'::jsonb)) k(t,v)
          join jex_companies c on c.ticker = k.t
        union all
        select 'fund: ' || f.name, k.t, (k.v->>'qty')::numeric,
               round((c.price - (k.v->>'avgPrice')::numeric) * (k.v->>'qty')::numeric, 2),
               round(coalesce((k.v->>'collateral')::numeric,0) * 0.8, 2)
          from jex_funds f, lateral jsonb_each(coalesce(f.shorts,'{}'::jsonb)) k(t,v)
          join jex_companies c on c.ticker = k.t) x),

  -- ── 7. Is there anything to roll back to ──
  --
  -- If Thursday goes wrong, a snapshot is the only undo. One taken before
  -- today's registrations will reset anyone who joined since.
  'snapshots', jsonb_build_object(
    'count', (select count(*) from jex_snapshots),
    'newest', (select max(created_at) from jex_snapshots),
    'accounts_created_since_newest', (
      select count(*) from jex_users u
       where u.created_at > coalesce((select max(created_at) from jex_snapshots), '1970-01-01'::timestamptz))),

  -- ── 8. Are the fixes still in place ──
  --
  -- Twenty-two markers from the migrations that matter most. Every one should be
  -- true. A false here means a function was replaced by hand afterwards and
  -- the fix went with it -- which is exactly how this codebase lost things
  -- before sql/ existed.
  'fixes_still_applied', (
    select jsonb_object_agg(m.label, coalesce(
             (select position(m.marker in p.prosrc) > 0
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = m.fn limit 1), false))
      from (values
        ('approve_registration needs an officer', 'approve_registration', 'v_caller_role text;'),
        ('forgot password works',                 'reset_migrated_password', 'verify_legacy_security_answer(p_user_id, p_answer)'),
        ('contact emails need a login',           'rpc_get_company_team_contacts', 'if not exists (select 1 from jex_users where auth_uid = auth.uid()) then'),
        ('restricted classes cannot be shorted',  'rpc_trade_short', 'if v_meta.ticker is not null and coalesce(v_meta.restricted,false) then'),
        ('a blown short can be closed',           'rpc_trade_cover_short', 'v_cash := greatest(0, round(v_cash + v_cb + v_pnl, 2));'),
        ('a fund cover respects the band',        'rpc_fund_cover_short', 'v_cp := jex_band_clamp(v_co.ticker, v_cp, v_co.price);'),
        ('a fund unit cannot go negative',        'jex_fund_nav', 'greatest(0, round(('),
        ('graded net worth marks the index live', 'jex_mark_price', 'v_index_room text;'),
        ('margin call sees the index',            'rpc_margin_call_short', 'v_co.price := round(coalesce(index_live_value('),
        ('fund margin call exists',               'rpc_margin_call_fund_short', 'v_coll * 0.8'),
        ('removing an account returns its shares','rpc_admin_remove_user', 'v_give_back record;'),
        ('officer reset will not delete holdings','rpc_admin_reset_officer_cash', 'v_holders text;'),
        ('audit log covers attribution',          'rpc_log_activity', 'coalesce(p_user_id'),
        ('dividend total includes funds',         'rpc_request_dividend_approval', 'from jex_funds f where f.holdings ?| v_tickers'),
        ('sign-in is rate limited',               'verify_legacy_password', 'jex_login_throttle'),
        ('an expired vote refuses ballots',       'rpc_cast_vote', 'v_deadline timestamptz;'),
        ('every new vote gets a 24h deadline',    'rpc_post_vote', '24 hours from posting, set here'),
        ('old votes are swept closed',            'rpc_auto_close_expired_votes', 'v.created_at + interval'),
        ('index opens from its constituents',     'rpc_record_session_open_prices', 'index_open_from('),
        ('...and reads companies before the index','rpc_record_session_open_prices', 'order by coalesce(is_index_fund, false) loop'),
        ('a restore re-records the opening prices','rpc_admin_restore_snapshot', 'jex_open_prices_now()'),
        ('a dilution marks its step on the chart','rpc_review_dilution', '''a'', case when v_co.price > 0')
      ) m(label, fn, marker)),

  -- ── 8b. Fixes that are about data, not a line in a function ──
  --
  -- Each of these should be an empty list or `true`.
  --
  -- functions_writing_utc_times  a bare to_char(now(), ...) renders in the
  --                              server's zone, UTC -- seven hours ahead of
  --                              Tucson. Any function listed here was put
  --                              back by hand after timestamps_arizona.sql.
  -- unmarked_dilutions           a company whose index base was adjusted with
  --                              no step marked in its history. JXI's chart
  --                              draws that dilution as a crash. Fixed by
  --                              mark_past_dilution.sql.
  -- jxi_open_is_honest           today's recorded JXI open equals the level its
  --                              constituents' opens give. False is how "-50%"
  --                              and "+99.93%" happened; opening the session
  --                              again, or restoring a snapshot, re-records it.
  'data_fixes_holding', jsonb_build_object(
    'functions_writing_utc_times', (
      select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
         and p.prosrc ~ 'to_char\(\s*now\(\)\s*,'),
    'unmarked_dilutions', (
      select coalesce(jsonb_agg(c.ticker order by c.ticker), '[]'::jsonb)
        from jex_companies c
       where not coalesce(c.is_index_fund, false)
         and coalesce(c.index_base_adjust, 1) <> 1
         and not exists (select 1 from jsonb_array_elements(coalesce(c.price_history, '[]'::jsonb)) e
                          where e ? 'a')),
    'jxi_open_is_honest', (
      select coalesce(bool_and(
               (s.session_open_prices->>c.ticker)::numeric
               = index_open_from(s.session_open_prices, c.index_classroom_id)), true)
        from jex_companies c cross join jex_session s
       where s.id = 1 and coalesce(c.is_index_fund, false) and c.status = 'listed'
         and s.session_open_prices ? c.ticker)),

  -- ── 9. The security answer trigger ──
  --
  -- rpc_update_security_question writes sec_a in PLAINTEXT and relies
  -- entirely on this trigger to hash it. If it is ever missing or disabled,
  -- security answers start landing in the database in clear text silently.
  'sec_a_protection', jsonb_build_object(
    'trigger_on_users',   (select count(*) > 0 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                            where c.relname = 'jex_users' and t.tgenabled = 'O' and not t.tgisinternal),
    'answers_in_plaintext', (select count(*) from jex_users
                              where sec_a is not null and sec_a !~ '^[0-9a-f]{64}$'))

)) as preflight;
