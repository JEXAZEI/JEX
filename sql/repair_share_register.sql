-- ============================================================
-- repair_share_register.sql
--
-- ** THIS ONE CHANGES DATA, NOT A FUNCTION. READ IT FIRST. **
--
-- Every other file in this directory rewrites a function and leaves your rows
-- alone. This one edits the share register: it puts back the shares that
-- `removed_user_shares.sql` explains the disappearance of. Run it only after
-- that file, and only if you agree with what it does.
--
-- ── What is wrong ──
--
-- Removing an account deleted the shares it held instead of returning them to
-- the company's unsold pool, so on every listed company:
--
--     shares  >  shares_avail + held_by_users + held_by_funds
--
-- As reported by officer_reset_guard.sql's verification:
--
--     AZEI     2,000 issued   1,262 unsold     729 held    9 unaccounted
--     TCO1       500 issued     496 unsold       0 held    4 unaccounted
--     TCO1.B     200 issued     196 unsold       0 held    4 unaccounted
--     TCO2       500 issued     496 unsold       0 held    4 unaccounted
--
-- 21 shares that exist nowhere. They are not lost value -- nobody is missing
-- money -- but the float is wrong: 9 shares of AZEI are counted as issued and
-- cannot be bought by anyone, and `shares` is the denominator for ownership
-- percentages and the index base.
--
-- ── What this does ──
--
--     shares_avail := shares - held_by_users - held_by_funds
--
-- for each listed company, and ONLY where that raises shares_avail. The
-- missing shares go back into the unsold pool, where they would have gone if
-- the leaver had sold them. Nobody is paid and nobody is charged: no cash
-- moves, no holding changes, no trade is written.
--
-- It never lowers shares_avail. If a company is over-accounted -- more shares
-- held than were ever issued -- that is a different fault with a different
-- cause, and this file reports it rather than papering over it by taking
-- shares away from whoever holds them.
--
-- Running it twice is a no-op: the second run finds nothing to raise.
--
-- ── What it does NOT do ──
--
-- It does not try to work out WHO held them or give them back to that person.
-- Those accounts are gone; there is nothing in the database that records what
-- a deleted row used to hold. Returning the shares to the pool is the only
-- honest reconstruction available, and it is a reconstruction -- if you would
-- rather leave the register as it is and let the numbers stand, not running
-- this is a perfectly reasonable choice. Nothing else depends on it.
-- ============================================================

do $repair$
declare
  r record;
  v_fixed jsonb := '{}'::jsonb;
  v_over  jsonb := '{}'::jsonb;
  v_total numeric := 0;
begin
  for r in
    select c.ticker, c.shares, c.shares_avail,
           h.u + h.f as held,
           c.shares - h.u - h.f as should_be
      from jex_companies c
      cross join lateral (
        select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                          where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as u,
               coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                          where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as f) h
     where c.status = 'listed' and not coalesce(c.is_index_fund, false)
     order by c.ticker
  loop
    if r.should_be < 0 then
      -- More held than issued. Not this bug; do not touch it.
      v_over := jsonb_set(v_over, array[r.ticker], jsonb_build_object(
        'issued', r.shares, 'held', r.held, 'over_by', -r.should_be));
      continue;
    end if;

    if r.should_be > r.shares_avail then
      update jex_companies
         set shares_avail = r.should_be::integer
       where ticker = r.ticker;
      v_total := v_total + (r.should_be - r.shares_avail);
      v_fixed := jsonb_set(v_fixed, array[r.ticker], jsonb_build_object(
        'unsold_was', r.shares_avail, 'unsold_now', r.should_be,
        'returned', r.should_be - r.shares_avail));
    end if;
  end loop;

  if v_fixed = '{}'::jsonb then
    raise notice 'Share register already balances -- nothing to repair.';
  else
    raise notice 'Returned % shares to the unsold pool: %', v_total, v_fixed;
  end if;
  if v_over <> '{}'::jsonb then
    raise notice 'NOT TOUCHED -- more shares held than issued: %', v_over;
  end if;
end
$repair$;

-- ── verification ──
--
-- share_register    issued / unsold / held for every listed company, and what
--                   is unaccounted for. Every `unaccounted` should now be 0.
-- total_missing     should be 0.
-- over_accounted    companies where MORE is held than was ever issued. Should
--                   be empty; if it is not, that is a separate fault and this
--                   file deliberately left it alone.
-- money_untouched   total cash across users and funds plus escrowed short
--                   collateral. This file moves no money, so compare it to
--                   whatever you had before -- it must be identical.
select
  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker, 'issued', c.shares, 'unsold', c.shares_avail,
            'held_by_users', h.u, 'held_by_funds', h.f,
            'unaccounted', c.shares - c.shares_avail - h.u - h.f)
          order by c.ticker), '[]'::jsonb)
     from jex_companies c
     cross join lateral (
       select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                         where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as u,
              coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                         where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as f) h
    where c.status = 'listed' and not coalesce(c.is_index_fund, false))        as share_register,

  (select coalesce(sum(c.shares - c.shares_avail - h.u - h.f), 0)
     from jex_companies c
     cross join lateral (
       select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                         where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as u,
              coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                         where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as f) h
    where c.status = 'listed' and not coalesce(c.is_index_fund, false))        as total_missing,

  (select coalesce(jsonb_agg(c.ticker order by c.ticker), '[]'::jsonb)
     from jex_companies c
     cross join lateral (
       select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                         where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as u,
              coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                         where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as f) h
    where c.status = 'listed' and not coalesce(c.is_index_fund, false)
      and c.shares - h.u - h.f < 0)                                            as over_accounted,

  round(
     coalesce((select sum(cash) from jex_users), 0)
   + coalesce((select sum(coalesce(cash, 0)) from jex_funds), 0)
   + coalesce((select sum(coalesce((v->>'collateral')::numeric, 0))
                 from jex_users u, lateral jsonb_each(coalesce(u.shorts,'{}'::jsonb)) k(t, v)), 0)
   + coalesce((select sum(coalesce((v->>'collateral')::numeric, 0))
                 from jex_funds f, lateral jsonb_each(coalesce(f.shorts,'{}'::jsonb)) k(t, v)), 0)
  , 2)                                                                         as money_untouched;
