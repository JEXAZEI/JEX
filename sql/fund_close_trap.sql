-- ============================================================
-- fund_close_trap.sql
--
-- WRITES. Patches three functions. Aborts and changes nothing on any mismatch.
-- Re-running is a no-op.
--
-- ── What is wrong ──
--
-- Closing a fund traps every investor's money in it, permanently.
--
-- rpc_close_fund sets status='closed' with no checks beyond who is asking. It
-- does not care whether the fund still holds stock, or whether anyone still
-- owns units of it. After that:
--
--   rpc_fund_withdraw needs fund.cash >= units * NAV, and NAV counts the
--   HOLDINGS as well as the cash -- so a fund that is mostly invested cannot
--   pay anybody out.
--
--   rpc_fund_sell and rpc_fund_cover_short both open with
--   `if v_fund.status <> 'active' then raise exception 'This fund is closed'`,
--   so the manager cannot liquidate to raise that cash either.
--
-- There is no third path. Measured on a copy of this database -- fund with $500
-- cash and 400 ACME, NAV 125, one investor holding 100 units:
--
--   manager closes the fund                     -> ok
--   investor withdraws 100 units ($12,500)      -> refused, not enough cash
--   manager sells the 400 ACME to raise it      -> refused, fund is closed
--
-- $12,500 of a student's money, locked with no way out for anyone -- not the
-- manager, not the Chairman. One click does it, and the manager may well not
-- be the person who loses.
--
-- ── The fix, in two halves ──
--
-- A fund can only be closed once it is WOUND DOWN -- no holdings, no shorts.
-- At that point its NAV is pure cash, so units * NAV can never exceed the cash
-- on hand and every remaining investor can always get out. The manager sells
-- and covers first, while the fund is still active, exactly as they already
-- can.
--
-- And a fund that is ALREADY closed holding stock -- which this cannot undo
-- retroactively -- must still be able to unwind. Selling and covering are now
-- permitted on a closed fund. Buying and shorting stay blocked, so a closed
-- fund can only ever shrink: it is a wind-down, not a reopening.
--
-- That second half is what rescues anyone already stuck. Without it this
-- migration would prevent the trap for the future and leave today's victims in
-- it.
--
-- ── Method ──
--
-- Executable anchors only, each asserted to occur EXACTLY once per function;
-- every function rebuilt through pg_get_functiondef so signature, volatility,
-- SECURITY DEFINER and any SET clause return exactly as they are. Line endings
-- detected per anchor rather than assumed -- these bodies are a mix.
-- ============================================================

do $mig$
declare
  r record;
  v_new text;
  v_n int;
  v_nl text;
  v_done int := 0;
  a text;
begin
  -- ---------- a closed fund may still be unwound ----------
  for r in
    select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('rpc_fund_sell','rpc_fund_cover_short')
     order by p.proname
  loop
    if position('may still SELL and COVER' in r.prosrc) > 0 then
      raise notice '  % already allows wind-down -- skipped', r.proname;
      v_done := v_done + 1;
      continue;
    end if;

    a := 'if v_fund.status <> ''active'' then raise exception ''This fund is closed''; end if;';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, a, ''))) / length(a);
    if v_n <> 1 then
      raise exception 'ABORT: % status anchor found % times, expected 1. Nothing changed.', r.proname, v_n;
    end if;

    v_nl := case when position(a || chr(13) || chr(10) in r.prosrc) > 0
                 then chr(13) || chr(10) else chr(10) end;

    v_new := replace(r.prosrc, a,
      '-- A closed fund may still SELL and COVER. That is how it is wound' || v_nl ||
      '  -- down, and refusing it is what trapped investors: a fund closed while' || v_nl ||
      '  -- still holding stock could not raise the cash to pay anyone out, and' || v_nl ||
      '  -- could not sell to raise it either. Buying and shorting stay blocked,' || v_nl ||
      '  -- so a closed fund can only ever shrink.' || v_nl ||
      '  if v_fund.status not in (''active'',''closed'') then' || v_nl ||
      '    raise exception ''This fund is not available for trading'';' || v_nl ||
      '  end if;');

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  % now permits wind-down on a closed fund', r.proname;
    v_done := v_done + 1;
  end loop;

  if v_done <> 2 then
    raise exception 'ABORT: expected 2 wind-down functions, handled %.', v_done;
  end if;

  -- ---------- and a fund can only be closed once wound down ----------
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_close_fund';
  if r.proname is null then raise exception 'ABORT: rpc_close_fund not found.'; end if;

  if position('still holds' in r.prosrc) > 0 then
    raise notice '  rpc_close_fund already requires a wound-down fund -- skipped';
  else
    a := 'update jex_funds set status = ''closed'' where id = p_fund_id;';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, a, ''))) / length(a);
    if v_n <> 1 then raise exception 'ABORT: close anchor found % times, expected 1.', v_n; end if;

    v_nl := case when position(chr(13) || chr(10) || '  ' || a in r.prosrc) > 0
                 then chr(13) || chr(10) else chr(10) end;

    v_new := replace(r.prosrc, a,
      '-- Only a wound-down fund may close. With no holdings and no shorts its' || v_nl ||
      '  -- NAV is pure cash, so units * NAV can never exceed the cash on hand' || v_nl ||
      '  -- and every remaining investor can always withdraw. Closing while still' || v_nl ||
      '  -- invested locked their money in permanently -- the fund could not pay' || v_nl ||
      '  -- out and could not sell to fund the payout either.' || v_nl ||
      '  if coalesce(v_fund.holdings, ''{}''::jsonb) <> ''{}''::jsonb' || v_nl ||
      '  or coalesce(v_fund.shorts,   ''{}''::jsonb) <> ''{}''::jsonb then' || v_nl ||
      '    raise exception ''%'', format(''%s still holds positions. Sell everything and cover any shorts first -- otherwise investors cannot be paid out and their money would be stuck in a fund that can no longer trade.'', v_fund.name);' || v_nl ||
      '  end if;' || v_nl || v_nl ||
      '  ' || a);

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_close_fund now requires the fund to be wound down first';
  end if;
end
$mig$;

-- ── Verification ──
--
-- The first three must be true.
--
-- close_requires_wound_down   a fund holding anything cannot be closed.
-- sell_allows_closed          a closed fund can still liquidate...
-- cover_allows_closed         ...and still close its shorts.
-- buy_still_blocked           but it cannot buy. A closed fund only shrinks.
--
-- stuck_funds_now is the one to read: any fund ALREADY closed while holding
-- something. Each is a live trap, and after this runs its manager can finally
-- sell out and let the investors withdraw. Empty means nobody is stuck.
select
  (select prosrc like '%still holds positions%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_close_fund')                  as close_requires_wound_down,
  (select prosrc like '%may still SELL and COVER%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_fund_sell')                   as sell_allows_closed,
  (select prosrc like '%may still SELL and COVER%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_fund_cover_short')            as cover_allows_closed,
  (select prosrc like '%if v_fund.status <> ''active'' then raise exception ''This fund is closed''%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_fund_buy')                    as buy_still_blocked,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'fund', f.name, 'status', f.status, 'cash', f.cash,
            'holdings', f.holdings, 'shorts', f.shorts,
            'units_outstanding', f.units_outstanding,
            'investor_money_at_nav', round(f.units_outstanding * jex_fund_nav(f.id), 2))
          order by f.name), '[]'::jsonb)
     from jex_funds f
    where f.status <> 'active'
      and (coalesce(f.holdings,'{}'::jsonb) <> '{}'::jsonb
        or coalesce(f.shorts,'{}'::jsonb) <> '{}'::jsonb))                    as stuck_funds_now;
