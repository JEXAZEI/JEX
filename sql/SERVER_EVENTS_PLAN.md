# Server-recorded events — rebuild plan

Approved: October 2026. Status is tracked at the bottom of this file.

## Why

The activity log and in-app notifications are written by students' browsers.
The app performs an action — a dividend, a fill, a halt — and then the browser
calls `rpc_log_activity` and `rpc_push_notification` to describe it. Whatever a
browser can describe, a student can describe falsely.

The guards already shipped limit the damage: entries record who wrote them
(`activity_log_guard.sql`), email carries no student-written text and officer
types are officer-only (`push_notification_guard.sql`). But a plausible false
entry or notice is still possible. This rebuild removes the possibility.

## The rule

**The server function that performs an action records it.** In the same
transaction, it writes the log entry and sends the notifications, with text
built from what it actually did. The browser stops sending them. When every
action does this, students lose access to `rpc_log_activity` and
`rpc_push_notification` entirely.

## Shared pieces (step 0)

- `jex_log(type, description, ticker, subject_id, subject_name, amount)` —
  internal, not granted to anon or authenticated. The chain logic from
  `activity_log_guard.sql`: advisory lock, `clock_timestamp()`, writer in the
  hash. The writer is the account whose action it was.
- `jex_notify(user_id, type, message, ticker)` — internal. The email rules from
  `push_notification_guard.sql`.
- `rpc_server_events()` — returns the names of the server functions that now
  record their own events. The page skips its own log/notification call for
  those, so every batch ships page-first with no duplicates and no gap, and the
  SQL can run any time after.

Wording stays word-for-word what the page sends today.

## Batches

### 1 — money and positions (11)

| server function | records | page function today |
| --- | --- | --- |
| `admin_adjust_cash` | balance_adj | adjustCash, adjustCompanyCash |
| `rpc_fund_deposit` | fund_deposit | depositToFund |
| `rpc_fund_withdraw` | fund_withdraw | withdrawFromFund |
| `rpc_pay_dividend` | dividend + holder notices | issueDividend, reviewDivApproval |
| `rpc_fill_limit_vs_pool` | limit_fill + notice | checkLimitOrders |
| `rpc_match_limit_order_book` | limit_fill + notices | checkLimitOrders |
| `rpc_trigger_stop_loss` | stop_loss + notice | checkStopLossOrders |
| `rpc_margin_call_short` | margin_call + notice | checkMarginCalls |
| `rpc_margin_call_fund_short` | margin_call + manager notice | checkMarginCalls |
| `rpc_convert_share_class` | class_convert | convertShareClass |
| `rpc_adjust_stock_price` | price_adj + holder/all notices | adjustStockPrice |

### 2 — officer and market control (15)

`rpc_admin_save_session` (session open/close, practice mode, officer notices),
`rpc_expire_day_orders`, `rpc_admin_halt_stock`, `rpc_admin_resume_stock`,
`rpc_admin_delist_company`, `rpc_admin_relist_company`, `rpc_review_delisting`,
`rpc_review_ipo`, `rpc_review_class_application`,
`rpc_admin_remove_share_class`, `approve_registration`,
`rpc_admin_restore_snapshot`, `rpc_post_minutes`, `rpc_post_announcement`,
`rpc_admin_resolve_flag`.

Also here: the **short-squeeze alert** moves to the server — checked when a
price moves, sent once per company per day (a per-company date column claimed
atomically), replacing the per-browser check that sent one copy per open tab.

### 3 — company and student actions (19)

`rpc_post_vote`, `rpc_close_vote`, `rpc_post_news`, `rpc_post_financials`,
`rpc_send_founder_invite`, `rpc_respond_to_invite`, `rpc_remove_founder`,
`rpc_request_founder_allocation`, `rpc_review_founder_allocation`,
`rpc_submit_class_application`, `rpc_request_delisting`,
`rpc_request_dividend_approval`, `rpc_reject_dividend_approval`,
`rpc_flag_account`, `rpc_submit_bug_report`, `rpc_create_fund`,
`rpc_place_limit_order`, `rpc_trigger_price_alert`,
`rpc_activate_after_hours_orders`.

### 4 — close the doors

Revoke `rpc_log_activity` and `rpc_push_notification` from anon and
authenticated — **server only**, not even officers. Remove the page code that
called them and the `rpc_server_events()` switch.

## Decisions

| question | decision |
| --- | --- |
| short-squeeze alert | move to the server, once per company per day |
| who may write log entries / notices afterwards | the server only |
| log ordinary buys and sells | no — they are in `jex_trades`; one entry per trade would bury the log |

## Per batch

1. Read-only query: the batch's live function bodies and fingerprints.
2. Rebuild them on a local Postgres 17, matching production.
3. Migration that refuses to run unless every fingerprint matches.
4. Tests: each action records exactly one entry and the right notices, nothing
   twice, money and shares move exactly as before.
5. Page update first (works with either server), then the SQL, then its
   verification pasted back.

## Status

- [x] step 0 + batch 1 — `server_events_batch1.sql`, run October 2026: all
  eleven record their own events, the page was told about all eleven, no helper
  callable from the web. Tested first on a Postgres 17 copy of production's
  bodies: money and shares identical before and after, chain intact under 8
  parallel writers (1,312 entries, 0 forks), wording identical to the page's.
  Changes found along the way: instant fills are now logged (the page never
  did) but don't notify; Treasurer-approved dividends carry the full holder
  message and name the company's owner.
- [x] batch 2 (with the short-squeeze alert) — `server_events_batch2.sql`, run
  October 2026: all fifteen record their own events, the page told about 27
  functions, no helper callable from the web, the squeeze check open to
  signed-in users only. Its first run failed harmlessly (`_b2_plan does not
  exist`): the SQL editor does not promise separate statements share a
  connection, so a temporary table made by one was gone for the next. The plan
  moved inside the block, and a test now refuses temporary tables in any
  migration. Tested on a Postgres 17 copy of production's exact bodies: every
  table identical before and after, wording identical to the page's, one entry
  for 8 simultaneous session opens, one squeeze alert for 8 simultaneous
  checks, not emailed. Changes found along the way: a session change is
  recorded however it was made and only when the status really changes; a
  circuit-breaker halt or resume is logged as the system's; squeeze short
  interest counts funds' shorts.
- [x] batch 3 — `server_events_batch3.sql`, run October 2026: all eighteen
  record their own events, the page told about 46 functions, no helper
  callable from the web, the news notice open to signed-in users only.
  `check_server_events.sql` the same day: nothing written twice, no chain
  breaks -- and no activity at all yet, so the live firing is still to be
  seen. Tested first on a Postgres 17 copy of production's exact bodies:
  every table identical apart from the news claim column, wording identical
  to the page's. Changes found along the way: the news box became
  rpc_notify_news_holders; companies are named by their base listing; a
  fund's order reads "Growth Fund placed...".
- [ ] batch 4
