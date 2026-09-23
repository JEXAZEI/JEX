-- ============================================================
-- push_notification_guard.sql
--
-- Any signed-in account could put any text in front of any student, and have
-- it EMAILED to them.
--
-- rpc_push_notification checked that the caller was signed in and that the
-- type was on a list of 21. Nothing else: not who the caller was, not who the
-- recipient was, not what the text said, not how many. For nine of those types
-- it also emails the recipient, from the exchange's own EmailJS account, with
-- the caller's text as the subject and body. So a student could send another
-- student -- or their parent's inbox, if that is the notification address --
-- "🎉 Your IPO has been approved!" or anything else, as the exchange, as many
-- times as they liked.
--
-- ── Why not simply "officers only" ──
--
-- Because most notifications are sent by whichever browser NOTICES an event,
-- and that is usually a student's. A student's limit order fills against a
-- resting one and their browser tells the other side. A stop-loss sweep, a
-- short-squeeze alert, a bug report to the officers -- all sent by students'
-- browsers, legitimately. Locking it to officers would silence all of those.
-- The real cure is the server writing its own notifications as events happen;
-- that is a rebuild, not a Thursday fix. This closes what can be closed
-- without it:
--
--   1. EMAIL CARRIES NO STUDENT-WRITTEN TEXT. When an officer sends, or when
--      the caller is the recipient, the email carries the message as before.
--      Otherwise it says only what KIND of notification is waiting -- "You
--      have a new Order filled notification on JEX. Sign in to read it." The
--      exchange's mail can no longer be used to say anything a student chose.
--
--   2. Four types only an officer can send: session, ipo, minutes, price_adj.
--      Those announce officer actions; nobody else has a reason to.
--
--   3. Three types only an officer can RECEIVE: bug_report, flag,
--      contact_admin. They exist to reach the officers; aimed at a student,
--      they were an email relay. div_approval must have an officer on one end.
--
--   4. A rate limit. 100 a minute from one sender, 10 a minute from one
--      sender to one recipient; 300 a minute for officers, whose broadcasts
--      reach the whole class. Well above anything the app does.
--
--   5. Every notification records who sent it (sent_by), so a forged one can
--      be traced to an account.
--
--   6. Messages over 500 characters are cut; a ticker that does not exist is
--      dropped.
--
-- ── And one that was simply broken ──
--
-- 'margin_call' was not on the list of 21. The app has been sending it since
-- margin calls existed, every one was refused as "Invalid notification type",
-- and the app swallows notification errors -- so no student has ever been told
-- their short was closed by a margin call. It is added, and emailed.
--
-- ── Safety ──
--
-- The function is rewritten whole, so this refuses to run unless production's
-- copy is byte-for-byte the one it was written against (md5 below, matched
-- against the fingerprint taken from production). Safe to run twice: the
-- second run finds sent_by in the body and skips.
-- ============================================================

do $mig$
declare
  v_md5 text;
  v_src text;
begin
  select md5(replace(p.prosrc, chr(13), '')), p.prosrc into v_md5, v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_push_notification';
  if v_src is null then
    raise exception 'ABORT: rpc_push_notification not found. Nothing changed.';
  end if;
  if position('sent_by' in v_src) > 0 then
    raise notice 'rpc_push_notification is already guarded -- skipped.';
    return;
  end if;
  if v_md5 <> '0c8c3d95ced037fc3361baff09520618' then
    raise exception 'ABORT: rpc_push_notification is not the version this was written against (md5 %). Nothing changed -- paste this error back.', v_md5;
  end if;

  alter table public.jex_notifications add column if not exists sent_by text;
  alter table public.jex_notifications add column if not exists created_at timestamptz not null default now();
  create index if not exists jex_notifications_sent_by_recent
    on public.jex_notifications (sent_by, created_at);

  execute $fn$
