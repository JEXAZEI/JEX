-- ============================================================
-- record_is_not_null.sql
--
-- WRITES. Patches six functions. Aborts and changes nothing on any mismatch.
-- Re-running is a no-op.
--
-- ── What is wrong ──
--
-- `record IS NOT NULL` in PL/pgSQL does not mean "a row was found". It is true
-- only when EVERY field of the record is non-null. One nullable column with a
-- null in it and the whole test is false, even though the row is right there.
--
-- (The opposite test, `record IS NULL`, does mean what it looks like -- it is
-- true only when every field is null, which is exactly the not-found case. So
-- the dozens of `if v_co is null then raise exception 'Company not found'`
-- checks throughout this schema are correct. Only the negated form is broken,
-- and it is used in six places.)
--
-- ── 1. A restricted share class is not restricted ──
--
-- Four functions gate the whitelist behind it:
--
--   select * into v_meta from jex_share_classes where ticker = p_ticker;
--   if v_meta is not null and coalesce(v_meta.restricted,false) then
--     ... whitelist check ...
--   end if;
--
-- jex_share_classes.whitelist, .owner_id and .created_at are all nullable. A
-- class row with any one of them null makes `v_meta is not null` false, the
-- whole block is skipped, and the class is open to everybody.
--
-- Measured on a copy of this database. ACME.B, restricted, whitelist ["u_s1"],
-- owner_id null:
--
--   row found = true
--   (v_meta is not null) = false        <- the guard
--   Student 2, not on the whitelist, buys 25 shares -> SUCCEEDS
--
-- Then, with owner_id and created_at filled in so that every column is
-- non-null, the same buy is refused with "This share class is restricted --
-- you are not on the whitelist." The feature works only by accident, on the
-- rows that happen to have nothing missing.
--
-- rpc_trade_buy, rpc_place_limit_order, rpc_fund_buy and rpc_fund_short all
-- have it, so market orders, resting limit orders, fund buying and fund
-- shorting are all open.
--
-- ── 2. A CEO cannot cancel their own delisting ──
--
-- rpc_cancel_delisting allows the applicant or the company's owner:
--
--   if not (v_app.user_id = v_uid or (v_co is not null and v_co.owner_id = v_uid)) then
--
-- Same test, so the owner arm never fires on a company row with any null
-- column -- and every company has nullable columns (funding_goal,
-- use_of_funds, classroom_id). An owner who did not personally file the
-- application is told they are not allowed to withdraw it. This one fails
-- closed rather than open, but it is the same bug.
--
-- ── 3. The index ticker's price is never refreshed ──
--
-- rpc_snapshot_jxi ends with a block whose comment says "Keep the tradeable
-- JXI ticker's own displayed price fresh too". It is guarded by
-- `if v_co is not null then`, and JXI's owner_id is null by design -- the
-- index has no owner. So that block has never run once.
--
-- It matters because jex_mark_price() returns jex_companies.price unchanged
-- for an index row, and rpc_snapshot_nw marks a student's holdings at
-- jex_mark_price. The JXI price is updated by a JXI TRADE, so it only goes
-- stale when a CONSTITUENT moves -- which is most of the time. The graded
-- net-worth history has been valuing index units at whatever the last direct
-- JXI trade left behind, while every connected browser recomputes and shows
-- the correct number.
--
-- And while it is being fixed: that block divides the index level by a
-- hardcoded 10. The unit divisor became a session setting (jex_session.
-- index_unit_divisor) precisely so that a hardcoded copy in one function
-- could not price a unit differently from the rest -- and this is the copy
-- that was missed, along with two in rpc_admin_full_reset's JXI seed. Every
-- trading path already reads jex_index_unit_divisor(); now these do too.
--
-- ── Method ──
--
-- Every occurrence replaced is asserted to appear exactly once in its
-- function first, and each function is rebuilt through pg_get_functiondef so
-- the signature, volatility, SECURITY DEFINER and any SET clause return
-- exactly as they are. Line endings are detected per function rather than
-- assumed -- these bodies are a mix.
--
-- The replacement is `v_meta.ticker is not null` / `v_co.ticker is not null`.
-- ticker is NOT NULL on both tables, so it is non-null exactly when a row was
-- found, which is what all six of these meant.
-- ============================================================

do $mig$
declare
  r record;
  v_new text; v_n int; v_nl text; v_a text; v_b text;
  v_fixed int := 0;
