// sessionAutoTick: the 15-second heartbeat.
//
// This function had NO test coverage of any kind -- it was one of only three
// server-touching functions in app.js that nothing in either harness reached,
// found by walking the call graph rather than by reading. That matters more
// than most gaps, because it is what makes the market open and close on
// schedule, and what refreshes every other student's screen when the
// instructor does something. If it stops, nothing on screen says so: prices
// simply stop moving, and the room assumes the wifi is bad.
//
// Three defects, in increasing order of how much they cost during a class:
//
//   1. Orphaned countdown timers. Three call sites assigned sessionTimer
//      straight over a live interval. In sessionAutoTick two of them ran two
//      lines apart, so a scheduled open reliably leaked one -- and orphans
//      survive clearInterval(sessionTimer), which only ever holds the newest.
//
//   2. A missing session row was treated as "closed". An empty read announced
//      "Trading session has closed" to everyone and killed the countdown, for
//      a session that was still open.
//
//   3. The catch covered only the RPC call, not the r.changed that followed
//      it. A null result threw, outside the try, inside a function nothing
//      awaits -- so the entire second half silently never ran: no fresh
//      companies, no fresh halts, no detection of a manual open or close.
//      This exact shape has bitten this codebase before.
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
let intervals=0, cleared=[], nextId=1;
const live=new Set();
global.setInterval=(fn,ms)=>{const id=nextId++;live.add(id);intervals++;return id;};
global.clearInterval=id=>{cleared.push(id);live.delete(id);};
const toasts=[];
global.toast=m=>toasts.push(m);
global.render=()=>{};
global.checkDevModeLockout=()=>false;
global.isNewTradingDay=()=>false;
global.recordSessionOpenPrices=async()=>{};
global.userIsFillingForm=()=>'';
global.get=()=>null;
global.UI={userId:'u-1'};
global.sessionTimer=null;

let tickResult, sessionRows, getCalls;
global.sb={
  rpc:async()=>{ if(tickResult instanceof Error) throw tickResult; return tickResult; },
  get:async(table)=>{ getCalls.push(table);
    if(table==='jex_session')return sessionRows;
    return []; },
};

eval(grabFn('startSessionTimer'));
eval(grabFn('tickTimer'));
eval(grabFn('sessionAutoTick'));

function reset(status){
  intervals=0; cleared=[]; live.clear(); toasts.length=0; getCalls=[];
  sessionTimer=null;
  global.DB={session:{id:1,status:status||'closed',label:'',ends_at:null},companies:[],halts:[]};
}

