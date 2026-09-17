-- ============================================================
-- cover_short_safety.sql
--
-- Two faults in the two functions that close a short position.
--
-- ── 1. A fund covering a short ignores the price band ──
--
-- rpc_trade_cover_short clamps the price it fills at:
--
--     v_cp := greatest(0.01, round(v_co.price * (1 + v_impact), 2));
--     v_cp := jex_band_clamp(v_co.ticker, v_cp, v_co.price);
--
-- rpc_fund_cover_short computes the same v_cp and does NOT clamp it. A
-- student-run fund closing a short therefore pushes the price through the
-- ceiling where a student closing the identical position is held at it.
--
-- Measured. ACME opened at $30.00 with a 30% band ($21.00-$39.00) and had
-- drifted to $37.00. The same 800-share cover, same size, same stock:
--
--     a student covers    $39.00   held at the band
--     a fund covers       $41.44   through it
--
-- and then, with the price stranded outside its own band:
--
--     a student tries to BUY    refused, "outside price band"
--     a student tries to SELL   filled, at $41.38
--
-- which is the same frozen market the "Boost +50%" bug produced, arrived at
-- from a different direction. Every buy refused, every sell filled, until the
-- price drifts back down on its own.
--
-- ── 2. A short that loses more than its collateral cannot be closed ──
--
-- Both cover functions settle as collateral-back plus P&L with no floor:
--
--     v_cash := round(v_cash + v_cb + v_pnl, 2)
--
-- When the loss exceeds the collateral plus the holder's cash, that number is
-- negative. For a student, jex_users has CHECK (cash >= 0), so the UPDATE
-- raises and the whole cover fails -- the student cannot get out of the
-- position at all, ever, by any route the app offers. For a fund, jex_funds
-- has no such constraint, so it silently goes negative instead.
--
-- Measured, on a 1,000-share short entered at $5.00 with $7,500 collateral
-- and $5,000 of cash, against a $30.00 price:
--
--     student   ERROR: new row violates check constraint
--               "chk_users_cash_nonneg" -- position stuck
--     fund      cash: -$16,100.00, no error, no warning
--
-- rpc_margin_call_short already settles a blown short with
-- `greatest(0, round(cash + collateral + pnl, 2))`, and its comment says why:
-- "a band clamp or a rounding edge can never leave a student with negative
-- cash". The two cover paths are made to agree with it.
--
-- What that means in plain terms: if a short loses more than the collateral
-- and the cash behind it, the position closes, the holder is taken to zero,
-- and the shortfall is written off. That is already the rule when the margin
-- caller does it. This makes it the rule when the holder does it themselves,
-- instead of trapping them. It is a forgiving rule and it is deliberate --
-- the alternative measured above is a student who can never close a position.
--
-- Safe to run twice. Aborts and changes nothing if any anchor count is wrong.
-- ============================================================

do $mig$
declare
  r record;
  v_src text;
  v_nl  text;
  v_n   int;
  v_done_clamp boolean := false;
  v_done_floor boolean := false;
begin
  -- ── rpc_fund_cover_short: the band clamp, and the cash floor ──
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_fund_cover_short';
  if r is null then
    raise exception 'ABORT: rpc_fund_cover_short not found. Nothing changed.';
  end if;

  v_src := r.prosrc;
  v_nl  := case when position(chr(13) in v_src) > 0 then chr(13) || chr(10) else chr(10) end;

  if position('v_cp := jex_band_clamp(v_co.ticker, v_cp, v_co.price);' in v_src) > 0 then
    raise notice 'rpc_fund_cover_short already clamps to the band -- skipped.';
  else
    v_n := (length(v_src) - length(replace(v_src, 'v_cp := greatest(0.01, round(v_co.price * (1 + v_impact), 2));', '')))
           / length('v_cp := greatest(0.01, round(v_co.price * (1 + v_impact), 2));');
    if v_n <> 1 then
      raise exception 'ABORT: expected the impact line exactly once in rpc_fund_cover_short, found %. Nothing changed.', v_n;
    end if;
    v_src := replace(v_src,
      'v_cp := greatest(0.01, round(v_co.price * (1 + v_impact), 2));',
      'v_cp := greatest(0.01, round(v_co.price * (1 + v_impact), 2));' || v_nl ||
      '  -- Clamped exactly as rpc_trade_cover_short clamps it. Without this a' || v_nl ||
      '  -- fund pushed a $37.00 stock to $41.44 against a $39.00 ceiling, and' || v_nl ||
      '  -- every buy was then refused while every sell filled.' || v_nl ||
      '  v_cp := jex_band_clamp(v_co.ticker, v_cp, v_co.price);');
    v_done_clamp := true;
  end if;

  if position('greatest(0, round(v_fund.cash + v_cb + v_pnl, 2))' in v_src) > 0 then
    raise notice 'rpc_fund_cover_short already floors the settlement -- skipped.';
  else
    v_n := (length(v_src) - length(replace(v_src, 'round(v_fund.cash + v_cb + v_pnl, 2)', '')))
           / length('round(v_fund.cash + v_cb + v_pnl, 2)');
    if v_n <> 4 then
      raise exception 'ABORT: expected the fund settlement 4 times in rpc_fund_cover_short, found %. Nothing changed.', v_n;
    end if;
    v_src := replace(v_src,
      'round(v_fund.cash + v_cb + v_pnl, 2)',
      'greatest(0, round(v_fund.cash + v_cb + v_pnl, 2))');
    v_done_floor := true;
  end if;

  if v_src <> r.prosrc then
    execute replace(r.def, r.prosrc, v_src);
    raise notice 'rpc_fund_cover_short updated (band clamp: %, cash floor: %).', v_done_clamp, v_done_floor;
  end if;

  -- ── rpc_trade_cover_short: the cash floor, both branches ──
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_trade_cover_short';
  if r is null then
    raise exception 'ABORT: rpc_trade_cover_short not found. Nothing changed.';
  end if;

  if position('v_cash := greatest(0, round(v_cash + v_cb + v_pnl, 2));' in r.prosrc) > 0 then
    raise notice 'rpc_trade_cover_short already floors the settlement -- skipped.';
  else
    v_n := (length(r.prosrc) - length(replace(r.prosrc, 'v_cash := round(v_cash + v_cb + v_pnl, 2);', '')))
           / length('v_cash := round(v_cash + v_cb + v_pnl, 2);');
    if v_n <> 2 then
      raise exception 'ABORT: expected the settlement twice in rpc_trade_cover_short (index branch and ordinary branch), found %. Nothing changed.', v_n;
    end if;
    execute replace(r.def, r.prosrc, replace(r.prosrc,
      'v_cash := round(v_cash + v_cb + v_pnl, 2);',
      'v_cash := greatest(0, round(v_cash + v_cb + v_pnl, 2));'));
    raise notice 'rpc_trade_cover_short: a blown short now closes at zero instead of failing.';
  end if;
