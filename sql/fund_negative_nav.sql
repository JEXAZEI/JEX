-- ============================================================
-- fund_negative_nav.sql
--
-- A fund unit can be worth less than nothing, and then every fund operation
-- does something wrong.
--
-- jex_fund_nav is cash + holdings + short P&L + short collateral, over units
-- outstanding. A short contributes `qty * (2.5*entry - price)` to that, so it
-- turns negative once the stock passes 2.5x the entry price. Past that, if the
-- shortfall is bigger than the fund's cash and holdings, the NAV itself goes
-- negative. Nothing stops a fund getting there: `rpc_margin_call_short` takes
-- a p_user_id and reads jex_users, and checkMarginCalls() in the browser walks
-- DB.users -- there is no fund-side margin call anywhere in this database.
--
-- Measured against the live function bodies running locally. A fund with
-- $5,000 cash, 1,000 units outstanding, short 1,000 shares entered at $5.00
-- with $7,500 posted, against a $30.00 price. NAV per unit: -$12.50.
--
--   an investor withdraws 1,000 units
--       receives -$12,500.00 -- their cash goes 20,000 -> 7,500
--       They are CHARGED $12,500 to leave a fund in which they had already
--       lost everything.
--
--   the same investor with $100 to their name
--       ERROR: violates "chk_users_cash_nonneg"
--       They cannot leave at all. The position is permanent.
--
--   somebody else deposits $1,000 into it
--       receives -80.0000 units, costBasis -12.5000
--       and the fund's units_outstanding goes DOWN, 1,000 -> 920.
--       They paid $1,000 for a negative holding.
--
-- rpc_fund_withdraw has a guard meant to catch exactly this kind of thing:
--
--     if v_fund.cash < v_gross then raise exception '... not enough
--       uninvested cash ...'
--
-- With v_gross negative, `cash < gross` is false and it sails straight
-- through. The guard was written for a gross that is too big, and a negative
-- one is smaller than everything.
--
-- ── The fix ──
--
-- A unit is floored at zero. An investor in a fund that has lost more than it
-- holds loses what they put in, and not a cent more -- which is what every
-- other balance in this database already assumes (jex_users.cash,
-- jex_funds.cash and jex_funds.units_outstanding all carry CHECK (>= 0)).
--
--   withdrawing at a floored NAV pays $0.00, burns the units and releases
--   the investor. No error, nothing trapped.
--
--   depositing into a fund whose units are worth nothing is refused with a
--   readable message rather than dividing by zero.
--
-- The shortfall is written off, the same way `cover_short_safety.sql` writes
-- off a blown short and the same way rpc_margin_call_short already did. That
-- is deliberate and it is the whole point: the alternative, measured above, is
-- a student who is charged to leave or cannot leave.
--
-- ── It also feeds the graded number ──
--
-- rpc_snapshot_nw values a student's fund units at
-- `units * jex_fund_nav(fund)` and writes the result to jex_nw_history. With
-- a negative NAV that term drags the GRADED net worth down by money the
-- student never had at risk. Flooring the NAV fixes that too, at the source,
-- for all three callers at once.
--
-- ── What this does NOT fix ──
--
-- A fund still has no margin call. This makes the consequences survivable; it
-- does not stop the fund getting there. Adding a fund-side margin caller, or
-- capping what a fund may short, is a decision about how the class should run.
--
-- Safe to run twice. Aborts and changes nothing if any anchor count is wrong.
-- ============================================================

do $mig$
declare
  r record;
  v_src text;
  v_nl  text;
  v_n   int;
