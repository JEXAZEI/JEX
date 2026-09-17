-- ============================================================
-- ex_dividend.sql
--
-- WRITES. Replaces rpc_pay_dividend. Aborts and changes nothing on any
-- mismatch. Re-running is a no-op with a clear message.
--
-- ── The missing half ──
--
-- On Sep 8 I shipped the client half of this and wrote in that commit that
-- "the server migrations follow once I have the deployed source." I never sent
-- this one. app.js has been calling applyExDividend(r.new_prices) ever since,
-- guarded so it does nothing when the field is absent -- which it always has
-- been. The feature has looked present in the code for five days and has never
-- once run.
--
-- ── What is actually wrong ──
--
-- A dividend moves cash out of the company to its shareholders and does not
-- touch the share price. The shares are worth exactly what they were a second
-- earlier, so the holder is up by the whole dividend -- free money, and the way
-- you take it is to not be a shareholder until just before the payment:
--
--     buy  ->  dividend pays  ->  sell back
--
-- Run against your real trade functions on a copy of this database:
--
--     $0.50/share, 100 shares  ->  student +$4.00
--     $2.00/share, 100 shares  ->  student +$154.00
--     $5.00/share, 100 shares  ->  student +$454.00   (of a $500 dividend)
--
-- Every dollar comes out of the paying owner's cash. Price impact is the only
-- brake -- trading 400 shares costs more than a small dividend pays -- but
-- trading cost is a fixed PERCENTAGE while the yield is whatever the CEO types,
-- so the bigger the dividend the better the trade.
--
-- And it is foreseeable. Every client fetches jex_dividend_approvals at boot,
-- so a pending dividend's ticker and per-share amount sit in DB.divApprovals in
-- every student's browser. Dividends above the approval threshold are exactly
-- the ones forced through that queue, so the largest and most profitable ones
-- are the most widely advertised.
--
-- ── The fix, and the three things it drags in with it ──
--
-- The price drops by the dividend on payment. That is the ex-dividend date, it
-- is why a dividend is not free money -- you trade a dollar of share price for
-- a dollar of cash -- and after it the round trip above nets nothing but the
-- trading costs. Retested: every case above becomes a loss of $2 to $45.
--
-- But a price drop is a GAIN to anyone short, and shorts here pay no dividend.
-- I measured the naive version of this fix before writing the rest of it:
--
--     short 50, $5.00 dividend, cover  ->  +$240.50
--     same trade with no dividend      ->   -$11.00
--
-- so the dividend handed the short seller $251.50, and because short P&L in
-- this system is paid by the exchange rather than by a counterparty, the system
-- money supply rose by the identical amount. That is not a transfer, it is
-- minting -- strictly worse than the bug being fixed. In a real market the
-- short seller owes the dividend to the lender. Here their basis drops with the
-- price, which leaves their P&L exactly where it was: they neither gain nor
-- lose from the dividend, no cash moves, and nothing can fail for want of it.
-- Both jex_users.shorts and jex_funds.shorts are covered.
--
-- Second: student-run funds hold real shares in jex_funds, a different table
-- from the one the payout loop reads, so they have never been paid a dividend.
-- Harmless while the price did not move; with the drop it becomes a straight
-- loss to every investor in the fund. The fund is now paid for the shares it
-- actually holds, into the fund's cash, where its NAV picks it up. The company
-- is charged for those shares, because it owes them.
--
-- Third, and the one to actually decide on: the payout loop pays only
-- role='student' AND status='approved'. Holders who are neither -- a departed
-- student, a company account holding another company's stock -- are skipped,
-- and the company is not charged for them. That was a harmless narrowness while
-- the price never moved. With the drop it becomes a real loss to those holders.
-- I have NOT changed it here, because who counts as a shareholder is your call
-- on a graded leaderboard, not mine. The verification at the bottom prints
-- exactly who is in that position right now so you can decide with the real
-- numbers in front of you; if the answer is "pay them too" that is a two-line
-- follow-up.
--
-- ── The part that is not obvious ──
--
-- The session open price moves down by the same amount.
--
-- The price band is +/-30% measured from the session open. If the price drops
-- and the reference does not, a large dividend can put a stock below its own
-- band -- and rpc_trade_sell rejects any sell that lands below the band while
-- still falling. A CEO paying a generous dividend would have locked their own
-- shareholders out of selling until the next session, as a direct result of
-- being generous. Real exchanges adjust the reference for corporate actions for
-- exactly this reason. The band keeps its width, centred on the price that now
-- reflects the payout.
--
-- ── Lock ordering ──
--
-- Share-class rows are locked up front, while this function holds only company
-- locks and has not yet touched a user row, and every loop that writes user or
-- fund rows walks them in id order. rpc_trade_buy takes companies and then
-- users; a function taking them in the other order deadlocks against it under a
-- class of fifteen all clicking at once.
--
-- ── Method ──
--
-- Executable anchors only, never comments, each asserted to occur EXACTLY once
-- before any replace(); the function is rebuilt from its own catalog signature
-- so nothing is retyped; the body goes through quote_literal() rather than
-- nested dollar quoting.
-- ============================================================

