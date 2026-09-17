-- ============================================================
-- price_axis_and_band.sql
--
-- WRITES. Patches four functions. Aborts and changes nothing on any mismatch.
-- Re-running is a no-op.
--
-- ══ Bug 1: an admin price adjustment freezes one side of the market ══
--
-- The price band, the daily % badge and the circuit breaker are all measured
-- from jex_session.session_open_prices. rpc_adjust_stock_price moves the price
-- and leaves that baseline where it was, so a boost or a cut large enough to
-- clear the band puts the stock permanently outside it -- and the band check
-- only lets a trade through if it moves the price BACK toward the band.
--
-- Measured on a copy of this database. ACME at $30.00, band +/-30%, so the
-- allowed range is 21.00 - 39.00. The Chairman applies "Boost +50%":
--
--   price                 $30.00 -> $45.00
--   session open price    $30.00 -> $30.00   (unchanged -- this is the bug)
--
--   a student tries to BUY   -> "Order rejected - outside price band.
--                                Allowed range: 21.00 - 39.00"
--   a student tries to SELL  -> goes through
--
-- Every buy is refused, every sell works, and it stays that way until the
-- price drifts back under $39. A "Boost" is a one-way trip down. A "Drop"
-- does the same thing in reverse -- sells refused, buys fine.
--
-- The fix is the one rpc_review_dilution already uses for a dilution step:
-- scale the baseline by the same factor the price moved. All three measures
-- then read real trading against the new price, and the day's percentage
-- change carries through the adjustment instead of being swamped by it.
--
-- ══ Bug 2: four functions write a caption where a timestamp goes ══
--
-- price_history entries are {p, t}, and `t` is a date. Four functions put a
-- label there instead:
--
--   rpc_adjust_stock_price        'Boost +10%' / 'Drop -5%'
--   rpc_admin_relist_company      'Re-IPO'
--   rpc_review_class_application  'Class B IPO'
--   rpc_admin_full_reset          'Listing'
--
-- new Date('Re-IPO') is Invalid Date, and both `NaN < cutoff` and
-- `NaN >= cutoff` are false -- so anchorToSessionOpen() and filterByInterval()
-- silently DROP the point. For a relist and a new share class that caption is
-- the only point the stock has, so its 1D/5D/1M chart is blank until somebody
-- trades it.
--
-- On the index chart these labels sorted AFTER every ISO timestamp ('B' > '2'),
-- landing at the end of the shared time axis as a phantom point and dragging
-- every other constituent's cursor to its end to meet it. The client now
-- filters non-dates off that axis, which stops the damage; this removes the
-- cause. The captions are not displayed anywhere -- the admin screen reads
-- jex_price_adjustments for that -- so nothing is lost by making them real.
--
-- ── Method ──
--
-- Executable anchors only, each asserted to occur EXACTLY once per function;
-- every function rebuilt through pg_get_functiondef so the signature,
-- volatility, SECURITY DEFINER and any SET clause return exactly as they are.
-- Line endings are detected per anchor rather than assumed -- these bodies are
-- a mix of CRLF and LF.
-- ============================================================

do $mig$
declare
  r record;
  v_new text; v_n int; v_nl text; v_a text; v_b text;
  v_stamp constant text :=
    'to_char(now() at time zone ''utc'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'')';

