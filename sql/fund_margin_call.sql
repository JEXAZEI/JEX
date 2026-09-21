-- ============================================================
-- fund_margin_call.sql
--
-- A fund's short has no safety net. This adds one.
--
-- rpc_margin_call_short takes a p_user_id and reads jex_users. There is no
-- fund equivalent anywhere in this database, and checkMarginCalls() in app.js
-- walks DB.users only. So a student-run fund can hold a short with nothing
-- watching it, while the identical position held by a student directly gets
-- closed automatically once it has eaten 80% of its collateral.
--
-- That is what lets a fund reach the state fund_negative_nav.sql had to make
-- survivable. A short contributes qty * (2.5*entry - price) to a fund's AUM,
-- so past 2.5x the entry the position is worth less than the collateral
-- behind it, and past that the whole NAV goes to zero and every investor in
-- the fund is wiped out. Those two migrations stopped that being CATASTROPHIC
-- -- nobody gets charged to leave, nobody gets trapped, no negative units get
-- minted. Neither of them stops it HAPPENING.
--
-- ── This is not a new policy ──
--
-- I flagged this as a decision for you rather than a bug fix, because it
-- looked like it needed an answer to "who eats the loss". It does not, any
-- more: the answer is already settled by the two fixes you have run.
--
--   cover_short_safety.sql   a blown cover settles at greatest(0, ...)
--   fund_negative_nav.sql    a unit is floored at zero
--
-- The investors eat it down to zero and not a cent further. All this function
-- does is apply the rule that is already in force, earlier, before the fund
-- gets there -- which is exactly what rpc_margin_call_short does for a
-- student. It is a mirror, line for line, of the function you already run:
-- same 80% line, same impact model, same band clamp, same live index mark,
-- same greatest(0, ...) settlement.
--
-- ── What it does ──
--
--   loss = (mark - entry) * qty          mark is the live level for an index
--   trigger = collateral * 0.8
--   if loss < trigger: nothing happens, reports 'not_crossed'
--   otherwise: buy to close at the impact price, clamped to the band, release
--              the collateral, settle the P&L, floor the fund's cash at zero,
--              write a margin_call trade against 'fund:<id>'
--
-- Like the user-side one it is callable by anybody and re-derives everything
-- under a row lock, because there is no cron here -- every open browser is the
-- scheduler. Two clients noticing at once is fine: the second is told
-- 'not_crossed' because the first already removed the position.
--
-- ── Current exposure ──
--
-- Two funds on this exchange, holding $10.00 and $1,000.00, with no open
-- shorts between them. So this changes nothing today. It is here so the first
-- fund that does short something has the same protection a student does.
--
-- ── The client half ──
--
-- app.js now walks DB.funds in checkMarginCalls() alongside DB.users. Without
-- that this function exists but nothing ever calls it.
--
-- Safe to run twice: it is a CREATE OR REPLACE, and re-running replaces the
-- function with an identical body. It adds a function and changes no existing
-- one, so there is nothing for it to abort on.
-- ============================================================

