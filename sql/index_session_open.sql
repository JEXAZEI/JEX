-- ============================================================
-- index_session_open.sql
--
-- CORRECTION, after it ran: this fixes a real stale baseline, but not the
-- number on the card. The card never reads session_open_prices for an index;
-- it derives JXI's history in the browser, and the -50.00% was a dilution
-- drawn as a crash in that history. That, a restore leaving the open behind,
-- and an ordering hole in the capture below are fixed in
-- dilution_and_restore_opens.sql. What this file fixed is the server's JXI
-- baseline, which its price band and circuit breaker read.
--
-- JXI's "today" percentage is wrong, and there is a clean proof of it.
--
-- The index card reads:
--
--     JXI  1197.24   -50.00% today      1 listed company
--     AZEI $13.61     +0.00% today
--
-- JXI is the equal-weighted average of every listed company. There is one.
-- So JXI's move today is AZEI's move today, necessarily -- one number divided
-- by a constant cannot fall 50% while the number it is derived from is flat.
-- The -50.00% is not a market event. It is a bad baseline.
--
-- ── Where the baseline comes from ──
--
-- rpc_record_session_open_prices captures the opening price of everything at
-- the start of each trading day:
--
--     for v_co in select ticker, price from jex_companies loop
--       v_prices := jsonb_set(v_prices, array[v_co.ticker], to_jsonb(v_co.price));
--     end loop;
--
-- For an ordinary company, jex_companies.price IS the price. For an index row
-- it is not -- it is a CACHE of a derived value, rewritten only when somebody
-- trades a unit of the index or when rpc_snapshot_jxi runs. Whatever stale
-- number happened to be sitting in that column at session open became JXI's
-- baseline for the whole day, and every percentage on the card, the sparkline
-- and the ticker bar was measured against it.
--
-- This is the same cache that produced three earlier bugs -- the index margin
-- call reading a historical price, the voluntary cover settling at it, and the
-- graded net worth marking units at it. Those are fixed. This is the fourth
-- reader, and the only one whose output a student sees on the front page.
--
-- ── The fix ──
--
-- An index row's session open is computed the same way its live value is:
-- the average constituent ratio, but taken from the constituents' OWN opening
-- prices rather than their current ones. Not from the cache, and not from the
-- live level either -- from where the constituents actually started the day.
--
-- That makes the arithmetic close: with one listed company, JXI's percentage
-- now equals AZEI's percentage exactly, because both are measured from the
-- same opening prices.
--
-- ── It also repairs today ──
--
-- Fixing the function only helps from the next session open, and the card is
-- wrong now. So this recomputes the stored baseline for every index row from
-- the constituent opens already recorded in jex_session.session_open_prices --
-- which are real, captured at the right moment, and untouched by this bug.
-- Nothing is invented: if AZEI opened at $13.61 and is at $13.61, JXI's
-- baseline becomes exactly its current level and the card reads +0.00%. If
-- AZEI had moved, the recomputed baseline would show that move.
--
-- The verification prints the old and new baseline side by side so the
-- correction is visible rather than silent.
--
-- Safe to run twice. Aborts and changes nothing if the anchor is not found
-- exactly once.
-- ============================================================

do $mig$
declare
  r record;
  v_nl text;
  v_n  int;
begin
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_record_session_open_prices';
  if r is null then
    raise exception 'ABORT: rpc_record_session_open_prices not found. Nothing changed.';
  end if;

  if position('index_open_from(' in r.prosrc) > 0 then
    raise notice 'rpc_record_session_open_prices already computes the index open -- skipped.';
    return;
  end if;

  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_n := (length(r.prosrc) - length(replace(r.prosrc,
            'for v_co in select ticker, price from jex_companies loop', '')))
         / length('for v_co in select ticker, price from jex_companies loop');
  if v_n <> 1 then
    raise exception 'ABORT: expected the capture loop exactly once, found %. Nothing changed.', v_n;
  end if;
  v_n := (length(r.prosrc) - length(replace(r.prosrc,
            'v_prices := jsonb_set(v_prices, array[v_co.ticker], to_jsonb(v_co.price));', '')))
         / length('v_prices := jsonb_set(v_prices, array[v_co.ticker], to_jsonb(v_co.price));');
  if v_n <> 1 then
    raise exception 'ABORT: expected the capture line exactly once, found %. Nothing changed.', v_n;
  end if;

  execute replace(r.def, r.prosrc,
    replace(
      replace(r.prosrc,
        'for v_co in select ticker, price from jex_companies loop',
        '-- jex_companies.price is a real price for a company and a stale CACHE' || v_nl ||
        '  -- for an index row, refreshed only by a unit trade or rpc_snapshot_jxi.' || v_nl ||
        '  -- Capturing it as the index''s opening baseline made every percentage' || v_nl ||
        '  -- on the card measure against whatever number happened to be sitting' || v_nl ||
        '  -- there. Measured: JXI showed -50.00% today while its only' || v_nl ||
        '  -- constituent showed +0.00%, which is arithmetically impossible.' || v_nl ||
        '  for v_co in select ticker, price, coalesce(is_index_fund, false) as is_index,' || v_nl ||
        '                     index_classroom_id' || v_nl ||
        '                from jex_companies loop'),
      'v_prices := jsonb_set(v_prices, array[v_co.ticker], to_jsonb(v_co.price));',
      'v_prices := jsonb_set(v_prices, array[v_co.ticker], to_jsonb(' || v_nl ||
      '      case when v_co.is_index' || v_nl ||
      '           then coalesce(index_open_from(v_prices, v_co.index_classroom_id), v_co.price)' || v_nl ||
      '           else v_co.price end));'));

  raise notice 'rpc_record_session_open_prices: an index now opens at its own computed level.';
