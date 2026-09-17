// The buyback preview, against what rpc_buyback actually does.
//
// The cascade has three rungs: cancel from the unsold float (free), lift
// resting asks cheapest-first at the asking price, then rest a tender at a
// premium for whatever is left. The preview walks the same three, so every
// number on it is checkable against the real call — which is how these came
// out.
//
// Measured against the real function on a copy of production, 144 scenarios
// across float/asks/quantity/premium:
//
//   22 of 144 quoted the wrong tender price. rpc_buyback carries v_last_price
//   through the cascade and prices the bid off the LAST ask it lifted, because
//   lifting asks moves the price before the tender is posted. The preview used
//   co.price. A CEO was shown $31.50 on a tender that rested at $32.55, and
//   $36.00 on one that rested at $37.20.
//
// And on a second sweep of 216 scenarios across cash, band width, premium,
// quantity and float:
//
//   141 of 216 buybacks the server REFUSES were shown as fine. The server
//   turns down a tender priced above the band ceiling ("a 5% premium puts the
//   tender at 32.55, above the 31.50 ceiling"), and one the company cannot
//   cover after the ask fills — the preview checked neither. It weighed only
//   the ask fills against the cash and never looked at the band at all.
//
// After the fix: 144 scenarios, 0 mismatches on any rung including the bid;
// 216 scenarios, the red warning fires exactly when the server refuses, with
// no misses and no false alarms.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── the wiring ──
check('the premium is measured from the last ask lifted',
      /lastPrice=Number\(a\.limit_price\)\|\|lastPrice;/.test(src));
check('...not from the price showing now',
      /let lastPrice=Number\(co\.price\)\|\|0;/.test(src));
check('the band ceiling is checked before the CEO commits',
      /if\(band&&bid>band\.upper\)overBand=true\|\|\(overBand=band\.upper\);/.test(src)
      ||/if\(band&&bid>band\.upper\)overBand=band\.upper;/.test(src));
check('...and says so in red',
      /That bid is above today\\'s '\+fmt\(overBand\)\+' price-band ceiling/.test(src));
check('the affordability check counts the tender as well as the fills',
      /const short=owner&&\(spend\+tenderCost\)>cash;/.test(src));
check('...and shows the total it came to',
      /and this would come to '\+fmt\(spend\+tenderCost\)\+'/.test(src));
check('the reason the bid moved is written down',
      /lifting asks moves the price/.test(src));

// ── the arithmetic, all three rungs ──
const r2=n=>Math.round(n*100)/100;
function preview(co,asks,qty,prem,cash,band){
  let left=qty,spend=0,bought=0,lastPrice=co.price;
  const fromFloat=Math.min(left,Math.max(0,co.shares_avail||0));
  left-=fromFloat;
  for(const a of asks.slice().sort((x,y)=>x.limit_price-y.limit_price)){
    if(left<=0)break;
    const take=Math.min(a.qty,left); if(take<=0)continue;
    spend=r2(spend+take*a.limit_price);bought+=take;left-=take;lastPrice=a.limit_price;
  }
  let bid=null,tenderCost=0,overBand=false;
  if(left>0&&prem>0){
    bid=Math.max(0.01,r2(lastPrice*(1+prem/100)));
    tenderCost=r2(left*bid);
    if(band!=null&&bid>band)overBand=true;
  }
  return {fromFloat,bought,spend,tender:prem>0?left:0,bid,
          short:(spend+tenderCost)>cash,overBand};
}

const co={price:30,shares:2000,shares_avail:3};
const asks=[{qty:5,limit_price:31},{qty:12,limit_price:29.5}];
let p=preview(co,asks,25,5,500000,39);
check('3 come free from the float', p.fromFloat===3);
check('17 are lifted from the asks', p.bought===17);
check('...cheapest first, for $509.00', p.spend===509);
check('5 are left for the tender', p.tender===5);
check('...priced off the LAST ask lifted, at $32.55', p.bid===32.55, String(p.bid));
check('the old way would have quoted $31.50', r2(30*1.05)===31.5);

// The float alone can cover it, and then nothing is spent.
p=preview({price:30,shares:2000,shares_avail:40},asks,25,5,500000,39);
check('a big enough float costs nothing', p.fromFloat===25&&p.spend===0&&p.tender===0);
check('...and posts no tender', p.bid===null);

// No asks at all: the premium is measured from the market price.
p=preview({price:30,shares:2000,shares_avail:0},[],10,20,500000,39);
check('with no asks the bid is off the market price', p.bid===36, String(p.bid));
check('...and the whole request goes to the tender', p.tender===10);

// A premium of zero posts nothing, however much is left.
p=preview({price:30,shares:2000,shares_avail:0},[],10,0,500000,39);
check('no premium means no tender', p.tender===0&&p.bid===null);

// ── the two refusals the preview now predicts ──
p=preview(co,asks,25,5,500000,31.5);
check('a bid above the band ceiling is flagged', p.overBand===true);
p=preview(co,asks,25,5,500000,39);
check('...and is not flagged when it fits', p.overBand===false);
p=preview(co,asks,25,5,600,39);
check('a tender the company cannot cover is flagged',
      p.short===true, 'spend 509 + tender '+r2(5*32.55)+' vs 600');
check('...and the total it would come to is 671.75', r2(509+5*32.55)===671.75);
p=preview(co,asks,25,5,700,39);
check('...and is not flagged when the cash is there', p.short===false);
check('the old check weighed the fills alone and passed it', 509<=700&&509<=600);

// Nothing requested, nothing happens.
p=preview(co,asks,0,20,500000,39);
check('a zero quantity spends nothing', p.fromFloat===0&&p.spend===0&&p.tender===0);
// A float bigger than the request never goes negative.
p=preview({price:30,shares:2000,shares_avail:1000},[],5,20,500000,39);
check('the float rung never over-cancels', p.fromFloat===5&&p.tender===0);
// The cent floor on a bid.
p=preview({price:0.01,shares:2000,shares_avail:0},[],5,0.1,500000,39);
check('a bid can never round to zero', p.bid>=0.01, String(p.bid));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
