-- ============================================================
-- index_constituents.sql
--
-- WRITES. Rewrites two small functions. Aborts and changes nothing on any
-- mismatch. Re-running is a no-op.
--
-- !! THIS ONE MOVES A PRICE. Read the verification before and after. !!
--
-- ── What is wrong ──
--
-- The index the app SHOWS and the index students TRADE at are different
-- numbers.
--
-- JXI is tradeable -- rpc_trade_buy's index branch mints units at
-- index_live_value(...) divided by the unit divisor -- so these two are the
-- price on the screen and the price on the receipt.
--
-- The client's computeIndex() takes the average of price / (first recorded
-- price * index_base_adjust) across every LISTED company, excluding three
-- things on purpose:
--
--   * index funds themselves      (an index of itself is circular)
--   * RESTRICTED share classes    (not everyone may trade them, so they do not
--                                  belong in a number everyone is measured by)
--   * TEST-account companies      (hidden from students everywhere else,
--                                  unless dev_mode is on)
--
-- and scoping to one classroom when asked.
--
-- index_live_value() excludes only the first. It counts restricted classes and
-- test companies, and it takes p_classroom_id as an argument and never looks
-- at it -- so every classroom-scoped index created by
-- rpc_admin_create_classroom_index is priced off the whole exchange.
-- index_constituent_tickers() has the identical body and the identical gaps.
--
-- Measured on a copy of this database. Five listed tickers: ACME and BETA at
-- ratio 1.0 in room_a, GAMA at 2.5 in room_b, a restricted ACME.R at 0.2, and
-- a test company TEST at 9.0.
--
--                       the client shows     the server trades at
--   whole exchange           1500                   2740
--   room_a                   1000                   2740
--   room_b                   2500                   2740
--
-- A student buying index units sees 15.00 on the card and is charged 27.40 --
-- 83% more -- and sells back at the same wrong number. The one instrument in
-- the app that is supposed to teach diversification is the one quoting a price
-- it does not honour.
--
-- ── The fix ──
--
-- The server applies the same three exclusions and finally reads the classroom
-- it is handed. The client is the reference because its exclusions are the
-- deliberate ones: a restricted class is not something every student can buy,
-- and a test company is invisible to them.
--
-- dev_mode is honoured the same way the client honours it: with dev_mode on,
-- test companies COUNT, because that is the mode where they are visible.
--
-- ── What will visibly change ──
--
-- If this exchange has any test company or any restricted share class listed,
-- JXI's level MOVES when this runs -- to the number the app has been showing
-- all along. The verification prints the before and after so it is not a
-- surprise. Nothing is minted or burned by the change itself; units already
-- held are simply repriced to the honest number.
--
-- ── Method ──
--
-- Both functions are one statement each, so their ENTIRE current bodies are
-- asserted byte-for-byte before anything is replaced, and both are rebuilt
-- through pg_get_functiondef so the signature, volatility and any SET clause
-- return exactly as they are. Eight callers -- rpc_trade_buy, rpc_trade_sell,
-- rpc_fund_buy, rpc_fund_sell, rpc_fund_short, rpc_place_limit_order,
-- rpc_review_ipo and jxi_live_value -- are untouched.
-- ============================================================

do $mig$
declare
  r record;
  v_old text; v_new text;
  v_expect_value constant text :=
'
 select round(avg(case when coalesce((c.price_history->0->>''p'')::numeric,0)*coalesce(c.index_base_adjust,1) > 0
   then c.price/((c.price_history->0->>''p'')::numeric*coalesce(c.index_base_adjust,1)) else 1 end)*1000,2)
 from jex_companies c where c.status=''listed'' and coalesce(c.is_index_fund,false)=false ';
  v_expect_tick constant text :=
' select ticker from jex_companies where status=''listed'' and coalesce(is_index_fund,false)=false ';

  -- The three exclusions, written once and used by both.
  v_filter constant text :=
'
   and not exists (select 1 from jex_share_classes sc
                    where sc.ticker = c.ticker and coalesce(sc.restricted, false))
   and not exists (select 1 from jex_users u
                    where u.id = c.owner_id and coalesce(u.is_test_account, false)
                      and not coalesce((select dev_mode from jex_session where id = 1), false))
   and (p_classroom_id is null
        or exists (select 1 from jex_users u
                    where u.id = c.owner_id and u.classroom_id = p_classroom_id))';
