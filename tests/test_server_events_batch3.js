// sql/server_events_batch3.sql moves the last page-written log entries and
// notifications -- the company and student actions -- into the functions
// that do them, and adds rpc_notify_news_holders for the "Notify all
// shareholders" box on news.
//
// Verified on a copy of production's code (every table identical before and
// after apart from the news claim column; wording identical to the page's;
// one news notice per article). This guards what the files can show -- and
// one thing batch 4 depends on: after this, EVERY log or notification call
// left in the page runs only when the server does not record that event.
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
      /const serverNews=serverRecords\('rpc_notify_news_holders'\);\s*if\(serverNews\)\{\s*try\{const n=await sb\.rpc\('rpc_notify_news_holders',\{p_news_id:rec\.id\}\)/.test(src));

// ── the wording is the page's ──
for(const frag of ['⏰ Your after-hours ',' is now active','🗳️ Vote closed: "','" — ',' launched a new fund: ','% performance fee)',
  '🚩 Compliance flag: ',' flagged ',' placed limit ','📊 ',') posted financial results for ',': Revenue ',', Profit ',
  ' posted financials for ',' — Rev ',' posted vote: ',' posted a vote: ','❌ Your dividend request for ',
  ' was rejected by the Treasurer.','❌ You have been removed as a founder of ',' removed as founder of ',
  ') has applied to delist — ','. Reason: ',') applied to delist (','💰 Dividend approval needed: ',' wants to pay ',
  ' total (',' founder shares for ',' joined ',' as a founder','✅ ',' accepted your founder invitation and has joined ',
  ' declined your founder invitation for ','🎁 ',' founder shares of ',') have been added to your portfolio!',
  '❌ Your founder share request for ',' granted ','🤝 ',' has invited you to join ',' as a founder. Accept or decline below.',
  '🐛 Bug report from ',' reported a bug: ',' applied for ',' Class ','🎯 Price alert: ',' (now ','📰 ']){
  check('same words on both sides: "'+frag.trim()+'"', unq(code).includes(frag) && src.includes(frag));
}

// ── every page write is now only a fallback ──
// Each logActivity / pushNotification* call left in the page must sit behind
// a serverRecords() check: either the else of
//   if(serverRecords('fn'))afterServerEvent(); else ...
// or inside if(!X) / &&!X for a const X=serverRecords('fn'). The nearest
// guard has to enclose the call -- an earlier guard for another block does
// not count. Batch 4 removes the page's ability to write these at all, so a
// call that slipped through here would silently stop working.
function guarded(at){
  const base=Math.max(0,at-3000), wide=src.slice(base,at);
  const vars=[...wide.matchAll(/const (\w+)=serverRecords\('\w+'\);/g)].map(m=>m[1]);
  const pats=[/serverRecords\('\w+'\)\)afterServerEvent\(\);\s*else/g, /if\(!server\)\{?/g];
  for(const v of vars)pats.push(new RegExp('if\\(!'+v+'\\)','g'),new RegExp('&&!'+v+'\\)','g'),
    new RegExp('if\\('+v+'\\)afterServerEvent\\(\\);\\s*else','g'));
  let last=null;
  for(const re of pats)for(const m of wide.matchAll(re))if(!last||m.index>last.index)last={index:m.index,end:m.index+m[0].length};
  if(!last)return false;
  let rest=src.slice(base+last.end,at);
  if(/^\s*(await\s+)?$/.test(rest))return true;
  if(/^\s*if\(co\)\{/.test(rest))rest=rest.replace(/^\s*if\(co\)/,'');      // else if(co){ ... }
  if(!/^\s*\{/.test(rest))return false;
  let d=0;
  for(const ch of rest.slice(rest.indexOf('{'))){if(ch==='{')d++;else if(ch==='}'&&--d<1)return false;}
  return d>=1;
}
const helpers=['logActivity','pushNotification','pushNotificationToHolders','pushNotificationToAll'];
const fnStarts=[...src.matchAll(/^(?:async )?function (\w+)\(/gm)].map(m=>({at:m.index,name:m[1]}));
const fnAt=i=>{let n=null;for(const f of fnStarts){if(f.at>i)break;n=f.name;}return n;};
let sites=0;
for(const m of src.matchAll(/(?:await\s+)?(logActivity|pushNotification(?:ToHolders|ToAll)?)\(/g)){
  const fn=fnAt(m.index);
  if(helpers.includes(fn))continue;              // the helpers themselves
  if(/^function\s/.test(src.slice(m.index-9,m.index)))continue;
  sites++;
  // The squeeze fallback follows an early return out of if(server){...};
  // test_server_events_batch2.js checks that shape in detail.
  if(fn==='checkShortSqueezes'){
    const sq=src.slice(src.indexOf('function checkShortSqueezes('),m.index);
    check('page write in checkShortSqueezes is only a fallback',
          /const server=serverRecords\('rpc_check_short_squeeze'\);/.test(sq) && /if\(server\)\{[\s\S]*?return;\s*\}\s*try\{localStorage\.setItem\(key,'1'\);\}catch\(e\)\{\}\s*$/.test(sq));
    continue;
  }
  check('page write in '+fn+' is only a fallback', guarded(m.index), src.slice(m.index-100,m.index+60).replace(/\s+/g,' '));
}
check('found the page\'s remaining writes', sites>=60, String(sites));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
