-- ============================================================
-- password_recovery_broken.sql
--
-- ** Forgot Password does not work. For anybody. Right now. **
--
-- Run this one before Thursday even if nothing else gets run.
--
-- ── What happens to a student ──
--
-- They click Forgot Password, type their email, and get their security
-- question. They answer it correctly. The app accepts the answer and moves
-- them to the new-password screen. They type a new password twice, click
-- Reset, and are told:
--
--     Could not reset password — start over from Forgot Password
--
-- Starting over does exactly the same thing. There is no route out of the
-- loop. The only way that student gets back into the exchange is an officer
-- resetting it for them.
--
-- ── Why ──
--
-- The two steps check the same answer against the same column in two
-- different formats.
--
-- Step 2 is verify_legacy_security_answer. It hashes the typed answer and
-- compares hashes, and it upgrades any row still holding a plaintext answer to
-- a hash as it goes:
--
--     v_hash := encode(digest(v_norm, 'sha256'), 'hex');
--     if v_stored = v_hash then return true; end if;
--
-- Step 3 is reset_migrated_password. It re-verifies the answer itself -- which
-- is right, since the RPC is reachable directly and step 2's word cannot be
-- trusted -- but it compares the STORED value against the PLAINTEXT answer:
--
--     if v_stored_answer <> lower(trim(p_answer)) then
--       return false;
--     end if;
--
-- Once sec_a is a sha256 hash, that comparison can never be true. And sec_a is
-- a hash for everyone: verify_legacy_security_answer upgrades it on the first
-- correct answer, and _hash_sec_a_on_write hashes it on write.
--
-- Measured against these two function bodies running locally, on an account
-- with a hashed sec_a and auth_uid set:
--
--     verify_legacy_security_answer('u_s1', 'Rex')   ->  true
--     reset_migrated_password('u_s1', 'Rex', ...)    ->  FALSE
--
-- and with sec_a as plaintext, which is the shape it was written for:
--
--     reset_migrated_password('u_s1', 'Rex', ...)    ->  true
--
-- ── Why it affects every account ──
--
-- forgotStep3 branches on u.auth_uid: migrated accounts go to
-- reset_migrated_password, legacy ones to rpc_reset_legacy_password. The
-- login_throttle.sql verification reported 15 accounts migrated and 0 on the
-- legacy path. So every account on this exchange takes the broken branch.
-- rpc_reset_legacy_password, the branch nobody uses, delegates to
-- verify_legacy_security_answer and works correctly.
--
-- ── The fix ──
--
-- Delegate, exactly as rpc_reset_legacy_password already does. One function
-- decides what a correct security answer is, both recovery paths ask it, and
-- they cannot drift apart again. It also brings the throttle with it, so the
-- lockout behaviour becomes identical on both paths.
--
-- The minimum password length goes from 4 to 6 in the same pass. Every other
-- place that sets a password -- rpc_reset_legacy_password, rpc_change_password,
-- the registration form and forgotStep3 itself -- requires 6, and
-- short_passwords.sql raised the other recovery path to 6 while missing this
-- one. A student cannot reach the 4 today because forgotStep3 checks 6 in the
-- browser first, but the RPC is callable directly.
--
-- Safe to run twice. Aborts and changes nothing if any anchor count is wrong.
-- ============================================================

do $mig$
declare
  r record;
  v_nl text;
  v_n  int;
  v_src text;
