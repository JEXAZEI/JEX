-- ============================================================
-- president_password.sql
--
-- New: the Chairman can set the President's password.
--
-- Until now nobody could. The reset-password screen refuses Chairman and
-- President accounts, and a "reset email" only helps someone who can still
-- read that inbox. A President locked out on game day stayed locked out.
--
-- rpc_admin_set_president_password(president's id, new password):
--
--   * only the Chairman may call it, and only on the President's account --
--     checked here, from the login, not taken from the browser
--   * 6 to 72 characters (6 is the sign-in minimum; 72 is bcrypt's limit,
--     past which the rest of a password is silently ignored)
--   * an account with a real sign-in has its sign-in password replaced, and
--     is signed out on every device: a password changed by someone else is
--     usually a lost or leaked one. Pages already open stop working within
--     the hour, when their sign-in next renews.
--   * an account still on the old password system has that password replaced
--     and its failed-sign-in count cleared
--   * the change is logged ("President's password changed by <Chairman>"),
--     and the President is told in the app. The new password is never
--     logged, stored in clear or sent anywhere.
--
-- Refuses to run, changing nothing, if this database cannot set a sign-in
-- password (no auth.users, no permission to update it, no pgcrypto), or if
-- the server-events functions it logs through are missing. Safe to run twice.
-- ============================================================

do $mig$
declare
  v_crypto text;
  v_body text;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'auth' and table_name = 'users' and column_name = 'encrypted_password') then
    raise exception 'ABORT: auth.users.encrypted_password not found -- this is not a Supabase database as expected. Nothing changed.';
  end if;
  if not has_table_privilege('auth.users', 'UPDATE') then
    raise exception 'ABORT: % cannot update auth.users, so a sign-in password cannot be set from here. Nothing changed -- paste this error back.', current_user;
  end if;
  select extnamespace::regnamespace::text into v_crypto from pg_extension where extname = 'pgcrypto';
  if v_crypto is null then
    raise exception 'ABORT: pgcrypto is not installed (Database > Extensions > pgcrypto). Nothing changed.';
  end if;
  if to_regprocedure('public.jex_log(text,text,text,text,text,numeric)') is null
     or to_regprocedure('public.jex_notify(text,text,text,text,boolean)') is null then
    raise exception 'ABORT: run server_events_batch1.sql to batch4 first. Nothing changed.';
  end if;

  v_body := $body$
create or replace function public.rpc_admin_set_president_password(p_user_id text, p_new_pw text)
 returns jsonb language plpgsql security definer set search_path to public, {crypto}
as $fn$
declare
  v_me jex_users%rowtype;
  v_pres jex_users%rowtype;
  v_devices int;
begin
  select * into v_me from jex_users where auth_uid = auth.uid();
  if v_me.id is null then raise exception 'Not authenticated'; end if;
  if v_me.role is distinct from 'chairman' then
    raise exception 'Only the Chairman can change the President''s password';
  end if;

  select * into v_pres from jex_users where id = p_user_id for update;
  if v_pres.id is null or v_pres.role is distinct from 'president' then
    raise exception 'That account is not the President';
  end if;

  if p_new_pw is null or length(p_new_pw) < 6 then
    raise exception 'Password must be at least 6 characters';
  end if;
  if octet_length(p_new_pw) > 72 then
    raise exception 'Password must be at most 72 characters';
  end if;

  if v_pres.auth_uid is not null then
    update auth.users set encrypted_password = crypt(p_new_pw, gen_salt('bf', 10)), updated_at = now()
     where id = v_pres.auth_uid;
    if not found then
      raise exception 'The President''s sign-in account was not found -- nothing changed';
    end if;
    -- Signed out everywhere. Refresh tokens go with their sessions; older
    -- tokens without a session are removed directly.
    begin
      delete from auth.sessions where user_id = v_pres.auth_uid;
      get diagnostics v_devices = row_count;
      delete from auth.refresh_tokens where user_id = v_pres.auth_uid::text;
    exception when insufficient_privilege or undefined_table then
      v_devices := null;
    end;
  else
    update jex_users set password = encode(digest(p_new_pw, 'sha256'), 'hex') where id = v_pres.id;
    if to_regprocedure('public.jex_login_throttle_clear(text)') is not null then
      perform jex_login_throttle_clear(v_pres.id);
    end if;
  end if;

  perform jex_log('password_reset', 'President''s password changed by ' || coalesce(v_me.name, 'the Chairman'),
                  null, v_pres.id, v_pres.name, null);
  perform jex_notify(v_pres.id, 'security',
    '🔑 Your password was changed by the Chairman (' || coalesce(v_me.name, 'Chairman')
    || '). If you did not ask for this, tell them right away.', null, false);

  return jsonb_build_object('changed', true, 'name', v_pres.name,
                            'real_sign_in', v_pres.auth_uid is not null,
                            'devices_signed_out', v_devices);
end;
$fn$;
$body$;
  execute replace(v_body, '{crypto}', quote_ident(v_crypto));

  execute 'revoke all on function public.rpc_admin_set_president_password(text, text) from public, anon';
  execute 'grant execute on function public.rpc_admin_set_president_password(text, text) to authenticated';
  raise notice 'The Chairman can now set the President''s password.';
end
$mig$;

-- ── verification ──
-- chairman_only           true: the function refuses anyone but the Chairman
-- signed_out_cannot_call  true
-- presidents              who it can be used on: name, and whether the
--                         account has a real sign-in (true) or the old
--                         password system (false)
select
  (select position('if v_me.role is distinct from ''chairman'' then' in prosrc) > 0
     from pg_proc where proname = 'rpc_admin_set_president_password')                         as chairman_only,
  not has_function_privilege('anon', 'public.rpc_admin_set_president_password(text,text)', 'execute')
                                                                                               as signed_out_cannot_call,
  (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'real_sign_in', auth_uid is not null)), '[]'::jsonb)
     from jex_users where role = 'president')                                                  as presidents;
