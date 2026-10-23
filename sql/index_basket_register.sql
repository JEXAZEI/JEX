-- ============================================================
-- index_basket_register.sql
--
-- ** THIS ONE CHANGES DATA, NOT A FUNCTION. READ IT FIRST. **
--
-- repair_share_register.sql assumed every share is either unsold
-- (shares_avail), held by a person (jex_users.holdings) or held by a fund
-- (jex_funds.holdings). There is a fourth place: the index basket. Buying JXI
-- or a classroom index buys real shares of every constituent out of the
-- unsold pool and keeps them in the index row's fund_holdings, so
--
--     shares = shares_avail + held_by_users + held_by_funds + held_by_indexes
--
-- The repair left the last term out, counted the basket as "missing", and put
-- it back on sale. Those shares then existed twice: in the basket and in the
-- pool. Run on a scratch copy: TCO1 with 500 issued, 496 unsold and 4 in the
-- basket was "repaired" to 500 unsold -- 504 shares of a 500-share company.
--
-- The production numbers it reported fit this exactly: 4 each on TCO1,
-- TCO1.B and TCO2 with nobody holding any, and 9 on AZEI -- the even split an
-- equal-weight index basket makes.
--
-- ── What this does ──
--
-- For each listed company where unsold + held + basket is MORE than issued,
-- lowers shares_avail by the excess, never below 0. Those are shares that
-- exist twice; the copy removed is the one nobody owns. No cash moves, no
-- holding changes, no trade is written.
--
-- It never raises shares_avail, and it does not touch a company that balances
-- or is short. Running it twice is a no-op.
--
-- preflight.sql's shares_unaccounted_for now counts the basket too, so it
-- stops reporting a "leak" after every index purchase.
-- ============================================================

do $repair$
declare
  r record;
  v_fixed jsonb := '{}'::jsonb;
  v_left  jsonb := '{}'::jsonb;
  v_cut   integer;
begin
  for r in
    select c.ticker, c.shares, c.shares_avail, h.u, h.f, h.idx,
           c.shares_avail + h.u + h.f + h.idx - c.shares as excess
      from jex_companies c
      cross join lateral (
        select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                          where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as u,
               coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                          where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as f,
               coalesce((select sum((x.fund_holdings->>c.ticker)::numeric) from jex_companies x
                          where coalesce(x.is_index_fund, false)
                            and coalesce(x.fund_holdings,'{}'::jsonb) ? c.ticker), 0) as idx) h
     where c.status = 'listed' and not coalesce(c.is_index_fund, false)
     order by c.ticker
       for update of c
  loop
    continue when r.excess <= 0;
    v_cut := least(r.excess, r.shares_avail)::integer;
    if v_cut > 0 then
      update jex_companies set shares_avail = shares_avail - v_cut where ticker = r.ticker;
      v_fixed := jsonb_set(v_fixed, array[r.ticker], jsonb_build_object(
        'unsold_was', r.shares_avail, 'unsold_now', r.shares_avail - v_cut,
        'in_index_baskets', r.idx, 'removed_duplicates', v_cut));
    end if;
    if r.excess > v_cut then
      -- Still over after emptying the pool: more is owned than was issued.
      -- A different fault; reported, not touched.
      v_left := jsonb_set(v_left, array[r.ticker], jsonb_build_object('still_over_by', r.excess - v_cut));
    end if;
  end loop;

  if v_fixed = '{}'::jsonb then
    raise notice 'No share is counted twice -- nothing changed.';
  else
    raise notice 'Removed duplicate unsold shares: %', v_fixed;
  end if;
  if v_left <> '{}'::jsonb then
    raise notice 'NOT TOUCHED -- more owned than issued: %', v_left;
  end if;
end
$repair$;

-- ── verification ──
-- share_register   per listed company: issued, unsold, held by people, by
--                  funds, by index baskets. Every `unaccounted` should be 0.
-- total_unaccounted should be 0.
select
  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker, 'issued', c.shares, 'unsold', c.shares_avail,
            'held_by_users', h.u, 'held_by_funds', h.f, 'in_index_baskets', h.idx,
            'unaccounted', c.shares - c.shares_avail - h.u - h.f - h.idx)
          order by c.ticker), '[]'::jsonb)
     from jex_companies c
     cross join lateral (
       select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                         where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as u,
              coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                         where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as f,
              coalesce((select sum((x.fund_holdings->>c.ticker)::numeric) from jex_companies x
                         where coalesce(x.is_index_fund, false)
                           and coalesce(x.fund_holdings,'{}'::jsonb) ? c.ticker), 0) as idx) h
    where c.status = 'listed' and not coalesce(c.is_index_fund, false))      as share_register,
  (select coalesce(sum(c.shares - c.shares_avail - h.u - h.f - h.idx), 0)
     from jex_companies c
     cross join lateral (
       select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                         where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as u,
              coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                         where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as f,
              coalesce((select sum((x.fund_holdings->>c.ticker)::numeric) from jex_companies x
                         where coalesce(x.is_index_fund, false)
                           and coalesce(x.fund_holdings,'{}'::jsonb) ? c.ticker), 0) as idx) h
    where c.status = 'listed' and not coalesce(c.is_index_fund, false))      as total_unaccounted;