do $mig$
declare
  r record;
  v_new text;
  v_n int;
  a text;
begin
  select p.oid, p.proname,
         pg_get_function_arguments(p.oid) as args,
         pg_get_function_result(p.oid)    as ret,
         p.prosrc, p.prosecdef, p.proconfig,
         case p.provolatile when 'i' then 'immutable'
                            when 's' then 'stable' else 'volatile' end as vol
    into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_pay_dividend';

  if r.proname is null then
    raise exception 'ABORT: rpc_pay_dividend not found. Nothing changed.';
  end if;

  if position('v_new_prices' in r.prosrc) > 0 then
    raise notice 'rpc_pay_dividend already applies the ex-dividend drop -- nothing to do.';
    return;
  end if;

  v_new := r.prosrc;

  -- ---------- 1. declarations ----------
  a := 'v_direct_cuts jsonb := ''[]''::jsonb;';
  v_n := (length(v_new) - length(replace(v_new, a, ''))) / length(a);
  if v_n <> 1 then raise exception 'ABORT: declare anchor found % times, expected 1.', v_n; end if;
  v_new := replace(v_new, a, a || chr(13) || chr(10) ||
    '  v_ex record; v_ex_price numeric; v_new_prices jsonb := ''{}''::jsonb;' || chr(13) || chr(10) ||
    '  v_sfund record; v_fund_pays jsonb := ''[]''::jsonb; v_short_id text;' || chr(13) || chr(10) ||
    '  v_open_prices jsonb;');

  -- ---------- 2. lock the share classes before any user row ----------
  a := 'select coalesce(dividend_approval_threshold, 1000) into v_threshold from jex_session where id = 1;';
  v_n := (length(v_new) - length(replace(v_new, a, ''))) / length(a);
  if v_n <> 1 then raise exception 'ABORT: threshold anchor found % times, expected 1.', v_n; end if;
  v_new := replace(v_new, a,
    '-- Every share class is locked HERE, while this function still holds only' || chr(13) || chr(10) ||
    '  -- company locks and has not touched a user row. rpc_trade_buy takes' || chr(13) || chr(10) ||
    '  -- companies and then users; taking them in the other order is how two' || chr(13) || chr(10) ||
    '  -- functions deadlock against each other.' || chr(13) || chr(10) ||
    '  perform 1 from jex_companies where ticker = any(v_tickers) order by ticker for update;' || chr(13) || chr(10) ||
    '  ' || a);

  -- ---------- 3. funds are shareholders too, and must be charged for ----------
  -- Placed before the "no shareholders" test so a fund-only dividend is
  -- payable, and before the affordability test so the owner is checked
  -- against the full amount they are about to owe.
  a := 'if v_total <= 0 then raise exception ''No shareholders yet''; end if;';
  v_n := (length(v_new) - length(replace(v_new, a, ''))) / length(a);
  if v_n <> 1 then raise exception 'ABORT: no-shareholders anchor found % times, expected 1.', v_n; end if;
  v_new := replace(v_new, a,
    '-- Student-run funds hold real shares, in jex_funds rather than in the' || chr(13) || chr(10) ||
    '  -- table the loops above read, so they have never been paid a dividend.' || chr(13) || chr(10) ||
    '  -- That was harmless while a dividend did not move the price. It is not' || chr(13) || chr(10) ||
    '  -- harmless now: without this, every investor in a fund holding this' || chr(13) || chr(10) ||
    '  -- stock would simply lose the ex-dividend drop. Paid into the fund''s' || chr(13) || chr(10) ||
    '  -- cash, where its NAV picks it up, and charged to the company, which' || chr(13) || chr(10) ||
    '  -- owes it for shares it really has outstanding.' || chr(13) || chr(10) ||
    '  for v_sfund in' || chr(13) || chr(10) ||
    '    select f.id, f.name,' || chr(13) || chr(10) ||
    '      coalesce((select sum((f.holdings->>t)::numeric * coalesce(sc.conversion_ratio, 1))' || chr(13) || chr(10) ||
    '                  from unnest(v_tickers) t' || chr(13) || chr(10) ||
    '                  left join jex_share_classes sc' || chr(13) || chr(10) ||
    '                    on sc.ticker = t and sc.ticker <> sc.parent_ticker' || chr(13) || chr(10) ||
    '                 where f.holdings ? t), 0) as shares' || chr(13) || chr(10) ||
    '      from jex_funds f' || chr(13) || chr(10) ||
    '     where f.holdings ?| v_tickers' || chr(13) || chr(10) ||
    '     order by f.id' || chr(13) || chr(10) ||
    '  loop' || chr(13) || chr(10) ||
    '    if v_sfund.shares > 0 then' || chr(13) || chr(10) ||
    '      v_payout := round(v_sfund.shares * p_per_share, 2);' || chr(13) || chr(10) ||
    '      v_total := v_total + v_payout;' || chr(13) || chr(10) ||
    '      v_fund_pays := v_fund_pays || jsonb_build_array(jsonb_build_object(' || chr(13) || chr(10) ||
    '        ''id'', v_sfund.id, ''name'', v_sfund.name, ''shares'', v_sfund.shares, ''payout'', v_payout));' || chr(13) || chr(10) ||
    '    end if;' || chr(13) || chr(10) ||
    '  end loop;' || chr(13) || chr(10) || chr(13) || chr(10) ||
    '  ' || a);

  -- ---------- 4. pay the funds, charge the shorts, drop the price ----------
  a := 'v_div_id := gen_random_uuid()::text;';
  v_n := (length(v_new) - length(replace(v_new, a, ''))) / length(a);
  if v_n <> 1 then raise exception 'ABORT: div-id anchor found % times, expected 1.', v_n; end if;
  v_new := replace(v_new, a,
    'for v_cut in select * from jsonb_array_elements(v_fund_pays)' || chr(13) || chr(10) ||
    '  loop' || chr(13) || chr(10) ||
    '    update jex_funds set cash = round(coalesce(cash, 0) + (v_cut->>''payout'')::numeric, 2)' || chr(13) || chr(10) ||
    '      where id = v_cut->>''id'';' || chr(13) || chr(10) ||
    '  end loop;' || chr(13) || chr(10) || chr(13) || chr(10) ||
    '  -- Ex-dividend. The company just handed this cash to its shareholders, so' || chr(13) || chr(10) ||
    '  -- it is worth exactly that much less and the price says so. Without this' || chr(13) || chr(10) ||
    '  -- a dividend is free money to anyone who buys in just before it and sells' || chr(13) || chr(10) ||
    '  -- straight back out -- measured at $454 of a $500 dividend, out of the' || chr(13) || chr(10) ||
    '  -- paying owner''s cash, and pending dividends are readable by every client.' || chr(13) || chr(10) ||
    '  --' || chr(13) || chr(10) ||
    '  -- A class share drops by per_share * ratio because that is what it was' || chr(13) || chr(10) ||
    '  -- paid: one class share at ratio 5 IS five parent shares.' || chr(13) || chr(10) ||
    '  for v_ex in' || chr(13) || chr(10) ||
    '    select c.ticker, c.price, c.price_history,' || chr(13) || chr(10) ||
    '           round(p_per_share * coalesce(sc.conversion_ratio, 1), 2) as drop_by' || chr(13) || chr(10) ||
    '      from unnest(v_tickers) t' || chr(13) || chr(10) ||
    '      join jex_companies c on c.ticker = t' || chr(13) || chr(10) ||
    '      left join jex_share_classes sc on sc.ticker = t and sc.ticker <> sc.parent_ticker' || chr(13) || chr(10) ||
    '     order by c.ticker' || chr(13) || chr(10) ||
    '  loop' || chr(13) || chr(10) ||
    '    v_ex_price := greatest(0.01, round(v_ex.price - v_ex.drop_by, 2));' || chr(13) || chr(10) ||
    '    update jex_companies set price = v_ex_price,' || chr(13) || chr(10) ||
    '      price_history = coalesce(v_ex.price_history, ''[]''::jsonb) ||' || chr(13) || chr(10) ||
    '        jsonb_build_array(jsonb_build_object(''p'', v_ex_price,' || chr(13) || chr(10) ||
    '          ''t'', to_char(now() at time zone ''utc'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'')))' || chr(13) || chr(10) ||
    '      where ticker = v_ex.ticker;' || chr(13) || chr(10) ||
    '    v_new_prices := jsonb_set(v_new_prices, array[v_ex.ticker], to_jsonb(v_ex_price));' || chr(13) || chr(10) || chr(13) || chr(10) ||
    '    -- The band is +/-30% from the session open, so the reference moves by' || chr(13) || chr(10) ||
    '    -- the same amount. Otherwise a large dividend drops a stock below its' || chr(13) || chr(10) ||
    '    -- own band, and rpc_trade_sell refuses a sell that is below the band' || chr(13) || chr(10) ||
    '    -- and still falling: a generous CEO would lock their own shareholders' || chr(13) || chr(10) ||
    '    -- out of selling until the next session.' || chr(13) || chr(10) ||
    '    update jex_session' || chr(13) || chr(10) ||
    '       set session_open_prices = jsonb_set(session_open_prices, array[v_ex.ticker],' || chr(13) || chr(10) ||
    '             to_jsonb(greatest(0.01, round((session_open_prices->>v_ex.ticker)::numeric - v_ex.drop_by, 2))))' || chr(13) || chr(10) ||
    '     where id = 1 and session_open_prices ? v_ex.ticker;' || chr(13) || chr(10) || chr(13) || chr(10) ||
    '    -- A short seller owes the dividend. Their basis falls with the price,' || chr(13) || chr(10) ||
    '    -- so their P&L is exactly where it was and the payout is neither a' || chr(13) || chr(10) ||
    '    -- gain nor a loss to them. Without this the drop is a pure gift to' || chr(13) || chr(10) ||
    '    -- every short -- measured at +$240.50 on a $5.00 dividend against' || chr(13) || chr(10) ||
    '    -- -$11.00 for the same trade without one -- and because short P&L is' || chr(13) || chr(10) ||
    '    -- paid by the exchange and not by a counterparty, the money supply' || chr(13) || chr(10) ||
    '    -- rose by the same amount. Minting, not transferring.' || chr(13) || chr(10) ||
    '    for v_short_id in select id from jex_users' || chr(13) || chr(10) ||
    '       where coalesce(shorts, ''{}''::jsonb) ? v_ex.ticker' || chr(13) || chr(10) ||
    '         and coalesce((shorts->v_ex.ticker->>''qty'')::numeric, 0) > 0' || chr(13) || chr(10) ||
    '       order by id' || chr(13) || chr(10) ||
    '    loop' || chr(13) || chr(10) ||
    '      update jex_users set shorts = jsonb_set(shorts, array[v_ex.ticker, ''avgPrice''],' || chr(13) || chr(10) ||
    '        to_jsonb(greatest(0.01, round((shorts->v_ex.ticker->>''avgPrice'')::numeric - v_ex.drop_by, 2))))' || chr(13) || chr(10) ||
    '        where id = v_short_id;' || chr(13) || chr(10) ||
    '    end loop;' || chr(13) || chr(10) ||
    '    for v_short_id in select id from jex_funds' || chr(13) || chr(10) ||
    '       where coalesce(shorts, ''{}''::jsonb) ? v_ex.ticker' || chr(13) || chr(10) ||
    '         and coalesce((shorts->v_ex.ticker->>''qty'')::numeric, 0) > 0' || chr(13) || chr(10) ||
    '       order by id' || chr(13) || chr(10) ||
    '    loop' || chr(13) || chr(10) ||
    '      update jex_funds set shorts = jsonb_set(shorts, array[v_ex.ticker, ''avgPrice''],' || chr(13) || chr(10) ||
    '        to_jsonb(greatest(0.01, round((shorts->v_ex.ticker->>''avgPrice'')::numeric - v_ex.drop_by, 2))))' || chr(13) || chr(10) ||
    '        where id = v_short_id;' || chr(13) || chr(10) ||
    '    end loop;' || chr(13) || chr(10) ||
    '  end loop;' || chr(13) || chr(10) || chr(13) || chr(10) ||
    '  -- Handed back so the client can move its own reference at the same' || chr(13) || chr(10) ||
    '  -- moment it moves the price. session_open_prices drives both the day''s' || chr(13) || chr(10) ||
    '  -- percent-change figure and the band limits shown on the trade ticket;' || chr(13) || chr(10) ||
    '  -- if the price moves here and the reference only catches up on the next' || chr(13) || chr(10) ||
    '  -- poll, every shareholder spends that window looking at an invented' || chr(13) || chr(10) ||
    '  -- loss for the day -- which is the exact misreading this whole change' || chr(13) || chr(10) ||
    '  -- is trying to prevent.' || chr(13) || chr(10) ||
    '  select session_open_prices into v_open_prices from jex_session where id = 1;' || chr(13) || chr(10) || chr(13) || chr(10) ||
    '  ' || a);

  -- ---------- 5. hand the new prices back to the client ----------
  a := 'return jsonb_build_object(''total'', v_total, ''payouts'', v_payouts,';
  v_n := (length(v_new) - length(replace(v_new, a, ''))) / length(a);
  if v_n <> 1 then raise exception 'ABORT: return anchor found % times, expected 1.', v_n; end if;
  v_new := replace(v_new, a,
    'return jsonb_build_object(''new_prices'', v_new_prices, ''fund_payouts'', v_fund_pays,' || chr(13) || chr(10) ||
    '    ''session_open_prices'', v_open_prices,' || chr(13) || chr(10) ||
    '    ''total'', v_total, ''payouts'', v_payouts,');

  if v_new = r.prosrc then
    raise exception 'ABORT: rpc_pay_dividend was not modified. Nothing changed.';
  end if;

  execute 'create or replace function public.' || quote_ident(r.proname) ||
          '(' || r.args || ') returns ' || r.ret ||
          ' language plpgsql ' || r.vol ||
          case when r.prosecdef then ' security definer' else '' end ||
          -- proconfig values are re-emitted RAW, not through quote_literal().
          -- A search_path of two schemas is stored as the bare list
          -- `search_path=public, pg_temp`; wrapping that in quote_literal makes
          -- it `set search_path = 'public, pg_temp'`, which Postgres reads as
          -- ONE schema whose name contains a comma. The rebuilt function then
          -- cannot see a single table -- every query in it fails with
          -- `relation "jex_users" does not exist`. I did exactly that to
          -- rpc_convert_share_class on my copy and it is the reason this note
          -- exists. Emitting the stored value verbatim round-trips correctly.
          -- Omitting the SET clause is NOT the alternative: a CREATE OR REPLACE
          -- without it drops the setting to NULL.
          coalesce((select string_agg(' set ' || split_part(c,'=',1) || ' = ' ||
                                      substr(c, position('=' in c)+1), '')
                      from unnest(r.proconfig) c), '') ||
          ' as ' || quote_literal(v_new);

  raise notice 'rpc_pay_dividend now applies the ex-dividend drop, pays funds, and charges shorts.';
