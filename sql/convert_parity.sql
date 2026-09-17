-- ============================================================
-- convert_parity.sql
--
-- WRITES. Replaces rpc_convert_share_class. Aborts and changes nothing on any
-- mismatch. Re-running is a no-op with a clear message.
--
-- ── What is wrong ──
--
-- A convertible share class and its parent are two separate tickers with two
-- separate prices, each moved independently by its own trading. The conversion
-- ratio between them is fixed. So the moment the two prices drift apart, the
-- swap is worth money, and rpc_convert_share_class has no price check in it at
-- all -- it reads the ratio, retires the class shares, issues the base shares,
-- and never looks at what either one is worth.
--
-- Run end to end on a copy of your database against your real trade functions,
-- with a ratio-5 class trading at $10 while the parent traded at $30:
--
--     bought 20 ACME.B on the open market      -$202.40
--     converted 20 x 5  ->  100 ACME                $0
--     sold 100 ACME                          +$2,957.00
--     ------------------------------------------------
--     profit, one cycle, from $10,000 of cash  +$2,754.60
--
-- The system money supply did not change by a cent, which is what makes this
-- easy to miss: nothing is minted. It is a transfer, and it comes out of the
-- company owner's cash when the converted shares are sold back. It repeats up
-- to the limit of the class's available float.
--
-- The comment sitting above the swap says share counts move but market cap does
-- not, "because p_qty class shares were worth p_qty * ratio base shares". That
-- is true only at parity. Nothing holds the two prices at parity. Classes are
-- created at parity -- the review screen lists a new class at parent.price *
-- ratio -- so parity is plainly the intent; independent trading is what breaks
-- it, and there is nothing in the system that pushes it back.
--
-- ── The fix ──
--
-- The conversion is refused while it would create value, with the arithmetic in
-- the message so the holder can see exactly why and what would have to change.
--
-- In a real market this situation cannot persist: the arbitrage IS the
-- mechanism that bids the class back to parity, which is why a convertible
-- never trades below its conversion value for long. Nothing in this exchange
-- performs that correction -- converting moves neither price -- so the
-- mispricing sits there paying out over and over. Refusing is the smallest
-- change that closes it completely.
--
-- What this costs: while the class trades at a discount, holders cannot convert
-- at all. That is a real limitation and worth knowing about rather than
-- discovering. The alternative that removes it is to stop quoting a convertible
-- class independently and derive its price from the parent -- the same thing I
-- did to JXI, for the same structural reason -- and that is a larger change
-- than this one.
--
-- Converting at a LOSS is deliberately still allowed. Giving up market value to
-- get voting rights is a real decision and it belongs to the holder.
--
-- The check is placed before the holder's row is locked, so a refused
-- conversion takes no user lock at all.
--
-- ── Method ──
--
-- One executable anchor, asserted to occur EXACTLY once before replace(); the
-- function is rebuilt from its own catalog signature so nothing is retyped; the
-- body goes through quote_literal() rather than nested dollar quoting.
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
   where n.nspname = 'public' and p.proname = 'rpc_convert_share_class';

  if r.proname is null then
    raise exception 'ABORT: rpc_convert_share_class not found. Nothing changed.';
  end if;

  if position('created out of nothing' in r.prosrc) > 0 then
    raise notice 'rpc_convert_share_class already checks parity -- nothing to do.';
    return;
  end if;

  a := 'select coalesce(holdings, ''{}''::jsonb) into v_h from jex_users where id = v_uid for update;';
  v_n := (length(r.prosrc) - length(replace(r.prosrc, a, ''))) / length(a);
  if v_n <> 1 then
    raise exception 'ABORT: holdings anchor found % times, expected 1. Nothing changed.', v_n;
  end if;

  v_new := replace(r.prosrc, a,
    '-- A conversion must not create value out of nothing. The class and its' || chr(13) || chr(10) ||
    '  -- parent are separate tickers with separate prices and the ratio between' || chr(13) || chr(10) ||
    '  -- them is fixed, so whenever the class trades below ratio * parent the' || chr(13) || chr(10) ||
    '  -- swap simply hands the holder the difference -- paid, when they sell the' || chr(13) || chr(10) ||
    '  -- base shares back, out of the company owner''s cash.' || chr(13) || chr(10) ||
    '  --' || chr(13) || chr(10) ||
    '  -- Measured on a copy of this database with a ratio-5 class at $10 and the' || chr(13) || chr(10) ||
    '  -- parent at $30: 20 class shares bought for $202.40 became 100 base shares' || chr(13) || chr(10) ||
    '  -- sold for $2,957.00. A profit of $2,754.60 in one cycle, out of $10,000' || chr(13) || chr(10) ||
    '  -- of starting cash, repeatable to the limit of the class float. Nothing is' || chr(13) || chr(10) ||
    '  -- minted, which is why it is easy to miss -- it is a transfer.' || chr(13) || chr(10) ||
    '  --' || chr(13) || chr(10) ||
    '  -- In a real market this cannot persist: the arbitrage itself is what bids' || chr(13) || chr(10) ||
    '  -- the class back to parity, which is why a convertible does not trade' || chr(13) || chr(10) ||
    '  -- below its conversion value. Converting here moves neither price, so' || chr(13) || chr(10) ||
    '  -- nothing corrects it and the mispricing pays out over and over.' || chr(13) || chr(10) ||
    '  --' || chr(13) || chr(10) ||
    '  -- Converting at a LOSS stays allowed. Giving up market value for voting' || chr(13) || chr(10) ||
    '  -- rights is a real decision and it is the holder''s to make.' || chr(13) || chr(10) ||
    '  --' || chr(13) || chr(10) ||
    '  -- Half a cent of tolerance so ordinary rounding is not treated as a gain.' || chr(13) || chr(10) ||
    '  if v_class.price * p_qty < v_parent.price * v_new - 0.005 then' || chr(13) || chr(10) ||
    '    raise exception ''%'', format(' || chr(13) || chr(10) ||
    '      ''Converting %s %s (worth %s) would return %s %s (worth %s) -- a gain of %s created out of nothing, so it is refused. %s has to be trading at or above %s (%s x %s) for this swap to be even.'',' || chr(13) || chr(10) ||
    '      p_qty, p_ticker, round(v_class.price * p_qty, 2),' || chr(13) || chr(10) ||
    '      v_new, v_meta.parent_ticker, round(v_parent.price * v_new, 2),' || chr(13) || chr(10) ||
    '      round(v_parent.price * v_new - v_class.price * p_qty, 2),' || chr(13) || chr(10) ||
    '      p_ticker, round(v_parent.price * v_ratio, 2), v_ratio, v_parent.price);' || chr(13) || chr(10) ||
    '  end if;' || chr(13) || chr(10) || chr(13) || chr(10) ||
    '  ' || a);

  if v_new = r.prosrc then
    raise exception 'ABORT: rpc_convert_share_class was not modified. Nothing changed.';
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

  raise notice 'rpc_convert_share_class now refuses a conversion that would create value.';
