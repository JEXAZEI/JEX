-- ============================================================
-- dedupe_ex_dividend.sql
--
-- RUN THIS BEFORE THE NEXT DIVIDEND. WRITES. Aborts and changes nothing on any
-- mismatch. Re-running is a no-op.
--
-- ── My mistake ──
--
-- rpc_pay_dividend now contains the ex-dividend logic TWICE, and that is my
-- fault. Your database already had an implementation of it -- a block built
-- around `foreach v_ex_t in array v_tickers loop`, using variables named
-- v_ex_prices / v_ex_drop / v_ex_owed. I did not know it was there; I could not
-- see your database, and every check I wrote looked for the name MY version
-- uses (v_new_prices). So the "already applied?" guard at the top of
-- ex_dividend.sql did not fire, and my block was spliced in alongside it.
--
-- Both blocks run on every dividend. Live effects:
--
--   * THE PRICE DROPS TWICE. A $1.00 dividend moves the price down $2.00.
--   * The session open price is moved down twice, by the same amount.
--   * Short sellers are charged twice -- the old block takes cash, mine lowers
--     the basis -- so a short pays the dividend two ways.
--   * The return builds 'new_prices' twice. In jsonb_build_object the last key
--     wins, so app.js has been reading the OLD block's map.
--   * The old block settles a short with greatest(0, cash - owed), which
--     forgives any shortfall. That is money created, at exactly the moment a
--     student is most over-extended.
--
-- Nothing is lost by removing the old block: everything it did, the surviving
-- one does, and does better.
--
--   basis, not cash. The old block deducted cash from short sellers, which can
--   fail against the cash >= 0 constraint and needs the greatest(0,...) that
--   mints. Lowering the basis moves the position with the price, so the short
--   is neither better nor worse off, no cash moves, and nothing can fail.
--
--   funds too. The old block only touched jex_users. Funds hold shares AND
--   shorts in their own table; the surviving block pays and charges both.
--
--   a real timestamp. The old block stamped the literal word 'ex-dividend' into
--   price_history where a date goes. computeIndex builds one shared time axis
--   from every constituent's stamps and sorts it as text -- 'ex-dividend' sorts
--   after every ISO date, so it became a phantom final point on the index
--   chart. That is the same bug I fixed on the client side yesterday.
--
-- ── Why this one anchors on comments, when I keep saying not to ──
--
-- Because I am no longer working from a reconstruction. dump_functions.sql gave
-- me pg_get_functiondef output, which is byte-accurate, so the comment text
-- here is the real text and not something I retyped from memory. Every anchor
-- is still asserted to occur EXACTLY once before anything is cut.
--
-- ── What it does ──
--
-- Deletes the region from the start of the old block's comment up to the line
-- that follows it, fixes the duplicated key in the return, and leaves the rest
-- of the function untouched.
-- ============================================================

do $mig$
declare
  r record;
  v_new text;
  v_start int;
  v_end int;
  v_n int;
  v_probe text;
  a_begin text := 'foreach v_ex_t in array v_tickers loop';
  a_cmt   text := '-- Ex-dividend. The price falls by what these shares were paid, which is';
  a_after text := 'for v_cut in select * from jsonb_array_elements(v_fund_pays)';
  a_dupe  text := ', ''new_prices'', v_ex_prices';
begin
  select p.oid, p.proname, p.prosrc,
         pg_get_functiondef(p.oid) as def
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_pay_dividend';

  if r.proname is null then
    raise exception 'ABORT: rpc_pay_dividend not found. Nothing changed.';
  end if;

  if position(a_begin in r.prosrc) = 0 then
    raise notice 'The duplicate ex-dividend block is already gone -- nothing to do.';
    return;
  end if;

  -- Each anchor exactly once, or this does not touch anything.
  -- A separate probe variable: v_new holds the rewritten body, and looping the
  -- anchors through it would wipe that before it is ever built.
  foreach v_probe in array array[a_begin, a_cmt, a_after] loop
    v_n := (length(r.prosrc) - length(replace(r.prosrc, v_probe, ''))) / length(v_probe);
    if v_n <> 1 then
      raise exception 'ABORT: anchor "%" found % times, expected 1. Nothing changed.',
        left(v_probe, 40), v_n;
    end if;
  end loop;

  -- The surviving block must actually be present, or removing the old one
  -- would leave the function with NO ex-dividend handling at all.
  if position('v_ex_price := greatest(0.01, round(v_ex.price - v_ex.drop_by, 2))' in r.prosrc) = 0 then
    raise exception 'ABORT: the block I intend to KEEP is not there. Nothing changed.';
  end if;

  v_start := position(a_cmt in r.prosrc);
  v_end   := position(a_after in r.prosrc);
  if v_end <= v_start then
    raise exception 'ABORT: the old block does not sit where expected. Nothing changed.';
  end if;

  v_new := left(r.prosrc, v_start - 1) || substr(r.prosrc, v_end);

  -- The duplicated return key. jsonb_build_object takes the LAST value for a
  -- repeated key, so while both blocks existed the client was being handed the
  -- old block's map rather than the surviving one's.
  v_n := (length(v_new) - length(replace(v_new, a_dupe, ''))) / length(a_dupe);
  if v_n <> 1 then
    raise exception 'ABORT: duplicate return key found % times, expected 1. Nothing changed.', v_n;
  end if;
  v_new := replace(v_new, a_dupe, '');

  if position(a_begin in v_new) > 0 then
    raise exception 'ABORT: the old block survived the cut. Nothing changed.';
  end if;

  -- Rebuilt from pg_get_functiondef, which is Postgres printing its own
  -- definition: the signature, volatility, SECURITY DEFINER and any SET clause
  -- all come back exactly as they are. This is the approach that would have
  -- prevented the search_path bug, and it is what I use from here on.
  execute replace(r.def, r.prosrc, v_new);

  raise notice 'Duplicate ex-dividend block removed. One remains.';
end
$mig$;

-- ── Verification ──
--
-- old_block_gone        the foreach block is no longer present.
-- one_drop_remains      exactly one price-drop loop survives.
-- one_new_prices_key    the return no longer repeats the key.
-- charges_shorts_basis  shorts move by basis, not by a cash deduction.
-- no_cash_deduction     the minting greatest(0, cash - owed) line is gone.
-- pays_funds            fund holdings are still paid.
-- still_secdef          unchanged.
-- search_path_intact    null is correct for this function -- it never had one.
select
  (select position('foreach v_ex_t in array v_tickers loop' in prosrc) = 0
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')              as old_block_gone,
  (select (length(prosrc) - length(replace(prosrc,
            'v_ex_price := greatest(0.01, round(v_ex.price - v_ex.drop_by, 2))','')))
        / length('v_ex_price := greatest(0.01, round(v_ex.price - v_ex.drop_by, 2))')
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')              as one_drop_remains,
  (select (length(prosrc) - length(replace(prosrc, '''new_prices''','')))
        / length('''new_prices''')
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')              as one_new_prices_key,
  (select prosrc like '%update jex_users set shorts = jsonb_set%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')              as charges_shorts_basis,
  (select position('cash = greatest(0, round(cash - v_ex_owed, 2))' in prosrc) = 0
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')              as no_cash_deduction,
  (select prosrc like '%update jex_funds set cash = round(coalesce(cash, 0)%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')              as pays_funds,
  (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')              as still_secdef,
  (select coalesce(array_to_json(proconfig)::text, 'null')
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')              as search_path_intact;
