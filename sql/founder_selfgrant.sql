-- ============================================================
-- founder_selfgrant.sql
--
-- WRITES. Patches one function. Aborts and changes nothing on any mismatch.
-- Re-running is a no-op.
--
-- ── What is wrong ──
--
-- A founder can grant themselves the company's entire float, alone, in two
-- clicks, and the CEO never sees it happen.
--
-- rpc_request_founder_allocation is open to "this company's owner or founders"
-- -- correctly, because proposing a grant is the founders' job. But
-- rpc_review_founder_allocation, the step that actually hands over the shares,
-- accepts the SAME list. So the person requesting and the person approving can
-- be one student.
--
-- Measured on a copy of this database. One student, an accepted founder of the
-- Acme CEO's company, holding 50 ACME:
--
--   rpc_request_founder_allocation('ACME','themselves',1400)  -> pending
--   rpc_review_founder_allocation(that id, true)              -> approved
--
--   shares_avail   1400  ->  0        (the entire float)
--   their holding    50  ->  1450     (72.5% of all shares issued)
--
-- Then they sold 300 of them straight back into the pool:
--
--   their cash   $40,000  ->  $48,595
--   CEO's cash  $250,000  -> $241,405
--
-- $8,595 out of the CEO's account on the first sale, with 1,150 shares still
-- in hand to keep going. Note also that the 20% position cap that governs
-- every ordinary trade does not apply here -- founder grants are meant to be
-- large, which is exactly why the owner has to be the one making them.
--
-- ── The fix ──
--
-- Requesting stays exactly as it is: any founder may propose a grant.
--
-- APPROVING is now the company owner's decision, or an exchange officer's --
-- and never the beneficiary's own. A CEO approving a grant to one of their
-- founders, which is the normal flow, is unaffected.
--
-- Rejecting stays wide: the owner, a founder, an officer, or the student who
-- asked can all withdraw a pending request. Turning one down costs nobody
-- anything, and a founder who changes their mind should not need the CEO.
--
-- ── Method ──
--
-- One executable anchor, asserted to occur EXACTLY once, rebuilt through
-- pg_get_functiondef so the signature, volatility, SECURITY DEFINER and any
-- SET clause return exactly as they are. The line ending is detected at the
-- anchor rather than assumed -- these bodies are a mix of CRLF and LF.
-- ============================================================

do $mig$
declare
  r record;
  v_new text; v_n int; v_nl text; v_anchor text; v_probe text;
  v_officers constant text := '''chairman'', ''president'', ''secretary'', ''treasurer'', ''compliance_officer''';
