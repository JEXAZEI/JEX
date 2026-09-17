-- ============================================================
-- index_margin_call.sql
--
-- The margin call cannot see an index short, and may not run at all.
--
-- ── 1. It marks the index at a stale price ──
--
-- rpc_margin_call_short decides whether a short has blown through its
-- collateral with:
--
--     v_loss := (v_co.price - v_avg) * v_qty;
--
-- For an ordinary company that is the live price. For the index it is not:
-- jex_companies.price for JXI is only rewritten when somebody actually trades
-- a unit of it. The real level lives in index_live_value(), which moves every
-- time any constituent moves. Between JXI trades the stored price is a
-- historical number.
--
-- Measured, on this database's own function bodies running locally. A student
-- shorts 1,000 JXI units at $15.00, putting up $22,500 of collateral. The
-- market then triples. Nobody trades JXI itself:
--
--     JXI stored price      $15.00
--     live index unit       $45.00
--     the short is down     $30,000 -- already past its $22,500 collateral
--     margin call says      {"loss": 0.00, "called": false,
--                            "reason": "not_crossed", "trigger": 18000.00}
--
-- The one mechanism that closes a runaway short is blind to the only
-- instrument on the exchange whose price can run away without a trade.
--
-- ── 2. It settles an index short on the wrong price model ──
--
-- If it does fire -- because somebody happened to trade a unit and refresh the
-- stored price -- it then prices the close as if the index had a float:
-- impact against jex_companies.shares, clamped to a price band. An index unit
-- has neither. A voluntary cover via rpc_trade_cover_short prices it off
-- index_live_value() with no impact and no band, so the two paths settle the
-- same position at different prices.
--
-- Both are fixed by marking the index live at the top and then using that mark
-- for the close, which is exactly what rpc_trade_cover_short does.
--
-- ── 3. It inserts a trade into a column type it assumes ──
--
--     v_trade_id bigint;
--     ...
--     returning id into v_trade_id;
--
-- Every other function in this database reads the inserted row back with
-- `returning to_jsonb(jex_trades.*) into v_trade`, which does not care what
-- type the id column is. This one function declares it a bigint. If
-- jex_trades.id is text or uuid, the RETURNING assignment raises
--
--     invalid input syntax for type bigint: "e5aad989-..."
--
-- and EVERY margin call fails, on every stock, index or not -- the function
-- gets as far as debiting the student and updating the price before it does.
-- That is what happened on the local copy, whose jex_trades.id is text.
--
-- I do not know which type the live jex_trades.id is, and I am not going to
-- guess: the rewrite below drops the typed variable and uses the same
-- `returning to_jsonb(...)` every other function uses, which is correct
-- either way. The verification reports the actual column type so the question
-- is answered rather than assumed. If it comes back `text`, margin calls have
-- never once completed on this exchange.
--
-- ── What this does NOT fix ──
--
-- rpc_margin_call_short is called from the browser (app.js), not by the
-- database. Nothing calls it on a schedule. A short only gets margin-called
-- while somebody has the app open with the trading screen live. That is a
-- design limit, not a bug, and changing it means adding a server-side job --
-- worth deciding on deliberately rather than as part of this fix.
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
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_margin_call_short';
  if r is null then
    raise exception 'ABORT: rpc_margin_call_short not found. Nothing changed.';
  end if;

  if position('if coalesce(v_co.is_index_fund, false) then' in r.prosrc) > 0 then
    raise notice 'rpc_margin_call_short already marks the index live -- skipped.';
    return;
  end if;

  v_src := r.prosrc;
  v_nl  := case when position(chr(13) in v_src) > 0 then chr(13) || chr(10) else chr(10) end;

  -- (a) mark the index live before the loss is computed
  v_n := (length(v_src) - length(replace(v_src, 'v_loss    := (v_co.price - v_avg) * v_qty;', '')))
         / length('v_loss    := (v_co.price - v_avg) * v_qty;');
  if v_n <> 1 then
    raise exception 'ABORT: expected the loss line exactly once, found %. Nothing changed.', v_n;
  end if;
  v_src := replace(v_src,
    'v_loss    := (v_co.price - v_avg) * v_qty;',
    '-- jex_companies.price for the index is only rewritten when somebody' || v_nl ||
    '  -- trades a unit, so between trades it is a historical number while the' || v_nl ||
    '  -- real level moves with every constituent. Measured: a 1,000-unit short' || v_nl ||
    '  -- $30,000 under water on $22,500 of collateral reported loss 0.00 and' || v_nl ||
    '  -- was never called. Mark it live, the same way a voluntary cover does.' || v_nl ||
    '  if coalesce(v_co.is_index_fund, false) then' || v_nl ||
    '    v_co.price := round(coalesce(index_live_value(v_co.index_classroom_id)' || v_nl ||
    '                                 / jex_index_unit_divisor(), v_co.price), 2);' || v_nl ||
    '  end if;' || v_nl ||
    v_nl ||
    '  v_loss    := (v_co.price - v_avg) * v_qty;');

  -- (b) close an index short at the level, not at an impact price in a band
  v_n := (length(v_src) - length(replace(v_src, 'v_new_price := jex_band_clamp(v_co.ticker, v_new_price, v_co.price);', '')))
         / length('v_new_price := jex_band_clamp(v_co.ticker, v_new_price, v_co.price);');
  if v_n <> 1 then
    raise exception 'ABORT: expected the band clamp exactly once, found %. Nothing changed.', v_n;
  end if;
  v_src := replace(v_src,
    'v_new_price := jex_band_clamp(v_co.ticker, v_new_price, v_co.price);',
    'v_new_price := jex_band_clamp(v_co.ticker, v_new_price, v_co.price);' || v_nl ||
    '  -- An index unit has no float to move and no session band: it closes at' || v_nl ||
    '  -- the level, which is what rpc_trade_cover_short charges for the same' || v_nl ||
    '  -- position. v_co.price is already the live mark by here.' || v_nl ||
    '  if coalesce(v_co.is_index_fund, false) then v_new_price := v_co.price; end if;');

  -- (c) stop assuming jex_trades.id is a bigint
  v_n := (length(v_src) - length(replace(v_src, 'returning id into v_trade_id;', '')))
         / length('returning id into v_trade_id;');
  if v_n <> 1 then
    raise exception 'ABORT: expected the RETURNING line exactly once, found %. Nothing changed.', v_n;
  end if;
  v_src := replace(v_src, 'returning id into v_trade_id;',
                          'returning to_jsonb(jex_trades.*) into v_trade;');

  v_n := (length(v_src) - length(replace(v_src, 'select to_jsonb(t) into v_trade from jex_trades t where t.id = v_trade_id;', '')))
         / length('select to_jsonb(t) into v_trade from jex_trades t where t.id = v_trade_id;');
  if v_n <> 1 then
    raise exception 'ABORT: expected the trade re-read exactly once, found %. Nothing changed.', v_n;
  end if;
  v_src := replace(v_src,
    'select to_jsonb(t) into v_trade from jex_trades t where t.id = v_trade_id;',
    '-- the insert above already returned the whole row, whatever type its id is');

  v_n := (length(v_src) - length(replace(v_src, 'v_trade_id bigint;', '')))
         / length('v_trade_id bigint;');
  if v_n = 1 then
    v_src := replace(v_src, 'v_trade_id bigint;',
                            'v_unused_trade_id bigint;  -- no longer used; jex_trades.id is not assumed');
  end if;

  execute replace(r.def, r.prosrc, v_src);
  raise notice 'rpc_margin_call_short: index shorts are now marked live and closed at the level.';
