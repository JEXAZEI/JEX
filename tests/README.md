# JEX regression tests

```
node tests/run.js            # everything
node tests/run.js beta pnl   # only suites whose filename matches
node tests/test_beta.js      # a single suite directly
```

Pure Node. No browser, no network, no database, no dependencies — so it
runs anywhere `node` does, including a fresh clone.

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

## What these do NOT cover

Worth being blunt about, because the gaps are where bugs will come from:

- **Nothing server-side.** Every `rpc_*` function lives in Postgres and is
  never executed here. The SQL was reviewed line by line against the live
  definitions, but its behaviour in production is unverified by this suite.
  Anything involving money — trades, dividends, fund withdrawals — is only
  half-covered: the client half.
- **No real DOM.** Rendering, layout, event wiring and anything visual is
  mocked or asserted against source text, not exercised in a browser.
- **No real network, auth, or realtime.** Supabase calls are stubbed.
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
