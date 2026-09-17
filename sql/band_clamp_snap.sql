-- ============================================================
-- band_clamp_snap.sql
--
-- WRITES. Rewrites one function, which eight others call. Aborts and changes
-- nothing on any mismatch. Re-running is a no-op.
--
-- ── What is wrong ──
--
-- A stock sitting outside its price band is snapped violently back to the band
-- edge by the very next trade, at a price the market never made and nobody was
-- quoted.
--
-- jex_band_clamp takes the proposed fill price and returns
--
--   least(greatest(p_proposed, v_lo), v_hi)
--
-- which forces the result INTO [lo, hi] no matter where the price already was.
-- It takes p_current as an argument and never looks at it.
--
-- Measured on a copy of this database. ACME at $45.00, session open $30.00,
-- band +/-30%, so the allowed range is $21.00 - $39.00. A student sells TEN
-- shares:
--
--   the client quotes         $44.93   (impactPrice, holding it where it is)
--   the server fills at       $39.00   (snapped to the band edge)
--   the student is paid         $390.00, not the ~$449 they were shown
--   ACME drops                $45.00 -> $39.00, down 13.3%, on ten shares
--
-- Every other ACME holder just lost 13.3% because one student sold ten shares,
-- and the seller was paid $59 less than the ticket said. In the other
-- direction it is worse: a stock stranded BELOW its band pays the seller MORE
-- than the market price -- measured at $11.04 a share on a stock trading at
-- $7.29, out of the company owner's cash, for a price nothing ever traded at.
--
-- ── Why it is the odd one out ──
--
-- Three places in this codebase implement the band, and the other two already
-- agree with each other:
--
--   rpc_trade_buy's REJECT check      (v_new > v_upper AND v_new > v_co.price)
--   app.js bandClamp()                min(max(p, min(lo,cur)), max(hi,cur))
--
-- Both say the same thing: a trade is only stopped when it moves the price
-- FURTHER out of the band. A stock already outside is held where it is, not
-- dragged back. app.js even carries the comment "Same rule, same reason, as
-- the SQL" -- which is what made this worth checking, because it was not true.
--
-- jex_band_clamp is the clamped path -- selling, shorting, covering, margin
-- calls, stop losses. Those are clamped rather than rejected on purpose:
-- refusing a sell would trap anyone holding a stock at the floor, since every
-- sell pushes it lower. But clamping is supposed to stop the price going
-- further out, not to teleport it back in.
--
-- How a stock ends up outside its band in the first place: an admin price
-- adjustment past the band edge, which price_axis_and_band.sql now prevents.
-- Anything already stranded stays stranded until the next session open
-- re-records the baseline -- and until then, its next sell does this.
--
-- ── The fix ──
--
-- Clamp into [least(lo, current), greatest(hi, current)] -- the same range
-- app.js has always used. A price inside the band is unaffected, because
-- current is inside it too. A price outside is held at its own level instead
-- of being snapped, and can still move back toward the band freely.
--
-- ── Method ──
--
-- The function is four lines, so its ENTIRE current body is asserted
-- byte-for-byte (line endings normalised) before anything is replaced, and it
-- is rebuilt through pg_get_functiondef so the signature, volatility and any
-- SET clause return exactly as they are. The eight callers are untouched --
-- they already pass p_current, which this finally uses.
-- ============================================================

do $mig$
declare
  r record;
  v_old text; v_new text; v_nl text;
  v_expect constant text := chr(10) ||
'declare v_open numeric; v_pct numeric; v_hi numeric; v_lo numeric;
begin
  select price_band_pct, (session_open_prices->>p_ticker)::numeric into v_pct, v_open from jex_session where id=1;
  if v_open is null then return p_proposed; end if;
  v_hi := round(v_open*(1+v_pct/100),2); v_lo := round(v_open*(1-v_pct/100),2);
  return least(greatest(p_proposed, v_lo), v_hi);
