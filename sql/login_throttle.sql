-- ============================================================
-- login_throttle.sql
--
-- WRITES. Adds two small functions and rewrites one. Aborts and changes
-- nothing on any mismatch. Re-running is a no-op.
--
-- ── What is wrong ──
--
-- A legacy password can be guessed as many times as anybody likes.
--
-- The forgot-password path is throttled: verify_legacy_security_answer opens
-- with `perform jex_recovery_throttle(p_user_id)`, which cuts a user off after
-- 8 tries in 15 minutes. verify_legacy_password -- the one the actual sign-in
-- form calls -- does not. There is no limit on it at all.
--
-- The whole attack is two calls, both reachable with the publishable key that
-- ships in the page:
--
--   rpc_resolve_login_identity('<a name off the leaderboard>', 'student')
--       -> {id, name, username, email, role, sec_q, ...}
--   verify_legacy_password(that id, '<guess>')
--       -> true / false, as often as you like
--
-- A six-character password against an oracle with no limit is not a password.
-- And this is a classroom: the names are on the leaderboard, the usernames are
-- derived from them, and the accounts hold the money being graded.
--
-- Migrated accounts are not exposed -- they go through Supabase Auth, which
-- rate-limits on its own. What is exposed is every account still on the legacy
-- path: anyone who has not signed in since the migration, and anyone whose
-- password is shorter than Supabase's six-character minimum, because those can
-- never migrate. The verification below counts them.
--
-- ── The fix ──
--
-- The same shape as the recovery throttle, with two differences that matter
-- for a sign-in form rather than a recovery flow:
--
--   * a larger budget -- 10 in 15 minutes rather than 8, because typing your
--     own password wrong is ordinary and being locked out of class is not
--   * only FAILURES count. A correct password clears the counter, so signing
--     in repeatedly never locks anybody out; ten wrong ones in a row does.
--
-- It uses its own key namespace in jex_auth_attempts ('pw:' || user_id), so
-- the sign-in budget and the recovery budget are independent -- fumbling your
-- password does not cost you recovery attempts, or the other way round.
--
-- The lockout raises SQLSTATE JEX01, the same private code the recovery
-- throttle uses, so the client can tell "you are locked out" apart from "wrong
-- password" instead of showing the same unhelpful line either way.
--
-- ── Method ──
--
-- The two throttle functions are new, so they are created outright.
-- verify_legacy_password is small enough to rewrite whole, so its ENTIRE
-- current body is asserted byte-for-byte (line endings normalised) before
-- anything is replaced, and it is rebuilt through pg_get_functiondef so the
-- signature, volatility, SECURITY DEFINER and any SET clause return exactly as
-- they are.
-- ============================================================

