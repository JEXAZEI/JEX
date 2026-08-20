const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','app.js'),'utf8');
function extractFn(name){
  const start=src.indexOf('async function '+name+'(');
  if(start<0)throw new Error('not found: '+name);
  let i=src.indexOf('{',start),depth=0;
  for(;i<src.length;i++){ if(src[i]==='{')depth++; else if(src[i]==='}'){depth--; if(depth===0)return src.slice(start,i+1);} }
  throw new Error('unbalanced');
}
eval(extractFn('submitDilution').replace('async function submitDilution','submitDilution=async function'));

// --- mocks ---
let toasts=[],rpcCalls=[],rendered=0;
global.toast=m=>toasts.push(m);
global.render=()=>rendered++;
global.UI={companyTab:null,userId:'u1'};
global.DB={dilApps:[],companies:[{ticker:'ACME',name:'Acme Corp',shares:1000,owner_id:'u1',status:'listed'}]};
global.getCo=t=>DB.companies.find(c=>c.ticker===t);
global.canManageCompany=()=>true;
global.rpcErrorMessage=e=>e.message;
global.clearDraft=()=>{};   // submit paths drop the saved draft
let rpcImpl;
global.sb={rpc:async(fn,params)=>{rpcCalls.push({fn,params});return rpcImpl(params);}};

function reset(){toasts=[];rpcCalls=[];rendered=0;DB.dilApps=[];UI.companyTab=null;}
let fails=0;
function check(label,cond){ if(cond)console.log('PASS: '+label); else {console.log('FAIL: '+label);fails++;} }

(async()=>{
  // 1. happy path — record comes from server, not built client-side
  reset();
  rpcImpl=p=>({id:'srv-1',ticker:p.p_ticker,company_name:'Acme Corp',current_shares:1000,new_shares:200,pct_increase:20,reason:p.p_reason.trim(),status:'pending',user_id:'u1',ts:'Aug 19, 3:00:00 PM'});
  await submitDilution('ACME','200','Need capital for expansion');
  check('calls rpc_request_dilution', rpcCalls.length===1 && rpcCalls[0].fn==='rpc_request_dilution');
  check('passes ticker/shares/reason only', JSON.stringify(rpcCalls[0].params)===JSON.stringify({p_ticker:'ACME',p_new_shares:200,p_reason:'Need capital for expansion'}));
  check('parses shares to int', typeof rpcCalls[0].params.p_new_shares==='number');
  check('pushes SERVER record (id srv-1)', DB.dilApps.length===1 && DB.dilApps[0].id==='srv-1');
  check('switches to dilution tab + renders', UI.companyTab==='dilution' && rendered===1);

  // 2. server rejects -> toast, no local push
  reset();
  rpcImpl=()=>{throw new Error('Only this company\'s owner or founders can request dilution for it');};
  await submitDilution('ACME','200','Need capital for expansion');
  check('server rejection surfaces message', toasts.length===1 && /owner or founders/.test(toasts[0]));
  check('no local row on rejection', DB.dilApps.length===0);
  check('no render on rejection', rendered===0);

  // 3. client-side guards still short-circuit before any RPC
  reset(); rpcImpl=()=>({id:'x'});
  await submitDilution('ACME','0','Need capital for expansion');
  check('rejects qty 0 without RPC', rpcCalls.length===0 && /valid share count/.test(toasts[0]));
  reset();
  await submitDilution('ACME','-5','Need capital for expansion');
  check('rejects negative qty without RPC', rpcCalls.length===0);
  reset();
  await submitDilution('ACME','200','short');
  check('rejects short reason without RPC', rpcCalls.length===0 && /Reason too short/.test(toasts[0]));
  reset();
  DB.dilApps.push({ticker:'ACME',status:'pending'});
  await submitDilution('ACME','200','Need capital for expansion');
  check('rejects duplicate pending without RPC', rpcCalls.length===0 && /Already pending/.test(toasts[0]));

  console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
})();
