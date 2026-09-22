-- ============================================================
-- dilution_and_restore_opens.sql
--
-- Three bugs behind the two wrong percentages, and a repair for today.
--
-- ── 1. A dilution drew a crash on the index chart ──
--
-- The JXI card's "-50.00% today" did not come from the server's opening
-- price. The card never reads it. app.js rebuilds JXI's history from its
-- constituents' histories, dividing every point by the constituent's
-- index_base_adjust -- the CURRENT one. A 2:1 dilution halves AZEI's price and
-- halves that adjust, so the live level does not move, as designed. But every
-- point from BEFORE the dilution was divided by the halved adjust too, which
-- doubled it. The history read 20 -> 23.94 -> 11.98: a 50% fall at the moment
-- of a dilution, on an index whose value did not change.
--
-- rpc_review_dilution now marks the point it appends with `a`, the step it
-- applied. app.js walks back from the current adjust and undoes each step as
-- it passes it, so every point is priced under the adjust in force when it
-- was recorded. Same history, marked: 10 -> 11.98 -> 11.98.
--
-- ── 2. A snapshot restore left the day's opening prices behind ──
--
-- rpc_admin_restore_snapshot puts back price, price_history and
-- index_base_adjust, and never touched session_open_prices. Everything that
-- measures "today" kept measuring from before the restore. Your numbers:
-- AZEI restored to $27.21 against an open of $13.61, which reads +99.93%
-- today. The same open centres the 30% price band, whose top is $17.69 --
-- AZEI sits far above it, and the band holds a price that is already outside
-- rather than moving it, so BUYING AZEI CANNOT RAISE ITS PRICE right now.
--
-- Proof it was not trading: trading moves a price and never the index base,
-- so JXI would have moved with AZEI. JXI's level is 1197.24 before and after.
-- Only three functions write the base: IPO (new companies only), dilution
-- (which does rescale the open), and restore.
--
-- A restored state is the new starting point, so a restore now re-records the
-- opening prices from it.
--
-- ── 3. My own fix from index_session_open.sql had an ordering hole ──
--
-- The capture loop computes an index's open FROM its constituents' opens, and
-- had no ORDER BY. If Postgres reached the JXI row before AZEI, AZEI was not
-- in the map yet, the index open came back null, and the fallback was the
-- stale cached price -- the bug that file existed to remove. The repair in
-- that file built the full map first, so today's value was right; tomorrow
-- morning's capture was a coin toss. Companies now go first.
--
-- ── The repair ──
--
-- Re-records today's opening prices from where everything stands now: the
-- same thing opening the session would do. Every "today" badge reads 0.00%
-- until something trades, and AZEI's band is centred on $27.21 again. The
-- verification prints the old open next to the new one for every ticker.
--
-- Safe to run twice. Aborts and changes nothing if any anchor is not found
-- exactly once.
-- ============================================================

-- ── the helper both the restore and the repair use ──
--
-- Every company at its current price, then every index row at the level its
-- constituents' prices give -- index rows LAST, because they read the map.
create or replace function public.jex_open_prices_now()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_prices jsonb := '{}'::jsonb;
  v_co record;
begin
  for v_co in select ticker, price, coalesce(is_index_fund, false) as is_index,
                     index_classroom_id
                from jex_companies
               order by coalesce(is_index_fund, false), ticker loop
    v_prices := jsonb_set(v_prices, array[v_co.ticker], to_jsonb(
      case when v_co.is_index
           then coalesce(index_open_from(v_prices, v_co.index_classroom_id), v_co.price)
           else v_co.price end));
  end loop;
  return v_prices;
end;
$function$;

revoke execute on function public.jex_open_prices_now() from public, anon, authenticated;

do $mig$
declare
  r record;
  v_nl text;
  v_n  int;
  v_anchor text;
