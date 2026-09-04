// You can only short a share somebody is actually holding.
//
// placeShort checked collateral and nothing else. With $10,000 and a $1 stock
// you could short 6,666 shares of a company that had only ever issued 1,000 --
// six times its entire existence. checkShortSqueezes then reported "666%
// short", and a squeeze figure that can say 666% is not saying anything.
//
// The borrowable supply is what is IN CIRCULATION, not what exists:
//
//     borrowable = (shares - shares_avail) - already shorted
//
// shares_avail is the un-issued float still sitting in the exchange pool.
// Nobody holds those, so nobody can lend them; they are for sale, not for
// loan. And a share already lent to an open short cannot be lent twice.
//
// Index funds are exempt, for the same reason they are exempt from the
// shares_avail check on a buy: an index mints and burns units on demand rather
// than trading a fixed float, and the server prices a short of one off NAV.
// There is no lender and nothing to run out of -- so borrowable() returns null
// for "no limit", never 0 for "none left". Those two must not be confused: 0
// blocks every short, null allows them.
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
eval(grabFn('borrowable').replace('function borrowable','global.borrowable=function'));

const co=(extra)=>Object.assign({ticker:'ACME',shares:1000,shares_avail:400,is_index_fund:false},extra||{});
const setup=(users,funds)=>{global.DB={users:users||[],funds:funds||[]};};

// ── the supply is what people hold, not what exists ──
setup([]);
check('600 in circulation means 600 to borrow', borrowable(co())===600,
      String(borrowable(co())));
check('the unsold float is not lendable',
      borrowable(co({shares_avail:1000}))===0, String(borrowable(co({shares_avail:1000}))));
check('a fully distributed company lends all of it',
      borrowable(co({shares_avail:0}))===1000, String(borrowable(co({shares_avail:0}))));

// ── a share already on loan cannot be lent again ──
setup([{shorts:{ACME:{qty:100}}}]);
check('an open short reduces what is left', borrowable(co())===500, String(borrowable(co())));
setup([{shorts:{ACME:{qty:100}}},{shorts:{ACME:{qty:250}}}]);
check('every student\'s shorts count', borrowable(co())===250, String(borrowable(co())));
setup([{shorts:{ACME:{qty:600}}}]);
check('fully lent out means none left', borrowable(co())===0, String(borrowable(co())));
// Funds short too, and their borrow comes out of the same pool.
setup([{shorts:{ACME:{qty:100}}}],[{shorts:{ACME:{qty:200}}}]);
check('a fund\'s short counts against the same supply', borrowable(co())===300,
      String(borrowable(co())));

// ── never negative ──
// A position opened before this limit existed can exceed the supply. That must
// read as "nothing left", not as a negative number that compares oddly.
setup([{shorts:{ACME:{qty:5000}}}]);
check('an over-lent book floors at zero, not negative', borrowable(co())===0,
      String(borrowable(co())));
check('shares_avail above shares also floors at zero',
      borrowable(co({shares_avail:5000}))===0, String(borrowable(co({shares_avail:5000}))));

// ── an index has no lender, and no limit ──
setup([{shorts:{JXI:{qty:50}}}]);
const idx=co({ticker:'JXI',is_index_fund:true,shares:100,shares_avail:100});
check('an index fund returns null, meaning no limit', borrowable(idx)===null,
      String(borrowable(idx)));
check('...which is NOT zero', borrowable(idx)!==0);
// shares - shares_avail is 0 for an index, so getting this wrong would block
// every index short outright. That is the failure this pins.
check('...even though its circulation is zero', idx.shares-idx.shares_avail===0);

// ── shapes that must not throw ──
setup([]);
check('a null company is unlimited, not a crash', borrowable(null)===null);
check('a company with no share counts reads zero',
      borrowable({ticker:'X'})===0, String(borrowable({ticker:'X'})));
setup([{shorts:null},{},{shorts:{ACME:null}}]);
check('users with null or missing shorts are skipped', borrowable(co())===600,
      String(borrowable(co())));
global.DB={};
check('no users or funds arrays at all does not throw', borrowable(co())===600,
      String(borrowable(co())));
setup([{shorts:{ACME:{qty:'100'}}}]);
check('a numeric string qty is coerced, not concatenated', borrowable(co())===500,
      String(borrowable(co())));

// ── the guards that use it ──
for(const [fn,label] of [['placeShort','a student'],['fundShort','a fund']]){
  const body=grabFn(fn);
  check(label+' cannot short more than is borrowable',
        /const canBorrow=borrowable\(co\);\s*\n\s*if\(canBorrow!=null&&qty>canBorrow\)return toast\(borrowMsg\(co\)\);/.test(body),
        body.slice(0,400));
  // null means unlimited. A plain `if(qty>canBorrow)` would compare against
  // null, coerce it to 0, and block every index short.
  check('...and an index is not blocked by a null limit',
        /canBorrow!=null&&/.test(body), body.slice(0,400));
  // The check has to come before the collateral maths, or a student is told
  // about money when the real problem is supply.
  check('...checked before the collateral message',
        body.indexOf('canBorrow')<body.indexOf('collateral'), fn);
}

// ── Max never offers a quantity that would be refused ──
const quick=grabFn('quickSetQty');
check('the Max button is capped by what can be borrowed',
      /const canBorrow=borrowable\(co\);\s*\n\s*if\(canBorrow!=null\)qty=Math\.min\(qty,canBorrow\);/.test(quick),
      quick.slice(0,600));

// ── and the number is visible before the refusal ──
const prev=grabFn('shortPrev');
check('the short preview shows what can be borrowed', /borrowable\(co\)/.test(prev), prev);
check('...and says so in red when the order is too big', /var\(--red\)/.test(prev), prev);
check('...while an index preview shows no limit at all',
      /canBorrow==null\?''/.test(prev), prev);

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll borrow-limit checks passed.'));
process.exit(fails?1:0);
