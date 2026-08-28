// One instrument, one number.
//
// From a real screenshot of the market page, all at the same moment:
//
//   index card ........ 1244.00   "+0% today"   (computed live)
//   Listed table ...... $123.68   "+0.00%"      (the cached column)
//   its one constituent  $31.10   "+0.58%"
//   the chart ......... a single dot
//
// jex_companies.price and .price_history on an index row are a CACHE of a
// derived value, and only the paths that trade the index itself refresh them.
// The value moves whenever a CONSTITUENT moves -- most trades on the exchange
// -- and whenever the constituent set changes at all: a listing, a delisting,
// a class becoming restricted. Between those, the cache is stale, and the page
// quotes three different answers for one instrument.
//
// indexSeries() derives the whole series from the constituents' own histories
// instead, so there is nothing to invalidate and nothing to keep in step.
// syncIndexRows() points every index row at it once per render, before any
// price is read.
//
// The numbers below are the screenshot's: AZEI at 31.10 against a 25.00 IPO
// base is a ratio of 1.244, an index level of 1244.00, and a unit price of
// 124.40 -- not the 123.68 the table was showing.
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

global.getClassMeta=()=>null;
global.isHiddenTestEntity=()=>false;
global.getUser=id=>(DB.users||[]).find(u=>u.id===id)||null;
global.getCo=t=>(DB.companies||[]).find(c=>c.ticker===t)||null;
eval(grabFn('computeIndex'));
eval(grabFn('computeJXI'));
eval(grabFn('indexSeries'));
eval(grabFn('syncIndexRows'));
eval(grabFn("filterByInterval"));
eval(grabFn("anchorToSessionOpen"));
eval(grabFn("intervalChg"));

const T=(n)=>'2026-08-2'+n+'T12:00:00.000Z';
const IDX=()=>({ticker:'JXI',name:'JEX Composite',is_index_fund:true,index_classroom_id:null,
  status:'listed',owner_id:null,price:123.68,shares:100,shares_avail:100,
  price_history:[{p:123.68,t:T(5)}]});
const AZEI=()=>({ticker:'AZEI',name:'Azalea Enterprises Inc.',status:'listed',owner_id:'o1',
  price:31.10,shares:1000,shares_avail:263,index_base_adjust:1,
  price_history:[{p:25.00,t:T(1)},{p:28.00,t:T(3)},{p:30.92,t:T(5)},{p:31.10,t:T(6)}]});

global.DB={users:[{id:'o1',classroom_id:'cA'}],companies:[],session:{session_started_at:null}};

// ── the screenshot ──
DB.companies=[IDX(),AZEI()];
const idx=getCo('JXI');
check('the cached column starts stale, exactly as reported', idx.price===123.68);
check('...while the live basket says 1244.00', computeJXI().value===1244,
      String(computeJXI().value));

syncIndexRows();
check('after the sync the row quotes the live value', getCo('JXI').price===124.40,
      String(getCo('JXI').price));
check('...which is the index level over ten', getCo('JXI').price===computeJXI().value/10,
      getCo('JXI').price+' vs '+computeJXI().value/10);

// The "+0% today" half. The badge reads the row's history through
// intervalChg(); with a one-point cache there is nothing to compare, so it
// printed 0 next to a constituent that had moved.
const hist=getCo('JXI').price_history;
check('the derived series has a point per constituent move', hist.length===4,
      JSON.stringify(hist));
check('...in chronological order', hist.every((p,i)=>!i||p.t>=hist[i-1].t));
check('...starting at the base, 1000/10', hist[0].p===100, String(hist[0].p));
check('...and ending at the live value', hist[hist.length-1].p===124.40, String(hist[hist.length-1].p));
check('the change is no longer flat', intervalChg(hist,'max')!==0, String(intervalChg(hist,'max')));
check('...and matches the constituent, since it is the only one',
      intervalChg(hist,'max')===intervalChg(getCo('AZEI').price_history,'max'),
      intervalChg(hist,'max')+' vs '+intervalChg(getCo('AZEI').price_history,'max'));

// ── a constituent moving must move the index, with no index trade at all ──
DB.companies=[IDX(),AZEI()];
syncIndexRows();
const before=getCo('JXI').price;
const az=getCo('AZEI');
az.price=34.21; az.price_history=[...az.price_history,{p:34.21,t:T(7)}];
syncIndexRows();
check('a constituent trade moves the index without any index trade',
      getCo('JXI').price>before, before+' -> '+getCo('JXI').price);
check('...to exactly the new basket average', getCo('JXI').price===136.84,
      String(getCo('JXI').price));

// ── the constituent SET changing must move it too ──
// This is the half no cache invalidation was ever going to catch: nobody
// traded anything, a company was simply delisted.
DB.companies=[IDX(),AZEI(),{ticker:'BETA',name:'Beta',status:'listed',owner_id:'o1',
  price:50,shares:1000,shares_avail:500,index_base_adjust:1,
  price_history:[{p:50,t:T(1)},{p:50,t:T(6)}]}];
syncIndexRows();
const withBeta=getCo('JXI').price;
check('two constituents average their ratios', withBeta===112.20, String(withBeta));
getCo('BETA').status='delisted';
syncIndexRows();
check('delisting a constituent reprices the index with no trade at all',
      getCo('JXI').price===124.40, withBeta+' -> '+getCo('JXI').price);

// ── a company that listed later must not invent history ──
// Treating BETA as flat at its IPO price before it existed would fabricate
// index points for days the company was not on the exchange.
DB.companies=[IDX(),AZEI(),{ticker:'LATE',name:'Late',status:'listed',owner_id:'o1',
  price:60,shares:1000,shares_avail:500,index_base_adjust:1,
  price_history:[{p:60,t:T(6)}]}];
syncIndexRows();
const s=getCo('JXI').price_history;
const early=s.find(p=>p.t===T(1));
check('a later listing does not back-fill the early points',
      early && early.p===100, JSON.stringify(early));
check('...but does count once it exists',
      s[s.length-1].p===Math.round(((31.10/25+60/60)/2)*100*100)/100,
      String(s[s.length-1].p));

// ── an empty basket leaves the last known price alone ──
// The alternative is showing 0.00 or blanking it, and a holder mid-redemption
// needs the last real number, not a placeholder.
DB.companies=[IDX()];
DB.companies[0].price=124.40;
syncIndexRows();
check('an index with no constituents keeps its last known price',
      getCo('JXI').price===124.40, String(getCo('JXI').price));

// ── ordinary companies are never touched ──
DB.companies=[IDX(),AZEI()];
const az0=JSON.stringify(getCo('AZEI'));
syncIndexRows();
check('a normal company is left exactly as it was', JSON.stringify(getCo('AZEI'))===az0);

// ── a classroom index sees only its own classroom ──
DB.users=[{id:'o1',classroom_id:'cA'},{id:'o2',classroom_id:'cB'}];
DB.companies=[
  Object.assign(IDX(),{ticker:'CBX',index_classroom_id:'cB'}),
  AZEI(),
  {ticker:'BSTU',name:'B Student Co',status:'listed',owner_id:'o2',price:40,shares:1000,
   shares_avail:500,index_base_adjust:1,price_history:[{p:20,t:T(1)},{p:40,t:T(6)}]}];
syncIndexRows();
check('a classroom index prices off its own classroom only',
      getCo('CBX').price===200, String(getCo('CBX').price));

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll index-series checks passed.'));
process.exit(fails?1:0);