begin
  -- ── the level ──
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'index_live_value';
  if r.proname is null then raise exception 'ABORT: index_live_value not found.'; end if;

  if position('p_classroom_id is null' in r.prosrc) > 0 then
    raise notice '  index_live_value already matches the client -- skipped';
  else
    v_old := replace(r.prosrc, chr(13), '');
    if v_old <> v_expect_value then
      raise exception 'ABORT: index_live_value does not match the expected body (% chars vs %). Nothing changed.',
        length(v_old), length(v_expect_value);
    end if;

    v_new :=
'
 -- The same three exclusions the client''s computeIndex() applies, and the
 -- classroom this is handed -- which used to be accepted and ignored, so every
 -- classroom index was priced off the whole exchange. A restricted class is
 -- not something every student may buy and a test company is invisible to
 -- them, so neither belongs in a number everyone is measured by and charged
 -- at. Measured before this: the app showed 1500 and charged 2740.
 select round(avg(case when coalesce((c.price_history->0->>''p'')::numeric,0)*coalesce(c.index_base_adjust,1) > 0
   then c.price/((c.price_history->0->>''p'')::numeric*coalesce(c.index_base_adjust,1)) else 1 end)*1000,2)
 from jex_companies c where c.status=''listed'' and coalesce(c.is_index_fund,false)=false'
   || v_filter || ' ';

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  index_live_value: restricted classes and test companies out, the classroom in';
  end if;

  -- ── and the constituent list, which has the identical gaps ──
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'index_constituent_tickers';
  if r.proname is null then raise exception 'ABORT: index_constituent_tickers not found.'; end if;

  if position('p_classroom_id is null' in r.prosrc) > 0 then
    raise notice '  index_constituent_tickers already matches the client -- skipped';
  else
    v_old := replace(r.prosrc, chr(13), '');
    if v_old <> v_expect_tick then
      raise exception 'ABORT: index_constituent_tickers does not match the expected body (% chars vs %). Nothing changed.',
        length(v_old), length(v_expect_tick);
    end if;

    v_new := ' select c.ticker from jex_companies c where c.status=''listed'' and coalesce(c.is_index_fund,false)=false'
      || v_filter || ' ';

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  index_constituent_tickers: the same list the client draws the chart from';
  end if;
end
$mig$;

-- ── Verification ──
--
-- The first three must be true.
--
-- value_reads_the_classroom   a classroom index is priced off that classroom.
-- value_skips_restricted      a whitelist-only class is out of the average...
-- value_skips_test_accounts   ...and so is a test company, unless dev_mode.
--
-- index_level_now is the number to read, and it is the point of the whole
-- file. `was` is what the index was charging before; `now` is what the app has
-- been showing. If they differ, JXI's price has just moved to the honest
-- number -- expected, not a fault -- and `unit_price_now` is what a unit costs
-- from this moment.
--
-- excluded_now lists every ticker that has just left the index and why, so the
-- move can be accounted for rather than wondered about.
select
  (select prosrc like '%p_classroom_id is null%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='index_live_value')                    as value_reads_the_classroom,
  (select prosrc like '%coalesce(sc.restricted, false)%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='index_live_value')                    as value_skips_restricted,
  (select prosrc like '%coalesce(u.is_test_account, false)%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='index_live_value')                    as value_skips_test_accounts,
  jsonb_build_object(
    'was', (select round(avg(case when coalesce((c.price_history->0->>'p')::numeric,0)*coalesce(c.index_base_adjust,1) > 0
              then c.price/((c.price_history->0->>'p')::numeric*coalesce(c.index_base_adjust,1)) else 1 end)*1000,2)
              from jex_companies c where c.status='listed' and coalesce(c.is_index_fund,false)=false),
    'now', index_live_value(null),
    'unit_price_now', round(coalesce(index_live_value(null),1000) / jex_index_unit_divisor(), 2),
    'units_held_by_students', coalesce((select sum((u.holdings->>c.ticker)::numeric)
                                          from jex_users u, jex_companies c
                                         where coalesce(c.is_index_fund,false)
                                           and coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0)
  )                                                                               as index_level_now,
  (select coalesce(jsonb_agg(jsonb_build_object('ticker', c.ticker, 'price', c.price,
            'why', case when exists (select 1 from jex_share_classes sc
                                      where sc.ticker = c.ticker and coalesce(sc.restricted,false))
                        then 'restricted share class' else 'test account' end)
          order by c.ticker), '[]'::jsonb)
     from jex_companies c
    where c.status = 'listed' and not coalesce(c.is_index_fund, false)
      and (exists (select 1 from jex_share_classes sc
                    where sc.ticker = c.ticker and coalesce(sc.restricted, false))
        or exists (select 1 from jex_users u
                    where u.id = c.owner_id and coalesce(u.is_test_account, false))))   as excluded_now;
