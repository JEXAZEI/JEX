-- ============================================================
-- server_timer.sql
--
-- JEX had no clock of its own. Everything that happens because time passed
-- -- a scheduled or weekly open, a scheduled close, a "Session -- 45min"
-- timer running out, a circuit-breaker halt lifting after 5 minutes -- ran
-- only when a signed-in browser checked in. With every tab closed or asleep,
-- a scheduled open simply did not happen, and a halted stock stayed halted.
--
-- Now pg_cron, Postgres's own scheduler, runs two jobs every 15 seconds:
--
--   jex-session-schedule   opens and closes trading on the schedule, ends a
--                          timed session, and does what goes with it (after-
--                          hours orders go live at an open, day orders expire
--                          at a close, owners are told) -- the same function
--                          a browser runs, minus the sign-in check.
--   jex-circuit-breakers   lifts circuit-breaker halts that are 5 minutes
--                          old, with the same 20-minute cooldown.
--
-- plus one daily job, jex-cron-cleanup, that keeps pg_cron's run history to
-- three days (two 15-second jobs add 11,500 rows a day).
--
-- Browsers keep checking in as before. That is harmless: the session row and
-- each halt are locked while they change, so every change happens once.
--
-- Also fixed: two browsers auto-resuming the same halt at the same moment
-- both logged it and both notified every student. Measured on a copy of
-- production: 2 log entries and 8 notices for one resume. The halt is now
-- locked while it is lifted; the second caller finds it gone.
--
-- Not moved: stop-losses, margin calls, limit fills and price alerts. Those
-- respond to a price moving, and a price only moves when someone trades or
-- an officer acts -- from a browser that is checking in.
--
-- Needs the pg_cron extension. This enables it if it can; if your project
-- does not allow that, it stops and says how to enable it in the dashboard.
--
-- Refuses to run, changing nothing, unless both edited functions are the
-- production versions this was tested against. Safe to run twice.
--
-- To turn the timer off (browsers carry on exactly as before):
--   select cron.unschedule('jex-session-schedule');
--   select cron.unschedule('jex-circuit-breakers');
-- ============================================================

do $mig$
declare
  v_src text; v_def text; v_fp text; v_nl text; v_n int; v_a text;
  v_core text; v_every text := '15 seconds';
  v_auth text := '  select id into v_uid from jex_users where auth_uid = auth.uid();{nl}'
              || '  if v_uid is null then raise exception ''Not authenticated''; end if;{nl}';
  v_halt text := '  select * into v_halt from jex_halts where ticker = p_ticker;';
  v_tick_done boolean; v_resume_done boolean;
begin
  -- ── check: both functions are done or exactly as expected ──
  select p.prosrc, pg_get_functiondef(p.oid), md5(replace(p.prosrc, chr(13), ''))
    into v_src, v_def, v_fp
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_session_tick';
  if v_src is null then raise exception 'ABORT: rpc_session_tick not found. Nothing changed.'; end if;
  v_tick_done := position('jex_session_tick_core' in v_src) > 0;
  if not v_tick_done then
    if position('jex_ev_session_tick' in v_src) = 0 then
      raise exception 'ABORT: run server_events_batch4.sql first. Nothing changed.';
    end if;
    if v_fp <> '7dc13c328a85fe47644c2471e34a5843' then
      raise exception 'ABORT: rpc_session_tick is not the version this was written against (md5 %). Nothing changed -- paste this error back.', v_fp;
    end if;
    v_nl := case when position(chr(13) in v_src) > 0 then chr(13) || chr(10) else chr(10) end;
    v_a := replace(v_auth, '{nl}', v_nl);
    v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_n <> 1 then raise exception 'ABORT: expected the sign-in check exactly once in rpc_session_tick, found %. Nothing changed.', v_n; end if;
  elsif not exists (select 1 from pg_proc where proname = 'jex_session_tick_core') then
    raise exception 'ABORT: rpc_session_tick calls jex_session_tick_core, which does not exist. Nothing changed -- paste this error back.';
  end if;

  select p.prosrc, md5(replace(p.prosrc, chr(13), '')) into v_core, v_fp
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_admin_resume_stock';
  if v_core is null then raise exception 'ABORT: rpc_admin_resume_stock not found. Nothing changed.'; end if;
  v_resume_done := position('where ticker = p_ticker for update;' in v_core) > 0;
  if not v_resume_done then
    if v_fp <> '03197e9479ffb49d11fbb4399b2b510c' then
      raise exception 'ABORT: rpc_admin_resume_stock is not the version this was written against (md5 %). Nothing changed -- paste this error back.', v_fp;
    end if;
    v_n := (length(v_core) - length(replace(v_core, v_halt, ''))) / length(v_halt);
    if v_n <> 1 then raise exception 'ABORT: expected the halt lookup exactly once in rpc_admin_resume_stock, found %. Nothing changed.', v_n; end if;
  end if;

  -- ── pg_cron ──
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension pg_cron;
    exception when others then
      raise exception 'ABORT: pg_cron is not enabled, and could not be enabled from here (%). In Supabase: Database > Extensions, search "pg_cron", enable it, then run this file again. Nothing changed.', sqlerrm;
    end;
  end if;

  -- ── 1. the schedule, without the sign-in check ──
  -- jex_session_tick_core is rpc_session_tick's body exactly, minus its first
  -- two lines; rpc_session_tick keeps those two lines and calls it.
  if not v_tick_done then
    v_a := replace(v_def, v_src, replace(v_src, replace(v_auth, '{nl}', v_nl), ''));
    v_n := (length(v_a) - length(replace(v_a, 'FUNCTION public.rpc_session_tick()', ''))) / length('FUNCTION public.rpc_session_tick()');
    if v_n <> 1 then raise exception 'ABORT: could not name the copy of rpc_session_tick (found its name % times). Nothing changed.', v_n; end if;
    execute replace(v_a, 'FUNCTION public.rpc_session_tick()', 'FUNCTION public.jex_session_tick_core()');
    execute replace(v_def, v_src,
         v_nl || 'declare' || v_nl
      || '  v_uid text;' || v_nl
      || 'begin' || v_nl
      || replace(v_auth, '{nl}', v_nl) || v_nl
      || '  -- What the schedule decides is in jex_session_tick_core(), which pg_cron' || v_nl
      || '  -- also runs every 15 seconds (server_timer.sql), so scheduled opens and' || v_nl
      || '  -- closes happen with no browser open. A tab calling this too is harmless:' || v_nl
      || '  -- the session row is locked while it changes, so each change happens once.' || v_nl
      || '  return jex_session_tick_core();' || v_nl
      || 'end;' || v_nl);
  end if;

  -- ── 2. one resume per halt ──
  if not v_resume_done then
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'rpc_admin_resume_stock';
    v_nl := case when position(chr(13) in v_core) > 0 then chr(13) || chr(10) else chr(10) end;
    execute replace(v_def, v_core, replace(v_core, v_halt,
         '  -- Locked: two callers lifting the same halt each logged it and notified' || v_nl
      || '  -- every student. The second now waits, then finds it gone.' || v_nl
      || '  select * into v_halt from jex_halts where ticker = p_ticker for update;'));
  end if;

  -- ── 3. circuit breakers, lifted on time ──
  execute $fn$
