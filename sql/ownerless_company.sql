-- ============================================================
-- ownerless_company.sql
--
-- WRITES. Patches four functions. Aborts and changes nothing on any mismatch.
-- Re-running is a no-op.
--
-- ── What is wrong ──
--
-- jex_companies_owner_id_fkey is ON DELETE SET NULL. So when an officer removes
-- a company account with rpc_admin_remove_user, the company's STOCK stays
-- listed and simply loses its owner.
--
-- Every money path through the unsold pool is written as
--
--     if v_co.owner_id is not null then ... pay the owner ... end if;
--
-- or as an UPDATE on `where id = v_co.owner_id`, which quietly matches zero
-- rows when that is null. So against an ownerless company:
--
--     BUYING  destroys money -- the student pays and nobody is credited
--     SELLING creates  money -- the student is paid and nobody is debited
--
-- Measured on a copy of this database, ACME at $30 with its owner removed:
--
--     buy 10   -> student pays $300.50, money supply falls $300.50
--     sell 10  -> student gets  $300.00, money supply rises $300.00
--
-- It is not a farm -- the round trip still loses the price impact -- but it
-- breaks conservation in both directions, and on a graded leaderboard a
-- student holding that stock when the owner is removed can cash out shares
-- that nobody is paying for.
--
-- ── What this does NOT touch ──
--
-- The index. JXI and every classroom index are deliberately ownerless and go
-- through their own branch, which never looks for an owner. Each guard below
-- excludes is_index_fund explicitly.
--
-- (Worth knowing separately, and NOT a bug this file fixes: because the index
-- has no owner and no basket, a JXI profit is minted and a JXI loss is burned.
-- Measured: buy 100 units at $10 destroys $1,000, the index rises 10%, selling
-- at $11 creates $1,100 -- net $100 of new money, exactly the student's gain.
-- That is the direct consequence of tracking the level without holding a
-- basket, which is the design that was chosen deliberately. It is not
-- risk-free money, but JXI gains are unfunded, which matters if the
-- leaderboard is graded.)
--
-- ── The fix, in two layers ──
--
-- Stop the state from arising: rpc_admin_remove_user refuses to delete someone
-- who still owns a listed company, and points at delisting, which settles every
-- shareholder and closes the shorts before the stock stops trading.
--
-- And refuse to trade one that already exists: rpc_trade_buy, rpc_trade_sell
-- and rpc_fill_limit_vs_pool all decline a company with no owner rather than
-- inventing or destroying the other side of the trade. Shareholders are not
-- stranded by that -- delisting still settles them, and it is the only thing
-- that should.
--
-- ── A third way to strand people, same family ──
--
-- rpc_admin_remove_share_class deletes the class's jex_companies row without
-- checking whether anybody holds it. Holdings live in a jsonb column with no
-- foreign key, so every holder is left with an orphaned ticker that no screen
-- can price. Measured: a student holding 200 ACME.B at $30 watched $6,000
-- become $0 -- no warning, no compensation, and nothing left to sell.
--
-- Guarded the same way: refuse while investors hold it, and point at delisting,
-- which pays them first. A class that is merely a relabelling of the parent
-- (ticker = parent_ticker) keeps its company row and is unaffected.
--
-- ── Method ──
--
-- Executable anchors only, each asserted to occur EXACTLY once; every function
-- rebuilt through pg_get_functiondef so the signature, volatility, SECURITY
-- DEFINER and any SET clause come back exactly as they are. Line endings are
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
  g text;
