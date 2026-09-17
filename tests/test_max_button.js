// The Max button, against what the server will actually accept.
//
// The test that found this was not another formula — it was placing the order.
// For a grid of price/float/cash, take the number the button sets, call the
// real rpc_trade_buy with it, and see what comes back. 27 of 75 non-zero Max
// values were refused:
//
//   "Position limit: one investor may hold at most 400 shares of ACME,
//    which is 20% of the 2000 issued"
//
// A student with $40,000 looking at a $30 stock on a 2,000-share float pressed
// Max, got 1,190 in the box, and was bounced every single time. maxAffordableQty
// only ever considered cash; quickSetQty clamped the result to the unsold float
// but not to the 20% position limit — even though positionHeadroom() already
// existed and was already used, a few lines away, to REFUSE the trade.
//
// The short path in the same function already got this right, with a comment
// saying why: "Max offering a number the trade would be refused for is the same
// defect as a dropdown listing a ticker whose buttons cannot work." The buy
// path just never applied it.
//
// After the fix, all 75 were accepted, and N+1 refused in every case — so the
// button is exactly maximal, not merely safe. The short Max was measured the
// same way: 0 refused, 22 of 69 one share conservative, because the server
// charges collateral on the impacted (lower) price. That direction is fine.
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
function grabConst(name){
  const m=new RegExp('(?:^|;)const '+name+'=','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  const start=m.index+(m[0].startsWith(';')?1:0);
  let i=src.indexOf('{',start),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(start,i+1);} }
  throw new Error('unterminated: '+name);
}

// ── the wiring ──
check('the buy Max clamps to the position headroom',
      /const headroom=positionHeadroom\(co,u\);\s*\n\s*if\(headroom!=null\)qty=Math\.min\(qty,headroom\);/.test(src));
check('...using the same helper that refuses the trade',
      /if\(headroom!=null&&qty>headroom\)return toast\(positionCapMsg\(co,u\)\);/.test(src));
check('the short Max still clamps to what can be borrowed',
      /const canBorrow=borrowable\(co\);\s*\n\s*if\(canBorrow!=null\)qty=Math\.min\(qty,canBorrow\);/.test(src));
check('the measurement is recorded next to the fix',
      /27 of 75 non-zero Max values came/.test(src));

// ── the arithmetic ──
global.DB={session:{price_band_pct:1000,session_open_prices:{ACME:30}}};
global.holdings=u=>(u&&u.holdings)||{};
eval(grabFn('bandLimits').replace(/^function /,'global.bandLimits=function '));
eval(grabFn('bandClamp').replace(/^function /,'global.bandClamp=function '));
eval(grabConst('impactPrice').replace(/^const /,'global.'));
eval(grabConst('maxAffordableQty').replace(/^const /,'global.'));
// Read the cap off app.js rather than restating it, so a change to the
// percentage fails here instead of silently passing.
const capPct=/const POSITION_CAP_PCT=([0-9.]+);/.exec(src);
if(!capPct)throw new Error('POSITION_CAP_PCT not found');
global.POSITION_CAP_PCT=Number(capPct[1]);
eval(grabFn('positionCap').replace(/^function /,'global.positionCap=function '));
eval(grabFn('positionHeadroom').replace(/^function /,'global.positionHeadroom=function '));

// What quickSetQty computes for a buy, all three limits together.
const maxBuy=(co,u)=>{
  let q=co.is_index_fund?maxAffordableQty(co,u.cash):Math.min(maxAffordableQty(co,u.cash),co.shares_avail);
  const h=positionHeadroom(co,u);
  if(h!=null)q=Math.min(q,h);
  return Math.max(0,q||0);
};
const costOf=(co,q)=>Math.round(impactPrice(co,q,'buy')*q*100)/100;

// The case from the measurement.
let co={ticker:'ACME',price:30,shares:2000,shares_avail:2000,is_index_fund:false};
let u={cash:40000,holdings:{}};
check('cash alone would have offered 1,190', Math.min(maxAffordableQty(co,u.cash),co.shares_avail)===1190,
      String(Math.min(maxAffordableQty(co,u.cash),co.shares_avail)));
check('the 20% cap on 2,000 shares is 400', positionCap(co)===400);
check('so Max is now 400, which the server accepts', maxBuy(co,u)===400, String(maxBuy(co,u)));

// Whichever limit binds, Max must equal it.
co={ticker:'ACME',price:30,shares:50000,shares_avail:50000,is_index_fund:false};
check('cash can be the binding limit', maxBuy(co,{cash:1000,holdings:{}})===33,
      String(maxBuy(co,{cash:1000,holdings:{}})));
check('...and one more really is unaffordable',
      costOf(co,33)<=1000&&costOf(co,34)>1000, costOf(co,33)+' / '+costOf(co,34));
co={ticker:'ACME',price:30,shares:50000,shares_avail:12,is_index_fund:false};
check('the unsold float can be the binding limit', maxBuy(co,{cash:40000,holdings:{}})===12);
co={ticker:'ACME',price:30,shares:200,shares_avail:200,is_index_fund:false};
check('the position cap can be the binding limit', maxBuy(co,{cash:40000,holdings:{}})===40);

// Already at or over the cap: Max must be 0, not a negative or a stale number.
co={ticker:'ACME',price:30,shares:2000,shares_avail:2000,is_index_fund:false};
check('a student already at the cap gets 0', maxBuy(co,{cash:40000,holdings:{ACME:400}})===0);
check('a student ABOVE the cap gets 0, not a negative',
      maxBuy(co,{cash:40000,holdings:{ACME:900}})===0);
check('...and partway up, only the remainder', maxBuy(co,{cash:40000,holdings:{ACME:150}})===250);

// An index fund is exempt from the cap and mints on demand, so neither the
// float nor the headroom may clamp it.
const idx={ticker:'JXI',price:10,shares:0,shares_avail:0,is_index_fund:true};
check('the index has no position cap', positionCap(idx)===null);
check('...so Max on it is pure cash', maxBuy(idx,{cash:1000,holdings:{}})===100,
      String(maxBuy(idx,{cash:1000,holdings:{}})));
check('...even with a big existing holding', maxBuy(idx,{cash:1000,holdings:{JXI:9999}})===100);

// A company with no shares issued has no cap to compute.
check('a zero-share company has no cap',
      positionCap({ticker:'X',shares:0,is_index_fund:false})===null);
check('no cash means no shares', maxBuy(co,{cash:0,holdings:{}})===0);

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
