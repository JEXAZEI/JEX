# Server migrations

The exchange's rules live in PostgreSQL functions, not in `app.js`. Roughly a
hundred of them — every trade, dividend, buyback, fund operation and admin
action runs server-side so that a student with the browser console open cannot
do anything the server would not let them do.

Those functions were being changed by pasting SQL into the Supabase editor,
which meant the only record of what production actually runs was a chat
thread. **That is what this directory is for.** Every file here has been run
against the live database; together they are the history of how it got to
where it is.

## Running one

Paste the whole file into the Supabase SQL editor and run it. Each file is one
`do` block followed by one `select`, because the editor only shows the last
result set — so the `select` at the bottom is the verification, and its
columns are named after what they check. The header of each file explains what
was wrong, how it was measured, and what the verification columns mean.

Every file:

- **aborts and changes nothing** if the database does not look the way it
  expects. They anchor on exact text inside the function they patch and refuse
  to guess.
- **is safe to run twice.** A second run reports "already ... — skipped".
- **rebuilds through `pg_get_functiondef`**, so the signature, volatility,
  `SECURITY DEFINER` and any `SET search_path` come back exactly as they were.
  Retyping a `CREATE OR REPLACE` by hand is how a function quietly loses its
  `search_path` and starts failing with `relation "jex_users" does not exist`.

## Order

They are listed in the order they were applied. Two of them care:

- `snapshot_late_joiner.sql` requires `practice_fund_restore.sql` first, and
  says so rather than half-applying.
- `record_is_not_null.sql` and `price_axis_and_band.sql` both touch
  `rpc_admin_full_reset`, in different places. Either order works.