begin
  -- ─────────────────────────────────────────────────────────
  -- 1. rpc_adjust_stock_price: real timestamp + move the baseline
  -- ─────────────────────────────────────────────────────────
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_adjust_stock_price';
  if r.proname is null then raise exception 'ABORT: rpc_adjust_stock_price not found.'; end if;

  if position('one-way trip' in r.prosrc) > 0 then
    raise notice '  rpc_adjust_stock_price already moves the baseline -- skipped';
  else
    v_a := '    jsonb_build_array(jsonb_build_object(''p'', v_new_price, ''t'', case when p_pct >= 0 then ''Boost +'' || p_pct || ''%'' else ''Drop '' || p_pct || ''%'' end));';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
    if v_n <> 1 then raise exception 'ABORT: adjust price_history anchor found % times, expected 1.', v_n; end if;

    v_b := '  update jex_companies set price = v_new_price, price_history = v_new_price_history where ticker = p_ticker;';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_b, ''))) / length(v_b);
    if v_n <> 1 then raise exception 'ABORT: adjust update anchor found % times, expected 1.', v_n; end if;

    v_nl := case when position(v_b || chr(13) || chr(10) in r.prosrc) > 0
                 then chr(13) || chr(10) else chr(10) end;

    v_new := replace(r.prosrc, v_a,
      '    -- A real timestamp, not a caption. new Date(''Boost +10%'') is Invalid' || v_nl ||
      '    -- Date, and every chart comparison against NaN is false, so the point' || v_nl ||
      '    -- was dropped from the company''s own 1D/5D/1M charts and sorted after' || v_nl ||
      '    -- every ISO stamp on the index''s shared time axis. The caption is not' || v_nl ||
      '    -- displayed anywhere -- the admin screen reads jex_price_adjustments.' || v_nl ||
      '    jsonb_build_array(jsonb_build_object(''p'', v_new_price, ''t'', ' || v_stamp || '));');

    v_new := replace(v_new, v_b,
      v_b || v_nl || v_nl ||
      '  -- The price band, the daily % badge and the circuit breaker are all' || v_nl ||
      '  -- measured from session_open_prices. Moving the price without moving' || v_nl ||
      '  -- that baseline puts the stock outside its own band, and the band only' || v_nl ||
      '  -- lets a trade through if it moves the price BACK toward the band -- so' || v_nl ||
      '  -- the market goes one way until the price drifts back in. Measured: a' || v_nl ||
      '  -- +50% boost on a $30 stock (band +/-30%, allowed 21.00-39.00) left it' || v_nl ||
      '  -- at $45.00, and from then on every BUY was refused as outside the band' || v_nl ||
      '  -- while every SELL went through. A "Boost" was a one-way trip down.' || v_nl ||
      '  --' || v_nl ||
      '  -- Scaling the baseline by the same factor is what rpc_review_dilution' || v_nl ||
      '  -- already does for a dilution step: all three measures go back to' || v_nl ||
      '  -- reading real trading against the new price, and the day''s percentage' || v_nl ||
      '  -- change carries through the adjustment instead of being swamped by it.' || v_nl ||
      '  if v_co.price > 0 then' || v_nl ||
      '    update jex_session' || v_nl ||
      '      set session_open_prices = jsonb_set(session_open_prices, array[p_ticker],' || v_nl ||
      '        to_jsonb(greatest(0.01, round((session_open_prices->>p_ticker)::numeric * (v_new_price / v_co.price), 2))))' || v_nl ||
      '      where id = 1' || v_nl ||
      '        and session_open_prices ? p_ticker' || v_nl ||
      '        and coalesce((session_open_prices->>p_ticker)::numeric, 0) > 0;' || v_nl ||
      '  end if;');

    -- The client has to be told, or its band preview and % badge keep using
    -- the old baseline until the next reload.
    v_a := '  return jsonb_build_object(''price'', v_new_price, ''price_history'', v_new_price_history, ''old_price'', v_co.price);';
    v_n := (length(v_new) - length(replace(v_new, v_a, ''))) / length(v_a);
    if v_n <> 1 then raise exception 'ABORT: adjust return anchor found % times, expected 1.', v_n; end if;
    v_new := replace(v_new, v_a,
      '  return jsonb_build_object(''price'', v_new_price, ''price_history'', v_new_price_history, ''old_price'', v_co.price,' || v_nl ||
      '    ''session_open_prices'', (select session_open_prices from jex_session where id = 1));');

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_adjust_stock_price: baseline now moves with the price, and the stamp is a date';
  end if;

  -- ─────────────────────────────────────────────────────────
  -- 2. rpc_admin_relist_company: 'Re-IPO' -> a timestamp
  -- ─────────────────────────────────────────────────────────
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_admin_relist_company';
  if r.proname is null then raise exception 'ABORT: rpc_admin_relist_company not found.'; end if;

  if position('''Re-IPO''' in r.prosrc) = 0 then
    raise notice '  rpc_admin_relist_company already writes a timestamp -- skipped';
  else
    v_a := 'jsonb_build_array(jsonb_build_object(''p'', v_co.price, ''t'', ''Re-IPO''))';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
    if v_n <> 1 then raise exception 'ABORT: relist anchor found % times, expected 1.', v_n; end if;
    v_new := replace(r.prosrc, v_a,
      'jsonb_build_array(jsonb_build_object(''p'', v_co.price, ''t'', ' || v_stamp || '))');
    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_admin_relist_company: a relisted stock now has a chart again';
  end if;

  -- ─────────────────────────────────────────────────────────
  -- 3. rpc_review_class_application: 'Class B IPO' -> a timestamp
  -- ─────────────────────────────────────────────────────────
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_review_class_application';
  if r.proname is null then raise exception 'ABORT: rpc_review_class_application not found.'; end if;

  if position('''Class ''||v_app.class||'' IPO''' in r.prosrc) = 0
     and position('''Class '' || v_app.class || '' IPO''' in r.prosrc) = 0 then
    raise notice '  rpc_review_class_application already writes a timestamp -- skipped';
  else
    v_a := 'jsonb_build_array(jsonb_build_object(''p'', v_price, ''t'', ''Class ''||v_app.class||'' IPO''))';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
    if v_n <> 1 then raise exception 'ABORT: class application anchor found % times, expected 1.', v_n; end if;
    v_new := replace(r.prosrc, v_a,
      'jsonb_build_array(jsonb_build_object(''p'', v_price, ''t'', ' || v_stamp || '))');
    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_review_class_application: a new share class now has a chart from day one';
  end if;

  -- ─────────────────────────────────────────────────────────
  -- 4. rpc_admin_full_reset: 'Listing' -> a timestamp
  -- ─────────────────────────────────────────────────────────
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_admin_full_reset';
  if r.proname is null then raise exception 'ABORT: rpc_admin_full_reset not found.'; end if;

  if position(', ''t'', ''Listing''' in r.prosrc) = 0 then
    raise notice '  rpc_admin_full_reset already writes a timestamp -- skipped';
  else
    v_a := ', ''t'', ''Listing''';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
    if v_n <> 1 then raise exception 'ABORT: full reset anchor found % times, expected 1.', v_n; end if;
    v_new := replace(r.prosrc, v_a, ', ''t'', ' || v_stamp);
    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_admin_full_reset: the re-seeded index now starts on a real date';
  end if;