-- ── the budget ──
create or replace function public.jex_login_throttle(p_user_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_max      constant int      := 10;
  v_window   constant interval := interval '15 minutes';
  v_key      text;
  v_attempts int;
begin
  -- A null id cannot identify an account, so there is nothing to protect and
  -- nothing to charge. The caller rejects it on its own.
  if p_user_id is null then return; end if;

  -- Its own namespace in the shared table. The sign-in budget and the
  -- forgot-password budget are separate on purpose: fumbling your password
  -- should not cost you recovery attempts, or the other way round.
  v_key := 'pw:' || p_user_id;

  insert into public.jex_auth_attempts as a (user_id, window_start, attempts)
       values (v_key, now(), 1)
  on conflict (user_id) do update
     set window_start = case when a.window_start < now() - v_window
                             then now() else a.window_start end,
         attempts     = case when a.window_start < now() - v_window
                             then 1 else a.attempts + 1 end
  returning a.attempts into v_attempts;

  if v_attempts > v_max then
    -- JEX01 is the same private SQLSTATE the recovery throttle uses.
    -- PostgREST passes it through as "code", which is what lets the sign-in
    -- form say "locked out" rather than "invalid username or password" to
    -- somebody who is typing the right thing.
    raise exception 'Too many sign-in attempts for this account. Wait 15 minutes, or ask your instructor to reset your password.'
      using errcode = 'JEX01';
  end if;
end;
$fn$;

-- ── and what clears it ──
create or replace function public.jex_login_throttle_clear(p_user_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- A correct password clears the count. Without this the budget would be
  -- spent by ordinary use -- ten sign-ins in a class period would lock a
  -- student out as surely as ten wrong guesses -- and the thing being
  -- rate-limited is guessing, not signing in.
  if p_user_id is null then return; end if;
  delete from public.jex_auth_attempts where user_id = 'pw:' || p_user_id;
end;
$fn$;

revoke all on function public.jex_login_throttle(text) from public, anon, authenticated;
revoke all on function public.jex_login_throttle_clear(text) from public, anon, authenticated;

do $mig$
declare
  r record;
  v_old text; v_new text; v_nl text;
  -- prosrc keeps the newline that follows `AS $function$`, so the expected
  -- body starts with one too.
  v_expect constant text := chr(10) ||
'declare
  v_stored text;
begin
  select password into v_stored from jex_users where id = p_user_id;
  if v_stored is null or p_password is null then
    return false;
  end if;
  if v_stored ~* ''^[0-9a-f]{64}$'' then
    return v_stored = encode(digest(p_password, ''sha256''), ''hex'');
  end if;
  if v_stored = p_password then
    update jex_users set password = encode(digest(p_password, ''sha256''), ''hex'') where id = p_user_id;
    return true;
  end if;
  return false;
end;
';
begin
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'verify_legacy_password';
  if r.proname is null then raise exception 'ABORT: verify_legacy_password not found.'; end if;

  if position('jex_login_throttle' in r.prosrc) > 0 then
    raise notice '  verify_legacy_password is already throttled -- skipped';
    return;
  end if;

  -- The whole body, byte for byte, with line endings normalised. If a single
  -- character differs this is not the function these notes describe and
  -- nothing should be rewritten.
  v_old := replace(r.prosrc, chr(13), '');
  if v_old <> v_expect then
    raise exception 'ABORT: verify_legacy_password does not match the expected body (% chars vs %). Nothing changed.',
      length(v_old), length(v_expect);
  end if;

  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_new := chr(10) ||
'declare
  v_stored text;
  v_ok boolean := false;
begin
  -- Ten wrong passwords in fifteen minutes and this account stops answering.
  --
  -- Without it this function is an unlimited password oracle, reachable with
  -- the publishable key in the page: rpc_resolve_login_identity turns a name
  -- off the leaderboard into a user id, and this turns a user id plus a guess
  -- into true or false, as many times as anybody cares to ask. A six-character
  -- password does not survive that. The forgot-password path next door has
  -- been throttled all along -- verify_legacy_security_answer opens with the
  -- same call -- and the sign-in form was simply never given one.
  --
  -- Only failures count, and a correct password clears the count below, so
  -- signing in over and over never locks anybody out.
  perform jex_login_throttle(p_user_id);

  select password into v_stored from jex_users where id = p_user_id;
  if v_stored is null or p_password is null then
    return false;
  end if;

  if v_stored ~* ''^[0-9a-f]{64}$'' then
    v_ok := v_stored = encode(digest(p_password, ''sha256''), ''hex'');
  elsif v_stored = p_password then
    update jex_users set password = encode(digest(p_password, ''sha256''), ''hex'') where id = p_user_id;
    v_ok := true;
  end if;

  if v_ok then perform jex_login_throttle_clear(p_user_id); end if;
  return v_ok;
end;
';

  if v_nl <> chr(10) then v_new := replace(v_new, chr(10), v_nl); end if;

  execute replace(r.def, r.prosrc, v_new);
  raise notice '  verify_legacy_password: 10 wrong passwords in 15 minutes and the account stops answering';
end
$mig$;

-- ── Verification ──
--
-- The first four must be true.
--
-- login_is_throttled      the sign-in check now has a budget.
-- success_clears_it       ...and a correct password resets it, so ordinary
--                         use never locks anybody out.
-- budgets_are_separate    sign-in and forgot-password have independent
--                         counters ('pw:' vs the bare id).
-- recovery_still_guarded  the forgot-password throttle is untouched.
-- attempts_table_is_private  anon cannot read, insert into, update or delete
--                         jex_auth_attempts -- if it could, the counter could
--                         simply be cleared between guesses and none of this
--                         would mean anything.
--
-- legacy_accounts is the one to read: every approved account still on the
-- legacy password path, which is exactly the set this was protecting. An
-- account with no auth_uid has never migrated. `can_ever_migrate` is false
-- where the account has no email to migrate with -- those stay on this path
-- permanently.
select
  (select prosrc like '%perform jex_login_throttle(p_user_id);%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='verify_legacy_password')            as login_is_throttled,
  (select prosrc like '%perform jex_login_throttle_clear(p_user_id);%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='verify_legacy_password')            as success_clears_it,
  (select prosrc like '%''pw:'' || p_user_id%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='jex_login_throttle')                as budgets_are_separate,
  (select prosrc like '%perform jex_recovery_throttle(p_user_id);%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='verify_legacy_security_answer')     as recovery_still_guarded,
  (select not bool_or(has_table_privilege('anon','public.jex_auth_attempts', pr))
     from unnest(array['select','insert','update','delete']) pr)                as attempts_table_is_private,
  (select jsonb_build_object(
            'still_on_legacy', count(*) filter (where auth_uid is null),
            'migrated', count(*) filter (where auth_uid is not null),
            'legacy_with_no_email', count(*) filter (where auth_uid is null and coalesce(email,'') = ''),
            'who', coalesce(jsonb_agg(jsonb_build_object('name', name, 'role', role,
                     'can_ever_migrate', coalesce(email,'') <> '')
                   order by name) filter (where auth_uid is null), '[]'::jsonb))
     from jex_users where status = 'approved')                                  as legacy_accounts;
