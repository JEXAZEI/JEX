-- ============================================================
-- dividend_approval_total.sql
--
-- WRITES. Patches one function. Aborts and changes nothing on any mismatch.
-- Re-running is a no-op.
--
-- ── What is wrong ──
--
-- The number the Treasurer is asked to approve is not the number the company
-- pays.
--
-- rpc_pay_dividend pays three groups: direct student holders, the index
-- basket's pass-through to whoever holds index units, and the student-run
-- funds in jex_funds -- and it multiplies every share-class holding by that
-- class's conversion_ratio, because one Class B share is worth conversion_ratio
-- of the parent.
--
-- rpc_request_dividend_approval, which fills in the `total` on the approval
-- the Treasurer signs, counts only the first group, at face value, with no
-- ratio.
--
-- Measured on a copy of this database. Acme, a $1.00 dividend, one student
-- holding 50 ACME and 20 ACME.B at a 5:1 ratio, another holding 20 ACME, and
-- a student-run fund holding 40 ACME:
--
--   rpc_request_dividend_approval  ->  total  $90.00     <- what is signed off
--   rpc_pay_dividend               ->  total $210.00     <- what leaves
--
-- 2.33 times. The Class B holding counted as 20 shares instead of 100, and the
-- fund's 40 shares were not counted at all.
--
-- This does not let a dividend dodge the approval threshold -- rpc_pay_dividend
-- recomputes the real total itself and refuses anything at or above the
-- threshold without an approval id. What it does is present the Treasurer with
-- a figure that is too small, on the one screen whose whole purpose is to put
-- a number in front of them before the company's cash moves.
--
-- ── The fix ──
--
-- The approval's total is computed the same way rpc_pay_dividend computes what
-- it spends: the same three groups, the same conversion ratio, the same
-- per-holder rounding. Nothing else about the function changes.
--
-- ── Method ──
--
-- Two executable anchors, each asserted to occur EXACTLY once, rebuilt through
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
   where n.nspname = 'public' and p.proname = 'rpc_request_dividend_approval';
  if r.proname is null then raise exception 'ABORT: rpc_request_dividend_approval not found.'; end if;

  -- An executable marker, not a phrase from a comment: a comment can be
  -- rewrapped across lines and then never matches, which is how this check
  -- silently stopped working the first time.
  if position('from jex_funds f where f.holdings ?| v_tickers' in r.prosrc) > 0 then
    raise notice '  rpc_request_dividend_approval already totals what will actually be paid -- skipped';
    return;
  end if;

  v_nl := case when position(chr(13) || chr(10) in r.prosrc) > 0
               then chr(13) || chr(10) else chr(10) end;

  -- the three extra variables
  v_a := '  v_uid text; v_name text; v_co record; v_tickers text[]; v_total numeric := 0; v_row jsonb;';
  v_n := (length(r.prosrc) - length(replace(r.prosrc, v_a, ''))) / length(v_a);
  if v_n <> 1 then raise exception 'ABORT: declare anchor found % times, expected 1. Nothing changed.', v_n; end if;
  v_new := replace(r.prosrc, v_a,
    v_a || v_nl || '  v_fund record; v_fund_shares numeric; v_eligible_units numeric;');

  -- the total itself
  v_a :=
    '  select coalesce(sum(round(sh.shares * p_per_share, 2)), 0) into v_total' || v_nl ||
    '  from (' || v_nl ||
    '    select coalesce((select sum((holdings->>t)::numeric) from unnest(v_tickers) t where holdings ? t), 0) as shares' || v_nl ||
    '    from jex_users where role = ''student'' and status = ''approved'' and holdings ?| v_tickers' || v_nl ||
    '  ) sh' || v_nl ||
    '  where sh.shares > 0;';
  v_n := (length(v_new) - length(replace(v_new, v_a, ''))) / length(v_a);
  if v_n <> 1 then raise exception 'ABORT: total anchor found % times, expected 1. Nothing changed.', v_n; end if;

  v_new := replace(v_new, v_a,
    '  -- The number the Treasurer is asked to approve has to be the number the' || v_nl ||
    '  -- company pays. rpc_pay_dividend pays three groups and applies each share' || v_nl ||
    '  -- class''s conversion_ratio; this counted the first group only, at face' || v_nl ||
    '  -- value. Measured: a $1.00 dividend with one 5:1 Class B holder and one' || v_nl ||
    '  -- student-run fund was presented as $90.00 and cost $210.00.' || v_nl ||
    '  --' || v_nl ||
    '  -- 1. direct student holders, each class at its conversion ratio.' || v_nl ||
    '  select coalesce(sum(round(sh.shares * p_per_share, 2)), 0) into v_total' || v_nl ||
    '  from (' || v_nl ||
    '    select coalesce((select sum((holdings->>t)::numeric * coalesce(sc.conversion_ratio, 1))' || v_nl ||
    '                       from unnest(v_tickers) t' || v_nl ||
    '                       left join jex_share_classes sc' || v_nl ||
    '                         on sc.ticker = t and sc.ticker <> sc.parent_ticker' || v_nl ||
    '                      where holdings ? t), 0) as shares' || v_nl ||
    '    from jex_users where role = ''student'' and status = ''approved'' and holdings ?| v_tickers' || v_nl ||
    '  ) sh' || v_nl ||
    '  where sh.shares > 0;' || v_nl ||
    '' || v_nl ||
    '  -- 2. the index basket''s pass-through, pro-rated over the units students' || v_nl ||
    '  --    actually hold, exactly as rpc_pay_dividend pro-rates it.' || v_nl ||
    '  for v_fund in select * from jex_companies where is_index_fund and fund_holdings ?| v_tickers' || v_nl ||
    '  loop' || v_nl ||
    '    v_fund_shares := coalesce((select sum((v_fund.fund_holdings->>t)::numeric * coalesce(sc.conversion_ratio, 1))' || v_nl ||
    '                                 from unnest(v_tickers) t' || v_nl ||
    '                                 left join jex_share_classes sc' || v_nl ||
    '                                   on sc.ticker = t and sc.ticker <> sc.parent_ticker' || v_nl ||
    '                                where v_fund.fund_holdings ? t), 0);' || v_nl ||
    '    select coalesce(sum((holdings->>v_fund.ticker)::numeric), 0) into v_eligible_units' || v_nl ||
    '      from jex_users' || v_nl ||
    '     where role = ''student'' and status = ''approved''' || v_nl ||
    '       and coalesce((holdings->>v_fund.ticker)::numeric, 0) > 0;' || v_nl ||
    '    if coalesce(v_fund.shares, 0) > 0 and v_eligible_units > 0 then' || v_nl ||
    '      v_total := v_total + round(v_fund_shares * p_per_share * (v_eligible_units / v_fund.shares), 2);' || v_nl ||
    '    end if;' || v_nl ||
    '  end loop;' || v_nl ||
    '' || v_nl ||
    '  -- 3. student-run funds, which hold real shares in jex_funds rather than' || v_nl ||
    '  --    in the table group 1 reads.' || v_nl ||
    '  select v_total + coalesce(sum(round(sf.shares * p_per_share, 2)), 0) into v_total' || v_nl ||
    '  from (' || v_nl ||
    '    select coalesce((select sum((f.holdings->>t)::numeric * coalesce(sc.conversion_ratio, 1))' || v_nl ||
    '                       from unnest(v_tickers) t' || v_nl ||
    '                       left join jex_share_classes sc' || v_nl ||
    '                         on sc.ticker = t and sc.ticker <> sc.parent_ticker' || v_nl ||
    '                      where f.holdings ? t), 0) as shares' || v_nl ||
    '    from jex_funds f where f.holdings ?| v_tickers' || v_nl ||
    '  ) sf' || v_nl ||
    '  where sf.shares > 0;');

  execute replace(r.def, r.prosrc, v_new);
  raise notice '  rpc_request_dividend_approval: the Treasurer now sees what the company will actually pay';