end
$mig$;

-- ── Verification ──
--
-- The first six must all be true.
--
-- drops_the_price     the price falls by the dividend.
-- moves_the_band      and the session open falls with it, so a big dividend
--                     cannot lock shareholders out of selling.
-- charges_shorts      short basis falls too, in BOTH tables -- this is the one
--                     that stops the fix from minting money.
-- pays_funds          jex_funds holdings are paid and charged for.
-- returns_new_prices  the field app.js has been reading since Sep 8.
-- locks_before_users  share classes locked before the first user row, the same
--                     order rpc_trade_buy takes them.
--
-- holders_not_paid is the decision I left to you: every holder of a listed
-- ticker who is NOT role='student'/status='approved' and so receives nothing,
-- but who will now take the price drop. If this comes back empty there is
-- nothing to decide. If it does not, tell me and I will widen the payout.
select
  (select prosrc like '%v_ex_price := greatest(0.01%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')             as drops_the_price,
  (select prosrc like '%session_open_prices = jsonb_set%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')             as moves_the_band,
  (select (prosrc like '%update jex_users set shorts = jsonb_set%')
      and (prosrc like '%update jex_funds set shorts = jsonb_set%')
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')             as charges_shorts,
  (select prosrc like '%update jex_funds set cash = round(coalesce(cash, 0)%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')             as pays_funds,
  (select prosrc like '%''new_prices'', v_new_prices%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')             as returns_new_prices,
  (select position('order by ticker for update' in prosrc)
        < position('from jex_users where id = v_co.owner_id for update' in prosrc)
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')             as locks_before_users,
  (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_pay_dividend')             as still_secdef,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'name', u.name, 'role', u.role, 'status', u.status, 'holdings', u.holdings)
          order by u.name), '[]'::jsonb)
     from jex_users u
    where not (u.role = 'student' and u.status = 'approved')
      and exists (select 1 from jex_companies c
                   where c.status = 'listed'
                     and coalesce((u.holdings->>c.ticker)::numeric, 0) > 0)) as holders_not_paid,
  (select coalesce(jsonb_agg(jsonb_build_object('fund', f.name, 'holdings', f.holdings)
          order by f.name), '[]'::jsonb)
     from jex_funds f where f.holdings <> '{}'::jsonb)                     as funds_now_paid,
  (select coalesce(jsonb_agg(jsonb_build_object('who', u.name, 'shorts', u.shorts)
          order by u.name), '[]'::jsonb)
     from jex_users u where coalesce(u.shorts, '{}'::jsonb) <> '{}'::jsonb) as shorts_now_charged;
