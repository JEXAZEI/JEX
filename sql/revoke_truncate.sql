-- ============================================================
-- revoke_truncate.sql
--
-- Signed-out visitors (anon) and signed-in users (authenticated) could TRUNCATE
-- 38 tables -- jex_users, jex_trades, jex_companies, jex_funds, jex_session
-- among them. TRUNCATE empties a table in one statement, and row-level
-- security does not apply to it.
--
-- Nothing a student can reach today issues one: the app talks to the database
-- through Supabase's web API, which only selects, inserts, updates and deletes.
-- These grants are leftovers from the project's default setup, which hands new
-- tables ALL privileges. But they are one route-change away from mattering,
-- and nothing in the app uses them. activity_log_guard.sql removed them from
-- jex_activity; this removes them everywhere.
--
-- Removed from anon and authenticated, on every table and view in public:
--
--   TRUNCATE     empty the table, bypassing row-level security
--   TRIGGER      create triggers on it
--   REFERENCES   point foreign keys at it
--
-- NOT touched: SELECT, INSERT, UPDATE, DELETE. Those are what the app and the
-- row-level security policies actually use. The migration counts them before
-- and after and aborts, changing nothing, if that count moves at all.
--
-- Also: the project's DEFAULT privileges, so a table created later does not
-- arrive with these three again. That is set per creating role; tables made in
-- the SQL editor are created by postgres, so that is the one changed. If this
-- role may not change it, the migration says so and carries on -- the existing
-- tables are still fixed.
--
-- Safe to run twice: a second run finds nothing left to revoke.
-- ============================================================

do $mig$
declare
  v_rel record;
  v_before bigint;
  v_after bigint;
  v_tables int := 0;
begin
  -- What the app relies on, counted so it can be proved untouched.
  select count(*) into v_before
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated')
     and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');

  for v_rel in
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and (has_table_privilege('anon', c.oid, 'TRUNCATE')
         or has_table_privilege('anon', c.oid, 'TRIGGER')
         or has_table_privilege('anon', c.oid, 'REFERENCES')
         or has_table_privilege('authenticated', c.oid, 'TRUNCATE')
         or has_table_privilege('authenticated', c.oid, 'TRIGGER')
         or has_table_privilege('authenticated', c.oid, 'REFERENCES'))
     order by c.relname
  loop
    execute format('revoke truncate, trigger, references on table public.%I from anon, authenticated', v_rel.relname);
    v_tables := v_tables + 1;
  end loop;

  select count(*) into v_after
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated')
     and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  if v_after <> v_before then
    raise exception 'ABORT: the app''s own grants changed (% before, % after). Nothing changed.', v_before, v_after;
  end if;

  if v_tables = 0 then
    raise notice 'No table grants TRUNCATE, TRIGGER or REFERENCES to anon or authenticated -- nothing to revoke.';
  else
    raise notice 'Revoked TRUNCATE, TRIGGER and REFERENCES on % tables. SELECT/INSERT/UPDATE/DELETE untouched (% grants before and after).',
      v_tables, v_before;
  end if;

  -- Future tables. Its own block so a role that may not change the defaults
  -- does not undo the revokes above.
  begin
    alter default privileges for role postgres in schema public
      revoke truncate, trigger, references on tables from anon, authenticated;
    raise notice 'Tables created by postgres from now on will not grant these three either.';
  exception when others then
    raise notice 'Could not change the default privileges (%). Existing tables are fixed; a new table may need this run again.', sqlerrm;
  end;
end
$mig$;

-- ── verification ──
--
-- still_truncatable      tables anon or authenticated can still TRUNCATE.
--                        Should be empty.
-- still_trigger_or_refs  the same for TRIGGER and REFERENCES. Should be empty.
-- app_grants             what the app relies on, per role, unchanged:
--                        SELECT/INSERT/UPDATE/DELETE grant counts.
-- future_tables_default  the default privileges postgres hands anon and
--                        authenticated on new tables. Should not mention
--                        TRUNCATE (D), TRIGGER (t) or REFERENCES (x).
select
  (select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
      and (has_table_privilege('anon', c.oid, 'TRUNCATE')
        or has_table_privilege('authenticated', c.oid, 'TRUNCATE')))           as still_truncatable,
  (select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
      and (has_table_privilege('anon', c.oid, 'TRIGGER')
        or has_table_privilege('anon', c.oid, 'REFERENCES')
        or has_table_privilege('authenticated', c.oid, 'TRIGGER')
        or has_table_privilege('authenticated', c.oid, 'REFERENCES')))         as still_trigger_or_refs,
  (select coalesce(jsonb_object_agg(g.grantee, g.privs), '{}'::jsonb)
     from (select grantee, jsonb_object_agg(privilege_type, n) as privs
             from (select grantee, privilege_type, count(*) as n
                     from information_schema.role_table_grants
                    where table_schema = 'public' and grantee in ('anon','authenticated')
                    group by 1, 2) x
            group by grantee) g)                                              as app_grants,
  (select coalesce(jsonb_agg(a::text), '[]'::jsonb)
     from pg_default_acl d
     join pg_namespace n on n.oid = d.defaclnamespace
     cross join lateral unnest(d.defaclacl) a
    where n.nspname = 'public' and d.defaclobjtype = 'r'
      and d.defaclrole = 'postgres'::regrole
      and (a::text like 'anon=%' or a::text like 'authenticated=%'))         as future_tables_default;