end
$mig$;

-- ── Verification ──
--
-- refuses_free_value   the parity check is in.
-- checks_before_lock   and it runs before the holder's row is locked, so a
--                      refused conversion takes no user lock.
-- still_secdef         unchanged.
--
-- classes_now is the thing to actually read: every share class that exists,
-- what it is trading at, what parity would be, and the gain per share the swap
-- is worth right now. Any row with edge_per_share above zero is a live
-- mispricing that was extractable until this ran. If the list is empty, this
-- was a trap for later rather than a hole today.
select
  (select prosrc like '%created out of nothing%'
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_convert_share_class')        as refuses_free_value,
  (select position('created out of nothing' in prosrc)
        < position('into v_h from jex_users where id = v_uid for update' in prosrc)
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_convert_share_class')        as checks_before_lock,
  (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rpc_convert_share_class')        as still_secdef,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'class', sc.ticker, 'parent', sc.parent_ticker,
            'ratio', coalesce(sc.conversion_ratio, 1),
            'class_price', cc.price, 'parent_price', pc.price,
            'parity_price', round(pc.price * coalesce(sc.conversion_ratio, 1), 2),
            'edge_per_share', round(pc.price * coalesce(sc.conversion_ratio, 1) - cc.price, 2),
            'class_shares_held_by_students',
              (select coalesce(sum(coalesce((u.holdings->>sc.ticker)::numeric, 0)), 0)
                 from jex_users u))
          order by sc.ticker), '[]'::jsonb)
     from jex_share_classes sc
     join jex_companies cc on cc.ticker = sc.ticker
     join jex_companies pc on pc.ticker = sc.parent_ticker
    where sc.ticker <> sc.parent_ticker)                                     as classes_now;
