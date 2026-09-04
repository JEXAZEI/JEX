// An index with no listed companies must not be tradeable.
//
// computeIndex() returns a base-1000 placeholder when its basket is empty --
// an average over zero constituents does not exist, so there is nothing else
// it could return -- and snapshotJXI() stops refreshing the stored price
// entirely. The number on the page is therefore a seed or a stale quote, not a
// valuation, and buying against it converts real cash into units backed by
// nothing. The first company to list then reprices those units to wherever ITS
// ratio sits, handing the holder a gain or loss that came from which company
// IPO'd next rather than from anything moving.
//
// Every constituents.length guard that existed before this was cosmetic -- the
// market card, the chart, the snapshot -- and none of them was on a trade
// path. This suite pins the rule that replaced them:
//
//   opening trades (buy, short)   refused while the basket is empty
//   closing trades (sell, cover)  always allowed, so nobody is trapped in
//                                 units they bought while it still had one
//
// A classroom index created for a classroom whose students have not IPO'd yet
// is empty by construction, so this is the ordinary case on day one, not an
// exotic one.
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

// ── environment ──
let toasts=[],calls=[];
global.toast=m=>{toasts.push(String(m));};
global.render=()=>{};
global.openPanel=()=>{};
global.esc=s=>String(s);
global.fmt=n=>String(n);
global.requireOpen=()=>true;
global.canAccessTicker=()=>true;
global.checkRateLimit=()=>{calls.push('ratelimit');return true;};
global.applyTradeResult=()=>{};
global.applyFundTradeResult=()=>{};
global.applyFundShortResult=()=>{};
// Shares available to borrow. null means "no limit", which is what an index
// fund returns -- it mints and burns units rather than lending a fixed float.
global.borrowable=()=>null;
global.borrowMsg=co=>'Only 0 shares of '+co.ticker+' can be borrowed right now';
global.snapshotNW=()=>{};
global.pushBalances=()=>{};
global.checkPriceAlerts=()=>{};
global.checkCircuitBreakers=()=>{};
global.pushTradeToSheets=()=>{};
global.getClassMeta=()=>null;
global.isHiddenTestEntity=()=>false;
global.holdings=u=>u.holdings||{};
global.shorts=u=>u.shorts||{};
global.UI={};
global.sb={rpc:async(name)=>{calls.push(name);return{price:1000,old_price:1000,trade:{price:1000},constituents:[]};}};

const STUDENT={id:'s1',role:'student',cash:50000,holdings:{JXI:5},shorts:{JXI:{qty:2,avgPrice:1000}}};
global.cu=()=>STUDENT;
global.getUser=id=>id===STUDENT.id?STUDENT:(DB.users.find(u=>u.id===id)||null);
global.getCo=t=>DB.companies.find(c=>c.ticker===t)||null;
global.getFund=id=>DB.funds.find(f=>f.id===id)||null;

global.DB={users:[STUDENT,{id:'o1',role:'company',classroom_id:'cA'}],funds:[
  {id:'f1',manager_id:'s1',status:'active',cash:50000,holdings:{JXI:5},shorts:{JXI:{qty:2,avgPrice:1000}}}],companies:[]};

const IDX={ticker:'JXI',name:'JEX Index',is_index_fund:true,index_classroom_id:null,
  status:'listed',price:1000,shares:10,shares_avail:10,owner_id:null};
const REALCO={ticker:'ACME',name:'Acme',status:'listed',price:50,shares:1000,shares_avail:900,
  owner_id:'o1',price_history:[{p:50}],index_base_adjust:1};

eval(grabFn('computeIndex'));
eval(grabFn('computeJXI'));
eval(grabFn('indexHasNoBasket'));
eval(grabFn('emptyIndexMsg'));
eval(grabFn('placeBuy'));
eval(grabFn('placeSell'));
eval(grabFn('placeShort'));
eval(grabFn('coverShort'));
eval(grabFn('fundBuy'));
eval(grabFn('fundSell'));
eval(grabFn('fundShort'));

const reset=companies=>{DB.companies=companies;toasts=[];calls=[];};
const traded=()=>calls.some(c=>c.startsWith('rpc_'));
const refusedForEmptyBasket=()=>toasts.some(t=>/no listed companies right now/i.test(t));