begin
  -- ── 1. rpc_review_dilution: mark the step on the point it appends ──
  select p.prosrc as prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_review_dilution';
  if r is null then raise exception 'ABORT: rpc_review_dilution not found. Nothing changed.'; end if;

  if position('''a'', case when v_co.price > 0' in r.prosrc) > 0 then
    raise notice 'rpc_review_dilution already marks the step -- skipped.';
  else
    v_anchor := 'jsonb_build_object(''p'', v_new_price, ''t'', to_char(now() at time zone ''utc'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"''))';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_anchor, ''))) / length(v_anchor);
    if v_n <> 1 then
      raise exception 'ABORT: expected the appended price point exactly once in rpc_review_dilution, found %. Nothing changed.', v_n;
    end if;
    -- The same expression v_adjust is computed from a few lines further down,
    -- written out here because v_adjust is not assigned yet at this point.
    execute replace(r.def, r.prosrc, replace(r.prosrc, v_anchor,
      'jsonb_build_object(''p'', v_new_price, ''t'', to_char(now() at time zone ''utc'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"''), ' ||
      '''a'', case when v_co.price > 0 then v_new_price / v_co.price else 1 end)'));
    raise notice 'rpc_review_dilution: the dilution point now carries its step.';
  end if;

  -- ── 2. rpc_record_session_open_prices: companies before index rows ──
  select p.prosrc as prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_record_session_open_prices';
  if r is null then raise exception 'ABORT: rpc_record_session_open_prices not found. Nothing changed.'; end if;

  if position('order by coalesce(is_index_fund, false) loop' in r.prosrc) > 0 then
    raise notice 'rpc_record_session_open_prices already orders the capture -- skipped.';
  else
    if position('index_open_from(' in r.prosrc) = 0 then
      raise exception 'ABORT: rpc_record_session_open_prices does not compute the index open -- run index_session_open.sql first. Nothing changed.';
    end if;
    v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;
    v_n := (length(r.prosrc) - length(replace(r.prosrc, 'from jex_companies loop', ''))) / length('from jex_companies loop');
    if v_n <> 1 then
      raise exception 'ABORT: expected the capture loop exactly once in rpc_record_session_open_prices, found %. Nothing changed.', v_n;
    end if;
    execute replace(r.def, r.prosrc, replace(r.prosrc, 'from jex_companies loop',
      'from jex_companies' || v_nl ||
      '               -- Companies first, index rows last: an index''s open is' || v_nl ||
      '               -- computed FROM its constituents'' opens, so they must already' || v_nl ||
      '               -- be in v_prices. Unordered, reaching JXI first found no' || v_nl ||
      '               -- constituents and fell back to the stale cached price.' || v_nl ||
      '               order by coalesce(is_index_fund, false) loop'));
    raise notice 'rpc_record_session_open_prices: companies are captured before the index.';
  end if;

  -- ── 3. rpc_admin_restore_snapshot: a restore re-records the open ──
  select p.prosrc as prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_admin_restore_snapshot';
  if r is null then raise exception 'ABORT: rpc_admin_restore_snapshot not found. Nothing changed.'; end if;

  if position('jex_open_prices_now()' in r.prosrc) > 0 then
    raise notice 'rpc_admin_restore_snapshot already re-records the open -- skipped.';
  else
    v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;
    v_anchor := 'delete from jex_limit_orders where status in (''open'',''after_hours'');';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_anchor, ''))) / length(v_anchor);
    if v_n <> 1 then
      raise exception 'ABORT: expected the order cleanup exactly once in rpc_admin_restore_snapshot, found %. Nothing changed.', v_n;
    end if;
    execute replace(r.def, r.prosrc, replace(r.prosrc, v_anchor,
      '-- The restore puts back price, price_history and index_base_adjust, and' || v_nl ||
      '  -- left session_open_prices where it was -- so every % badge, the price' || v_nl ||
      '  -- band and the circuit breaker kept measuring from before the restore.' || v_nl ||
      '  -- Measured: AZEI restored to $27.21 against an open of $13.61 read' || v_nl ||
      '  -- +99.93% today, and sat so far above its band that buying could no' || v_nl ||
      '  -- longer move it. The restored state is the new starting point.' || v_nl ||
      '  update jex_session' || v_nl ||
      '     set session_open_prices = jex_open_prices_now(),' || v_nl ||
      '         jxi_open_value = jxi_live_value()' || v_nl ||
      '   where id = 1;' || v_nl ||
      v_nl ||
      '  ' || v_anchor));
    raise notice 'rpc_admin_restore_snapshot: a restore now re-records the day''s opening prices.';
  end if;
end
$mig$;

-- ── repair today ──
do $repair$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  select session_open_prices into v_before from jex_session where id = 1;
  v_after := jex_open_prices_now();
  if v_before = v_after then
    raise notice 'Opening prices already match the current state -- nothing to repair.';
    return;
  end if;
  update jex_session
     set session_open_prices = v_after,
         jxi_open_value = jxi_live_value()
   where id = 1;
  raise notice 'Opening prices re-recorded. Before: %  After: %', v_before, v_after;
