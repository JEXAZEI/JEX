-- ============================================================
-- bankruptcy_rounding.sql
--
-- WRITES. Patches one function. Aborts and changes nothing on any mismatch.
-- Re-running is a no-op.
--
-- ── What is wrong ──
--
-- About one bankruptcy settlement in four fails outright, with a raw Postgres
-- constraint error, and the company stays listed.
--
-- rpc_review_delisting pays shareholders pro-rata when a company cannot cover
-- what it owes:
--
--   v_ratio := least(1, owner_cash / owed);          -- exact, many decimals
--   v_amt   := round(qty * price * v_ratio, 2);      -- per holder, to the cent
--   ...
--   update jex_users set cash = round(cash - v_paid, 2) where id = owner;
--
-- The ratio is exact but every payout is rounded independently, so the rounded
-- sum can come out ABOVE owner_cash -- by up to half a cent per holder. The
-- company is then charged more than it has, jex_users.cash goes below zero,
-- chk_users_cash_nonneg fires, and the whole settlement rolls back:
--
--   new row for relation "jex_users" violates check constraint
--   "chk_users_cash_nonneg"
--
-- Measured on a copy of this database, 60 randomized bankruptcies with 15
-- holders each -- a real class:
--
--   settled  43
--   FAILED   17        (28%, the first at owner cash $57,796.49 against
--                       $89,505.22 owed)
--
-- and a separate 20,000-case simulation of the arithmetic alone put the
-- overshoot rate at 23.8%, worst case 5 cents over.
--
-- Nothing partial happens -- the transaction rolls back cleanly -- so no money
-- is lost. What the President sees is a database error on a button that should
-- have worked, with no way to tell that trying again with a settlement price a
-- cent lower would fix it.
--
-- ── The fix ──
--
-- The payout carries a budget: the cash the company actually has. Each holder
-- is paid their rounded share or whatever is left, whichever is smaller, so
-- the total can never exceed what is being spent. The few cents that rounding
-- cannot place land on whoever is last in id order, and are already reported
-- in `shortfall`.
--
-- Going private is unaffected. That path already refuses unless the company
-- can cover the whole buyout, so the budget never binds -- it is only ever the
-- pro-rata bankruptcy case that runs into it.
--
-- ── Method ──
--
-- Executable anchors, each asserted to occur the exact number of times
-- expected -- the payout line deliberately appears TWICE, once for students
-- and once for funds, and both need the same change. Rebuilt through
-- pg_get_functiondef so the signature, volatility, SECURITY DEFINER and any
-- SET clause return exactly as they are. The line ending is detected at the
-- anchor rather than assumed.
-- ============================================================

do $mig$
declare
  r record;
  v_new text; v_n int; v_nl text; v_a text;
