-- ============================================================
-- activity_hash_coverage.sql
--
-- The audit trail's hash chain does not cover who an entry is about.
--
-- jex_activity carries prev_hash and entry_hash, which makes it a hash chain:
-- each row commits to the one before it, so altering an old row after the fact
-- should break every hash after it and be obvious. rpc_log_activity builds it
-- server-side, which is right -- it used to be built in the browser, and
-- tamper-evidence produced by the party you are guarding against is not
-- evidence.
--
-- But the hash is taken over four fields:
--
--     substr(md5(v_prev || p_type || coalesce(p_description,'')
--                || coalesce(p_amount::text,'') || v_ts), 1, 8)
--
-- type, description, amount, timestamp. Not user_id. Not user_name. Not
-- ticker. Those are exactly the fields that say WHO an entry is about, and
-- they are the ones worth altering.
--
-- Measured against this database's own function body running locally. Two
-- entries written normally, chain verifying. Then:
--
--     update jex_activity set user_name = 'Somebody Else', user_id = 'u_s3';
--
--     entry            chain still verifies?
--     Somebody Else    true
--
-- Every row's attribution rewritten, and the chain still says it is intact.
--
-- ── The fix ──
--
-- The hash covers user_id, user_name and ticker as well. Nothing else changes:
-- same algorithm, same 8 characters, same column.
--
-- ── What this deliberately does NOT fix ──
--
-- Forging an entry at WRITE time. rpc_log_activity takes p_user_id and
-- p_user_name as parameters, so any signed-in student can write an entry
-- attributed to anybody:
--
--     rpc_log_activity('dividend','Paid a $50,000 dividend','ACME',
--                      'u_s1','Student 1', 50000)
--       -> accepted, attributed to Student 1
--
-- That is not an oversight, it is the documented design -- app.js says so:
-- "user_id and user_name stay parameters because the log records who an entry
-- is ABOUT, which is often not the caller (an admin approving a student's IPO
-- logs it against the student)." Closing it means the server deriving the
-- subject of every activity type itself, which is a real piece of work and not
-- something to do three days before a class.
--
-- So be clear about what the chain is worth after this: it proves the log has
-- not been edited SINCE it was written. It does not prove each entry was
-- honest when written. Those are different claims and only the first one is
-- true here.
--
-- ── One thing to know before running it ──
--
-- Entries written after this use a different hash input from entries written
-- before it, so a verifier walking the whole table would see a discontinuity
-- at the changeover. Nothing verifies the chain today -- app.js only displays
-- the last four characters in the admin table -- which is exactly why now is
-- the cheapest moment to widen it. If you would rather keep one consistent
-- format across the term, not running this is a defensible choice; the chain
-- just keeps its current blind spot.
--
-- Safe to run twice. Aborts and changes nothing if the anchor is not found
-- exactly once.
-- ============================================================

do $mig$
declare
  r record;
  v_nl text;
  v_n  int;
begin
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_log_activity';
  if r is null then
    raise exception 'ABORT: rpc_log_activity not found. Nothing changed.';
  end if;

  if position('coalesce(p_user_id, '''') || coalesce(p_user_name, '''')' in r.prosrc) > 0 then
    raise notice 'rpc_log_activity already hashes the attribution -- skipped.';
    return;
  end if;

  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_n := (length(r.prosrc) - length(replace(r.prosrc,
            'substr(md5(v_prev || p_type || coalesce(p_description, '''') || coalesce(p_amount::text, '''') || v_ts), 1, 8)', '')))
         / length('substr(md5(v_prev || p_type || coalesce(p_description, '''') || coalesce(p_amount::text, '''') || v_ts), 1, 8)');
  if v_n <> 1 then
    raise exception 'ABORT: expected the hash expression exactly once, found %. Nothing changed.', v_n;
  end if;

  execute replace(r.def, r.prosrc, replace(r.prosrc,
    'substr(md5(v_prev || p_type || coalesce(p_description, '''') || coalesce(p_amount::text, '''') || v_ts), 1, 8)',
    '-- user_id, user_name and ticker are in here now. Without them the' || v_nl ||
    '    -- chain covered what happened but not who it happened to, so' || v_nl ||
    '    -- rewriting the attribution on every row left every hash still' || v_nl ||
    '    -- verifying. Measured: `update jex_activity set user_name =' || v_nl ||
    '    -- ''Somebody Else''` and the chain reported itself intact.' || v_nl ||
    '    substr(md5(v_prev || p_type || coalesce(p_description, '''')' || v_nl ||
    '               || coalesce(p_amount::text, '''') || v_ts' || v_nl ||
    '               || coalesce(p_user_id, '''') || coalesce(p_user_name, '''')' || v_nl ||
    '               || coalesce(p_ticker, '''')), 1, 8)'));

  raise notice 'rpc_log_activity: the chain now covers who each entry is about.';
end
$mig$;

-- ── verification ──
--
-- hashes_attribution   the fix is in
-- chain_check          for every existing entry, whether its stored hash
--                      matches a recompute under the OLD formula. These were
--                      all written under the old one, so they should all say
--                      true -- this is a baseline, not a problem. Entries
--                      written from now on will not match it, by design.
-- chain_breaks_now     how many existing entries fail that old-formula check.
--                      Anything other than 0 means a row was edited after it
--                      was written, which is what the chain is for.
-- entries              how many rows are in the log, and the oldest and newest
select
  (select position('coalesce(p_user_id, '''') || coalesce(p_user_name, '''')' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_log_activity')             as hashes_attribution,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'when', a.ts, 'type', a.type, 'about', a.user_name,
            'verifies_under_old_formula',
              a.entry_hash = substr(md5(coalesce(a.prev_hash,'') || coalesce(a.type,'')
                                        || coalesce(a.description,'')
                                        || coalesce(a.amount::text,'')
                                        || coalesce(a.ts,'')), 1, 8))
          order by a.created_at desc), '[]'::jsonb)
     from (select * from jex_activity order by created_at desc limit 20) a)    as chain_check,

  (select count(*) from jex_activity a
    where a.entry_hash is not null
      and a.entry_hash <> substr(md5(coalesce(a.prev_hash,'') || coalesce(a.type,'')
                                     || coalesce(a.description,'')
                                     || coalesce(a.amount::text,'')
                                     || coalesce(a.ts,'')), 1, 8))             as chain_breaks_now,

  (select jsonb_build_object(
            'rows', count(*),
            'oldest', min(created_at),
            'newest', max(created_at)) from jex_activity)                      as entries;