begin
  -- ---------- the three trading paths ----------
  for r in
    select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('rpc_trade_buy','rpc_trade_sell','rpc_fill_limit_vs_pool')
     order by p.proname
  loop
    if position('has no owner right now' in r.prosrc) > 0
    or position('company_has_no_owner' in r.prosrc) > 0 then
      raise notice '  % already guarded -- skipped', r.proname;
      v_done := v_done + 1;
      continue;
    end if;

    if r.proname = 'rpc_fill_limit_vs_pool' then
      a := 'if v_co is null then return jsonb_build_object(''filled'', false, ''reason'', ''company_not_found''); end if;';
      g := 'if v_co.owner_id is null and not coalesce(v_co.is_index_fund, false) then'
           || '{NL}' || '    return jsonb_build_object(''filled'', false, ''reason'', ''company_has_no_owner'');'
           || '{NL}' || '  end if;';
    else
      a := 'if v_co is null then raise exception ''Company not found''; end if;';
      g := 'if v_co.owner_id is null and not coalesce(v_co.is_index_fund, false) then'
           || '{NL}' || '    raise exception ''%'', format(''%s has no owner right now, so there is nobody on the other side of this trade. An officer needs to delist it -- which settles every shareholder -- before it can trade again.'', p_ticker);'
           || '{NL}' || '  end if;';
    end if;

    v_n := (length(r.prosrc) - length(replace(r.prosrc, a, ''))) / length(a);
    if v_n <> 1 then
      raise exception 'ABORT: % anchor found % times, expected 1. Nothing changed.', r.proname, v_n;
    end if;

    -- Which line ending sits right after the anchor. These bodies are a mix:
    -- earlier migrations spliced CRLF into functions that were otherwise LF,
    -- so asking whether the body "has" CRLF answers the wrong question.
    v_nl := case when position(a || chr(13) || chr(10) in r.prosrc) > 0
                 then chr(13) || chr(10) else chr(10) end;

    v_new := replace(r.prosrc, a,
      a || v_nl || v_nl ||
      '  -- A listed company with no owner has no counterparty. owner_id is ON' || v_nl ||
      '  -- DELETE SET NULL, so removing a company account leaves its stock' || v_nl ||
      '  -- listed and ownerless -- and then buying DESTROYS the cash (nobody is' || v_nl ||
      '  -- credited) while selling CREATES it (nobody is debited). Measured at' || v_nl ||
      '  -- $300.50 destroyed on a 10-share buy and $300.00 created selling them' || v_nl ||
      '  -- back. The index is deliberately ownerless and handled by its own' || v_nl ||
      '  -- branch, so it is excluded here.' || v_nl ||
      '  ' || replace(g, '{NL}', v_nl));

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  % now refuses an ownerless company', r.proname;
    v_done := v_done + 1;
  end loop;

  if v_done <> 3 then
    raise exception 'ABORT: expected 3 trading functions, handled %.', v_done;
  end if;

  -- ---------- stop the state from arising ----------
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_admin_remove_user';
  if r.proname is null then raise exception 'ABORT: rpc_admin_remove_user not found.'; end if;

  -- This check used to look for a phrase that is not in the text below, so it
  -- never fired and a second run appended a SECOND copy of the guard. The copy
  -- is unreachable -- the first one raises -- so nothing behaved differently,
  -- but the function grew on every run. Both halves are fixed here: the marker
  -- now matches what is actually written, and an existing duplicate is
  -- collapsed.
  declare
    v_mark constant text := 'which is still listed. Delist it first';
    v_head constant text := '-- Removing the account would leave the stock listed with nobody on the';
    v_dup  text;
    v_at1  int; v_at2 int;
  begin
    if (length(r.prosrc) - length(replace(r.prosrc, v_mark, ''))) / length(v_mark) > 1 then
      v_at1 := position(v_head in r.prosrc);
      v_at2 := position(v_head in substring(r.prosrc from v_at1 + length(v_head))) + v_at1 + length(v_head) - 1;
      v_dup := substring(r.prosrc from v_at1 for v_at2 - v_at1);
      if v_dup <> '' and position(v_dup || v_dup in r.prosrc) > 0 then
        execute replace(r.def, r.prosrc, replace(r.prosrc, v_dup || v_dup, v_dup));
        select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'rpc_admin_remove_user';
        raise notice '  rpc_admin_remove_user carried the guard twice -- duplicate removed';
      end if;
    end if;
  end;

  if position('which is still listed. Delist it first' in r.prosrc) > 0 then
    raise notice '  rpc_admin_remove_user already refuses owners of listed companies -- skipped';
  else
    a := 'delete from jex_users where id = p_user_id;';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, a, ''))) / length(a);
    if v_n <> 1 then raise exception 'ABORT: remove_user anchor found % times, expected 1.', v_n; end if;
    v_nl := case when position(chr(13) || chr(10) || '  ' || a in r.prosrc) > 0
                 then chr(13) || chr(10) else chr(10) end;
    v_new := replace(r.prosrc, a,
      '-- Removing the account would leave the stock listed with nobody on the' || v_nl ||
      '  -- other side of it, because owner_id is ON DELETE SET NULL. Delisting' || v_nl ||
      '  -- is the path that exists for this: it pays every shareholder, closes' || v_nl ||
      '  -- the shorts and cancels the resting orders first.' || v_nl ||
      '  if exists (select 1 from jex_companies c' || v_nl ||
      '              where c.owner_id = p_user_id and c.status = ''listed''' || v_nl ||
      '                and not coalesce(c.is_index_fund, false)) then' || v_nl ||
      '    raise exception ''%'', format(''%s still owns %s, which is still listed. Delist it first -- that settles every shareholder and closes the shorts -- then remove the account.'',' || v_nl ||
      '      v_target.name, (select string_agg(c.ticker, '', '') from jex_companies c' || v_nl ||
      '                       where c.owner_id = p_user_id and c.status = ''listed''' || v_nl ||
      '                         and not coalesce(c.is_index_fund, false)));' || v_nl ||
      '  end if;' || v_nl || v_nl ||
      '  ' || a);
    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_admin_remove_user now refuses while a listed company is owned';
  end if;

  -- ---------- and do not delete a security people still hold ----------
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_admin_remove_share_class';
  if r.proname is null then raise exception 'ABORT: rpc_admin_remove_share_class not found.'; end if;

  if position('is still held by investors' in r.prosrc) > 0 then
    raise notice '  rpc_admin_remove_share_class already refuses while held -- skipped';
  else
    a := 'delete from jex_share_classes where ticker = p_ticker;';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, a, ''))) / length(a);
    if v_n <> 1 then raise exception 'ABORT: share-class anchor found % times, expected 1.', v_n; end if;
    v_nl := case when position(chr(13) || chr(10) || '  ' || a in r.prosrc) > 0
                 then chr(13) || chr(10) else chr(10) end;
    v_new := replace(r.prosrc, a,
      '-- Deleting the class''s company row leaves every holder with an orphaned' || v_nl ||
      '  -- ticker: holdings are a jsonb column with no foreign key, so nothing' || v_nl ||
      '  -- cleans them up and no screen can price them. Measured at $6,000 of a' || v_nl ||
      '  -- student''s holdings silently becoming $0. Delisting is the path that' || v_nl ||
      '  -- exists for this -- it pays every holder before the stock stops' || v_nl ||
      '  -- trading. A class that is only a relabelling of the parent keeps its' || v_nl ||
      '  -- company row, so it is exempt.' || v_nl ||
      '  if not v_is_conversion and exists (' || v_nl ||
      '       select 1 from jex_users u where coalesce((u.holdings->>p_ticker)::numeric, 0) > 0' || v_nl ||
      '        union all' || v_nl ||
      '       select 1 from jex_funds f where coalesce((f.holdings->>p_ticker)::numeric, 0) > 0) then' || v_nl ||
      '    raise exception ''%'', format(''%s is still held by investors, so removing it would wipe out what they hold. Delist it first -- that pays every holder -- then remove the class.'', p_ticker);' || v_nl ||
      '  end if;' || v_nl || v_nl ||
      '  ' || a);
    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_admin_remove_share_class now refuses while investors hold it';
  end if;