end
$mig$;

-- ── verification ──
--
-- fund_cover_clamps      a fund now fills a cover inside the band
-- fund_cover_floored     a fund can no longer be driven to negative cash
-- student_cover_floored  a student can always close a short
-- stranded_tickers       anything sitting outside its own band right now
--                        (these were already frozen to buyers; they unfreeze
--                        as the price drifts back, or an officer can adjust)
-- open_shorts_underwater positions whose loss already exceeds their
--                        collateral -- these are the ones that were stuck
select
  (select position('v_cp := jex_band_clamp(v_co.ticker, v_cp, v_co.price);' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_fund_cover_short')        as fund_cover_clamps,

  (select position('greatest(0, round(v_fund.cash + v_cb + v_pnl, 2))' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_fund_cover_short')        as fund_cover_floored,

  (select position('v_cash := greatest(0, round(v_cash + v_cb + v_pnl, 2));' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_trade_cover_short')       as student_cover_floored,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker, 'price', c.price,
            'band', round(o.open_price * (1 - s.price_band_pct/100), 2)::text || ' .. ' ||
                    round(o.open_price * (1 + s.price_band_pct/100), 2)::text) order by c.ticker), '[]'::jsonb)
     from jex_companies c
     join jex_session s on s.id = 1
     cross join lateral (select (s.session_open_prices->>c.ticker)::numeric as open_price) o
    where c.status = 'listed' and o.open_price is not null
      and (c.price > round(o.open_price * (1 + s.price_band_pct/100), 2)
        or c.price < round(o.open_price * (1 - s.price_band_pct/100), 2)))    as stranded_tickers,

  (select coalesce(jsonb_agg(x ORDER BY x->>'who'), '[]'::jsonb) from (
     select jsonb_build_object(
              'who', u.name, 'ticker', k.t, 'qty', (k.v->>'qty')::numeric,
              'avg', (k.v->>'avgPrice')::numeric, 'collateral', (k.v->>'collateral')::numeric,
              'loss_now', round((c.price - (k.v->>'avgPrice')::numeric) * (k.v->>'qty')::numeric, 2)) as x
       from jex_users u, lateral jsonb_each(coalesce(u.shorts, '{}'::jsonb)) k(t, v)
       join jex_companies c on c.ticker = k.t
      where (c.price - (k.v->>'avgPrice')::numeric) * (k.v->>'qty')::numeric
            > coalesce((k.v->>'collateral')::numeric, 0)
     union all
     select jsonb_build_object(
              'who', 'fund: ' || f.name, 'ticker', k.t, 'qty', (k.v->>'qty')::numeric,
              'avg', (k.v->>'avgPrice')::numeric, 'collateral', (k.v->>'collateral')::numeric,
              'loss_now', round((c.price - (k.v->>'avgPrice')::numeric) * (k.v->>'qty')::numeric, 2))
       from jex_funds f, lateral jsonb_each(coalesce(f.shorts, '{}'::jsonb)) k(t, v)
       join jex_companies c on c.ticker = k.t
      where (c.price - (k.v->>'avgPrice')::numeric) * (k.v->>'qty')::numeric
            > coalesce((k.v->>'collateral')::numeric, 0)
   ) q)                                                                       as open_shorts_underwater,

  (select count(*) from jex_funds where coalesce(cash, 0) < 0)                as funds_already_negative;
