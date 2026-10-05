// sql/server_events_batch3.sql moves the last page-written log entries and
// notifications -- the company and student actions -- into the functions
// that do them, and adds rpc_notify_news_holders for the "Notify all
// shareholders" box on news.
//
// Verified on a copy of production's code (every table identical before and
// after apart from the news claim column; wording identical to the page's;
// one news notice per article). This guards what the files can show. That
// the page no longer writes anything itself is test_server_events_batch4.js.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'..','sql','server_events_batch3.sql'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const code=sql.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');
const unq=s=>s.replace(/''/g,"'");

// ── the migration's rails ──
const EIGHTEEN=['rpc_activate_after_hours_orders','rpc_close_vote','rpc_create_fund','rpc_flag_account',
  'rpc_place_limit_order','rpc_post_financials','rpc_post_vote','rpc_reject_dividend_approval',
  'rpc_remove_founder','rpc_request_delisting','rpc_request_dividend_approval',
  'rpc_request_founder_allocation','rpc_respond_to_invite','rpc_review_founder_allocation',
  'rpc_send_founder_invite','rpc_submit_bug_report','rpc_submit_class_application','rpc_trigger_price_alert'];
const rows=[...code.matchAll(/\((\d+), '(\w+)', '([0-9a-f]{32})',/g)].map(m=>({seq:+m[1],fn:m[2],md5:m[3]}));
const fns=[...new Set(rows.map(r=>r.fn))];
check('the plan covers exactly the eighteen', fns.length===18 && EIGHTEEN.every(f=>fns.includes(f)), fns.join(','));
check('edits are numbered in order', rows.every((r,i)=>r.seq===i+1));
check('one fingerprint per function', fns.every(f=>new Set(rows.filter(r=>r.fn===f).map(r=>r.md5)).size===1));
check('refuses to run before batches 1 and 2', /run server_events_batch1\.sql and server_events_batch2\.sql first/.test(code));
check('a mismatch aborts before anything is created',
      code.indexOf('is not the version this was written against')<code.indexOf('alter table public.jex_news'));
check('every edit\'s anchor must occur exactly once', /anchor exactly once in %/.test(code));
check('the plan is held inside the block', /select jsonb_agg\(to_jsonb\(p\) order by p\.seq\) into v_plan/.test(code) && !/temp(orary)? table/i.test(code));
check('safe to run twice', (code.match(/position\('jex_ev_' in v_src\) > 0/g)||[]).length===2);

const created=[...code.matchAll(/create or replace function public\.(jex_\w+)\(/g)].map(m=>m[1]);
const revoke=(code.match(/revoke execute on function([\s\S]*?)from public, anon, authenticated/)||[])[1]||'';
check('helpers created', created.length===20, created.join(','));
for(const h of created)check('...'+h+' cannot be called from the web', revoke.includes('public.'+h+'('));
check('every event function warns instead of undoing the action',
      (code.match(/exception when others then raise warning '/g)||[]).length===created.filter(h=>h.startsWith('jex_ev_')).length);

// ── companies are named by their base listing ──
check('a company is found by owner with its base listing first, not a share class',
      /order by exists \(select 1 from jex_share_classes sc where sc\.ticker = c\.ticker and sc\.ticker <> sc\.parent_ticker\)/.test(code));
for(const f of ['jex_ev_flagged','jex_ev_invite_answered','jex_ev_founder_removed','jex_ev_invite_sent']){
  const body=code.slice(code.indexOf('function public.'+f+'('),code.indexOf('$body$;',code.indexOf('function public.'+f+'(')));
  check('...used by '+f, /jex_company_of\(/.test(body) && !/from jex_companies where owner_id/.test(body));
}

// ── news: the author's choice, once ──
const news=code.slice(code.indexOf('function public.rpc_notify_news_holders('));
check('news notices: only the author', /author_id = v_uid/.test(news));
check('...within 10 minutes of posting', /created_at > now\(\) - interval '10 minutes'/.test(news));
check('...once', /holders_notified_at is null/.test(news) && /set holders_notified_at = now\(\)/.test(news));
check('...with the text from the stored article', /'📰 ' \|\| n\.company_name \|\| ': ' \|\| n\.headline/.test(code));
check('...signed-in users only',
      /revoke execute on function public\.rpc_notify_news_holders\(text\) from public, anon/.test(code)
      && /grant execute on function public\.rpc_notify_news_holders\(text\) to authenticated/.test(code));
check('the page asks the server when the box is ticked',
      /if\(document\.getElementById\('news-notify'\)\?\.checked\)\{[\s\S]{0,200}?try\{const n=await sb\.rpc\('rpc_notify_news_holders',\{p_news_id:rec\.id\}\)/.test(src));

// ── the wording ──
// Written to match what the page used to send; the page no longer writes any
// of it (server_events_batch4.sql), so these guard the migration's own text.
for(const frag of ['⏰ Your after-hours ',' is now active','🗳️ Vote closed: "','" — ',' launched a new fund: ','% performance fee)',
  '🚩 Compliance flag: ',' flagged ',' placed limit ','📊 ',') posted financial results for ',': Revenue ',', Profit ',
  ' posted financials for ',' — Rev ',' posted vote: ',' posted a vote: ','❌ Your dividend request for ',
  ' was rejected by the Treasurer.','❌ You have been removed as a founder of ',' removed as founder of ',
  ') has applied to delist — ','. Reason: ',') applied to delist (','💰 Dividend approval needed: ',' wants to pay ',
  ' total (',' founder shares for ',' joined ',' as a founder','✅ ',' accepted your founder invitation and has joined ',
  ' declined your founder invitation for ','🎁 ',' founder shares of ',') have been added to your portfolio!',
  '❌ Your founder share request for ',' granted ','🤝 ',' has invited you to join ',' as a founder. Accept or decline below.',
  '🐛 Bug report from ',' reported a bug: ',' applied for ',' Class ','🎯 Price alert: ',' (now ','📰 ']){
  check('the server writes: "'+frag.trim()+'"', unq(code).includes(frag));
}

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
