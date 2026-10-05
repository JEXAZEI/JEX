// sql/server_events_batch1.sql moves the activity entry and notifications for
// eleven money-and-positions functions into the functions themselves, and the
// page stops writing its own copy for whichever ones the server lists.
//
// The money side was verified on a copy of production's code (every balance,
// holding, short, price, order and trade identical before and after; chain
// intact under 8 parallel writers). This guards what can be checked from the
// files: the migration's own safety rails, that the server's wording is the
// page's wording, and that every page call site for these events defers to the
// server once it records them -- or the event is written twice.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'..','sql','server_events_batch1.sql'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const code=sql.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');

// ── the migration's rails ──
const plan=[...code.matchAll(/\['(\w+)', '([0-9a-f]{32})',/g)].map(m=>({fn:m[1],md5:m[2]}));
const ELEVEN=['admin_adjust_cash','rpc_fund_deposit','rpc_fund_withdraw','rpc_pay_dividend','rpc_fill_limit_vs_pool',
  'rpc_match_limit_order_book','rpc_trigger_stop_loss','rpc_margin_call_short','rpc_margin_call_fund_short',
  'rpc_convert_share_class','rpc_adjust_stock_price'];
check('the plan covers exactly the eleven', plan.length===11 && ELEVEN.every(f=>plan.some(p=>p.fn===f)),
      plan.map(p=>p.fn).join(','));
check('each is pinned to a production fingerprint', plan.every(p=>/^[0-9a-f]{32}$/.test(p.md5)));
check('a mismatch aborts before anything is created',
      code.indexOf("is not the version this was written against")<code.indexOf('create or replace function public.jex_fmt'));
check('each anchor must occur exactly once', /expected the anchor exactly once/.test(code));
check('the check loop cannot reuse the previous function\'s body', /v_src := null; v_fp := null;/.test(code));
check('a function that already records its events is skipped (safe to run twice)',
      /position\('jex_ev_' in r\.prosrc\) > 0 then\s+raise notice '% already records its events/.test(code));
check('CRLF bodies keep their line endings', /v_nl := case when position\(chr\(13\) in r\.prosrc\)/.test(code));

// Every helper is created and every one is revoked from the web roles.
const created=[...code.matchAll(/create or replace function public\.(jex_\w+)\(/g)].map(m=>m[1]);
const revoke=(code.match(/revoke execute on function([\s\S]*?)from public, anon, authenticated/)||[])[1]||'';
check('helpers created', created.length===14, created.join(','));
for(const h of created)check('...'+h+' cannot be called from the web', revoke.includes('public.'+h+'('));
check('rpc_server_events is the one new function the page may call',
      /grant execute on function public\.rpc_server_events\(\) to anon, authenticated/.test(code));
check('...and it does not list itself', /p\.proname <> 'rpc_server_events'/.test(code));

// The log entry joins the same chain rpc_log_activity writes, the same way.
check('server entries take the chain lock', /pg_advisory_xact_lock\(hashtext\('jex_activity_chain'\)\)/.test(code));
check('...are stamped under it', /'server', clock_timestamp\(\)\);/.test(code));
check('...and hash the writer like rpc_log_activity does', /coalesce\(v_ticker, ''\) \|\| 'server'\), 1, 8\)/.test(code));
check('recording never undoes a trade: every event function warns instead of failing',
      (code.match(/exception when others then raise warning '/g)||[]).length===10);
check('an order that fills the moment it is placed does not notify (or email) its owner',
      /p_placed < now\(\) - interval '1 minute'/.test(code));

// ── the wording ──
// Written to match what the page used to send, word for word. The page no
// longer writes any of it (server_events_batch4.sql), so these fragments
// guard the migration's own text.
const unq=s=>s.replace(/''/g,"'");
for(const frag of [" paid dividend ","/share — total ","💰 "," paid a dividend of ",
  " — the cash came out of the company, so your total is unchanged. That is what a dividend is.",
  " deposited "," into "," withdrew "," (performance fee ",
  " added to "," removed from ","'s balance set to ",
  "'s limit "," filled vs JEX pool @ ","⚡ Limit "," filled: "," ↔ ",
  "🛑 Stop-loss triggered: sold "," (trigger: "," stop-loss triggered on ",
  " was closed by a margin call @ "," (opened at ","). Loss "," you posted."," the fund posted.",
  " converted "," price ","boosted by +","cut by "]){
  check('the server writes: "'+frag.trim()+'"', unq(code).includes(frag));
}
check('the server writes the margin call notice', unq(code).includes('⚠️ Margin call: your short of '));

// ── the page's half, run ──
function grab(name){
  const m=new RegExp('^(?:async )?function '+name+'\\(','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  let i=src.indexOf('{',m.index),d=0;
  for(let j=i;j<src.length;j++){if(src[j]==='{')d++;else if(src[j]==='}'&&--d===0)return src.slice(m.index,j+1);}
}
let _serverEventTimer=null, sheets=[];
const pushToSheets=(t,p)=>{sheets.push(t+':'+(p.items||[]).length);};
let rpcCalls=[], pushes=[], renders=0, me={id:'u1',role:'student'};
const UI={userId:'u1'};
const PUSH_TITLES={stop_loss:'🛑 Stop-loss triggered'};
const isAdmin=u=>['chairman','treasurer'].includes(u&&u.role);
const cu=()=>me;
const showBrowserPush=(t,b)=>pushes.push(t+'|'+b);
const userIsFillingForm=()=>false;
const renderBackground=()=>{renders++;};
let DB={notifications:[{id:'n0',user_id:'u1',read:false,message:'old'}],activity:[{id:'a0'}]};
let serverNotes=[], sb;
const safeRpc=async(fn,p)=>{rpcCalls.push(fn);
  if(fn==='rpc_get_my_notifications')return serverNotes;
  if(fn==='rpc_admin_list_activity')return [{id:'a1'},{id:'a0'}];
  return null;};
eval(grab('afterServerEvent'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  // A matching sweep can settle many orders in a row: one fetch, not many.
  serverNotes=[{id:'n0',user_id:'u1',read:false,message:'old'},
               {id:'n1',user_id:'u1',read:false,type:'stop_loss',message:'sold 10'},
               {id:'n2',user_id:'u1',read:true,type:'stop_loss',message:'already read'}];
  rpcCalls=[];pushes=[];renders=0;
  for(let i=0;i<5;i++)afterServerEvent();
  await wait(600);
  check('five events in a row fetch once', rpcCalls.filter(f=>f==='rpc_get_my_notifications').length===1, rpcCalls.join(','));
  check('a student does not ask for the officers\' activity list', !rpcCalls.includes('rpc_admin_list_activity'));
  check('the new notification is now in the page', DB.notifications.some(n=>n.id==='n1'));
  check('...and pops a browser push, as when this tab wrote it', pushes.length===1 && pushes[0]==='🛑 Stop-loss triggered|sold 10', pushes.join(';'));
  check('...nothing for one already known or already read', !pushes.some(p=>p.endsWith('|old')||p.endsWith('|already read')));
  check('the page re-renders once', renders===1);

  me={id:'u1',role:'treasurer'};rpcCalls=[];pushes=[];
  afterServerEvent();await wait(600);
  check('an officer\'s activity list picks up the server\'s entry', DB.activity.length===2 && DB.activity[0].id==='a1');
  check('...and a second refresh pushes nothing already seen', pushes.length===0);
  check('...and feeds the Sheets activity tab, which the page\'s own entries used to', sheets.includes('activity:2'), sheets.join(','));

  me=null;UI.userId=null;rpcCalls=[];
  afterServerEvent();await wait(600);
  check('signed out, nothing is fetched', rpcCalls.length===0, rpcCalls.join(','));

  console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
  process.exit(fails?1:0);
})();