begin
  -- ── 1. the restricted share class, in all four trading paths ──
  v_a := 'v_meta is not null and coalesce(v_meta.restricted,false)';
  for r in
    select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('rpc_trade_buy','rpc_place_limit_order','rpc_fund_buy','rpc_fund_short')
     order by p.proname
  loop
    if position('a row was found' in r.prosrc) > 0 then
      raise notice '  % already tests for a found row -- skipped', r.proname;
      v_fixed := v_fixed + 1;
      continue;
    end if;

    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
    if v_n <> 1 then
      raise exception 'ABORT: % restricted-class guard found % times, expected 1. Nothing changed.', r.proname, v_n;
    end if;

    v_b := 'select * into v_meta from jex_share_classes where ticker = p_ticker;';
    if (length(r.prosrc) - length(replace(r.prosrc, v_b, ''))) / length(v_b) <> 1 then
      raise exception 'ABORT: % share-class lookup found more than once. Nothing changed.', r.proname;
    end if;

    v_nl := case when position(chr(13) || chr(10) in r.prosrc) > 0
                 then chr(13) || chr(10) else chr(10) end;

    -- The note goes on its own lines after the lookup, so the test itself is a
    -- one-for-one swap and nothing about the surrounding statement moves.
    v_new := replace(r.prosrc, v_b, v_b || v_nl ||
      '    -- `record is not null` is true only when EVERY field is non-null, so' || v_nl ||
      '    -- the test below used to be false for any class row with a null' || v_nl ||
      '    -- whitelist, owner_id or created_at -- skipping the whitelist check' || v_nl ||
      '    -- entirely and leaving a restricted class open to anybody. Measured: a' || v_nl ||
      '    -- student not on the whitelist bought 25 shares of one. ticker is NOT' || v_nl ||
      '    -- NULL, so it is non-null exactly when a row was found, which is what' || v_nl ||
      '    -- this always meant.');

    v_new := replace(v_new, v_a, 'v_meta.ticker is not null and coalesce(v_meta.restricted,false)');

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  %: a restricted share class is restricted again', r.proname;
    v_fixed := v_fixed + 1;
  end loop;

  if v_fixed <> 4 then
    raise exception 'ABORT: expected 4 restricted-class guards, handled %.', v_fixed;
  end if;

  -- ── 2. the owner's own delisting ──
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_cancel_delisting';
  if r.proname is null then raise exception 'ABORT: rpc_cancel_delisting not found.'; end if;

  if position('(v_co.ticker is not null and v_co.owner_id = v_uid)' in r.prosrc) > 0 then
    raise notice '  rpc_cancel_delisting already lets the owner withdraw -- skipped';
  else
    v_a := '(v_co is not null and v_co.owner_id = v_uid)';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
    if v_n <> 1 then raise exception 'ABORT: cancel-delisting guard found % times, expected 1.', v_n; end if;
    v_new := replace(r.prosrc, v_a, '(v_co.ticker is not null and v_co.owner_id = v_uid)');
    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_cancel_delisting: the company owner can withdraw their own delisting again';
  end if;

  -- ── 3. the index ticker's price, and the hardcoded divisor ──
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_snapshot_jxi';
  if r.proname is null then raise exception 'ABORT: rpc_snapshot_jxi not found.'; end if;

  if position('if v_co.ticker is not null then' in r.prosrc) > 0 then
    raise notice '  rpc_snapshot_jxi already refreshes the index price -- skipped';
  else
    v_a := '  if v_co is not null then';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
    if v_n <> 1 then raise exception 'ABORT: snapshot_jxi guard found % times, expected 1.', v_n; end if;

    v_b := 'v_etf_price := round(v_value / 10, 2);';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_b, ''))) / length(v_b);
    if v_n <> 1 then raise exception 'ABORT: snapshot_jxi divisor found % times, expected 1.', v_n; end if;

    v_nl := case when position(chr(13) || chr(10) in r.prosrc) > 0
                 then chr(13) || chr(10) else chr(10) end;

    v_new := replace(r.prosrc, v_a,
      '  -- JXI has no owner, so `v_co is not null` -- true only when EVERY field' || v_nl ||
      '  -- of the record is non-null -- was false every single time and this' || v_nl ||
      '  -- block never ran. jex_mark_price() returns jex_companies.price straight' || v_nl ||
      '  -- back for an index row, and rpc_snapshot_nw marks holdings at' || v_nl ||
      '  -- jex_mark_price, so the graded net-worth history has been valuing index' || v_nl ||
      '  -- units at whatever the last direct JXI trade left behind. A trade in a' || v_nl ||
      '  -- CONSTITUENT moves the index without touching that price, which is most' || v_nl ||
      '  -- of the time.' || v_nl ||
      '  if v_co.ticker is not null then');

    v_new := replace(v_new, v_b,
      '-- The unit divisor is a session setting so that one hardcoded copy' || v_nl ||
      '    -- cannot price a unit differently from every trading path. This was' || v_nl ||
      '    -- that copy.' || v_nl ||
      '    v_etf_price := round(v_value / jex_index_unit_divisor(), 2);');

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_snapshot_jxi: the index price is refreshed, at the session''s unit divisor';
  end if;

  -- ── and the same hardcoded divisor in the full reset's JXI seed ──
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_admin_full_reset';
  if r.proname is null then raise exception 'ABORT: rpc_admin_full_reset not found.'; end if;

  v_a := 'coalesce(jxi_live_value(), 1000) / 10';
  v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
  if v_n = 0 then
    raise notice '  rpc_admin_full_reset already seeds JXI at the session divisor -- skipped';
  elsif v_n <> 2 then
    raise exception 'ABORT: full-reset divisor found % times, expected 2 (price and history).', v_n;
  else
    v_new := replace(r.prosrc, v_a, 'coalesce(jxi_live_value(), 1000) / jex_index_unit_divisor()');
    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_admin_full_reset: the re-seeded JXI starts at the session''s unit divisor';
  end if;
