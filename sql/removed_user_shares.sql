-- ============================================================
-- removed_user_shares.sql
--
-- Removing an account deletes the shares it was holding.
--
-- A student's holdings live in a jsonb column on their own jex_users row, so
-- `delete from jex_users where id = p_user_id` takes the shares with it.
-- Nothing puts them back into the company's unsold pool, so the arithmetic
-- that has to hold --
--
--     shares = shares_avail + held_by_users + held_by_funds
--
-- -- stops holding, permanently, and by exactly what the leaver was holding.
--
-- rpc_admin_remove_user already refuses when the account owns a LISTED
-- company, and tells you to delist first because that settles every
-- shareholder. It has no equivalent thought for an account that is merely a
-- shareholder itself.
--
-- Measured against this database's own function bodies running locally. One
-- student holding 4 shares of a 2,000-share company, removed by an officer:
--
--                        before     after
--     issued              2,000      2,000
--     unsold              1,400      1,400     <- unchanged
--     held by everyone      308        304     <- 4 shares deleted
--     unaccounted            89         93
--
-- ── This is already the case here ──
--
-- The verification on officer_reset_guard.sql reported it on every listed
-- company on this exchange:
--
--     AZEI     2,000 issued   1,262 unsold     729 held    9 unaccounted
--     TCO1       500 issued     496 unsold       0 held    4 unaccounted
--     TCO1.B     200 issued     196 unsold       0 held    4 unaccounted
--     TCO2       500 issued     496 unsold       0 held    4 unaccounted
--
-- 21 shares that exist nowhere. Three test companies missing exactly 4 each
-- looks like the same account being removed while holding 4 of each.
--
-- **This migration does not touch that data.** It fixes the function so it
-- stops happening; the verification below reports the current discrepancy so
-- you can see it against these numbers. Putting the missing shares back is a
-- separate decision and a separate file -- I am not going to edit a live share
-- register on an inference about how they went missing.
--
-- ── What the fix does, and what it chooses ──
--
-- The shares go back into the company's unsold pool. The leaver is paid
-- nothing -- they are gone, and their cash leaves with the account either way.
--
-- That is a choice and it is worth naming: the company gets its float back
-- without paying for it. The alternative I rejected was refusing the removal
-- until the holdings are sold, which is what this function already does for a
-- company owner. It does not work here: there is no admin action anywhere in
-- this app that can liquidate somebody else's portfolio, so refusing would
-- mean an account that has ever bought anything can never be removed at all.
--
-- If you would rather a departing student's position simply stay put, that is
-- what rpc_admin_mark_departed is for -- it sets departed_at and leaves
-- everything alone. Removal is the destructive path, and this makes it destroy
-- one thing instead of two.
--
-- ── Shorts are deliberately left alone ──
--
-- Shorting never touches shares_avail in this engine, so an open short does
-- not affect the identity above and nothing needs returning. Removing the
-- account does take the escrowed collateral out of the exchange along with
-- their cash -- measured at $7,100 on a $5,000 balance with $2,100 posted --
-- but that is the leaver's own money leaving with them, which is what removal
-- means.
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
   where n.nspname = 'public' and p.proname = 'rpc_admin_remove_user';
  if r is null then
    raise exception 'ABORT: rpc_admin_remove_user not found. Nothing changed.';
  end if;

  if position('v_give_back record;' in r.prosrc) > 0 then
    raise notice 'rpc_admin_remove_user already returns held shares -- skipped.';
    return;
  end if;

  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, '  v_target record;', '')))
         / length('  v_target record;');
  if v_n <> 1 then
    raise exception 'ABORT: expected the declare block exactly once, found %. Nothing changed.', v_n;
  end if;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, '  delete from jex_users where id = p_user_id;', '')))
         / length('  delete from jex_users where id = p_user_id;');
  if v_n <> 1 then
    raise exception 'ABORT: expected the delete exactly once, found %. Nothing changed.', v_n;
  end if;

  v_src := replace(r.prosrc, '  v_target record;',
                             '  v_target record;' || v_nl ||
                             '  v_give_back record;' || v_nl ||
                             '  v_returned jsonb := ''{}''::jsonb;');

  v_src := replace(v_src, '  delete from jex_users where id = p_user_id;',
    '  -- Holdings live on the row being deleted, so without this the shares' || v_nl ||
    '  -- simply cease to exist: shares_avail is not touched and' || v_nl ||
    '  -- shares = shares_avail + held stops holding, by exactly what the' || v_nl ||
    '  -- leaver had. Measured: removing a student holding 4 of a 2,000-share' || v_nl ||
    '  -- company left 4 shares accounted for nowhere.' || v_nl ||
    '  --' || v_nl ||
    '  -- They go back to the unsold pool. The leaver is paid nothing -- their' || v_nl ||
    '  -- cash leaves with the account regardless -- and least() keeps the' || v_nl ||
    '  -- chk_companies_shares_avail_le_shares constraint satisfied even if the' || v_nl ||
    '  -- register was already inconsistent before this ran.' || v_nl ||
    '  for v_give_back in' || v_nl ||
    '    select k.key as ticker, coalesce((k.value)::text::numeric, 0) as qty' || v_nl ||
    '      from jsonb_each(coalesce(v_target.holdings, ''{}''::jsonb)) k' || v_nl ||
    '     order by k.key' || v_nl ||
    '  loop' || v_nl ||
    '    continue when v_give_back.qty <= 0;' || v_nl ||
    '    update jex_companies' || v_nl ||
    '       set shares_avail = least(shares, shares_avail + v_give_back.qty::integer)' || v_nl ||
    '     where ticker = v_give_back.ticker;' || v_nl ||
    '    if found then' || v_nl ||
    '      v_returned := jsonb_set(v_returned, array[v_give_back.ticker], to_jsonb(v_give_back.qty));' || v_nl ||
    '    end if;' || v_nl ||
    '  end loop;' || v_nl ||
    v_nl ||
    '  delete from jex_users where id = p_user_id;');

  v_src := replace(v_src,
    'return jsonb_build_object(''removed'', true, ''user_id'', p_user_id);',
    'return jsonb_build_object(''removed'', true, ''user_id'', p_user_id,' || v_nl ||
    '    ''shares_returned'', v_returned);');

  execute replace(r.def, r.prosrc, v_src);
  raise notice 'rpc_admin_remove_user: a leaver''s shares now go back to the unsold pool.';