end
$mig$;

-- ── Verification ──
--
-- The first five must be true.
--
-- adjust_moves_baseline    a boost or a cut no longer strands the stock
--                          outside its own price band.
-- adjust_returns_baseline  ...and the client is told, so its band preview and
--                          daily % badge agree with the server immediately.
-- adjust_stamp_is_a_date   no more 'Boost +10%' where a timestamp goes.
-- relist_stamp_is_a_date   a relisted stock has a chart before its first trade.
-- class_stamp_is_a_date    so does a newly approved share class.
-- reset_stamp_is_a_date    and the index the full reset re-seeds.
--
-- stranded_now is the one to read: every listed stock whose price is ALREADY
-- outside its band today, with the side of the market that is currently
-- refused. This migration does not move an existing baseline -- doing that
-- retroactively would erase a real day's trading -- so anything listed here
-- stays stuck until the next session open re-records the baseline, or until
-- the Chairman adjusts it back. Empty means nothing is stuck right now.
select
  (select prosrc like '%one-way trip%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_adjust_stock_price')            as adjust_moves_baseline,
  (select prosrc like '%''session_open_prices'', (select session_open_prices%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_adjust_stock_price')            as adjust_returns_baseline,
  (select prosrc not like '%''t'', case when p_pct%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_adjust_stock_price')            as adjust_stamp_is_a_date,
  (select prosrc not like '%Re-IPO%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_relist_company')          as relist_stamp_is_a_date,
  (select prosrc not like '%'' IPO''%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_review_class_application')      as class_stamp_is_a_date,
  (select prosrc not like '%''Listing''%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_full_reset')              as reset_stamp_is_a_date,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', q.ticker, 'price', q.price, 'session_open', q.open_price,
            'band_low', q.lo, 'band_high', q.hi,
            'refused_side', case when q.price > q.hi then 'every BUY is refused'
                                 else 'every SELL is refused' end)
          order by q.ticker), '[]'::jsonb)
     from (
       select c.ticker, c.price,
              (s.session_open_prices->>c.ticker)::numeric as open_price,
              round((s.session_open_prices->>c.ticker)::numeric * (1 - s.price_band_pct/100), 2) as lo,
              round((s.session_open_prices->>c.ticker)::numeric * (1 + s.price_band_pct/100), 2) as hi
         from jex_companies c cross join jex_session s
        where s.id = 1 and c.status = 'listed'
          and not coalesce(c.is_index_fund, false)
          and s.session_open_prices ? c.ticker
          and coalesce((s.session_open_prices->>c.ticker)::numeric, 0) > 0
     ) q
    where q.price > q.hi or q.price < q.lo)                                     as stranded_now;
