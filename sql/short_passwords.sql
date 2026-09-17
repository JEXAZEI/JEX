-- ============================================================
-- short_passwords.sql
--
-- WRITES. Patches three functions. Aborts and changes nothing on any mismatch.
-- Re-running is a no-op.
--
-- ── What is wrong ──
--
-- A password shorter than six characters means the account cannot trade. Two
-- of the three functions that set one allow four.
--
-- Trading needs a real sign-in: every rpc_trade_* opens with
-- `select id into v_uid from jex_users where auth_uid = auth.uid()`, and an
-- account with no auth_uid never matches. Legacy accounts get their auth_uid
-- the first time they sign in with the right password -- app.js calls
-- supaAuth.auth.signUp right after verify_legacy_password returns true -- and
-- Supabase Auth refuses a password under six characters. So the signUp fails,
-- the account stays on the legacy path, and every trade it attempts comes back
-- "Not authenticated".
--
--   rpc_change_password         requires 6   -- correct
--   rpc_reset_legacy_password   requires 4   -- "Min 4 characters"
--   rpc_admin_reset_password    requires 4   -- "Min 4 characters"
--
-- The two that allow four are the recovery paths: the forgot-password flow a
-- student uses when they are already locked out, and the button an instructor
-- presses to help them. Both are reached precisely when somebody is having
-- trouble getting in, and both will happily set a password that guarantees
-- they still cannot trade afterwards -- while telling them four is fine.
--
-- app.js asks for six on every one of these screens, so the only way to hit it
-- is a direct call. That does not make the message any less wrong, and it is
-- the server that decides.
--
-- ── Also: "You only holds 0 shares" ──
--
-- rpc_place_limit_order builds its refusal as
-- `'% only holds % shares', case when p_fund_id is not null then 'Fund' else 'You' end`
-- so a student trying to sell more than they have reads "You only holds 0
-- shares". It came up nine times in one 500-step fuzz -- it is one of the more
-- common refusals in the app, not an edge case. Now "You only hold 12 shares
-- of ACME" or "This fund only holds 12 shares of ACME", which also says WHICH
-- stock, since a student with several open tickets cannot otherwise tell.
--
-- ── Method ──
--
-- Executable anchors only, each asserted to occur EXACTLY once per function,
-- rebuilt through pg_get_functiondef so the signature, volatility, SECURITY
-- DEFINER and any SET clause return exactly as they are.
-- ============================================================

do $mig$
declare
  r record;
  v_new text; v_n int; v_a text; v_done int := 0;
begin
  -- ── six characters, everywhere a password is set ──
  for r in
    select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('rpc_reset_legacy_password','rpc_admin_reset_password')
     order by p.proname
  loop
    if position('Min 4 characters' in r.prosrc) = 0 then
      raise notice '  % already requires six characters -- skipped', r.proname;
      v_done := v_done + 1;
      continue;
    end if;

    v_a := 'if p_new_pw is null or length(p_new_pw) < 4 then raise exception ''Min 4 characters''; end if;';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
    if v_n <> 1 then
      raise exception 'ABORT: % minimum-length check found % times, expected 1. Nothing changed.', r.proname, v_n;
    end if;

    v_new := replace(r.prosrc, v_a,
      'if p_new_pw is null or length(p_new_pw) < 6 then raise exception ''Password must be at least 6 characters -- a shorter one cannot be linked to a real sign-in, and the account would not be able to trade.''; end if;');

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  %: six characters, and it says why', r.proname;
    v_done := v_done + 1;
  end loop;

  if v_done <> 2 then
    raise exception 'ABORT: expected 2 password-setting functions, handled %.', v_done;
  end if;

  -- ── "You only holds 0 shares" ──
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_place_limit_order';
  if r.proname is null then raise exception 'ABORT: rpc_place_limit_order not found.'; end if;

  if position('only holds % shares' in r.prosrc) = 0 then
    raise notice '  rpc_place_limit_order already reads properly -- skipped';
  else
    v_a := 'raise exception ''% only holds % shares'', case when p_fund_id is not null then ''Fund'' else ''You'' end, v_held;';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
    if v_n <> 1 then raise exception 'ABORT: holdings message found % times, expected 1.', v_n; end if;

    v_new := replace(r.prosrc, v_a,
      'raise exception ''%'', case when p_fund_id is not null'
      || ' then format(''This fund only holds %s shares of %s'', v_held, p_ticker)'
      || ' else format(''You only hold %s shares of %s'', v_held, p_ticker) end;');

    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_place_limit_order: "You only hold 12 shares of ACME"';
  end if;
end
$mig$;

-- ── Verification ──
--
-- All four must be true.
--
-- recovery_needs_six    the forgot-password path no longer sets a password
--                       that cannot be linked to a sign-in...
-- admin_reset_needs_six ...and neither does the instructor's reset button.
-- change_still_needs_six  the one that was already right is untouched.
-- limit_order_reads_right  "You only hold 12 shares of ACME".
--
-- cannot_trade is the one to read: every approved account with no auth_uid.
-- Those are the accounts stuck on the legacy path, and they get "Not
-- authenticated" from every trade until they sign in once with a password of
-- at least six characters. `password_too_short_to_migrate` is true where the
-- stored password is plain text short enough that signing in will not fix it
-- -- an admin has to reset it. A hashed password is 64 hex characters and its
-- true length cannot be known from here, so those read null.
select
  (select prosrc like '%at least 6 characters%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_reset_legacy_password')       as recovery_needs_six,
  (select prosrc like '%at least 6 characters%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_admin_reset_password')        as admin_reset_needs_six,
  (select prosrc like '%length(p_new_pw) < 6%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_change_password')             as change_still_needs_six,
  (select prosrc like '%You only hold %s shares of %s%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_place_limit_order')           as limit_order_reads_right,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'name', u.name, 'role', u.role,
            'password_too_short_to_migrate',
              case when u.password is null then null
                   when u.password ~* '^[0-9a-f]{64}$' then null
                   else length(u.password) < 6 end,
            'holdings_worth', round(coalesce((
              select sum(c.price * (u.holdings->>c.ticker)::numeric)
                from jex_companies c
               where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0), 2))
          order by u.name), '[]'::jsonb)
     from jex_users u
    where u.status = 'approved' and u.auth_uid is null
      and u.role in ('student','company'))                                    as cannot_trade;
