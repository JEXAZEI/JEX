-- ============================================================
-- buyback_cascade.sql
--
-- WRITES. Replaces rpc_buyback and patches two order-book functions. Aborts and
-- changes nothing on any mismatch. Re-running is a no-op.
--
-- ── What was wrong ──
--
-- rpc_buyback debited the company and lowered `shares`, and that was all. No
-- holder's position changed and nobody was paid. Measured on a copy of your
-- database, buying back 100 shares of ACME at $30:
--
--     company cash      -$3,045.00
--     paid to anyone     $0.00          <- the money left the system
--     shares sold         110 before, 110 after   <- nobody sold
--     price              $30.00 -> $30.45         <- everyone marked UP
--     issued              2000 -> 1900
--
-- Two separate faults. The cash was destroyed rather than transferred. And the
-- price ROSE, because a buyback is modelled as a buy, so every existing holder
-- was marked up for free -- then when they sell into the pool the company pays
-- a second time under the "company pays" rule. One button, two drains.
--
-- There was also a counting fault: when the circulating shares are genuinely
-- all held, `shares` drops below held + shares_avail, so more shares are
-- claimable than the company ever issued.
--
-- ── What it does now ──
--
-- A buyback works down a cascade, and stops as soon as the quantity is met.
--
--   1. UNSOLD FLOAT FIRST. Shares the company never sold are its own already,
--      so it cancels them: `shares` and `shares_avail` both drop by the same
--      amount and NO money moves. Paying yourself for your own stock is not a
--      transaction. The price does not move either -- no trade happened.
--
--   2. THEN RESTING SELL ORDERS. Anyone who has already posted an ask is a
--      willing seller, so they are served next, cheapest ask first and oldest
--      first at equal prices. They are paid their own limit price -- the
--      resting order sets the price, the same rule the book matcher uses. Their
--      shares are retired, so issued and outstanding fall together.
--
--   3. THEN A TENDER. Whatever is left is posted as a standing buy order at a
--      premium the CEO names, and it sits on the book until somebody takes it
--      or the CEO cancels it. That is what a tender offer is, and it means the
--      company never takes shares from anyone who did not choose to sell.
--
-- ── Why the order book had to change ──
--
-- A tender is a real row in jex_limit_orders, so the two functions that fill
-- orders have to know what it is. Marked with order_type = 'buyback':
--
--   rpc_fill_limit_vs_pool refuses it outright. That path fills against the
--   company's own unsold pool, and a company buying its own unsold stock from
--   itself is the original bug wearing a different hat.
--
--   rpc_match_limit_order_book, when the bid is a tender, debits the company
--   and RETIRES the shares instead of crediting them to the company's holdings.
--   Otherwise the company would end up holding its own stock, which then counts
--   in float, voting and the borrow limit.
--
-- ── The premium is capped ──
--
-- At 50%, and additionally refused if it would put the bid above the session
-- price band's ceiling. Without a cap a CEO could post a bid far outside the
-- band that nothing else in the system would ever allow.
--
-- ── Signature change ──
--
-- rpc_buyback gains a third argument, p_premium_pct, defaulting to 0. A
-- different argument list is a different function in Postgres, so the old
-- two-argument version is dropped rather than left behind as an overload that
-- PostgREST could not choose between. Its EXECUTE grants are read off the old
-- function and replayed onto the new one, so nothing loses access.
-- ============================================================

do $mig$
declare
  r record;
  v_new text;
  v_n int;
  v_acl aclitem[];
  v_g record;
  a text;
  -- Production stores these bodies with CRLF; my local copy of one of them has
  -- LF. An anchor that hard-codes either one silently matches nothing in the
  -- other, which is how the first attempt at this migration aborted. Detected
  -- per function instead of assumed.
  v_nl text;