create or replace function public.rpc_push_notification(p_user_id text, p_type text, p_message text, p_ticker text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $body$
declare
  v_caller text;
  v_caller_role text;
  v_is_officer boolean;
  v_recipient jex_users%rowtype;
  v_recipient_officer boolean;
  v_row jex_notifications%rowtype;
  v_secret text;
  v_sess jex_session%rowtype;
  v_addr text;
  v_msg text;
  v_ticker text;
  v_n int;
  v_limit int;
  v_label text;
  v_email_msg text;
  v_email_subject text;
  v_officers text[] := array['chairman','president','secretary','treasurer','compliance_officer'];
  v_allowed_types text[] := array['after_hours','bug_report','contact_admin','div_approval',
    'dividend','financials','flag','founder_alloc','halt','invite','ipo','limit_fill','margin_call',
    'minutes','news','price_adj','price_alert','resume','session','stop_loss','vote','vote_closed'];
  v_important text[] := array['dividend','halt','stop_loss','ipo','session','limit_fill',
    'founder_alloc','bug_report','contact_admin','margin_call'];
  -- Announce an officer's own action; nobody else has a reason to send them.
  v_officer_sends text[] := array['session','ipo','minutes','price_adj'];
  -- Exist to reach the officers. Aimed at a student they were an email relay.
  v_officer_receives text[] := array['bug_report','flag','contact_admin'];
begin
  select id, role into v_caller, v_caller_role from jex_users where auth_uid = auth.uid();
  if v_caller is null then raise exception 'Not authenticated'; end if;
  v_is_officer := coalesce(v_caller_role = any(v_officers), false);

  if p_type is null or not (p_type = any(v_allowed_types)) then
    raise exception 'Invalid notification type';
  end if;

  select * into v_recipient from jex_users where id = p_user_id;
  if not found then raise exception 'Recipient not found'; end if;
  v_recipient_officer := coalesce(v_recipient.role = any(v_officers), false);

  if p_type = any(v_officer_sends) and not v_is_officer then
    raise exception 'Only an officer can send % notifications', p_type;
  end if;
  if p_type = any(v_officer_receives) and not v_recipient_officer then
    raise exception '% notifications go to officers only', p_type;
  end if;
  if p_type = 'div_approval' and not (v_is_officer or v_recipient_officer) then
    raise exception 'Dividend approval notifications must involve the Treasurer';
  end if;

  v_msg := btrim(coalesce(p_message, ''));
  if v_msg = '' then raise exception 'A notification needs a message'; end if;
  if length(v_msg) > 500 then v_msg := left(v_msg, 499) || '…'; end if;

  v_ticker := case when p_ticker is not null
                    and exists (select 1 from jex_companies where ticker = p_ticker)
                   then p_ticker end;

  -- Rate limit, counted from what this sender actually wrote.
  select count(*) into v_n from jex_notifications
   where sent_by = v_caller and created_at > now() - interval '1 minute';
  -- Computed first: in PL/pgSQL a CASE inside an IF condition has its THEN
  -- read as the IF's, which does not parse.
  v_limit := case when v_is_officer then 300 else 100 end;
  if v_n >= v_limit then
    raise exception 'Too many notifications -- wait a minute';
  end if;
  if not v_is_officer and v_caller <> p_user_id then
    select count(*) into v_n from jex_notifications
     where sent_by = v_caller and user_id = p_user_id and created_at > now() - interval '1 minute';
    if v_n >= 10 then raise exception 'Too many notifications to one person -- wait a minute'; end if;
  end if;

  insert into jex_notifications (id, user_id, type, message, ticker, read, ts, sent_by, created_at)
    values (gen_random_uuid()::text, p_user_id, p_type, v_msg, v_ticker, false,
      to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI AM'), v_caller, now())
    returning * into v_row;

  -- Best-effort email dispatch -- never allowed to fail the notification
  -- write itself.
  begin
    if v_recipient.email_notifications and p_type = any(v_important) then
      v_addr := coalesce(v_recipient.notification_email, v_recipient.email);
      if v_addr is not null then
        select * into v_sess from jex_session where id = 1;
        select emailjs_access_token into v_secret from jex_email_secrets where id = 1;
        if v_sess.emailjs_service_id is not null and v_sess.emailjs_template_id is not null
           and v_sess.emailjs_public_key is not null and v_secret is not null then
          -- The exchange's mail carries text a student wrote only when that
          -- student is writing to themselves. From anyone else who is not an
          -- officer, it says what KIND of notification is waiting and nothing
          -- more -- the message itself is read in the app.
          v_label := case p_type
            when 'dividend' then 'Dividend' when 'halt' then 'Trading halt'
            when 'stop_loss' then 'Stop-loss' when 'ipo' then 'IPO'
            when 'session' then 'Session' when 'limit_fill' then 'Order filled'
            when 'founder_alloc' then 'Founder shares' when 'bug_report' then 'Bug report'
            when 'contact_admin' then 'Message' when 'margin_call' then 'Margin call'
            else initcap(replace(p_type, '_', ' ')) end;
          if v_is_officer or v_caller = p_user_id then
            v_email_subject := 'JEX Alert — ' || left(regexp_replace(v_msg, '[\x00-\x1f]', '', 'g'), 60);
            v_email_msg := v_msg;
          else
            v_email_subject := 'JEX Alert — ' || v_label;
            v_email_msg := 'You have a new ' || v_label || ' notification on JEX. Sign in to read it.';
          end if;
          perform net.http_post(
            url := 'https://api.emailjs.com/api/v1.0/email/send',
            body := jsonb_build_object(
              'service_id', v_sess.emailjs_service_id,
              'template_id', v_sess.emailjs_template_id,
              'user_id', v_sess.emailjs_public_key,
              'accessToken', v_secret,
              'template_params', jsonb_build_object(
                'to_email', v_addr,
                'to_name', v_recipient.name,
                'subject', v_email_subject,
                'message', v_email_msg,
                'ticker', coalesce(v_ticker, ''),
                'app_url', coalesce(v_sess.emailjs_site_url, '')
              )
            ),
            headers := jsonb_build_object('Content-Type', 'application/json')
          );
        end if;
      end if;
    end if;
  exception when others then
    null; -- email dispatch is best-effort; the notification row above still stands
  end;

  return to_jsonb(v_row);
end;
$body$;
$fn$;

  raise notice 'rpc_push_notification: guarded (email text, officer-only types, rate limit, sender recorded, margin_call delivered).';
end
$mig$;

-- ── verification ──
--
-- guarded                 the new body is in place
-- margin_call_allowed     margin-call notifications are no longer refused
-- sender_recorded         jex_notifications.sent_by exists
-- search_path_pinned      the function resolves tables in public only
-- still_callable_by       who can execute it: authenticated must be here, or
--                         every notification in the app stops. anon should
--                         not matter (the body refuses without a login).
-- notifications_last_7d   what has been sent recently, by type -- for a
--                         baseline. Senders were not recorded before this.
select
  (select position('v_officer_sends' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_push_notification')        as guarded,
  (select position('''margin_call''' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_push_notification')        as margin_call_allowed,
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'jex_notifications'
             and column_name = 'sent_by')                                      as sender_recorded,
  (select coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=public%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_push_notification')        as search_path_pinned,
  (select coalesce(jsonb_agg(r.rolname order by r.rolname), '[]'::jsonb)
     from pg_roles r
    where r.rolname in ('anon', 'authenticated', 'service_role')
      and has_function_privilege(r.rolname,
            'public.rpc_push_notification(text, text, text, text)', 'execute'))  as still_callable_by,
  (select coalesce(jsonb_object_agg(t.type, t.n), '{}'::jsonb)
     from (select type, count(*) as n from jex_notifications
            where created_at > now() - interval '7 days' group by type) t)     as notifications_last_7d;
