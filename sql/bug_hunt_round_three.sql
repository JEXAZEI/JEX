-- ============================================================
-- bug_hunt_round_three.sql
--
-- Five small server changes left over from the second bug hunt. app.js is
-- updated in the same commit and works with or without this file: until it
-- runs, each screen keeps its old behaviour.
--
-- ── 1. "Capital raised" only counted the last 200 trades ──
--
-- The company page and the officers' overview summed jex_trades from the
-- browser's copy, which is the newest 200 prints exchange-wide. A company
-- with more history than that showed less than it had raised, and the figure
-- fell as other companies traded. New: rpc_capital_raised() sums the whole
-- table. Read-only, runs as the caller, so it sees exactly what the browser
-- could already read.
--
-- ── 2. "vs Start" used the session setting for everyone ──
--
-- The approval form lets an officer type a different starting amount per
-- student, and every "vs Start" figure (leaderboard colour, Balances table
-- and its graded CSV, PDF report, Portfolio page) measured against the
-- session setting regardless. New: jex_users.starting_cash, filled on insert
-- from the opening cash by a trigger, so approve_registration is not touched.
-- Existing accounts are backfilled from their 'registration' activity entry,
-- which records the amount they were approved with; an account with no such
-- entry stays empty and the app keeps using the session setting for it.
--
-- ── 3. Officers could not remove a company's news or votes ──
--
-- rpc_delete_news, rpc_close_vote and rpc_delete_vote allow the company's
-- owner and founders only, so an officer had no way to take down an
-- inappropriate post. Three new officer-only functions do that; the three
-- existing ones are unchanged.
--
-- ── 4. Three functions with no fixed search_path ──
--
-- rpc_get_company_team_contacts, rpc_get_leadership_contacts and
-- rpc_pay_dividend run as their owner without a fixed search_path (see the
-- README on why that matters). Set to public, nothing else changed.
--
-- ── 5. rpc_cast_vote read deadlines differently from the sweep ──
--
-- vote_deadline_enforced.sql made the rule "closes_at when it is an ISO
-- timestamp, else created_at + 24 hours", and the sweep matches exactly that.
-- rpc_cast_vote instead tried any cast, so a legacy closes_at Postgres can
-- parse but the sweep cannot ("2026-10-20 15:00") was a different deadline in
-- each. Now both use the ISO test, and so does app.js.
--
-- Safe to run twice. Part 5 aborts and changes nothing if its anchor is not
-- found exactly once.
-- ============================================================

do $mig$
declare
  r record;
  v_nl text;
  v_n int;
  v_old text := 'v_deadline := v_vote.closes_at::timestamptz;';
  v_fn text;
begin
  -- ── 1. capital raised ──
  execute $fn$
create or replace function public.rpc_capital_raised()
 returns jsonb
 language sql
 stable
 security invoker
 set search_path to 'public'
as $body$
  -- max_id: the newest trade counted, so the browser adds only prints that
  -- arrived after this answer instead of counting any of them twice.
  select jsonb_build_object(
    'max_id', (select max(id) from jex_trades),
    'by_ticker', coalesce((
      select jsonb_object_agg(ticker, raised)
        from (select ticker, sum(round(price * qty, 2)) as raised
                from jex_trades
               where seller_id = 'exchange'
               group by ticker) s), '{}'::jsonb));
$body$;
$fn$;
  execute 'revoke execute on function public.rpc_capital_raised() from public';
  execute 'grant execute on function public.rpc_capital_raised() to anon, authenticated';

  -- ── 2. starting cash per account ──
  alter table public.jex_users add column if not exists starting_cash numeric;
  execute $fn$
create or replace function public.jex_users_record_starting_cash()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $body$
begin
  if new.starting_cash is null then new.starting_cash := new.cash; end if;
  return new;
end;
$body$;
$fn$;
  execute 'revoke execute on function public.jex_users_record_starting_cash() from public, anon, authenticated';
  drop trigger if exists jex_users_starting_cash on public.jex_users;
  create trigger jex_users_starting_cash before insert on public.jex_users
    for each row execute function public.jex_users_record_starting_cash();
  update public.jex_users u
     set starting_cash = a.amount
    from (select distinct on (user_id) user_id, amount
            from public.jex_activity
           where type = 'registration' and amount is not null and user_id is not null
           order by user_id, created_at desc) a
   where u.id = a.user_id and u.starting_cash is null;
  -- jex_users is read column by column (JEX_USERS_SAFE_SELECT); a column
  -- added later is not covered by a column-level grant.
  execute 'grant select (id, starting_cash) on public.jex_users to anon, authenticated';

  -- ── 3. officer moderation ──
  execute $fn$
