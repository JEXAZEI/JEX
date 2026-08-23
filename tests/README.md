# JEX regression tests

There are two harnesses. Run both.

```
node tests/run.js                      # the Node suites (fast, no browser)
node tests/run.js beta pnl             # only suites whose filename matches
node tests/test_beta.js                # a single suite directly

node tests/browser/run.js              # the real page in headless Chromium
node tests/browser/run.js --only=empty # one scenario
node tests/browser/run.js --keep       # leave the generated page for inspection
```

The Node suites are pure Node — no browser, no network, no database, no
dependencies — so they run anywhere `node` does, including a fresh clone.
The browser harness needs Chromium under `/opt/pw-browsers` and takes about
two minutes for all nine scenarios.

## How they work

Each suite reads `app.js`, extracts the function under test by name, and
evaluates it against mocked dependencies (`DB`, `sb`, `getUser`, DOM stubs,
and so on). That means they exercise the **real shipped code** rather than a
copy that can drift — but it also has hard limits, below.

A few suites instead assert against the source text directly (that a query
carries a `LIMIT`, that no raw `sb.post` survives). Those guard decisions
that would otherwise be re-broken silently by a future edit.

## What each suite covers

| suite | guards |
|---|---|
| `test_pnl_adversarial` | P&L attribution: trades walked oldest-first, short legs kept out of the long cost basis, average cost, missing opening legs |
| `test_nwstats` | net-worth history ordering (by `created_at`, not the `ts` display string), VaR percentile over all changes, Sharpe epsilon guard |
| `test_beta` | portfolio beta = cov/var against time-aligned index readings; returns null rather than a fake 1.0 |
| `test_maxqty_fix` | the Max button solves for the impact-adjusted price, never overshooting cash |
| `test_index_adjust` | a dilution does not move the index; client and server agree on basket value |
| `test_dividend_conservation` | the JXI pass-through charges only for units that get paid |
| `test_dividend_race` | dividend payouts come from one consistent snapshot, so debited == distributed |
| `test_buyback` | the company is debited, not whoever clicked |
| `test_dilution` | dilution requests go through the RPC; client guards short-circuit first |
| `test_snapshotnw` | net-worth snapshots are server-derived and can only be taken for the caller |
| `test_raw_writes` | no raw table write survives; no forgeable field is sent |
| `test_overfetch` | split boot queries are true partitions — no row in both halves, none in neither |
| `test_async_forms` | `busy()` double-submit guard, and draft save/restore/expiry |
| `test_busy_wiring` | every wrapped `onclick` parses as JS and calls a promise-returning handler |
| `test_xss` | user text escaped at every render site, and no free text passed through an inline handler |
| `test_404` | the 404 page is self-contained (it is served for any depth, so relative asset paths would break) |
| `test_leaderboard` | a frozen snapshot never resurrects a removed student |
| `test_boot_render` | boot always reaches a rendered screen, never a permanent splash |
| `test_realtime` | repaints carry typed input instead of being blocked; coalescing and reconnect backoff |
| `test_deadlock_retry` | sb.rpc retries a Postgres deadlock (guaranteed rolled back) and NOTHING else — a lost response is never repeated |
| `test_networth` | net worth is flat when a student moves their own money (buy, short, fund deposit) and moves only when the market does |
| `test_time` | Arizona time: wall-clock vs instant, the server's `ts` display format, day rollover, no DST — every case run in four timezones |

## The browser harness (`tests/browser/`)

`stub.js` fakes Supabase — it intercepts `window.fetch` for PostgREST and
RPCs, replaces `WebSocket` with one that pushes real `postgres_changes`
frames, and supplies `Chart` and `emailjs` locally (the CDN copies cannot
load in a sandbox, and a hanging script tag means the load event never
fires). `harness.html` is `index.html` with those script tags removed and the
stub injected. `run.js` serves the tree, launches headless Chromium once per
scenario, and reads the result back over an XHR POST.

Scenarios, each a transform of the seeded exchange:

