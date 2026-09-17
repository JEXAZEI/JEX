-- ============================================================
-- snapshot_late_joiner.sql
--
-- WRITES. Patches one function. Aborts and changes nothing on any mismatch.
-- Re-running is a no-op.
--
-- ── What is wrong ──
--
-- Restoring a snapshot creates shares out of nothing for anybody who
-- registered after it was taken.
--
-- rpc_admin_restore_snapshot walks the users IN the snapshot and rolls each
-- one back. A student who joined afterwards is not in that list, so nothing
-- touches them -- while the companies ARE rolled back, shares_avail included.
-- The shares that student bought go back into the pool AND stay in their
-- portfolio.
--
-- Measured on a copy of this database:
--
--   snapshot taken            shares_avail 1400, total held  70   (1470)
--   a new student joins and buys 100 ACME at $30.45
--                             shares_avail 1300, total held 170   (1470)
--   restore                   shares_avail 1400, total held 170   (1570)
--
-- 100 shares in two places at once. The CEO's $3,045 of sale proceeds was
-- rolled back, the student kept both the $6,955 and the stock, and they can
-- sell those shares straight back into the pool and take the $3,045 out of
-- the CEO a second time.
--
-- This is the practice-round button. A restore is meant to put the exchange
-- back the way it was, and anyone who was not there yet is the one case it
-- silently gets wrong.
--
-- ── The fix ──
--
-- A user who did not exist in the snapshot is put back to the only state that
-- is coherent for them: the starting cash of the session being restored, and
-- nothing held. Their account, login and identity are untouched -- this is the
-- position they would have been in if they had registered and done nothing,
-- which is exactly what "roll the exchange back to before you joined" means.
--
-- Every one of them is reported by name, with what they were holding at the
-- time, so the restore is never silent about it.
--
-- Companies created after the snapshot are reported too but NOT touched.
-- Their shares are real and their owner is real; delisting one on a rollback
-- would be a bigger surprise than leaving it. It is the admin's call.
--
-- Also fixed: fund_units was restored with
-- `coalesce(v_u->'fund_units', fund_units)`, which gets two of three cases
-- wrong. jsonb_build_object always writes the key, so a user whose column was
-- SQL NULL at save time comes back as the jsonb value 'null' -- which is not
-- SQL NULL, so coalesce never fires and a JSON null lands in a column the rest
-- of the code reads as an object. And a snapshot taken before fund_units was
-- recorded at all has no key, which is not the same thing as "they had none":
-- it means the snapshot has no opinion, so what the user holds now must be
-- left alone rather than wiped. All three are handled separately now.
--
-- ── And a repair ──
--
-- If rpc_admin_restore_snapshot is found assigning fund_units twice in the
-- same UPDATE, this removes the duplicate before doing anything else. Postgres
-- refuses that at execution -- `multiple assignments to same column
-- "fund_units"` -- so every restore fails outright, and the state carries this
-- migration's own marker, so it would otherwise be skipped over as
-- already-applied. It comes about by running practice_fund_restore.sql a
-- second time after something has rewritten the line its "already done" check
-- looks for. That cannot happen after this file runs -- the replacement below
-- deliberately keeps the literal text that check matches on -- but a database
-- already in that state is repaired rather than left broken.
--
-- ── Method ──
--
-- Executable anchors only, each asserted to occur EXACTLY once, rebuilt
-- through pg_get_functiondef so the signature, volatility, SECURITY DEFINER
-- and any SET clause return exactly as they are. The line ending is detected
-- at the anchor rather than assumed.
-- ============================================================

do $mig$
declare
  r record;
  v_new text; v_n int; v_nl text; v_a text;
