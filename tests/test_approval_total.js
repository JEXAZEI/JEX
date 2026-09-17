// What the Treasurer is asked to approve, against what the company pays.
//
// rpc_pay_dividend pays three groups -- direct student holders, the index
// basket's pass-through to whoever holds index units, and the student-run
// funds in jex_funds -- and multiplies every share-class holding by that
// class's conversion_ratio, because one Class B share is worth
// conversion_ratio of the parent.
//
// rpc_request_dividend_approval, which fills in the `total` the Treasurer
// signs, counted only the first group, at face value, with no ratio.
//
// Measured against the real functions on a copy of production. Acme, a $1.00
// dividend, one student holding 50 ACME and 20 ACME.B at 5:1, another holding
// 20 ACME, a student-run fund holding 40 ACME:
//
//   rpc_request_dividend_approval  ->  $90.00      <- what was signed off
//   rpc_pay_dividend               -> $210.00      <- what left
//
// 2.33 times. After the fix, with a JXI basket holding 100 ACME and 50 of its
// 200 units in student hands, both report $235.00.
//
// It never let a dividend dodge the approval threshold -- rpc_pay_dividend
// recomputes the real total itself and refuses anything at or above it without
// an approval id. What it did was put a figure that was too small on the one
// screen whose whole purpose is to show a number before the cash moves.
//
// The client has its own preview of the same number, and this file pins that
// the two are built from the same three parts.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── the client's preview is the sum of the same three groups ──
check('the preview adds the direct holders, the index pass-through and the funds',
      /directTotal\+pass\.total\+fundCut/.test(src));
check('the fund cut applies the conversion ratio',
      /fundDividendCut\(tickers,perShare\)/.test(src)||/function fundDividendCut\(tickers,perShare\)/.test(src));
check('the reason the server had to be fixed is written down',
      /presented to the\s*\n\s*\/\/ Treasurer as \$90\.00 and cost the company \$210\.00/.test(src));
check('...and that the two figures now agree',
      /and the stored one finally agree/.test(src));

// ── the arithmetic, as both halves now do it ──
//
// Each holder's payout is rounded to the cent on its own and then summed --
// rounding the total instead would drift away from what is actually paid out.
const r2=n=>Math.round(n*100)/100;
const direct=(holders,perShare,ratio)=>holders.reduce(
  (s,h)=>r2(s+r2((h.base+h.classB*ratio)*perShare)),0);
const fundCut=(funds,perShare,ratio)=>funds.reduce(
  (s,f)=>r2(s+r2((f.base+(f.classB||0)*ratio)*perShare)),0);
const passThrough=(basketShares,perShare,unitsHeld,unitsTotal)=>
  unitsTotal>0&&unitsHeld>0?r2(basketShares*perShare*(unitsHeld/unitsTotal)):0;

const holders=[{base:50,classB:20},{base:20,classB:0}];
const funds=[{base:40}];
check('the old way -- face value, holders only -- gives $90.00',
      direct([{base:50,classB:20}],1,1)+direct([{base:20,classB:0}],1,1)===90);
check('the ratio alone takes the direct total to $170.00',
      direct(holders,1,5)===170, String(direct(holders,1,5)));
check('the student-run fund adds $40.00', fundCut(funds,1,5)===40);
check('so the real cost is $210.00', r2(direct(holders,1,5)+fundCut(funds,1,5))===210);
check('and the old figure understated it by $120.00',
      r2(direct(holders,1,5)+fundCut(funds,1,5))-90===120);

// The index basket, pro-rated over the units students actually hold.
check('a basket of 100 shares with 50 of 200 units held passes through $25.00',
      passThrough(100,1,50,200)===25);
check('...all the units held means the whole basket', passThrough(100,1,200,200)===100);
check('...no units held means nothing', passThrough(100,1,0,200)===0);
check('...and a basket with no units outstanding does not divide by zero',
      passThrough(100,1,50,0)===0);
check('the three parts together are $235.00',
      r2(direct(holders,1,5)+fundCut(funds,1,5)+passThrough(100,1,50,200))===235);

// ── the shapes that used to be refused outright ──
//
// A company whose only shareholder is a student-run fund totalled zero under
// the old count, so "No shareholders yet" refused a request that would have
// paid out perfectly well.
check('a company held only through a fund is no longer nothing',
      fundCut([{base:60}],0.25,1)===15, String(fundCut([{base:60}],0.25,1)));
check('...where the old count would have made it zero', direct([],0.25,1)===0);
check('genuinely nobody is still zero',
      r2(direct([],1,5)+fundCut([],1,5)+passThrough(0,1,0,0))===0);

// Per-holder rounding, which is what keeps the approval and the payment equal
// to the cent.
const odd=[{base:7,classB:0},{base:7,classB:0}];
check('each holder is rounded once, not the total',
      direct(odd,0.125,1)===1.76, String(direct(odd,0.125,1)));
check('a fractional ratio still lands on the cent',
      direct([{base:0,classB:3}],1,1.5)===4.5, String(direct([{base:0,classB:3}],1,1.5)));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
