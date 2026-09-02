// Day one: thirty students register, an admin approves them one by one.
//
// approveReg used to treat EVERY failure as "this registration was already
// approved" -- and delete the row from the pending list on the way out:
//
//     catch(e){ DB.pending = DB.pending.filter(...); render();
//               return toast('This registration was already approved'); }
//
// The intent was real. u.id reuses the pending record's id, so a double-click
// or two admins working the queue at once collide on the primary key, and that
// genuinely does mean somebody else got there first.
//
// But the catch could not tell that apart from the wifi dropping. When it
// could not, the student was NOT approved, the admin was told they were, and
// the name vanished from the queue -- recoverable only by reloading, which
// nobody does after being told the thing succeeded. Thirty registrations on
// classroom wifi is precisely where one request fails, and the cost is a
// student who cannot log in on the first day with no record of why.
//
// The rule now: a primary-key collision is success-by-someone-else. Everything
// else is a failure, says so, and leaves the student in the queue.
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
function grabConst(name){
  const m=new RegExp('(?:^|;)const '+name+'=','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  const start=m.index+(m[0].startsWith(';')?1:0);
  let depth=0;
  for(let i=start;i<src.length;i++){
    const c=src[i];
    if('([{'.includes(c))depth++;
    else if(')]}'.includes(c))depth--;
    else if(c===';'&&depth===0)return src.slice(start,i+1);
  }
  throw new Error('unterminated: '+name);
}

let toasts=[],acts=[],thrown=null,called=0;
global.toast=m=>{toasts.push(String(m));};
global.render=()=>{};
global.fmt=n=>'$'+Number(n).toFixed(2);
global.document={getElementById:()=>null};
global.logActivity=async(...a)=>{acts.push(a);};
global.reportClientError=()=>{};
global.INTERNAL_DB_ERROR=eval('('+grabConst('INTERNAL_DB_ERROR')
  .replace(/^const INTERNAL_DB_ERROR=/,'').replace(/;$/,'')+')');
eval(grabFn('rpcErrorMessage'));
eval(grabFn('approveReg'));

const PENDING={id:'p1',name:'Ada Lovelace',role:'student'};
const reset=err=>{
  toasts=[];acts=[];thrown=err;called=0;
  global.DB={pending:[{...PENDING}],users:[],session:{starting_cash:10000}};
  global.sb={rpc:async()=>{called++;if(thrown)throw thrown;return{id:'p1',name:'Ada Lovelace',role:'student',cash:10000};}};
};
const err=msg=>new Error(JSON.stringify({message:msg}));
const stillQueued=()=>DB.pending.some(p=>p.id==='p1');

(async()=>{

  // ── the happy path ──
  reset(null);
  await approveReg('p1',10000);
  check('an approval adds the user', DB.users.length===1 && DB.users[0].id==='p1');
  check('...and removes them from the queue', !stillQueued());
  check('...and is logged', acts.length===1, JSON.stringify(acts));
  check('...and says so', toasts.some(t=>/approved/i.test(t)), JSON.stringify(toasts));

  // ── a genuine double-approval ──
  // The RPC reuses the pending id as the new user id, so a second approval
  // collides on the primary key. That one really does mean "already done".
  for(const msg of ['duplicate key value violates unique constraint "jex_users_pkey"',
                    'Key (id)=(p1) already exists.']){
    reset(err(msg));
    await approveReg('p1',10000);
    check('a PK collision is reported as already approved',
          toasts.some(t=>/already approved/i.test(t)), JSON.stringify(toasts));
    check('...and drops them from the queue, since they do have an account',
          !stillQueued());
  }

  // ── everything else is a failure and must say so ──
  for(const [label,msg] of [
      ['the connection dropped',      'Failed to fetch'],
      ['a permissions denial',        'new row violates row-level security policy for table "jex_users"'],
      ['a server fault',              'record "v_x" is not assigned yet'],
      ['a timeout',                   'canceling statement due to statement timeout'],
      ['an unreadable error',         '']]){
    reset(err(msg));
    await approveReg('p1',10000);
    check('failure ('+label+') is NOT called success',
          !toasts.some(t=>/already approved/i.test(t)), JSON.stringify(toasts));
    check('...the student stays in the queue', stillQueued(), JSON.stringify(DB.pending));
    check('...no account is created', DB.users.length===0);
    check('...nothing is written to the activity log', acts.length===0);
    check('...and the admin is told to try again',
          toasts.some(t=>/try again/i.test(t)), JSON.stringify(toasts));
  }

  // A server fault should still be sanitised for display -- the admin does not
  // need a plpgsql variable name -- but must not be mistaken for success.
  reset(err('record "v_x" is not assigned yet'));
  await approveReg('p1',10000);
  check('an internal fault is not shown raw',
        !toasts.some(t=>/v_x/.test(t)), JSON.stringify(toasts));
  check('...and names the student so the admin knows who to retry',
        toasts.some(t=>/Ada Lovelace/.test(t)), JSON.stringify(toasts));

  // ── a bare (non-JSON) error must behave the same ──
  reset(new Error('duplicate key value violates unique constraint'));
  await approveReg('p1',10000);
  check('a bare duplicate error is still recognised',
        toasts.some(t=>/already approved/i.test(t)) && !stillQueued(),
        JSON.stringify(toasts));
  reset(new Error('Network request failed'));
  await approveReg('p1',10000);
  check('a bare network error still leaves them queued', stillQueued(),
        JSON.stringify(toasts));

  // ── the RPC is called exactly once per attempt ──
  reset(null);
  await approveReg('p1',10000);
  check('one attempt sends one RPC', called===1, String(called));

  // ── an unknown id does nothing at all ──
  reset(null);
  await approveReg('nope',10000);
  check('an unknown registration is a no-op', called===0 && DB.users.length===0);

  console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll approve-registration checks passed.'));
  process.exit(fails?1:0);
})();
