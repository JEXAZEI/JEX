-- ============================================================
-- client_error_limits.sql
--
-- Anyone -- signed in or not -- could add error reports to the officers'
-- Errors tab as fast as they could send them.
--
-- rpc_report_client_error is callable without a login, on purpose: a crash on
-- the login page is exactly the kind of report worth having. It already cut
-- each field to a sensible length, so no single report can be huge. What it
-- did not do was limit how MANY. Measured against production's own function
-- body (fingerprint below):
--
--   5,000 reports from a signed-out caller, in one go     5,000 rows
--   one real crash, hit 300 times                          300 rows
--
-- The second is the everyday version of the problem: a bug that fires in a
-- loop buries every other report under copies of itself. (Production holds 12
-- reports today, all the same error.)
--
-- ── The fix ──
--
--   repeats   The same message from the same place, within 10 minutes of the
--             last time it was seen, is counted on the existing report
--             (repeat_count, last_seen_at) instead of stored again. The
--             Errors tab shows it as "×300, last seen ...".
--
--   limits    New reports: 30 per signed-in user per 10 minutes, 50 from
--             signed-out callers together, 200 overall. Past a limit the
--             report is dropped quietly -- the page ignores the result anyway,
--             and a failed error report must never become a second error.
--
--   size      Only the newest 2,000 reports are kept.
--
-- Legitimate use is nowhere near any of these: 12 reports in the table's
-- whole life.
--
-- ── Safety ──
--
-- Refuses to run, changing nothing, unless rpc_report_client_error is
-- byte-for-byte the production version this was written and tested against.
-- Safe to run twice: a second run finds repeat_count in the body and skips.
-- ============================================================

do $mig$
declare
  v_src text;
  v_fp text;
begin
  select p.prosrc, md5(replace(p.prosrc, chr(13), '')) into v_src, v_fp
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_report_client_error';
  if v_src is null then
    raise exception 'ABORT: rpc_report_client_error not found. Nothing changed.';
  end if;
  if position('repeat_count' in v_src) > 0 then
    raise notice 'rpc_report_client_error already limits reports -- skipped.';
    return;
  end if;
  if v_fp <> '8439f24c10d337c89a4f0c2ad0e8d788' then
    raise exception 'ABORT: rpc_report_client_error is not the version this was written against (md5 %). Nothing changed -- paste this error back.', v_fp;
  end if;

  alter table public.jex_client_errors add column if not exists repeat_count int not null default 1;
  alter table public.jex_client_errors add column if not exists last_seen_at timestamptz;
  create index if not exists jex_client_errors_created on public.jex_client_errors (created_at);

  execute $fn$
create or replace function public.rpc_report_client_error(p_message text, p_stack text default null::text, p_source text default null::text, p_url text default null::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $body$
declare
  v_uid text;
  v_name text;
  v_role text;
  v_msg text;
  v_src text;
  v_id text;
  v_n int;
  v_cap int;
begin
  select id, name, role into v_uid, v_name, v_role from jex_users where auth_uid = auth.uid();
  v_msg := left(coalesce(nullif(btrim(p_message), ''), '(no message)'), 500);
  v_src := left(coalesce(p_source, ''), 300);

  -- The same error from the same place, seen again within 10 minutes of the
  -- last time, is counted on the report already there rather than stored
  -- again. A bug that fires in a loop is one report saying x300, not 300
  -- reports burying everything else.
  select id into v_id from jex_client_errors
   where message = v_msg and source = v_src
     and coalesce(last_seen_at, created_at) > now() - interval '10 minutes'
   order by created_at desc limit 1;
  if found then
    update jex_client_errors
       set repeat_count = repeat_count + 1, last_seen_at = now()
     where id = v_id;
    return;
  end if;

  -- New reports are limited. Past a limit the report is dropped quietly: the
  -- page ignores the result anyway, and a failed report must never become a
  -- second error for the page to try to report.
  select count(*) into v_n from jex_client_errors where created_at > now() - interval '10 minutes';
  if v_n >= 200 then return; end if;
  v_cap := case when v_uid is null then 50 else 30 end;
  select count(*) into v_n from jex_client_errors
   where created_at > now() - interval '10 minutes'
     and user_id is not distinct from v_uid;
  if v_n >= v_cap then return; end if;

  insert into jex_client_errors (id, message, stack, source, url, user_id, user_name, user_role, ts,
                                 created_at, repeat_count, last_seen_at)
    values (gen_random_uuid()::text, v_msg,
            left(coalesce(p_stack, ''), 2000), v_src, left(coalesce(p_url, ''), 500),
            v_uid, v_name, v_role,
            to_char(now() at time zone 'America/Phoenix', 'HH12:MI:SS AM'),
            now(), 1, now());

  -- Only the newest 2,000 are kept.
  delete from jex_client_errors
   where id in (select id from jex_client_errors order by created_at desc offset 2000);
exception when others then
  -- Never let a logging failure itself become a second uncaught error the
  -- client would then try to report -- fail silently.
  null;
end;
$body$;
$fn$;

  raise notice 'rpc_report_client_error: repeats counted, new reports limited, newest 2,000 kept.';
end
$mig$;

-- ── verification ──
--
-- limited             the new body is in place
-- still_callable_by   anon must be here, or a crash on the login page goes
--                     unreported
-- reports_now         what the table holds; the 12 identical reports already
--                     there stay as they are (they predate repeat counting)
select
  (select position('repeat_count' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_report_client_error')     as limited,
  (select coalesce(jsonb_agg(r.rolname order by r.rolname), '[]'::jsonb)
     from pg_roles r
    where r.rolname in ('anon','authenticated')
      and has_function_privilege(r.rolname, 'public.rpc_report_client_error(text,text,text,text)', 'execute'))
                                                                              as still_callable_by,
  (select jsonb_build_object('rows', count(*),
                             'newest', max(created_at),
                             'has_repeat_count', bool_and(repeat_count >= 1))
     from jex_client_errors)                                                  as reports_now;
