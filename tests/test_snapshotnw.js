const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','app.js'),'utf8');
function extractFn(name){
  const start=src.indexOf('async function '+name+'(');
  let i=src.indexOf('{',start),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--; if(d===0)return src.slice(start,i+1);} }
}
eval(extractFn('snapshotNW').replace('async function snapshotNW','snapshotNW=async function'));

let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

let rpcCalls=[],posts=[],current='u1';
global.DB={nwHistory:[],users:[
  {id:'u1',role:'student',cash:5000},
  {id:'u2',role:'student',cash:9999},
  {id:'c1',role:'company',cash:100},
]};
global.getUser=id=>DB.users.find(x=>x.id===id);
global.cu=()=>getUser(current);
let rpcImpl=()=>({id:'srv-row',user_id:'u1',nw:12345,cash:5000,portfolio:7345,ts:'Aug 19, 3:00:00 PM',created_at:'2026-08-19T22:00:00Z'});
global.sb={
  rpc:async(fn,params)=>{rpcCalls.push({fn,params});return rpcImpl(params);},
  post:async(t,rec)=>{posts.push({t,rec});},
};
const reset=()=>{rpcCalls=[];posts=[];DB.nwHistory=[];current='u1';};

(async()=>{
  reset();
  await snapshotNW('u1');
  check('calls rpc_snapshot_nw', rpcCalls.length===1&&rpcCalls[0].fn==='rpc_snapshot_nw');
  check('sends no user id (server derives the caller)', JSON.stringify(rpcCalls[0].params)==='{}');
  check('never raw-POSTs to jex_nw_history', posts.length===0);
  check('pushes the SERVER row, not a client-built one', DB.nwHistory.length===1&&DB.nwHistory[0].id==='srv-row');
  check('server row carries created_at for ordering', !!DB.nwHistory[0].created_at);

  reset();
  await snapshotNW('c1');
  check('non-student is skipped entirely, no RPC', rpcCalls.length===0&&DB.nwHistory.length===0);

  reset();
  await snapshotNW('nobody');
  check('unknown user is skipped, no RPC', rpcCalls.length===0&&DB.nwHistory.length===0);

  reset();
  await snapshotNW('u2'); // current user is still u1
  check('refuses to snapshot a different user than the caller', rpcCalls.length===0&&DB.nwHistory.length===0);

  reset(); current='u2';
  await snapshotNW('u2');
  check('does snapshot when the id IS the caller', rpcCalls.length===1);

  reset(); rpcImpl=()=>{throw new Error('boom');};
  await snapshotNW('u1');
  check('RPC failure is swallowed, no row appended, no throw', DB.nwHistory.length===0);

  reset(); rpcImpl=()=>null; // server returns null for a non-student
  await snapshotNW('u1');
  check('null RPC result appends nothing', DB.nwHistory.length===0);

  console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
  process.exit(fails?1:0);
})();
