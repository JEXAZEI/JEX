-- ============================================================
-- mark_past_dilution.sql
--
-- CHANGES DATA. Adds one key to one price point. Moves no money, no shares,
-- no price.
--
-- dilution_and_restore_opens.sql made every FUTURE dilution record its step on
-- the price point it appends, so the index chart can tell a dilution from a
-- crash. A dilution approved before that has no mark, and the chart still
-- draws it.
--
-- There is one in production: AZEI's 10% dilution on Sep 3. AZEI's
-- index_base_adjust is 0.9091 and none of its 44 points are marked, so the
-- browser divides every point from BEFORE Sep 3 by a base 9% too small. JXI's
-- 1M and Max charts show a ~9% drop on Sep 3 that never happened. The live
-- level and the 1D view are unaffected -- this is history only.
--
-- ── How the point is found, and when it is not touched ──
--
-- A dilution multiplies the price by the same factor it multiplies the base
-- by. So the dilution point is the one whose step from the point before it
-- matches index_base_adjust -- to within cent rounding (0.2%) -- at or after
-- the moment the dilution was applied for.
--
-- It is marked only when EXACTLY ONE point matches. None (the adjust came from
-- two dilutions, or the history was replaced) or several (a real trade happened
-- to move by the same amount) and the company is skipped and reported, and
-- nothing is guessed.
--
-- ── Snapshots too ──
--
-- A restore puts back a snapshot's price_history. Every snapshot saved after
-- Sep 3 holds the same unmarked point, and restoring one would bring the
-- phantom drop straight back. The same rule is applied to each company inside
-- each snapshot.
--
-- Safe to run twice: a history that already carries a mark is left alone.
-- ============================================================

create or replace function pg_temp.mark_dilution(p_hist jsonb, p_adjust numeric, p_since timestamptz)
returns jsonb
language sql
immutable
as $f$
  with pts as (
    select i, e,
           (e->>'p')::numeric as p,
           lag((e->>'p')::numeric) over (order by i) as prev_p
      from jsonb_array_elements(p_hist) with ordinality as h(e, i)
  ), hits as (
    select i, prev_p, p, e->>'t' as t
      from pts
     where prev_p > 0 and p > 0
       and e->>'t' ~ '^\d{4}-\d{2}-\d{2}T'
       and (e->>'t')::timestamptz >= p_since
       and abs((p / prev_p) / p_adjust - 1) < 0.002
  )
  select case
    when p_adjust is null or p_adjust = 1 then jsonb_build_object('skip', 'no adjustment')
    when exists (select 1 from jsonb_array_elements(p_hist) e where e ? 'a')
      then jsonb_build_object('skip', 'already marked')
    when (select count(*) from hits) <> 1
      then jsonb_build_object('skip', format('%s matching points, need exactly 1', (select count(*) from hits)),
                              'candidates', (select coalesce(jsonb_agg(jsonb_build_object('t', t, 'from', prev_p, 'to', p)), '[]'::jsonb) from hits))
    else (select jsonb_build_object(
                   'history', jsonb_set(p_hist, array[(i - 1)::text, 'a'], to_jsonb(p_adjust)),
                   'marked', jsonb_build_object('t', t, 'from', prev_p, 'to', p, 'a', p_adjust))
            from hits)
  end;
$f$;

do $mark$
declare
  v_co record;
  v_res jsonb;
  v_snap record;
  v_k int;
  v_el jsonb;
  v_since timestamptz;
  v_data jsonb;
  v_snaps_marked int := 0;
