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
  global.DB={buybacks:[],users:[
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

// Server: company pays, returns owner_id/owner_cash.
const serverOk=cost=>({cash:10000-cost,owner_id:OWNER,owner_cash:10000-cost,
  price:20.3,shares:900,shares_avail:400,price_history:[{p:20.3,t:'2026-08-20T00:00:00Z'}],
  total:cost,buyback:{id:'bb1',qty:100,price:20.3,total:cost}});

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

  reset(); rpcImpl=()=>serverOk(0);
  await doBuyback('ACME',9999); // sold = 1000-400 = 600
  check('qty above shares in circulation rejected before any RPC',
    rpcCalls.length===0&&/in circulation/.test(toasts[0]||''), toasts[0]);

  console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
  process.exit(fails?1:0);
})();