| scenario | state |
|---|---|
| `default` | a mid-semester classroom, driven end to end: every page, every admin tab as the role that owns it, XSS payloads, realtime events, drafts, `busy()`, and the real student trading flows |
| `default-sweep` | the same exchange, swept for render failures and audited handler by handler |
| `empty` | day one: no companies, no trades, no history, session closed |
| `closed` | trading closed |
| `halted` | a halted ticker and a live circuit-breaker cooldown |
| `newstudent` | someone who joined today — no holdings, no history, no snapshots |
| `classes` | a company split into share classes |
| `ragged` | schema-legal nulls, an empty name, a zero price, a negative balance |
| `mobile` | the default run at a phone-sized viewport (the bottom-nav branch) |
| `tz-utc` | the default run with the DEVICE in UTC |
| `tz-tokyo` | the default run with the device in Asia/Tokyo, a day ahead of Arizona |

The two timezone scenarios exist because every Arizona-time bug found so far
was invisible from Arizona. The app declares itself on Arizona time -- the
schedule, the session clock, every server-written timestamp -- so a student at
home, or a laptop whose clock was never set, is the case that exposes anything
still reading the device's own zone.

One trap when adding driver steps: the driver lives inside a JS template
literal, where an unrecognized escape like `\d` collapses to a bare `d`. A
regex written with `\d` still compiles, still runs, and simply never matches --
a test that cannot fail. Write driver regexes without backslash escapes
(`[0-9]`, not `\d`); `run.js` lints the generated driver for eaten escapes and
refuses to launch if it finds one, and syntax-checks it so a quoting slip
reports immediately instead of as a 150-second hang.

The `default` scenario fires the flows a student actually uses -- buy, sell,
short, cover, watchlist, limit order, vote -- through the real handlers, and
checks the numbers that come back. `stub.js` reimplements the server's
arithmetic for those paths (the same impact curve, the same 150% short
collateral, the same rounding) so a buy can be asserted to move cash,
holdings, `shares_avail` and the price consistently, and a cover to release
exactly the collateral it locked plus its P&L. That verifies the CLIENT --
that it applies what it is handed, that its own pre-checks fire before
anything reaches the server, and that a rejection becomes a message rather
than a crash. It is not a test of the SQL, which runs in Postgres and is
never executed here.

Orders are paced 1.8s apart on purpose: `checkRateLimit()` allows at most 3
in any 5s window, and firing them back to back is what it exists to stop. The
limiter has its own check rather than only being worked around.

Two checks in the sweep are worth calling out because they find things
reading cannot. Every page is rendered for every seeded user and every tab,
individually, so one throwing page does not hide the rest. And every inline
handler in the rendered DOM is parsed with `new Function` and its called
identifiers resolved — which catches both a handler broken by quoting in
user data and one calling a function that no longer exists. Resolution uses
`typeof <name>` evaluated in global scope, not `window[name]`: `app.js` is a
classic script, so its top-level `const`/`let` names (`get`, `esc`, …) are
reachable from handlers but never appear as window properties.

## The lock order (server-side invariant)

Not enforced by any test here — the SQL lives in Postgres and never runs in
this repo — but recorded because breaking it is silent until a class hits it.

**Every money-moving RPC locks `jex_companies` before `jex_users`.**

The trade RPCs used to do the opposite: lock the caller's `jex_users` row via
`auth_uid = auth.uid() for update`, then the company. `rpc_pay_dividend` and
`rpc_buyback` go companies-first and cannot do otherwise — a dividend does not
know which holders to lock until it has read the company. Opposite orders on
the same two rows is a deadlock, and the collision was the ordinary one:

    student:   lock jex_users[S]         -> waits for jex_companies[ACME]
    dividend:  lock jex_companies[ACME]  -> waits for jex_users[S]

Postgres detects it and aborts one side — nothing is corrupted — but the
student sees a raw "deadlock detected" and their trade did not happen.

Two rules follow, for anyone editing these functions:

1. Resolve `auth.uid()` **without** a lock. Lock the company, then the user
   row, then RE-READ cash/holdings/shorts under that lock. Reading balances
   before the lock and writing after it computes against a stale balance.
