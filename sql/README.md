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

## The rig

These were developed and tested against a local PostgreSQL 16 copy with the
real function bodies installed, not read and reasoned about. Where a header
says "measured", a number came out of running it. Several of the bugs above
were found only because the fix was tested first and turned out to make things
worse — the naive ex-dividend fix, for one, minted $240.50 through short
positions before it was corrected.
