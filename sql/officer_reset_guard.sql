-- ============================================================
-- officer_reset_guard.sql
--
-- rpc_admin_reset_officer_cash destroys shares and money without saying so.
--
-- The whole function is:
--
--     update jex_users set cash = 0, holdings = '{}', shorts = '{}',
--                          watchlist = '[]'
--       where role in ('chairman','president','secretary','treasurer',
--                      'compliance_officer');
--
-- Zeroing the cash is the point and is fine. Emptying `holdings` and `shorts`
-- is not: an officer can trade -- nothing in rpc_trade_buy stops one, and the
-- officer roles are explicitly whitelisted past restricted share classes -- so
-- those columns can hold real positions, and this deletes them without
-- returning anything to anybody.
--
-- Measured against this database's own function bodies running locally. One
-- officer holding 400 shares of a 2,000-share company and short 200 more:
--
--                          before        after
--     ACME issued          2,000         2,000
--     ACME unsold          1,400         1,400      <- unchanged
--     held by everyone       407             6      <- 401 shares deleted
--     shorted by everyone    428           228      <- 200 borrows deleted
--     money on the exchange  $550,522.96   $536,206.20
--
-- 594 shares of a 2,000-share company now exist nowhere: not unsold, not held.
-- 200 shares were borrowed from a pool that will never get them back. And
-- $14,316.76 left the exchange -- the officer's cash plus the collateral
-- escrowed behind the short, which is somebody's money whichever way you
-- count it.
--
-- ── How much this matters ──
--
-- Less than it sounds, and it is worth being straight about that:
-- **nothing in the app calls this function.** I checked every RPC name in the
-- database against app.js and the HTML -- 127 of them -- and this is one of
-- only three that appear nowhere, along with two harmless contact-message
-- helpers. There is no button. It can only be reached by someone typing the
-- call themselves.
--
-- But it is SECURITY DEFINER and any officer may execute it, so it is one
-- console line away from breaking a company's share accounting in a way that
-- nothing else in the app can put right. It costs one guard to close.
--
-- ── The fix ──
--
-- Refuse when an officer is actually holding something, and name them. The
-- cash reset still works the moment their positions are closed, and closing
-- them the ordinary way pays them properly instead of deleting the shares.
--
-- This deliberately does NOT try to settle the positions itself. Returning the
-- shares to the unsold pool, or paying the officer out, are different policies
-- with different answers about who ends up with the money, and that is a
-- decision about how the class runs -- not something to bury inside a guard.
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
   where n.nspname = 'public' and p.proname = 'rpc_admin_reset_officer_cash';
  if r is null then
    raise exception 'ABORT: rpc_admin_reset_officer_cash not found. Nothing changed.';
  end if;

  if position('v_holders text;' in r.prosrc) > 0 then
    raise notice 'rpc_admin_reset_officer_cash already refuses to delete positions -- skipped.';
    return;
  end if;

  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, 'update jex_users set cash = 0, holdings = ', '')))
         / length('update jex_users set cash = 0, holdings = ');
  if v_n <> 1 then
    raise exception 'ABORT: expected the reset UPDATE exactly once, found %. Nothing changed.', v_n;
  end if;
  v_n := (length(r.prosrc) - length(replace(r.prosrc, 'v_uid text; v_role text;', '')))
         / length('v_uid text; v_role text;');
  if v_n <> 1 then
    raise exception 'ABORT: expected the declare block exactly once, found %. Nothing changed.', v_n;
  end if;

  execute replace(r.def, r.prosrc,
    replace(
      replace(r.prosrc,
        'v_uid text; v_role text;',
        'v_uid text; v_role text; v_holders text;'),
      'update jex_users set cash = 0, holdings = ',
      '-- This used to empty holdings and shorts outright. An officer can' || v_nl ||
      '  -- trade, so those are real positions: measured, one officer holding' || v_nl ||
      '  -- 400 shares and short 200 more left 594 shares of a 2,000-share' || v_nl ||
      '  -- company existing nowhere -- not unsold, not held -- 200 borrows' || v_nl ||
      '  -- never returned, and $14,316.76 gone from the exchange.' || v_nl ||
      '  select string_agg(u.name || '' ('' || u.role || '')'', '', '' order by u.name)' || v_nl ||
      '    into v_holders' || v_nl ||
      '    from jex_users u' || v_nl ||
      '   where u.role in (''chairman'',''president'',''secretary'',''treasurer'',''compliance_officer'')' || v_nl ||
      '     and (coalesce(u.holdings, ''{}''::jsonb) <> ''{}''::jsonb' || v_nl ||
      '       or coalesce(u.shorts, ''{}''::jsonb) <> ''{}''::jsonb);' || v_nl ||
      '  if v_holders is not null then' || v_nl ||
      '    raise exception ''%'', format(''%s still hold shares or open shorts. Resetting their cash would delete those positions outright -- the shares would not go back into the unsold pool and the shorts would never be returned. Sell out and cover first, then reset.'', v_holders);' || v_nl ||
      '  end if;' || v_nl ||
      v_nl ||
      '  update jex_users set cash = 0, holdings = '));

  raise notice 'rpc_admin_reset_officer_cash: now refuses rather than deleting an officer''s positions.';
end
$mig$;

-- ── verification ──
--
-- guard_added        the function now refuses instead of deleting
-- officers_at_risk   officers who currently hold shares or shorts -- these
--                    are the positions that would have been destroyed. Empty
--                    is the expected answer.
-- share_accounting   for every listed company: issued, unsold, and the total
--                    actually held. unaccounted should be 0 for each; a
--                    non-zero figure means shares already went missing.
select
  (select position('v_holders text;' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_admin_reset_officer_cash') as guard_added,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'name', u.name, 'role', u.role,
            'holdings', u.holdings, 'shorts', u.shorts) order by u.name), '[]'::jsonb)
     from jex_users u
    where u.role in ('chairman','president','secretary','treasurer','compliance_officer')
      and (coalesce(u.holdings, '{}'::jsonb) <> '{}'::jsonb
        or coalesce(u.shorts, '{}'::jsonb) <> '{}'::jsonb))                    as officers_at_risk,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker,
            'issued', c.shares,
            'unsold', c.shares_avail,
            'held_by_users', h.users_hold,
            'held_by_funds', h.funds_hold,
            'unaccounted', c.shares - c.shares_avail - h.users_hold - h.funds_hold)
          order by c.ticker), '[]'::jsonb)
     from jex_companies c
     cross join lateral (
       select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                         where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as users_hold,
              coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                         where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as funds_hold) h
    where c.status = 'listed' and not coalesce(c.is_index_fund, false))        as share_accounting;
