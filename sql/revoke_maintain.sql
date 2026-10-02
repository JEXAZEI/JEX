-- ============================================================
-- revoke_maintain.sql
--
-- revoke_truncate.sql removed TRUNCATE, TRIGGER and REFERENCES from signed-out
-- visitors (anon) and signed-in users (authenticated). Its verification showed
-- that new tables still default to one more: MAINTAIN.
--
-- MAINTAIN arrived in Postgres 17, and "grant all" -- which is what the
-- project's defaults do -- includes it, so the existing tables almost
-- certainly grant it too. It covers housekeeping commands:
--
--   LOCK TABLE                 including ACCESS EXCLUSIVE, which stops every
--                              read and write on the table until released
--   VACUUM, ANALYZE, REINDEX,
--   CLUSTER, REFRESH MATERIALIZED VIEW
--
-- Measured on Postgres 17.10 with production's grants (anon and authenticated
-- hold SELECT, plus MAINTAIN): a signed-out caller could take ACCESS EXCLUSIVE
-- on jex_trades and a student on jex_users, and REINDEX either. With SELECT
-- alone, MAINTAIN is the only thing that allowed it; after this, all refused,
-- every read unchanged.
--
-- Same reasoning as TRUNCATE: the web API cannot issue any of these and the app
-- never uses them, so they are one route-change away from mattering and
-- nothing is lost by removing them.
--
-- Removed from anon and authenticated on every table and view in public, and
-- from postgres's defaults so new tables do not grant it. SELECT, INSERT,
-- UPDATE and DELETE are counted before and after; the migration aborts,
-- changing nothing, if that count moves.
--
-- Postgres 17 or later only. On an older server MAINTAIN does not exist, and
-- this says so and changes nothing. Safe to run twice.
-- ============================================================

do $mig$
declare
  v_rel record;
  v_before bigint;
  v_after bigint;
  v_tables int := 0;
begin
  if current_setting('server_version_num')::int < 170000 then
    raise notice 'This server is Postgres %, which has no MAINTAIN privilege -- nothing to do.', current_setting('server_version');
    return;
  end if;

  select count(*) into v_before
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated')
     and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');

  for v_rel in
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and (has_table_privilege('anon', c.oid, 'MAINTAIN')
         or has_table_privilege('authenticated', c.oid, 'MAINTAIN'))
     order by c.relname
  loop
    -- Built as text so the file still parses on a server that predates
    -- MAINTAIN; the version check above keeps it from running there.
    execute format('revoke maintain on table public.%I from anon, authenticated', v_rel.relname);
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
    raise notice 'No table grants MAINTAIN to anon or authenticated -- nothing to revoke.';
  else
    raise notice 'Revoked MAINTAIN on % tables. SELECT/INSERT/UPDATE/DELETE untouched (% grants before and after).',
      v_tables, v_before;
  end if;

  begin
    execute 'alter default privileges for role postgres in schema public revoke maintain on tables from anon, authenticated';
    raise notice 'Tables created by postgres from now on will not grant MAINTAIN either.';
  exception when others then
    raise notice 'Could not change the default privileges (%). Existing tables are fixed; a new table may need this run again.', sqlerrm;
  end;
end
$mig$;

-- ── verification ──
--
-- server_version         MAINTAIN exists from 17
-- still_maintainable     tables anon or authenticated can still LOCK, VACUUM,
--                        REINDEX... Should be empty.
-- still_truncatable      revoke_truncate.sql's result, re-checked. Should be
--                        empty.
-- app_grants             what the app relies on, unchanged: anon and
--                        authenticated SELECT on 31 relations.
-- future_tables_default  what postgres hands anon and authenticated on new
--                        tables. Should be r (SELECT) only -- no m.
select
  current_setting('server_version')                                             as server_version,
  (select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
      and current_setting('server_version_num')::int >= 170000
      and (has_table_privilege('anon', c.oid, 'MAINTAIN')
        or has_table_privilege('authenticated', c.oid, 'MAINTAIN')))            as still_maintainable,
  (select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
      and (has_table_privilege('anon', c.oid, 'TRUNCATE')
        or has_table_privilege('authenticated', c.oid, 'TRUNCATE')))            as still_truncatable,
  (select coalesce(jsonb_object_agg(g.grantee, g.privs), '{}'::jsonb)
     from (select grantee, jsonb_object_agg(privilege_type, n) as privs
             from (select grantee, privilege_type, count(*) as n
                     from information_schema.role_table_grants
                    where table_schema = 'public' and grantee in ('anon','authenticated')
                    group by 1, 2) x
            group by grantee) g)                                               as app_grants,
  (select coalesce(jsonb_agg(a::text), '[]'::jsonb)
     from pg_default_acl d
     join pg_namespace n on n.oid = d.defaclnamespace
     cross join lateral unnest(d.defaclacl) a
    where n.nspname = 'public' and d.defaclobjtype = 'r'
      and d.defaclrole = 'postgres'::regrole
      and (a::text like 'anon=%' or a::text like 'authenticated=%'))          as future_tables_default;
