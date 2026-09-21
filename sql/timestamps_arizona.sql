-- ============================================================
-- timestamps_arizona.sql
--
-- Times shown on the site are seven hours ahead. They are UTC.
--
-- Every `ts` column in this schema is TEXT -- a pre-formatted clock time
-- written at insert. Most functions write it correctly:
--
--     to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI:SS AM')
--
-- and some write it like this:
--
--     to_char(now(), 'HH12:MI:SS AM')
--
-- The second form has no zone conversion at all. to_char() on a timestamptz
-- renders it in the SERVER's TimeZone setting, which on Supabase is UTC. So a
-- snapshot saved at 2:14 PM in Tucson is stored, and displayed, as 09:14 PM.
--
-- That is the Saved snapshots list reading 09:03 PM, 10:26 PM and 07:01 AM
-- while the clock says 2:14 PM. Nothing is wrong with the data -- created_at
-- is a real timestamptz and is correct -- it is only the text column anyone
-- actually looks at.
--
-- Arizona does not observe daylight saving, so 'America/Phoenix' is a fixed
-- UTC-7 and this does not drift twice a year.
--
-- ── Why this file rewrites functions it was not told about ──
--
-- Every other migration in this directory names its target and refuses to
-- guess. This one cannot: the same mistake is spread across functions I have
-- no copy of, and fixing the eight I can see would leave the rest wrong and
-- hard to find again. So it works from the pattern instead --
--
--     to_char(  now()  ,     ->    to_char(now() at time zone 'America/Phoenix',
--
-- -- and it is deliberately narrow. It matches `now()` followed by nothing but
-- whitespace and a comma, so it cannot touch:
--
--     to_char(now() at time zone 'America/Phoenix', ...)   already correct
--     to_char(now() at time zone 'utc', ...)               deliberately UTC
--     to_char((now() + interval '24 hours') at time zone ...)
--     now() used anywhere that is not a to_char first argument
--
-- It reports every function it changed, and every one it left alone, so the
-- blast radius is visible rather than asserted.
--
-- Safe to run twice: the second run finds nothing matching and says so.
-- ============================================================

do $mig$
declare
  r record;
  v_src text;
  v_changed text[] := array[]::text[];
  v_pattern constant text := 'to_char\(\s*now\(\)\s*,';
  v_replace constant text := 'to_char(now() at time zone ''America/Phoenix'',';
begin
  for r in
    select p.oid, p.prosrc, pg_get_functiondef(p.oid) as def, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and p.prosrc ~ v_pattern
     order by p.proname
  loop
    v_src := regexp_replace(r.prosrc, v_pattern, v_replace, 'g');
    if v_src = r.prosrc then
      continue;
    end if;
    -- Rebuilt through pg_get_functiondef, so the signature, volatility,
    -- SECURITY DEFINER and any SET search_path survive exactly as they were.
    execute replace(r.def, r.prosrc, v_src);
    v_changed := v_changed || r.proname;
  end loop;

  if array_length(v_changed, 1) is null then
    raise notice 'No function writes an unzoned timestamp -- nothing to do.';
  else
    raise notice 'Now writing Arizona time (% functions): %',
      array_length(v_changed, 1), array_to_string(v_changed, ', ');
  end if;
end
$mig$;

-- ── verification ──
--
-- still_unzoned        functions still writing a bare to_char(now(), ...).
--                      Should be empty.
-- deliberately_utc     functions that convert to UTC on purpose -- the ISO
--                      timestamps in price_history and closes_at, which are
--                      parsed as instants rather than read as clock times.
--                      These are correct and were not touched.
-- now_in_each_zone     what the server thinks the time is, both ways, so the
--                      seven hours is visible rather than argued about.
-- newest_text_stamps   the most recent ts written into each table that has
--                      one, next to its real created_at rendered in Arizona.
--                      Rows written BEFORE this ran still hold the old UTC
--                      text -- this migration does not rewrite history, it
--                      stops it being made. A row whose two columns disagree
--                      is a row from before.
select
  (select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.prosrc ~ 'to_char\(\s*now\(\)\s*,')                               as still_unzoned,

  (select coalesce(jsonb_agg(distinct p.proname order by p.proname), '[]'::jsonb)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.prosrc like '%at time zone ''utc''%')                             as deliberately_utc,

  jsonb_build_object(
    'server_zone', current_setting('TimeZone'),
    'utc_now', to_char(now() at time zone 'utc', 'FMHH12:MI:SS AM'),
    'arizona_now', to_char(now() at time zone 'America/Phoenix', 'FMHH12:MI:SS AM'))
                                                                              as now_in_each_zone,

  (select jsonb_object_agg(t.tbl, t.row) from (
     select 'jex_snapshots' as tbl, jsonb_build_object(
              'stored_ts', (select ts from jex_snapshots order by created_at desc limit 1),
              'should_read', (select to_char(created_at at time zone 'America/Phoenix', 'FMHH12:MI:SS AM')
                                from jex_snapshots order by created_at desc limit 1)) as row
     union all
     select 'jex_votes', jsonb_build_object(
              'stored_ts', (select ts from jex_votes order by created_at desc limit 1),
              'should_read', (select to_char(created_at at time zone 'America/Phoenix', 'FMHH12:MI:SS AM')
                                from jex_votes order by created_at desc limit 1))
     union all
     select 'jex_news', jsonb_build_object(
              'stored_ts', (select ts from jex_news order by created_at desc limit 1),
              'should_read', (select to_char(created_at at time zone 'America/Phoenix', 'FMHH12:MI:SS AM')
                                from jex_news order by created_at desc limit 1))
     union all
     select 'jex_trades', jsonb_build_object(
              'stored_ts', (select ts from jex_trades order by created_at desc limit 1),
              'should_read', (select to_char(created_at at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI:SS AM')
                                from jex_trades order by created_at desc limit 1))
   ) t)                                                                       as newest_text_stamps;
