// Deadlock retry on sb.rpc().
//
// The trade RPCs lock jex_users (the caller) and THEN jex_companies (the
// ticker). rpc_pay_dividend and rpc_buyback lock them the other way round --
// jex_companies first, then jex_users. Two transactions taking the same two
// row locks in opposite orders is a deadlock cycle, and the realistic
// collision is the ordinary one: a company pays a dividend while someone is
// mid-trade on that same ticker.
//
//   student:  lock jex_users[S]      -> wait for jex_companies[ACME]
//   dividend: lock jex_companies[ACME] -> wait for jex_users[S]  (S is a holder)
//
// Postgres detects this, picks a victim and aborts it with SQLSTATE 40P01.
// Nothing is corrupted -- the losing transaction rolls back completely -- but
// without a retry a student just sees "deadlock detected" and their trade
// silently did not happen.
//
// That guarantee of a complete rollback is exactly why this ONE error is safe
// to retry when no other write is. The tests below matter as much for what
// they prove is NOT retried: a write whose response never arrived may well
// have landed, and repeating it would apply it twice.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── extract sb.rpc verbatim ──
function grabMethod(name){
  const i=src.indexOf('  async '+name+'(fn,params){');
  if(i<0)throw new Error('not found: '+name);
  let d=0,j=src.indexOf('{',i);
  for(;j<src.length;j++){ if(src[j]==='{')d++; else if(src[j]==='}'){d--;if(!d)return src.slice(i,j+1);} }
}

let calls, script, delays;
global.SUPABASE_URL='https://x';
function build(){
  calls=[]; delays=[];
  global.fetchWithTimeout=async(url,opts)=>{
    calls.push({url,opts});
    const next=script.shift();
    if(!next)throw new Error('fetchWithTimeout called more times than the script allows');
    if(next.throw)throw next.throw;
    return {ok:next.ok, text:async()=>next.body, json:async()=>JSON.parse(next.body)};
  };
  const realTimeout=global.setTimeout;
  global.setTimeout=(fn,ms)=>{delays.push(ms);return realTimeout(fn,0);};
  const obj={ headers:async()=>({}) };
  eval('obj.rpc = async function'+grabMethod('rpc').replace(/^\s*async rpc\(fn,params\)/,'(fn,params)')+';');
  return obj;
}

(async()=>{
  console.log('=== a deadlock is retried, and succeeds ===');
  script=[{ok:false, body:JSON.stringify({code:'40P01', message:'deadlock detected'})},
          {ok:true,  body:JSON.stringify({cash:100})}];
  let sb=build();
  let res=await sb.rpc('rpc_trade_buy',{p_ticker:'ACME'});
  check('the call is repeated after a deadlock', calls.length===2, calls.length+' calls');
  check('and the retry\'s result comes back', res&&res.cash===100, JSON.stringify(res));
  check('it waited before retrying', delays.length===1&&delays[0]>=120, JSON.stringify(delays));
  check('the wait is randomised, not a fixed value', delays[0]!==Math.floor(delays[0])||delays[0]>120,
    String(delays[0]));

  console.log('\n=== it gives up rather than hammering ===');
  const dl={ok:false, body:JSON.stringify({code:'40P01', message:'deadlock detected'})};
  script=[dl,dl,dl];
  sb=build();
  let threw=null;
  try{ await sb.rpc('rpc_trade_buy',{}); }catch(e){ threw=e.message; }
  check('a persistent deadlock eventually surfaces', threw!==null);
  check('after exactly 3 attempts, not more', calls.length===3, calls.length+' calls');
  check('and the real error text is what propagates', /deadlock/.test(threw||''), threw);

  console.log('\n=== the message form is matched too, not just the code ===');
  script=[{ok:false, body:'deadlock detected on relation jex_users'},
          {ok:true,  body:'{"ok":true}'}];
  sb=build();
  await sb.rpc('rpc_trade_sell',{});
  check('a bare message with no JSON code still retries', calls.length===2, calls.length+' calls');

  script=[{ok:false, body:JSON.stringify({code:'40001', message:'could not serialize access'})},
          {ok:true,  body:'{"ok":true}'}];
  sb=build();
  await sb.rpc('rpc_trade_buy',{});
  check('a serialization failure retries as well', calls.length===2, calls.length+' calls');

  console.log('\n=== everything else is NOT retried ===');
  // This is the half that protects money. A write that may have landed must
  // never be repeated.
  for(const [label, body] of [
    ['a business rejection (not enough cash)', JSON.stringify({code:'P0001', message:'Not enough cash'})],
    ['a permission error', JSON.stringify({code:'42501', message:'permission denied'})],
    ['a constraint violation', JSON.stringify({code:'23514', message:'check constraint violated'})],
    ['an authentication failure', JSON.stringify({message:'JWT expired'})],
    ['a plain 500', 'Internal Server Error'],
  ]){
    script=[{ok:false, body}];
    sb=build();
    let err=null;
    try{ await sb.rpc('rpc_trade_buy',{}); }catch(e){ err=e.message; }
    check(label+' is not retried', calls.length===1, calls.length+' calls');
    check(label+' still throws', err!==null);
  }

  console.log('\n=== a lost response is never repeated ===');
  // fetchWithTimeout throwing means we do not know whether the write landed.
  // Retrying could apply a trade twice, so it must propagate untouched.
  script=[{throw:new Error('Failed to fetch')}];
  sb=build();
  let netErr=null;
  try{ await sb.rpc('rpc_trade_buy',{}); }catch(e){ netErr=e.message; }
  check('a network-level failure is not retried', calls.length===1, calls.length+' calls');
  check('and propagates unchanged', netErr==='Failed to fetch', netErr);

  script=[{throw:new Error('Request timed out')}];
  sb=build();
  let toErr=null;
  try{ await sb.rpc('rpc_trade_buy',{}); }catch(e){ toErr=e.message; }
  check('a timeout is not retried either', calls.length===1, calls.length+' calls');
  check('and propagates unchanged', toErr==='Request timed out', toErr);

  console.log('\n=== the ordinary path is untouched ===');
  script=[{ok:true, body:JSON.stringify({price:12.5})}];
  sb=build();
  const okRes=await sb.rpc('rpc_trade_buy',{});
  check('a successful call goes out exactly once', calls.length===1);
  check('and returns its parsed body', okRes.price===12.5);
  check('with no delay at all', delays.length===0, JSON.stringify(delays));

  script=[{ok:true, body:''}];
  sb=build();
  const voidRes=await sb.rpc('rpc_admin_clear_client_errors',{});
  check('a `returns void` RPC still yields null rather than throwing', voidRes===null, String(voidRes));

  console.log('\n=== source wiring ===');
  check('only sb.rpc got the retry -- post/patch/del are untouched',
    !/async post\([\s\S]{0,400}DEADLOCK/.test(src)&&!/async patch\([\s\S]{0,400}DEADLOCK/.test(src));
  check('retryable() is still not applied to rpc', !/retryable\(async\(\)=>\{[\s\S]{0,200}rpc\//.test(src));
  check('the retry is capped', /attempt<2&&DEADLOCK\.test\(body\)/.test(src));

  console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
  process.exit(fails?1:0);
})();