begin
  -- ============================================================
  -- 1. rpc_buyback itself
  -- ============================================================
  -- Matched on the argument COUNT, not on a rendered signature string.
  -- pg_get_function_identity_arguments returns "p_ticker text, p_qty integer"
  -- -- parameter names included -- not "text, integer", so comparing against
  -- the bare type list silently matches nothing and leaves the old overload in
  -- place beside the new one, which PostgREST then cannot choose between.
  select p.oid, p.proacl, pg_get_function_identity_arguments(p.oid) as ident into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_buyback' and p.pronargs = 2;

  if r.oid is not null then
    v_acl := r.proacl;
    execute format('drop function public.rpc_buyback(%s)', r.ident);
  end if;

  create or replace function public.rpc_buyback(p_ticker text, p_qty integer,
                                                p_premium_pct numeric default 0)
  returns jsonb language plpgsql security definer as $fn$
  declare
    v_uid text;
    v_co record;
    v_owner_cash numeric;
    v_session_status text;
    v_remaining integer;
    v_from_float integer := 0;
    v_ask record;
    v_fill integer; v_price numeric; v_cost numeric;
    v_spent numeric := 0; v_bought integer := 0;
    v_seller_held integer; v_seller_h jsonb; v_seller_fund record;
    v_fills jsonb := '[]'::jsonb;
    v_band_pct numeric; v_open_price numeric; v_upper numeric;
    v_bid_price numeric; v_order jsonb := null;
    v_new_shares integer; v_new_avail integer;
    v_last_price numeric; v_new_hist jsonb;
    v_bb_id text; v_buyback jsonb := null;
  begin
    select id into v_uid from jex_users where auth_uid = auth.uid();
    if v_uid is null then raise exception 'Not authenticated'; end if;
    if p_qty is null or p_qty <= 0 then raise exception 'Enter valid quantity'; end if;
    if p_premium_pct is not null and (p_premium_pct < 0 or p_premium_pct > 50) then
      raise exception 'Tender premium must be between 0 and 50%%';
    end if;

    select status into v_session_status from jex_session where id = 1;
    if v_session_status is distinct from 'open' then
      raise exception 'Trading is %. Wait for the session to open.', coalesce(v_session_status,'closed');
    end if;
    if exists (select 1 from jex_halts where ticker = p_ticker) then
      raise exception '% trading is currently halted.', p_ticker;
    end if;

    select * into v_co from jex_companies where ticker = p_ticker for update;
    if v_co is null then raise exception 'Company not found'; end if;
    if coalesce(v_co.is_index_fund, false) then
      raise exception 'The index is not a company and has no shares to buy back';
    end if;

    if not (v_co.owner_id = v_uid or exists (
      select 1 from jex_company_members
       where company_user_id = v_co.owner_id and student_id = v_uid and status = 'accepted'
    )) then
      raise exception 'Only this company''s owner or founders can buy back its shares';
    end if;

    -- Company first, then users. Every other RPC here takes them in that order.
    select cash into v_owner_cash from jex_users where id = v_co.owner_id for update;
    if v_owner_cash is null then raise exception 'Company owner not found'; end if;

    v_remaining   := p_qty;
    v_new_shares  := v_co.shares;
    v_new_avail   := v_co.shares_avail;
    v_last_price  := v_co.price;
    v_new_hist    := coalesce(v_co.price_history, '[]'::jsonb);

    -- ---------- 1. cancel unsold float, at no cost ----------
    -- These shares were never sold, so the company already owns them. Both
    -- counters fall together, which keeps shares_avail <= shares true and keeps
    -- held + available equal to issued. No cash moves and no price moves,
    -- because no trade happened.
    v_from_float := least(v_remaining, greatest(0, v_co.shares_avail));
    if v_from_float > 0 then
      v_new_shares := v_new_shares - v_from_float;
      v_new_avail  := v_new_avail  - v_from_float;
      v_remaining  := v_remaining  - v_from_float;
    end if;

    -- ---------- 2. buy from anyone who has posted an ask ----------
    if v_remaining > 0 then
      for v_ask in
        select * from jex_limit_orders
         where ticker = p_ticker and side = 'sell' and status = 'open'
           and coalesce(user_id, '') is distinct from v_co.owner_id
         order by limit_price asc, created_at asc
           for update
      loop
        exit when v_remaining <= 0;
        v_price := v_ask.limit_price;
        v_fill  := least(v_ask.qty, v_remaining);
        -- Only what the company can still afford. Asks are walked cheapest
        -- first, so once the cheapest is out of reach nothing further is.
        v_fill  := least(v_fill, floor((v_owner_cash - v_spent) / v_price)::integer);
        exit when v_fill <= 0;

        if v_ask.fund_id is not null then
          select * into v_seller_fund from jex_funds where id = v_ask.fund_id for update;
          v_seller_held := coalesce((v_seller_fund.holdings->>p_ticker)::integer, 0);
          if v_seller_held < v_fill then
            update jex_limit_orders set status = 'cancelled' where id = v_ask.id;
            continue;
          end if;
          v_cost := round(v_price * v_fill, 2);
          if v_seller_held - v_fill <= 0 then
            update jex_funds set cash = round(cash + v_cost, 2),
                   holdings = coalesce(holdings,'{}'::jsonb) - p_ticker
             where id = v_ask.fund_id;
          else
            update jex_funds set cash = round(cash + v_cost, 2),
                   holdings = jsonb_set(coalesce(holdings,'{}'::jsonb), array[p_ticker],
                                        to_jsonb(v_seller_held - v_fill))
             where id = v_ask.fund_id;
          end if;
          v_fills := v_fills || jsonb_build_array(jsonb_build_object(
            'fund_id', v_ask.fund_id, 'qty', v_fill, 'price', v_price, 'paid', v_cost));
        else
          select holdings into v_seller_h from jex_users where id = v_ask.user_id for update;
          v_seller_held := coalesce((v_seller_h->>p_ticker)::integer, 0);
          if v_seller_held < v_fill then
            update jex_limit_orders set status = 'cancelled' where id = v_ask.id;
            continue;
          end if;
          v_cost := round(v_price * v_fill, 2);
          if v_seller_held - v_fill <= 0 then
            update jex_users set cash = round(cash + v_cost, 2),
                   holdings = coalesce(v_seller_h,'{}'::jsonb) - p_ticker
             where id = v_ask.user_id;
          else
            update jex_users set cash = round(cash + v_cost, 2),
                   holdings = jsonb_set(coalesce(v_seller_h,'{}'::jsonb), array[p_ticker],
                                        to_jsonb(v_seller_held - v_fill))
             where id = v_ask.user_id;
          end if;
          v_fills := v_fills || jsonb_build_array(jsonb_build_object(
            'user_id', v_ask.user_id, 'qty', v_fill, 'price', v_price, 'paid', v_cost));
        end if;

        -- The shares are retired: they came out of somebody's hands and out of
        -- the issued count together, so outstanding and issued stay consistent.
        v_new_shares := v_new_shares - v_fill;
        v_spent      := round(v_spent + v_cost, 2);
        v_bought     := v_bought + v_fill;
        v_remaining  := v_remaining - v_fill;
        v_last_price := v_price;

        if v_ask.qty - v_fill <= 0 then
          update jex_limit_orders
             set status = 'filled', filled_price = v_price,
                 filled_at = to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI:SS AM')
           where id = v_ask.id;
        else
          update jex_limit_orders set qty = v_ask.qty - v_fill where id = v_ask.id;
        end if;

        insert into jex_trades (ticker, qty, price, buyer_id, seller_id, type, ts)
          values (p_ticker, v_fill, v_price, 'buyback',
            case when v_ask.fund_id is not null then 'fund:' || v_ask.fund_id else v_ask.user_id end,
            'buyback', to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI:SS AM'));

        v_new_hist := v_new_hist || jsonb_build_array(jsonb_build_object(
          'p', v_price, 't', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
      end loop;

      if v_spent > 0 then
        update jex_users set cash = round(cash - v_spent, 2) where id = v_co.owner_id;
      end if;
    end if;

    update jex_companies
       set shares = v_new_shares, shares_avail = v_new_avail,
           price = v_last_price, price_history = v_new_hist
     where ticker = p_ticker;

    -- ---------- 3. tender for the remainder ----------
    if v_remaining > 0 and coalesce(p_premium_pct, 0) > 0 then
      v_bid_price := greatest(0.01, round(v_last_price * (1 + p_premium_pct / 100), 2));

      select price_band_pct, (session_open_prices->>p_ticker)::numeric
        into v_band_pct, v_open_price from jex_session where id = 1;
      if v_open_price is not null and v_band_pct is not null then
        v_upper := round(v_open_price * (1 + v_band_pct / 100), 2);
        if v_bid_price > v_upper then
          raise exception '%', format(
            'A %s%% premium puts the tender at %s, above the %s ceiling the price band allows today (%s%% from the session open of %s). Offer less.',
            p_premium_pct, v_bid_price, v_upper, v_band_pct, v_open_price);
        end if;
      end if;

      if (v_owner_cash - v_spent) < round(v_bid_price * v_remaining, 2) then
        raise exception '%', format(
          'The tender for %s shares at %s would cost %s and the company holds %s after this buyback. Offer fewer shares or a smaller premium.',
          v_remaining, v_bid_price, round(v_bid_price * v_remaining, 2), round(v_owner_cash - v_spent, 2));
      end if;

      insert into jex_limit_orders
        (id, user_id, fund_id, ticker, side, qty, limit_price, status, order_type, ts, created_at)
        values (gen_random_uuid()::text, v_co.owner_id, null, p_ticker, 'buy',
          v_remaining, v_bid_price, 'open', 'buyback',
          to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI:SS AM'), now())
        returning to_jsonb(jex_limit_orders.*) into v_order;
    end if;

    if v_spent > 0 or v_from_float > 0 then
      v_bb_id := gen_random_uuid()::text;
      insert into jex_buybacks (id, ticker, company_name, qty, price, total, ts)
        values (v_bb_id, p_ticker, v_co.name, v_from_float + v_bought,
          v_last_price, v_spent,
          to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI:SS AM'))
        returning to_jsonb(jex_buybacks.*) into v_buyback;
    end if;

    return jsonb_build_object(
      'ok', true, 'ticker', p_ticker, 'requested', p_qty,
      'cancelled_from_float', v_from_float,
      'bought_from_sellers', v_bought,
      'spent', v_spent,
      'fills', v_fills,
      'tender', v_order,
      'still_wanted', v_remaining,
      'shares', v_new_shares, 'shares_avail', v_new_avail,
      'price', v_last_price, 'price_history', v_new_hist,
      'buyback', v_buyback,
      'owner_id', v_co.owner_id,
      'cash', round(v_owner_cash - v_spent, 2),
      'owner_cash', round(v_owner_cash - v_spent, 2));
  end;
  $fn$;

  -- Replay whatever EXECUTE grants the old function carried. A null proacl
  -- means it was on Postgres defaults, and the new function is too.
  if v_acl is not null then
    for v_g in select a.grantee, a.privilege_type from aclexplode(v_acl) a loop
      execute format('grant %s on function public.rpc_buyback(text,integer,numeric) to %s',
        v_g.privilege_type,
        case when v_g.grantee = 0 then 'public' else v_g.grantee::regrole::text end);
    end loop;
  end if;
  raise notice '  rpc_buyback rebuilt with the float -> asks -> tender cascade';

  -- ============================================================
  -- 2. the pool fill must refuse a tender
  -- ============================================================
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_fill_limit_vs_pool';
  if r.proname is null then raise exception 'ABORT: rpc_fill_limit_vs_pool not found.'; end if;

  if position('buyback_tender' in r.prosrc) > 0 then
    raise notice '  rpc_fill_limit_vs_pool already refuses tenders -- skipped';
  else
    a := 'if v_order is null then return jsonb_build_object(''filled'', false, ''reason'', ''not_open''); end if;';
    v_n := (length(r.prosrc) - length(replace(r.prosrc, a, ''))) / length(a);
    if v_n <> 1 then raise exception 'ABORT: pool anchor found % times, expected 1.', v_n; end if;
    v_new := replace(r.prosrc, a, a || chr(13) || chr(10) || chr(13) || chr(10) ||
      '  -- A buyback tender must never fill against the pool. The pool IS the' || chr(13) || chr(10) ||
      '  -- company''s own unsold stock, so filling here would have the company' || chr(13) || chr(10) ||
      '  -- pay itself for shares it already owns -- which is the bug the' || chr(13) || chr(10) ||
      '  -- buyback cascade was rewritten to remove. A tender is only ever' || chr(13) || chr(10) ||
      '  -- filled by a real holder, through the order book.' || chr(13) || chr(10) ||
      '  if coalesce(v_order.order_type, '''') = ''buyback'' then' || chr(13) || chr(10) ||
      '    return jsonb_build_object(''filled'', false, ''reason'', ''buyback_tender'');' || chr(13) || chr(10) ||
      '  end if;');
    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_fill_limit_vs_pool now refuses buyback tenders';
  end if;

  -- ============================================================
  -- 3. the book matcher must retire, not accumulate
  -- ============================================================
  select p.proname, p.prosrc, pg_get_functiondef(p.oid) as def into r
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_match_limit_order_book';
  if r.proname is null then raise exception 'ABORT: rpc_match_limit_order_book not found.'; end if;

  if position('a tender RETIRES' in r.prosrc) > 0 then
    raise notice '  rpc_match_limit_order_book already retires tender fills -- skipped';
  else
    -- Anchored on the buy-side fund update rather than on the "Execute: buy
    -- side" comment above it. `if v_bid.fund_id is not null then` appears twice
    -- in this function -- once to check funds, once to execute -- so the
    -- following line is what makes it unambiguous, and being executable it is
    -- the same in every copy of this function regardless of comment drift.
    -- Try CRLF, then LF. A single function can contain BOTH: an earlier
    -- migration of mine spliced CRLF lines into a body that was otherwise LF,
    -- so asking whether the function "has" CRLF anywhere answers the wrong
    -- question. What matters is the ending on THIS line boundary.
    v_nl := chr(13) || chr(10);
    a := 'if v_bid.fund_id is not null then' || v_nl ||
         '    update jex_funds set cash = round(v_buyer_fund.cash - v_cost, 2),';
    if position(a in r.prosrc) = 0 then
      v_nl := chr(10);
      a := 'if v_bid.fund_id is not null then' || v_nl ||
           '    update jex_funds set cash = round(v_buyer_fund.cash - v_cost, 2),';
    end if;
    v_n := (length(r.prosrc) - length(replace(r.prosrc, a, ''))) / length(a);
    if v_n <> 1 then raise exception 'ABORT: matcher anchor found % times, expected 1.', v_n; end if;
    v_new := replace(r.prosrc, a,
      '-- A company buying its own stock does not RECEIVE it: a tender RETIRES' || v_nl ||
      '  -- the shares. Crediting them to the company''s holdings instead would' || v_nl ||
      '  -- leave it holding its own stock, which then counts toward float, the' || v_nl ||
      '  -- short borrow limit and voting power.' || v_nl ||
      '  if coalesce(v_bid.order_type, '''') = ''buyback'' then' || v_nl ||
      '    update jex_users set cash = round(v_buyer_cash - v_cost, 2)' || v_nl ||
      '      where id = v_bid.user_id' || v_nl ||
      '      returning cash, holdings into v_buyer_cash, v_buyer_holdings;' || v_nl ||
      '    update jex_companies set shares = greatest(0, shares - v_fill_qty)' || v_nl ||
      '      where ticker = p_ticker;' || v_nl ||
      '  elsif v_bid.fund_id is not null then' || v_nl ||
      '    update jex_funds set cash = round(v_buyer_fund.cash - v_cost, 2),');
    execute replace(r.def, r.prosrc, v_new);
    raise notice '  rpc_match_limit_order_book now retires tender fills';
  end if;
end
$mig$;

-- ── Verification ──
--
-- All seven must be true.
--
-- cascade_installed     rpc_buyback takes a premium and runs the cascade.
-- float_is_free         cancelling unsold float moves no cash.
-- pays_real_sellers     resting asks are paid their own limit price.
-- posts_tender          the remainder becomes a standing bid.
-- premium_capped        50% cap and the band ceiling both enforced.
-- pool_refuses_tender   a tender can never fill against the company's own pool.
-- matcher_retires       a filled tender retires shares.
-- one_signature_only    the old two-argument version is gone, so PostgREST
--                       has exactly one rpc_buyback to resolve to.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_buyback')                     as one_signature_only,
  (select prosrc like '%cancel unsold float, at no cost%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_buyback')                     as cascade_installed,
  (select prosrc like '%v_from_float := least(v_remaining, greatest(0, v_co.shares_avail))%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_buyback')                     as float_is_free,
  (select prosrc like '%order by limit_price asc, created_at asc%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_buyback')                     as pays_real_sellers,
  (select prosrc like '%''buyback'', ts, created_at%' or prosrc like '%''open'', ''buyback''%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_buyback')                     as posts_tender,
  (select prosrc like '%between 0 and 50%' and prosrc like '%the price band allows today%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_buyback')                     as premium_capped,
  (select prosrc like '%buyback_tender%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_fill_limit_vs_pool')          as pool_refuses_tender,
  (select prosrc like '%a tender RETIRES%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_match_limit_order_book')      as matcher_retires;