begin
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_admin_restore_snapshot';
  if r.proname is null then raise exception 'ABORT: rpc_admin_restore_snapshot not found.'; end if;

  -- A body that assigns fund_units twice is broken, not merely untidy:
  -- Postgres rejects the UPDATE at execution with `multiple assignments to
  -- same column "fund_units"`, so every restore fails outright. It happens if
  -- practice_fund_restore.sql is run a second time after anything has
  -- rewritten the line its "already done" check looks for. Repaired here
  -- rather than aborted on, and BEFORE the already-applied check below,
  -- because the broken state carries this migration's own marker and would
  -- otherwise be skipped over.
  if (length(r.prosrc) - length(replace(r.prosrc, 'fund_units = ', '')))
     / length('fund_units = ') >
     (case when position('did not exist in the snapshot' in r.prosrc) > 0 then 2 else 1 end) then
    raise notice '  rpc_admin_restore_snapshot assigns fund_units twice -- every restore was failing. Repairing.';
    execute replace(r.def, r.prosrc,
      regexp_replace(r.prosrc,
        'fund_units = coalesce\(v_u->''fund_units'', fund_units\),\s*', '', 'g'));
    select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'rpc_admin_restore_snapshot';
    raise notice '  ...repaired.';
  end if;

  if position('did not exist in the snapshot' in r.prosrc) > 0 then
    raise notice '  rpc_admin_restore_snapshot already handles late joiners -- skipped';
    return;
  end if;

  if position('fund_units = coalesce(v_u->''fund_units'', fund_units)' in r.prosrc) = 0 then
    raise exception 'ABORT: this expects the fund-restoring version of rpc_admin_restore_snapshot (practice_fund_restore.sql). Nothing changed.';
  end if;

  v_a := '  delete from jex_limit_orders where status in (''open'',''after_hours'');';
  v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
  if v_n <> 1 then raise exception 'ABORT: limit-order cleanup anchor found % times, expected 1.', v_n; end if;

  v_nl := case when position(v_a || chr(13) || chr(10) in r.prosrc) > 0
               then chr(13) || chr(10) else chr(10) end;

  -- 1. fund_units: a JSON null is not SQL NULL, and an ABSENT key is neither.
  --
  -- Three cases, and the old line only got one of them right:
  --
  --   key absent        a snapshot taken before fund_units was recorded at
  --                     all. It has no opinion, so KEEP what the user has --
  --                     wiping it would destroy units the snapshot never knew
  --                     about.
  --   key present, null the column was SQL NULL when the snapshot was taken.
  --                     jsonb_build_object writes the key anyway, as a JSON
  --                     null, and that is not SQL NULL -- so coalesce never
  --                     fired and a JSON null landed in a column the rest of
  --                     the code reads as an object.
  --   key present, obj  use it.
  --
  -- The replacement deliberately still contains the literal text
  -- `fund_units = coalesce`, because that is what practice_fund_restore.sql
  -- looks for to decide it has already run. Without that, running that file
  -- again after this one would add a SECOND fund_units assignment to the same
  -- UPDATE, and `multiple assignments to same column "fund_units"` takes the
  -- whole restore down. Measured -- that is exactly what happened on the rig.
  v_new := replace(r.prosrc,
    'fund_units = coalesce(v_u->''fund_units'', fund_units)',
    'fund_units = coalesce(nullif(v_u->''fund_units'', ''null''::jsonb),' || v_nl ||
    '        case when v_u ? ''fund_units'' then ''{}''::jsonb else fund_units end)');

  -- 2. the late joiners, reset and reported.
  v_new := replace(v_new, v_a,
    '-- Anyone who did not exist in the snapshot is rolled back too, or the' || v_nl ||
    '  -- rollback mints shares. Users IN the snapshot are restored above; a' || v_nl ||
    '  -- student who joined afterwards is untouched by that loop, while the' || v_nl ||
    '  -- COMPANIES are rolled back around them -- shares_avail included. The' || v_nl ||
    '  -- shares they bought go back in the pool and stay in their portfolio at' || v_nl ||
    '  -- the same time. Measured: 100 shares in two places, and the $3,045 the' || v_nl ||
    '  -- CEO paid for them refunded to the CEO and still in the student''s hands.' || v_nl ||
    '  --' || v_nl ||
    '  -- They go back to the only state that is coherent for them: the starting' || v_nl ||
    '  -- cash of the session being restored, holding nothing. Account, login and' || v_nl ||
    '  -- identity untouched -- this is where they would have been had they' || v_nl ||
    '  -- registered and done nothing, which is what rolling back past their' || v_nl ||
    '  -- arrival means.' || v_nl ||
    '  select coalesce(jsonb_agg(jsonb_build_object(' || v_nl ||
    '           ''id'', u.id, ''name'', u.name, ''role'', u.role,' || v_nl ||
    '           ''cash_before'', u.cash, ''holdings_before'', u.holdings,' || v_nl ||
    '           ''shorts_before'', u.shorts, ''fund_units_before'', u.fund_units)' || v_nl ||
    '         order by u.name), ''[]''::jsonb)' || v_nl ||
    '    into v_late_users' || v_nl ||
    '    from jex_users u' || v_nl ||
    '   where not exists (' || v_nl ||
    '     select 1 from jsonb_array_elements(coalesce(v_data->''users'',''[]''::jsonb)) s' || v_nl ||
    '      where s->>''id'' = u.id);' || v_nl || v_nl ||
    '  update jex_users u set' || v_nl ||
    '      cash = coalesce((v_data->''session''->>''starting_cash'')::numeric, u.cash),' || v_nl ||
    '      holdings = ''{}''::jsonb, shorts = ''{}''::jsonb, fund_units = ''{}''::jsonb' || v_nl ||
    '   where exists (select 1 from jsonb_array_elements(v_late_users) l where l->>''id'' = u.id);' || v_nl || v_nl ||
    '  -- Companies created after the snapshot are REPORTED, not touched. Their' || v_nl ||
    '  -- shares and their owner are real, and delisting one on a rollback would' || v_nl ||
    '  -- be a bigger surprise than leaving it standing. The admin decides.' || v_nl ||
    '  select coalesce(jsonb_agg(jsonb_build_object(' || v_nl ||
    '           ''ticker'', c.ticker, ''name'', c.name, ''price'', c.price,' || v_nl ||
    '           ''shares'', c.shares, ''shares_avail'', c.shares_avail, ''status'', c.status)' || v_nl ||
    '         order by c.ticker), ''[]''::jsonb)' || v_nl ||
    '    into v_late_companies' || v_nl ||
    '    from jex_companies c' || v_nl ||
    '   where not exists (' || v_nl ||
    '     select 1 from jsonb_array_elements(coalesce(v_data->''companies'',''[]''::jsonb)) s' || v_nl ||
    '      where s->>''ticker'' = c.ticker);' || v_nl || v_nl ||
    v_a);

  -- 3. the two new variables, and 4. report them back.
  v_a := '  v_f jsonb; v_restored_funds int := 0;';
  v_n := (length(v_new) - length(replace(v_new, v_a, ''))) / length(v_a);
  if v_n <> 1 then raise exception 'ABORT: declare anchor found % times, expected 1.', v_n; end if;
  v_new := replace(v_new, v_a,
    v_a || v_nl || '  v_late_users jsonb := ''[]''::jsonb; v_late_companies jsonb := ''[]''::jsonb;');

  v_a := '  return jsonb_build_object(''restored_users'', v_restored_users, ''restored_companies'', v_restored_companies, ''restored_funds'', v_restored_funds, ''label'', v_snap.label);';
  v_n := (length(v_new) - length(replace(v_new, v_a, ''))) / length(v_a);
  if v_n <> 1 then raise exception 'ABORT: return anchor found % times, expected 1.', v_n; end if;
  v_new := replace(v_new, v_a,
    '  return jsonb_build_object(''restored_users'', v_restored_users, ''restored_companies'', v_restored_companies, ''restored_funds'', v_restored_funds, ''label'', v_snap.label,' || v_nl ||
    '    ''reset_users'', v_late_users, ''unknown_companies'', v_late_companies);');

  execute replace(r.def, r.prosrc, v_new);
  raise notice '  rpc_admin_restore_snapshot: a restore no longer mints shares for anyone who joined after the snapshot';
