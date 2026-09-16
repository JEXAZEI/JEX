const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','app.js'),'utf8');
function extractFn(name){
  const start=src.indexOf('async function '+name+'(');
  let i=src.indexOf('{',start),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--; if(d===0)return src.slice(start,i+1);} }
}
eval(extractFn('doBuyback').replace('async function doBuyback','doBuyback=async function'));

let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

let current, toasts, rpcCalls, rpcImpl;
const OWNER='companyAcct', FOUNDER='studentFounder';
function reset(){
  toasts=[];rpcCalls=[];current=OWNER;
  global.DB={buybacks:[],limitOrders:[],users:[
    {id:OWNER,role:'company',cash:10000},
    {id:FOUNDER,role:'student',cash:250},
  ],companies:[{ticker:'ACME',owner_id:OWNER,price:20,shares:1000,shares_avail:400,price_history:[]}]};
}
global.getUser=id=>DB.users.find(x=>x.id===id);
global.cu=()=>getUser(current);
global.getCo=t=>DB.companies.find(c=>c.ticker===t);
global.toast=m=>toasts.push(m);
global.render=()=>{};
global.fmt=n=>'$'+n;
global.requireOpen=()=>true;
// Always-allow. This suite is about the buyback's money math, not pacing;
// the limiter itself is covered by test_rate_limit.js, including the static
// assertion that doBuyback still calls it.
global.checkRateLimit=()=>true;
global.rpcErrorMessage=e=>e.message;
global.sb={rpc:async(fn,p)=>{rpcCalls.push({fn,p});return rpcImpl(p);}};
global.MAX_TENDER_PREMIUM_PCT=50;
// Sellers are paid out of the company's cash, so doBuyback refreshes their
// rows the same way a dividend does. Not what this file is testing.
global.refreshDividendPayoutBalances=async()=>{};

// Server: company pays, returns owner_id/owner_cash. Shaped like the cascade
// rpc_buyback actually returns -- cancelled_from_float / bought_from_sellers /
// spent / tender / still_wanted -- because the three rungs are the whole point
// and a buyback that cancels unsold stock costs nothing and pays nobody.
const serverOk=(cost,extra)=>Object.assign({cash:10000-cost,owner_id:OWNER,owner_cash:10000-cost,
  price:20.3,shares:900,shares_avail:400,price_history:[{p:20.3,t:'2026-08-20T00:00:00Z'}],
  cancelled_from_float:0,bought_from_sellers:100,spent:cost,fills:[],tender:null,still_wanted:0,
  total:cost,buyback:{id:'bb1',qty:100,price:20.3,total:cost}},extra||{});