end
$mig$;

-- ── the helper the function above calls ──
--
-- index_live_value() with the constituents' opening prices substituted for
-- their current ones. Same constituent rule, same exclusions, same base-1000
-- scaling, same unit divisor -- so the opening level and the live level are
-- the same measurement taken at two moments, which is the only way a
-- percentage between them means anything.
--
-- Takes the open-price map as an argument rather than reading jex_session,
-- because rpc_record_session_open_prices calls it while building that map and
-- has not written it yet.
create or replace function public.index_open_from(p_opens jsonb, p_classroom_id text)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $function$
  select round(round(avg(
      case when coalesce((c.price_history->0->>'p')::numeric, 0) * coalesce(c.index_base_adjust, 1) > 0
             and coalesce((p_opens->>c.ticker)::numeric, 0) > 0
        then (p_opens->>c.ticker)::numeric
             / ((c.price_history->0->>'p')::numeric * coalesce(c.index_base_adjust, 1))
        else 1 end
    ) * 1000, 2) / jex_index_unit_divisor(), 2)
    from jex_companies c
    left join jex_users o on o.id = c.owner_id
   where c.status = 'listed'
     and coalesce(c.is_index_fund, false) = false
     and not exists (select 1 from jex_share_classes sc
                      where sc.ticker = c.ticker and coalesce(sc.restricted, false) = true)
     and (coalesce((select dev_mode from jex_session where id = 1), false)
          or not coalesce(o.is_test_account, false))
     and (p_classroom_id is null or o.classroom_id = p_classroom_id)
     and p_opens ? c.ticker;
$function$;

grant execute on function public.index_open_from(jsonb, text) to anon, authenticated;

-- ── repair today's baseline ──
--
-- Recomputed from the constituent opens already in session_open_prices, which
-- were captured correctly and are not affected by this bug.
do $repair$
declare
  v_opens jsonb;
  v_co record;
  v_new numeric;
  v_fixed jsonb := '{}'::jsonb;
begin
  select session_open_prices into v_opens from jex_session where id = 1;
  if v_opens is null then
    raise notice 'No session open prices recorded yet -- nothing to repair.';
    return;
  end if;

  for v_co in select ticker, index_classroom_id from jex_companies
               where coalesce(is_index_fund, false) loop
    v_new := index_open_from(v_opens, v_co.index_classroom_id);
    continue when v_new is null;
    v_fixed := jsonb_set(v_fixed, array[v_co.ticker], jsonb_build_object(
      'was', coalesce(v_opens->v_co.ticker, 'null'::jsonb), 'now', to_jsonb(v_new)));
    v_opens := jsonb_set(v_opens, array[v_co.ticker], to_jsonb(v_new));
  end loop;

  if v_fixed = '{}'::jsonb then
    raise notice 'No index rows to repair.';
  else
    update jex_session set session_open_prices = v_opens where id = 1;
    raise notice 'Index baselines recomputed: %', v_fixed;
  end if;
end
$repair$;

-- ── verification ──
--
-- records_computed_open   the function no longer captures the cache
-- index_today             for each index: its baseline, its live level, and
--                         the percentage the card will now show
-- constituents_today      each constituent's own open, price and percentage.
--                         With one listed company the index percentage and
--                         that company's percentage must MATCH -- that
--                         equality is the whole check, and it is what
--                         -50.00% against +0.00% violated.
select
  (select position('index_open_from(' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_record_session_open_prices')
                                                                              as records_computed_open,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker,
            'baseline_now', (s.session_open_prices->>c.ticker)::numeric,
            'live_level', round(index_live_value(c.index_classroom_id), 2),
            'live_unit', round(index_live_value(c.index_classroom_id) / jex_index_unit_divisor(), 2),
            'today_pct', case when coalesce((s.session_open_prices->>c.ticker)::numeric, 0) > 0
              then round(((round(index_live_value(c.index_classroom_id) / jex_index_unit_divisor(), 2)
                           / (s.session_open_prices->>c.ticker)::numeric) - 1) * 100, 2) end)
          order by c.ticker), '[]'::jsonb)
     from jex_companies c cross join jex_session s
    where s.id = 1 and coalesce(c.is_index_fund, false))                      as index_today,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker,
            'open', (s.session_open_prices->>c.ticker)::numeric,
            'price', c.price,
            'today_pct', case when coalesce((s.session_open_prices->>c.ticker)::numeric, 0) > 0
              then round(((c.price / (s.session_open_prices->>c.ticker)::numeric) - 1) * 100, 2) end)
          order by c.ticker), '[]'::jsonb)
     from jex_companies c cross join jex_session s
     left join jex_users o on o.id = c.owner_id
    where s.id = 1 and c.status = 'listed' and not coalesce(c.is_index_fund, false)
      and not coalesce(o.is_test_account, false))                             as constituents_today;