create or replace function public.rpc_margin_call_fund_short(p_fund_id text, p_ticker text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_session_status text;
  v_co       record;
  v_fund     record;
  v_pos      jsonb;
  v_qty      numeric;
  v_avg      numeric;
  v_coll     numeric;
  v_loss     numeric;
  v_trigger  numeric;
  v_impact   numeric;
  v_new_price numeric;
  v_cost     numeric;
  v_pnl      numeric;
  v_shorts   jsonb;
  v_trade    jsonb;
begin
  select status into v_session_status from jex_session where id = 1;
  if v_session_status is distinct from 'open' then
    return jsonb_build_object('called', false, 'reason', 'session_not_open');
  end if;

  -- Companies first, then the fund. Every other path in this schema locks in
  -- that order and a margin call must not be the one that disagrees.
  select * into v_co from jex_companies where ticker = p_ticker for update;
  if v_co is null then
    return jsonb_build_object('called', false, 'reason', 'company_not_found');
  end if;

  if exists (select 1 from jex_halts where ticker = p_ticker) then
    return jsonb_build_object('called', false, 'reason', 'halted');
  end if;

  select * into v_fund from jex_funds where id = p_fund_id for update;
  if v_fund is null then
    return jsonb_build_object('called', false, 'reason', 'fund_not_found');
  end if;

  v_pos  := coalesce(v_fund.shorts, '{}'::jsonb) -> p_ticker;
  v_qty  := coalesce((v_pos->>'qty')::numeric, 0);
  v_avg  := coalesce((v_pos->>'avgPrice')::numeric, 0);
  v_coll := coalesce((v_pos->>'collateral')::numeric, 0);
  if v_qty <= 0 then
    return jsonb_build_object('called', false, 'reason', 'no_short');
  end if;

  -- jex_companies.price for an index row is a cache, rewritten only by a
  -- direct unit trade or by rpc_snapshot_jxi, so a margin call that reads it
  -- is looking at a historical number while the real level moves with every
  -- constituent. Same correction as rpc_margin_call_short.
  if coalesce(v_co.is_index_fund, false) then
    v_co.price := round(coalesce(index_live_value(v_co.index_classroom_id)
                                 / jex_index_unit_divisor(), v_co.price), 2);
  end if;

  v_loss    := (v_co.price - v_avg) * v_qty;
  v_trigger := v_coll * 0.8;
  if v_coll <= 0 or v_loss < v_trigger then
    return jsonb_build_object('called', false, 'reason', 'not_crossed',
      'loss', round(v_loss, 2), 'trigger', round(v_trigger, 2));
  end if;

  -- Buying to close pushes the price up, same impact model as any other buy,
  -- and clamped to the band like every other fill.
  v_impact := least((v_qty / greatest(v_co.shares * 0.05, 1)) * 0.015, 0.12);
  v_new_price := greatest(0.01, round(v_co.price * (1 + v_impact), 2));
  v_new_price := jex_band_clamp(v_co.ticker, v_new_price, v_co.price);
  -- An index unit has no float to move and no session band: it closes at the
  -- level, which is what rpc_fund_cover_short charges for the same position.
  if coalesce(v_co.is_index_fund, false) then v_new_price := v_co.price; end if;

  v_cost := round(v_new_price * v_qty, 2);
  v_pnl  := round((v_avg - v_new_price) * v_qty, 2);

  -- Release the collateral, settle the loss. The 80% line is what normally
  -- keeps this above zero; greatest() is the belt, and jex_funds carries
  -- CHECK (cash >= 0) so without it a blown call would raise instead of
  -- closing the position -- which is the trap cover_short_safety.sql removed
  -- from the voluntary path.
  v_shorts := coalesce(v_fund.shorts, '{}'::jsonb) - p_ticker;
  update jex_funds
     set cash   = greatest(0, round(v_fund.cash + v_coll + v_pnl, 2)),
         shorts = v_shorts
   where id = p_fund_id;

  update jex_companies
     set price = v_new_price,
         price_history = coalesce(price_history, '[]'::jsonb) ||
           jsonb_build_array(jsonb_build_object('p', v_new_price,
             't', to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
   where ticker = p_ticker;

  insert into jex_trades (ticker, qty, price, buyer_id, seller_id, type, ts)
  values (p_ticker, v_qty, v_new_price, 'fund:' || p_fund_id, 'cover', 'margin_call',
          to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI:SS AM'))
  returning to_jsonb(jex_trades.*) into v_trade;

  select * into v_fund from jex_funds where id = p_fund_id;
  select * into v_co   from jex_companies where ticker = p_ticker;

  return jsonb_build_object(
    'called', true,
    'fund_id', p_fund_id,
    'fund_name', v_fund.name,
    'manager_id', v_fund.manager_id,
    'ticker', p_ticker,
    'qty', v_qty,
    'avg_price', v_avg,
    'price', v_new_price,
    'collateral', v_coll,
    'pnl', v_pnl,
    'cost', v_cost,
    'fund_cash', v_fund.cash,
    'shorts', v_fund.shorts,
    'units_outstanding', v_fund.units_outstanding,
    'nav', jex_fund_nav(p_fund_id),
    'shares_avail', v_co.shares_avail,
    'price_history', v_co.price_history,
    'trade', v_trade);
end
$function$;

-- Same reach as the user-side margin caller and the other pollers: there is no
-- cron, so every open browser has to be able to run it for anybody.
grant execute on function public.rpc_margin_call_fund_short(text, text) to anon, authenticated;

-- ── verification ──
--
-- function_exists      it is installed
-- callable_by_clients  anon and authenticated can execute it, or no browser
--                      will ever be able to run it
-- mirrors_user_version the four things that must match the user-side caller:
--                      the 80% line, the band clamp, the live index mark and
--                      the greatest(0,...) settlement
-- fund_shorts_now      every open fund short, its loss against the live mark,
--                      and whether it is already past the line. Anything
--                      showing past_the_line = true will be closed by the
--                      next browser that looks.
-- funds_now            each fund's cash, units and NAV, as a before picture
select
  (select count(*) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_margin_call_fund_short')  as function_exists,

  (select exists (select 1 from unnest(coalesce(p.proacl::text[], array[]::text[])) a
                   where a like 'anon=%')
      and exists (select 1 from unnest(coalesce(p.proacl::text[], array[]::text[])) a
                   where a like 'authenticated=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_margin_call_fund_short')  as callable_by_clients,

  (select jsonb_build_object(
            'eighty_pct_line', position('v_coll * 0.8' in p.prosrc) > 0,
            'band_clamped',    position('jex_band_clamp(v_co.ticker' in p.prosrc) > 0,
            'index_marked_live', position('index_live_value(v_co.index_classroom_id' in p.prosrc) > 0,
            'floored_at_zero', position('greatest(0, round(v_fund.cash + v_coll + v_pnl, 2))' in p.prosrc) > 0)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_margin_call_fund_short')  as mirrors_user_version,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'fund', f.name, 'ticker', k.t,
            'qty', (k.v->>'qty')::numeric,
            'entry', (k.v->>'avgPrice')::numeric,
            'collateral', (k.v->>'collateral')::numeric,
            'mark', round(case when coalesce(c.is_index_fund,false)
                               then coalesce(index_live_value(c.index_classroom_id)
                                             / jex_index_unit_divisor(), c.price)
                               else c.price end, 2),
            'loss_now', round((case when coalesce(c.is_index_fund,false)
                                    then coalesce(index_live_value(c.index_classroom_id)
                                                  / jex_index_unit_divisor(), c.price)
                                    else c.price end - (k.v->>'avgPrice')::numeric)
                              * (k.v->>'qty')::numeric, 2),
            'call_line', round(coalesce((k.v->>'collateral')::numeric,0) * 0.8, 2),
            'past_the_line', (case when coalesce(c.is_index_fund,false)
                                   then coalesce(index_live_value(c.index_classroom_id)
                                                 / jex_index_unit_divisor(), c.price)
                                   else c.price end - (k.v->>'avgPrice')::numeric)
                             * (k.v->>'qty')::numeric
                             >= coalesce((k.v->>'collateral')::numeric,0) * 0.8)
          order by f.name, k.t), '[]'::jsonb)
     from jex_funds f, lateral jsonb_each(coalesce(f.shorts, '{}'::jsonb)) k(t, v)
     join jex_companies c on c.ticker = k.t)                                  as fund_shorts_now,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'fund', f.name, 'manager', f.manager_name, 'status', f.status,
            'cash', f.cash, 'units', f.units_outstanding,
            'nav', jex_fund_nav(f.id)) order by f.name), '[]'::jsonb)
     from jex_funds f)                                                        as funds_now;