2. When a function writes more than one `jex_users` row (`rpc_trade_buy`
   credits the company's owner as well as debiting the buyer), lock them in a
   deterministic id order, or two company accounts trading each other's stock
   can deadlock on the user tier alone.

Verify with `regexp_matches(pg_get_functiondef(oid), 'from\s+(jex_\w+)[^;]*?for update', 'g')`
— the first element must be `jex_companies`. Do **not** verify by searching for
where a table name first appears in the text; that finds comments and unlocked
selects and reports the same answer for every function.

Known residual: `rpc_pay_dividend` walks its holder list in JSONB order, so two
simultaneous dividends with overlapping shareholders can still deadlock on the
holder tier. `sb.rpc()` retries that one error (see `test_deadlock_retry`),
which is safe only because Postgres guarantees a deadlock victim rolled back
completely.

## The price band (server-side invariant)

Also not enforced from here — same reason — and also recorded because it was
wrong for a long time in a way nothing surfaced.

**Two rules, and the asymmetry between them is deliberate.**

1. **Sell side clamps.** `rpc_trade_sell`, `rpc_trade_short`,
   `rpc_trade_cover_short`, `rpc_fund_sell`, and *both* fund functions'
   constituent loops call `jex_band_clamp(ticker, proposed, current)`. The order
   always executes; the price stops at the band edge.
2. **Buy side rejects.** `rpc_trade_buy`, `rpc_buyback`,
   `rpc_place_limit_order`, `rpc_fill_limit_vs_pool`, `rpc_fund_buy` raise.

They differ because refusing a buy costs a student an opportunity, while
refusing a sell costs them the exit — a holder of a stock sitting at the floor
would find every sell refused at every size, since every sell pushes it lower.

Three things that are easy to get wrong, all of which were:

- **The band was buy-side only.** Every upward path checked it; no downward one
  did. Severity was smaller than it sounds — the circuit breaker is symmetric
  (`Math.abs`, default 20%) and trips *before* the 30% band — but the breaker is
  reactive and the band preventive, so a single large sell could overshoot the
  breaker threshold and the overshoot stood.
- **The fund functions' CONSTITUENT loops were missed on both sides.** A fund
  purchase or redemption moves every underlying holding's price too.
  `rpc_fund_buy` looked covered because it bands its own ticker.
- **Reject asked the wrong question.** `if p > v_upper or p < v_lower` asks "is
  the result outside the band", not "does this order make things worse". A buy
  on a stock already below the floor moves it *toward* the band and was refused
  for it — and since the clamp correctly holds a below-floor stock rather than
  pushing it lower, nothing anyone did could move the price. The ticker froze
  until the next session open recentred the baseline. Now:
  `if (p > v_upper and p > cur) or (p < v_lower and p < cur)`.

`jex_band_clamp` never moves a price back *into* the band: the floor for any
trade is `least(band_floor, current_price)`. A sell order that RAISED a price
would be a stranger bug than the one being fixed.

**A null `price_band_pct` means the instructor pressed Disable and there is no
band.** The SQL used to write `coalesce(v_band_pct,30)` and the client
`circuit_breaker_pct||20`, so both Disable buttons changed a label and nothing
else. `test_disable_controls` covers the client half; the SQL half is the
absence of any `coalesce(v_band_pct,`.

`bandClamp`/`bandLimits` in `app.js` mirror `jex_band_clamp` for the trade
preview only — `test_price_band` pins them together. If they drift, the preview
quotes a price the server will not fill at.

## What these do NOT cover

Worth being blunt about, because the gaps are where bugs will come from:

- **Nothing server-side.** Every `rpc_*` function lives in Postgres and is
  never executed here. The SQL was reviewed line by line against the live
  definitions, but its behaviour in production is unverified by this suite.
  Anything involving money — trades, dividends, fund withdrawals — is only
  half-covered: the client half.
- **Nothing visual.** The browser harness proves pages render, handlers
  resolve and state flows correctly. It cannot tell you the layout is right,
  the colours are legible, or a button is reachable on a real phone.
- **No real network or auth.** Supabase calls are stubbed in both harnesses;
  the Google OAuth round trip in particular is never exercised.
- **Charts are stubbed.** `Chart` records the config it was handed; nothing
  is actually plotted, so a wrong axis or scale would not be caught.
- **No multi-client behaviour.** Races between two browsers are modelled
  arithmetically (see `test_dividend_race`), not actually raced.

## Adding a suite

Print `PASS: ...` / `FAIL: ...` lines and `process.exit(1)` on any failure —
`run.js` counts those lines and propagates the exit code. Copy the harness
from any existing suite.

One trap worth knowing: when extracting a function whose signature has a
default parameter (`function f(a, opts={})`), walk the parameter list to its
closing paren before looking for the body's `{`. Matching the first `{` after
the name grabs the default value instead and closes immediately.
