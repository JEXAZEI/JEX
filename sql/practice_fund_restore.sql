-- ============================================================
-- practice_fund_restore.sql
--
-- WRITES. Replaces rpc_admin_save_snapshot and rpc_admin_restore_snapshot.
-- Aborts and changes nothing on any mismatch. Re-running is a no-op.
--
-- ── What is wrong ──
--
-- Practice mode's whole promise is that it can be undone. It cannot, for funds.
--
-- rpc_admin_save_snapshot records each user as
--
--     id, name, role, cash, holdings, shorts
--
-- and each fund as
--
--     id, cash, holdings, shorts
--
-- Neither jex_users.fund_units nor jex_funds.units_outstanding is captured, and
-- rpc_admin_restore_snapshot does not write them either. So a deposit made
-- during practice is only half reversed:
--
--     deposit $1,000  ->  cash -1000, units +N, fund cash +1000,
--                         units_outstanding +N
--     restore         ->  cash back to 1000, fund cash back
--                         units STILL +N, units_outstanding STILL +N
--
-- The student keeps units they no longer paid for, and can withdraw them
-- afterwards for real money. Withdrawal is priced off NAV and the fund's cash
-- was restored, so the units are backed by other people's money. A withdrawal
-- also pays the manager a performance fee on the "gain".
--
-- It runs the other way too: a student who WITHDREW during practice has the
-- cash taken back on restore while their units stay gone. That one destroys
-- their money rather than creating it, which is worse for the student and
-- exactly as wrong.
--
-- Funds hold the largest balances on the exchange. The existing comment in the
-- restore function says as much -- it was added when fund cash/holdings/shorts
-- were first restored -- but units were missed, and units are the half that
-- says who owns the fund.
--
-- ── The fix ──
--
-- Capture both, restore both. Everything else is untouched.
--
-- Snapshots taken BEFORE this runs do not carry the new keys, so restoring one
-- leaves units exactly as they are now -- the same behaviour as today, not
-- worse. That is deliberate: coalesce falls back to the current value rather
-- than to zero, because zeroing everyone's units from an old snapshot would be
-- a far bigger accident than the bug being fixed. Take a fresh snapshot after
-- running this and the next practice session is fully reversible.
--
-- ── Method ──
--
-- Both functions are rebuilt through pg_get_functiondef, which is Postgres
-- printing its own definition: signature, volatility, SECURITY DEFINER and any
-- SET clause come back exactly as they are. That is the approach that would
-- have prevented the search_path bug I shipped, and it is what I use now.
-- Every anchor is asserted to occur EXACTLY once before anything is replaced.
-- ============================================================

do $mig$
declare
  r record;
  v_new text;
  v_n int;
  v_done int := 0;

  a_save_users text := '''users'', (select coalesce(jsonb_agg(jsonb_build_object(''id'', id, ''name'', name, ''role'', role, ''cash'', cash, ''holdings'', holdings, ''shorts'', shorts)), ''[]''::jsonb) from jex_users),';
  a_save_funds text := '''funds'', (select coalesce(jsonb_agg(jsonb_build_object(''id'', id, ''cash'', cash, ''holdings'', holdings, ''shorts'', shorts)), ''[]''::jsonb) from jex_funds)';
  a_rest_users text := 'shorts = coalesce(v_u->''shorts'', ''{}''::jsonb)';
  a_rest_funds text := 'shorts = coalesce(v_f->''shorts'', ''{}''::jsonb)';
