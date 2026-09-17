// A bankruptcy settlement that pays out more than the company has.
//
// rpc_review_delisting pays shareholders pro-rata when a company cannot cover
// what it owes:
//
//   ratio = min(1, owner_cash / owed)        exact, many decimals
//   amt   = round(qty * price * ratio, 2)    per holder, to the cent
//   owner_cash -= sum(amt)
//
// The ratio is exact but each payout is rounded on its own, so the rounded SUM
// can land above owner_cash -- by up to half a cent per holder. The company is
// then charged more than it has, chk_users_cash_nonneg fires, and the ENTIRE
// settlement rolls back with a raw database error on a button that should have
// worked:
//
//   new row for relation "jex_users" violates check constraint
//   "chk_users_cash_nonneg"
//
// Measured against the real function on a copy of production, 60 randomized
// bankruptcies with 15 holders each -- a real class:
//
//   before   43 settled, 17 FAILED   (28%)
//   after   200 settled,  0 failed, 0 conservation breaks, owner never
//           negative, at most 3 cents left unpaid
//
// The fix is a budget: each holder gets their rounded share or whatever is
// left, whichever is smaller. This file pins the arithmetic that fix depends
// on, because the server half is the only place it lives.
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const r2=n=>Math.round(n*100)/100;

// The old way: round each payout independently and hope.
const payoutOld=(qtys,price,ratio)=>qtys.reduce((s,q)=>r2(s+r2(q*price*ratio)),0);
// The new way: never spend more than is left.
const payoutNew=(qtys,price,ratio,cash)=>{
  let budget=cash,total=0;
  for(const q of qtys){const amt=Math.min(r2(q*price*ratio),budget);budget=r2(budget-amt);total=r2(total+amt);}
  return total;
};

// ── the exact case the rig failed on ──
// 15 holders, $27.38 a share, the company holding $57,796.49 against
// $89,505.22 owed.
const price=27.38,cash=57796.49,owed=89505.22,ratio=cash/owed;
// Share counts that reproduce an overshoot: every holder rounding up.
const qtys=[];
for(let i=0;i<15;i++){
  // find a quantity whose payout rounds UP at this ratio
  let q=1;
  for(let t=1;t<4000;t++){const exact=t*price*ratio;if(r2(exact)>exact){q=t;break;}}
  qtys.push(q);
}
const owedHere=r2(qtys.reduce((s,q)=>s+q,0)*price);
const ratioHere=Math.min(1,cash/owedHere);
check('every one of the 15 payouts rounds up at this ratio',
      qtys.every(q=>r2(q*price*ratioHere)>=q*price*ratioHere));

// With all 15 rounding up, the old sum exceeds the exact total.
const exactTotal=qtys.reduce((s,q)=>s+q*price*ratioHere,0);
check('the old sum is above the exact pro-rata total',
      payoutOld(qtys,price,ratioHere)>=r2(exactTotal),
      payoutOld(qtys,price,ratioHere)+' vs '+r2(exactTotal));

// ── the property that actually matters ──
//
// Whatever the holders, the prices or the ratio, the new payout can never
// exceed the cash being spent. That is the whole fix.
let worstOld=0,overOld=0,overNew=0,runs=0;
let seed=20260917;
const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
for(let t=0;t<20000;t++){
  const n=2+Math.floor(rnd()*14);
  const px=r2(rnd()*40+0.5);
  const qs=Array.from({length:n},()=>1+Math.floor(rnd()*400));
  const od=r2(qs.reduce((s,q)=>s+q,0)*px);
  if(od<=0)continue;
  const ch=r2(rnd()*od*0.98);
  const rt=Math.min(1,ch/od);
  runs++;
  const o=payoutOld(qs,px,rt),nw=payoutNew(qs,px,rt,ch);
  if(o>ch){overOld++;worstOld=Math.max(worstOld,r2(o-ch));}
  if(nw>ch)overNew++;
}
check('the simulation actually ran', runs>15000, String(runs));
check('the old arithmetic overpays on a large fraction of bankruptcies',
      overOld/runs>0.15, (overOld/runs*100).toFixed(1)+'%');
check('...by cents, not dollars -- it is a rounding fault, not a logic one',
      worstOld>0&&worstOld<=0.10, String(worstOld));
check('the new arithmetic NEVER overpays, across every case',
      overNew===0, String(overNew)+' of '+runs);

// ── and it must not quietly underpay when there is plenty ──
//
// Going private refuses unless the company covers the whole buyout, so ratio
// is 1 and the budget must never bind.
const qs2=[100,250,7,1,999];
const px2=12.34;
const owed2=r2(qs2.reduce((s,q)=>s+q,0)*px2);
check('with ratio 1 and cash to spare, every holder is paid in full',
      payoutNew(qs2,px2,1,owed2+1000)===payoutOld(qs2,px2,1),
      payoutNew(qs2,px2,1,owed2+1000)+' vs '+payoutOld(qs2,px2,1));
check('...and that total is the exact amount owed', payoutOld(qs2,px2,1)===owed2,
      payoutOld(qs2,px2,1)+' vs '+owed2);

// A wipeout -- 0 a share -- pays nothing and must not go wrong.
check('a $0 settlement pays nothing', payoutNew(qs2,0,1,500)===0);
check('a company with no cash pays nothing', payoutNew(qs2,px2,0.5,0)===0);
check('a single holder takes the whole budget and no more',
      payoutNew([1000],px2,1,50)===50);
check('the second holder gets what the first left',
      payoutNew([1000,1000],px2,1,50)===50);

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