end
$mig$;

-- ── Verification ──
--
-- The first four must be true.
--
-- buy_guarded / sell_guarded / fill_guarded   the money paths refuse.
-- remove_user_guarded                          the state cannot arise.
-- index_still_exempt                           every guard excludes the index,
--                                              which is ownerless on purpose.
--
-- ownerless_listed_now is the one to read: any non-index company that is
-- ALREADY listed with no owner. Each one is a live conservation hole until it
-- is delisted. If this comes back empty, the guards are purely preventive.
select
  (select prosrc like '%has no owner right now%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_trade_buy')                   as buy_guarded,
  (select prosrc like '%has no owner right now%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_trade_sell')                  as sell_guarded,
  (select prosrc like '%company_has_no_owner%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_fill_limit_vs_pool')          as fill_guarded,
  (select prosrc like '%still owns a listed company%' or prosrc like '%still owns %s, which is still listed%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_remove_user')           as remove_user_guarded,
  (select prosrc like '%is still held by investors%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_remove_share_class')    as class_removal_guarded,
  (select count(*) = 3 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname in ('rpc_trade_buy','rpc_trade_sell','rpc_fill_limit_vs_pool')
      and p.prosrc like '%not coalesce(v_co.is_index_fund, false)%')          as index_still_exempt,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker, 'name', c.name, 'status', c.status,
            'shares_held_by_investors',
              coalesce((select sum(coalesce((u.holdings->>c.ticker)::numeric,0)) from jex_users u),0)
            + coalesce((select sum(coalesce((f.holdings->>c.ticker)::numeric,0)) from jex_funds f),0))
          order by c.ticker), '[]'::jsonb)
     from jex_companies c
    where c.owner_id is null
      and not coalesce(c.is_index_fund, false)
      and c.status = 'listed')                                                as ownerless_listed_now;