begin
  -- ---------- the snapshot ----------
  select p.oid, p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_admin_save_snapshot';
  if r.proname is null then raise exception 'ABORT: rpc_admin_save_snapshot not found.'; end if;

  if position('''fund_units'', fund_units' in r.prosrc) > 0 then
    raise notice '  rpc_admin_save_snapshot already records fund units -- skipped';
    v_done := v_done + 1;
  else
    v_new := r.prosrc;

    v_n := (length(v_new) - length(replace(v_new, a_save_users, ''))) / length(a_save_users);
    if v_n <> 1 then raise exception 'ABORT: save/users anchor found % times, expected 1.', v_n; end if;
    v_new := replace(v_new, a_save_users,
      '''users'', (select coalesce(jsonb_agg(jsonb_build_object(''id'', id, ''name'', name, ''role'', role, ''cash'', cash, ''holdings'', holdings, ''shorts'', shorts, ''fund_units'', fund_units)), ''[]''::jsonb) from jex_users),');

    v_n := (length(v_new) - length(replace(v_new, a_save_funds, ''))) / length(a_save_funds);
    if v_n <> 1 then raise exception 'ABORT: save/funds anchor found % times, expected 1.', v_n; end if;
    v_new := replace(v_new, a_save_funds,
      '''funds'', (select coalesce(jsonb_agg(jsonb_build_object(''id'', id, ''cash'', cash, ''holdings'', holdings, ''shorts'', shorts, ''units_outstanding'', units_outstanding)), ''[]''::jsonb) from jex_funds)');

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_admin_save_snapshot now records fund units';
    v_done := v_done + 1;
  end if;

  -- ---------- the restore ----------
  select p.oid, p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_admin_restore_snapshot';
  if r.proname is null then raise exception 'ABORT: rpc_admin_restore_snapshot not found.'; end if;

  if position('fund_units = coalesce' in r.prosrc) > 0 then
    raise notice '  rpc_admin_restore_snapshot already restores fund units -- skipped';
    v_done := v_done + 1;
  else
    v_new := r.prosrc;

    v_n := (length(v_new) - length(replace(v_new, a_rest_users, ''))) / length(a_rest_users);
    if v_n <> 1 then raise exception 'ABORT: restore/users anchor found % times, expected 1.', v_n; end if;
    -- coalesce back to the CURRENT value, not to an empty object: a snapshot
    -- taken before this migration has no fund_units key, and zeroing every
    -- student's fund holding from an old snapshot would be a much larger
    -- accident than the bug being fixed.
    v_new := replace(v_new, a_rest_users,
      a_rest_users || ',' || chr(13) || chr(10) ||
      '      fund_units = coalesce(v_u->''fund_units'', fund_units)');

    v_n := (length(v_new) - length(replace(v_new, a_rest_funds, ''))) / length(a_rest_funds);
    if v_n <> 1 then raise exception 'ABORT: restore/funds anchor found % times, expected 1.', v_n; end if;
    v_new := replace(v_new, a_rest_funds,
      a_rest_funds || ',' || chr(13) || chr(10) ||
      '      units_outstanding = coalesce((v_f->>''units_outstanding'')::numeric, units_outstanding)');

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_admin_restore_snapshot now restores fund units';
    v_done := v_done + 1;
  end if;

  if v_done <> 2 then
    raise exception 'ABORT: expected 2 functions, handled %.', v_done;
  end if;
end
$mig$;

-- ── Verification ──
--
-- The first four must be true. The last two confirm nothing else moved.
--
-- snapshot_records_units   users' fund_units is captured.
-- snapshot_records_outstanding  funds' units_outstanding is captured.
-- restore_writes_units     and the restore writes it back.
-- restore_writes_outstanding    likewise for the fund side.
-- old_snapshots_safe       the restore falls back to the CURRENT value, so a
--                          snapshot taken before today cannot zero anyone out.
-- both_secdef              unchanged.
select
  (select prosrc like '%''fund_units'', fund_units%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_save_snapshot')        as snapshot_records_units,
  (select prosrc like '%''units_outstanding'', units_outstanding%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_save_snapshot')        as snapshot_records_outstanding,
  (select prosrc like '%fund_units = coalesce(v_u->''fund_units'', fund_units)%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_restore_snapshot')     as restore_writes_units,
  (select prosrc like '%units_outstanding = coalesce((v_f->>''units_outstanding'')::numeric, units_outstanding)%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_restore_snapshot')     as restore_writes_outstanding,
  (select prosrc not like '%fund_units = coalesce(v_u->''fund_units'', ''{}''%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_restore_snapshot')     as old_snapshots_safe,
  (select bool_and(prosecdef) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname in ('rpc_admin_save_snapshot','rpc_admin_restore_snapshot')) as both_secdef,
  -- How much is actually at stake right now.
  (select coalesce(jsonb_agg(jsonb_build_object('fund', f.name,
            'units_outstanding', f.units_outstanding, 'cash', f.cash) order by f.name), '[]'::jsonb)
     from jex_funds f)                                                       as funds_now,
  (select count(*) from jex_users u
    where coalesce(u.fund_units, '{}'::jsonb) <> '{}'::jsonb)                as students_holding_units;