create or replace function public.rpc_admin_delete_news(p_news_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $body$
declare v_role text;
begin
  select role into v_role from jex_users where auth_uid = auth.uid();
  if v_role is null then raise exception 'Not authenticated'; end if;
  if v_role not in ('chairman','president','secretary','treasurer','compliance_officer') then
    raise exception 'Admin access required';
  end if;
  delete from jex_news where id::text = p_news_id;
  if not found then raise exception 'That news post no longer exists'; end if;
  return jsonb_build_object('deleted', true);
end;
$body$;
$fn$;
  execute $fn$
create or replace function public.rpc_admin_close_vote(p_vote_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $body$
declare v_role text;
begin
  select role into v_role from jex_users where auth_uid = auth.uid();
  if v_role is null then raise exception 'Not authenticated'; end if;
  if v_role not in ('chairman','president','secretary','treasurer','compliance_officer') then
    raise exception 'Admin access required';
  end if;
  update jex_votes set status = 'closed' where id::text = p_vote_id;
  if not found then raise exception 'That vote no longer exists'; end if;
  return jsonb_build_object('closed', true);
end;
$body$;
$fn$;
  execute $fn$
create or replace function public.rpc_admin_delete_vote(p_vote_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $body$
declare v_role text;
begin
  select role into v_role from jex_users where auth_uid = auth.uid();
  if v_role is null then raise exception 'Not authenticated'; end if;
  if v_role not in ('chairman','president','secretary','treasurer','compliance_officer') then
    raise exception 'Admin access required';
  end if;
  delete from jex_vote_ballots where vote_id::text = p_vote_id;
  delete from jex_votes where id::text = p_vote_id;
  if not found then raise exception 'That vote no longer exists'; end if;
  return jsonb_build_object('deleted', true);
end;
$body$;
$fn$;
  foreach v_fn in array array['rpc_admin_delete_news(text)','rpc_admin_close_vote(text)','rpc_admin_delete_vote(text)'] loop
    execute format('revoke execute on function public.%s from public, anon', v_fn);
    execute format('grant execute on function public.%s to authenticated', v_fn);
  end loop;

  -- ── 4. fixed search_path ──
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('rpc_get_company_team_contacts','rpc_get_leadership_contacts','rpc_pay_dividend')
  loop
    execute format('alter function %s set search_path to ''public''', r.oid::regprocedure);
  end loop;

  -- ── 5. rpc_cast_vote: the same deadline rule as the sweep ──
  select p.oid, p.prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_cast_vote';
  if r.oid is null then raise exception 'ABORT: rpc_cast_vote not found. Nothing changed.'; end if;
  if position('closes_at ~ ' in r.prosrc) > 0 then
    raise notice 'rpc_cast_vote already uses the ISO deadline rule -- skipped.';
  else
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception 'ABORT: expected the deadline cast exactly once in rpc_cast_vote, found % (run vote_deadline_enforced.sql first?). Nothing changed -- paste this error back.', v_n;
    end if;
    v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;
    execute replace(r.def, r.prosrc, replace(r.prosrc, v_old,
      '-- Only an ISO timestamp is a deadline, as in the sweep and app.js;' || v_nl ||
      '    -- anything else falls to created_at + 24 hours below.' || v_nl ||
      '    -- (bug_hunt_round_three.sql)' || v_nl ||
      '    if v_vote.closes_at ~ ''^\d{4}-\d{2}-\d{2}T'' then' || v_nl ||
      '      ' || v_old || v_nl ||
      '    end if;'));
    raise notice 'rpc_cast_vote: deadline read by the same rule as the sweep.';
  end if;
end
$mig$;

-- ── verification ──
-- capital_raised        what the company page now shows, per ticker
-- starting_cash         accounts with their own baseline recorded / without
--                       (those without use the session setting, as before)
-- officer_moderation    true: the three officer functions exist
-- search_path_fixed     true: all three functions run with search_path=public
-- vote_rule_matches     true: rpc_cast_vote uses the ISO test
select
  (select rpc_capital_raised()->'by_ticker')                                       as capital_raised,
  (select jsonb_build_object('recorded', count(starting_cash), 'session_default', count(*) - count(starting_cash))
     from jex_users where role in ('student','company'))                          as starting_cash,
  (select count(*) = 3 from pg_proc
    where proname in ('rpc_admin_delete_news','rpc_admin_close_vote','rpc_admin_delete_vote')) as officer_moderation,
  (select bool_and(coalesce(array_to_string(proconfig, ',') like '%search_path=public%', false))
     from pg_proc
    where proname in ('rpc_get_company_team_contacts','rpc_get_leadership_contacts','rpc_pay_dividend')) as search_path_fixed,
  (select position('closes_at ~ ' in prosrc) > 0 from pg_proc where proname = 'rpc_cast_vote') as vote_rule_matches;