end
$mig$;

-- ── Verification ──
--
-- The first four must be true.
--
-- counts_conversion_ratio  a Class B share counts for what it converts to.
-- counts_the_index_basket  the index pass-through is in the total.
-- counts_student_funds     and so are the student-run funds.
-- payment_still_authoritative  rpc_pay_dividend still recomputes the real
--                          total itself and still refuses anything at or above
--                          the threshold without an approval -- this changes
--                          what is DISPLAYED, not what is enforced.
--
-- pending_approvals is the one to read: every dividend still waiting on the
-- Treasurer, with the stored total beside a recount done the way the payment
-- will do it. Any row where they differ was requested under the old
-- arithmetic, and `understated_by` is how much more will leave the company
-- than the figure on the request says.
select
  (select prosrc like '%coalesce(sc.conversion_ratio, 1)%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_request_dividend_approval')       as counts_conversion_ratio,
  (select prosrc like '%is_index_fund and fund_holdings ?| v_tickers%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_request_dividend_approval')       as counts_the_index_basket,
  (select prosrc like '%from jex_funds f where f.holdings ?| v_tickers%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_request_dividend_approval')       as counts_student_funds,
  (select prosrc like '%requires Treasurer approval%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')                    as payment_still_authoritative,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', q.ticker, 'per_share', q.per_share, 'requested_by', q.requested_by_name,
            'stored_total', q.total, 'real_total', q.real_total,
            'understated_by', round(q.real_total - q.total, 2))
          order by q.ticker), '[]'::jsonb)
     from (
       select a.ticker, a.per_share, a.requested_by_name, a.total,
              (
                coalesce((select sum(round(sh.shares * a.per_share, 2)) from (
                   select coalesce((select sum((u.holdings->>t)::numeric * coalesce(sc.conversion_ratio, 1))
                                      from unnest(tk.tickers) t
                                      left join jex_share_classes sc
                                        on sc.ticker = t and sc.ticker <> sc.parent_ticker
                                     where u.holdings ? t), 0) as shares
                     from jex_users u
                    where u.role = 'student' and u.status = 'approved' and u.holdings ?| tk.tickers
                 ) sh where sh.shares > 0), 0)
              + coalesce((select sum(round(sf.shares * a.per_share, 2)) from (
                   select coalesce((select sum((f.holdings->>t)::numeric * coalesce(sc.conversion_ratio, 1))
                                      from unnest(tk.tickers) t
                                      left join jex_share_classes sc
                                        on sc.ticker = t and sc.ticker <> sc.parent_ticker
                                     where f.holdings ? t), 0) as shares
                     from jex_funds f where f.holdings ?| tk.tickers
                 ) sf where sf.shares > 0), 0)
              ) as real_total
         from jex_dividend_approvals a
         cross join lateral (
           select array(select a.ticker
                        union select sc.ticker from jex_share_classes sc where sc.parent_ticker = a.ticker) as tickers
         ) tk
        where a.status = 'pending'
     ) q
    where round(q.real_total - q.total, 2) <> 0)                                  as pending_approvals;
