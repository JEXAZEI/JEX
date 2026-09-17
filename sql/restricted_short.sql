-- ============================================================
-- restricted_short.sql
--
-- A restricted share class could still be SHORTED by anyone.
--
-- `record_is_not_null.sql` fixed four places where a row-found test was
-- written `if v_meta is not null`. In PL/pgSQL that expression is true only
-- when EVERY field of the record is non-null, so any share-class row with a
-- null whitelist, owner_id or created_at read as "no row" and the whole
-- restriction check was skipped.
--
-- That migration covered rpc_trade_buy, rpc_place_limit_order, rpc_fund_buy
-- and rpc_fund_short. It MISSED rpc_trade_short. I found the four by reading
-- and stopped; the fifth turned up only when the live function bodies were
-- dumped and scanned mechanically.
--
-- Measured, against this database's own function bodies running locally:
-- a restricted class whose access is by officer role with no explicit
-- whitelist (whitelist is null, which is the ordinary way to set one up).
--
--   a plain student BUYS it          refused, "you are not on the whitelist"
--   the same student LIMIT-buys it   refused, same message
--   the same student SHORTS it       FILLED -- 5 units, collateral $44.93
--
-- Shorting is the more dangerous of the two: it does not need the shares to
-- be for sale, it moves the price DOWN, and it is the position a student
-- holds against a class they were never allowed to touch.
--
-- The fix is one word. `ticker` is NOT NULL on jex_share_classes, so
-- `v_meta.ticker is not null` is true exactly when a row was found, which is
-- what the test always meant.
--
-- There are no restricted classes on this exchange right now, so nothing is
-- currently exposed -- the verification below confirms that. This closes the
-- hole before the first one is created.
--
-- Safe to run twice: a second run reports "already fixed -- skipped".
-- Aborts and changes nothing if the anchor is not found exactly once.
-- ============================================================

do $mig$
declare
  r record;
  v_new text;
  v_old text;
  v_nl  text;
  v_hits int;
begin
  select p.oid, p.prosrc as prosrc, pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_trade_short';

  if r is null then
    raise exception 'ABORT: rpc_trade_short not found. Nothing changed.';
  end if;

  -- Already applied? Match on the EXECUTABLE text this migration inserts,
  -- never on a comment -- a comment gets rewrapped and the check silently
  -- stops firing, which is how an earlier migration in this directory managed
  -- to apply itself twice.
  if position('if v_meta.ticker is not null and coalesce(v_meta.restricted,false) then' in r.prosrc) > 0 then
    raise notice 'rpc_trade_short already tests v_meta.ticker -- skipped.';
    return;
  end if;

  -- Bodies in this database are a mix of CRLF and LF. Detect which this one
  -- uses rather than assuming.
  v_nl := case when position(chr(13) in r.prosrc) > 0 then chr(13) || chr(10) else chr(10) end;

  v_old := 'if v_meta is not null and coalesce(v_meta.restricted,false) then';

  v_hits := (length(r.prosrc) - length(replace(r.prosrc, v_old, ''))) / length(v_old);
  if v_hits <> 1 then
    raise exception 'ABORT: expected the guard exactly once in rpc_trade_short, found %. Nothing changed.', v_hits;
  end if;

  v_new :=
    '-- `record is not null` is true only when EVERY field is non-null, so this' || v_nl ||
    '  -- test was false for any class row with a null whitelist -- which is the' || v_nl ||
    '  -- ordinary shape of an officers-only class -- and the restriction check' || v_nl ||
    '  -- below was skipped entirely. Measured: a student refused a BUY of a' || v_nl ||
    '  -- restricted class shorted 5 units of it in the same breath. ticker is' || v_nl ||
    '  -- NOT NULL, so it is non-null exactly when a row was found.' || v_nl ||
    '  if v_meta.ticker is not null and coalesce(v_meta.restricted,false) then';

  execute replace(r.def, r.prosrc, replace(r.prosrc, v_old, v_new));

  raise notice 'rpc_trade_short: restriction guard now fires on a row being found.';
end
$mig$;

-- ── verification ──
--
-- guard_fixed            rpc_trade_short now tests v_meta.ticker
-- bare_record_tests_left  every function still using `<record> is not null`;
--                         should be empty
-- restricted_classes      the classes this protects; empty today
-- shortable_by            who could have shorted one before this ran
select
  (select position('if v_meta.ticker is not null and coalesce(v_meta.restricted,false) then' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rpc_trade_short')            as guard_fixed,

  -- Comment lines are stripped first: this same check once matched the
  -- explanatory comment a previous migration had inserted and reported a
  -- function as still broken when it was the note about the fix.
  (select coalesce(jsonb_agg(x.proname order by x.proname), '[]'::jsonb) from (
     select distinct p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace,
       lateral (select string_agg(l, chr(10)) as code
                  from regexp_split_to_table(replace(p.prosrc, chr(13), ''), chr(10)) l
                 where l !~ '^[[:space:]]*--') c
      where n.nspname = 'public' and p.prokind = 'f'
        and c.code ~* '(^|[^.[:alnum:]_])v_[a-z0-9_]+[[:space:]]+is[[:space:]]+not[[:space:]]+null[[:space:]]+and[[:space:]]+coalesce'
   ) x)                                                                      as bare_record_tests_left,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', sc.ticker, 'whitelist', sc.whitelist) order by sc.ticker), '[]'::jsonb)
     from jex_share_classes sc where coalesce(sc.restricted, false))         as restricted_classes,

  (select count(*) from jex_users u
    where coalesce(u.role,'') not in ('chairman','president','secretary','treasurer','compliance_officer'))
                                                                             as students_the_guard_now_covers;