end
$mig$;

-- ── Verification ──
--
-- The first six must be true.
--
-- buy_checks_whitelist        a market buy honours a restricted class again...
-- limit_checks_whitelist      ...and so does a resting limit order...
-- fund_buy_checks_whitelist   ...and a fund buying it...
-- fund_short_checks_whitelist ...and a fund shorting it.
-- owner_can_cancel_delisting  a CEO can withdraw their own delisting.
-- index_price_refreshes       the index ticker's price is updated again, at
--                             the session's unit divisor rather than a 10.
--
-- restricted_classes_now is the one to read: every share class currently
-- marked restricted, with the number of people on its whitelist and how many
-- holders it actually has. `was_unguarded` is true where the old test would
-- have skipped the check -- i.e. the class was open to anyone for as long as
-- that was so. Anyone holding one of those who is not on the whitelist got in
-- through this.
select
  (select prosrc like '%a row was found%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_trade_buy')                   as buy_checks_whitelist,
  (select prosrc like '%a row was found%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_place_limit_order')           as limit_checks_whitelist,
  (select prosrc like '%a row was found%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_fund_buy')                    as fund_buy_checks_whitelist,
  (select prosrc like '%a row was found%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_fund_short')                  as fund_short_checks_whitelist,
  (select prosrc like '%(v_co.ticker is not null and v_co.owner_id = v_uid)%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_cancel_delisting')            as owner_can_cancel_delisting,
  (select prosrc like '%if v_co.ticker is not null then%'
      and prosrc like '%v_value / jex_index_unit_divisor()%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_snapshot_jxi')                as index_price_refreshes,
  (select index_unit_divisor from jex_session where id = 1)                   as unit_divisor_in_use,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', sc.ticker, 'company', sc.company_name,
            'whitelisted', coalesce(jsonb_array_length(sc.whitelist), 0),
            'holders', (select count(*) from jex_users u
                         where coalesce((u.holdings->>sc.ticker)::numeric,0) > 0),
            'was_unguarded', (sc.whitelist is null or sc.owner_id is null or sc.created_at is null),
            'holders_not_whitelisted', (select coalesce(jsonb_agg(u.name order by u.name), '[]'::jsonb)
                                          from jex_users u
                                         where coalesce((u.holdings->>sc.ticker)::numeric,0) > 0
                                           and not coalesce(sc.whitelist ? u.id, false)
                                           and u.role not in ('chairman','president','secretary','treasurer','compliance_officer')))
          order by sc.ticker), '[]'::jsonb)
     from jex_share_classes sc
    where coalesce(sc.restricted,false))                                      as restricted_classes_now;