end
$repair$;

-- ── verification ──
--
-- dilution_marks_step    the next dilution records its step on its point
-- open_capture_ordered   tomorrow's open cannot fall back to the stale cache
-- restore_rebaselines    a restore re-records the open
-- today                  every listed ticker: its open, its price, and the
--                        percentage the site will show. All 0.00 until
--                        something trades is the expected answer.
-- band_now               AZEI's band, which should now contain its price
-- history_check          for any company whose index base is not 1: how many
--                        points its history holds, how many carry a step
--                        mark, and every jump of more than 25% between two
--                        consecutive points. An unmarked jump there is a past
--                        dilution the chart still draws as a crash -- if one
--                        shows up, paste this and I will mark it.
-- dilutions_ever         every dilution application, whatever its status
-- recent_admin           the last 15 snapshot and dilution events, so the
--                        restore that caused this is on the record
select
  (select position('''a'', case when v_co.price > 0' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_review_dilution')          as dilution_marks_step,

  (select position('order by coalesce(is_index_fund, false) loop' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_record_session_open_prices') as open_capture_ordered,

  (select position('jex_open_prices_now()' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_admin_restore_snapshot')   as restore_rebaselines,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker,
            'open', (s.session_open_prices->>c.ticker)::numeric,
            'now', case when coalesce(c.is_index_fund, false)
                        then round(index_live_value(c.index_classroom_id) / jex_index_unit_divisor(), 2)
                        else c.price end,
            'today_pct', case when coalesce((s.session_open_prices->>c.ticker)::numeric, 0) > 0
              then round(((case when coalesce(c.is_index_fund, false)
                                then round(index_live_value(c.index_classroom_id) / jex_index_unit_divisor(), 2)
                                else c.price end
                           / (s.session_open_prices->>c.ticker)::numeric) - 1) * 100, 2) end)
          order by coalesce(c.is_index_fund, false) desc, c.ticker), '[]'::jsonb)
     from jex_companies c cross join jex_session s
    where s.id = 1 and c.status = 'listed')                                    as today,

  (select jsonb_build_object(
            'price', c.price,
            'band_low', round((s.session_open_prices->>'AZEI')::numeric * (1 - s.price_band_pct / 100), 2),
            'band_high', round((s.session_open_prices->>'AZEI')::numeric * (1 + s.price_band_pct / 100), 2),
            'price_inside_band', c.price between
              round((s.session_open_prices->>'AZEI')::numeric * (1 - s.price_band_pct / 100), 2)
              and round((s.session_open_prices->>'AZEI')::numeric * (1 + s.price_band_pct / 100), 2))
     from jex_companies c cross join jex_session s
    where s.id = 1 and c.ticker = 'AZEI')                                      as band_now,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker,
            'index_base_adjust', c.index_base_adjust,
            'points', jsonb_array_length(coalesce(c.price_history, '[]'::jsonb)),
            'marked_steps', (select count(*) from jsonb_array_elements(coalesce(c.price_history, '[]'::jsonb)) e
                              where e ? 'a'),
            'big_jumps', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'from', x.prev_p, 'to', x.p, 't', x.t, 'marked', x.marked)
                                   order by x.i), '[]'::jsonb)
                            from (select i, (e->>'p')::numeric as p, e->>'t' as t, e ? 'a' as marked,
                                         lag((e->>'p')::numeric) over (order by i) as prev_p
                                    from jsonb_array_elements(coalesce(c.price_history, '[]'::jsonb))
                                         with ordinality as h(e, i)) x
                           where x.prev_p > 0 and abs(x.p / x.prev_p - 1) > 0.25))
          order by c.ticker), '[]'::jsonb)
     from jex_companies c
    where coalesce(c.index_base_adjust, 1) <> 1
      and not coalesce(c.is_index_fund, false))                                as history_check,

  (select coalesce(jsonb_agg(to_jsonb(d.*) order by d.created_at), '[]'::jsonb)
     from jex_dilution_applications d)                                         as dilutions_ever,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'when', to_char(a.created_at at time zone 'America/Phoenix', 'Mon FMDD FMHH12:MI AM'),
            'type', a.type, 'what', a.description, 'by', a.user_name)
          order by a.created_at desc), '[]'::jsonb)
     from (select * from jex_activity
            where type in ('snapshot', 'dilution')
               or description ilike '%snapshot%' or description ilike '%dilution%'
            order by created_at desc limit 15) a)                              as recent_admin;
