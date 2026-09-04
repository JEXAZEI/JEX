// A dilution must not make the index look like it crashed.
//
// index_base_adjust is the corporate-action divisor. A dilution changes a
// share price without changing what the company is worth, and this is the
// field that tells the index so. computeIndex() reads it:
//
//     const base = rawBase * (c.index_base_adjust ?? 1);
//     const ratio = base > 0 ? c.price / base : 1;
//
// Nothing client-side ever WRITES it -- grep the file, there are two reads and
// no assignment. It is maintained by rpc_review_dilution.
//
// reviewDilution applied the new price, shares, shares_avail and price_history
// from the RPC result and left the divisor alone. So immediately after an
// approval the client held a halved price over an unhalved base, and the index
// dropped by the dilution factor: on the screen of the admin who just approved
// it, and in every net worth figure, until a 20s refresh happened to fix it.
//
// The comment above computeIndex() records this exact failure happening once
// before -- "a 2:1 dilution took a 3-company classroom index down 16.67%,
// costing real money to anyone holding tradeable index units" -- and
// syncIndexRows() now spreads it further, since the index row's price, its
// entire rebuilt history, portfolio value and the leaderboard all derive from
// the same read.
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

let toasts=[],gets=[],rpcResult=null,getRows=null;
global.toast=m=>{toasts.push(String(m));};
global.render=()=>{};
global.fmt=n=>String(n);
global.reportClientError=()=>{};
global.rpcErrorMessage=e=>String((e&&e.message)||e);
global.getClassMeta=()=>null;
global.isHiddenTestEntity=()=>false;
global.getUser=id=>(DB.users||[]).find(u=>u.id===id)||null;
global.getCo=t=>(DB.companies||[]).find(c=>c.ticker===t)||null;
eval(grabFn('computeIndex'));
eval(grabFn('computeJXI'));
eval(grabFn('indexSeries'));
// syncIndexRows only rebuilds the series when the constituents' shape
// changes; this is where it remembers the last one.
global._indexSeriesCache=new Map();
eval(grabFn('syncIndexRows'));
eval(grabFn('reviewDilution'));

// ACME listed at 50 and now trades at 50, so its ratio is 1.00 and the index
// sits exactly at its base of 1000 (unit price 100).
//
// index_base_adjust multiplies the BASE, not the price:
//
//     base = price_history[0].p * index_base_adjust
//
// so a 2:1 dilution that halves the price to 25 needs the divisor to HALVE too
// -- 0.5, giving base 25 and ratio 25/25 = 1.00. Nothing was created or
// destroyed and the index must not move. (An earlier draft of this suite used
// 2 and quartered the index; the direction is easy to get backwards.)
const T=n=>'2026-08-2'+n+'T12:00:00.000Z';
const reset=(rpc,rows)=>{
  toasts=[];gets=[];rpcResult=rpc;getRows=rows;
  global.DB={
    session:{session_open_prices:{ACME:50}},
    users:[{id:'o1',classroom_id:'cA'}],
    dilApps:[{id:'d1',ticker:'ACME',company_name:'Acme Corp',new_shares:1000,status:'pending'}],
    companies:[
      {ticker:'JXI',name:'Index',is_index_fund:true,index_classroom_id:null,status:'listed',
       owner_id:null,price:100,shares:10,shares_avail:10,price_history:[{p:100,t:T(1)}]},
      {ticker:'ACME',name:'Acme Corp',status:'listed',owner_id:'o1',price:50,shares:1000,
       shares_avail:400,index_base_adjust:1,price_history:[{p:50,t:T(1)}]}]};
  global.sb={
    rpc:async()=>rpcResult,
    get:async(tbl,q)=>{gets.push([tbl,q]);return getRows;}
  };
};
const idxPrice=()=>{syncIndexRows();return getCo('JXI').price;};

