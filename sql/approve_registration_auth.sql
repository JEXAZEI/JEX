-- ============================================================
-- approve_registration_auth.sql
--
-- RUN THIS ONE FIRST. Any student can give themselves any amount of money.
--
-- approve_registration creates a jex_users row with the cash its CALLER names:
--
--     create function approve_registration(p_pending_id text,
--                                          p_starting_cash numeric,
--                                          p_classroom_id text default null)
--     ... security definer ...
--     begin
--       select * into v_pending from jex_pending where id = p_pending_id;
--       ...
--       insert into jex_users (..., cash, ...) values (..., p_starting_cash, ...)
--
-- There is no role check in it. Not a weak one -- there is no call to
-- auth.uid() in the function at all. The only thing standing in front of it is
-- the admin panel, which is client-side and therefore not standing in front of
-- anything: the RPC is published, and this database grants EXECUTE on it to
-- both `anon` and `authenticated`.
--
-- Measured against this database's own function bodies running locally. Signed
-- in as Student 2, an ordinary approved student with $9,647.03:
--
--     approve_registration('<a pending id>', 1000000)
--       -> {"cash": 1000000, "role": "student", "status": "approved"}
--
--     money in the exchange: $459,846.25  ->  $1,459,846.25
--
-- A million dollars, created in one call, by a student. And they do not need
-- to be signed in as anybody: rpc_register_pending is granted to `anon`, and
-- it RETURNS the row it just inserted -- including the id. So the whole thing
-- is three calls from a logged-out browser console:
--
--     1. rpc_register_pending(...)        -> {"id": "...", ...}
--     2. approve_registration(id, 999999999)
--     3. sign in with the password from step 1
--
-- ── One thing I could NOT confirm, stated as such ──
--
-- A pending row also carries `role`, and approve_registration copies it
-- verbatim. On my copy, approving a pending row with role='chairman' produced
-- a CHAIRMAN -- which is every admin RPC in the database, including the ones
-- that DO check roles. rpc_register_pending refuses anything but 'student' and
-- 'company', so that variant needs a direct INSERT into jex_pending, and
-- whether a student can do that depends on the row-level-security policy on
-- that table, which I have not read. The cash path above needs no such thing
-- and is confirmed.
--
-- ── The fix ──
--
-- Require the caller to be an officer -- the same five roles isAdmin() checks
-- in the client and the same list rpc_admin_remove_user and
-- rpc_admin_delist_company already use -- and reject a negative starting cash.
-- Nothing about the normal flow changes: the admin panel calls this as an
-- officer and always has.
--
-- The role on the pending row is left alone deliberately. Refusing to approve
-- a 'chairman' row here would break a legitimate path if you ever seed an
-- officer that way, and it is the wrong place for that rule -- the right place
-- is whatever writes jex_pending. The role check below already stops a student
-- reaching this function at all.
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
   where n.nspname = 'public' and p.proname = 'approve_registration';
  if r is null then
    raise exception 'ABORT: approve_registration not found. Nothing changed.';
  end if;

  if position('v_caller_role text;' in r.prosrc) > 0 then
    raise notice 'approve_registration already checks the caller -- skipped.';
    return;
  end if;

  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, '  v_user record;', '')))
         / length('  v_user record;');
  if v_n <> 1 then
    raise exception 'ABORT: expected the declare block exactly once, found %. Nothing changed.', v_n;
  end if;

  v_n := (length(r.prosrc) - length(replace(r.prosrc, 'select * into v_pending from jex_pending where id = p_pending_id;', '')))
         / length('select * into v_pending from jex_pending where id = p_pending_id;');
  if v_n <> 1 then
    raise exception 'ABORT: expected the pending lookup exactly once, found %. Nothing changed.', v_n;
  end if;

  v_src := replace(r.prosrc, '  v_user record;', '  v_user record;' || v_nl || '  v_caller_role text;');

  v_src := replace(v_src,
    'select * into v_pending from jex_pending where id = p_pending_id;',
    '-- This function had no caller check of ANY kind -- no auth.uid() call in' || v_nl ||
    '  -- it at all -- while being SECURITY DEFINER, granted to anon and' || v_nl ||
    '  -- authenticated, and taking the new account''s cash balance straight' || v_nl ||
    '  -- from its argument. The admin panel is not a check; it runs on the' || v_nl ||
    '  -- student''s own machine. Measured: an ordinary student called it with' || v_nl ||
    '  -- p_starting_cash = 1000000 and got an approved account holding exactly' || v_nl ||
    '  -- that, taking the exchange from $459,846.25 to $1,459,846.25.' || v_nl ||
    '  select role into v_caller_role from jex_users where auth_uid = auth.uid();' || v_nl ||
    '  if v_caller_role is null then raise exception ''Not authenticated''; end if;' || v_nl ||
    '  if v_caller_role not in (''chairman'',''president'',''secretary'',''treasurer'',''compliance_officer'') then' || v_nl ||
    '    raise exception ''Admin access required'';' || v_nl ||
    '  end if;' || v_nl ||
    v_nl ||
    '  -- Negative would be caught by chk_users_cash_nonneg with an unreadable' || v_nl ||
    '  -- constraint error; null would create an account with no balance.' || v_nl ||
    '  if p_starting_cash is null or p_starting_cash < 0 then' || v_nl ||
    '    raise exception ''Starting cash must be zero or more'';' || v_nl ||
    '  end if;' || v_nl ||
    v_nl ||
    '  select * into v_pending from jex_pending where id = p_pending_id;');

  execute replace(r.def, r.prosrc, v_src);
  raise notice 'approve_registration: now requires an officer, and a sane starting balance.';
end
$mig$;

-- ── verification ──
--
-- caller_checked        the role check is in
-- cash_validated        a null or negative starting balance is refused
-- still_open_to_anon    OTHER functions that are SECURITY DEFINER, callable
--                       by anon or authenticated, and contain no auth.uid()
--                       call. The pollers (stop loss, price alert, margin
--                       call, limit fill/match) belong here on purpose -- any
--                       client runs them for anybody and they re-derive their
--                       own conditions under a lock. Anything else in this
--                       list is worth a second look.
-- accounts_by_cash      every account and its balance, highest first, so an
--                       already-minted balance would stand out. Compare
--                       against the starting cash you actually handed out.
-- pending_queue         registrations waiting, and the role each one carries.
--                       Anything here that is not 'student' or 'company' did
--                       not come from the signup form.
select
  (select position('v_caller_role text;' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'approve_registration')         as caller_checked,

  (select position('Starting cash must be zero or more' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'approve_registration')         as cash_validated,

  (select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
      and p.prosrc not like '%auth.uid()%'
      and p.prosrc not like '%_caller_role%'
      and (p.proacl is null
        or exists (select 1 from unnest(p.proacl::text[]) a
                    where a like 'anon=%' or a like 'authenticated=%')))       as still_open_to_anon,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'name', u.name, 'role', u.role, 'cash', u.cash,
            'joined', u.created_at::date) order by u.cash desc), '[]'::jsonb)
     from jex_users u)                                                         as accounts_by_cash,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'name', pd.name, 'role', pd.role, 'submitted', pd.created_at::date)
          order by pd.created_at), '[]'::jsonb)
     from jex_pending pd)                                                      as pending_queue;
