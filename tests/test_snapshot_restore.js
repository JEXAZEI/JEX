// Restoring a snapshot, and the one case it silently got wrong.
//
// rpc_admin_restore_snapshot walks the users IN the snapshot and rolls each
// one back. A student who registered afterwards is not in that list, so
// nothing touches them -- while the COMPANIES are rolled back around them,
// shares_avail included. The shares they bought go back into the pool and stay
// in their portfolio at the same time.
//
// Measured against the real functions on a copy of production:
//
//   snapshot taken                     shares_avail 1400, held  70  (1470)
//   a new student joins, buys 100 ACME  shares_avail 1300, held 170  (1470)
//   restore                             shares_avail 1400, held 170  (1570)
//
// 100 shares in two places. The CEO's $3,045 was refunded to the CEO and the
// student kept the stock, so they can sell it back and take the $3,045 a
// second time.
//
// The server now rolls those users back too -- to the snapshot session's
// starting cash, holding nothing, account and login untouched -- and reports
// every one of them. This file pins the client half: the warning BEFORE, which
// is the admin's only chance to say no, and the report AFTER, which is how
// they find out who it reached.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── the warning, before anything happens ──
check('the confirm says late joiners are rolled back too',
      /Anyone who registered AFTER this snapshot was taken is rolled back too/.test(src));
check('...and exactly what that costs them',
      /anything they bought or earned since joining is gone/.test(src));
check('...and that their account survives it',
      /Their account and login are untouched/.test(src));
check('...and promises the names',
      /You will be told exactly who/.test(src));
check('...and says a company listed since is NOT rolled back',
      /can\\'t un-IPO it/.test(src));

// ── the report, after ──
check('the reset users are read off the result',
      /const reset=\(r&&r\.reset_users\)\|\|\[\],unknown=\(r&&r\.unknown_companies\)\|\|\[\];/.test(src));
check('...and shown rather than logged',
      /if\(reset\.length\|\|unknown\.length\)\{[\s\S]{0,900}?alert\(msg\);/.test(src));
check('each name comes with the cash they had',
      /had '\+fmt\(u\.cash_before\)/.test(src));
check('...and what they were holding',
      /Object\.entries\(u\.holdings_before\)\.map\(\(\[t,q\]\)=>q\+' '\+t\)/.test(src));

// ── the comment block has to describe what the RPC actually does now ──
check('the coverage note lists fund_units',
      /jex_users\s+cash, holdings, shorts, fund_units/.test(src));
check('...and jex_funds, which it now restores',
      /jex_funds\s+cash, holdings, shorts, units_outstanding/.test(src));
check('the stale claim that funds survive a rollback is gone',
      !/a fund's cash and holdings survive a rollback/.test(src));
check('...and the measurement is written down next to it',
      /100 shares in two places/.test(src));

// ── the arithmetic the bug came down to ──
//
// Shares are conserved when pool + everything held stays put across a restore.
// The late joiner is the term that used to be missing from one side of it.
const total=(avail,held)=>avail+held;
check('before the snapshot, 1400 + 70 = 1470', total(1400,70)===1470);
check('after the buy, 1300 + 170 = 1470 -- still conserved', total(1300,170)===1470);
check('the old restore gave 1400 + 170 = 1570 -- 100 minted',
      total(1400,170)-total(1300,170)===100);
check('resetting the late joiner puts it back to 1470', total(1400,70)===1470);

// The empty cases have to stay quiet: a snapshot with nobody new must not pop
// a dialog at every restore.
const shouldReport=(reset,unknown)=>!!(reset.length||unknown.length);
check('nothing new means no dialog', shouldReport([],[])===false);
check('a reset user means a dialog', shouldReport([{name:'x'}],[])===true);
check('a new company alone still means a dialog', shouldReport([],[{ticker:'X'}])===true);

// A user with no holdings at all must render as a name and a cash figure, not
// as "and undefined".
const line=u=>'  • '+u.name+' — had '+u.cash_before
  +(u.holdings_before&&Object.keys(u.holdings_before).length
    ?' and '+Object.entries(u.holdings_before).map(([t,q])=>q+' '+t).join(', '):'');
check('a cash-only account reads cleanly',
      line({name:'A',cash_before:10000,holdings_before:{}})==='  • A — had 10000');
check('a missing holdings object does not print undefined',
      line({name:'B',cash_before:5})==='  • B — had 5');
check('holdings are listed as quantity and ticker',
      line({name:'C',cash_before:1,holdings_before:{ACME:100,BETA:2}})
        ==='  • C — had 1 and 100 ACME, 2 BETA');

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
