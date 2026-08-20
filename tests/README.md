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
| `default` | a mid-semester classroom, driven end to end: every page, every admin tab as the role that owns it, XSS payloads, realtime events, drafts, `busy()`, a real market buy |
| `default-sweep` | the same exchange, swept for render failures and audited handler by handler |
| `empty` | day one: no companies, no trades, no history, session closed |
| `closed` | trading closed |
| `halted` | a halted ticker and a live circuit-breaker cooldown |
| `newstudent` | someone who joined today — no holdings, no history, no snapshots |
| `classes` | a company split into share classes |
| `ragged` | schema-legal nulls, an empty name, a zero price, a negative balance |
| `mobile` | the default run at a phone-sized viewport (the bottom-nav branch) |

Two checks in the sweep are worth calling out because they find things
reading cannot. Every page is rendered for every seeded user and every tab,
individually, so one throwing page does not hide the rest. And every inline
handler in the rendered DOM is parsed with `new Function` and its called
identifiers resolved — which catches both a handler broken by quoting in
user data and one calling a function that no longer exists. Resolution uses
`typeof <name>` evaluated in global scope, not `window[name]`: `app.js` is a
classic script, so its top-level `const`/`let` names (`get`, `esc`, …) are
reachable from handlers but never appear as window properties.

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