end
$mig$;

-- ── verification ──
--
-- marks_index_live      the trigger now reads index_live_value for the index
-- closes_at_the_level   and the close is priced off it, not off impact+band
-- trade_id_not_assumed  the bigint assumption is gone
-- trades_id_type        what jex_trades.id ACTUALLY is. If this says text or
--                       uuid, no margin call has ever completed on this
--                       exchange -- and every one that was attempted debited
--                       the student and moved the price before it failed.
-- index_shorts_open     open short positions in an index, and whether each is
--                       past the 80% line RIGHT NOW when marked live. Anything
--                       listed here should have been called already.
select
  (select position('if coalesce(v_co.is_index_fund, false) then' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_margin_call_short')       as marks_index_live,

  (select position('if coalesce(v_co.is_index_fund, false) then v_new_price := v_co.price; end if;' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_margin_call_short')       as closes_at_the_level,

  (select position('returning to_jsonb(jex_trades.*) into v_trade;' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_margin_call_short')       as trade_id_not_assumed,

  (select data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'jex_trades' and column_name = 'id')
                                                                              as trades_id_type,

  (select coalesce(jsonb_agg(x order by x->>'who'), '[]'::jsonb) from (
     select jsonb_build_object(
              'who', u.name, 'ticker', k.t,
              'qty', (k.v->>'qty')::numeric,
              'avg', (k.v->>'avgPrice')::numeric,
              'collateral', (k.v->>'collateral')::numeric,
              'stored_price', c.price,
              'live_mark', round(coalesce(index_live_value(c.index_classroom_id)
                                          / jex_index_unit_divisor(), c.price), 2),
              'loss_at_stored_price', round((c.price - (k.v->>'avgPrice')::numeric) * (k.v->>'qty')::numeric, 2),
              'loss_at_live_mark', round((round(coalesce(index_live_value(c.index_classroom_id)
                                          / jex_index_unit_divisor(), c.price), 2)
                                          - (k.v->>'avgPrice')::numeric) * (k.v->>'qty')::numeric, 2),
              'call_line_80pct', round(coalesce((k.v->>'collateral')::numeric, 0) * 0.8, 2)) as x
       from jex_users u, lateral jsonb_each(coalesce(u.shorts, '{}'::jsonb)) k(t, v)
       join jex_companies c on c.ticker = k.t and coalesce(c.is_index_fund, false)
     union all
     select jsonb_build_object(
              'who', 'fund: ' || f.name, 'ticker', k.t,
              'qty', (k.v->>'qty')::numeric,
              'avg', (k.v->>'avgPrice')::numeric,
              'collateral', (k.v->>'collateral')::numeric,
              'stored_price', c.price,
              'live_mark', round(coalesce(index_live_value(c.index_classroom_id)
                                          / jex_index_unit_divisor(), c.price), 2),
              'loss_at_stored_price', round((c.price - (k.v->>'avgPrice')::numeric) * (k.v->>'qty')::numeric, 2),
              'loss_at_live_mark', round((round(coalesce(index_live_value(c.index_classroom_id)
                                          / jex_index_unit_divisor(), c.price), 2)
                                          - (k.v->>'avgPrice')::numeric) * (k.v->>'qty')::numeric, 2),
              'call_line_80pct', round(coalesce((k.v->>'collateral')::numeric, 0) * 0.8, 2))
       from jex_funds f, lateral jsonb_each(coalesce(f.shorts, '{}'::jsonb)) k(t, v)
       join jex_companies c on c.ticker = k.t and coalesce(c.is_index_fund, false)
   ) q)                                                                       as index_shorts_open;