// ── 1. a null RPC result must not stop the rest of the tick ──
(async()=>{
reset('closed');
tickResult=null;
sessionRows=[{id:1,status:'closed',label:'',ends_at:null}];
// Caught explicitly. Unguarded, this throws OUT of sessionAutoTick -- and in
// production nothing awaits it (setInterval(()=>{sessionAutoTick(); ...})), so
// it lands as an unhandled rejection nobody sees while the refresh half is
// skipped. Letting it crash the test file would detect it too, but it would
// abort every check below and report the count as zero, so the failure would
// arrive as a stack trace rather than as a sentence saying what broke.
let threw=null;
try{ await sessionAutoTick(); }catch(e){ threw=e; }
check('a null rpc_session_tick result does not throw',
      !threw, threw&&threw.message);
check('a null rpc_session_tick result does not abort the tick',
      getCalls.includes('jex_companies')&&getCalls.includes('jex_halts'),
      'the refresh half never ran: '+JSON.stringify(getCalls));

// A THROWN rpc_session_tick must not stop the refresh either. The scheduler
// call and the three refresh reads are independent: rpc_session_tick can fail
// on its own (a server-side error in the scheduler, a permissions change)
// while the plain reads are perfectly healthy. The original `catch(e){return}`
// meant one such failure disabled every connected screen's refresh for as long
// as it lasted -- and if the cause was permanent, permanently. The refresh
// half has its own try/catch, so if the network really is down it fails
// harmlessly on its own.
reset('closed');
tickResult=new Error('rpc_session_tick is broken');
sessionRows=[{id:1,status:'closed',label:'',ends_at:null}];
await sessionAutoTick();
check('a THROWN rpc_session_tick does not stop the refresh either',
      getCalls.includes('jex_companies')&&getCalls.includes('jex_halts'),
      'refresh skipped: '+JSON.stringify(getCalls));

// ── 2. an empty session read is not a close ──
reset('open');
tickResult={changed:false};
sessionRows=[];                       // the row did not come back
await sessionAutoTick();
check('an empty session read does not announce a close',
      !toasts.some(t=>/closed/i.test(t)), toasts.join(' | '));
check('an empty session read does not kill the countdown',
      DB.session.status==='open');

// A real close still works.
reset('open');
tickResult={changed:false};
sessionRows=[{id:1,status:'closed',label:'',ends_at:null}];
await sessionAutoTick();
check('a real close IS announced', toasts.some(t=>/closed/i.test(t)), toasts.join(' | '));

// ── 3. no orphaned countdown timers ──
// The leak: ends_at set and the session transitioning closed -> open. The
// guarded line starts a timer, then the transition branch used to start a
// SECOND one over the top of it.
reset('closed');
tickResult={changed:false};
sessionRows=[{id:1,status:'open',label:'',ends_at:Date.now()+600000}];
await sessionAutoTick();
check('a scheduled open leaves exactly one live countdown',
      live.size===1, live.size+' live intervals after one open');

// Repeated open/close cycles must not accumulate.
for(let i=0;i<5;i++){
  tickResult={changed:false};
  sessionRows=[{id:1,status:'closed',label:'',ends_at:null}];
  await sessionAutoTick();
  tickResult={changed:false};
  sessionRows=[{id:1,status:'open',label:'',ends_at:Date.now()+600000}];
  await sessionAutoTick();
}
check('five open/close cycles leave exactly one live countdown, not six',
      live.size===1, live.size+' live intervals -- orphans accumulated');

// Same through the scheduler-driven branch (r.changed === true).
reset('closed');
tickResult={changed:true, session:{id:1,status:'open',label:'weekly',ends_at:Date.now()+600000}};
sessionRows=[{id:1,status:'open',label:'weekly',ends_at:Date.now()+600000}];
await sessionAutoTick();
check('the scheduler-driven open also leaves exactly one countdown',
      live.size===1, live.size+' live intervals');

// ── 4. startSessionTimer itself ──
reset('closed');
startSessionTimer();
const first=sessionTimer;
startSessionTimer();
check('startSessionTimer clears the previous interval before starting one',
      cleared.includes(first)&&live.size===1,
      'cleared='+JSON.stringify(cleared)+' live='+live.size);

// ── 5. no assignment site bypasses it ──
// Static: every place that starts the countdown must go through
// startSessionTimer or be guarded by !sessionTimer. A bare assignment is how
// the orphans got created in the first place.
const bare=[...src.matchAll(/^.*sessionTimer=setInterval\(tickTimer.*$/gm)]
  .map(m=>m[0])
  .filter(l=>!/!sessionTimer\)sessionTimer=setInterval/.test(l))   // guarded
  .filter(l=>!/clearInterval\(sessionTimer\);sessionTimer=null;/.test(l))  // clears first
  .filter(l=>!/^function startSessionTimer/.test(l.trim()))
  .filter(l=>!/^\s*sessionTimer=setInterval\(tickTimer,500\);$/.test(l)||!/startSessionTimer/.test(src.slice(0,src.indexOf(l))));
check('no unguarded bare sessionTimer assignment remains',
      bare.length<=1, bare.length+' found:\n    '+bare.join('\n    '));

console.log(fails?('\n'+fails+' FAILURE(S)'):'\nAll session-tick checks passed.');
process.exit(fails?1:0);
})();
