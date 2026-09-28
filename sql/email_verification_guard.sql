-- ============================================================
-- email_verification_guard.sql
--
-- Email verification proved nothing. Three holes, each reproduced against
-- production's own function bodies (fingerprints below match production):
--
--   1. rpc_request_verification_code RETURNED THE CODE to whoever asked, and
--      the browser emailed it. So anyone could ask for a code for any address,
--      read it out of the reply, and confirm it without ever seeing that inbox.
--      Measured: requested for teacher@school.edu, reply {"code": "871604"},
--      confirmed true.
--
--   2. rpc_register_pending stored email_verified exactly as the browser sent
--      it. Skipping verification and posting true put "✓ verified" on the
--      officers' approval screen. Measured: stored true, nothing verified.
--
--   3. rpc_confirm_verification_code allowed unlimited guesses. Measured: 200
--      wrong codes in a row, none refused. With hole 1 closed this becomes the
--      way in, so it is closed at the same time.
--
-- And requesting was unlimited too, so anyone could flood any inbox with codes
-- sent from the exchange's own email account.
--
-- ── The fix ──
--
--   request   The SERVER emails the code (pg_net -> EmailJS, the same account
--             and settings rpc_push_notification already uses) and returns
--             only {"sent": true}. The code never leaves the database except
--             in that email. One request per address per 30 seconds, five per
--             hour, 100 across the exchange per 10 minutes. Refused for an
--             address that already has an account. Codes come from
--             gen_random_bytes, not random().
--
--   confirm   Checks only the latest code for the address. Five wrong guesses
--             and that code is dead -- request a new one. A right code records
--             WHEN it was confirmed (confirmed_at), which is what registration
--             reads.
--
--   register  email_verified is decided by the server: a code confirmed for
--             this address in the last two hours, or a Google sign-in whose
--             own token carries this address. p_email_verified is still
--             accepted, so the app's call does not change, and ignored.
--
-- What "verified" unlocks today: the badge on the approval screen, and the
-- sign-up form's "verify before submitting" step. Nothing else reads it. It is
-- still worth being true -- otherwise an account can be registered under a
-- teacher's address and show as verified.
--
-- ── Order ──
--
-- The app update that goes with this is already live, and works with both the
-- old and new server. So this can be run any time. Until it is, verification
-- works exactly as before.
--
-- ── Safety ──
--
-- Refuses to run, changing nothing, unless all three functions are
-- byte-for-byte the versions this was written and tested against. Safe to run
-- twice: a second run finds each change already in place and skips it.
-- ============================================================

do $mig$
declare
  r record;
  v_nl text;
  v_n int;
  v_anchor text;
  v_want text;
  v_have_req boolean; v_have_conf boolean; v_have_reg boolean;
begin
  -- ── check all three before touching anything ──
  -- Each marker is text only the NEW body contains.
  select position('net.http_post' in prosrc) > 0 into v_have_req from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_request_verification_code';
  select position('confirmed_at' in prosrc) > 0 into v_have_conf from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_confirm_verification_code';
  select position('v_verified' in prosrc) > 0 into v_have_reg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_register_pending';
  if v_have_req is null or v_have_conf is null or v_have_reg is null then
    raise exception 'ABORT: one of the three verification functions is missing. Nothing changed.';
  end if;

  for r in
    select p.proname, md5(replace(p.prosrc, chr(13), '')) as fp
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and ((p.proname = 'rpc_request_verification_code' and not v_have_req)
         or (p.proname = 'rpc_confirm_verification_code' and not v_have_conf)
         or (p.proname = 'rpc_register_pending' and not v_have_reg))
  loop
    -- Computed first: a CASE inside an IF condition has its THEN read as the IF's.
    v_want := case r.proname
                when 'rpc_request_verification_code' then 'ab6aef0f56460ec96da65d5d4c9e902c'
                when 'rpc_confirm_verification_code' then 'e1dce68091ee6873efb6274b2961743f'
                when 'rpc_register_pending'          then '57d84c3ccc0aaa01840d9277a01b9e4a' end;
    if r.fp <> v_want then
      raise exception 'ABORT: % is not the version this was written against (md5 %). Nothing changed -- paste this error back.', r.proname, r.fp;
    end if;
  end loop;

  alter table public.jex_email_verifications add column if not exists confirmed_at timestamptz;
  alter table public.jex_email_verifications add column if not exists attempts int not null default 0;
  create index if not exists jex_email_verifications_email_recent
    on public.jex_email_verifications (email, created_at);

  -- ── 1. request: the server sends the code, and never returns it ──
  if v_have_req then
    raise notice 'rpc_request_verification_code already sends its own email -- skipped.';
  else
    execute $fn$