| file | what it fixes |
| --- | --- |
| `ex_dividend.sql` | A dividend did not move the share price, so buying just before one and selling straight after was free money — $454 of a $500 dividend, out of the paying owner's cash. |
| `dedupe_ex_dividend.sql` | The ex-dividend drop was applied twice, taking a $30.00 stock to $28.00 on a $1.00 dividend and charging every short twice. |
| `convert_parity.sql` | Converting a share class priced below parity created value out of nothing — $2,754.60 a cycle, straight out of the CEO. |
| `practice_fund_restore.sql` | A snapshot restore did not roll back fund units, so a practice round left students holding units they had not paid for. |
| `buyback_cascade.sql` | A buyback destroyed the company's cash and paid nobody — $3,045 measured. Replaced with float → resting asks → a tender at a premium the CEO names. |
| `ownerless_company.sql` | A listed company with no owner had nobody on the other side of a trade: buying destroyed the cash, selling created it. Also stops an account being removed, or a share class deleted, while either still has holders. |
| `fund_close_trap.sql` | Closing a fund that still held stock locked every investor's money in permanently — $12,500 measured, with no way out for anyone. |
| `founder_selfgrant.sql` | A founder could request the company's entire float for themselves and approve it in the same breath — 1,400 shares and $8,595 out of the CEO's cash, with the CEO never in the loop. |
| `price_axis_and_band.sql` | A "Boost +50%" left the price outside its own band, so every buy was refused and every sell went through until the price drifted back. Also stops four functions writing a caption where a timestamp goes, which blanked a relisted stock's chart. |
| `snapshot_late_joiner.sql` | Restoring a snapshot minted shares for anyone who registered after it was taken — the pool got its shares back while the student kept them too. |
| `bankruptcy_rounding.sql` | About one bankruptcy settlement in four failed outright with a check-constraint error, because the pro-rata payouts rounded up past the cash the company had. |
| `record_is_not_null.sql` | `record IS NOT NULL` means "every field is non-null", not "a row was found". It left restricted share classes open to anyone, stopped a CEO withdrawing their own delisting, and meant the index price the graded net worth reads was never refreshed. |
| `login_throttle.sql` | The sign-in password check had no rate limit, so a legacy password could be guessed without end through the publishable key. |
| `dividend_approval_total.sql` | The Treasurer was shown a dividend total that left out the conversion ratio, the student-run funds and the index pass-through — $90.00 approved, $210.00 paid. |
| `short_passwords.sql` | The two password-recovery paths allowed four characters, and a password under six can never be linked to a real sign-in — so the account could not trade at all afterwards. Also fixes "You only holds 0 shares". |
| `restricted_short.sql` | `record_is_not_null.sql` fixed four of the five places with the broken guard. A restricted share class was still shortable by anyone — refused on the buy side, filled on the short side. |
| `cover_short_safety.sql` | A short that lost more than its collateral could not be closed at all — the settlement went negative and the non-negative CHECK on the balance rejected it, leaving the position stuck permanently for a student or a fund alike. Also, a fund covering a short ignored the price band and stranded the stock above it, freezing every buy. |
| `index_margin_call.sql` | The margin call read `jex_companies.price` for the index, which only moves when somebody trades a unit — so a JXI short $30,000 under water on $22,500 of collateral reported `loss: 0.00, not_crossed`. |
| `fund_negative_nav.sql` | A fund unit could be worth less than nothing. Withdrawing then **charged** the investor — $12,500 on a 1,000-unit position — or failed on the cash CHECK and trapped them, and a new deposit minted negative units. The graded net worth read the same negative number. |
| `officer_reset_guard.sql` | `rpc_admin_reset_officer_cash` emptied `holdings` and `shorts` outright. Measured: 594 shares of a 2,000-share company left existing nowhere, 200 borrows never returned, $14,316.76 gone. Nothing in the app calls it, but any officer can. |
| `approve_registration_auth.sql` | **The serious one.** `approve_registration` took the new account's balance from its caller and had no role check at all — no `auth.uid()` call anywhere in it — while granted to `anon` and `authenticated`. An ordinary student minted an approved account holding $1,000,000. |
| `removed_user_shares.sql` | Removing an account deleted the shares it held instead of returning them to the unsold pool, so `shares = shares_avail + held` stopped holding by exactly what the leaver had. 21 shares across four tickers had already gone this way. |
| `graded_index_mark.sql` | `jex_mark_price` returned the cached price for an index row, and `app.js` calls `snapshotNW` *before* `snapshotJXI` — so every graded row written at a trade was taken before the cache caught up. Measured 8.5% low on a 500-unit holding. |
| `fund_margin_call.sql` | A fund's short had no margin call at all — `rpc_margin_call_short` reads `jex_users` and the client walked `DB.users` only. Adds the fund-side mirror and makes the poller walk both. |
| `password_recovery_broken.sql` | **Forgot Password did not work, for anybody.** Step 2 verified the security answer as a hash and step 3 re-verified it as plaintext, so every correct answer was rejected at the last screen with no way out of the loop. |
| `contact_details_auth.sql` | `rpc_get_company_team_contacts` and `rpc_get_leadership_contacts` returned students' names and email addresses to unauthenticated callers. |
| `activity_hash_coverage.sql` | The audit trail's hash chain covered what happened but not who it happened to — rewriting `user_name` on every row left every hash still verifying. |

### Not a migration

| file | what it does |
| --- | --- |
| `preflight.sql` | **Read-only, run it before class.** Answers "is the exchange in a state where a lesson can happen" — dev_mode, session status, whether the books balance, stranded prices, shorts near their margin line, snapshot freshness, and whether 15 named fixes are still present. |
| `repair_share_register.sql` | **Changes data, not a function.** Puts the 21 missing shares back into the unsold pool after `removed_user_shares.sql` stops the leak. Moves no money. Optional — leaving the register as it stands is a reasonable choice. |

## Scope of the audit

Every function in the `public` schema was read against the live body, not
against a local copy — 146 of them. The fingerprint diff above is what made
that checkable; before it existed, 22 of the copies being reasoned about were
stale, including every core trading path.

The order it was done in, because the order mattered:

1. **The money paths** — trades, dividends, buybacks, funds, shorts, the
   index. Read and then exercised on a rig carrying the same constraints,
   foreign keys and column types as production.
2. **The auth surface** — everything `SECURITY DEFINER` and callable by
   `anon`. This is where `approve_registration` was, and where Forgot Password
   turned out to be broken for every account with a password.
3. **The remaining 50** — votes, news, notifications, announcements, flags,
   bug reports, classroom admin, watchlists, price alerts. Triaged by whether
   each checks its caller, then all 50 read in full.

