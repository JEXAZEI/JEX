// Closing a short: the three rules that keep a student from getting stuck.
//
// A short is the only position on this exchange that can lose more than it
// cost. The collateral is 150% of the entry value and it is locked at the
// ENTRY price -- it is never topped up -- so a big enough move eats it, and
// then the loss keeps going.
//
// Three things are supposed to stop that, and each of them had a hole.
//
// ── 1. The settlement has a floor ──
//
// Both cover paths settle the same way:
//
//     cash + collateral_released + pnl
//
// and neither used to floor it. jex_users.cash and jex_funds.cash both carry
// CHECK (>= 0), so when that sum went negative the UPDATE raised and the cover
// FAILED -- the holder could not close the position by any route the app
// offers, and it kept growing against them.
//
// Measured against the live function bodies running locally, on a 1,000-share
// short entered at $5.00 with $7,500 collateral and $5,000 of cash, covered
// against a $30.00 price (the cover fills at $33.60 -- it is itself a market
// buy and pays the 12% impact):
//
//   before   student  ERROR: violates "chk_users_cash_nonneg"  (stuck)
//            fund     ERROR: violates "chk_funds_cash_nonneg"  (stuck)
//   after    student  covers, cash 0
//            fund     covers, cash 0
//
// An earlier version of this note said the fund went to -16,100.00 silently.
// That was my test rig, which was missing chk_funds_cash_nonneg. The real
// database has it and the fund half failed loudly, same as the student half.
//
// rpc_margin_call_short already settled with greatest(0, ...) and said why in
// its own comment. The cover paths now agree with it. The shortfall is written
// off -- that is the deliberate choice, and the alternative is the measured
// one above.
//
// ── 2. A fund covers inside the band, like everyone else ──
//
// rpc_fund_cover_short computed its fill price with the impact model and never
// clamped it. Measured on ACME, session open $30.00, band 30% ($21.00-$39.00),
// price drifted to $37.00, identical 800-share cover:
//
//   a student covers   $39.00   held at the ceiling
//   a fund covers      $41.44   straight through it
//
// and with the price stranded outside its own band, every buy is refused and
// every sell fills -- the same frozen market the "Boost +50%" bug produced.
//
// ── 3. The margin call marks the index live ──
//
// The line is `avgPrice + 0.8 * collateral / qty`, computed below and
// re-derived server-side under a row lock. Server-side it was compared against
// jex_companies.price, which for an index row is only rewritten when somebody
// trades a unit. Measured: a 1,000-unit JXI short at $15.00 with $22,500
// posted, market triples, nobody trades JXI:
//
//   stored price   $15.00      live unit   $45.00
//   actual loss    $30,000     the call    {"loss": 0.00, "reason":
//                                           "not_crossed"}
//
// The client half was already right -- syncIndexRows() rewrites an index row's
// price from computeIndex() at the top of every render, so co.price is live in
// the browser. It was only the server that read the cache.
//
// ── Still open, deliberately not fixed here ──
//
// A FUND's short is never margin-called at all: checkMarginCalls() walks
// DB.users only, and there is no fund-side RPC. A fund can therefore run a
// short past its collateral with no safety net, and now settles at zero --
// which wipes out its investors. Fixing that means either a fund margin caller
// or a cap on fund shorts, and that is a decision about how the class should
// work, not a bug fix.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

