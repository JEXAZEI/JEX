// sql/server_events_batch2.sql moves the activity entry and notifications for
// fifteen officer and market-control functions into the functions themselves,
// and the short-squeeze alert to the server. The page stops writing its own
// copy for whichever ones the server lists.
//
// Verified on a copy of production's code (every table identical before and
// after; one session-open entry for 8 simultaneous opens; one squeeze alert
// for 8 simultaneous checks). This guards what the files can show: the
// migration's rails, that the server's wording is the page's, and that every
// page call site for these events defers -- or the event is written twice.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'..','sql','server_events_batch2.sql'),'utf8');
const b1=fs.readFileSync(path.join(__dirname,'..','sql','server_events_batch1.sql'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const code=sql.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');
const unq=s=>s.replace(/''/g,"'");

// ── the migration's rails ──
const FIFTEEN=['rpc_admin_save_session','rpc_expire_day_orders','rpc_admin_halt_stock','rpc_admin_resume_stock',
  'rpc_admin_delist_company','rpc_admin_relist_company','rpc_review_delisting','rpc_review_ipo',
  'rpc_review_class_application','rpc_admin_remove_share_class','approve_registration',
  'rpc_admin_restore_snapshot','rpc_post_minutes','rpc_post_announcement','rpc_admin_resolve_flag'];
const rows=[...code.matchAll(/\((\d+), '(\w+)', '([0-9a-f]{32})',/g)].map(m=>({seq:+m[1],fn:m[2],md5:m[3]}));
const fns=[...new Set(rows.map(r=>r.fn))];
check('the plan covers exactly the fifteen', fns.length===15 && FIFTEEN.every(f=>fns.includes(f)), fns.join(','));
check('one fingerprint per function',
      fns.every(f=>new Set(rows.filter(r=>r.fn===f).map(r=>r.md5)).size===1));
check('edits are numbered in order', rows.every((r,i)=>r.seq===i+1), rows.map(r=>r.seq).join(','));
// The Supabase SQL editor does not promise separate statements share a
// connection: batch 2 first held its plan in a temporary table, and in
// production the next statement could not see it. No migration may rely on
// state carried between statements.
for(const f of fs.readdirSync(path.join(__dirname,'..','sql')).filter(f=>f.endsWith('.sql'))){
  const body=fs.readFileSync(path.join(__dirname,'..','sql',f),'utf8').split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');
  check(f+' keeps no state between statements (no temporary tables)', !/create\s+temp(orary)?\s+table/i.test(body));
}
check('the plan is held inside the migration block', /select jsonb_agg\(to_jsonb\(p\) order by p\.seq\) into v_plan/.test(code) && !/_b2_plan/.test(code));
check('refuses to run before batch 1', /run server_events_batch1\.sql first/.test(code));
check('a mismatch aborts before anything is created',
      code.indexOf('is not the version this was written against')<code.indexOf('alter table public.jex_companies'));
check('every edit\'s anchor must occur exactly once', /anchor exactly once in %/.test(code));
check('the check loop cannot reuse the previous function\'s body', /v_src := null; v_fp := null;/.test(code));
check('a function that already records its events is skipped (safe to run twice)',
      (code.match(/position\('jex_ev_' in v_src\) > 0/g)||[]).length===2);
check('{nl} anchors follow the function\'s own line endings', /v_a := replace\(e\.anchor, '\{nl\}', v_nl\)/.test(code));

const created=[...code.matchAll(/create or replace function public\.(jex_\w+)\(/g)].map(m=>m[1]);
const revoke=(code.match(/revoke execute on function([\s\S]*?)from public, anon, authenticated/)||[])[1]||'';
check('helpers created', created.length===17, created.join(','));
for(const h of created)check('...'+h+' cannot be called from the web', revoke.includes('public.'+h+'('));
check('every event function warns instead of undoing the action',
      (code.match(/exception when others then raise warning '/g)||[]).length===created.filter(h=>h.startsWith('jex_ev_')).length);

// ── session: once, on a real change ──
check('a session event needs the status to really change', /if p_new is distinct from p_old and p_new in \('open', 'paused', 'closed'\)/.test(code));
check('...read under a lock, so two simultaneous opens log one', /select \* into v_was from jex_session where id = 1 for update;/.test(code));
check('practice mode is announced only when it flips',
      /coalesce\(p_new_practice, false\) is distinct from coalesce\(p_old_practice, false\)/.test(code));

// ── the squeeze alert ──
check('the squeeze alert has its own type', /jex_notify_students\('squeeze',/.test(code));
const important=(b1.match(/v_important text\[\] := array\[([\s\S]*?)\];/)||[])[1]||'';
check('...which is not emailed', important.length>0 && !important.includes("'squeeze'"));
check('...is claimed once per company per Arizona day',
      /squeeze_alert_date is distinct from v_today/.test(code) && /v_today date := \(now\(\) at time zone 'America\/Phoenix'\)::date/.test(code));
check('...and only signed-in users can ask',
      /revoke execute on function public\.rpc_check_short_squeeze\(text\) from public, anon/.test(code)
      && /grant execute on function public\.rpc_check_short_squeeze\(text\) to authenticated/.test(code));
check('...thresholds match the page: 15% short, up more than 10%',
      /v_pct < 0\.15 or v_chg <= 0\.10/.test(code) && /if\(shortPct<0\.15\)return;/.test(src) && /if\(!\(priceChgPct>0\.1\)\)return;/.test(src));

// ── the wording is the page's ──
for(const frag of ['🟢 Trading session is now open!','🔴 Trading session has closed.',
  '📋 Session opened — post any meeting minutes or official notices now.',
  '💰 Session opened — monitor company cash levels and dividend activity.',
  '🔍 Session opened — watch for unusual trading patterns or price anomalies.',
  '📊 Session closed — review the cash flow report and check for budget warnings.',
  '🔍 Session closed — review the activity log for any suspicious patterns.',
  '🎮 Practice mode started — trades do not count toward rankings.','✅ Practice mode ended — real trading resumes.',
  ' — ran for ',' minute','📋 Day order expired at session close: ',
  ' trading halted — ','⚠️ Trading halted on ',' trading has been halted: ',' trading resumed','System (Circuit Breaker)',
  ' trading has resumed','📋 Limit order cancelled — ',' has been delisted.',') has been delisted from JEX.',
  ') delisted','🔄 Your company ',' has been reset — you can now submit a new IPO application.',
  ' delisted — you were paid ',' per share',') listed on JEX @ ','🎉 Your IPO has been approved! ',
  ') is now listed on JEX.','❌ Your IPO application for ',' was rejected.',' converted to Class ',
  ' stripped from','Share class ',' removed from',' approved (',') with ','Snapshot restored: ',
  'Meeting minutes posted: ','📋 New meeting minutes posted: ','Announcement posted: ',' flag on ',
  '🔥 Short squeeze alert: ','% short interest. Short sellers may be forced to cover.']){
  check('same words on both sides: "'+frag.trim()+'"', unq(code).includes(frag) && (src.includes(frag)||src.includes(frag.replace("'","\\'"))));
}
check('...including the apostrophe in the Secretary\'s close notice',
      unq(code).includes("📋 Session closed — prepare and post meeting minutes for today's session.")
      && src.includes("📋 Session closed — prepare and post meeting minutes for today\\'s session."));

// ── the page defers for every one ──
// Each page-side log/notification of a batch 2 event is reached only when the
// server does not record the function that did it.
const SITES=[
  ["logActivity('session'",'rpc_admin_save_session'],
  ["pushNotificationToAll('session'",'rpc_admin_save_session'],
  ["pushNotification(officer.id,'session'",'rpc_admin_save_session'],
  ["'📋 Day order expired at session close: '",'rpc_expire_day_orders'],
  ["logActivity('halt'",'rpc_admin_halt_stock'],
  ["'⚠️ Trading halted on '",'rpc_admin_halt_stock'],
  ["' trading has been halted: '",'rpc_admin_halt_stock'],
  ["logActivity('resume'",'rpc_admin_resume_stock'],
  ["pushNotificationToAll('resume'",'rpc_admin_resume_stock'],
  ["') has been delisted from JEX.'",'rpc_admin_delist_company'],
  ["logActivity('ipo',co.name+' ('+ticker+') delisted'",'rpc_admin_delist_company'],
  ["'🔄 Your company '",'rpc_admin_relist_company'],
  ["' delisted — you were paid '",'rpc_review_delisting'],
  ["logActivity('ipo',app.ticker+' delisted — '",'rpc_review_delisting'],
  ["logActivity('ipo',r.name+",'rpc_review_ipo'],
  ["'🎉 Your IPO has been approved! '",'rpc_review_ipo'],
  ["'❌ Your IPO application for '",'rpc_review_ipo'],
  ["logActivity('class_approved'",'rpc_review_class_application'],
  ["logActivity('class_removed'",'rpc_admin_remove_share_class'],
  ["logActivity('registration'",'approve_registration'],
  ["logActivity('snapshot','Snapshot restored: '",'rpc_admin_restore_snapshot'],
  ["logActivity('minutes'",'rpc_post_minutes'],
  ["pushNotificationToAll('minutes'",'rpc_post_minutes'],
  ["logActivity('announcement'",'rpc_post_announcement'],
  ["logActivity('flag_resolve'",'rpc_admin_resolve_flag'],
];
// A call is guarded when the nearest guard before it -- `if(!X)` for a
// const X=serverRecords('fn'), or `serverRecords('fn'))afterServerEvent();
// else` -- either encloses it in a block or is the statement directly in
// front of it. The nearest one: an earlier guard on the same flag, for a
// different block, does not count.
function guarded(at,fn){
  const wide=src.slice(Math.max(0,at-3000),at), base=Math.max(0,at-3000);
  const bound=[...wide.matchAll(new RegExp("const (\\w+)=serverRecords\\('"+fn+"'\\);",'g'))].pop();
  const pats=[new RegExp("serverRecords\\('"+fn+"'\\)\\)afterServerEvent\\(\\);\\s*else",'g')];
  if(bound)pats.push(new RegExp('if\\(!'+bound[1]+'\\)','g'),new RegExp('if\\('+bound[1]+'\\)afterServerEvent\\(\\);\\s*else','g'));
  let last=null;
  for(const re of pats)for(const m of wide.matchAll(re))if(!last||m.index>last.index)last={index:m.index,end:m.index+m[0].length};
  if(!last)return false;
  const rest=src.slice(base+last.end,at);
  if(/^\s*(await\s+)?$/.test(rest))return true;              // the very next statement
  if(!/^\s*\{/.test(rest))return false;
  let d=0;
  for(const ch of rest.slice(rest.indexOf('{'))){if(ch==='{')d++;else if(ch==='}'&&--d<1)return false;}
  return d>=1;                                                   // still inside its block
}
// "Limit order cancelled" appears twice: admin delist and reviewed delisting.
for(const [needle,fn] of SITES.concat([["'📋 Limit order cancelled — '",null]])){
  let at=src.indexOf(needle), n=0;
  check('found '+needle, at>=0);
  while(at>=0){
    n++;
    const before=src.slice(Math.max(0,at-900),at);
    const f=fn||(/rpc_review_delisting/.test(before)?'rpc_review_delisting':'rpc_admin_delist_company');
    // A message fragment sits inside its call: judge from where the call starts.
    const head=src.slice(Math.max(0,at-200),at);
    const calls=[...head.matchAll(/(?:await\s+)?(?:pushNotification\w*|logActivity)\(/g)];
    const callAt=needle.startsWith("'")&&calls.length?at-head.length+calls.pop().index:at;
    check(needle+' #'+n+' defers to '+f, guarded(callAt,f), src.slice(at-120,at+40));
    at=src.indexOf(needle,at+1);
  }
}
const sq=src.slice(src.indexOf('function checkShortSqueezes('),src.indexOf('function checkShortSqueezes(')+2600);
check('the squeeze alert asks the server once the server decides',
      /const server=serverRecords\('rpc_check_short_squeeze'\);/.test(sq) && /if\(server\)\{[\s\S]*?sb\.rpc\('rpc_check_short_squeeze'[\s\S]*?return;\s*\}/.test(sq));
check('...and only falls back to the old alert before the migration',
      sq.indexOf("pushNotificationToAll('halt','🔥 Short squeeze alert: '")>sq.indexOf('if(server){'));
check('...stops asking once it is settled for the day', /r\.sent\|\|r\.reason==='already_sent'/.test(sq));
check('...and asks once at a time per company', /_squeezeAsking\.has\(co\.ticker\)/.test(sq));
check('a squeeze has its own icon and push title', /squeeze:'🔥'\}/.test(src) && /squeeze:'🔥 Short squeeze'/.test(src));

// ── the squeeze check, run ──
let toasts=[], rpcs=[], pushed=[], refreshed=0, store={};
const DB={companies:[{ticker:'ACME',name:'Acme',status:'listed',shares:1000,price:13}],
  users:[{role:'student',shorts:{ACME:{qty:100}}}],funds:[{shorts:{ACME:{qty:60}}}],
  session:{session_open_prices:{ACME:10}}};
const isOpen=()=>true;
let serverList=new Set(['rpc_check_short_squeeze']);
const serverRecords=fn=>serverList.has(fn);
const afterServerEvent=()=>{refreshed++;};
const priceChg=c=>(c.price-DB.session.session_open_prices[c.ticker])/DB.session.session_open_prices[c.ticker]*100;
const localStorage={getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=v;}};
const pushNotificationToAll=(...a)=>{pushed.push(a);};
let answer={sent:true};
const sb={rpc:async(fn,p)=>{rpcs.push(p.p_ticker);return answer;}};
const start=src.indexOf('const _squeezeAsking=');
const end=src.indexOf('\n}\n',src.indexOf('function checkShortSqueezes('))+2;
eval(src.slice(start,end).replace('const _squeezeAsking=','var _squeezeAsking='));
const tick=()=>new Promise(r=>setTimeout(r,10));
(async()=>{
  // 160 short of 1000 = 16%, but only with the fund's 60 counted.
  checkShortSqueezes();checkShortSqueezes();
  await tick();
  check('a fund\'s short counts toward short interest, as on the server', rpcs.length===1, JSON.stringify(rpcs));
  check('two ticks while asking send one request', rpcs.length===1);
  check('the page sends no alert itself', pushed.length===0);
  check('a sent alert fetches what the server wrote', refreshed===1);
  checkShortSqueezes();await tick();
  check('settled for the day: it stops asking', rpcs.length===1);
  store={};answer={sent:false,reason:'not_crossed'};
  checkShortSqueezes();await tick();checkShortSqueezes();await tick();
  check('not crossed on the server: it asks again next tick', rpcs.length===3, JSON.stringify(rpcs));
  store={};serverList=new Set();rpcs=[];
  checkShortSqueezes();await tick();
  check('before the migration the old alert still goes out', pushed.length===0 && rpcs.length===0,
        'students alone are 10%: '+JSON.stringify(pushed));
  DB.users[0].shorts.ACME.qty=200;store={};
  checkShortSqueezes();await tick();
  check('...counting students only, as it always did', pushed.length===1 && /16%|20%/.test(pushed[0][1]), JSON.stringify(pushed));
  console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
  process.exit(fails?1:0);
})();
