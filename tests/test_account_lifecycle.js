// Creating an account, and removing one. Both had a hole.
//
// ── 1. Any student could give themselves any amount of money ──
//
// approve_registration is SECURITY DEFINER, is granted EXECUTE to both `anon`
// and `authenticated`, takes the new account's balance straight from its
// argument, and contained no caller check of any kind -- not a weak one, no
// call to auth.uid() anywhere in the function. The admin panel was the only
// thing in front of it, and the admin panel runs on the student's machine.
//
// Measured against the live function bodies running locally, signed in as an
// ordinary approved student holding $9,647.03:
//
//   approve_registration('<a pending id>', 1000000)
//     -> {"cash": 1000000, "role": "student", "status": "approved"}
//   money in the exchange: $459,846.25 -> $1,459,846.25
//
// and it does not need a login at all, because rpc_register_pending is granted
// to `anon` and RETURNS the row it inserts, id included:
//
//   1. rpc_register_pending(...)        -> {"id": "...", ...}
//   2. approve_registration(id, 999999999)
//   3. sign in with the password from step 1
//
// The fix is a role check matching isAdmin() below, plus a non-negative
// starting balance. rpc_register_pending already refuses any role but
// 'student' and 'company', which is what keeps step 1 from asking for
// 'chairman' directly -- that check is pinned here because it is now load
// bearing for more than it looks.
//
// ── 2. Removing an account deleted the shares it held ──
//
// Holdings are a jsonb column on the jex_users row, so deleting the row takes
// them with it, and nothing returns them to the company's unsold pool. The
// identity that has to hold --
//
//     shares = shares_avail + held_by_users + held_by_funds
//
// -- then stops holding by exactly what the leaver had, permanently.
//
// Measured, one student holding 4 shares of a 2,000-share company:
//
//              before   after (broken)   after (fixed)
//   unsold      1,400        1,400           1,404
//   held          308          304             304
//
// rpc_admin_remove_user already refuses when the account owns a listed
// company, and says to delist first because that settles every shareholder. It
// had no equivalent thought for an account that is only a shareholder.
//
// The shares now go back to the unsold pool and the leaver is paid nothing --
// their cash leaves with the account either way. Refusing instead, which is
// what the function does for a company owner, does not work here: no admin
// action in this app can liquidate somebody else's portfolio, so refusing
// would mean an account that ever bought anything could never be removed.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── the share register identity, both directions ──
//
// This is the arithmetic rpc_admin_remove_user now preserves. least() is here
// for the same reason it is in the SQL: the register may already be
// inconsistent, and chk_companies_shares_avail_le_shares must still hold.
const removeHolder=(co,held)=>({
  shares:co.shares,
  shares_avail:Math.min(co.shares, co.shares_avail + held),
});
const unaccounted=(co,heldAfter)=>co.shares - co.shares_avail - heldAfter;

let co={shares:2000,shares_avail:1400};
check('before: 2,000 issued, 1,400 unsold, 308 held leaves 292 unaccounted',
      unaccounted(co,308)===292, String(unaccounted(co,308)));
let after=removeHolder(co,4);
check('removing a holder of 4 puts them back: unsold 1,404',
      after.shares_avail===1404, String(after.shares_avail));
check('...and the unaccounted figure does not move',
      unaccounted(after,304)===292, String(unaccounted(after,304)));
check('...where deleting them outright would have made it 296',
      unaccounted(co,304)===296, String(unaccounted(co,304)));

// A register that is ALREADY short cannot be pushed past the constraint.
co={shares:500,shares_avail:496};
check('returning 10 into a 500/496 register stops at 500, not 506',
      removeHolder(co,10).shares_avail===500, String(removeHolder(co,10).shares_avail));
check('a holder of nothing changes nothing',
      removeHolder({shares:2000,shares_avail:1400},0).shares_avail===1400);
check('a whole float coming back lands exactly on issued',
      removeHolder({shares:2000,shares_avail:0},2000).shares_avail===2000);

// The four tickers as this exchange actually stood when the leak was found.
// Kept as data so the next person can see the shape rather than the story.
const register=[
  ['AZEI',   2000, 1262, 729, 9],
  ['TCO1',    500,  496,   0, 4],
  ['TCO1.B',  200,  196,   0, 4],
  ['TCO2',    500,  496,   0, 4],
];
let total=0;
for(const [ticker,issued,unsold,held,expected] of register){
  const gap=issued-unsold-held;
  total+=gap;
  check(ticker+' was missing '+expected+' shares', gap===expected, String(gap));
}
check('21 shares in total existed nowhere', total===21, String(total));
check('three test companies missing exactly 4 each is one account, not three bugs',
      register.slice(1).every(([,,,,g])=>g===4));

// ── the roles that may approve ──
//
// The server now checks this list. isAdmin() is the client's copy of it and
// the two have to stay the same, or an officer gets a button that errors.
const OFFICERS=['chairman','president','secretary','treasurer','compliance_officer'];
const m=/const isAdmin=([^;]+);/.exec(src)||/function isAdmin\(([\s\S]*?)\n\}/.exec(src);
check('isAdmin exists to compare against', !!m);
for(const role of OFFICERS){
  check('the client counts '+role+' as an admin', m&&m[0].includes("'"+role+"'"), m?m[0].slice(0,120):'');
}
check('...and a plain student is not in that list', m&&!/'student'/.test(m[0]));

// ── signup cannot ask for a privileged role ──
//
// This is what stops the escalation being reachable from the public form. It
// lives server-side in rpc_register_pending; the client only ever sends these
// two, and this pins that it never learns to send a third.
const roleArgs=[...src.matchAll(/p_role:\s*'([a-z_]+)'/g)].map(x=>x[1]);
check('the client only ever registers students and companies',
      roleArgs.length>0&&roleArgs.every(r=>r==='student'||r==='company'),
      roleArgs.join(','));

// ── the approval call still sends what the server now validates ──
check('approveReg sends a starting balance the server will check',
      /sb\.rpc\('approve_registration',\{p_pending_id:id,p_starting_cash:startCash/.test(src));
check('...defaulted from the session, never hardcoded',
      /startCash=parseFloat\(startCash\)\|\|DB\.session\.starting_cash\|\|10000;/.test(src));
check('the admin form cannot type a negative starting balance',
      /id="cash-\$\{r\.id\}"[^>]*min="0"/.test(src));

// ── removal is still gated to a real chairman client-side ──
//
// Not a security control -- the server check is -- but it should not offer a
// button that will be refused.
check('only a true chairman sees Remove on another officer',
      /isTrueChairman&&x\.id!==u\?\.id\?`<button class="btn btn-sm btn-danger" onclick="removeUser\('\$\{x\.id\}'\)"/.test(src));
check('removing a company warns that its stock is delisted too',
      /Listed stock '\+listedCo\.ticker\+' will also be delisted\./.test(src));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