The third pass found one thing (`activity_hash_coverage.sql`) and confirmed
everything else correct. That is worth recording precisely, because "we
checked and found nothing" is only useful if it says what was checked:

- every admin function is role-gated, and the role lists are deliberately
  tiered — `rpc_admin_list_bug_reports` is Chairman/President only,
  `rpc_admin_list_flags` adds the Compliance Officer, `rpc_post_minutes` is
  the Secretary alone, and the client's tab lists agree with each of them
- every self-service function (watchlist, price alerts, notifications,
  last-login, bug reports) acts on the caller's own row, derived from
  `auth.uid()`, never on an id it was handed
- `rpc_delete_price_alert` is the one that takes an id, and it checks
  ownership before deleting

### Triggers

There are exactly two, and they are the same function on two tables:
`_hash_sec_a_on_write`, BEFORE INSERT OR UPDATE FOR EACH ROW on `jex_users`
and on `jex_pending`, both enabled. It hashes a security answer on the way in
unless it already looks hashed.

This matters more than it sounds. `rpc_update_security_question` writes the
answer in **plaintext** — `set sec_a = lower(trim(p_new_a))` — and it is this
trigger, nothing in the function itself, that keeps answers out of the
database in clear text. If the trigger were ever dropped or disabled, that
would stop being true silently, and `password_recovery_broken.sql`'s
verification (`sec_a_storage`) is the check that would notice.

## The rig

These were developed and tested against a local PostgreSQL 16 copy with the
real function bodies installed, not read and reasoned about. Where a header
says "measured", a number came out of running it. Several of the bugs above
were found only because the fix was tested first and turned out to make things
worse — the naive ex-dividend fix, for one, minted $240.50 through short
positions before it was corrected.

**The rig is only as good as the copy in it.** Two migrations were written,
tested and sent against function bodies that were stale — `jex_band_clamp` and
`index_live_value` had both already been fixed in production, and the rig was
carrying older versions. Both were caught at the door: one aborted on its
byte-for-byte body check, the other skipped on its own "already applied" guard,
and neither changed anything. They have been removed rather than kept as
history of a state production was never in.

The lesson is cheap to state and was expensive to learn: before measuring a
bug in a function, diff that function against production. A rig that is right
about ten functions and stale about the eleventh will produce a completely
convincing measurement of a bug that does not exist.

That diff now exists as one query, and it should be run first, not last:

```sql
select p.proname || '|' || pg_get_function_identity_arguments(p.oid)
    || '|' || length(p.prosrc)
    || '|' || md5(replace(p.prosrc, chr(13), ''))
    || '|' || p.provolatile::text
    || '|' || case when p.prosecdef then 'definer' else 'invoker' end
    || '|' || coalesce(array_to_string(p.proconfig, ','), '-')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by 1;
```

One short line per function. Run it against production and against the rig and
compare the hashes. The first time it was run it found **22 stale copies out of
54** — including every core trading path — which invalidated most of what had
been measured up to that point. The three migrations above were found only
after the real bodies were installed, and two of them (`restricted_short.sql`
and the `bigint` assumption in `index_margin_call.sql`) were found by scanning
those bodies mechanically rather than by reading them.

**The same applies to the schema, and it caught me a second time.** The first
version of `index_margin_call.sql` also rewrote a trade insert, because
`rpc_margin_call_short` declares `v_trade_id bigint` and the rig's
`jex_trades.id` is `text` — which would make every margin call die after
debiting the student. Production's `jex_trades.id` is `integer`, so that edit
was fixing a fault that only existed locally, and the file aborted. The same
run showed `jex_funds` carries `chk_funds_cash_nonneg` in production and did
not on the rig, which changed a "silently goes negative" finding into a
"fails loudly and traps the position" one.

So the schema needs the same one-query diff the functions get:

```sql
select c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid)
  from pg_constraint c
 where c.contype = 'c' and c.conrelid::regclass::text like 'jex_%'
 order by 1, 2;
```

plus the column types for anything a function assigns into a typed variable.
A constraint that exists in one place and not the other does not just change
the wording of a finding — it changes whether the failure is loud or silent,
and those need different fixes.