(async()=>{
  console.log('=== the company is debited, not the clicker ===');
  reset(); current=FOUNDER; rpcImpl=()=>serverOk(2030);
  await doBuyback('ACME',100);
  check('founder clicks: COMPANY balance is the one that changes',
    getUser(OWNER).cash===10000-2030, 'owner cash '+getUser(OWNER).cash);
  check("founder clicks: founder's own cash is untouched",
    getUser(FOUNDER).cash===250, 'founder cash '+getUser(FOUNDER).cash);

  reset(); current=OWNER; rpcImpl=()=>serverOk(2030);
  await doBuyback('ACME',100);
  check('owner clicks: still debits the company (same account)', getUser(OWNER).cash===7970);

  console.log('\n=== company state applied ===');
  reset(); rpcImpl=()=>serverOk(2030);
  await doBuyback('ACME',100);
  const co=getCo('ACME');
  check('price updated', co.price===20.3);
  check('shares reduced', co.shares===900);
  check('shares_avail untouched (shares are retired)', co.shares_avail===400);
  check('shares never falls below shares_avail', co.shares>=co.shares_avail);
  check('buyback appended to history', DB.buybacks.length===1&&DB.buybacks[0].id==='bb1');

  console.log('\n=== backward compatibility with the pre-migration server ===');
  reset(); rpcImpl=()=>({cash:7970,price:20.3,shares:900,price_history:[],total:2030}); // no owner_id/owner_cash
  await doBuyback('ACME',100);
  check('falls back to co.owner_id and r.cash when the RPC omits the new fields',
    getUser(OWNER).cash===7970, 'owner cash '+getUser(OWNER).cash);

  console.log('\n=== guards ===');
  reset(); rpcImpl=()=>{throw new Error('The company does not have enough cash (need $2030)');};
  await doBuyback('ACME',100);
  check('server rejection surfaces its message', /does not have enough cash/.test(toasts[0]||''), toasts[0]);
  check('no local mutation on rejection', getUser(OWNER).cash===10000&&getCo('ACME').shares===1000);

  reset(); rpcImpl=()=>serverOk(0);
  await doBuyback('ACME',0);
  check('zero qty rejected before any RPC', rpcCalls.length===0);
  await doBuyback('ACME',-5);
  check('negative qty rejected before any RPC', rpcCalls.length===0);
  await doBuyback('ACME','abc');
  check('non-numeric qty rejected before any RPC', rpcCalls.length===0);

  // The cap is the ISSUED count, not what is circulating. The cascade's first
  // rung cancels the company's own unsold float, so a company holding most of
  // its float can legitimately retire more than is in circulation -- the old
  // cap of shares-shares_avail made the cheapest rung unreachable.
  reset(); rpcImpl=()=>serverOk(0);
  await doBuyback('ACME',9999); // issued = 1000
  check('qty above the issued count rejected before any RPC',
    rpcCalls.length===0&&/have been issued/.test(toasts[0]||''), toasts[0]);
  reset(); rpcImpl=()=>serverOk(0);
  await doBuyback('ACME',700); // above circulating 600, below issued 1000
  check('qty above circulating but within issued is allowed through',
    rpcCalls.length===1, JSON.stringify(toasts));

  console.log('\n=== the premium ===');
  reset(); rpcImpl=()=>serverOk(0);
  await doBuyback('ACME',100,10);
  check('premium is forwarded to the server', rpcCalls[0].p.p_premium_pct===10);
  reset(); rpcImpl=()=>serverOk(0);
  await doBuyback('ACME',100);
  check('omitted premium becomes 0, not NaN', rpcCalls[0].p.p_premium_pct===0);
  reset(); rpcImpl=()=>serverOk(0);
  await doBuyback('ACME',100,'');
  check('blank premium becomes 0', rpcCalls[0].p.p_premium_pct===0);
  reset(); rpcImpl=()=>serverOk(0);
  await doBuyback('ACME',100,80);
  check('premium above the cap is refused before any RPC',
    rpcCalls.length===0&&/between 0 and 50/.test(toasts[0]||''), toasts[0]);
  reset(); rpcImpl=()=>serverOk(0);
  await doBuyback('ACME',100,-5);
  check('negative premium refused before any RPC', rpcCalls.length===0);

  console.log('\n=== the message says which rung actually happened ===');
  reset(); rpcImpl=()=>serverOk(0,{cancelled_from_float:100,bought_from_sellers:0,spent:0,buyback:null});
  await doBuyback('ACME',100);
  check('cancelling unsold stock does not claim anyone was paid',
    /cancelled 100 unsold/.test(toasts[0]||'')&&/no cost/.test(toasts[0]||''), toasts[0]);
  check('...and does not say "bought"', !/bought/.test(toasts[0]||''), toasts[0]);

  reset(); rpcImpl=()=>serverOk(2030,{cancelled_from_float:0,bought_from_sellers:100,spent:2030});
  await doBuyback('ACME',100);
  check('buying from sellers reports what was spent', /bought 100 from sellers/.test(toasts[0]||''), toasts[0]);

  reset(); rpcImpl=()=>serverOk(0,{cancelled_from_float:0,bought_from_sellers:0,spent:0,still_wanted:50,
    tender:{id:'t1',ticker:'ACME',qty:50,limit_price:22,order_type:'buyback',status:'open',side:'buy'}});
  await doBuyback('ACME',50,10);
  check('a tender is reported as an open offer', /offering 50 at/.test(toasts[0]||''), toasts[0]);
  check('...and lands in the local order book', (DB.limitOrders||[]).some(o=>o.id==='t1'));

  reset(); rpcImpl=()=>serverOk(0,{cancelled_from_float:0,bought_from_sellers:0,spent:0,still_wanted:50,tender:null});
  await doBuyback('ACME',50);
  check('nothing available and no premium says so plainly',
    /nobody is selling/.test(toasts[0]||''), toasts[0]);

  console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
  process.exit(fails?1:0);
})();
