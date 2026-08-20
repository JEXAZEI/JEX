// Models the compute-then-pay structure of rpc_pay_dividend, with a
// concurrent holdings change landing between the two passes, to check that
// the snapshot version stays conserved where the re-query version does not.
const r2=x=>Math.round(x*100)/100;

// --- OLD: re-queries jex_users in the payout pass ---
function oldWay({holders,perShare,fundShares,totalUnits,mutate}){
  let charged=0;
  for(const h of holders) if(h.shares>0) charged=r2(charged+r2(h.shares*perShare));
  const eligible=holders.reduce((s,h)=>s+h.units,0);
  const fundCharge=(totalUnits>0&&eligible>0)?r2(fundShares*perShare*(eligible/totalUnits)):0;
  charged=r2(charged+fundCharge);

  const now=mutate(holders.map(h=>({...h})));   // a trade lands here

  let paid=0;
  for(const h of now) if(h.shares>0) paid=r2(paid+r2(h.shares*perShare));
  // fund side re-queries holders too, but divides by the SNAPSHOTTED denominator
  for(const h of now) if(h.units>0) paid=r2(paid+r2(fundCharge*h.units/eligible));
  return {charged,paid};
}

// --- NEW: pays from the snapshot taken in the first pass ---
function newWay({holders,perShare,fundShares,totalUnits,mutate}){
  const directCuts=[],fundHolders=[];
  let charged=0;
  for(const h of holders) if(h.shares>0){const p=r2(h.shares*perShare);directCuts.push({id:h.id,payout:p});charged=r2(charged+p);}
  for(const h of holders) if(h.units>0) fundHolders.push({id:h.id,units:h.units});
  const eligible=fundHolders.reduce((s,h)=>s+h.units,0);
  const fundCharge=(totalUnits>0&&eligible>0)?r2(fundShares*perShare*(eligible/totalUnits)):0;
  charged=r2(charged+fundCharge);

  mutate(holders.map(h=>({...h})));             // same trade lands here, ignored

  let paid=0;
  for(const c of directCuts) paid=r2(paid+c.payout);
  if(eligible>0) for(const h of fundHolders) paid=r2(paid+r2(fundCharge*h.units/eligible));
  return {charged,paid};
}

let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

const base={
  holders:[{id:'a',shares:100,units:50},{id:'b',shares:60,units:30},{id:'c',shares:40,units:20}],
  perShare:0.75,fundShares:800,totalUnits:200,
};

const races=[
  {label:'a holder SELLS shares between the two passes', mutate:hs=>{hs[0].shares=20;return hs;}},
  {label:'a holder BUYS shares between the two passes',  mutate:hs=>{hs[1].shares=500;return hs;}},
  {label:'a holder sells all their JXI units',           mutate:hs=>{hs[2].units=0;return hs;}},
  {label:'a holder doubles their JXI units',             mutate:hs=>{hs[0].units=100;return hs;}},
  {label:'a new holder appears',                          mutate:hs=>{hs.push({id:'d',shares:90,units:40});return hs;}},
  {label:'nothing changes (control)',                     mutate:hs=>hs},
];

for(const r of races){
  const o=oldWay({...base,mutate:r.mutate});
  const n=newWay({...base,mutate:r.mutate});
  const oldGap=r2(o.charged-o.paid), newGap=r2(n.charged-n.paid);
  console.log(`\n${r.label}`);
  console.log(`  old: charged $${o.charged}, paid $${o.paid}, gap $${oldGap}`);
  console.log(`  new: charged $${n.charged}, paid $${n.paid}, gap $${newGap}`);
  const tol=0.01*(base.holders.length+1);
  check('  snapshot version stays conserved', Math.abs(newGap)<=tol, `gap $${newGap}`);
}

console.log('\n=== the race is real in the old structure ===');
{
  const o=oldWay({...base,mutate:hs=>{hs[0].shares=20;return hs;}});
  check('old version really did diverge when a holder sold', Math.abs(r2(o.charged-o.paid))>0.05, `gap was $${r2(o.charged-o.paid)}`);
  const c=oldWay({...base,mutate:hs=>hs});
  check('old version was fine when nothing changed', Math.abs(r2(c.charged-c.paid))<=0.05);
}
console.log('\n=== eligibility filter consistency ===');
{
  // an unapproved holder is now excluded from BOTH denominator and payout
  const noop=hs=>hs;
  const withUnapproved={...base,holders:[...base.holders,{id:'x',shares:0,units:100}],mutate:noop};
  const nAll=newWay(withUnapproved);            // as if 'x' were eligible
  const nFiltered=newWay({...base,mutate:noop});// 'x' filtered out of both
  check('excluding a holder lowers the charge too, not just the payout', nFiltered.charged<nAll.charged);
  check('both remain conserved either way', Math.abs(r2(nAll.charged-nAll.paid))<=0.05&&Math.abs(r2(nFiltered.charged-nFiltered.paid))<=0.05);
}

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