(async()=>{

  // ── the empty basket ──
  reset([IDX]);
  check('an empty index reports an empty basket', indexHasNoBasket(IDX)===true);
  check('...and computeIndex still hands back the 1000 placeholder',
        computeJXI().value===1000&&computeJXI().constituents.length===0,
        JSON.stringify(computeJXI()));

  reset([IDX]);
  await placeBuy('JXI',3);
  check('BUY is refused while the basket is empty', !traded()&&refusedForEmptyBasket(),
        JSON.stringify({calls,toasts}));

  // The guard sits before checkRateLimit deliberately, matching the ordering
  // fix applied to every other money path: a refused order must not burn a
  // slot and leave the student waiting out a cooldown for something that never
  // happened.
  check('...and the refusal does not burn a rate-limit slot',
        !calls.includes('ratelimit'), JSON.stringify(calls));

  reset([IDX]);
  await placeShort('JXI',3);
  check('SHORT is refused while the basket is empty', !traded()&&refusedForEmptyBasket(),
        JSON.stringify({calls,toasts}));

  // The whole point of the asymmetry: someone already holding units when the
  // last constituent delisted has to be able to get out.
  reset([IDX]);
  await placeSell('JXI',2);
  check('SELL still works while the basket is empty', calls.includes('rpc_trade_sell'),
        JSON.stringify({calls,toasts}));

  reset([IDX]);
  await coverShort('JXI',1);
  check('COVER still works while the basket is empty', calls.includes('rpc_trade_cover_short'),
        JSON.stringify({calls,toasts}));

  // A fund manager can reach the same instrument by a different door.
  reset([IDX]);
  await fundBuy('f1','JXI',3);
  check('a FUND buy is refused too', !traded()&&refusedForEmptyBasket(),
        JSON.stringify({calls,toasts}));

  reset([IDX]);
  await fundShort('f1','JXI',3);
  check('a FUND short is refused too', !traded()&&refusedForEmptyBasket(),
        JSON.stringify({calls,toasts}));

  reset([IDX]);
  await fundSell('f1','JXI',1);
  check('a FUND sell still works', calls.some(c=>c==='rpc_fund_sell'),
        JSON.stringify({calls,toasts}));

  // ── the basket refills ──
  reset([IDX,REALCO]);
  check('one listed company is enough to make the basket non-empty',
        indexHasNoBasket(IDX)===false);
  await placeBuy('JXI',3);
  check('BUY works again once a company is listed', calls.includes('rpc_trade_buy'),
        JSON.stringify({calls,toasts}));

  reset([IDX,REALCO]);
  await placeShort('JXI',3);
  check('SHORT works again once a company is listed', calls.includes('rpc_trade_short'),
        JSON.stringify({calls,toasts}));

  // ── the guard must not touch ordinary stocks ──
  // indexHasNoBasket() keys off is_index_fund, so a normal company can never
  // trip it -- but a broader check (e.g. one keyed off constituents alone)
  // would have blocked every stock on a fresh exchange.
  reset([REALCO]);
  check('an ordinary company never reports an empty basket',
        indexHasNoBasket(REALCO)===false);
  await placeBuy('ACME',3);
  check('an ordinary company is unaffected by the guard', calls.includes('rpc_trade_buy'),
        JSON.stringify({calls,toasts}));

  // A delisted-only basket is empty: computeIndex filters on status==='listed',
  // so an index whose companies all delisted is in exactly the same position as
  // one that never had any.
  reset([IDX,Object.assign({},REALCO,{status:'delisted'})]);
  check('a basket of only DELISTED companies counts as empty',
        indexHasNoBasket(IDX)===true);
  await placeBuy('JXI',1);
  check('...and buying is refused there too', !traded()&&refusedForEmptyBasket(),
        JSON.stringify({calls,toasts}));

  // A classroom index only sees its own classroom's companies. ACME's owner is
  // in classroom cA, so an index scoped to cB is empty even though the exchange
  // as a whole is not -- this is the day-one case for a new classroom index.
  const CBIDX=Object.assign({},IDX,{ticker:'CBX',index_classroom_id:'cB'});
  reset([CBIDX,REALCO]);
  check('a classroom index with no companies IN THAT CLASSROOM counts as empty',
        indexHasNoBasket(CBIDX)===true);
  check('...while the exchange-wide index is fine', indexHasNoBasket(IDX)===false);
  await placeBuy('CBX',1);
  check('...and buying the empty classroom index is refused',
        !traded()&&refusedForEmptyBasket(), JSON.stringify({calls,toasts}));

  console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll empty-index checks passed.'));
  process.exit(fails?1:0);
})();
