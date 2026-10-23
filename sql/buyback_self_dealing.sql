-- ============================================================
-- buyback_self_dealing.sql
--
-- rpc_buyback (buyback_cascade.sql) lifts resting sell orders at whatever
-- price each one asks, skipping only the company owner's own. Two faults,
-- both run on a scratch copy of the function exactly as buyback_cascade.sql
-- created it:
--
-- ── 1. A founder could pay themselves the company's cash ──
--
-- Founders may call rpc_buyback. A founder holding one share posted it for
-- sale at $4,999.00 and bought it back on the company's behalf:
--
--     company cash   $5,000.00 -> $1.00
--     founder cash     $100.00 -> $5,099.00
--
-- The owner was never involved. It is the same self-dealing
-- founder_selfgrant.sql closed for share grants. With unsold stock the
-- founder simply asks for one share more than is unsold; the unsold shares
-- are cancelled first, for free, and the next one bought is theirs.
--
-- ── 2. A buyback ignored the price band ──
--
-- An ask far above the band never fills through the matcher, but the buyback
-- filled it and then set the company's price to it. ACME opened at $30.00
-- with a 30% band ($21.00-$39.00); one share offered at $1,000.00 was bought
-- back and ACME's price became $1,000.00. A student holding 200 ACME was then
-- marked at $200,000.00 instead of $6,000.00, and with the price stranded
-- above the band every buy was refused -- the frozen one-way market
-- price_axis_and_band.sql fixed.
--
-- Now a buyback buys only from people who are not running the company (not
-- the caller, not the owner, not an accepted founder), and only at or below
-- today's band ceiling. Anything else stays on the book, and the remainder
-- goes to the tender, which was already held to the band. Founders who want
-- to sell can still sell to the market like anyone else.
--
-- Also gives rpc_buyback a fixed search_path; buyback_cascade.sql created it
-- without one (see the README on why that matters).
--
-- Refuses to run, changing nothing, unless the line it changes appears in
-- rpc_buyback exactly once. Safe to run twice.
-- ============================================================

do $mig$
declare
  r record;
  v_old text := 'and coalesce(user_id, '''') is distinct from v_co.owner_id';
  v_new text;
  v_nl  text;
  v_hits int;
begin
  select p.oid, p.prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_buyback';
  if r.oid is null then raise exception 'ABORT: rpc_buyback not found. Nothing changed.'; end if;

  if position('is distinct from v_uid' in r.prosrc) > 0 then
    raise notice 'rpc_buyback already skips the caller''s own asks -- skipped.';
  else
    v_hits := (length(r.prosrc) - length(replace(r.prosrc, v_old, ''))) / length(v_old);
    if v_hits <> 1 then
      raise exception 'ABORT: expected the owner filter exactly once in rpc_buyback, found %. Nothing changed -- paste this error back.', v_hits;
    end if;
    v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;
    v_new := v_old || v_nl
      || '           -- Not whoever is running this buyback, nor any founder: one share' || v_nl
      || '           -- posted at $4,999 and bought back by its own founder moved the' || v_nl
      || '           -- company''s cash into theirs. And only inside today''s band: an ask' || v_nl
      || '           -- at $1,000 on a $30 stock was filled and became the price.' || v_nl
      || '           -- (buyback_self_dealing.sql)' || v_nl
      || '           and coalesce(user_id, '''') is distinct from v_uid' || v_nl
      || '           and not exists (select 1 from jex_company_members m' || v_nl
      || '                            where m.company_user_id = v_co.owner_id' || v_nl
      || '                              and m.student_id = jex_limit_orders.user_id' || v_nl
      || '                              and m.status = ''accepted'')' || v_nl
      || '           and limit_price <= coalesce((select round((s.session_open_prices->>p_ticker)::numeric' || v_nl
      || '                                                     * (1 + s.price_band_pct / 100), 2)' || v_nl
      || '                                          from jex_session s where s.id = 1), limit_price)';
    execute replace(r.def, r.prosrc, replace(r.prosrc, v_old, v_new));
    raise notice 'rpc_buyback: buys only from outsiders, inside the band.';
  end if;

  execute format('alter function %s set search_path to ''public''', r.oid::regprocedure);
end
$mig$;

-- ── verification ──
-- skips_caller_and_founders   true: the caller's and founders' asks are left alone
-- held_to_band                true: asks above today's ceiling are left alone
-- search_path_fixed           true: rpc_buyback runs with search_path=public
-- asks_it_would_now_skip      open sell asks the new filter excludes, today
select
  (select position('is distinct from v_uid' in prosrc) > 0 and position('m.status = ''accepted''' in prosrc) > 0
     from pg_proc where proname = 'rpc_buyback')                                     as skips_caller_and_founders,
  (select position('* (1 + s.price_band_pct / 100), 2)' in prosrc) > 0
     from pg_proc where proname = 'rpc_buyback')                                     as held_to_band,
  (select coalesce(array_to_string(proconfig, ',') like '%search_path=public%', false)
     from pg_proc where proname = 'rpc_buyback')                                     as search_path_fixed,
  (select coalesce(jsonb_agg(jsonb_build_object('ticker', o.ticker, 'qty', o.qty, 'price', o.limit_price)
                             order by o.ticker), '[]'::jsonb)
     from jex_limit_orders o join jex_companies c on c.ticker = o.ticker, jex_session s
    where s.id = 1 and o.side = 'sell' and o.status = 'open'
      and (exists (select 1 from jex_company_members m
                    where m.company_user_id = c.owner_id and m.student_id = o.user_id and m.status = 'accepted')
           or o.limit_price > round((s.session_open_prices->>o.ticker)::numeric * (1 + s.price_band_pct / 100), 2)))
                                                                                     as asks_it_would_now_skip;