create or replace function public.jex_resume_expired_breakers()
 returns integer language plpgsql security definer set search_path to 'public'
as $body$
declare v_ticker text; v_n int := 0;
begin
  -- What rpc_admin_resume_stock(ticker, true) does for one halt -- lift a
  -- circuit-breaker halt 5 minutes old, and give the ticker 20 minutes before
  -- the breaker can trip again -- for every such halt, with nobody signed in.
  -- A halt a browser is lifting right now is skipped; the browser has it.
  for v_ticker in
    select ticker from jex_halts
     where halted_by = 'System (Circuit Breaker)' and created_at <= now() - interval '5 minutes'
     order by ticker
       for update skip locked
  loop
    delete from jex_halts where ticker = v_ticker;
    update jex_session set circuit_cooldowns = jsonb_set(
      coalesce(circuit_cooldowns, '{}'::jsonb), array[v_ticker],
      to_jsonb(((extract(epoch from now()) * 1000)::bigint) + 20*60*1000)
    ) where id = 1;
    perform jex_ev_resume(v_ticker, null, true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$body$;
$fn$;

  execute 'revoke execute on function public.jex_session_tick_core(), public.jex_resume_expired_breakers()
             from public, anon, authenticated';

  -- ── 4. the jobs ──
  -- Scheduling by name replaces a job of the same name, so a second run
  -- leaves two jobs, not four. pg_cron before 1.5 cannot do seconds: then
  -- every minute.
  begin
    perform cron.schedule('jex-session-schedule', v_every, 'select public.jex_session_tick_core()');
  exception when others then
    v_every := '* * * * *';
    perform cron.schedule('jex-session-schedule', v_every, 'select public.jex_session_tick_core()');
  end;
  perform cron.schedule('jex-circuit-breakers', v_every, 'select public.jex_resume_expired_breakers()');
  perform cron.schedule('jex-cron-cleanup', '17 10 * * *',
    $job$delete from cron.job_run_details where end_time < now() - interval '3 days'$job$);

  raise notice 'Server timer on: every %.', case v_every when '15 seconds' then '15 seconds' else 'minute' end;
end
$mig$;

-- ── verification ──
-- jobs                      the three jobs, active, with their schedules
-- schedule_runs_on_server   true: rpc_session_tick hands the work to the
--                           function pg_cron runs
-- one_resume_per_halt       true: the halt is locked while it is lifted
-- callable_from_the_web     should be false: only pg_cron runs the two
--                           timer functions
select
  (select jsonb_object_agg(jobname, schedule || case when active then '' else ' (OFF)' end)
     from cron.job where jobname like 'jex-%')                                         as jobs,
  (select position('jex_session_tick_core' in prosrc) > 0
     from pg_proc where proname = 'rpc_session_tick')                                  as schedule_runs_on_server,
  (select position('where ticker = p_ticker for update;' in prosrc) > 0
     from pg_proc where proname = 'rpc_admin_resume_stock')                            as one_resume_per_halt,
  (select bool_or(has_function_privilege(r, p.oid, 'execute'))
     from pg_proc p, unnest(array['anon', 'authenticated']) r
    where p.proname in ('jex_session_tick_core', 'jex_resume_expired_breakers'))       as callable_from_the_web;
