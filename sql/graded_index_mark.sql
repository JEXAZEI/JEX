-- ============================================================
-- graded_index_mark.sql
--
-- The graded net worth values index units at a cached price.
--
-- rpc_snapshot_nw is what writes jex_nw_history -- the number the class is
-- graded on, and the series behind the portfolio chart, Sharpe, VaR and beta.
-- It marks every holding at jex_mark_price(ticker), and jex_mark_price does
-- this for an index row:
--
--     -- An index unit's price is already derived from its constituents
--     -- rather than from its own prints, so its own tape is not the right
--     -- input.
--     if v_is_index then return v_price; end if;
--
-- The reasoning is right and the conclusion is wrong. It returns
-- jex_companies.price, which for an index row is not a price but a CACHE of a
-- derived value -- and that cache is only rewritten when somebody trades a
-- unit of the index or when rpc_snapshot_jxi runs. Between those, the real
-- level has moved with every constituent and the cache has not.
--
-- ── Why it is not a rounding-error-sized problem ──
--
-- Look at the order in app.js, in the handler that runs after every trade:
--
--     if(u)snapshotNW(u.id);       <- writes the graded row
--     checkPriceAlerts();
--     checkCircuitBreakers();
--     pushBalances();
--     snapshotJXI();               <- refreshes the cache, afterwards
--
-- So the graded row written at the moment of a trade is ALWAYS taken before
-- the index cache catches up with the trade that was just made. Not
-- occasionally -- every time.
--
-- Measured against this database's own function bodies running locally. A
-- student with $10,000 cash and 500 JXI units, starting in sync at $7.01 a
-- unit, then one constituent moves from $30.00 to $45.00:
--
--     JXI cached        $7.01        live level        $9.51
--     graded row written              $13,505.00
--     what it should be               $14,755.00
--     understated by                   $1,250.00   -- 8.5%
--
--     the next snapshot, after rpc_snapshot_jxi     $14,755.00
--
-- It self-corrects on the following tick, so this is not a permanent error in
-- the balance -- it is a permanent error in the SERIES, and the series is the
-- graded artifact. Every row written at the moment of a trade is wrong, and
-- those are the rows the chart is made of.
--
-- ── The fix ──
--
-- jex_mark_price computes the index level itself instead of reading the
-- cache. This is the third place to need the same correction, after
-- rpc_trade_cover_short's index branch and rpc_margin_call_short: the rule for
-- this schema is that jex_companies.price is never the answer for an index
-- row. It falls back to the stored price when index_live_value returns null --
-- an index with no listed constituents has no defined level, and the last
-- known unit price is the honest answer there.
--
-- Fixing it here rather than reordering the two calls in app.js is deliberate.
-- The ordering is one caller; jex_mark_price is read by rpc_snapshot_nw and by
-- anything else that ever marks a portfolio, and a fix at the source cannot be
-- undone by the next caller that gets the order wrong.
--
-- ── Current exposure ──
--
-- Zero right now: no student holds JXI units on this exchange, so no graded
-- row has been affected yet. This closes it before the first one does.
--
-- Safe to run twice. Aborts and changes nothing if any anchor count is wrong.
-- ============================================================

do $mig$
declare
  r record;
  v_nl text;
  v_n  int;
  v_src text;
