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
eval(extractFn('calcSharpe').replace('function calcSharpe','calcSharpe=function'));
eval(extractFn('calcVaR').replace('function calcVaR','calcVaR=function'));

let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// Build snapshots newest-first, exactly how sb.get('order=created_at.desc') delivers them.
const iso=n=>new Date(Date.UTC(2026,7,10,12,0,0)+n*3600000).toISOString();
const mk=(nw,n)=>({user_id:'u1',nw,created_at:iso(n),ts:'fake string ts'});

console.log('=== nwSnapshots ordering ===');
global.DB={nwHistory:[mk(1300,5),mk(1200,4),mk(900,3),mk(1100,2),mk(1000,1)]}; // desc, as loaded
let s=nwSnapshots('u1');
check('sorts oldest-first regardless of load order', JSON.stringify(s.map(x=>x.nw))===JSON.stringify([1000,1100,900,1200,1300]), JSON.stringify(s.map(x=>x.nw)));

// live-appended rows land at the END of a desc-ordered array
global.DB={nwHistory:[mk(1300,5),mk(1200,4),mk(1000,1),mk(1400,6)]};
s=nwSnapshots('u1');
check('interleaves a live-appended newest row correctly', JSON.stringify(s.map(x=>x.nw))===JSON.stringify([1000,1200,1300,1400]), JSON.stringify(s.map(x=>x.nw)));

global.DB={nwHistory:[mk(100,1),{user_id:'u2',nw:999,created_at:iso(2)}]};
check('filters to the requested user only', nwSnapshots('u1').length===1);

global.DB={nwHistory:[{user_id:'u1',nw:5},{user_id:'u1',nw:6}]};
check('rows with no created_at do not crash (stable, order preserved)', JSON.stringify(nwSnapshots('u1').map(x=>x.nw))===JSON.stringify([5,6]));

const before=[mk(1300,5),mk(1200,4)];
global.DB={nwHistory:before};
nwSnapshots('u1');
check('does not mutate DB.nwHistory in place', DB.nwHistory[0].nw===1300);

console.log('\n=== the ts-string sort this replaced ===');
const tsSort=(a,b)=>a.ts>b.ts?1:-1;
const byTs=[{ts:'Aug 19, 3:00:00 PM'},{ts:'Aug 9, 3:00:00 PM'}].slice().sort(tsSort);
check('old comparator really did put "Aug 19" before "Aug 9"', byTs[0].ts.startsWith('Aug 19'));
const byTs2=[{ts:'Aug 9, 11:00:00 AM'},{ts:'Aug 9, 9:00:00 AM'}].slice().sort(tsSort);
check('old comparator really did put 11:00 AM before 9:00 AM', byTs2[0].ts.includes('11:00'));

console.log('\n=== calcVaR ===');
global.getUser=id=>({id});
// The case that actually separates the fix from the old losses-only code:
// 30 snapshots -> 29 changes, only 3 of which are losses (-100, -60, -20).
// OLD: losses=[100,60,20], floor(3*0.05)=0 -> reports 100, the worst loss
//      ever, as the "95%" figure even though only 10% of periods lose.
// NEW: 29 changes sorted ascending, floor(29*0.05)=1 -> the second-worst
//      change (-60). The 5% tail of the FULL distribution, which is what
//      95% VaR means.
global.DB={nwHistory:(()=>{const out=[];let v=5000;const losses={5:-100,12:-60,20:-20};
  for(let i=0;i<30;i++){v+=losses[i]!==undefined?losses[i]:15;out.push(mk(v,i));}return out;})()};
let v=calcVaR('u1');
check('few losses among many gains -> 5% tail of all changes, not the worst loss', v===60, 'got '+v+' (old code would report 100)');

// Honest about the inherent limit: with a small sample the 5th percentile
// genuinely IS the worst observation. Asserted so a future change that
// silently alters it gets caught.
global.DB={nwHistory:(()=>{const out=[];let x=1000;
  for(let i=0;i<10;i++){x+= i===4?-250:10;out.push(mk(x,i));}return out;})()};
check('small sample: 5th percentile degenerates to the worst change (documented)', calcVaR('u1')===250, 'got '+calcVaR('u1'));

// monotonic gains only -> no loss at 95%
global.DB={nwHistory:(()=>{const out=[];let x=1000;for(let i=0;i<20;i++){x+=25;out.push(mk(x,i));}return out;})()};
check('all-gains history -> VaR 0', calcVaR('u1')===0, 'got '+calcVaR('u1'));

// monotonic losses -> VaR equals the per-period loss
global.DB={nwHistory:(()=>{const out=[];let x=2000;for(let i=0;i<20;i++){x-=30;out.push(mk(x,i));}return out;})()};
check('all-losses history -> VaR 30', calcVaR('u1')===30, 'got '+calcVaR('u1'));

global.DB={nwHistory:[mk(1000,1),mk(1010,2)]};
check('too few snapshots -> null', calcVaR('u1')===null);

console.log('\n=== calcSharpe ===');
global.DB={nwHistory:(()=>{const out=[];let x=1000;for(let i=0;i<10;i++){x*=1.02;out.push(mk(x,i));}return out;})()};
check('steady identical gains -> stddev 0 -> null', calcSharpe('u1')===null, 'got '+calcSharpe('u1'));
global.DB={nwHistory:[mk(1000,1),mk(1100,2),mk(1050,3),mk(1200,4),mk(1150,5)]};
const sh=calcSharpe('u1');
check('mixed returns -> finite number', typeof sh==='number'&&Number.isFinite(sh), 'got '+sh);
global.DB={nwHistory:[mk(1000,1),mk(1100,2)]};
check('fewer than 3 snapshots -> null', calcSharpe('u1')===null);
global.DB={nwHistory:[mk(0,1),mk(0,2),mk(0,3),mk(0,4)]};
check('zero net worth throughout does not divide by zero', calcSharpe('u1')===null);

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