end
$mig$;

-- ── Verification ──
--
-- The first three must be true.
--
-- resets_late_joiners   a user absent from the snapshot is rolled back too,
--                       instead of keeping shares the pool just got back.
-- reports_them          ...and the restore says exactly who, and what they
--                       were holding when it happened.
-- fund_units_three_cases  an absent key keeps what the user has, a JSON null
--                       becomes an empty object, and an object is used as-is.
-- no_duplicate_assignment  fund_units is assigned exactly twice in the whole
--                       function -- once in the restore loop and once in the
--                       late-joiner reset. Three means an UPDATE assigns it
--                       twice, which Postgres refuses at execution and which
--                       takes every restore down; this migration repairs that
--                       if it finds it.
--
-- snapshots_with_late_joiners is the one to read: for every snapshot you could
-- restore today, how many current users were not in it. Restoring one of those
-- BEFORE this migration is what mints the shares; after it, those users are
-- reset and named. A snapshot with 0 is safe either way.
select
  (select prosrc like '%did not exist in the snapshot%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_restore_snapshot')      as resets_late_joiners,
  (select prosrc like '%''reset_users'', v_late_users%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_restore_snapshot')      as reports_them,
  (select prosrc like '%nullif(v_u->''fund_units'', ''null''::jsonb)%'
      and prosrc like '%case when v_u ? ''fund_units'' then ''{}''::jsonb else fund_units end%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_restore_snapshot')      as fund_units_three_cases,
  (select (length(prosrc) - length(replace(prosrc, 'fund_units = ', ''))) / length('fund_units = ') = 2
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_restore_snapshot')      as no_duplicate_assignment,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'label', x.label, 'taken', x.ts, 'users_not_in_it', x.n,
            'they_hold_now', x.worth)
          order by x.label), '[]'::jsonb)
     from (
       select s.label, s.ts,
              count(*) as n,
              round(sum(coalesce((
                select sum(c.price * (u.holdings->>c.ticker)::numeric)
                  from jex_companies c
                 where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0)), 2) as worth
         from jex_snapshots s
         join jex_users u
           on not exists (select 1 from jsonb_array_elements(coalesce(s.data->'users','[]'::jsonb)) e
                           where e->>'id' = u.id)
        group by s.label, s.ts
     ) x)                                                                    as snapshots_with_late_joiners;