end ';
begin
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'jex_band_clamp';
  if r.proname is null then raise exception 'ABORT: jex_band_clamp not found.'; end if;

  if position('least(v_lo, p_current)' in r.prosrc) > 0 then
    raise notice '  jex_band_clamp already holds a stranded price where it is -- skipped';
    return;
  end if;

  v_old := replace(r.prosrc, chr(13), '');
  if v_old <> v_expect then
    raise exception 'ABORT: jex_band_clamp does not match the expected body (% chars vs %). Nothing changed.',
      length(v_old), length(v_expect);
  end if;

  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_new := chr(10) ||
'declare v_open numeric; v_pct numeric; v_hi numeric; v_lo numeric;
begin
  select price_band_pct, (session_open_prices->>p_ticker)::numeric into v_pct, v_open from jex_session where id=1;
  if v_open is null then return p_proposed; end if;
  v_hi := round(v_open*(1+v_pct/100),2); v_lo := round(v_open*(1-v_pct/100),2);

  -- The range is widened to take in wherever the price ALREADY is. Clamping
  -- into [v_lo, v_hi] flat dragged a stranded price back to the band edge on
  -- the next trade, at a level nothing ever traded at and nobody was quoted:
  -- measured, ACME at $45.00 against a $21.00-$39.00 band filled a TEN-share
  -- sell at $39.00, paying the student $59 less than the ticket said and
  -- taking every other holder down 13.3% on ten shares. A stock stranded
  -- BELOW its band was worse -- it paid the seller $11.04 on a $7.29 stock,
  -- out of the company owner''s cash.
  --
  -- This is what rpc_trade_buy''s reject check and app.js bandClamp() have
  -- always done: stop a price going FURTHER out of the band, never haul it
  -- back in. A price inside the band is unaffected, because p_current is
  -- inside it too.
  return least(greatest(p_proposed, least(v_lo, p_current)), greatest(v_hi, p_current));
end ';

  if v_nl <> chr(10) then v_new := replace(v_new, chr(10), v_nl); end if;

  execute replace(r.def, r.prosrc, v_new);
  raise notice '  jex_band_clamp: a stranded price is held where it is, not snapped to the band edge';
end
$mig$;

-- ── Verification ──
--
-- The first two must be true.
--
-- holds_a_stranded_price  the clamp widens its range to include wherever the
--                         price already is.
-- eight_callers_unchanged the sell, short, cover, fund, margin-call and
--                         stop-loss paths all still go through it -- this
--                         fixes them all at once and touches none of them.
--
-- stranded_now is the one to read: every listed stock whose price is outside
-- its own band right now. Before this, the next sell, short or cover on any of
-- them jumped the price straight to the band edge. `next_sell_would_have_
-- snapped_to` is where it would have gone, and `gap` is how far that is from
-- where the stock actually trades -- money that would have moved between a
-- student and the company for no reason. Empty means nothing is stranded.
select
  (select prosrc like '%least(v_lo, p_current)%' and prosrc like '%greatest(v_hi, p_current)%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='jex_band_clamp')                     as holds_a_stranded_price,
  (select count(*) = 8 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosrc like '%jex_band_clamp%'
      and p.proname <> 'jex_band_clamp')                                         as eight_callers_unchanged,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', q.ticker, 'price', q.price, 'session_open', q.open_price,
            'band_low', q.lo, 'band_high', q.hi,
            'next_sell_would_have_snapped_to', case when q.price > q.hi then q.hi else q.lo end,
            'gap', round(abs(q.price - case when q.price > q.hi then q.hi else q.lo end), 2),
            'shares_in_hands', coalesce((select sum((u.holdings->>q.ticker)::numeric) from jex_users u
                                          where coalesce(u.holdings,'{}'::jsonb) ? q.ticker), 0))
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
    where q.price > q.hi or q.price < q.lo)                                      as stranded_now;
