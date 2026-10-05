-- ============================================================
-- check_server_events.sql
--
-- READ ONLY. Changes nothing.
--
-- Run after a few real actions (an announcement, a balance adjustment, a
-- trade that fills a limit order) to confirm the server-recorded events are
-- live and nothing is recorded twice.
--
-- server_entries_24h   entries the server wrote in the last day, by type.
--                      Should not be empty once something has happened.
-- server_notices_24h   notifications the server sent in the last day, by type
-- written_twice        an event logged by the server AND by a browser within
--                      a minute of each other. Should be empty. A row here
--                      means an open tab predates the page update -- reload
--                      it -- or a call site was missed.
-- chain_breaks_24h     entries whose "previous" link does not point at the
--                      entry before them. Should be 0.
-- page_still_writing   entries written by browsers in the last day, by type.
--                      Should be empty: since batch 3 the page writes no
--                      entries, and after batch 4 it cannot.
-- ============================================================
select jsonb_pretty(jsonb_build_object(

  'server_entries_24h', (
    select coalesce(jsonb_object_agg(type, n), '{}'::jsonb)
      from (select type, count(*) as n from jex_activity
             where logged_by = 'server' and created_at > now() - interval '1 day'
             group by type) x),

  'server_notices_24h', (
    select coalesce(jsonb_object_agg(type, n), '{}'::jsonb)
      from (select type, count(*) as n from jex_notifications
             where sent_by = 'server' and created_at > now() - interval '1 day'
             group by type) x),

  'written_twice', (
    select coalesce(jsonb_agg(jsonb_build_object('type', s.type, 'at', s.ts, 'also_written_by', b.logged_by)), '[]'::jsonb)
      from jex_activity s
      join jex_activity b
        on b.type = s.type and b.description = s.description
       and b.logged_by is distinct from 'server'
       and abs(extract(epoch from (b.created_at - s.created_at))) < 60
     where s.logged_by = 'server' and s.created_at > now() - interval '1 day'),

  'chain_breaks_24h', (
    select count(*) from (
      select created_at, prev_hash, lag(coalesce(entry_hash, id)) over (order by created_at) as before
        from jex_activity where type <> 'snapshot') c
     where c.created_at > now() - interval '1 day'
       and c.before is not null and c.prev_hash is distinct from c.before),

  'page_still_writing', (
    select coalesce(jsonb_object_agg(type, n), '{}'::jsonb)
      from (select type, count(*) as n from jex_activity
             where logged_by is not null and logged_by <> 'server'
               and created_at > now() - interval '1 day'
             group by type) x)

)) as server_events_check;