begin
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_review_founder_allocation';
  if r.proname is null then raise exception 'ABORT: rpc_review_founder_allocation not found.'; end if;

  if position('cannot approve your own' in r.prosrc) > 0 then
    raise notice '  rpc_review_founder_allocation already refuses self-approval -- skipped';
    return;
  end if;

  -- Pick the line ending this body actually uses, at this anchor.
  v_probe := '  if not (' || chr(13) || chr(10) || '    v_co.owner_id = v_uid';
  if position(v_probe in r.prosrc) > 0 then
    v_nl := chr(13) || chr(10);
  elsif position('  if not (' || chr(10) || '    v_co.owner_id = v_uid' in r.prosrc) > 0 then
    v_nl := chr(10);
  else
    raise exception 'ABORT: could not locate the reviewer check. Nothing changed.';
  end if;

  v_anchor :=
    '  if not (' || v_nl ||
    '    v_co.owner_id = v_uid' || v_nl ||
    '    or exists (' || v_nl ||
    '      select 1 from jex_company_members where company_user_id = v_co.owner_id and student_id = v_uid and status = ''accepted''' || v_nl ||
    '    )' || v_nl ||
    '    or v_role in (' || v_officers || ')' || v_nl ||
    '  ) then' || v_nl ||
    '    raise exception ''Only this company''''s owner, founders, or an exchange officer can review this allocation'';' || v_nl ||
    '  end if;';

  v_n := (length(r.prosrc) - length(replace(r.prosrc, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then
    raise exception 'ABORT: reviewer check found % times, expected 1. Nothing changed.', v_n;
  end if;

  v_new := replace(r.prosrc, v_anchor,
    '-- Proposing a founder grant is open to the founders. HANDING THE SHARES' || v_nl ||
    '  -- OVER is the owner''s decision, or an exchange officer''s, and it is never' || v_nl ||
    '  -- the beneficiary''s own. Founders used to be on this list for both halves,' || v_nl ||
    '  -- so one student could request the company''s entire float for themselves' || v_nl ||
    '  -- and approve it in the same breath -- measured at 1,400 shares (72.5% of' || v_nl ||
    '  -- everything issued) and $8,595 out of the CEO''s cash on the first sale,' || v_nl ||
    '  -- with the CEO never in the loop. The 20% position cap that governs every' || v_nl ||
    '  -- ordinary trade does not apply to a grant, which is precisely why the' || v_nl ||
    '  -- owner has to be the one making it.' || v_nl ||
    '  if p_approve then' || v_nl ||
    '    if v_alloc.student_id = v_uid then' || v_nl ||
    '      raise exception ''You cannot approve your own founder share request. Ask the company owner, or an exchange officer, to review it.'';' || v_nl ||
    '    end if;' || v_nl ||
    '    if not (v_co.owner_id = v_uid or v_role in (' || v_officers || ')) then' || v_nl ||
    '      raise exception ''Only this company''''s owner or an exchange officer can approve a founder share grant'';' || v_nl ||
    '    end if;' || v_nl ||
    '  else' || v_nl ||
    '    -- Turning a request down costs nobody anything, so it stays wide: the' || v_nl ||
    '    -- owner, any founder, an officer, or the student who asked can withdraw it.' || v_nl ||
    '    if not (' || v_nl ||
    '      v_co.owner_id = v_uid' || v_nl ||
    '      or v_alloc.student_id = v_uid' || v_nl ||
    '      or exists (' || v_nl ||
    '        select 1 from jex_company_members where company_user_id = v_co.owner_id and student_id = v_uid and status = ''accepted''' || v_nl ||
    '      )' || v_nl ||
    '      or v_role in (' || v_officers || ')' || v_nl ||
    '    ) then' || v_nl ||
    '      raise exception ''Only this company''''s owner, its founders, or an exchange officer can reject this allocation'';' || v_nl ||
    '    end if;' || v_nl ||
    '  end if;');

  execute replace(r.def, r.prosrc, v_new);
  raise notice '  rpc_review_founder_allocation: approving a grant is now the owner''s call, never the beneficiary''s';
end
$mig$;

-- ── Verification ──
--
-- All four must be true.
--
-- refuses_self_approval   the beneficiary can no longer approve their own grant.
-- approval_is_owner_only  a plain founder can no longer approve one at all.
-- rejection_stays_open    a founder or the student who asked can still withdraw it.
-- request_still_open      proposing a grant is unchanged -- founders still can.
--
-- already_granted lists every allocation ALREADY approved. This cannot undo
-- one; read it and check each against what the company's owner actually
-- intended. `self_reviewed` is the sharp one -- true means the request names
-- a student who is a founder of that company, so this is one of the grants
-- that could have been waved through by its own beneficiary. It is not proof
-- that it was, only that nothing would have stopped it.
select
  (select prosrc like '%cannot approve your own%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_review_founder_allocation')          as refuses_self_approval,
  (select prosrc like '%owner or an exchange officer can approve a founder share grant%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_review_founder_allocation')          as approval_is_owner_only,
  (select prosrc like '%its founders, or an exchange officer can reject%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_review_founder_allocation')          as rejection_stays_open,
  (select prosrc like '%owner or founders can request an allocation for it%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_request_founder_allocation')         as request_still_open,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'ticker', a.ticker, 'student', a.student_name, 'shares', a.shares,
            'status', a.status, 'when', a.ts,
            'worth_now', round(a.shares * coalesce(c.price, 0), 2),
            'self_reviewed', exists (
              select 1 from jex_company_members m
               where m.company_user_id = c.owner_id
                 and m.student_id = a.student_id
                 and m.status = 'accepted'))
          order by a.shares desc), '[]'::jsonb)
     from jex_founder_allocations a
     left join jex_companies c on c.ticker = a.ticker
    where a.status = 'approved')                                                     as already_granted;
