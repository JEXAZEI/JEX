-- Which tables survive a full reset?
--
-- Run this after adding ANY new jex_ table. rpc_admin_full_reset is what the
-- Chairman runs between class periods, and it names its tables one DELETE at a
-- time -- so a table added later is silently kept unless somebody remembers to
-- teach the reset about it. Nothing in the codebase enforces that.
--
-- This is how jex_delist_applications came to survive a reset: it was created
-- two days after the reset function, the client cleared its copy in memory so
-- the screen looked right, and the row came back on the next page load -- a
-- pending delisting review for a company the reset had just deleted.
--
-- The list below is derived from the FUNCTION SOURCE, never from a comment. The
-- comment in app.js describing this had already drifted to 28 tables while the
-- function named 35, which is exactly why it was not noticed.
--
-- Expected survivors, all deliberate:
--
--   jex_email_secrets     configuration; wiping it breaks email
--   jex_auth_attempts     login throttling; clearing it frees anyone mid-lockout
--   jex_snapshots         arguably the point -- last term's snapshot should keep
--   jex_earnings_targets  no references in app.js
--   jex_founders          no references in app.js
--
-- Anything ELSE appearing here is a table someone forgot to add.
with src as (
  select p.prosrc as body from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='rpc_admin_full_reset'
),
named as (
  select distinct m[1] as tbl from src, regexp_matches(src.body,'(jex_[a-z_]+)','g') m
),
existing as (
  select c.relname as tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like 'jex\_%'
)
select
  (select count(*) from existing)                                          as tables_total,
  (select count(*) from named where tbl in (select tbl from existing))     as tables_cleared,
  (select coalesce(jsonb_agg(tbl order by tbl), '[]'::jsonb)
     from existing where tbl not in (select tbl from named))               as survives_a_reset;