end
$mig$;

-- ── verification ──
--
-- returns_shares     the fix is in
-- reports_what       the RPC now tells the caller which shares went back
-- share_register     issued / unsold / held for every listed company, with
--                    what is unaccounted for. This migration does NOT change
--                    these numbers -- it stops them getting worse. Compare
--                    against the figures in the header.
-- total_missing      the sum, so there is one number to watch
-- holders_who_left   accounts marked departed that still hold shares. These
--                    are the ones where removing them would have leaked, and
--                    now will not.
select
  (select position('v_give_back record;' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_admin_remove_user')        as returns_shares,

  (select position('''shares_returned'', v_returned' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_admin_remove_user')        as reports_what,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker, 'issued', c.shares, 'unsold', c.shares_avail,
            'held_by_users', h.u, 'held_by_funds', h.f,
            'unaccounted', c.shares - c.shares_avail - h.u - h.f)
          order by c.ticker), '[]'::jsonb)
     from jex_companies c
     cross join lateral (
       select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                         where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as u,
              coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                         where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as f) h
    where c.status = 'listed' and not coalesce(c.is_index_fund, false))        as share_register,

  (select coalesce(sum(c.shares - c.shares_avail - h.u - h.f), 0)
     from jex_companies c
     cross join lateral (
       select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                         where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as u,
              coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                         where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as f) h
    where c.status = 'listed' and not coalesce(c.is_index_fund, false))        as total_missing,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'name', u.name, 'departed', u.departed_at::date,
            'holdings', u.holdings, 'shorts', u.shorts) order by u.name), '[]'::jsonb)
     from jex_users u
    where u.departed_at is not null
      and (coalesce(u.holdings,'{}'::jsonb) <> '{}'::jsonb
        or coalesce(u.shorts,'{}'::jsonb) <> '{}'::jsonb))                     as holders_who_left;
