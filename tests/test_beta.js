const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','app.js'),'utf8');
function extractFn(name){
  const start=src.indexOf('function '+name+'(');
  let i=src.indexOf('{',start),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--; if(d===0)return src.slice(start,i+1);} }
}
function extractConst(name){
  const start=src.indexOf('const '+name+'=');
  let i=start,d=0;
  for(;i<src.length;i++){const ch=src[i];
    if('{(['.includes(ch))d++; else if('})]'.includes(ch))d--;
    else if(ch===';'&&d===0)return src.slice(start,i+1);}
}
eval(extractConst('nwSnapshots').replace('const ','var '));
eval(extractFn('calcBeta').replace('function calcBeta','calcBeta=function'));

let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const near=(a,b,tol)=>a!==null&&Math.abs(a-b)<=(tol||0.02);

const T=n=>new Date(Date.UTC(2026,7,10,12,0,0)+n*60000).toISOString();
global.getUser=id=>({id});

// Market path and a portfolio that tracks it with a known leverage factor.
function build(mktLevels,leverage,{nwOffsetMs=1000,startNw=10000}={}){
  const index=mktLevels.map((v,i)=>({value:v,created_at:T(i)}));
  let nwv=startNw;const nwHistory=[{user_id:'u1',nw:nwv,created_at:new Date(Date.parse(T(0))+nwOffsetMs).toISOString()}];
  for(let i=1;i<mktLevels.length;i++){
    const mr=(mktLevels[i]-mktLevels[i-1])/mktLevels[i-1];
    nwv=nwv*(1+leverage*mr);
    nwHistory.push({user_id:'u1',nw:nwv,created_at:new Date(Date.parse(T(i))+nwOffsetMs).toISOString()});
  }
  return {indexHistory:index,nwHistory};
}

const path=[1000,1020,1005,1040,1010,1060,1035,1080,1050,1100];

console.log('=== recovers a known beta ===');
for(const lev of [1,2,0.5,0,-1]){
  global.DB=build(path,lev);
  const b=calcBeta('u1');
  // Compounded returns aren't exactly linear in the market return, so allow
  // a small tolerance around the seeded leverage.
  check(`leverage ${lev} -> beta ~= ${lev} (got ${b})`, near(b,lev,0.06), 'got '+b);
}

console.log('\n=== ordering robustness ===');
{
  const d=build(path,2);
  // deliver nwHistory newest-first, the way sb.get('created_at.desc') does
  global.DB={indexHistory:d.indexHistory,nwHistory:d.nwHistory.slice().reverse()};
  check('unsorted (desc) nwHistory still yields the same beta', near(calcBeta('u1'),2,0.06), 'got '+calcBeta('u1'));
  global.DB={indexHistory:d.indexHistory.slice().reverse(),nwHistory:d.nwHistory};
  check('reversed indexHistory still yields the same beta', near(calcBeta('u1'),2,0.06), 'got '+calcBeta('u1'));
}

console.log('\n=== degenerate inputs return null, never a fake 1.0 ===');
global.DB=build([1000,1000,1000,1000,1000,1000],1);
check('flat market -> null (old code returned 1)', calcBeta('u1')===null, 'got '+calcBeta('u1'));

global.DB={indexHistory:[],nwHistory:build(path,1).nwHistory};
check('no index history -> null', calcBeta('u1')===null);

global.DB={indexHistory:build(path,1).indexHistory,nwHistory:[]};
check('no nw history -> null', calcBeta('u1')===null);

global.DB=build([1000,1020,1005],1);
check('too few points -> null', calcBeta('u1')===null);

{ // every nw snapshot predates the first index reading
  const d=build(path,1);
  global.DB={nwHistory:d.nwHistory,indexHistory:d.indexHistory.map(x=>({...x,created_at:T(500)}))};
  check('nw snapshots all predate any index reading -> null', calcBeta('u1')===null, 'got '+calcBeta('u1'));
}

{ // malformed rows must not crash or poison the result
  const d=build(path,2);
  global.DB={nwHistory:[...d.nwHistory,{user_id:'u1',nw:null,created_at:'not-a-date'},{user_id:'u1'}],
             indexHistory:[...d.indexHistory,{value:0,created_at:T(3)},{value:1050},null]};
  const b=calcBeta('u1');
  check('malformed index/nw rows are skipped, not crashed on', near(b,2,0.06), 'got '+b);
}

{ // zero / negative net worth must not divide by zero
  const d=build(path,1);
  global.DB={indexHistory:d.indexHistory,nwHistory:d.nwHistory.map((x,i)=>i===3?{...x,nw:0}:x)};
  const b=calcBeta('u1');
  check('a zero net-worth snapshot does not produce NaN/Infinity', b===null||Number.isFinite(b), 'got '+b);
}

console.log('\n=== does not mutate shared state ===');
{
  const d=build(path,1);
  global.DB=d;
  const before=d.indexHistory.map(x=>x.value).join(',');
  calcBeta('u1');
  check('DB.indexHistory left untouched', d.indexHistory.map(x=>x.value).join(',')===before);
}

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