create or replace function public.rpc_request_verification_code(p_email text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $body$
declare
  v_email text;
  v_code text;
  v_sess jex_session%rowtype;
  v_secret text;
begin
  v_email := lower(trim(coalesce(p_email, '')));
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email';
  end if;
  if exists (select 1 from jex_users where lower(email) = v_email)
     or exists (select 1 from jex_pending where lower(email) = v_email) then
    raise exception 'An account with that email already exists';
  end if;

  -- Every code is an email from the exchange's own account, so asking is
  -- limited: per address, and across the exchange.
  if exists (select 1 from jex_email_verifications
              where email = v_email and created_at > now() - interval '30 seconds') then
    raise exception 'Please wait 30 seconds before asking for another code';
  end if;
  if (select count(*) from jex_email_verifications
       where email = v_email and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Too many codes for this email -- try again in an hour';
  end if;
  if (select count(*) from jex_email_verifications
       where created_at > now() - interval '10 minutes') >= 100 then
    raise exception 'Verification is busy -- try again in a few minutes';
  end if;

  select * into v_sess from jex_session where id = 1;
  select emailjs_access_token into v_secret from jex_email_secrets where id = 1;
  if v_sess.emailjs_service_id is null or v_sess.emailjs_template_id is null
     or v_sess.emailjs_public_key is null or v_secret is null then
    raise exception 'Email verification is not available right now';
  end if;

  -- Six digits from a cryptographic source. random() is predictable.
  v_code := lpad((abs(('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');

  -- Only the latest code for an address can ever be confirmed.
  update jex_email_verifications set used = true where email = v_email and used = false;
  insert into jex_email_verifications (id, email, code, used, expires_at, created_at, attempts)
    values (gen_random_uuid()::text, v_email, v_code, false,
            extract(epoch from now() + interval '15 minutes') * 1000, now(), 0);

  -- The code leaves the database in this email and nowhere else. Returning it
  -- to the caller -- as this used to -- let anyone verify an address they do
  -- not own. Not best-effort: if the send cannot be queued, the request fails
  -- and the code is not stored.
  perform net.http_post(
    url := 'https://api.emailjs.com/api/v1.0/email/send',
    body := jsonb_build_object(
      'service_id', v_sess.emailjs_service_id,
      'template_id', v_sess.emailjs_template_id,
      'user_id', v_sess.emailjs_public_key,
      'accessToken', v_secret,
      'template_params', jsonb_build_object(
        'to_email', v_email,
        'to_name', 'there',
        'subject', 'Your JEX verification code',
        'message', 'Your JEX email verification code is ' || v_code || '. It expires in 15 minutes.',
        'ticker', '',
        'app_url', coalesce(v_sess.emailjs_site_url, '')
      )
    ),
    headers := jsonb_build_object('Content-Type', 'application/json')
  );

  return jsonb_build_object('email', v_email, 'sent', true);
end;
$body$;
$fn$;
    raise notice 'rpc_request_verification_code: the server emails the code and never returns it.';
  end if;

  -- ── 2. confirm: the latest code only, five guesses, and record when ──
  if v_have_conf then
    raise notice 'rpc_confirm_verification_code already limits guesses -- skipped.';
  else
    execute $fn$
create or replace function public.rpc_confirm_verification_code(p_email text, p_code text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $body$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_code  text := trim(coalesce(p_code, ''));
  v_row   jex_email_verifications%rowtype;
begin
  -- The LATEST live code for the address, whatever was typed. Matching on the
  -- typed code first -- as this used to -- meant a wrong guess touched no row,
  -- so nothing could count the guesses.
  select * into v_row from jex_email_verifications
   where email = v_email and used = false
   order by created_at desc limit 1
   for update;
  if not found then return false; end if;

  if extract(epoch from now()) * 1000 > v_row.expires_at then
    update jex_email_verifications set used = true where id = v_row.id;
    return false;
  end if;

  if v_row.code = v_code then
    update jex_email_verifications set used = true, confirmed_at = now() where id = v_row.id;
    return true;
  end if;

  -- Five wrong guesses and this code is finished; a new one has to be sent.
  update jex_email_verifications
     set attempts = attempts + 1, used = (attempts + 1 >= 5)
   where id = v_row.id;
  return false;
end;
$body$;
$fn$;
    raise notice 'rpc_confirm_verification_code: five guesses per code, and confirmation is recorded.';
  end if;

  -- ── 3. register: the server decides whether the email was verified ──
  if v_have_reg then
    raise notice 'rpc_register_pending already decides email_verified itself -- skipped.';
  else
    select p.prosrc as prosrc, pg_get_functiondef(p.oid) as def into r
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'rpc_register_pending';
    v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

    foreach v_anchor in array array[
      'v_name text; v_username text; v_email text; v_auth_uid uuid; v_row jsonb;',
      'insert into jex_pending (id, name, username, email, password, role, description,',
      'p_sec_q, p_sec_a, coalesce(p_email_verified, false),'] loop
      v_n := (length(r.prosrc) - length(replace(r.prosrc, v_anchor, ''))) / length(v_anchor);
      if v_n <> 1 then
        raise exception 'ABORT: expected "%" exactly once in rpc_register_pending, found %. Nothing changed.', v_anchor, v_n;
      end if;
    end loop;

    execute replace(r.def, r.prosrc,
      replace(replace(replace(r.prosrc,
        'v_name text; v_username text; v_email text; v_auth_uid uuid; v_row jsonb;',
        'v_name text; v_username text; v_email text; v_auth_uid uuid; v_row jsonb;' || v_nl ||
        '  v_verified boolean;'),
        'insert into jex_pending (id, name, username, email, password, role, description,',
        '-- email_verified is decided here, never taken from the browser. The' || v_nl ||
        '  -- posted p_email_verified used to be stored as sent, so claiming true' || v_nl ||
        '  -- without verifying put "verified" on the officers'' approval screen.' || v_nl ||
        '  -- Verified means one of two things the server can check itself: a code' || v_nl ||
        '  -- for this address confirmed in the last two hours, or a Google sign-in' || v_nl ||
        '  -- whose own token carries this address. p_email_verified is ignored.' || v_nl ||
        '  v_verified := exists (select 1 from jex_email_verifications' || v_nl ||
        '                         where email = v_email and confirmed_at > now() - interval ''2 hours'')' || v_nl ||
        '    or (auth.uid() is not null' || v_nl ||
        '        and coalesce(auth.jwt() -> ''app_metadata'' ->> ''provider'', '''') = ''google''' || v_nl ||
        '        and lower(coalesce(auth.jwt() ->> ''email'', '''')) = v_email);' || v_nl ||
        v_nl ||
        '  insert into jex_pending (id, name, username, email, password, role, description,'),
        'p_sec_q, p_sec_a, coalesce(p_email_verified, false),',
        'p_sec_q, p_sec_a, v_verified,'));
    raise notice 'rpc_register_pending: email_verified is decided by the server.';
  end if;
end
$mig$;

-- ── verification ──
--
-- code_never_returned      the request no longer puts the code in its reply
-- server_sends_email       the request emails the code itself
-- guesses_limited          five wrong guesses kill a code
-- verified_decided_by_server  registration ignores the browser's claim
-- still_callable_by        anon and authenticated must both be here, or
--                          sign-up breaks (it runs before anyone is logged in)
-- codes_in_last_day        requests in the last 24 hours, for a baseline
select
  (select position('''code'', v_code' in p.prosrc) = 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_request_verification_code')  as code_never_returned,
  (select position('net.http_post' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_request_verification_code')  as server_sends_email,
  (select position('attempts + 1 >= 5' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_confirm_verification_code')  as guesses_limited,
  (select position('p_sec_q, p_sec_a, v_verified,' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_register_pending')           as verified_decided_by_server,
  (select jsonb_object_agg(p.proname, (select coalesce(jsonb_agg(r.rolname order by r.rolname), '[]'::jsonb)
                                         from pg_roles r where r.rolname in ('anon','authenticated')
                                          and has_function_privilege(r.rolname, p.oid, 'execute')))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('rpc_request_verification_code','rpc_confirm_verification_code','rpc_register_pending'))
                                                                                as still_callable_by,
  (select count(*) from jex_email_verifications where created_at > now() - interval '1 day')
                                                                                as codes_in_last_day;
