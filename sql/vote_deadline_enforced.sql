-- ============================================================
-- vote_deadline_enforced.sql
--
-- Every vote ends. The browser already believed that; the database did not.
--
-- app.js sets closes_at to 24 hours from posting, and isVoteOpen() hides an
-- expired vote everywhere in the UI. rpc_auto_close_expired_votes sweeps
-- expired rows to status='closed'. All of that works. What was missing is the
-- server-side half: rpc_cast_vote checks status and nothing else --
--
--     if v_vote.status <> 'open' then raise exception 'This vote is closed';
--
-- -- so a ballot is accepted for as long as the status column still says
-- 'open', which is until some browser happens to run the sweep.
--
-- Measured against this database's own function bodies running locally:
--
--   a vote that expired YESTERDAY, sweep not yet run     ballot ACCEPTED
--   the same vote, after the sweep runs                  correctly refused
--   a vote with closes_at null                           ACCEPTED, forever
--   a vote with legacy free-text closes_at
--     ("Friday 3pm", which is what the column held
--      before deadlines were a real feature)             ACCEPTED, forever
--
-- The last two never close at all. The sweep only matches an ISO timestamp
-- (`closes_at ~ '^\d{4}-\d{2}-\d{2}T'`), so a null or a sentence is invisible
-- to it, and isVoteOpen() deliberately treats an unparseable deadline as "no
-- deadline" to avoid mistaking garbage for expiry. Both were the right call
-- when the deadline was cosmetic. Neither is right now.
--
-- ── The rule, in one place ──
--
-- A vote's deadline is closes_at when that is a real timestamp, and
-- created_at + 24 hours when it is not. Every vote therefore has an end,
-- including every vote already in the table, with no data migration and
-- nothing rewritten underneath anyone.
--
-- That rule now lives in three places that have to agree, and this file puts
-- it in all three:
--
--   rpc_cast_vote                 refuses a ballot past the deadline,
--                                 whatever the status column says
--   rpc_post_vote                 always writes a real ISO deadline, so a
--                                 caller that is not the app cannot create an
--                                 immortal vote
--   rpc_auto_close_expired_votes  sweeps on the same rule, so status
--                                 eventually tells the truth for old rows too
--
-- app.js's isVoteOpen() is updated to match in the same commit.
--
-- ── One deliberate behaviour change ──
--
-- Votes currently sitting in the table with no deadline, or with a free-text
-- one, stop accepting ballots 24 hours after they were POSTED -- which for
-- anything already there means immediately. That is the point of the change,
-- but it is a change: if one of those is a live vote you still want answers
-- to, close it and post it again before running this. The verification below
-- lists exactly which votes are affected, so run it first and read that
-- column if you are unsure.
--
-- Safe to run twice. Aborts and changes nothing if any anchor count is wrong.
-- ============================================================

do $mig$
declare
  r record;
  v_nl text;
  v_n  int;
  v_tail text;
begin
  -- ── rpc_cast_vote: the ballot itself ──
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_cast_vote';
  if r is null then
    raise exception 'ABORT: rpc_cast_vote not found. Nothing changed.';
  end if;

  if position('v_deadline timestamptz;' in r.prosrc) > 0 then
    raise notice 'rpc_cast_vote already enforces the deadline -- skipped.';
  else
    v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

    v_n := (length(r.prosrc) - length(replace(r.prosrc, 'v_row jsonb;', ''))) / length('v_row jsonb;');
    if v_n <> 1 then
      raise exception 'ABORT: expected the declare line exactly once in rpc_cast_vote, found %. Nothing changed.', v_n;
    end if;
    v_n := (length(r.prosrc) - length(replace(r.prosrc,
              'if v_vote.status <> ''open'' then raise exception ''This vote is closed''; end if;', '')))
           / length('if v_vote.status <> ''open'' then raise exception ''This vote is closed''; end if;');
    if v_n <> 1 then
      raise exception 'ABORT: expected the status check exactly once in rpc_cast_vote, found %. Nothing changed.', v_n;
    end if;

    execute replace(r.def, r.prosrc,
      replace(
        replace(r.prosrc, 'v_row jsonb;', 'v_row jsonb;' || v_nl || '  v_deadline timestamptz;'),
        'if v_vote.status <> ''open'' then raise exception ''This vote is closed''; end if;',
        'if v_vote.status <> ''open'' then raise exception ''This vote is closed''; end if;' || v_nl ||
        v_nl ||
        '  -- The status column only becomes ''closed'' when a browser happens to' || v_nl ||
        '  -- run rpc_auto_close_expired_votes, so checking it alone accepted' || v_nl ||
        '  -- ballots on a vote that had already expired. Measured: a vote that' || v_nl ||
        '  -- closed YESTERDAY took a ballot because the sweep had not run.' || v_nl ||
        '  --' || v_nl ||
        '  -- closes_at when it is a real timestamp, created_at + 24 hours when' || v_nl ||
        '  -- it is null or free text -- which is what it held ("Friday 3pm")' || v_nl ||
        '  -- before deadlines were enforced. Every vote has an end either way.' || v_nl ||
        '  begin' || v_nl ||
        '    v_deadline := v_vote.closes_at::timestamptz;' || v_nl ||
        '  exception when others then' || v_nl ||
        '    v_deadline := null;' || v_nl ||
        '  end;' || v_nl ||
        '  v_deadline := coalesce(v_deadline, v_vote.created_at + interval ''24 hours'');' || v_nl ||
        '  if now() >= v_deadline then' || v_nl ||
        '    raise exception ''%'', format(''Voting on "%s" closed %s.'', v_vote.question,' || v_nl ||
        '      to_char(v_deadline at time zone ''America/Phoenix'', ''Mon FMDD at FMHH12:MI AM''));' || v_nl ||
        '  end if;'));

    raise notice 'rpc_cast_vote: a ballot past the deadline is now refused.';
  end if;

  -- ── rpc_post_vote: never create an immortal vote ──
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_post_vote';
  if r is null then
    raise exception 'ABORT: rpc_post_vote not found. Nothing changed.';
  end if;

  if position('24 hours from posting, set here' in r.prosrc) > 0 then
    raise notice 'rpc_post_vote already sets the deadline itself -- skipped.';
  else
    v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

    -- The insert tail has two possible spellings. timestamps_arizona.sql
    -- rewrites every bare to_char(now(), ...) to convert to Arizona time, and
    -- this function has one -- so after that migration the tail reads the
    -- second way. Anchoring only on the first is what aborted this file in
    -- production when the two were run in that order. Either is accepted, and
    -- the replacement always writes the Arizona form, so running these two in
    -- either order ends in the same place.
    v_tail := 'to_char(now() at time zone ''America/Phoenix'',''HH12:MI:SS AM''), p_closes_at)';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_tail, ''))) / length(v_tail);
    if v_n = 0 then
      v_tail := 'to_char(now(),''HH12:MI:SS AM''), p_closes_at)';
      v_n := (length(r.prosrc) - length(replace(r.prosrc, v_tail, ''))) / length(v_tail);
    end if;
    if v_n <> 1 then
      raise exception 'ABORT: expected the insert tail exactly once in rpc_post_vote, found %. Nothing changed.', v_n;
    end if;

    execute replace(r.def, r.prosrc, replace(r.prosrc,
      v_tail,
      'to_char(now() at time zone ''America/Phoenix'',''HH12:MI:SS AM''),' || v_nl ||
      '      -- 24 hours from posting, set here rather than taken from the' || v_nl ||
      '      -- caller. p_closes_at is kept so the signature does not change,' || v_nl ||
      '      -- and is deliberately ignored: it was inserted verbatim before,' || v_nl ||
      '      -- including when it was null, which created a vote that could' || v_nl ||
      '      -- never close. The app always sent exactly this value anyway.' || v_nl ||
      '      -- The format matches what rpc_auto_close_expired_votes looks for.' || v_nl ||
      -- Parenthesised deliberately: AT TIME ZONE binds tighter than +, so
      -- `now() + interval '24 hours' at time zone 'utc'` parses as
      -- `now() + (interval at time zone 'utc')` and fails outright with
      -- "function pg_catalog.timezone(unknown, interval) does not exist".
      '      to_char((now() + interval ''24 hours'') at time zone ''utc'',' || v_nl ||
      '              ''YYYY-MM-DD"T"HH24:MI:SS"Z"''))'));

    raise notice 'rpc_post_vote: every new vote gets a real 24-hour deadline.';
  end if;