begin
  -- ── live companies ──
  for v_co in
    select c.ticker, c.price_history, c.index_base_adjust,
           (select min(d.created_at) from jex_dilution_applications d
             where d.ticker = c.ticker and d.status = 'approved') as since
      from jex_companies c
     where not coalesce(c.is_index_fund, false)
       and coalesce(c.index_base_adjust, 1) <> 1
  loop
    if v_co.since is null then
      raise notice '%: base adjusted but no approved dilution on record -- skipped.', v_co.ticker;
      continue;
    end if;
    v_res := pg_temp.mark_dilution(coalesce(v_co.price_history, '[]'::jsonb), v_co.index_base_adjust, v_co.since);
    if v_res ? 'history' then
      update jex_companies set price_history = v_res->'history' where ticker = v_co.ticker;
      raise notice '%: marked %', v_co.ticker, v_res->'marked';
    else
      raise notice '%: %', v_co.ticker, v_res;
    end if;
  end loop;

  -- ── the same point inside saved snapshots ──
  for v_snap in select id, data from jex_snapshots where data ? 'companies' loop
    v_data := v_snap.data;
    for v_k in 0 .. jsonb_array_length(coalesce(v_data->'companies', '[]'::jsonb)) - 1 loop
      v_el := v_data->'companies'->v_k;
      continue when coalesce((v_el->>'index_base_adjust')::numeric, 1) = 1;
      select min(d.created_at) into v_since from jex_dilution_applications d
       where d.ticker = v_el->>'ticker' and d.status = 'approved';
      continue when v_since is null;
      v_res := pg_temp.mark_dilution(coalesce(v_el->'price_history', '[]'::jsonb),
                                     (v_el->>'index_base_adjust')::numeric, v_since);
      if v_res ? 'history' then
        v_data := jsonb_set(v_data, array['companies', v_k::text, 'price_history'], v_res->'history');
      end if;
    end loop;
    if v_data is distinct from v_snap.data then
      update jex_snapshots set data = v_data where id = v_snap.id;
      v_snaps_marked := v_snaps_marked + 1;
    end if;
  end loop;
  raise notice 'Snapshots updated: %', v_snaps_marked;
end
$mark$;

-- ── verification ──
--
-- companies        each company with an adjusted base: the point now marked,
--                  with the step it records. `a` should equal the adjust,
--                  and from -> to should be a ~9% step on Sep 3's date.
-- snapshots        each snapshot, and whether its copy of the history is
--                  marked. Snapshots from before Sep 3 have nothing to mark.
-- share_register   the restore on Sep 21 rolled back shares, holdings and the
--                  unsold pool together. `unaccounted` must be 0 everywhere;
--                  anything else is shares that exist nowhere, or twice.
select
  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker, 'index_base_adjust', c.index_base_adjust,
            'marked_points', (select coalesce(jsonb_agg(jsonb_build_object(
                                       't', e->>'t', 'p', e->'p', 'a', e->'a')), '[]'::jsonb)
                                from jsonb_array_elements(coalesce(c.price_history, '[]'::jsonb)) e
                               where e ? 'a'))
          order by c.ticker), '[]'::jsonb)
     from jex_companies c
    where not coalesce(c.is_index_fund, false)
      and coalesce(c.index_base_adjust, 1) <> 1)                               as companies,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'label', s.label,
            'saved', to_char(s.created_at at time zone 'America/Phoenix', 'Mon FMDD FMHH12:MI AM'),
            'adjusted_companies', (select count(*) from jsonb_array_elements(s.data->'companies') c
                                    where coalesce((c->>'index_base_adjust')::numeric, 1) <> 1),
            'marked', (select count(*) from jsonb_array_elements(s.data->'companies') c,
                              jsonb_array_elements(coalesce(c->'price_history', '[]'::jsonb)) e
                        where e ? 'a'))
          order by s.created_at desc), '[]'::jsonb)
     from jex_snapshots s)                                                     as snapshots,

  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', c.ticker, 'issued', c.shares, 'unsold', c.shares_avail,
            'held_by_users', h.u, 'held_by_funds', h.f,
            'unaccounted', c.shares - c.shares_avail - h.u - h.f)
          order by c.ticker), '[]'::jsonb)
     from jex_companies c
     cross join lateral (
       select coalesce((select sum((u.holdings->>c.ticker)::numeric) from jex_users u
                         where coalesce(u.holdings,'{}'::jsonb) ? c.ticker), 0) as u,
              coalesce((select sum((f.holdings->>c.ticker)::numeric) from jex_funds f
                         where coalesce(f.holdings,'{}'::jsonb) ? c.ticker), 0) as f) h
    where c.status = 'listed' and not coalesce(c.is_index_fund, false))        as share_register;