begin
  -- ── jex_fund_nav: floor a unit at zero ──
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'jex_fund_nav';
  if r is null then
    raise exception 'ABORT: jex_fund_nav not found. Nothing changed.';
  end if;

  if position('greatest(0, round((' in r.prosrc) > 0 then
    raise notice 'jex_fund_nav already floors a unit at zero -- skipped.';
  else
    v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

    v_n := (length(r.prosrc) - length(replace(r.prosrc, 'then round((', '')))
           / length('then round((');
    if v_n <> 1 then
      raise exception 'ABORT: expected the NAV expression opener exactly once in jex_fund_nav, found %. Nothing changed.', v_n;
    end if;
    v_n := (length(r.prosrc) - length(replace(r.prosrc, ') / f.units_outstanding, 4)', '')))
           / length(') / f.units_outstanding, 4)');
    if v_n <> 1 then
      raise exception 'ABORT: expected the NAV divisor exactly once in jex_fund_nav, found %. Nothing changed.', v_n;
    end if;

    v_src := replace(r.prosrc, 'then round((', 'then greatest(0, round((');
    v_src := replace(v_src, ') / f.units_outstanding, 4)', ') / f.units_outstanding, 4))');
    execute replace(r.def, r.prosrc, v_src);
    raise notice 'jex_fund_nav: a unit can no longer be worth less than nothing.';
  end if;

  -- ── rpc_fund_deposit: refuse to price units off a zero NAV ──
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_fund_deposit';
  if r is null then
    raise exception 'ABORT: rpc_fund_deposit not found. Nothing changed.';
  end if;

  if position('if v_nav is null or v_nav <= 0 then' in r.prosrc) > 0 then
    raise notice 'rpc_fund_deposit already refuses a worthless fund -- skipped.';
  else
    v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

    v_n := (length(r.prosrc) - length(replace(r.prosrc, 'v_units_to_mint := round(p_amount / v_nav, 4);', '')))
           / length('v_units_to_mint := round(p_amount / v_nav, 4);');
    if v_n <> 1 then
      raise exception 'ABORT: expected the minting line exactly once in rpc_fund_deposit, found %. Nothing changed.', v_n;
    end if;

    execute replace(r.def, r.prosrc, replace(r.prosrc,
      'v_units_to_mint := round(p_amount / v_nav, 4);',
      '-- With the NAV floored at zero this is reachable, and dividing by it' || v_nl ||
      '  -- would be a bare division-by-zero. Before the floor it was worse: a' || v_nl ||
      '  -- negative NAV minted NEGATIVE units. Measured -- $1,000 deposited' || v_nl ||
      '  -- into a fund at -$12.50 a unit bought -80.0000 units and took the' || v_nl ||
      '  -- fund''s units outstanding DOWN from 1,000 to 920.' || v_nl ||
      '  if v_nav is null or v_nav <= 0 then' || v_nl ||
      '    raise exception ''%'', format(''%s has lost more than it holds, so a unit is worth nothing right now and there is no price to buy in at. The manager has to cover its shorts or sell holdings first.'', v_fund.name);' || v_nl ||
      '  end if;' || v_nl ||
      v_nl ||
      '  v_units_to_mint := round(p_amount / v_nav, 4);'));
    raise notice 'rpc_fund_deposit: a worthless fund is refused instead of minting negative units.';
  end if;
end
$mig$;

-- ── verification ──
--
-- nav_floored         a unit can no longer be negative
-- deposit_guarded     depositing into a worthless fund is refused
-- funds_now           every fund, its NAV, and whether it is underwater. A
--                     fund showing underwater = true had a negative NAV
--                     before this ran, and its investors were being charged
--                     to leave.
-- investors_affected  how many students hold units in such a fund
-- worst_unit_value    the most negative a unit was, before the floor --
--                     computed here without it, so it reports the real state
--                     rather than the fixed one
select
  (select position('greatest(0, round((' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'jex_fund_nav')                as nav_floored,

  (select position('if v_nav is null or v_nav <= 0 then' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_fund_deposit')            as deposit_guarded,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'fund', f.name, 'manager', f.manager_name, 'status', f.status,
            'cash', f.cash, 'units_outstanding', f.units_outstanding,
            'nav_now', jex_fund_nav(f.id),
            'raw_unit_value', raw.v,
            'underwater', coalesce(raw.v, 0) < 0) order by f.name), '[]'::jsonb)
     from jex_funds f
     cross join lateral (select case when f.units_outstanding > 0 then round((
         coalesce(f.cash, 0)
       + coalesce((select sum(c.price * (f.holdings->>c.ticker)::numeric)
                     from jex_companies c where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0)
       + coalesce((select sum(round((s.value->>'avgPrice')::numeric - c.price, 2) * (s.value->>'qty')::numeric)
                     from jsonb_each(coalesce(f.shorts,'{}'::jsonb)) s
                     join jex_companies c on c.ticker = s.key), 0)
       + coalesce((select sum((s.value->>'collateral')::numeric)
                     from jsonb_each(coalesce(f.shorts,'{}'::jsonb)) s), 0)
       ) / f.units_outstanding, 4) else 10 end as v) raw)                     as funds_now,

  (select count(*) from jex_users u, lateral jsonb_each(coalesce(u.fund_units,'{}'::jsonb)) k(fid, v)
    where coalesce((v->>'units')::numeric, 0) > 0)                            as investors_holding_units,

  (select count(*) from jex_funds f
    where f.units_outstanding > 0
      and coalesce((select sum(round((s.value->>'avgPrice')::numeric - c.price, 2) * (s.value->>'qty')::numeric)
                      from jsonb_each(coalesce(f.shorts,'{}'::jsonb)) s
                      join jex_companies c on c.ticker = s.key), 0) < 0)      as funds_with_a_losing_short;
