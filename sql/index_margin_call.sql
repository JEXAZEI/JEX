-- ============================================================
-- index_margin_call.sql   (revised -- the first version aborted)
--
-- The margin call cannot see an index short.
--
-- ── What this fixes ──
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
-- Measured against this database's own function bodies running locally. A
-- student shorts 1,000 JXI units at $15.00, putting up $22,500 of collateral.
-- The market then triples. Nobody trades JXI itself:
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
-- And if it does fire -- because somebody happened to trade a unit and refresh
-- the stored price -- it then prices the close as if the index had a float:
-- impact against jex_companies.shares, clamped to a price band. An index unit
-- has neither. A voluntary cover via rpc_trade_cover_short prices it off
-- index_live_value() with no impact and no band, so the two paths settled the
-- same position at different prices. After the fix both return $45.00 on the
-- case above.
--
-- ── What changed since the version that aborted ──
--
-- The first version of this file also rewrote the trade insert. It declares
--
--     v_trade_id bigint;  ...  returning id into v_trade_id;
--
-- and on my local copy jex_trades.id is text, so that line raised
-- "invalid input syntax for type bigint" and killed the margin call after it
-- had already debited the student. I said I would not guess the real type and
-- asked. The answer came back: **jex_trades.id is `integer` on this
-- database**, so `v_trade_id bigint` is perfectly fine and that edit was
-- fixing a fault that exists only on my test rig. It is gone. So is the claim
-- that no margin call has ever completed -- `margin_call_trades_ever` is 0
-- because no short has ever crossed the line, not because the function is
-- broken.
--
-- The first version aborted with `relation "v_trade" does not exist` and
-- changed nothing, which is the guard working. I could not reproduce that
-- error here and I am not going to claim I know which of the three edits
-- caused it. Instead this version does the two edits I can defend, in two
-- INDEPENDENT blocks: if one applies and the other does not, re-running the
-- file applies only what is still missing, and the verification reports each
-- one separately rather than as a single yes/no.
--
-- ── What this does NOT fix ──
--
-- rpc_margin_call_short is called from the browser (app.js), not by the
-- database. Nothing calls it on a schedule, so a short only gets margin-called
-- while somebody has the app open. And it takes a p_user_id and reads
-- jex_users, so a FUND's short is never called at all. Both are design limits
-- worth deciding on deliberately, not changing inside a bug fix.
--
-- Safe to run twice. Each block aborts and changes nothing if its anchor is
-- not found exactly once.
-- ============================================================

-- ── (a) mark the index live before the loss is computed ──
do $mig_a$
declare
  r record;
  v_nl text;
  v_n  int;
begin
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_margin_call_short';
  if r is null then
    raise exception 'ABORT: rpc_margin_call_short not found. Nothing changed.';
  end if;

  if position('v_co.price := round(coalesce(index_live_value(' in r.prosrc) > 0 then
    raise notice '(a) rpc_margin_call_short already marks the index live -- skipped.';
    return;
  end if;

  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, 'v_loss    := (v_co.price - v_avg) * v_qty;', '')))
         / length('v_loss    := (v_co.price - v_avg) * v_qty;');
  if v_n <> 1 then
    raise exception 'ABORT (a): expected the loss line exactly once, found %. Nothing changed.', v_n;
  end if;

  execute replace(r.def, r.prosrc, replace(r.prosrc,
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
    '  v_loss    := (v_co.price - v_avg) * v_qty;'));

  raise notice '(a) rpc_margin_call_short: the index is marked live before the loss is measured.';
end
$mig_a$;

-- ── (b) close an index short at the level, not at an impact price in a band ──
do $mig_b$
declare
  r record;
  v_nl text;
  v_n  int;
begin
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_margin_call_short';
  if r is null then
    raise exception 'ABORT: rpc_margin_call_short not found. Nothing changed.';
  end if;

  if position('then v_new_price := v_co.price; end if;' in r.prosrc) > 0 then
    raise notice '(b) rpc_margin_call_short already closes an index short at the level -- skipped.';
    return;
  end if;

  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, 'v_new_price := jex_band_clamp(v_co.ticker, v_new_price, v_co.price);', '')))
         / length('v_new_price := jex_band_clamp(v_co.ticker, v_new_price, v_co.price);');
  if v_n <> 1 then
    raise exception 'ABORT (b): expected the band clamp exactly once, found %. Nothing changed.', v_n;
  end if;

  execute replace(r.def, r.prosrc, replace(r.prosrc,
    'v_new_price := jex_band_clamp(v_co.ticker, v_new_price, v_co.price);',
    'v_new_price := jex_band_clamp(v_co.ticker, v_new_price, v_co.price);' || v_nl ||
    '  -- An index unit has no float to move and no session band: it closes at' || v_nl ||
    '  -- the level, which is what rpc_trade_cover_short charges for the same' || v_nl ||
    '  -- position. v_co.price is already the live mark by here.' || v_nl ||
    '  if coalesce(v_co.is_index_fund, false) then v_new_price := v_co.price; end if;'));

  raise notice '(b) rpc_margin_call_short: an index short closes at the level.';
end
$mig_b$;

-- ── verification ──
--
-- a_marks_index_live    edit (a) is in
-- b_closes_at_level     edit (b) is in
-- index_shorts_open     open index short positions, with the loss the margin
--                       call USED to see (stored price) next to the real one
--                       (live mark). Anything here whose live loss is past
--                       call_line_80pct should have been called already.
-- margin_calls_so_far   how many margin_call trades exist. 0 means no short
--                       has ever crossed the line, which the schema_facts run
--                       already showed.
-- body_after            the whole function as it now stands, so my local copy
--                       can be made byte-identical to yours instead of
--                       reconstructed. This is the column that stops the next
--                       round of this.
select
  (select position('v_co.price := round(coalesce(index_live_value(' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_margin_call_short')       as a_marks_index_live,

  (select position('then v_new_price := v_co.price; end if;' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_margin_call_short')       as b_closes_at_level,

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
   ) q)                                                                       as index_shorts_open,

  (select count(*) from jex_trades where type = 'margin_call')                as margin_calls_so_far,

  (select pg_get_functiondef(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_margin_call_short')       as body_after;
