// Models the JXI pass-through arithmetic before and after the fix, to check
// that what the payer is charged equals what recipients actually receive.
const r2=x=>Math.round(x*100)/100;

function oldWay({fundShares,perShare,totalUnits,studentUnits}){
  const charged=r2(fundShares*perShare);
  const paid=studentUnits.reduce((s,u)=>s+(totalUnits>0?r2(charged*u/totalUnits):0),0);
  return {charged,paid:r2(paid)};
}
function newWay({fundShares,perShare,totalUnits,studentUnits}){
  const eligible=studentUnits.reduce((s,u)=>s+u,0);
  const charged=(totalUnits>0&&eligible>0)?r2(fundShares*perShare*(eligible/totalUnits)):0;
  const paid=eligible>0?studentUnits.reduce((s,u)=>s+r2(charged*u/eligible),0):0;
  return {charged,paid:r2(paid)};
}

let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

const cases=[
  {label:'a fund holds 400 of 1000 JXI units (students hold 600)',
   s:{fundShares:1000,perShare:0.50,totalUnits:1000,studentUnits:[300,200,100]}},
  {label:'all units held by students (no leak either way)',
   s:{fundShares:1000,perShare:0.50,totalUnits:600,studentUnits:[300,200,100]}},
  {label:'a fund holds almost everything (10 of 1000 with students)',
   s:{fundShares:2000,perShare:1.25,totalUnits:1000,studentUnits:[10]}},
  {label:'no student holds any JXI at all',
   s:{fundShares:1000,perShare:0.50,totalUnits:1000,studentUnits:[]}},
  {label:'awkward ratios that stress cent rounding',
   s:{fundShares:777,perShare:0.37,totalUnits:1000,studentUnits:[133,267,91]}},
  {label:'single holder owns every unit',
   s:{fundShares:500,perShare:2,totalUnits:250,studentUnits:[250]}},
  {label:'zero units outstanding (degenerate)',
   s:{fundShares:500,perShare:2,totalUnits:0,studentUnits:[]}},
];

console.log('=== the leak, before and after ===');
for(const c of cases){
  const o=oldWay(c.s),n=newWay(c.s);
  const oldLeak=r2(o.charged-o.paid), newLeak=r2(n.charged-n.paid);
  console.log(`\n${c.label}`);
  console.log(`  old: charged $${o.charged}, paid $${o.paid}, LOST $${oldLeak}`);
  console.log(`  new: charged $${n.charged}, paid $${n.paid}, lost $${newLeak}`);
  // Cent-level rounding across holders is inherent; anything beyond that is a leak.
  const tol=0.01*Math.max(c.s.studentUnits.length,1);
  check('  conserved after fix (|charged - paid| within cent rounding)', Math.abs(newLeak)<=tol, `leak $${newLeak}, tolerance $${r2(tol)}`);
  check('  no recipient is ever paid more than was charged', n.paid<=n.charged+tol);
}

console.log('\n=== the fix actually changes the leaking cases ===');
{
  const leaky=cases[0];
  const o=oldWay(leaky.s),n=newWay(leaky.s);
  check('fund-held units really did leak before', r2(o.charged-o.paid)>0, `old leak was $${r2(o.charged-o.paid)}`);
  check('payer is charged strictly less now', n.charged<o.charged, `${n.charged} vs ${o.charged}`);
  check('students receive the same as before', Math.abs(n.paid-o.paid)<=0.03, `${n.paid} vs ${o.paid}`);
}
{
  const clean=cases[1];
  const o=oldWay(clean.s),n=newWay(clean.s);
  check('the no-leak case is left untouched by the fix', Math.abs(n.charged-o.charged)<0.01&&Math.abs(n.paid-o.paid)<0.01);
}
{
  const none=cases[3];
  const n=newWay(none.s);
  check('nobody eligible -> payer charged nothing at all', n.charged===0&&n.paid===0);
}

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