(async()=>{

  // ── the index sits at its base before anything happens ──
  reset(null,null);
  check('the index starts at 100 a unit (level 1000)', idxPrice()===100, String(idxPrice()));

  // ── the RPC hands back the new divisor ──
  reset({approved:true,shares:2000,shares_avail:1400,price:25,
         price_history:[{p:50,t:T(1)},{p:25,t:T(2)}],index_base_adjust:0.5,
         session_open_prices:{ACME:25}},null);
  await reviewDilution('d1',true);
  // The server rescales session_open_prices by the same factor -- it drives
  // bandLimits(), the daily % badges and the circuit breaker. Left stale, the
  // band is measured against a pre-dilution open and the badges read the
  // dilution step as a crash, which is what the rescaling exists to prevent.
  check('the rescaled session opens are applied',
        DB.session && DB.session.session_open_prices
          && DB.session.session_open_prices.ACME===25,
        JSON.stringify(DB.session&&DB.session.session_open_prices));
  check('the new divisor is applied', getCo('ACME').index_base_adjust===0.5,
        String(getCo('ACME').index_base_adjust));
  check('a 2:1 dilution leaves the index exactly where it was', idxPrice()===100,
        String(idxPrice()));
  check('...and does not re-fetch unnecessarily', gets.length===0, JSON.stringify(gets));
  check('the price and share count still land', getCo('ACME').price===25 && getCo('ACME').shares===2000);
  check('the application is marked approved', DB.dilApps[0].status==='approved');

  // ── the RPC does NOT hand it back: re-read rather than carry a stale one ──
  reset({approved:true,shares:2000,shares_avail:1400,price:25,
         price_history:[{p:50,t:T(1)},{p:25,t:T(2)}]},
        [{ticker:'ACME',name:'Acme Corp',status:'listed',owner_id:'o1',price:25,shares:2000,
          shares_avail:1400,index_base_adjust:0.5,price_history:[{p:50,t:T(1)},{p:25,t:T(2)}]}]);
  await reviewDilution('d1',true);
  check('a missing divisor triggers a re-read', gets.length===1, JSON.stringify(gets));
  check('...for the right company', /ticker=eq\.ACME/.test(gets[0][1]||''), JSON.stringify(gets));
  check('...and the index still does not move', idxPrice()===100, String(idxPrice()));

  // ── the re-read failing must not throw or corrupt anything ──
  reset({approved:true,shares:2000,shares_avail:1400,price:25,
         price_history:[{p:50,t:T(1)},{p:25,t:T(2)}]},null);
  global.sb.get=async()=>{throw new Error('offline');};
  let threw=null;
  try{await reviewDilution('d1',true);}catch(e){threw=e;}
  check('a failed re-read does not throw', threw===null, String(threw));
  check('...and the approval still registers', DB.dilApps[0].status==='approved');

  // ── a rejection changes nothing at all ──
  reset({approved:false},null);
  const before=idxPrice();
  await reviewDilution('d1',false);
  check('a rejected dilution leaves the company alone',
        getCo('ACME').price===50 && getCo('ACME').shares===1000 && getCo('ACME').index_base_adjust===1);
  check('...and the index alone', idxPrice()===before, String(idxPrice()));
  check('...and says so', toasts.some(t=>/rejected/i.test(t)), JSON.stringify(toasts));

  // ── the shape of the bug, stated directly ──
  // Applying the halved price while keeping the old divisor is what produced
  // the drop. This is what the code did before, reproduced by hand.
  // indexSeries derives from price_history, not the live price field, so the
  // post-dilution price has to arrive as a history point -- which is how it
  // arrives in production, since every RPC writes price and price_history
  // together.
  reset(null,null);
  const acme=getCo('ACME');
  acme.price=25;
  acme.price_history=[{p:50,t:T(1)},{p:25,t:T(2)}];
  // index_base_adjust deliberately left at 1, as the stale client had it
  check('a halved price over an unhalved base halves the index',
        idxPrice()===50, String(idxPrice()));

  console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll dilution-index checks passed.'));
  process.exit(fails?1:0);
})();
