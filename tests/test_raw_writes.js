const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','app.js'),'utf8');
function extractFn(name){
  const start=src.indexOf('async function '+name+'(');
  if(start<0)throw new Error('not found: '+name);
  // Walk the PARAMETER list to its closing paren first -- a default value
  // like `extras={}` puts a brace before the body, and matching on the
  // first '{' after the name grabs that instead and closes immediately.
  let i=src.indexOf('(',start),p=0;
  for(;i<src.length;i++){ if(src[i]==='(')p++; else if(src[i]===')'){p--; if(p===0){i++;break;} } }
  i=src.indexOf('{',i);
  let d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--; if(d===0)return src.slice(start,i+1);} }
  throw new Error('unbalanced: '+name);
}
for(const fn of ['logActivity','flagAccount','submitIPO','activateAfterHoursOrders'])
  eval(extractFn(fn).replace('async function '+fn,fn+'=async function'));

let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

let rpcCalls,posts,patches,toasts,rpcImpl;
function reset(){
  rpcCalls=[];posts=[];patches=[];toasts=[];
  global.DB={activity:[],flags:[],ipoApps:[],companies:[],limitOrders:[],users:[{id:'u1',name:'Ana',role:'student'}],session:{}};
}
global.toast=m=>toasts.push(m);
global.render=()=>{};
global.fmt=n=>'$'+n;
global.getUser=id=>DB.users.find(u=>u.id===id);
global.cu=()=>DB.users[0];
global.getCo=t=>DB.companies.find(c=>c.ticker===t);
global.UI={};
global.uid=()=>'client-generated-id';
global.ts=()=>'client ts';
global.rpcErrorMessage=e=>e.message;
global.clearDraft=()=>{};   // submit paths drop the saved draft
global.pushNotification=async()=>{};
global.pushToSheets=()=>{};
global.sb={
  rpc:async(fn,p)=>{rpcCalls.push({fn,p});return rpcImpl(fn,p);},
  post:async(t,r)=>{posts.push({t,r});},
  patch:async(t,q,b)=>{patches.push({t,q,b});},
};

(async()=>{
  console.log('=== logActivity: chain built server-side ===');
  reset();
  rpcImpl=(fn,p)=>({id:'srv-a1',type:p.p_type,description:p.p_description,prev_hash:'abc12345',entry_hash:'def67890',ts:'Aug 20, 1:00:00 PM'});
  await logActivity('ipo','Ana listed ACME',{ticker:'ACME',userId:'u9',userName:'Bo',amount:12.5});
  check('calls rpc_log_activity', rpcCalls.length===1&&rpcCalls[0].fn==='rpc_log_activity');
  check('no raw POST', posts.length===0);
  check('sends no prev_hash or entry_hash', !('p_prev_hash' in rpcCalls[0].p)&&!('p_entry_hash' in rpcCalls[0].p));
  check('still passes the subject (not the caller) through', rpcCalls[0].p.p_user_id==='u9'&&rpcCalls[0].p.p_user_name==='Bo');
  check('server row is what lands in DB.activity', DB.activity[0].id==='srv-a1'&&DB.activity[0].entry_hash==='def67890');
  reset(); rpcImpl=()=>{throw new Error('boom');};
  await logActivity('x','y',{});
  check('a failing log never throws into its caller', DB.activity.length===0);
  reset(); rpcImpl=()=>null;
  await logActivity('x','y',{});
  check('null result appends nothing', DB.activity.length===0);

  console.log('\n=== flagAccount ===');
  reset(); rpcImpl=()=>({id:'srv-f1',target_id:'u2',flagged_by:'u1',status:'open'});
  await flagAccount('u2','Posted Name','user','they were doing something odd');
  check('calls rpc_flag_account', rpcCalls[0].fn==='rpc_flag_account');
  check('does NOT send the client-supplied target name', !('p_target_name' in rpcCalls[0].p));
  check('does NOT send flagged_by', !('p_flagged_by' in rpcCalls[0].p));
  check('server row stored', DB.flags[0].id==='srv-f1');
  reset(); rpcImpl=()=>({id:'x'});
  await flagAccount('u2','n','user','tiny');
  check('short reason rejected before any RPC', rpcCalls.length===0&&/at least 5/.test(toasts[0]||''));
  reset(); rpcImpl=()=>{throw new Error('Account not found');};
  await flagAccount('ghost','n','user','a good long reason here');
  check('server rejection surfaces, nothing stored', DB.flags.length===0&&/not found/.test(toasts[0]||''));

  console.log('\n=== submitIPO ===');
  reset(); rpcImpl=(fn,p)=>({id:'srv-i1',user_id:'u1',ticker:p.p_ticker,status:'pending'});
  await submitIPO('Acme Corp','acme','10','1000','we make things');
  check('calls rpc_submit_ipo', rpcCalls[0].fn==='rpc_submit_ipo');
  check('does NOT send user_id', !('p_user_id' in rpcCalls[0].p));
  check('does NOT send status', !('p_status' in rpcCalls[0].p));
  check('server row stored, not a client-built one', DB.ipoApps[0].id==='srv-i1');
  reset(); rpcImpl=()=>({id:'x'});
  await submitIPO('Acme','ACME','-5','1000','d');
  check('negative price rejected before any RPC', rpcCalls.length===0);
  await submitIPO('Acme','ACME','10','0','d');
  check('zero shares rejected before any RPC', rpcCalls.length===0);
  await submitIPO('','ACME','10','10','d');
  check('empty name rejected before any RPC', rpcCalls.length===0);
  reset(); rpcImpl=()=>{throw new Error('Ticker already exists or is pending');};
  await submitIPO('Acme','ACME','10','1000','d');
  check('server duplicate-ticker rejection surfaces', DB.ipoApps.length===0&&/already exists/.test(toasts[0]||''));

  console.log('\n=== activateAfterHoursOrders ===');
  reset();
  DB.limitOrders=[{id:'o1',status:'after_hours'},{id:'o2',status:'after_hours'}];
  rpcImpl=()=>({activated:[{id:'o1',user_id:'u1',ticker:'ACME',qty:5,limit_price:10,side:'buy'}]});
  await activateAfterHoursOrders();
  check('calls rpc_activate_after_hours_orders', rpcCalls[0].fn==='rpc_activate_after_hours_orders');
  check('no raw patch', patches.length===0);
  check('only the SERVER-claimed order flips locally', DB.limitOrders[0].status==='open'&&DB.limitOrders[1].status==='after_hours');
  reset();
  DB.limitOrders=[{id:'o1',status:'after_hours'}];
  rpcImpl=()=>({activated:[]});          // another client won the race
  await activateAfterHoursOrders();
  check('losing the race changes nothing locally and toasts nothing', DB.limitOrders[0].status==='after_hours'&&toasts.length===0);
  reset();
  DB.limitOrders=[{id:'o1',status:'open'}];
  rpcImpl=()=>({activated:[{id:'o1'}]});
  await activateAfterHoursOrders();
  check('no after-hours orders -> no RPC at all', rpcCalls.length===0);
  reset();
  DB.limitOrders=[{id:'o1',status:'after_hours'}];
  rpcImpl=()=>{throw new Error('Not authenticated');};
  await activateAfterHoursOrders();
  check('RPC failure leaves local state untouched', DB.limitOrders[0].status==='after_hours');

  console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
  process.exit(fails?1:0);
})();