begin
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_review_delisting';
  if r.proname is null then raise exception 'ABORT: rpc_review_delisting not found.'; end if;

  if position('v_budget' in r.prosrc) > 0 then
    raise notice '  rpc_review_delisting already caps the payout at the cash on hand -- skipped';
    return;
  end if;

  -- The payout line, in BOTH loops.
  v_a := '    v_amt := round(v_h.qty * v_price * v_ratio, 2);';
  v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
  if v_n <> 2 then
    raise exception 'ABORT: payout line found % times, expected 2 (students and funds). Nothing changed.', v_n;
  end if;

  v_nl := case when position(v_a || chr(13) || chr(10) in r.prosrc) > 0
               then chr(13) || chr(10) else chr(10) end;

  v_new := replace(r.prosrc, v_a,
    '    -- Never more than is actually left. See v_budget above.' || v_nl ||
    '    v_amt := least(round(v_h.qty * v_price * v_ratio, 2), v_budget);' || v_nl ||
    '    v_budget := round(v_budget - v_amt, 2);');

  -- The budget variable.
  v_a := '  v_payouts jsonb := ''[]''::jsonb;';
  v_n := (length(v_new) - length(replace(v_new, v_a, ''))) / length(v_a);
  if v_n <> 1 then raise exception 'ABORT: declare anchor found % times, expected 1.', v_n; end if;
  v_new := replace(v_new, v_a, v_a || v_nl || '  v_budget numeric := 0;');

  -- Set it from the cash that is actually being spent, right where the
  -- pro-rata ratio is worked out. The whole block is the anchor so the fix
  -- lands after its `end if;` rather than inside the branch.
  v_a := '  if v_owed > 0 then' || v_nl ||
         '    v_ratio := least(1::numeric, v_owner_cash / v_owed);' || v_nl ||
         '  end if;';
  v_n := (length(v_new) - length(replace(v_new, v_a, ''))) / length(v_a);
  if v_n <> 1 then raise exception 'ABORT: ratio anchor found % times, expected 1.', v_n; end if;
  v_new := replace(v_new, v_a,
    v_a || v_nl ||
    '' || v_nl ||
    '  -- The ratio above is exact; each payout below is rounded to the cent on' || v_nl ||
    '  -- its own, so the rounded TOTAL can land above the cash the company has --' || v_nl ||
    '  -- up to half a cent per holder. `cash = cash - v_paid` then drives the' || v_nl ||
    '  -- owner below zero, chk_users_cash_nonneg fires, and the entire' || v_nl ||
    '  -- settlement rolls back with a raw constraint error on a button that' || v_nl ||
    '  -- should have worked. Measured: 17 of 60 randomized bankruptcies with 15' || v_nl ||
    '  -- holders failed exactly that way.' || v_nl ||
    '  --' || v_nl ||
    '  -- So the payout carries a budget. Each holder gets their rounded share or' || v_nl ||
    '  -- whatever is left, whichever is smaller. The stray cents rounding cannot' || v_nl ||
    '  -- place stay with the company and are already reported in `shortfall`.' || v_nl ||
    '  -- Going private never reaches this -- it refuses unless the whole buyout' || v_nl ||
    '  -- is covered -- so the budget only ever binds on a pro-rata bankruptcy.' || v_nl ||
    '  v_budget := v_owner_cash;');

  execute replace(r.def, r.prosrc, v_new);
  raise notice '  rpc_review_delisting: a bankruptcy settlement can no longer overdraw the company by a rounding cent';
end
$mig$;

-- ── Verification ──
--
-- The first three must be true.
--
-- payout_has_a_budget    the settlement tracks what is left to spend...
-- budget_starts_at_cash  ...starting from the company's actual cash...
-- both_loops_capped      ...and both the student payout and the fund payout
--                        respect it (the line appears twice and both matter).
--
-- pending_bankruptcies lists every delisting waiting on a decision, with what
-- it would cost at the proposed price against what the company holds. Anything
-- where `cash_covers_it` is false is a pro-rata settlement -- the case that
-- used to fail about a quarter of the time and now will not.
select
  (select prosrc like '%v_budget := round(v_budget - v_amt, 2);%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_review_delisting')            as payout_has_a_budget,
  (select prosrc like '%v_budget := v_owner_cash;%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_review_delisting')            as budget_starts_at_cash,
  (select (length(prosrc) - length(replace(prosrc, 'least(round(v_h.qty * v_price * v_ratio, 2), v_budget)', '')))
          / length('least(round(v_h.qty * v_price * v_ratio, 2), v_budget)') = 2
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_review_delisting')            as both_loops_capped,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', a.ticker, 'kind', a.kind, 'proposed_price', a.proposed_price,
            'outside_shares', q.shares, 'would_cost', round(q.shares * coalesce(a.proposed_price,0), 2),
            'company_has', q.owner_cash,
            'cash_covers_it', q.owner_cash >= round(q.shares * coalesce(a.proposed_price,0), 2))
          order by a.ticker), '[]'::jsonb)
     from jex_delist_applications a
     join jex_companies c on c.ticker = a.ticker
     cross join lateral (
       select coalesce((select cash from jex_users where id = c.owner_id), 0) as owner_cash,
              coalesce((select sum((u.holdings->>a.ticker)::numeric) from jex_users u
                         where coalesce(u.holdings,'{}'::jsonb) ? a.ticker and u.id <> c.owner_id), 0)
            + coalesce((select sum((f.holdings->>a.ticker)::numeric) from jex_funds f
                         where coalesce(f.holdings,'{}'::jsonb) ? a.ticker), 0) as shares
     ) q
    where a.status = 'pending')                                              as pending_bankruptcies;