begin
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'jex_mark_price';
  if r is null then
    raise exception 'ABORT: jex_mark_price not found. Nothing changed.';
  end if;

  if position('v_index_room text;' in r.prosrc) > 0 then
    raise notice 'jex_mark_price already marks the index live -- skipped.';
    return;
  end if;

  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, '  v_price numeric; v_is_index boolean;', '')))
         / length('  v_price numeric; v_is_index boolean;');
  if v_n <> 1 then
    raise exception 'ABORT: expected the declare line exactly once, found %. Nothing changed.', v_n;
  end if;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, 'select price, coalesce(is_index_fund,false) into v_price, v_is_index', '')))
         / length('select price, coalesce(is_index_fund,false) into v_price, v_is_index');
  if v_n <> 1 then
    raise exception 'ABORT: expected the company lookup exactly once, found %. Nothing changed.', v_n;
  end if;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, '  if v_is_index then return v_price; end if;', '')))
         / length('  if v_is_index then return v_price; end if;');
  if v_n <> 1 then
    raise exception 'ABORT: expected the index early-return exactly once, found %. Nothing changed.', v_n;
  end if;

  v_src := replace(r.prosrc,
    '  v_price numeric; v_is_index boolean;',
    '  v_price numeric; v_is_index boolean; v_index_room text;');

  v_src := replace(v_src,
    'select price, coalesce(is_index_fund,false) into v_price, v_is_index',
    'select price, coalesce(is_index_fund,false), index_classroom_id' || v_nl ||
    '    into v_price, v_is_index, v_index_room');

  v_src := replace(v_src,
    '  if v_is_index then return v_price; end if;',
    '  -- jex_companies.price is not a price for an index row, it is a CACHE of' || v_nl ||
    '  -- a derived value, rewritten only by a direct unit trade or by' || v_nl ||
    '  -- rpc_snapshot_jxi. app.js calls snapshotNW BEFORE snapshotJXI after' || v_nl ||
    '  -- every trade, so the graded row was always taken before the cache' || v_nl ||
    '  -- caught up with the trade that had just been made. Measured: 500 units' || v_nl ||
    '  -- marked at $7.01 when the level was $9.51 -- $13,505.00 written where' || v_nl ||
    '  -- the truth was $14,755.00.' || v_nl ||
    '  --' || v_nl ||
    '  -- Falls back to the stored price, never to a seed: an index with no' || v_nl ||
    '  -- listed constituents has no defined level, and what the units were' || v_nl ||
    '  -- last actually worth is the honest answer there.' || v_nl ||
    '  if v_is_index then' || v_nl ||
    '    return round(coalesce(index_live_value(v_index_room) / jex_index_unit_divisor(), v_price), 2);' || v_nl ||
    '  end if;');

  execute replace(r.def, r.prosrc, v_src);
  raise notice 'jex_mark_price: index units are now marked at the live level.';
end
$mig$;

-- ── verification ──
--
-- marks_index_live   the fix is in
-- index_rows         every index, its cached price, the live level, and the
--                    gap between them RIGHT NOW. A non-zero gap is exactly
--                    what every graded row written at a trade was carrying.
-- holders_affected   students holding index units, and what the correction is
--                    worth to each. Empty means nothing graded was affected.
-- history_rows       how many graded rows exist, and the most recent, so
--                    there is a before/after reference point.
select
  (select position('v_index_room text;' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'jex_mark_price')               as marks_index_live,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker,
            'cached_price', c.price,
            'live_level', round(coalesce(index_live_value(c.index_classroom_id)
                                         / jex_index_unit_divisor(), c.price), 2),
            'gap', round(coalesce(index_live_value(c.index_classroom_id)
                                  / jex_index_unit_divisor(), c.price), 2) - c.price,
            'units_outstanding', c.shares) order by c.ticker), '[]'::jsonb)
     from jex_companies c where coalesce(c.is_index_fund, false))              as index_rows,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'who', u.name, 'ticker', c.ticker,
            'units', (u.holdings->>c.ticker)::numeric,
            'was_marked_at', c.price,
            'now_marked_at', round(coalesce(index_live_value(c.index_classroom_id)
                                            / jex_index_unit_divisor(), c.price), 2),
            'difference', round(((round(coalesce(index_live_value(c.index_classroom_id)
                                        / jex_index_unit_divisor(), c.price), 2) - c.price)
                                * (u.holdings->>c.ticker)::numeric), 2))
          order by u.name), '[]'::jsonb)
     from jex_users u
     join jex_companies c on coalesce(c.is_index_fund, false)
                         and coalesce(u.holdings, '{}'::jsonb) ? c.ticker
    where coalesce((u.holdings->>c.ticker)::numeric, 0) > 0)                   as holders_affected,

  (select jsonb_build_object(
            'rows', count(*),
            'latest', max(created_at)) from jex_nw_history)                    as history_rows;
