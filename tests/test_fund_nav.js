// A fund unit cannot be worth less than nothing.
//
// A fund's AUM is cash + holdings + short P&L + short collateral. A short
// contributes `qty * (2.5*entry - price)` to that, so the position turns
// negative once the stock passes 2.5x the entry price, and past that the whole
// NAV can go negative. Nothing prevents a fund getting there: there is no
// fund-side margin call anywhere -- rpc_margin_call_short takes a p_user_id
// and reads jex_users, and checkMarginCalls() walks DB.users.
//
// ── What a negative NAV did ──
//
// Measured against the live function bodies running locally. A fund with
// $5,000 cash, 1,000 units outstanding, short 1,000 shares entered at $5.00
// with $7,500 posted, against a $30.00 price. NAV per unit: -$12.50.
//
//   an investor withdraws 1,000 units
//       receives -$12,500.00. Their cash goes 20,000 -> 7,500. They are
//       CHARGED $12,500 to leave a fund in which they had already lost
//       everything.
//
//   the same investor with $100 to their name
//       ERROR: violates "chk_users_cash_nonneg". They cannot leave at all.
//
//   somebody else deposits $1,000
//       receives -80.0000 units at costBasis -12.5000, and the fund's
//       units_outstanding goes DOWN from 1,000 to 920.
//
// rpc_fund_withdraw has a guard meant to catch this:
//
//     if v_fund.cash < v_gross then raise exception '... not enough
//       uninvested cash ...'
//
// With v_gross negative, `cash < gross` is false. The guard was written for a
// gross that is too big, and a negative one is smaller than everything.
//
// ── The rule ──
//
// A unit is floored at zero on BOTH sides -- jex_fund_nav() server-side and
// currentFundNav() here. An investor in a fund that has lost more than it
// holds loses what they put in and not a cent more, which is what every
// balance in this database already assumes: jex_users.cash, jex_funds.cash and
// jex_funds.units_outstanding all carry CHECK (>= 0).
//
// The two halves have to agree because they feed different things that are
// compared to each other: currentFundNav -> fundValue -> nw() and the
// leaderboard; jex_fund_nav -> rpc_snapshot_nw -> the GRADED history, and
// rpc_fund_withdraw -> what the depositor is actually paid.
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
// These are arrow functions with reduce() callbacks inside, so "up to the
// first balanced pair of braces" stops in the middle of one. Scan to the
// semicolon that ends the statement instead, counting every kind of bracket.
function grabConst(name){
  const m=new RegExp('(?:^|;)const '+name+'=','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  const start=m.index+(m[0].startsWith(';')?1:0);
  let d=0;
  for(let i=start;i<src.length;i++){
    const ch=src[i];
    if(ch==='('||ch==='{'||ch==='[')d++;
    else if(ch===')'||ch==='}'||ch===']')d--;
    else if(ch===';'&&d===0)return src.slice(start,i+1);
  }
  throw new Error('unterminated: '+name);
}

global.DB={companies:[],funds:[],users:[],session:{}};
global.getCo=t=>DB.companies.find(c=>c.ticker===t)||null;
eval(grabConst('fundShorts').replace(/^const /,'global.'));
eval(grabConst('fundShortPnl').replace(/^const /,'global.'));
eval(grabConst('fundShortCollateral').replace(/^const /,'global.'));
eval(grabFn('fundAUM').replace(/^function /,'global.fundAUM=function '));
eval(grabFn('currentFundNav').replace(/^function /,'global.currentFundNav=function '));

// jex_fund_nav(), transcribed. Same expression, same floor, same rounding.
const sqlNav=f=>{
  if(!(f.units_outstanding>0))return 10;
  const holdings=Object.entries(f.holdings||{}).reduce((s,[t,q])=>{const c=getCo(t);return s+(c?c.price*q:0);},0);
  const pnl=Object.entries(f.shorts||{}).reduce((s,[t,p])=>{const c=getCo(t);return c?s+Math.round((p.avgPrice-c.price)*100)/100*p.qty:s;},0);
  const coll=Object.entries(f.shorts||{}).reduce((s,[,p])=>s+p.collateral,0);
  return Math.max(0,Math.round(((f.cash+holdings+pnl+coll)/f.units_outstanding)*10000)/10000);
};

const fund=(cash,units,holdings,shorts)=>({id:'f1',cash,units_outstanding:units,
  holdings:holdings||{},shorts:shorts||{},status:'active',fee_pct:10});

// ── the measured case ──
DB.companies=[{ticker:'ACME',price:30,shares:2000}];
const blown=fund(5000,1000,{},{ACME:{qty:1000,avgPrice:5,collateral:7500}});
check('the measured fund is floored to 0 client-side', currentFundNav(blown)===0, String(currentFundNav(blown)));
check('...and server-side', sqlNav(blown)===0, String(sqlNav(blown)));
check('...where the raw figure was -12.50',
      Math.round(((5000+(5-30)*1000+7500)/1000)*10000)/10000===-12.5);
check('a 1,000-unit withdrawal used to charge -12,500.00',
      Math.round(1000*-12.5*100)/100===-12500);
check('...and now pays exactly 0.00', Math.round(1000*currentFundNav(blown)*100)/100===0);
check('a 1,000 deposit used to mint -80 units',
      Math.round((1000/-12.5)*10000)/10000===-80);

// ── the two halves agree everywhere, not just at zero ──
const cases=[
  ['a plain cash fund',                fund(10000,1000,{},{})],
  ['holdings and no shorts',           fund(5000,1000,{ACME:100},{})],
  ['a profitable short',               fund(5000,1000,{},{ACME:{qty:100,avgPrice:40,collateral:6000}})],
  ['a losing short, still solvent',    fund(50000,1000,{},{ACME:{qty:1000,avgPrice:20,collateral:30000}})],
  ['a short exactly at the waterline', fund(0,1000,{},{ACME:{qty:400,avgPrice:12,collateral:7200}})],
  ['the blown one',                    blown],
  ['no units outstanding',             fund(0,0,{},{})],
  ['a fund holding a delisted-price stock', fund(1,1,{GONE:50},{})],
];
for(const [label,f] of cases){
  check('client and server agree: '+label, currentFundNav(f)===sqlNav(f),
        currentFundNav(f)+' vs '+sqlNav(f));
  check('...and it is never negative: '+label, currentFundNav(f)>=0, String(currentFundNav(f)));
}

// 2.5x the entry is where a short's contribution to AUM crosses zero. Pinned
// because it is the number that says how far a fund can run before this
// matters, and it is not obvious from the code.
const contribution=(qty,entry,price)=>qty*(entry-price)+qty*entry*1.5;
check('a short contributes nothing to AUM at exactly 2.5x the entry',
      contribution(100,10,25)===0);
check('...and goes negative past it', contribution(100,10,26)<0);
check('...while it is still positive just below', contribution(100,10,24)>0);

// ── the client refuses a deposit and warns on a withdrawal ──
check('depositToFund refuses a fund whose units are worth nothing',
      /if\(currentFundNav\(f\)<=0\)return toast\(f\.name\+' has lost more than it holds/.test(src));
check('withdrawFromFund warns instead of silently paying 0.00',
      /if\(currentFundNav\(f\)<=0&&!confirm\(/.test(src));
check('...and still lets them out if they say yes',
      /Withdraw anyway\?'\)\)return;/.test(src));

// ── and the floor is actually in the client function, not just asserted ──
check('currentFundNav floors at zero', /Math\.max\(0,Math\.round\(\(totalValue\/f\.units_outstanding\)/.test(src));
check('an empty fund still quotes the 10.00 seed, not 0',
      currentFundNav(fund(0,0,{},{}))===10);

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