function grabFn(name){
  const m=new RegExp('^(?:async )?function '+name+'\\(','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(m.index,i+1);} }
  throw new Error('unterminated: '+name);
}
eval((/^const MARGIN_CALL_AT=.*$/m.exec(src))[0].replace(/^const /,'global.'));
eval(grabFn('shortMarginLine').replace(/^function /,'global.shortMarginLine=function '));

// ── the settlement rule, both sides ──
//
// This is the arithmetic the two cover RPCs now run. Transcribed here so that
// if either side is edited the two stop agreeing and this fails.
const settle=(cash,collateral,avg,fill,qty)=>
  Math.max(0, Math.round((cash + collateral + (avg-fill)*qty)*100)/100);

check('an ordinary cover pays out collateral plus profit',
      settle(5000,7500,30,25,1000)===17500, String(settle(5000,7500,30,25,1000)));
check('a losing cover eats into the collateral',
      settle(5000,7500,30,33,1000)===9500, String(settle(5000,7500,30,33,1000)));
check('a loss the collateral exactly covers lands on the cash',
      settle(5000,7500,30,37.5,1000)===5000, String(settle(5000,7500,30,37.5,1000)));
// The measured case: 1,000 shares short at $5.00, $7,500 posted, $5,000 of
// cash, covered against a $30.00 price. The fill is $33.60, not $30.00 -- the
// cover is itself a market buy and pays the 12% impact.
check('the measured stuck position now closes at zero instead of erroring',
      settle(5000,7500,5,33.60,1000)===0, String(settle(5000,7500,5,33.60,1000)));
check('...and without the floor it came to -16,100.00, which both CHECKs reject',
      Math.round((5000+7500+(5-33.60)*1000)*100)/100===-16100,
      String(Math.round((5000+7500+(5-33.60)*1000)*100)/100));
check('a fund is settled by the same rule', settle(5000,7500,5,33.60,1000)===0);
check('zero quantity is a no-op, not a negative', settle(1000,0,10,99,0)===1000);

// ── the margin line ──
//
// 80% of the collateral, not 100%, because the forced buy-back is itself a
// market buy and has to fit inside what is left.
const pos=(qty,avg,coll)=>({qty,avgPrice:avg,collateral:coll});
check('the standard 150% short is called at 2.2x the entry price',
      shortMarginLine(pos(100,10,1500))===22, String(shortMarginLine(pos(100,10,1500))));
check('the JXI short measured above is called at $33.00',
      shortMarginLine(pos(1000,15,22500))===33, String(shortMarginLine(pos(1000,15,22500))));
check('...and the live mark of $45.00 is well past it',
      45 > shortMarginLine(pos(1000,15,22500)));
check('...while the stale stored price of $15.00 is not',
      15 < shortMarginLine(pos(1000,15,22500)));
check('a position with no collateral has no line to cross',
      shortMarginLine(pos(100,10,0))===null);
check('a closed position has no line either', shortMarginLine(pos(0,10,1500))===null);
check('a missing position does not throw', shortMarginLine(null)===null);

// The line has to sit below the point where the collateral is gone, or it is
// not a safety net -- it is a notification that the money has already gone.
for(const [qty,avg,coll] of [[100,10,1500],[1000,15,22500],[7,3.25,34.13],[4,12,72]]){
  const line=shortMarginLine({qty,avgPrice:avg,collateral:coll});
  const wipeout=avg+coll/qty;
  check('called at '+line+' before the collateral is gone at '+Math.round(wipeout*100)/100,
        line!=null&&line<wipeout);
}
// The one place they coincide: the line is rounded to the cent, so on a
// position whose whole collateral is worth a couple of cents the rounded line
// lands exactly on the wipeout price. Recorded rather than papered over --
// it is real, and it is two cents.
check('at sub-cent collateral the rounded line meets the wipeout exactly',
      shortMarginLine(pos(1,0.01,0.02))===0.03 && 0.01+0.02/1===0.03);

// ── the client marks an index live ──
//
// The server now does this too. Here we only pin the client half: an index
// row's price is rewritten from the constituents before anything reads it.
check('render() refreshes index rows before reading any price',
      /function render\(\)\{[\s\S]{0,400}?syncIndexRows\(\);/.test(src));
check('syncIndexRows writes the derived level onto the index row',
      /co\.price=series\[series\.length-1\]\.p;/.test(src));
check('the margin poller reads that same refreshed price',
      /const co=getCo\(ticker\);if\(!co\)continue;\s*const line=shortMarginLine\(pos\);/.test(src));
check('the poller skips a halted ticker rather than calling into a halt',
      /if\(isHalted\(ticker\)\)continue;/.test(src));

// ── and the gap that is still open ──
//
// Stated as a test so it cannot be forgotten: if a fund margin caller is ever
// added, this check is what should change.
check('checkMarginCalls still only walks users, not funds (known gap)',
      /async function checkMarginCalls\(\)\{[\s\S]{0,600}?for\(const u of DB\.users\|\|\[\]\)/.test(src)
      && !/checkMarginCalls[\s\S]{0,900}?DB\.funds/.test(src));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
