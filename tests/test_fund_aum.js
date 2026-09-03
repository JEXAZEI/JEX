// A fund's assets under management, and whether the two numbers on its own
// page agree.
//
// The fund detail card shows "NAV / unit" and "Assets under management" side by
// side, and AUM is also the figure on the funds list and the fund leaderboard.
// They were computed by two different sums:
//
//     fundAUM        = cash + holdings
//     currentFundNav = cash + holdings + short P&L + short collateral, / units
//
// Opening a short locks 150% of the position value out of f.cash and credits no
// proceeds (rpc_fund_short debits collateral only). So the moment a fund
// shorted $2,000 of stock, its AUM dropped by $3,000 on every screen that shows
// it, while its NAV -- correctly -- did not move at all. The collateral is
// escrowed, not spent; it comes back on cover.
//
// This was the fourth copy of that sum. Two of the earlier three had already
// drifted apart server-side, where rpc_fund_deposit valued a fund without the
// collateral and rpc_fund_withdraw valued it with, so a manager could deposit
// at the low NAV and withdraw at the high one for risk-free profit taken from
// the other unit-holders. There is one definition per side now, and this suite
// exists to keep it that way: the identity AUM === NAV * units is checked on
// every shape below, because that identity is what a second copy breaks first.
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
function grabArrow(name){
  const m=new RegExp('^const '+name+'=.*$','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  return m[0];
}

let PRICES={};
global.getCo=t=>PRICES[t]===undefined?null:{ticker:t,price:PRICES[t]};
global.fundShorts=f=>f.shorts||{};
eval(grabArrow('fundShortPnl').replace(/^const /,'global.'));
eval(grabArrow('fundShortCollateral').replace(/^const /,'global.'));
eval(grabFn('fundAUM').replace('function fundAUM','global.fundAUM=function'));
eval(grabFn('currentFundNav').replace('function currentFundNav','global.currentFundNav=function'));

// NAV is published to 4 decimals, so multiplying it back out can miss the
// total by up to half a hundredth of a cent per unit. Anything beyond that
// slack is a second definition of the sum, not rounding.
const agree=(label,f)=>{
  const aum=fundAUM(f),nav=currentFundNav(f);
  if(!f.units_outstanding){check(label+': no units means nothing to reconcile',true);return;}
  const slack=0.005+f.units_outstanding*0.00005;
  check(label+': AUM equals NAV x units',
        Math.abs(aum-nav*f.units_outstanding)<=slack, aum+' vs '+(nav*f.units_outstanding));
};

// ── a plain cash fund ──
PRICES={};
let f={cash:10000,holdings:{},shorts:{},units_outstanding:1000};
check('an all-cash fund reports its cash', fundAUM(f)===10000, String(fundAUM(f)));
check('...at a NAV of 10', currentFundNav(f)===10, String(currentFundNav(f)));
agree('all-cash',f);

// ── cash plus holdings ──
PRICES={ACME:25,BOLT:8};
f={cash:5000,holdings:{ACME:100,BOLT:250},shorts:{},units_outstanding:1000};
check('holdings are marked to market', fundAUM(f)===9500, String(fundAUM(f)));
agree('cash + holdings',f);

// A holding in a company that no longer exists must not become NaN.
PRICES={ACME:25};
f={cash:5000,holdings:{ACME:100,GONE:40},shorts:{},units_outstanding:1000};
check('a delisted holding is valued at zero, not NaN', fundAUM(f)===7500, String(fundAUM(f)));

// ── the bug: a short must not destroy assets ──
// $10,000 fund shorts 100 x $20. rpc_fund_short debits 150% collateral
// (3000) and credits no proceeds, so cash falls to 7000. Nothing has been
// earned or lost yet, so AUM must still read 10,000.
PRICES={ACME:20};
f={cash:7000,holdings:{},shorts:{ACME:{qty:100,avgPrice:20,collateral:3000}},units_outstanding:1000};
check('opening a short does not shrink assets', fundAUM(f)===10000, String(fundAUM(f)));
check('...and NAV is unchanged at 10', currentFundNav(f)===10, String(currentFundNav(f)));
agree('flat short',f);

// The short then wins: price halves, so the fund is up (20-10)*100 = 1000.
PRICES={ACME:10};
check('a winning short adds its gain', fundAUM(f)===11000, String(fundAUM(f)));
agree('winning short',f);

// And loses: price doubles, so the fund is down (20-40)*100 = -2000.
PRICES={ACME:40};
check('a losing short subtracts its loss', fundAUM(f)===8000, String(fundAUM(f)));
agree('losing short',f);

// ── everything at once ──
PRICES={ACME:25,BOLT:8,CRUX:12};
f={cash:4000,holdings:{ACME:100,BOLT:250},
   shorts:{CRUX:{qty:50,avgPrice:15,collateral:1125}},units_outstanding:800};
// 4000 + (2500+2000) + (15-12)*50 + 1125 = 9775
check('cash, holdings, short P&L and collateral all count',
      fundAUM(f)===9775, String(fundAUM(f)));
agree('mixed book',f);

// ── shapes that must not throw ──
f={cash:1000,units_outstanding:100};
check('a fund with no holdings/shorts keys still values', fundAUM(f)===1000, String(fundAUM(f)));
f={cash:1000,holdings:null,shorts:null,units_outstanding:100};
check('...and null ones too', fundAUM(f)===1000, String(fundAUM(f)));
f={cash:0,holdings:{},shorts:{},units_outstanding:0};
check('a brand new fund prices units at 10, not Infinity',
      currentFundNav(f)===10, String(currentFundNav(f)));
f={cash:0,holdings:{},shorts:{},units_outstanding:0};
check('...and reports zero assets', fundAUM(f)===0, String(fundAUM(f)));

// A fully covered short leaves a zero-qty entry behind with no collateral;
// it must contribute nothing rather than a phantom P&L.
PRICES={ACME:40};
f={cash:9000,holdings:{},shorts:{ACME:{qty:0,avgPrice:20,collateral:0}},units_outstanding:1000};
check('a closed-out short contributes nothing', fundAUM(f)===9000, String(fundAUM(f)));

// ── and structurally: one sum, not two ──
// The regression this suite is really guarding is someone re-inlining the
// total inside currentFundNav. If that happens the numbers can drift again
// without a single check above failing, because both copies would start out
// identical.
check('currentFundNav defers to fundAUM rather than re-adding it',
      /function currentFundNav\(f\)\{[\s\S]{0,200}?fundAUM\(f\)/.test(src));
check('...and does not build its own holdings sum',
      !/function currentFundNav\(f\)\{[\s\S]{0,400}?f\.holdings/.test(src));

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll fund AUM checks passed.'));
process.exit(fails?1:0);