end
$mig$;

-- ── rpc_auto_close_expired_votes: sweep on the same rule ──
--
-- Rewritten whole, because it is four lines. The old version only matched an
-- ISO closes_at, so a vote with a null or free-text deadline was invisible to
-- it and kept status='open' for ever. rpc_cast_vote now refuses those ballots
-- regardless, but the status column should still tell the truth -- the admin
-- vote-oversight list reads it.
create or replace function public.rpc_auto_close_expired_votes()
returns void
language sql
security definer
set search_path to 'public'
as $function$
  update jex_votes v
     set status = 'closed'
   where v.status = 'open'
     and now() >= coalesce(
           case when v.closes_at ~ '^\d{4}-\d{2}-\d{2}T' then v.closes_at::timestamptz end,
           v.created_at + interval '24 hours');
$function$;

-- ── verification ──
--
-- ballot_checks_deadline   rpc_cast_vote refuses past the deadline
-- new_votes_get_a_deadline rpc_post_vote writes one itself
-- sweep_covers_old_rows    the sweep uses the created_at fallback too
-- votes_now                every vote, its deadline as the new rule reads it,
--                          and whether it is open. `deadline_source` says
--                          whether that came from closes_at or from the
--                          created_at fallback -- a 'created_at + 24h' row is
--                          one that could never close before today.
-- closed_by_this_change    votes that were accepting ballots and now are not.
--                          If one of these is a live vote you still want
--                          answers to, re-post it.
select
  (select position('v_deadline timestamptz;' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_cast_vote')               as ballot_checks_deadline,

  (select position('24 hours from posting, set here' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_post_vote')               as new_votes_get_a_deadline,

  (select position('v.created_at + interval' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_auto_close_expired_votes') as sweep_covers_old_rows,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'question', v.question, 'company', v.company_name,
            'status', v.status,
            'raw_closes_at', v.closes_at,
            'deadline_source', case when v.closes_at ~ '^\d{4}-\d{2}-\d{2}T'
                                    then 'closes_at' else 'created_at + 24h' end,
            'deadline', coalesce(
              case when v.closes_at ~ '^\d{4}-\d{2}-\d{2}T' then v.closes_at::timestamptz end,
              v.created_at + interval '24 hours'),
            'open_now', now() < coalesce(
              case when v.closes_at ~ '^\d{4}-\d{2}-\d{2}T' then v.closes_at::timestamptz end,
              v.created_at + interval '24 hours'))
          order by v.created_at desc), '[]'::jsonb)
     from jex_votes v)                                                        as votes_now,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'question', v.question, 'company', v.company_name,
            'ballots_cast', (select count(*) from jex_vote_ballots b where b.vote_id = v.id))
          order by v.created_at desc), '[]'::jsonb)
     from jex_votes v
    where v.status = 'open'
      and not (v.closes_at ~ '^\d{4}-\d{2}-\d{2}T')
      and now() >= v.created_at + interval '24 hours')                        as closed_by_this_change;
