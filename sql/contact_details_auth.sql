-- ============================================================
-- contact_details_auth.sql
--
-- Two functions hand out students' email addresses to anyone who asks.
--
-- rpc_get_company_team_contacts and rpc_get_leadership_contacts are both
-- SECURITY DEFINER, both granted EXECUTE to `anon`, and neither contains a
-- call to auth.uid(). They return names and email addresses:
--
--     rpc_get_company_team_contacts('AZEI')
--       -> [{"id":..., "name":..., "email":..., "role":"Owner"},
--           {"id":..., "name":..., "email":..., "role":"Founder"}, ...]
--
--     rpc_get_leadership_contacts()
--       -> [{"id":..., "name":..., "email":...}]   -- chairman and president
--
-- The Supabase publishable key is in the page source, which is how it is
-- supposed to work -- it is a public key and RLS is what protects the data
-- behind it. But a SECURITY DEFINER function bypasses RLS by design, so for
-- these two the key is the only thing between an anonymous caller and the
-- list. Ticker symbols are public, so the company one can be walked.
--
-- That is a roomful of teenagers' email addresses, readable by anyone with
-- the site URL and thirty seconds. Nothing here has been exploited as far as
-- I can tell -- there is no log that would show it either way, and I am not
-- going to claim it has not been.
--
-- ── The fix ──
--
-- Require the caller to be a signed-in account. Both functions exist to let
-- students contact a company's team or the exchange's leadership from inside
-- the app, and everyone using them that way is signed in, so nothing about
-- the feature changes. An anonymous caller now gets 'Not authenticated'
-- instead of a list.
--
-- Both are rewritten whole rather than patched, because both are short and I
-- have their exact current bodies. rpc_get_leadership_contacts changes from
-- LANGUAGE sql to plpgsql so it can raise; the result for a signed-in caller
-- is byte-for-byte the same JSON.
--
-- ── What this does NOT close ──
--
-- rpc_check_email_taken is also anon-callable and answers whether an address
-- is already registered. That is an enumeration oracle, and it is left alone
-- on purpose: the signup form needs it before anybody has an account, so
-- there is nobody to authenticate. It leaks one bit per guessed address,
-- which is the normal cost of a "that email is taken" message.
--
-- Safe to run twice: these are CREATE OR REPLACE with the guard already in
-- them, so a second run replaces each function with an identical body.
-- ============================================================

create or replace function public.rpc_get_company_team_contacts(p_ticker text)
returns jsonb
language plpgsql
stable
security definer
as $function$
declare
  v_owner_id text;
  v_result jsonb;
begin
  -- SECURITY DEFINER bypasses RLS, so without this the publishable key in the
  -- page is the only thing between an anonymous caller and a list of student
  -- names and email addresses -- one call per ticker, and tickers are public.
  if not exists (select 1 from jex_users where auth_uid = auth.uid()) then
    raise exception 'Not authenticated';
  end if;

  select owner_id into v_owner_id from jex_companies where ticker = p_ticker;
  if v_owner_id is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_result from (
    select jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email, 'role', 'Owner') as row
      from jex_users u where u.id = v_owner_id
    union all
    select jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email, 'role', 'Founder') as row
      from jex_company_members m
      join jex_users u on u.id = m.student_id
      where m.company_user_id = v_owner_id and m.status = 'accepted'
  ) t;

  return v_result;
end;
$function$;

create or replace function public.rpc_get_leadership_contacts()
returns jsonb
language plpgsql
stable
security definer
as $function$
begin
  -- Same reason as above. These two are the instructor's own addresses rather
  -- than a student's, which is a smaller exposure, but there is no reason for
  -- them to be readable without signing in either.
  if not exists (select 1 from jex_users where auth_uid = auth.uid()) then
    raise exception 'Not authenticated';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'email', email)), '[]'::jsonb)
      from jex_users where role in ('chairman','president')
  );
end;
$function$;

-- Unchanged from what they already had: the app calls both from a signed-in
-- page, and the grant is what lets PostgREST route to them at all. The guard
-- inside is now what decides.
grant execute on function public.rpc_get_company_team_contacts(text) to anon, authenticated;
grant execute on function public.rpc_get_leadership_contacts() to anon, authenticated;

-- ── verification ──
--
-- team_contacts_guarded / leadership_contacts_guarded
--     both now check the caller
-- still_anon_readable
--     every remaining SECURITY DEFINER function that anon can call and that
--     never mentions auth.uid(). What should be left: the five pollers and
--     read-only helpers (jex_mark_price, rpc_fill_limit_vs_pool,
--     rpc_match_limit_order_book, rpc_margin_call_short,
--     rpc_trigger_price_alert, rpc_margin_call_fund_short,
--     rpc_auto_close_expired_votes), and the pre-authentication paths that
--     take a credential as an argument and verify it themselves
--     (rpc_resolve_login_identity, verify_legacy_*, reset_*, rpc_change_*,
--     rpc_check_email_taken, the verification-code pair). Anything else
--     appearing here is worth another look.
-- emails_exposed
--     how many addresses the company endpoint would have returned across
--     every listed ticker, which is the size of what was reachable.
select
  (select position('if not exists (select 1 from jex_users where auth_uid = auth.uid()) then' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_get_company_team_contacts') as team_contacts_guarded,

  (select position('if not exists (select 1 from jex_users where auth_uid = auth.uid()) then' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_get_leadership_contacts')   as leadership_contacts_guarded,

  (select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
      and p.prosrc not like '%auth.uid()%'
      and p.prosrc not like '%_caller_role%'
      and (p.proacl is null
        or exists (select 1 from unnest(p.proacl::text[]) a
                    where a like 'anon=%' or a like 'authenticated=%')))        as still_anon_readable,

  (select count(*) from (
     select u.id from jex_companies c
       join jex_users u on u.id = c.owner_id
      where c.status = 'listed'
     union
     select m.student_id from jex_companies c
       join jex_company_members m on m.company_user_id = c.owner_id and m.status = 'accepted'
      where c.status = 'listed'
   ) q)                                                                         as emails_exposed;
