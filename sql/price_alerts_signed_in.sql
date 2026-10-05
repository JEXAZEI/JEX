-- ============================================================
-- price_alerts_signed_in.sql
--
-- rpc_trigger_price_alert was the one money-adjacent function a signed-out
-- visitor could call: it had no sign-in check at all, and the web's anon role
-- could execute it. It re-checks the alert's condition itself, so nothing
-- false could be triggered -- but an anonymous caller could still fire a
-- student's due alert and send them its notice.
--
-- Now it needs a signed-in account, and signed-out visitors cannot call it.
-- Any signed-in browser can still trigger any due alert: whichever one
-- notices first does, exactly like stop-losses.
--
-- Refuses to run, changing nothing, unless the function is the production
-- version this was tested against (batch 3 applied). Safe to run twice.
-- ============================================================

do $mig$
declare
  v_src text; v_def text; v_fp text; v_nl text; v_n int;
  v_anchor text := '  select * into v_alert from jex_price_alerts where id = p_id and triggered = false for update;';
begin
  select p.prosrc, pg_get_functiondef(p.oid), md5(replace(p.prosrc, chr(13), ''))
    into v_src, v_def, v_fp
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_trigger_price_alert';
  if v_src is null then raise exception 'ABORT: rpc_trigger_price_alert not found. Nothing changed.'; end if;

  if position('Not authenticated' in v_src) > 0 then
    raise notice 'rpc_trigger_price_alert already requires a signed-in account -- skipped.';
  else
    if v_fp <> '97c95f7488af4be6f23acc659608ec99' then
      raise exception 'ABORT: rpc_trigger_price_alert is not the version this was written against (md5 %). Nothing changed -- paste this error back.', v_fp;
    end if;
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    if v_n <> 1 then
      raise exception 'ABORT: expected the anchor exactly once, found %. Nothing changed.', v_n;
    end if;
    v_nl := case when position(chr(13) in v_src) > 0 then chr(13) || chr(10) else chr(10) end;
    execute replace(v_def, v_src, replace(v_src, v_anchor,
      '  if not exists (select 1 from jex_users where auth_uid = auth.uid()) then raise exception ''Not authenticated''; end if;'
      || v_nl || v_nl || v_anchor));
  end if;

  execute 'revoke execute on function public.rpc_trigger_price_alert(text) from public, anon';
  execute 'grant execute on function public.rpc_trigger_price_alert(text) to authenticated';
  raise notice 'rpc_trigger_price_alert: signed-in accounts only.';
end
$mig$;

-- ── verification ──
-- requires_sign_in   the function itself refuses a caller with no account
-- callable_by        should be ["authenticated"]
select
  (select position('Not authenticated' in prosrc) > 0 from pg_proc where proname = 'rpc_trigger_price_alert') as requires_sign_in,
  (select jsonb_agg(r.rolname order by r.rolname) from pg_roles r
    where r.rolname in ('public', 'anon', 'authenticated')
      and has_function_privilege(r.rolname, 'public.rpc_trigger_price_alert(text)', 'execute'))       as callable_by;
