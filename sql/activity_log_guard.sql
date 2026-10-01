-- ============================================================
-- activity_log_guard.sql
--
-- Any signed-in account could write anything into the activity log, about
-- anyone, and nothing recorded who wrote it.
--
-- rpc_log_activity checked that the caller was signed in and that the type
-- was not empty. Every entry in the log comes through it -- no server function
-- writes one itself -- and it accepted, from a student (measured against
-- production's own body, fingerprint below):
--
--   a "type" of <img src=x onerror=alert(1)>      stored; the officer screens
--                                                 rendered type unescaped
--                                                 until the page fix shipped
--   "Session closed by Chairman", type session    stored
--   "Elijah withdrew $5,000 from the treasury",
--     attributed to Elijah, amount -5000          stored, as Elijah
--   a 200,000-character description               stored
--   1,000 entries in a row                        stored
--
-- and the log had no column saying whose browser wrote any of it.
--
-- ── Why not "officers only" ──
--
-- Most entries are written by whichever browser does the thing -- a student
-- buying into a fund, a company posting financials -- or notices it: a limit
-- order filling, a stop-loss, a margin call, the circuit breaker halting a
-- stock, all of which run in whichever browser happens to be open. Locking the
-- log to officers would empty it. The real cure is the server writing its own
-- entries as events happen; that is a rebuild. This closes what can be closed
-- without one:
--
--   1. WHO WROTE IT. Every entry records logged_by -- the account that wrote
--      it, taken from the login, not from the call -- and it is part of the
--      hash, so it cannot be edited out afterwards without breaking the chain.
--      The Activity tab shows it whenever it differs from who the entry is
--      about, so "Elijah withdrew $5,000" written by Kyle says so.
--
--   2. Seven types only an officer can log: session, price_adj, balance_adj,
--      class_removed, snapshot, minutes, registration. Every app path that logs
--      them is officer-gated (pinned by test).
--
--   3. A type is a plain word: lowercase letters and underscores, at most 40.
--
--   4. Lengths: description 500, ticker 20, name 100.
--
--   5. 60 entries a minute from one account; 300 for officers.
--
--   6. One entry at a time. Two entries written at the same instant both
--      read the same "previous" hash and forked the chain; a transaction lock
--      now serializes them.
--
-- And the log table's leftover grants: anon and authenticated held TRUNCATE,
-- TRIGGER and REFERENCES on jex_activity. The web API cannot reach them today,
-- and nothing needs them, so they are revoked.
--
-- ── Safety ──
--
-- Refuses to run, changing nothing, unless rpc_log_activity is byte-for-byte
-- the production version this was written and tested against. Safe to run
-- twice: the second run finds logged_by in the body and skips.
-- ============================================================

do $mig$
declare
  v_src text;
  v_fp text;
begin
  select p.prosrc, md5(replace(p.prosrc, chr(13), '')) into v_src, v_fp
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_log_activity';
  if v_src is null then
    raise exception 'ABORT: rpc_log_activity not found. Nothing changed.';
  end if;
  if position('logged_by' in v_src) > 0 then
    raise notice 'rpc_log_activity already records who wrote each entry -- skipped.';
    return;
  end if;
  if v_fp <> '7a38c217cc13a60d7ab3f4c3ff477fa8' then
    raise exception 'ABORT: rpc_log_activity is not the version this was written against (md5 %). Nothing changed -- paste this error back.', v_fp;
  end if;

  alter table public.jex_activity add column if not exists logged_by text;
  create index if not exists jex_activity_logged_by_recent on public.jex_activity (logged_by, created_at);
  revoke truncate, trigger, references on public.jex_activity from anon, authenticated;

  execute $fn$
create or replace function public.rpc_log_activity(p_type text, p_description text, p_ticker text, p_user_id text, p_user_name text, p_amount numeric)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $body$
declare
  v_uid text; v_role text; v_is_officer boolean;
  v_prev text; v_ts text; v_row jsonb;
  v_type text; v_desc text; v_ticker text; v_subject text; v_subject_name text;
  v_n int; v_limit int;
  v_officers text[] := array['chairman','president','secretary','treasurer','compliance_officer'];
  -- Logged only by officer actions; every app path that writes them is gated.
  v_officer_types text[] := array['session','price_adj','balance_adj','class_removed',
                                  'snapshot','minutes','registration'];
begin
  select id, role into v_uid, v_role from jex_users where auth_uid = auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;
  v_is_officer := coalesce(v_role = any(v_officers), false);

  -- A type is a plain word. It was any text at all, and the officer screens
  -- rendered it unescaped.
  v_type := lower(btrim(coalesce(p_type, '')));
  if v_type !~ '^[a-z_]{1,40}$' then raise exception 'Invalid activity type'; end if;
  if v_type = any(v_officer_types) and not v_is_officer then
    raise exception 'Only an officer can log % entries', v_type;
  end if;

  v_desc := left(coalesce(p_description, ''), 500);
  v_ticker := left(nullif(btrim(coalesce(p_ticker, '')), ''), 20);
  v_subject := left(nullif(btrim(coalesce(p_user_id, '')), ''), 100);
  v_subject_name := left(nullif(btrim(coalesce(p_user_name, '')), ''), 100);

  -- Counted from what this account actually wrote.
  v_limit := case when v_is_officer then 300 else 60 end;
  select count(*) into v_n from jex_activity
   where logged_by = v_uid and created_at > now() - interval '1 minute';
  if v_n >= v_limit then raise exception 'Too many activity entries -- wait a minute'; end if;

  -- One entry at a time. Two written at the same instant both read the same
  -- "previous" hash below and forked the chain.
  perform pg_advisory_xact_lock(hashtext('jex_activity_chain'));

  select coalesce(entry_hash, id) into v_prev
    from jex_activity where type <> 'snapshot'
    order by created_at desc nulls last limit 1;
  v_prev := coalesce(v_prev, 'genesis');

  v_ts := to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI:SS AM');

  insert into jex_activity (id, type, description, ticker, user_id, user_name, amount, ts,
                            prev_hash, entry_hash, logged_by, created_at)
  values (gen_random_uuid()::text, v_type, v_desc, v_ticker, v_subject, v_subject_name, p_amount,
    v_ts, v_prev,
    -- Who the entry is about (user_id, user_name, ticker) has been in the hash
    -- since activity_hash_coverage.sql. Who WROTE it is in it now too: the
    -- log records the account behind every entry, and editing that out
    -- afterwards breaks the chain like any other edit.
    substr(md5(v_prev || v_type || v_desc
               || coalesce(p_amount::text, '') || v_ts
               || coalesce(v_subject, '') || coalesce(v_subject_name, '')
               || coalesce(v_ticker, '') || v_uid), 1, 8),
    -- clock_timestamp, not now(): now() is when this CALL started, so a call
    -- that waited on the lock above would be stamped earlier than the entry
    -- that went ahead of it -- and the next entry, which finds "previous" by
    -- created_at, would chain to the wrong one. Stamped under the lock, the
    -- order of created_at is the order of the chain.
    v_uid, clock_timestamp())
  returning to_jsonb(jex_activity.*) into v_row;

  return v_row;
end;
$body$;
$fn$;

  raise notice 'rpc_log_activity: writer recorded and hashed, officer-only types, plain-word types, lengths, rate limit, serialized chain.';
end
$mig$;

-- ── verification ──
--
-- guarded              the new body is in place
-- writer_recorded      jex_activity.logged_by exists
-- leftover_grants      what anon/authenticated still hold on jex_activity.
--                      Should be empty.
-- other_tables_with_truncate
--                      public tables where anon or authenticated can still
--                      TRUNCATE. Not changed here -- listed so the size of a
--                      follow-up is known. The web API cannot issue TRUNCATE.
-- still_callable_by    authenticated must be here, or the app stops logging
select
  (select position('v_officer_types' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_log_activity')            as guarded,
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'jex_activity'
             and column_name = 'logged_by')                                   as writer_recorded,
  (select coalesce(jsonb_agg(g.grantee || ':' || g.privilege_type order by 1), '[]'::jsonb)
     from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name = 'jex_activity'
      and g.grantee in ('anon','authenticated'))                              as leftover_grants,
  (select coalesce(jsonb_agg(distinct g.table_name order by g.table_name), '[]'::jsonb)
     from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.grantee in ('anon','authenticated')
      and g.privilege_type = 'TRUNCATE')                                      as other_tables_with_truncate,
  (select coalesce(jsonb_agg(r.rolname order by r.rolname), '[]'::jsonb)
     from pg_roles r
    where r.rolname in ('anon','authenticated')
      and has_function_privilege(r.rolname,
            'public.rpc_log_activity(text,text,text,text,text,numeric)', 'execute')) as still_callable_by;