begin
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'reset_migrated_password';
  if r is null then
    raise exception 'ABORT: reset_migrated_password not found. Nothing changed.';
  end if;

  if position('verify_legacy_security_answer(p_user_id, p_answer)' in r.prosrc) > 0 then
    raise notice 'reset_migrated_password already delegates the answer check -- skipped.';
    return;
  end if;

  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, 'length(p_new_password) < 4', '')))
         / length('length(p_new_password) < 4');
  if v_n <> 1 then
    raise exception 'ABORT: expected the 4-character floor exactly once, found %. Nothing changed.', v_n;
  end if;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, 'if v_stored_answer <> lower(trim(p_answer)) then', '')))
         / length('if v_stored_answer <> lower(trim(p_answer)) then');
  if v_n <> 1 then
    raise exception 'ABORT: expected the plaintext comparison exactly once, found %. Nothing changed.', v_n;
  end if;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, 'select sec_a, auth_uid into v_stored_answer, v_auth_uid from jex_users where id = p_user_id;', '')))
         / length('select sec_a, auth_uid into v_stored_answer, v_auth_uid from jex_users where id = p_user_id;');
  if v_n <> 1 then
    raise exception 'ABORT: expected the account lookup exactly once, found %. Nothing changed.', v_n;
  end if;

  -- 4 -> 6, matching every other password path in this schema.
  v_src := replace(r.prosrc, 'length(p_new_password) < 4', 'length(p_new_password) < 6');

  -- The whole local answer check becomes a delegation. The throttle comes with
  -- it, so the two lines that used to call it separately collapse into one.
  v_src := replace(v_src,
    'select sec_a, auth_uid into v_stored_answer, v_auth_uid from jex_users where id = p_user_id;',
    '-- This compared the STORED answer against the PLAINTEXT one, while' || v_nl ||
    '  -- verify_legacy_security_answer stores and compares a sha256 hash and' || v_nl ||
    '  -- upgrades any plaintext row it meets. Once sec_a was a hash -- which it' || v_nl ||
    '  -- is for every account -- step 2 of Forgot Password said the answer was' || v_nl ||
    '  -- right and step 3 said it was wrong, with no way out of the loop.' || v_nl ||
    '  -- Measured: verify_legacy_security_answer true, this function false, on' || v_nl ||
    '  -- the same account and the same answer.' || v_nl ||
    '  --' || v_nl ||
    '  -- One function decides what a correct answer is and both recovery paths' || v_nl ||
    '  -- ask it, which is what rpc_reset_legacy_password already does. The' || v_nl ||
    '  -- throttle lives in there too, so this no longer calls it separately.' || v_nl ||
    '  if not verify_legacy_security_answer(p_user_id, p_answer) then' || v_nl ||
    '    return false;' || v_nl ||
    '  end if;' || v_nl ||
    v_nl ||
    '  select sec_a, auth_uid into v_stored_answer, v_auth_uid from jex_users where id = p_user_id;');

  -- The two now-redundant checks. Left as no-ops rather than deleted so the
  -- shape of the original is still legible next to the fix.
  v_src := replace(v_src,
    'if v_stored_answer is null or p_answer is null then',
    'if v_stored_answer is null or p_answer is null then  -- already covered above');

  v_src := replace(v_src,
    'if v_stored_answer <> lower(trim(p_answer)) then',
    'if false then  -- was: v_stored_answer <> lower(trim(p_answer)) -- see above');

  -- The local throttle call is now made by verify_legacy_security_answer, and
  -- counting each attempt twice would halve the 8-attempt window to 4.
  v_n := (length(v_src) - length(replace(v_src, 'perform jex_recovery_throttle(p_user_id);', '')))
         / length('perform jex_recovery_throttle(p_user_id);');
  if v_n = 1 then
    v_src := replace(v_src, 'perform jex_recovery_throttle(p_user_id);',
      '-- throttled inside verify_legacy_security_answer below; calling it here' || v_nl ||
      '  -- as well would count every attempt twice and halve the window.');
  end if;

  execute replace(r.def, r.prosrc, v_src);
  raise notice 'reset_migrated_password: Forgot Password works again.';
end
$mig$;

-- ── verification ──
--
-- delegates_answer_check   step 3 now asks the same function step 2 does
-- six_char_minimum         matches every other password path
-- no_double_throttle       the 8-attempt window is not halved
-- accounts_by_recovery_path  how many accounts take each branch of
--                          forgotStep3. The migrated count is how many people
--                          could not reset their own password until now.
-- sec_a_storage            how the security answers are actually stored. Every
--                          'hashed' row is an account the old code would have
--                          rejected; every 'plaintext' row is one it happened
--                          to work for.
select
  (select position('verify_legacy_security_answer(p_user_id, p_answer)' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reset_migrated_password')      as delegates_answer_check,

  (select position('length(p_new_password) < 6' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reset_migrated_password')      as six_char_minimum,

  (select position('perform jex_recovery_throttle(p_user_id);' in p.prosrc) = 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reset_migrated_password')      as no_double_throttle,

  (select jsonb_build_object(
            'migrated_uses_this_function', count(*) filter (where auth_uid is not null),
            'legacy_uses_the_other_one',   count(*) filter (where auth_uid is null))
     from jex_users)                                                           as accounts_by_recovery_path,

  (select jsonb_build_object(
            'hashed',    count(*) filter (where sec_a ~* '^[0-9a-f]{64}$'),
            'plaintext', count(*) filter (where sec_a is not null and sec_a !~* '^[0-9a-f]{64}$'),
            'none_set',  count(*) filter (where sec_a is null))
     from jex_users)                                                           as sec_a_storage;
