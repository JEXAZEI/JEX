// ═══════════════════════════════════════════════
// CONFIG — paste your Supabase values here
// ═══════════════════════════════════════════════
const SUPABASE_URL = 'https://hahxemgfkorglaoywybq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_-moLk6DXyj8L41Ope-RAXw_3YPkyv_8';
const SESSION_KEY = 'jex-session-v3';
const APP_VERSION = '1.0.0';
// jex_users/jex_pending grant anon/authenticated column-level SELECT on
// everything except password/sec_a (see the password-hash-fix migration),
// and — since the email-pii-exposure-fix migration — except email and
// notification_email too (jex_pending: email only). A bare select=* is a
// table-level operation and fails outright under a column-only grant, so
// every fetch of these two tables must explicitly list columns.
// Centralized here so every call site stays in sync. email/notification_email
// are deliberately NOT in this bulk list any more — every legitimate reader
// gets them through a scoped RPC instead (see rpc_resolve_login_identity,
// rpc_google_session_match, rpc_admin_get_all_emails,
// rpc_get_company_team_contacts).
const JEX_USERS_SAFE_SELECT = 'id,name,username,role,status,cash,holdings,shorts,watchlist,fund_units,description,app_status,sec_q,auth_provider,auth_uid,created_at,classroom_id,email_notifications';
const JEX_PENDING_SAFE_SELECT = 'id,name,role,sec_q,description,ts,created_at,classroom_id,username,auth_provider,email_verified,auth_uid';

// Headers carry the CURRENT user's own Supabase Auth access token when one exists
// (real per-user identity, needed for RLS to ever enforce anything per-row), falling
// back to the shared anon key otherwise — e.g. logged out, or a legacy account that
// hasn't been migrated to real auth yet. supaAuth is declared further down; guarded
// here since sb is defined before it.
// supabase-js v2 serializes concurrent auth.getSession() calls behind an
// internal lock (to avoid racing a token refresh) -- loadAll() fires dozens
// of requests via Promise.all, and each one calling getSession() itself
// turned that "parallel" fetch into dozens of queued lock acquisitions
// before any request could even start, badly slowing down every page load.
// _authTokenCache is kept in sync by the onAuthStateChange listener below
// (which fires once immediately with the current session, then again on
// every sign-in/out/refresh), so most calls here just read the cache
// instead of touching the lock at all.
let _authTokenCache={ready:false,token:null};
// Before the cache is warm (the very first loadAll(), racing the async
// initial onAuthStateChange event), multiple concurrent callers would each
// still hit the lock independently -- sharing one in-flight getSession()
// call between them collapses that back down to a single lock acquisition.
let _authTokenInflight=null;
async function sbAuthToken(){
  if(typeof supaAuth==='undefined'||!supaAuth)return SUPABASE_ANON_KEY;
  if(_authTokenCache.ready)return _authTokenCache.token||SUPABASE_ANON_KEY;
  try{
    if(!_authTokenInflight){
      _authTokenInflight=supaAuth.auth.getSession().finally(()=>{_authTokenInflight=null;});
    }
    const{data}=await _authTokenInflight;
    if(data&&data.session&&data.session.access_token)return data.session.access_token;
  }catch(e){}
  return SUPABASE_ANON_KEY;
}
const sb = {
  url:(t,q='')=>SUPABASE_URL+'/rest/v1/'+t+(q?'?'+q:''),
  async headers(extra){
    const token=await sbAuthToken();
    return {'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+token,...(extra||{})};
  },
  async get(t,q=''){const h=await this.headers({'Accept':'application/json'});const r=await fetch(this.url(t,q),{headers:h});if(!r.ok)throw new Error(await r.text());const d=await r.json();
    // Defense in depth: the database itself now revokes SELECT on these columns
    // (see the password-hash-fix migration), so this is a no-op in practice —
    // kept in case that revoke is ever missing on a given project.
    if(t==='jex_users'&&Array.isArray(d))d.forEach(u=>{delete u.password;delete u.sec_a;});return d;},
  // jex_users/jex_pending only have column-level (not table-level) SELECT for
  // anon/authenticated (see the password-hash-fix migration), and `return=
  // representation` needs to read back the affected row same as a bare
  // select=* does — same failure mode, so those two tables ask for no
  // representation at all. Nothing reads the POST/PATCH response body for
  // either table anyway (checked every call site before making this change).
  async post(t,d){const minimal=t==='jex_users'||t==='jex_pending';const h=await this.headers({'Prefer':'return='+(minimal?'minimal':'representation')});const r=await fetch(this.url(t),{method:'POST',headers:h,body:JSON.stringify(d)});if(!r.ok)throw new Error(await r.text());return minimal?null:r.json();},
  async patch(t,q,d){const minimal=t==='jex_users'||t==='jex_pending';const h=await this.headers({'Prefer':'return='+(minimal?'minimal':'representation')});const r=await fetch(this.url(t,q),{method:'PATCH',headers:h,body:JSON.stringify(d)});if(!r.ok)throw new Error(await r.text());return minimal?null:r.json();},
  async del(t,q){const h=await this.headers();const r=await fetch(this.url(t,q),{method:'DELETE',headers:h});if(!r.ok)throw new Error(await r.text());},
  async rpc(fn,params){const h=await this.headers({'Accept':'application/json'});const r=await fetch(SUPABASE_URL+'/rest/v1/rpc/'+fn,{method:'POST',headers:h,body:JSON.stringify(params||{})});if(!r.ok)throw new Error(await r.text());
    // `returns void` RPCs (e.g. rpc_admin_clear_client_errors) come back as an
    // empty 204 body -- r.json() on an empty body throws "Unexpected end of
    // JSON input", so read as text first and only parse if there's anything there.
    const t=await r.text();return t?JSON.parse(t):null;}
};
// Calls an RPC and swallows any failure (permission-denied for a role that
// legitimately shouldn't have access, network hiccup, etc.) into `null`
// instead of throwing — used for RPCs that are only meaningful for SOME
// callers (e.g. admin-only bulk data merged in opportunistically) where a
// non-admin's expected rejection should never break the wider load.
async function safeRpc(fn,params){try{return await sb.rpc(fn,params);}catch(e){return null;}}
const isConfigured=()=>SUPABASE_URL!=='YOUR_SUPABASE_URL'&&SUPABASE_ANON_KEY!=='YOUR_SUPABASE_ANON_KEY';
// ── Client-side error/failure logging ─────────────────────
// Reports genuinely uncaught errors to an admin-only log (see the
// client-error-logging migration) -- normal validation rejections are
// already caught by the code that triggers them and shown via toast(),
// so they never reach here; only real bugs do. Deliberately does not use
// safeRpc/sb.rpc's own error surface (a failed report must never itself
// throw a second uncaught error) and de-dupes identical errors within one
// page load so a loop that errors every frame doesn't flood the log.
const _reportedErrors=new Set();
function reportClientError(message,stack,source){
  try{
    if(!isConfigured())return;
    const key=String(message)+'|'+String(source||'');
    if(_reportedErrors.has(key))return;
    _reportedErrors.add(key);
    sb.rpc('rpc_report_client_error',{
      p_message:String(message||'').slice(0,500),
      p_stack:String(stack||'').slice(0,2000),
      p_source:String(source||'').slice(0,300),
      p_url:typeof location!=='undefined'?location.href:null
    }).catch(()=>{});
  }catch(e){}
}
if(typeof window!=='undefined'){
  window.addEventListener('error',e=>{
    reportClientError(e.message,e.error&&e.error.stack,(e.filename||'')+(e.lineno?':'+e.lineno:''));
  });
  window.addEventListener('unhandledrejection',e=>{
    const r=e.reason;
    reportClientError(r&&r.message?r.message:String(r),r&&r.stack,'unhandledrejection');
  });
}
// Used for Google Sign-In and (Phase 1) migrated local accounts — all other data
// access stays on the sb wrapper above, which itself borrows this client's session
// token when one exists (see sbAuthToken below).
let supaAuth=null;
// True for the whole page load a password-reset link was opened on. Guards checkGoogleSession()
// (see below) from racing the PASSWORD_RECOVERY event: that event fires asynchronously, and if
// checkGoogleSession()'s own getSession() call resolves first, it would otherwise treat the
// brand-new recovery session exactly like a returning Google login and silently sign the browser
// into the target account — skipping the "set new password" screen entirely. The URL itself is
// also checked synchronously as a second, ordering-independent signal, since Supabase's redirect
// link carries a recovery marker (type=recovery) before the SDK has even parsed it into an event.
let _passwordRecoveryActive=/type=recovery/.test(window.location.hash)||/type=recovery/.test(window.location.search);
// True for the whole page load a Google OAuth redirect landed back on --
// Supabase's return URL carries either #access_token=... (implicit flow) or
// ?code=... (PKCE) before the SDK has parsed/exchanged it into a session.
// Used only to keep the "Connecting..." splash up through checkGoogleSession()
// instead of flashing the login screen in between: without a saved
// localStorage session yet (this may be this browser's first-ever visit),
// loadAll()'s own renders show the login screen while checkGoogleSession()
// is still working out that this is actually a just-completed Google
// sign-in, which read as a jarring "back to login" flash right after
// approving on Google's consent screen. Cleared once checkGoogleSession()
// settles either way (see its finally block below).
let _oauthReturnActive=!_passwordRecoveryActive&&(/access_token=/.test(window.location.hash)||/[?&]code=/.test(window.location.search));
// A recovery session is otherwise indistinguishable from a normal signed-in session once
// persisted — if someone opens a reset link and then just closes the tab without setting a
// new password, that live session would still be sitting in localStorage on the next visit,
// and _passwordRecoveryActive (in-memory, reset every page load) can't catch that later visit.
// Remembering this specific session's access_token here (durable, survives a reload) lets
// checkGoogleSession() keep refusing to auto-login with THIS session while not affecting any
// later, genuine login by the same person (which mints a different token entirely).
const RECOVERY_TOKEN_KEY='jex-recovery-token';
try{
  if(isConfigured()&&typeof window.supabase!=='undefined'){
    supaAuth=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);
    // A password-reset email link lands back here with a PASSWORD_RECOVERY event.
    // Force out of any existing app session and show the "set new password" form,
    // regardless of what the page happened to be showing before the link was clicked.
    supaAuth.auth.onAuthStateChange((event,session)=>{
      // Fires once immediately with the current session (whatever it is),
      // then again on every sign-in/out/refresh -- keeps sbAuthToken()'s
      // cache correct without it ever needing to call getSession() itself.
      _authTokenCache={ready:true,token:(session&&session.access_token)||null};
      if(event==='PASSWORD_RECOVERY'){
        _passwordRecoveryActive=true;
        if(session&&session.access_token){try{localStorage.setItem(RECOVERY_TOKEN_KEY,session.access_token);}catch(e){}}
        UI.userId=null;
        try{localStorage.removeItem(SESSION_KEY);}catch(e){}
        UI.loginView='recover-pw';
        render();
      }
    });
  }
}catch(e){console.warn('Supabase Auth client init failed:',e);}
// ── Password hashing ─────────────────────────────────────
// Only used to hash a NEWLY chosen password before writing it — checking
// an EXISTING password/security-answer against what's on file happens
// server-side now (verify_legacy_password / verify_legacy_security_answer
// RPCs), since the database no longer lets the client read those columns
// back at all.
async function hashPw(pw){
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(pw)));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
let DB={users:[],pending:[],companies:[],news:[],ipoApps:[],dilApps:[],trades:[],dividends:[],buybacks:[],
  announcements:[],limitOrders:[],activity:[],shareClasses:[],classApps:[],votes:[],ballots:[],
  notifications:[],halts:[],priceAlerts:[],stopLossOrders:[],nwHistory:[],
  companyMembers:[],founderAllocations:[],classrooms:[],flags:[],minutes:[],divApprovals:[],bugReports:[],funds:[],contactMessages:[],indexHistory:[],snapshots:[],clientErrors:[],
  session:{id:1,status:'closed',label:'Session closed',ends_at:null,scheduled_open:null,scheduled_close:null,starting_cash:10000,sheets_url:null,circuit_breaker_pct:20,session_open_prices:{},session_started_at:null,jxi_open_value:null,budget_warning_threshold:500,dividend_approval_threshold:1000,price_band_pct:30,order_rate_limit:10,
    weekly_schedule:{sun:{enabled:false,open:{h:16,m:0},close:{h:18,m:30}},mon:{enabled:false,open:{h:16,m:0},close:{h:18,m:30}},tue:{enabled:false,open:{h:16,m:0},close:{h:18,m:30}},wed:{enabled:false,open:{h:16,m:0},close:{h:18,m:30}},thu:{enabled:false,open:{h:16,m:0},close:{h:18,m:30}},fri:{enabled:false,open:{h:16,m:0},close:{h:18,m:30}},sat:{enabled:false,open:{h:16,m:0},close:{h:18,m:30}}},
    weekly_active:false,weekly_override:false}};
let SHEETS_URL=null;
let _realtimeChannels=[];

function subscribeRealtime(){
  if(!SUPABASE_URL||SUPABASE_URL==='YOUR_SUPABASE_URL')return;
  // Unsubscribe from any existing channels
  _realtimeChannels.forEach(ch=>{try{ch.unsubscribe();}catch(e){}});
  _realtimeChannels=[];
  const wsUrl=SUPABASE_URL.replace('https://','wss://').replace('http://','ws://');
  // Use Supabase Realtime REST API via SSE (works without SDK)
  // Subscribe to key tables via postgres_changes
  // jex_notifications deliberately excluded -- Supabase Realtime's
  // postgres_changes broadcasts the full row of every change to every
  // subscribed client, straight from WAL replication, completely bypassing
  // PostgREST's anon/authenticated grants (there's no RLS on this schema to
  // scope it with). Notifications are per-user by nature, so there is no
  // safe way to put this table on a shared realtime channel -- the
  // handleRealtimeUpdate() 'user_id===UI.userId' check below only filters
  // what the client CHOOSES to display, not what already arrived over the
  // wire. Notifications now rely on the ~15-20s autoRefresh() poll instead
  // (through rpc_get_my_notifications, safely scoped server-side). See the
  // notification-privacy-fix migration for the production-side caveat this
  // alone can't fully close (whether jex_notifications is actually in the
  // supabase_realtime publication needs checking directly).
  const tables=['jex_companies','jex_trades','jex_announcements',
    'jex_halts','jex_session','jex_limit_orders','jex_news','jex_votes'];
  // Build a single channel for all tables
  const channelName='jex-realtime-'+Math.random().toString(36).slice(2);
  const eventsUrl=SUPABASE_URL+'/realtime/v1/websocket?vsn=1.0.0&apikey='+SUPABASE_ANON_KEY;
  
  try{
    const ws=new WebSocket(eventsUrl);
    _realtimeChannels.push({unsubscribe:()=>ws.close()});
    let heartbeatInterval;
    
    ws.onopen=()=>{
      // Join channel -- topic must be this client's own unique channel name
      // (channelName, generated above), not a literal 'realtime:*' wildcard.
      // Supabase's Realtime protocol is per-channel: the server matches
      // incoming WAL changes against each joined channel's own
      // config.postgres_changes list, keyed by the channel's topic, not by
      // any special wildcard string -- a topic the server doesn't recognize
      // as a real channel silently never receives events, even though the
      // connection itself stays open and looks healthy.
      ws.send(JSON.stringify({topic:'realtime:'+channelName,event:'phx_join',payload:{config:{broadcast:{self:false},presence:{key:''},postgres_changes:tables.map(t=>({event:'*',schema:'public',table:t}))}},ref:'1'}));
      // Heartbeat every 30s
      heartbeatInterval=setInterval(()=>{
        if(ws.readyState===1)ws.send(JSON.stringify({topic:'phoenix',event:'heartbeat',payload:{},ref:'hb'}));
      },30000);
      console.log('JEX Realtime connected');
    };
    
    ws.onmessage=e=>{
      try{
        const msg=JSON.parse(e.data);
        if(msg.event==='postgres_changes'||msg.event==='INSERT'||msg.event==='UPDATE'||msg.event==='DELETE'){
          const {table,new:newRow,old:oldRow,eventType}=msg.payload?.data||msg.payload||{};
          handleRealtimeUpdate(table,eventType||msg.event,newRow,oldRow);
        }
      }catch(err){}
    };
    
    ws.onerror=()=>{ clearInterval(heartbeatInterval); };
    ws.onclose=()=>{ 
      clearInterval(heartbeatInterval);
      // Reconnect after 5s if still logged in
      if(UI.userId)setTimeout(subscribeRealtime,5000);
    };
  }catch(e){
    console.warn('Realtime unavailable, falling back to polling:',e.message);
  }
}

function handleRealtimeUpdate(table,event,newRow,oldRow){
  if(!UI.userId)return;
  const wasRendering=false;
  switch(table){
    case 'jex_companies':
      if(newRow){const idx=DB.companies.findIndex(c=>c.id===newRow.id);if(idx>=0)Object.assign(DB.companies[idx],newRow);else if(event==='INSERT')DB.companies.push(newRow);}
      break;
    case 'jex_trades':
      if(newRow&&!DB.trades.find(t=>t.id===newRow.id))DB.trades.unshift(newRow);
      break;
    case 'jex_announcements':
      if(newRow&&event==='INSERT'){if(!DB.announcements.find(a=>a.id===newRow.id))DB.announcements.unshift(newRow);}
      else if(event==='DELETE'&&oldRow)DB.announcements=DB.announcements.filter(a=>a.id!==oldRow.id);
      break;
    // jex_notifications is no longer subscribed via realtime at all (see
    // subscribeRealtime() -- notifications now arrive via the periodic
    // poll instead, since realtime has no way to scope a per-user table
    // without RLS). This case is unreachable; kept only so an unexpected
    // event for this table fails safe (does nothing) instead of erroring.
    case 'jex_notifications':
      break;
    case 'jex_halts':
      if(event==='INSERT'&&newRow&&!DB.halts.find(h=>h.ticker===newRow.ticker))DB.halts.push(newRow);
      else if(event==='DELETE'&&oldRow)DB.halts=DB.halts.filter(h=>h.ticker!==oldRow.ticker);
      break;
    case 'jex_session':
      if(newRow){
        const wasOpen=DB.session.status==='open';
        Object.assign(DB.session,newRow);
        const isNowOpen=DB.session.status==='open';
        const isNowClosed=DB.session.status==='closed';
        if(!wasOpen&&isNowOpen){
          // Session just opened for this user
          activateAfterHoursOrders();
          recordSessionOpenPrices();
          toast('🟢 Trading session is now open!');
        } else if(wasOpen&&isNowClosed){
          toast('🔴 Trading session has closed.');
          // Expire day orders locally
          DB.limitOrders.filter(o=>o.status==='open'&&o.order_type==='day').forEach(o=>o.status='expired');
        }
      }
      break;
    case 'jex_limit_orders':
      if(newRow){const idx=DB.limitOrders.findIndex(o=>o.id===newRow.id);if(idx>=0)Object.assign(DB.limitOrders[idx],newRow);else if(event==='INSERT')DB.limitOrders.push(newRow);}
      break;
    case 'jex_news':
      if(newRow&&event==='INSERT'&&!DB.news.find(n=>n.id===newRow.id))DB.news.unshift(newRow);
      else if(event==='DELETE'&&oldRow)DB.news=DB.news.filter(n=>n.id!==oldRow.id);
      break;
    case 'jex_votes':
      if(newRow){const idx=DB.votes.findIndex(v=>v.id===newRow.id);if(idx>=0)Object.assign(DB.votes[idx],newRow);else if(event==='INSERT')DB.votes.unshift(newRow);}
      break;
  }
  // Debounced re-render
  if(!userIsFillingForm()){
    clearTimeout(window._rtRenderTimer);
    window._rtRenderTimer=setTimeout(()=>render(),150);
  }
}
let _lastActivity=Date.now();
const INACTIVITY_TIMEOUT=30*60*1000; // 30 minutes
function resetActivityTimer(){_lastActivity=Date.now();}
function checkInactivity(){
  if(!UI.userId)return;
  if(Date.now()-_lastActivity>INACTIVITY_TIMEOUT){
    toast('Logged out due to inactivity');
    logout();
  }
}
setInterval(checkInactivity,60000); // check every minute
document.addEventListener('mousemove',resetActivityTimer,{passive:true});
document.addEventListener('keydown',resetActivityTimer,{passive:true});
document.addEventListener('touchstart',resetActivityTimer,{passive:true});
let UI={userId:null,navTab:'market',adminTab:'registrations',appTab:'status',companyTab:'stock',portfolioTab:'holdings',loginView:'select',loginTab:'student',loginUsername:'',loginError:null,forgotUserId:null,forgotAnswer:null,panelTicker:null,panelMode:'buy',companyPage:null,companyPageTab:'overview',tradePage:0,activityFilter:{type:'',ticker:'',user:''},classroomFilter:null,lbClassroom:null,
  regVerify:{reg:{status:'idle',email:'',resendAt:0},'reg-co':{status:'idle',email:'',resendAt:0}},fundPage:null,googleAuth:null};
let charts={},sessionTimer=null;
// Pages that have been split out into their own real HTML file (see the
// "split into real separate pages" plan) -- everything else still lives as
// an in-app UI.navTab switch rendered by getPageContent(). renderNav()
// links a routed page with a real <a href>; every other tab stays an
// onclick="setTab(...)" button. Grows one entry at a time as pages convert.
const PAGE_ROUTES=new Set(['settings','admin','exchange','leaderboard','trades','mystock','news','notifications','funds','orders','portfolio','market']);
// market has no market.html -- index.html IS the market page (old root
// bookmarks/links keep working), so its route target is the root file.
const pageHref=k=>k==='market'?'index.html':k+'.html';

async function loadAll(){
  // ── Phase 1: critical data needed to render login ──────
  const [users,session,companies,announcements,halts]=await Promise.all([
    sb.get('jex_users','order=created_at.asc&select='+JEX_USERS_SAFE_SELECT),
    sb.get('jex_session','id=eq.1'),
    sb.get('jex_companies','order=created_at.asc'),
    sb.get('jex_announcements','order=created_at.desc'),
    sb.get('jex_halts','order=created_at.asc'),
  ]);
  // Apply phase 1 immediately so login renders fast
  DB.users=users;
  DB.session=session[0]||DB.session;
  DB.companies=companies;
  DB.announcements=announcements;
  DB.halts=halts;
  SHEETS_URL=DB.session.sheets_url||null;
  if(DB.session.ends_at&&DB.session.status==='open'&&!sessionTimer)sessionTimer=setInterval(tickTimer,500);
  render(); // render login screen immediately with phase 1 data

  // ── Phase 2: everything else in parallel ───────────────
  const [pending,news,ipoApps,dilApps,trades,dividends,buybacks,limitOrders,
    activity,shareClasses,classApps,votes,ballots,notifications,
    priceAlerts,nwHistory,companyMembers,founderAllocations,
    priceAdjustments,flags,classrooms,stopLossOrders,minutes,divApprovals,bugReports,funds,contactMessages,indexHistory,snapshots,clientErrors]=await Promise.all([
    sb.get('jex_pending','order=created_at.asc&select='+JEX_PENDING_SAFE_SELECT),
    sb.get('jex_news','order=created_at.desc&limit=50'),
    sb.get('jex_ipo_applications','order=created_at.asc'),
    sb.get('jex_dilution_applications','order=created_at.asc'),
    sb.get('jex_trades','order=created_at.desc&limit=200&select=id,ticker,qty,price,buyer_id,seller_id,type,ts'),  // only last 200 trades
    sb.get('jex_dividends','order=created_at.asc'),
    sb.get('jex_buybacks','order=created_at.asc'),
    sb.get('jex_limit_orders','order=created_at.asc'),
    // jex_activity SELECT is revoked entirely now (see the
    // activity-log-privacy-fix migration) -- table-wide SELECT was wide
    // open with no role check, leaking the same flag-reason/bug-report/
    // price-adjustment content already locked down for jex_notifications/
    // jex_flags to every user's browser memory regardless of role.
    safeRpc('rpc_admin_list_activity',{p_limit:100}).then(r=>r||[]),
    sb.get('jex_share_classes','order=created_at.asc'),
    sb.get('jex_class_applications','order=created_at.asc'),
    sb.get('jex_votes','order=created_at.desc'),
    sb.get('jex_vote_ballots','order=created_at.asc'),
    // jex_notifications SELECT is revoked entirely now (see the
    // notification-privacy-fix migration) -- table-wide SELECT was
    // wide open, no user_id filter enforced server-side, leaking every
    // user's notification content (flag/bug-report/contact-admin
    // summaries, price alert targets, trading activity) to anyone.
    // safeRpc resolves to null pre-login, turned into [] below.
    safeRpc('rpc_get_my_notifications',{p_limit:50}).then(r=>r||[]),
    sb.get('jex_price_alerts','order=created_at.asc'),
    sb.get('jex_nw_history','order=created_at.desc&limit=200'),
    sb.get('jex_company_members','order=created_at.asc'),
    sb.get('jex_founder_allocations','order=created_at.desc'),
    sb.get('jex_price_adjustments','order=created_at.desc&limit=50'),
    // jex_flags/jex_bug_reports/jex_contact_messages: table-level SELECT is
    // revoked for anon/authenticated entirely now (see the
    // email-pii-exposure-fix migration) -- these three RPCs are the only
    // way to read them, and only resolve to real data for the admin roles
    // each one actually gates on. Any other caller gets a permission error
    // here, which safeRpc quietly turns into an empty array -- exactly the
    // "nothing to show" state those users should see anyway.
    safeRpc('rpc_admin_list_flags').then(r=>r||[]),
    sb.get('jex_classrooms','order=created_at.asc'),
    sb.get('jex_stop_loss','status=eq.active&order=created_at.asc'),
    sb.get('jex_minutes','order=created_at.desc&limit=50'),
    sb.get('jex_dividend_approvals','order=created_at.desc&limit=100'),
    safeRpc('rpc_admin_list_bug_reports').then(r=>r||[]),
    sb.get('jex_funds','order=created_at.asc'),
    safeRpc('rpc_admin_list_contact_messages').then(r=>r||[]),
    sb.get('jex_index_history','order=created_at.asc&limit=500'),
    sb.get('jex_snapshots','order=created_at.desc&limit=50'),
    // Same pattern as flags/bug_reports/contact_messages -- admin-only
    // (see the client-error-logging migration).
    safeRpc('rpc_admin_list_client_errors',{p_limit:100}).then(r=>r||[]),
  ]);
  Object.assign(DB,{pending,news,ipoApps,dilApps,
    trades,dividends,buybacks,limitOrders,activity,
    shareClasses,classApps,votes,ballots,notifications,
    priceAlerts,nwHistory,companyMembers,founderAllocations,
    priceAdjustments,flags,minutes,divApprovals,stopLossOrders,classrooms,bugReports,funds,contactMessages,indexHistory,snapshots,clientErrors});
  // Chairman/President/Treasurer/Compliance Officer only (see
  // rpc_admin_get_all_emails): merges real email addresses into the
  // already-loaded (email-less) DB.users/DB.pending rows. safeRpc resolves
  // to null for every other role, in which case nothing is merged and
  // those rows simply have no .email, matching what non-admin UI ever
  // reads from them.
  const emailMap=await safeRpc('rpc_admin_get_all_emails');
  if(emailMap){
    const uMap=new Map(emailMap.users.map(e=>[e.id,e.email]));
    const pMap=new Map(emailMap.pending.map(e=>[e.id,e.email]));
    DB.users.forEach(u=>{if(uMap.has(u.id))u.email=uMap.get(u.id);});
    DB.pending.forEach(p=>{if(pMap.has(p.id))p.email=pMap.get(p.id);});
  }
  // The bulk fetch above just overwrote DB.users wholesale, including
  // whatever richer row (with email) a just-completed login/Google-match
  // RPC had merged in for the CURRENT user before calling loadAll() --
  // finishLogin() sets UI.userId before this runs, so it's already known
  // here. Re-merges it back in rather than leaving self email blank until
  // the next full page reload.
  if(UI.userId){
    const info=await safeRpc('rpc_get_own_contact_info');
    if(info){
      const self=DB.users.find(u=>u.id===UI.userId);
      if(self){self.email=info.email;self.notification_email=info.notification_email;}
    }
  }
  render(); // re-render with full data
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
const get=id=>document.getElementById(id);
function togglePw(id){const el=get(id);if(!el)return;el.type=el.type==='password'?'text':'password';const btn=el.parentElement?.querySelector('.pw-eye');if(btn)btn.textContent=el.type==='password'?'👁':'🙈';}
const fmt=n=>'$'+Number(n).toFixed(2);
const fmtChg=n=>(n>=0?'+':'')+Number(n).toFixed(2)+'%';
const norm=s=>(s||'').trim().toLowerCase();
const validEmail=e=>e&&e.includes('@')&&e.includes('.');
const normalizeUsername=v=>{v=(v||'').trim();if(v.startsWith('@'))v=v.slice(1);return v;};
const validUsername=v=>/^[a-zA-Z0-9_.]{3,20}$/.test(v);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const infoBubble=text=>'<span class="info-bubble" tabindex="0">?<span class="info-tip">'+esc(text)+'</span></span>';
// Info-tip tooltips are centered under their icon by default (see app.css),
// which clips off-screen when the icon sits close to the viewport's left or
// right edge -- exactly what happened with the NAV/unit bubble on the funds
// page. Nudges the tooltip back on-screen with an inline transform at the
// moment it's shown, rather than trying to guess a safe position per icon.
function clampInfoTip(bubble){
  const tip=bubble.querySelector('.info-tip');
  if(!tip)return;
  tip.style.transform='translateX(-50%)';
  const r=tip.getBoundingClientRect();
  const margin=8;
  let shift=0;
  if(r.left<margin)shift=margin-r.left;
  else if(r.right>window.innerWidth-margin)shift=(window.innerWidth-margin)-r.right;
  if(shift)tip.style.transform='translateX(calc(-50% + '+Math.round(shift)+'px))';
}
document.addEventListener('mouseover',e=>{const b=e.target.closest&&e.target.closest('.info-bubble');if(b)clampInfoTip(b);});
document.addEventListener('focusin',e=>{const b=e.target.closest&&e.target.closest('.info-bubble');if(b)clampInfoTip(b);});
const cu=()=>DB.users.find(u=>u.id===UI.userId)||null;
const getUser=id=>DB.users.find(u=>u.id===id);
const getCo=t=>DB.companies.find(c=>c.ticker===t);
// ── CSV Export ────────────────────────────────────────────
function exportCSV(filename,rows,headers){
  const escape=v=>{
    if(v==null)return'';
    const s=String(v).replace(/\n/g,' ');
    return s.includes(',')||s.includes('"')?'"'+s.replace(/"/g,'""')+'"':s;
  };
  const lines=[headers.map(escape).join(','),...rows.map(r=>headers.map(h=>escape(r[h]||r[headers.indexOf(h)])).join(','))];
  const blob=new Blob([lines.join('\n')],{type:'text/csv'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();
}
function exportTableCSV(table){
  const now=new Date().toISOString().slice(0,10);
  switch(table){
    case 'trades':
      exportCSV('jex-trades-'+now+'.csv',DB.trades,['ts','ticker','qty','price','buyer_id','seller_id','type']);
      break;
    case 'dividends':
      exportCSV('jex-dividends-'+now+'.csv',DB.dividends.map(d=>({ts:d.ts,company:d.company_name,ticker:d.ticker,per_share:d.per_share,total:d.total,recipients:(d.payouts||[]).length,note:d.note})),['ts','company','ticker','per_share','total','recipients','note']);
      break;
    case 'activity':
      exportCSV('jex-activity-'+now+'.csv',DB.activity,['ts','type','description','amount']);
      break;
    case 'balances':{
      const rows=DB.users.filter(u=>u.role==='student'&&u.status==='approved').map(u=>({name:u.name,email:u.email,cash:u.cash,portfolio:pv(u),net_worth:nw(u),dividends:divRec(u)}));
      exportCSV('jex-balances-'+now+'.csv',rows,['name','email','cash','portfolio','net_worth','dividends']);
      break;}
    case 'votes':
      exportCSV('jex-votes-'+now+'.csv',DB.votes.map(v=>({ts:v.ts,ticker:v.parent_ticker,question:v.question,option1:v.option1,option2:v.option2,status:v.status,ballots:DB.ballots.filter(b=>b.vote_id===v.id).length})),['ts','ticker','question','option1','option2','status','ballots']);
      break;
    case 'orders':
      exportCSV('jex-orders-'+now+'.csv',DB.limitOrders,['ts','ticker','side','qty','limit_price','status','order_type','filled_price','filled_at']);
      break;
    case 'holdings':{
      const rows2=[];
      DB.users.filter(u=>u.role==='student'&&u.status==='approved').forEach(u=>{
        Object.entries(u.holdings||{}).forEach(([ticker,qty])=>{
          const co=getCo(ticker);rows2.push({student:u.name,ticker,qty,price:co?co.price:0,value:co?qty*co.price:0});
        });
      });
      exportCSV('jex-holdings-'+now+'.csv',rows2,['student','ticker','qty','price','value']);
      break;}
    default:toast('Unknown table: '+table);
  }
  toast('Exported '+table+'.csv');
}
function copyTicker(ticker){
  navigator.clipboard?.writeText(ticker).then(()=>toast('Copied: '+ticker)).catch(()=>toast(ticker+' (copy manually)'));
}
const uid=()=>'id_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
const ts=()=>new Date().toLocaleTimeString();
const isoNow=()=>new Date().toISOString();

// Daily (since this session opened) is the default %-change everywhere --
// every ticker's headline number should mean "today," the same way a real
// stock's or index's does, not "since I first started covering it." Falls
// back to since-listing (the original behavior) until this ticker's first
// session-open capture happens (a brand new IPO mid-session, or before any
// session has ever opened on a fresh exchange).
const priceChg=c=>{
  const openPrice=DB.session.session_open_prices&&DB.session.session_open_prices[c.ticker];
  if(openPrice>0)return(c.price-openPrice)/openPrice*100;
  if(!c.price_history||c.price_history.length<2)return 0;
  const f=c.price_history[0].p,l=c.price_history[c.price_history.length-1].p;
  return f?((l-f)/f*100):0;
};
function computeJXI(){
  // JXI itself is now a real, tradeable ticker in DB.companies (see
  // is_index_fund) -- it must never appear in its own basket, or its price
  // would track a moving average that includes itself.
  const listed=DB.companies.filter(c=>c.status==='listed'&&!getClassMeta(c.ticker)&&!c.is_index_fund);
  if(!listed.length)return{value:1000,change:0,constituents:[]};
  const constituents=listed.map(c=>{
    const base=(c.price_history&&c.price_history[0]&&c.price_history[0].p)||c.price;
    const ratio=base>0?c.price/base:1;
    return{ticker:c.ticker,name:c.name,price:c.price,ratio};
  });
  const avgRatio=constituents.reduce((s,x)=>s+x.ratio,0)/constituents.length;
  const value=Math.round(avgRatio*1000*100)/100;
  const change=Math.round(((avgRatio-1)*100)*100)/100;
  return{value,change,constituents};
}
async function snapshotJXI(){
  const idx=computeJXI();
  if(!idx.constituents.length)return;
  // Runs server-side (rpc_snapshot_jxi), which recomputes the index value
  // itself from real company prices -- a raw POST here used to let
  // anyone insert an arbitrary fabricated value, distorting the market-
  // index chart shown on the market page to every user.
  try{
    const rec=await sb.rpc('rpc_snapshot_jxi',{});
    if(rec){
      DB.indexHistory.push(rec);
      // rpc_snapshot_jxi also updates JXI's own jex_companies row
      // server-side (price + price_history), but doesn't return it -- and
      // that row is what the headline badge/chart actually read (see
      // renderIndexCard()). Without this, the caller's own view of the
      // JXI card lags every trade/limit-fill in the system until the next
      // poll/reload, even though the underlying data was already updated.
      const jxiCo=getCo('JXI');
      if(jxiCo&&rec.value!=null){
        const etfPrice=Math.round(rec.value/10*100)/100;
        jxiCo.price=etfPrice;
        jxiCo.price_history=[...(jxiCo.price_history||[]),{p:etfPrice,t:rec.ts||new Date().toISOString()}];
      }
    }
  }catch(e){console.warn('JXI snapshot failed:',e);}
}
const holdings=u=>u.holdings||{};const shorts=u=>u.shorts||{};const watchlist=u=>u.watchlist||[];
const pv=u=>Object.entries(holdings(u)).reduce((s,[t,q])=>{const c=getCo(t);return s+(c?c.price*q:0);},0);
const sPnl=u=>Object.entries(shorts(u)).reduce((s,[t,pos])=>{const c=getCo(t);if(!c)return s;return s+Math.round((pos.avgPrice-c.price)*pos.qty*100)/100;},0);
const divRec=u=>DB.dividends.reduce((s,d)=>{const p=(d.payouts||[]).find(x=>x.userId===u.id);return s+(p?p.payout:0);},0);
const nw=u=>Math.round((u.cash+pv(u)+sPnl(u))*100)/100;
const isAdmin=u=>(['chairman','president','secretary','treasurer','compliance_officer'].includes(u?.role));
const isChairman=u=>u?.role==='chairman'||u?.role==='president';
const isPresident=u=>u?.role==='president';
const isSecTre=u=>(u?.role==='secretary'||u?.role==='treasurer');
const isOpen=()=>DB.session.status==='open';
const isPractice=()=>!!DB.session.practice_mode;
// ── Client-side rate limiting ────────────────────────────
const _orderTimestamps={};
const _lastOrderTime={};
const MIN_ORDER_GAP_MS=800; // min 0.8s between any two orders
function checkRateLimit(userId){
  const limit=DB.session.order_rate_limit||10;
  const now=Date.now();
  // Layer 1: minimum gap between consecutive orders (stops button mashing)
  const last=_lastOrderTime[userId]||0;
  if(now-last<MIN_ORDER_GAP_MS){
    toast('⏳ Wait a moment between orders');
    return false;
  }
  // Layer 2: burst check — max 3 in 5 seconds
  if(!_orderTimestamps[userId])_orderTimestamps[userId]=[];
  _orderTimestamps[userId]=_orderTimestamps[userId].filter(t=>now-t<60000);
  const burst=_orderTimestamps[userId].filter(t=>now-t<5000);
  if(burst.length>=3){
    toast('⚠️ Too many orders too fast — wait a few seconds');
    return false;
  }
  // Layer 3: per-minute cap
  if(_orderTimestamps[userId].length>=limit){
    const waitSec=Math.ceil((60000-(now-_orderTimestamps[userId][0]))/1000);
    toast('🚫 Max '+limit+' orders/min — wait '+waitSec+'s');
    return false;
  }
  _lastOrderTime[userId]=now;
  _orderTimestamps[userId].push(now);
  return true;
}
function disableTradeBtn(btn,ms=1500){
  if(!btn)return;
  btn.disabled=true;btn.style.opacity='0.5';
  setTimeout(()=>{btn.disabled=false;btn.style.opacity='';},ms);
}
const requireOpen=(ticker=null)=>{
  if(!isOpen()){toast('Trading is '+DB.session.status+'. Wait for the session to open.');return false;}
  if(ticker&&isHalted(ticker)){toast(ticker+' trading is currently halted.');return false;}
  return true;
};
function checkPriceBand(ticker,orderPrice){
  const bandPct=DB.session.price_band_pct||30;
  const openPrices=DB.session.session_open_prices||{};
  const openPrice=openPrices[ticker];
  if(!openPrice)return true; // no band if no session-open price recorded
  const upperBand=Math.round(openPrice*(1+bandPct/100)*100)/100;
  const lowerBand=Math.round(openPrice*(1-bandPct/100)*100)/100;
  if(orderPrice>upperBand||orderPrice<lowerBand){
    toast('Order rejected — outside price band. Allowed range: '+fmt(lowerBand)+' – '+fmt(upperBand)+' (±'+bandPct+'% from session open '+fmt(openPrice)+')');
    return false;
  }
  return true;
}
function getPreMarketPrice(ticker){
  // Estimate price from queued after-hours orders
  const ahOrders=DB.limitOrders.filter(o=>o.status==='after_hours'&&o.ticker===ticker);
  if(!ahOrders.length)return null;
  const buys=ahOrders.filter(o=>o.side==='buy').sort((a,b)=>b.limit_price-a.limit_price);
  const sells=ahOrders.filter(o=>o.side==='sell').sort((a,b)=>a.limit_price-b.limit_price);
  const bestBid=buys[0]?.limit_price||null;
  const bestAsk=sells[0]?.limit_price||null;
  if(bestBid&&bestAsk&&bestBid>=bestAsk)return Math.round((bestBid+bestAsk)/2*100)/100;
  if(bestBid&&bestAsk)return Math.round((bestBid+bestAsk)/2*100)/100;
  return bestBid||bestAsk||null;
}
const shareholders=ticker=>DB.users.filter(u=>u.role==='student'&&(holdings(u)[ticker]||0)>0);
const divTotal=(ticker,ps)=>shareholders(ticker).reduce((s,u)=>s+Math.round(((holdings(u)[ticker])||0)*ps*100)/100,0);
const impactPrice=(co,qty,dir)=>{const liq=co.shares*0.05,impact=Math.min((qty/liq)*0.015,0.12);return Math.max(0.01,Math.round((dir==='buy'?co.price*(1+impact):co.price*(1-impact))*100)/100);};
const isWatched=ticker=>{const u=cu();return u&&watchlist(u).includes(ticker);};
const sharesBar=co=>{
  // JXI mints/redeems on demand -- shares_avail always equals shares (see
  // rpc_trade_buy/sell's is_index_fund branch), so the usual "available out
  // of a fixed float" bar would always read a meaningless "100% available"
  // and imply a supply that can run out, which it can't.
  if(co.is_index_fund)return `<div class="sbar-wrap"><div style="font-size:12px;font-weight:500;font-family:var(--mono)">${co.shares.toLocaleString()}</div><div style="font-size:11px;color:var(--text3);margin-top:1px">units outstanding</div></div>`;
  const pct=co.shares>0?Math.round((co.shares_avail/co.shares)*100):0;return `<div class="sbar-wrap"><div style="font-size:12px;font-weight:500;font-family:var(--mono)">${co.shares_avail.toLocaleString()} <span style="font-weight:400;color:var(--text2)">/ ${co.shares.toLocaleString()}</span></div><div style="font-size:11px;color:var(--text3);margin-top:1px">${pct}% available</div><div class="sbar-bg"><div class="sbar-fill" style="width:${pct}%"></div></div></div>`;};
const roleBadge=role=>role==='chairman'?'<span class="badge b-chair">Chairman</span>':role==='president'?'<span class="badge b-pres">President</span>':role==='secretary'?'<span class="badge b-sec">Secretary</span>':role==='treasurer'?'<span class="badge b-tre">Treasurer</span>':role==='compliance_officer'?'<span class="badge b-co">Compliance</span>':role==='student'?'<span class="badge b-blue">Student</span>':role==='company'?'<span class="badge b-amber">Company</span>':'';
const avatarClass=role=>role==='chairman'?'av-ch':role==='president'?'av-pr':role==='secretary'?'av-sec':role==='treasurer'?'av-tre':role==='compliance_officer'?'av-co':role==='company'?'av-c':'av-s';

function toast(msg){const t=get('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3200);}
function destroyCharts(){Object.keys(charts).forEach(k=>destroyChart(k));charts={};}

// ═══════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════
const pad=n=>n<10?'0'+n:String(n);
function getAZTime(){return new Date(new Date().toLocaleString('en-US',{timeZone:'America/Phoenix'}));}
// True once the calendar day (Arizona time, same timezone the scheduler
// already standardizes on) has rolled over since session_open_prices was
// last captured -- lets the daily %-change baseline reset every day like a
// real market's open, even when the exchange itself is left continuously
// "open" across multiple days instead of being closed and reopened each one.
function isNewTradingDay(){
  if(!DB.session.session_started_at)return false;
  const lastAz=new Date(new Date(DB.session.session_started_at).toLocaleString('en-US',{timeZone:'America/Phoenix'}));
  return lastAz.toDateString()!==getAZTime().toDateString();
}
function fmtAZTime(d){return d.toLocaleString('en-US',{timeZone:'America/Phoenix',weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true})+' MST';}
// Runs server-side (rpc_admin_save_session) -- saveSession() itself had no
// auth check at all, and neither did most of its callers (saveBudgetThreshold,
// saveDivThreshold, savePriceBand, saveCBPct, saveEmailJSConfig, startTimer,
// scheduleSession, clearSchedule, saveWeeklySchedule -- not even client-side).
// The RPC requires Chairman/President, matching setSession's existing check
// (the only caller that already had one) and the fact that the entire Session
// admin tab these all live in is only ever rendered for those two roles.
async function saveSession(data){
  let r;
  try{r=await sb.rpc('rpc_admin_save_session',{p_data:data});}
  catch(e){toast(rpcErrorMessage(e));throw e;}
  Object.assign(DB.session,r.session);
}
function adjStockForm(){
  adjustStockPrice(
    document.getElementById('adj-ticker')?.value,
    document.getElementById('adj-pct')?.value,
    document.getElementById('adj-reason')?.value
  );
}
async function saveBudgetThreshold(){await saveBudgetThresholdFrom('bw-threshold');}
async function saveBudgetThresholdFrom(id='bw-threshold'){
  const val=parseFloat(document.getElementById(id)?.value);
  if(isNaN(val)||val<0)return toast('Enter a valid amount');
  await saveSession({budget_warning_threshold:val});
  toast('Warning threshold set to '+fmt(val));render();
}
async function saveDivThreshold(){await saveDivThresholdFrom('div-threshold');}
async function saveDivThresholdFrom(id='div-threshold'){
  const val=parseFloat(document.getElementById(id)?.value);
  if(isNaN(val)||val<0)return toast('Enter a valid amount');
  await saveSession({dividend_approval_threshold:val});
  toast('Dividend approval threshold set to '+fmt(val));render();
}
async function reviewDivApproval(id,approve){
  const da=DB.divApprovals.find(x=>x.id===id);if(!da)return;
  const u=cu();
  if(!approve){
    // Rejecting doesn't move money, but runs server-side now too
    // (rpc_reject_dividend_approval) -- this had NO check at all before.
    let r;
    try{r=await sb.rpc('rpc_reject_dividend_approval',{p_id:id});}
    catch(e){return toast(rpcErrorMessage(e));}
    if(!r.rejected)return toast('This request was already reviewed');
    da.status='rejected';da.approved_by=u.name;
    await pushNotification(da.requested_by,'div_approval','❌ Your dividend request for '+da.company_name+' was rejected by the Treasurer.',da.ticker);
    toast('Dividend rejected');render();return;
  }
  // Approving DOES move money -- rpc_pay_dividend does its own atomic claim
  // (SELECT ... FOR UPDATE, re-checks status='pending') and requires the
  // caller to actually be a Treasurer, closing the same "any authenticated
  // caller could call issueDividend(...,preApproved=true) directly" gap
  // this whole pass is about.
  let r;
  try{r=await sb.rpc('rpc_pay_dividend',{p_ticker:da.ticker,p_per_share:da.per_share,p_note:da.note||'Treasurer-approved dividend',p_approval_id:id});}
  catch(e){return toast(rpcErrorMessage(e));}
  da.status='approved';da.approved_by=u.name;
  if(r.owner_id){const o=getUser(r.owner_id);if(o)o.cash=r.owner_cash;}
  const jxiPayoutsA=(r.jxi_pass_through||[]).flatMap(f=>f.payouts);
  await refreshDividendPayoutBalances([...(r.payouts||[]),...jxiPayoutsA]);
  if(r.dividend_id)DB.dividends.push({id:r.dividend_id,ticker:da.ticker,company_name:da.company_name,per_share:da.per_share,total:r.total,note:da.note||'Treasurer-approved dividend',payouts:r.payouts,jxi_pass_through:r.jxi_pass_through||[],ts:ts()});
  await logActivity('dividend',da.company_name+' paid dividend '+fmt(da.per_share)+'/share — total '+fmt(r.total),{ticker:da.ticker,userId:r.owner_id,userName:u.name,amount:r.total});
  await pushNotificationToHolders(da.ticker,'dividend','💰 '+da.company_name+' paid a dividend of '+fmt(da.per_share)+'/share');
  pushBalances();
  toast(da.company_name+' paid '+fmt(da.per_share)+'/share (Treasurer-approved)');
  render();
}
async function togglePracticeMode(){
  if(!isAdmin(cu()))return toast('Admin access required');
  const now=!DB.session.practice_mode;
  if(now){
    if(!confirm('Start practice mode? An automatic snapshot will be saved so the exchange can be restored exactly to this state when practice mode ends.'))return;
    const snapId=await doSaveSnapshot('Auto-snapshot before practice mode');
    await saveSession({practice_mode:now,practice_snapshot_id:snapId});
  } else {
    if(!confirm('End practice mode? The exchange will be automatically restored to its state from just before practice mode started, undoing all practice trades.'))return;
    const snapId=DB.session.practice_snapshot_id;
    await saveSession({practice_mode:now,practice_snapshot_id:null});
    if(snapId)await doRestoreSnapshot(snapId);
  }
  await pushNotificationToAll('session',now?'🎮 Practice mode started — trades do not count toward rankings.':'✅ Practice mode ended — real trading resumes.');
  toast(now?'Practice mode ON':'Practice mode OFF');render();
}

async function savePriceBand(){
  const pct=parseInt(document.getElementById('band-pct')?.value);
  if(isNaN(pct)||pct<1||pct>100)return toast('Enter a value between 1 and 100');
  await saveSession({price_band_pct:pct});
  toast('Price band set to ±'+pct+'%');render();
}
async function saveEmailJSConfig(){
  const serviceId=(get('ejs-service')?.value||'').trim();
  const templateId=(get('ejs-template')?.value||'').trim();
  const pubKey=(get('ejs-pubkey')?.value||'').trim();
  const siteUrl=(get('ejs-siteurl')?.value||'').trim();
  await saveSession({emailjs_service_id:serviceId||null,emailjs_template_id:templateId||null,emailjs_public_key:pubKey||null,emailjs_site_url:siteUrl||null});
  toast(serviceId?'✓ Email config saved — students can now enable email notifications':'Email config cleared');
  render();
}
// The private key (EmailJS calls it "Access Token") never round-trips back
// to any client after this -- rpc_admin_save_email_secret only ever tells
// the caller back whether one is set (jex_session.emailjs_secret_configured),
// never the value itself. Needed because sending now happens server-side
// (rpc_push_notification via pg_net), which EmailJS requires the private
// key for since there's no browser Origin header to satisfy its default
// same-origin check.
async function saveEmailJSSecret(){
  const token=(get('ejs-secret')?.value||'').trim();
  try{await sb.rpc('rpc_admin_save_email_secret',{p_access_token:token});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.session.emailjs_secret_configured=!!token;
  const el=get('ejs-secret');if(el)el.value='';
  toast(token?'✓ Private key saved':'Private key cleared');
  render();
}
async function saveCBPct(){
  const pct=parseInt(document.getElementById('cb-pct')?.value);
  if(isNaN(pct)||pct<1||pct>100)return toast('Enter a value between 1 and 100');
  await saveSession({circuit_breaker_pct:pct});
  toast('Circuit breaker set to '+pct+'%');render();
}
// ═══════════════════════════════════════════════
// SNAPSHOT / RESTORE
// ═══════════════════════════════════════════════
async function saveSnapshot(label){
  if(!isAdmin(cu()))return toast('Admin access required');
  if(!label||label.trim().length<2)return toast('Enter a snapshot name');
  await doSaveSnapshot(label.trim());
  toast('✓ Snapshot saved: '+label.trim());render();
}
async function doSaveSnapshot(label){
  // The snapshot's contents (users/companies/session state) are built
  // entirely server-side from the RPC's own reads -- the client only
  // supplies the label. This closes the forgery path where a client could
  // previously POST an arbitrary data payload (see jex_snapshots table).
  let row;
  try{row=await sb.rpc('rpc_admin_save_snapshot',{p_label:label});}
  catch(e){toast(rpcErrorMessage(e));return null;}
  DB.snapshots.unshift(row);
  return row.id;
}
async function restoreSnapshot(snapshotId){
  if(!isAdmin(cu()))return toast('Admin access required');
  if(!confirm('Restore this snapshot? All current holdings, prices, and cash will be overwritten.'))return;
  await doRestoreSnapshot(snapshotId);
}
async function doRestoreSnapshot(snapshotId){
  if(!isAdmin(cu()))return toast('Admin access required');
  const snap=DB.snapshots.find(s=>s.id===snapshotId);if(!snap)return toast('Snapshot not found');
  toast('Restoring snapshot...');
  // Restoring cash/holdings/shorts/price/shares_avail runs server-side
  // (rpc_admin_restore_snapshot), reading the snapshot's data from
  // jex_snapshots (RPC-written only) instead of a client-writable row.
  // Clearing active orders and stop-loss, and rolling back any trade made
  // AFTER the snapshot was taken, happens inside the same RPC transaction
  // instead of separate direct client DELETEs -- a true "roll back to this
  // point in time" (this is what actually powers "End practice mode...
  // undoing all practice trades"), not just prices/cash/holdings with stale
  // trade history left behind.
  let r;
  try{r=await sb.rpc('rpc_admin_restore_snapshot',{p_activity_id:snapshotId});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.limitOrders=DB.limitOrders.filter(o=>o.status!=='open'&&o.status!=='after_hours');
  DB.stopLossOrders=[];
  await logActivity('snapshot','Snapshot restored: '+snap.label,{userId:cu()?.id,userName:cu()?.name});
  await loadAll();
  const tradesMsg=r&&r.removed_trades?' ('+r.removed_trades+' trade'+(r.removed_trades!==1?'s':'')+' rolled back)':'';
  toast('✓ Snapshot restored: '+snap.label+tradesMsg);
}
function renderSnapshotTab(){
  const snaps=DB.snapshots;
  return`<div class="card"><div class="section-title">Save snapshot</div>
    <div class="ibox ibox-blue">Saves current prices, holdings, and cash for all users. Restore any snapshot to roll back the exchange state — useful for practice rounds.</div>
    <div class="row" style="align-items:flex-end">
      <div class="frow" style="flex:1"><label class="flabel">Snapshot name</label><input type="text" id="snap-label" placeholder="e.g. Practice round 1 — end of day"></div>
      <div style="padding-bottom:12px"><button class="btn btn-primary" onclick="saveSnapshot(get('snap-label')?.value)">💾 Save snapshot</button></div>
    </div>
  </div>
  ${snaps.length?`<div class="card"><div class="section-title">Saved snapshots (${snaps.length})</div>
    <table><thead><tr><th>Name</th><th>Created by</th><th>Time</th><th></th></tr></thead>
    <tbody>${snaps.map(s=>`<tr>
      <td style="font-weight:500">${esc(s.label)}</td>
      <td style="color:var(--text2)">${esc(s.created_by)}</td>
      <td style="color:var(--text2)">${s.ts}</td>
      <td><button class="btn btn-sm btn-warning" onclick="restoreSnapshot('${s.id}')">⏪ Restore</button></td>
    </tr>`).join('')}</tbody></table>
  </div>`:''}`;
}
async function generateSessionRecap(u){
  const students=DB.users.filter(s=>s.role==='student'&&s.status==='approved');
  const listed=DB.companies.filter(c=>c.status==='listed');
  // Find biggest mover
  const movers=listed.map(c=>({ticker:c.ticker,name:c.name,chg:priceChg(c)})).sort((a,b)=>Math.abs(b.chg)-Math.abs(a.chg));
  const bigMover=movers[0];
  // Today's trades
  const today=new Date().toLocaleDateString();
  const todayTrades=DB.trades.filter(t=>t.ts&&t.ts.includes(today));
  const totalVol=todayTrades.reduce((s,t)=>s+t.price*t.qty,0);
  const bigTrade=todayTrades.length?todayTrades.reduce((a,b)=>b.price*b.qty>a.price*a.qty?b:a):null;
  // Leaderboard snapshot
  const ranked=students.map(s=>({name:s.name,nw:nw(s)})).sort((a,b)=>b.nw-a.nw);
  // Build recap announcement
  const recapBody=[
    '📊 Session recap — '+new Date().toLocaleDateString(),
    '',
    '🏆 Leaderboard leader: '+( ranked[0]?.name||'—')+' ('+fmt(ranked[0]?.nw||0)+')',
    '📈 Biggest mover: '+(bigMover?bigMover.ticker+' '+(bigMover.chg>=0?'+':'')+bigMover.chg.toFixed(1)+'%':'—'),
    '📋 Total trades: '+todayTrades.length+' ('+fmt(totalVol)+' volume)',
    bigTrade?'💰 Biggest trade: '+bigTrade.qty+'×'+bigTrade.ticker+' @ '+fmt(bigTrade.price)+' ('+fmt(bigTrade.price*bigTrade.qty)+')':'',
    '',
    'Next session: TBD',
  ].filter(Boolean).join('\n');
  const title='Session recap — '+new Date().toLocaleDateString();
  // Runs server-side (rpc_post_session_recap) -- a raw POST to jex_minutes
  // is no longer possible for anyone (see minutes_announcements_forgery_fix_migration.sql).
  let rec;
  try{rec=await sb.rpc('rpc_post_session_recap',{p_title:title,p_body:recapBody});}
  catch(e){console.warn('Session recap post failed:',e);return;}
  DB.minutes=DB.minutes||[];
  DB.minutes.unshift(rec);
}
// ── Classroom management ──────────────────────────────
async function createClassroom(){
  if(!isAdmin(cu()))return toast('Admin access required');
  const name=(document.getElementById('cls-name')?.value||'').trim();
  if(!name)return toast('Enter a classroom name');
  const rec={id:uid(),name,ts:ts()};
  await sb.post('jex_classrooms',rec);
  DB.classrooms.push(rec);
  toast('Classroom "'+name+'" created');render();
}
async function deleteClassroom(id){
  if(!isAdmin(cu()))return toast('Admin access required');
  const affected=DB.users.filter(u=>u.classroom_id===id);
  if(!confirm('Delete this classroom?'+(affected.length?' '+affected.length+' assigned user(s) will become unassigned.':'')))return;
  // Runs server-side (rpc_admin_delete_classroom) -- deletes the classroom
  // and unassigns every affected user in one atomic transaction instead of
  // two separate direct client writes.
  let r;
  try{r=await sb.rpc('rpc_admin_delete_classroom',{p_id:id});}
  catch(e){return toast(rpcErrorMessage(e));}
  affected.forEach(u=>u.classroom_id=null);
  DB.classrooms=DB.classrooms.filter(c=>c.id!==id);
  toast('Classroom deleted'+(r.affected_users?' — '+r.affected_users+' user(s) unassigned':''));render();
}
function getClassroomName(id){
  if(!id)return null;
  const c=DB.classrooms.find(x=>x.id===id);
  return c?c.name:null;
}
async function reassignClassroom(){
  if(!isAdmin(cu()))return toast('Admin access required');
  const rawId=get('reassign-uid')?.value;
  const cid=get('reassign-cid-select')?.value||null;
  if(!rawId)return toast('Select a user or company');
  try{await sb.rpc('rpc_admin_reassign_classroom',{p_user_id:rawId,p_classroom_id:cid});}
  catch(e){return toast(rpcErrorMessage(e));}
  const u=getUser(rawId);if(u)u.classroom_id=cid;
  toast('Reassigned to classroom: '+(cid||'unassigned'));
  render();
}
async function saveSheetsUrl(url){
  url=(url||'').trim();
  // Runs server-side (rpc_admin_save_sheets_url) -- this had NO check at
  // all before, and the URL controls where real student balance/activity
  // data gets synced to.
  try{await sb.rpc('rpc_admin_save_sheets_url',{p_url:url});}
  catch(e){return toast(rpcErrorMessage(e));}
  SHEETS_URL=url||null;
  DB.session.sheets_url=url||null;
  toast(url?'Google Sheets sync URL saved ✓':'Sheets sync URL cleared');
  render();
}
async function pushToSheets(type,payload){
  if(!SHEETS_URL)return;
  try{
    await fetch(SHEETS_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,...payload})});
  }catch(e){console.warn('Sheets sync failed:',e);}
}
async function pushBalances(){
  if(!SHEETS_URL)return;
  const students=DB.users.filter(u=>u.role==='student'&&u.status==='approved');
  // email dropped from this payload -- it's pushed to an unauthenticated
  // third-party Google Apps Script webhook (SHEETS_URL) from whichever
  // student's browser happens to trigger a sync, and bulk DB.users no
  // longer carries email at all for non-admins anyway (see the
  // email-pii-exposure-fix migration). Re-architecting the Sheets
  // integration to fetch email server-side wasn't worth it for a "rank
  // sheet" feature that never needed it in the first place.
  const rows=students.map((u,i)=>({
    rank:i+1,name:u.name,
    cash:Math.round(u.cash*100)/100,
    portfolio:Math.round(pv(u)*100)/100,
    shortPnl:Math.round(sPnl(u)*100)/100,
    divs:Math.round(divRec(u)*100)/100,
    nw:nw(u),vsStart:Math.round((nw(u)-10000)*100)/100
  })).sort((a,b)=>b.nw-a.nw).map((r,i)=>({...r,rank:i+1}));
  await pushToSheets('balances',{rows});
}
let _sessionOpenedAt=null;
async function setSession(status){
  if(!isChairman(cu()))return toast('Only the Chairman or President can control the trading session');
  const label=status==='open'?'Session open':status==='paused'?'Session paused':'Session closed';
  clearInterval(sessionTimer);sessionTimer=null;
  // If the weekly scheduler currently has trading open and the admin manually pauses/closes it,
  // mark an override so the scheduler doesn't immediately reopen it during the same window.
  const overriding=DB.session.weekly_active&&status!=='open';
  await saveSession({status,label,ends_at:null,scheduled_open:null,scheduled_close:null,weekly_active:false,weekly_override:overriding?true:DB.session.weekly_override});
  const u=cu();
  let description='Session '+status+(u?' by '+u.name:'');
  if(status==='closed'&&_sessionOpenedAt){
    const mins=Math.round((Date.now()-_sessionOpenedAt)/60000);
    description+=' — ran for '+mins+' minute'+(mins!==1?'s':'');
    _sessionOpenedAt=null;
  }
  if(status==='open')_sessionOpenedAt=Date.now();
  await logActivity('session',description,{userId:u?.id,userName:u?.name});
  if(status==='open'){
    await pushNotificationToAll('session','🟢 Trading session is now open!');
    // Role-specific officer notifications
    for(const officer of DB.users.filter(x=>['secretary','treasurer','compliance_officer'].includes(x.role))){
      const msgs={
        secretary:'📋 Session opened — post any meeting minutes or official notices now.',
        treasurer:'💰 Session opened — monitor company cash levels and dividend activity.',
        compliance_officer:'🔍 Session opened — watch for unusual trading patterns or price anomalies.'
      };
      await pushNotification(officer.id,'session',msgs[officer.role]||'🟢 Session opened');
    }
    activateAfterHoursOrders();recordSessionOpenPrices();
  }
  if(status==='closed'){
    await pushNotificationToAll('session','🔴 Trading session has closed.');
    for(const officer of DB.users.filter(x=>['secretary','treasurer','compliance_officer'].includes(x.role))){
      const msgs={
        secretary:'📋 Session closed — prepare and post meeting minutes for today\'s session.',
        treasurer:'📊 Session closed — review the cash flow report and check for budget warnings.',
        compliance_officer:'🔍 Session closed — review the activity log for any suspicious patterns.'
      };
      await pushNotification(officer.id,'session',msgs[officer.role]||'🔴 Session closed');
    }
    // Expire day orders
    const dayOrders=DB.limitOrders.filter(o=>o.status==='open'&&o.order_type==='day');
    for(const o of dayOrders){
      await sb.patch('jex_limit_orders','id=eq.'+o.id,{status:'expired'});
      o.status='expired';
      await pushNotification(o.user_id,'limit_fill','📋 Day order expired at session close: '+o.qty+'×'+o.ticker+' @ '+fmt(o.limit_price),o.ticker);
    }
    if(dayOrders.length)toast(dayOrders.length+' day order'+(dayOrders.length!==1?'s':'')+' expired at session close');
    // Freeze leaderboard snapshot
    const students2=DB.users.filter(s=>s.role==='student'&&s.status==='approved');
    const snapshot=students2.map(s=>({name:s.name,nw:nw(s),id:s.id,classroom_id:s.classroom_id,sharpe:calcSharpe(s.id)})).sort((a,b)=>b.nw-a.nw);
    await saveSession({leaderboard_snapshot:snapshot});
    // Freeze leaderboard
    const lbStudents=DB.users.filter(s=>s.role==='student'&&s.status==='approved');
    const lbSnap2=lbStudents.map(s=>({name:s.name,nw:nw(s),id:s.id,classroom_id:s.classroom_id,sharpe:calcSharpe(s.id)})).sort((a,b)=>b.nw-a.nw);
    await saveSession({leaderboard_snapshot:lbSnap2});
    // Auto session recap
    await generateSessionRecap(u);
  }
  render();
}
async function startTimer(mins){clearInterval(sessionTimer);sessionTimer=null;const endsAt=Date.now()+mins*60000;await saveSession({status:'open',label:'Session — '+mins+'min',ends_at:endsAt,scheduled_open:null,scheduled_close:null,weekly_active:false});sessionTimer=setInterval(tickTimer,500);render();}
// Countdown display only -- purely local, no write. The actual "has it
// expired, should it close" decision now belongs entirely to
// rpc_session_tick() (see sessionAutoTick below), so a display that's
// briefly stale for up to one 15s poll is the accepted trade-off for not
// trusting this 500ms client timer to decide anything real anymore.
function tickTimer(){if(!DB.session.ends_at)return;const rem=DB.session.ends_at-Date.now();if(rem<=0)return;const el=get('timer-el');if(el){const m=Math.floor(rem/60000),s=Math.floor((rem%60000)/1000);el.textContent=m+':'+(s<10?'0':'')+s;}const al=get('admin-timer-txt');if(al)al.textContent=Math.max(0,Math.round(rem/1000))+'s';}
async function scheduleSession(){const sh=parseInt(get('sched-start-h')?.value||'8'),sm2=parseInt(get('sched-start-m')?.value||'0'),eh=parseInt(get('sched-end-h')?.value||'15'),em=parseInt(get('sched-end-m')?.value||'0');if([sh,sm2,eh,em].some(isNaN))return toast('Enter valid times');const startMin=sh*60+sm2,endMin=eh*60+em;if(endMin<=startMin)return toast('End time must be after start time');const az=getAZTime(),nowMin=az.getHours()*60+az.getMinutes();if(nowMin>=endMin)return toast('End time has already passed in Arizona time');if(nowMin<startMin){await saveSession({status:'closed',label:'Scheduled: opens '+pad(sh)+':'+pad(sm2)+' – '+pad(eh)+':'+pad(em)+' MST',ends_at:null,scheduled_open:{h:sh,m:sm2},scheduled_close:{h:eh,m:em}});toast('Session scheduled for '+pad(sh)+':'+pad(sm2)+' – '+pad(eh)+':'+pad(em)+' AZ time');}else{const msUntilEnd=(endMin-nowMin)*60*1000-az.getSeconds()*1000;await saveSession({status:'open',label:'Open until '+pad(eh)+':'+pad(em)+' MST',ends_at:Date.now()+msUntilEnd,scheduled_open:null,scheduled_close:{h:eh,m:em}});sessionTimer=setInterval(tickTimer,500);toast('Session open until '+pad(eh)+':'+pad(em)+' AZ time');}render();}
async function clearSchedule(){await saveSession({scheduled_open:null,scheduled_close:null,status:'closed',label:'Session closed',ends_at:null});toast('Schedule cleared');render();}
// ── Weekly recurring schedule (different hours per day of week, repeats every week) ──
const WEEKDAY_KEYS=['sun','mon','tue','wed','thu','fri','sat'];
const WEEKDAY_LABELS={sun:'Sunday',mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday'};
function saveWeeklySchedule(){
  const ws={};
  for(const day of WEEKDAY_KEYS){
    const enabled=!!get('wk-'+day+'-on')?.checked;
    const[oh,om]=(get('wk-'+day+'-open')?.value||'').split(':').map(Number);
    const[ch,cm]=(get('wk-'+day+'-close')?.value||'').split(':').map(Number);
    if(enabled){
      if([oh,om,ch,cm].some(isNaN))return toast(WEEKDAY_LABELS[day]+': enter valid times');
      if(ch*60+cm<=oh*60+om)return toast(WEEKDAY_LABELS[day]+': close time must be after open time');
    }
    ws[day]={enabled,open:{h:isNaN(oh)?16:oh,m:isNaN(om)?0:om},close:{h:isNaN(ch)?18:ch,m:isNaN(cm)?30:cm}};
  }
  saveSession({weekly_schedule:ws}).then(()=>{toast('Weekly schedule saved');render();});
}
// Replaces checkSchedule()/checkWeeklySchedule() -- every connected
// client still polls every 15s, but the actual decision (is a timer
// expired, has a one-time or weekly window opened/closed) is now made
// entirely server-side by rpc_session_tick(), which re-derives it from
// jex_session's own stored fields and the real server clock rather than
// trusting each client's local Date.now()/timezone math. This function
// just applies whatever the server decided.
async function sessionAutoTick(){
  if(!UI.userId)return;
  const wasOpen=DB.session.status==='open';
  let r;
  try{r=await sb.rpc('rpc_session_tick',{});}catch(e){return;}
  if(r.changed){
    Object.assign(DB.session,r.session);
    const nowOpen=DB.session.status==='open';
    if(nowOpen&&!wasOpen){
      sessionTimer=setInterval(tickTimer,500);
      toast(DB.session.label.includes('weekly')?'🟢 Trading session opened (weekly schedule)':'Trading session is now open!');
      // The scheduler opening the market is just as much "today's open" as a
      // manual Chairman/President click -- without this, a classroom that
      // only ever uses the weekly auto-schedule (never a manual open/close)
      // would never capture a daily %-change baseline through this path at
      // all, leaving every stock's "today" % stuck showing since-listing.
      recordSessionOpenPrices();
    } else if(!nowOpen&&wasOpen){
      clearInterval(sessionTimer);sessionTimer=null;
      toast(DB.session.label&&DB.session.label.includes('weekly')?'🔴 Trading session closed (weekly schedule)':'Session ended.');
    }
    render();
    return;
  }
  // Real market %-change resets every trading day -- do the same here even
  // when the exchange is left continuously open across midnight instead of
  // being closed and reopened each day.
  if(DB.session.status==='open'&&isNewTradingDay())await recordSessionOpenPrices();
  // Catch manual Chairman/President actions -- opening/closing/pausing the
  // market, adjusting a stock's price, halting/resuming trading -- that
  // rpc_session_tick() above doesn't cover (it only decides SCHEDULER-driven
  // transitions). Piggybacks on this same 15s timer rather than a new one;
  // only 3 small tables, so it stays cheap at this cadence, and gets every
  // other connected client's screen "automatically" refreshed within 15s
  // regardless of whether Realtime's WebSocket push is also working.
  try{
    const [freshSession,freshCompanies,freshHalts]=await Promise.all([
      sb.get('jex_session','id=eq.1'),
      sb.get('jex_companies','order=created_at.asc'),
      sb.get('jex_halts','order=created_at.asc'),
    ]);
    const nowOpen=freshSession[0]&&freshSession[0].status==='open';
    if(freshSession[0])Object.assign(DB.session,freshSession[0]);
    DB.companies=freshCompanies;
    DB.halts=freshHalts;
    if(DB.session.ends_at&&DB.session.status==='open'&&!sessionTimer)sessionTimer=setInterval(tickTimer,500);
    if(nowOpen&&!wasOpen){
      sessionTimer=setInterval(tickTimer,500);
      toast('🟢 Trading session is now open!');
      recordSessionOpenPrices();
    } else if(!nowOpen&&wasOpen){
      clearInterval(sessionTimer);sessionTimer=null;
      toast('🔴 Trading session has closed.');
    }
    if(!userIsFillingForm())render();
  }catch(e){}
}
setInterval(()=>{sessionAutoTick();if(DB.session.ends_at&&DB.session.status==='open'&&!sessionTimer)sessionTimer=setInterval(tickTimer,500);},15000);

// ── Auto-refresh: pull latest data every 20 seconds ──────
let _lastRefresh=0;
function userIsFillingForm(){
  // Check if any input, textarea, or select has focus or has content typed in it
  const active=document.activeElement;
  if(active&&['INPUT','TEXTAREA','SELECT'].includes(active.tagName))return true;
  // Also skip if on a form-heavy tab
  const formTabs=['mystock','register','settings'];
  if(formTabs.includes(UI.navTab))return true;
  if(UI.loginView==='register')return true;
  // Check for any filled-in inputs (user has started typing something)
  const inputs=document.querySelectorAll('input[type="text"],input[type="number"],input[type="email"],input[type="password"],textarea');
  for(const inp of inputs){if(inp.value&&inp.value.trim().length>0)return true;}
  return false;
}
async function autoRefresh(){
  if(!UI.userId)return; // not logged in
  if(userIsFillingForm())return; // don't interrupt forms
  const now=Date.now();
  if(now-_lastRefresh<18000)return; // debounce
  _lastRefresh=now;
  try{
    // Only reload lightweight tables that change frequently
    const [newNotifs,newSession,newCompanies,newTrades,newLimitOrders,newMembers,newAllocs,newFlags,newClassrooms,newStopLoss,newMinutes,newDivApprovals,newBugReports,newFunds,newContactMessages]=await Promise.all([
      // Was a client-supplied user_id=eq. filter -- not a real security
      // boundary since SELECT was table-wide open (see the
      // notification-privacy-fix migration). rpc_get_my_notifications
      // scopes it server-side via auth.uid() instead.
      sb.rpc('rpc_get_my_notifications',{p_limit:50}),
      sb.get('jex_session','id=eq.1'),
      sb.get('jex_companies','order=created_at.asc'),
      sb.get('jex_trades','order=id.desc&limit=100'),
      sb.get('jex_limit_orders','order=created_at.asc'),
      sb.get('jex_company_members','order=created_at.asc'),
      sb.get('jex_founder_allocations','order=created_at.desc'),
      safeRpc('rpc_admin_list_flags').then(r=>r||[]),
    sb.get('jex_classrooms','order=created_at.asc'),
    sb.get('jex_stop_loss','status=eq.active&order=created_at.asc'),
      sb.get('jex_minutes','order=created_at.desc&limit=50'),
      sb.get('jex_dividend_approvals','order=created_at.desc&limit=100'),
      safeRpc('rpc_admin_list_bug_reports').then(r=>r||[]),
      sb.get('jex_funds','order=created_at.asc'),
      safeRpc('rpc_admin_list_contact_messages').then(r=>r||[]),
    ]);
    const prevUnread=DB.notifications.filter(n=>n.user_id===UI.userId&&!n.read).length;
    DB.notifications=newNotifs;
    DB.session=newSession[0]||DB.session;
    DB.companies=newCompanies;
    DB.companyMembers=newMembers;
    DB.founderAllocations=newAllocs;
    DB.flags=newFlags;
    DB.classrooms=newClassrooms;
    DB.stopLossOrders=newStopLoss;
    DB.minutes=newMinutes;
    DB.divApprovals=newDivApprovals;
    DB.bugReports=newBugReports;
    DB.funds=newFunds;
    DB.contactMessages=newContactMessages;
    // Chairman/President only (see loadAll) -- keeps newly-arrived pending
    // registrations' emails visible without a full reload; a no-op safeRpc
    // resolves to null for everyone else.
    const emailMap=await safeRpc('rpc_admin_get_all_emails');
    if(emailMap){
      const uMap=new Map(emailMap.users.map(e=>[e.id,e.email]));
      const pMap=new Map(emailMap.pending.map(e=>[e.id,e.email]));
      DB.users.forEach(u=>{if(uMap.has(u.id))u.email=uMap.get(u.id);});
      DB.pending.forEach(p=>{if(pMap.has(p.id))p.email=pMap.get(p.id);});
    }
    // Merge new trades (avoid duplicates)
    const existingIds=new Set(DB.trades.map(t=>t.id));
    newTrades.forEach(t=>{if(!existingIds.has(t.id))DB.trades.unshift(t);});
    DB.limitOrders=newLimitOrders;
    // Update session timer if needed
    if(DB.session.ends_at&&DB.session.status==='open'&&!sessionTimer)sessionTimer=setInterval(tickTimer,500);
    // Re-render if notifications changed or always update market data silently
    const newUnread=DB.notifications.filter(n=>n.user_id===UI.userId&&!n.read).length;
    // Always re-render to show fresh prices, but don't interrupt forms
    if(!userIsFillingForm()){
      render();
    } else if(newUnread!==prevUnread) {
      // At minimum update the bell badge
      const tb=document.querySelector('.user-pill');if(tb)tb.outerHTML=renderTopbar();
    }
  }catch(e){/* silent fail */}
}
setInterval(autoRefresh,20000);
// Browsers throttle setInterval in background tabs (often down to once a
// minute or less) -- if a trade happened while this tab was in the
// background, its next scheduled autoRefresh() could be a long way off by
// the time someone actually looks at it again. Force an immediate refresh
// the moment the tab regains focus instead of waiting for that timer,
// independent of whether Realtime's WebSocket push is also working.
if(typeof document!=='undefined'){
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible'){_lastRefresh=0;autoRefresh();}
  });
}

// ── Keyboard shortcuts ────────────────────────────────────
document.addEventListener('keydown',function(e){
  // Skip if typing in a form field
  if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
  if(e.metaKey||e.ctrlKey||e.altKey)return;
  const key=e.key.toLowerCase();
  if(key==='escape'){
    if(UI.companyPage){closeCompanyPage();return;}
  }
  if(!UI.userId)return;
  const u=cu();
  if(u?.role==='student'||u?.role==='company'){
    if(key==='m'){setTab('market');return;}
    if(key==='p'){setTab('portfolio');return;}
    if(key==='l'){setTab('leaderboard');return;}
    if(key==='n'&&(u.role==='student'||u.role==='company')){UI.navTab='notifications';render();return;}
    if(UI.companyPage){
      if(key==='b'){UI.companyPageTab='trade';UI.panelMode='buy';render();}
      if(key==='s'){UI.companyPageTab='trade';UI.panelMode='sell';render();}
      if(key==='o'){UI.companyPageTab='overview';render();}
    }
  }
});

// ═══════════════════════════════════════════════
// AUTH & REGISTRATION
// ═══════════════════════════════════════════════
const SECURITY_QUESTIONS=['What is the name of your first pet?','What city were you born in?','What is your mother\'s maiden name?','What was the name of your first school?','What is your favourite book?','What was the make of your first car?','What is your oldest sibling\'s middle name?','What street did you grow up on?'];
function secQSelect(prefix){return `<select id="${prefix}-secq"><option value="">— Select a question —</option>${SECURITY_QUESTIONS.map(q=>`<option value="${q}">${q}</option>`).join('')}</select>`;}

// ── Email verification (registration) ────────────────────
const emailjsReady=()=>!!(DB.session.emailjs_service_id&&DB.session.emailjs_template_id&&DB.session.emailjs_public_key&&typeof emailjs!=='undefined');
function openRegisterView(){UI.regVerify={reg:{status:'idle',email:'',resendAt:0},'reg-co':{status:'idle',email:'',resendAt:0}};UI.googleAuth=null;UI.loginView='register';render();}

// ── Google Sign-In (real Supabase Auth) ───────────────────
const GOOGLE_G_SVG='<svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/><path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>';
function genUsernameFromEmail(email){
  const base=(String(email).split('@')[0]||'user').replace(/[^a-zA-Z0-9_.]/g,'').slice(0,16)||'user';
  let candidate=base,n=1;
  while(DB.users.some(u=>norm(u.username)===norm(candidate))||DB.pending.some(r=>norm(r.username)===norm(candidate))){
    candidate=base+(n++);
  }
  return candidate;
}
async function signInWithGoogle(){
  if(!supaAuth)return toast('Google Sign-In is not available right now');
  try{
    await supaAuth.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin+window.location.pathname}});
  }catch(e){toast('Could not start Google Sign-In: '+(e.message||e));}
}
async function checkGoogleSession(){
  if(!supaAuth)return;
  // Never auto-login off a password-recovery session — see _passwordRecoveryActive above.
  if(_passwordRecoveryActive)return;
  // Every path below returns through here -- see _oauthReturnActive above for
  // why this needs to clear no matter how this call resolves (matched,
  // pending, brand new signup, or no session at all), not just on success.
  try{await checkGoogleSessionInner();}finally{_oauthReturnActive=false;}
}
async function checkGoogleSessionInner(){
  let session=null;
  try{
    const res=await supaAuth.auth.getSession();
    session=res&&res.data&&res.data.session;
  }catch(e){console.warn('Google session check failed:',e);return;}
  if(!session||!session.user||!session.user.email)return;
  // Also refuse a session left over from an abandoned recovery link on a LATER page load
  // (see RECOVERY_TOKEN_KEY above) — the in-memory flag alone only covers the same load.
  try{if(session.access_token&&session.access_token===localStorage.getItem(RECOVERY_TOKEN_KEY))return;}catch(e){}
  const email=norm(session.user.email);
  const meta=session.user.user_metadata||{};
  const name=String(meta.full_name||meta.name||email.split('@')[0]||'Google User');
  const authUid=session.user.id||null;
  // Matching against DB.users/DB.pending by email client-side is gone --
  // bulk fetches no longer carry email at all (see the
  // email-pii-exposure-fix migration). rpc_google_session_match() does the
  // match (and the auth_uid backfill, in the same call) server-side,
  // reading the email from the caller's own verified JWT rather than
  // trusting anything client-supplied.
  let match;
  try{match=await sb.rpc('rpc_google_session_match',{});}catch(e){console.warn('Google session match failed:',e);return;}
  if(match.status==='existing'){
    const existing=match.user;
    // Real page navigation (every nav click, now that pages are routed)
    // reruns boot() -> checkGoogleSession() on an already-established
    // session -- if localStorage already restored this exact user, there's
    // nothing new to announce. Let boot()'s own session-validation path
    // (right after this call) handle it silently instead of re-toasting
    // "Signed in with Google" and re-resetting navTab on every click.
    if(UI.userId===existing.id)return;
    const idx=DB.users.findIndex(u=>u.id===existing.id);
    if(idx>=0)DB.users[idx]=existing;else DB.users.push(existing);
    UI.userId=existing.id;
    UI.navTab=isAdmin(existing)?'admin':existing.role==='company'?'mystock':'market';
    try{localStorage.setItem(SESSION_KEY,existing.id);}catch(e){}
    subscribeRealtime();
    toast('Signed in with Google as '+existing.name);
    render();
    return;
  }
  if(match.status==='pending'){
    toast('Your registration is still awaiting Chairman/President approval');
    render();
    return;
  }
  UI.googleAuth={email,name,authUid};
  UI.loginView='register';
  render();
}
function onRegEmailChanged(prefix){
  const state=UI.regVerify[prefix];
  const email=norm((get(prefix+'-email')?.value||'').trim());
  if(state&&state.status!=='idle'&&state.email!==email){
    UI.regVerify[prefix]={status:'idle',email:'',resendAt:0};
    renderRegEmailVerify(prefix);
  }
}
async function sendRegVerificationCode(prefix){
  const email=norm((get(prefix+'-email')?.value||'').trim());
  if(!validEmail(email))return toast('Enter a valid email first');
  if(!emailjsReady())return toast('Email verification is not available right now');
  const name=(get(prefix==='reg'?'reg-name':'reg-co-name')?.value||'').trim()||'there';
  // Runs server-side (rpc_request_verification_code), which generates and
  // stores the code itself -- a raw POST here used to let anyone insert
  // their own self-chosen code for an email they don't own, "verifying"
  // it without any real email round-trip. The code is only ever returned
  // to this immediate caller, since it's needed here to embed in the
  // EmailJS send just below.
  try{
    const r=await sb.rpc('rpc_request_verification_code',{p_email:email});
    emailjs.init({publicKey:DB.session.emailjs_public_key});
    await emailjs.send(DB.session.emailjs_service_id,DB.session.emailjs_template_id,{
      to_email:email,to_name:name,
      subject:'Your JEX verification code',
      message:'Your JEX email verification code is '+r.code+'. It expires in 15 minutes.',
      ticker:'',app_url:window.location.origin+window.location.pathname
    });
  }catch(e){return toast('Failed to send verification code: '+(e.message||e));}
  UI.regVerify[prefix]={status:'sent',email,resendAt:Date.now()+30000};
  renderRegEmailVerify(prefix);
  toast('Verification code sent to '+email);
}
async function confirmRegVerificationCode(prefix){
  const state=UI.regVerify[prefix];
  if(!state||state.status!=='sent')return;
  const code=(get(prefix+'-verify-code')?.value||'').trim();
  if(!/^\d{6}$/.test(code))return toast('Enter the 6-digit code from your email');
  // Runs server-side (rpc_confirm_verification_code), which checks the
  // match itself and never returns the stored code -- a raw GET here used
  // to let anyone read out any email's real verification code directly,
  // completely defeating the point of email verification.
  let ok;
  try{ok=await sb.rpc('rpc_confirm_verification_code',{p_email:state.email,p_code:code});}
  catch(e){return toast('Verification failed, please try again');}
  if(!ok)return toast('Incorrect or expired code');
  UI.regVerify[prefix]={status:'verified',email:state.email,resendAt:0};
  renderRegEmailVerify(prefix);
  toast('Email verified');
}
function renderRegEmailVerify(prefix){
  const box=get(prefix+'-email-verify');if(!box)return;
  box.innerHTML=renderRegEmailVerifyHTML(prefix);
}
function renderRegEmailVerifyHTML(prefix){
  if(!emailjsReady())return '';
  const state=UI.regVerify[prefix]||{status:'idle'};
  if(state.status==='verified')return '<div class="ibox ibox-green" style="margin:-6px 0 12px;font-size:12px">✓ Email verified</div>';
  if(state.status==='sent'){
    const canResend=Date.now()>=state.resendAt;
    return '<div class="frow" style="margin-top:-6px"><label class="flabel">Enter the 6-digit code we emailed you</label>'
      +'<div style="display:flex;gap:8px"><input type="text" id="'+prefix+'-verify-code" placeholder="123456" maxlength="6" inputmode="numeric" style="flex:1"><button type="button" class="btn btn-sm" onclick="confirmRegVerificationCode(&#39;'+prefix+'&#39;)">Verify</button></div>'
      +'<div style="font-size:11px;margin-top:6px">'+(canResend?'<a class="legal-link" onclick="sendRegVerificationCode(&#39;'+prefix+'&#39;)">Resend code</a>':'<span style="color:var(--text2)">You can resend in a moment</span>')+'</div>'
      +'</div>';
  }
  return '<div style="margin:-6px 0 12px"><button type="button" class="btn btn-sm" onclick="sendRegVerificationCode(&#39;'+prefix+'&#39;)">Send verification code</button></div>';
}

// Tries to create a real Supabase Auth account for a new local (non-Google) signup.
// Fails safe: if this doesn't succeed for any reason (misconfigured project, a stale
// duplicate signup, no network), the caller falls back to today's custom password
// system for that account rather than blocking registration outright.
async function tryCreateAuthAccount(email,pw){
  if(!supaAuth)return null;
  try{
    const{data,error}=await supaAuth.auth.signUp({email:norm(email),password:pw,options:{emailRedirectTo:window.location.origin+window.location.pathname}});
    if(error){console.warn('Supabase Auth signup failed, using legacy auth for this account:',error.message);return null;}
    return data?.user?.id||null;
  }catch(e){console.warn('Supabase Auth signup failed, using legacy auth for this account:',e);return null;}
}
async function registerStudent(name,username,email,pw,secQ,secA,emailVerified,authProvider,authUid){
  if(!name||name.trim().length<2)return toast('Enter a valid name');
  const un=normalizeUsername(username);
  if(!validUsername(un))return toast('Username must be 3-20 characters: letters, numbers, underscore, or period');
  if(!validEmail(email))return toast('Enter a valid email');
  const isGoogle=authProvider==='google';
  if(!isGoogle){
    if(!pw||pw.length<4)return toast('Password must be at least 4 characters');
    if(!secQ)return toast('Select a security question');
    if(!secA||secA.trim().length<2)return toast('Enter a security answer');
  }
  const n=name.trim();
  if(DB.users.find(u=>norm(u.name)===norm(n))||DB.pending.find(r=>norm(r.name)===norm(n)))return toast('Name already taken');
  if(DB.users.find(u=>norm(u.username)===norm(un))||DB.pending.find(r=>norm(r.username)===norm(un)))return toast('Username already taken');
  // Checked across every role, not just students: emails are the real Supabase Auth
  // identity now, and checkGoogleSession()/loginByForm both key off email, so two
  // approved-or-pending accounts sharing one email leads to genuinely broken, hard-to-
  // diagnose login lockouts. Runs server-side (rpc_check_email_taken) -- bulk
  // DB.users/DB.pending no longer carry email at all to check against client-side.
  let emailTaken=false;
  try{emailTaken=await sb.rpc('rpc_check_email_taken',{p_email:email});}catch(e){return toast('Could not verify email — please try again');}
  if(emailTaken)return toast('An account with that email already exists');
  const newAuthUid=isGoogle?(authUid||null):await tryCreateAuthAccount(email,pw);
  const isMigrated=isGoogle||!!newAuthUid;
  const pwHash=isMigrated?null:await hashPw(pw);
  const rec={id:uid(),name:n,username:un,email:norm(email),password:pwHash,role:'student',
    sec_q:isGoogle?null:secQ,sec_a:isGoogle?null:norm(secA),
    email_verified:isGoogle?true:!!emailVerified,auth_provider:isGoogle?'google':null,auth_uid:newAuthUid,ts:ts()};
  await sb.post('jex_pending',rec);DB.pending.push(rec);
  toast('Registration submitted! Wait for admin approval.');UI.loginView='select';UI.googleAuth=null;render();
}
async function registerCompany(name,username,email,pw,desc,secQ,secA,emailVerified,authProvider,authUid){
  if(!name||name.trim().length<2)return toast('Enter a valid company name');
  const un=normalizeUsername(username);
  if(!validUsername(un))return toast('Username must be 3-20 characters: letters, numbers, underscore, or period');
  if(!validEmail(email))return toast('Enter a valid email');
  if(!desc||desc.trim().length<5)return toast('Please add a description');
  const isGoogle=authProvider==='google';
  if(!isGoogle){
    if(!pw||pw.length<4)return toast('Password must be at least 4 characters');
    if(!secQ)return toast('Select a security question');
    if(!secA||secA.trim().length<2)return toast('Enter a security answer');
  }
  const n=name.trim();
  if(DB.users.find(u=>norm(u.name)===norm(n))||DB.pending.find(r=>norm(r.name)===norm(n)))return toast('Name already taken');
  if(DB.users.find(u=>norm(u.username)===norm(un))||DB.pending.find(r=>norm(r.username)===norm(un)))return toast('Username already taken');
  // See the matching check in registerStudent for why this spans every role.
  let emailTakenCo=false;
  try{emailTakenCo=await sb.rpc('rpc_check_email_taken',{p_email:email});}catch(e){return toast('Could not verify email — please try again');}
  if(emailTakenCo)return toast('An account with that email already exists');
  const newAuthUidCo=isGoogle?(authUid||null):await tryCreateAuthAccount(email,pw);
  const isMigratedCo=isGoogle||!!newAuthUidCo;
  const pwHashCo=isMigratedCo?null:await hashPw(pw);
  const rec={id:uid(),name:n,username:un,email:norm(email),password:pwHashCo,role:'company',description:desc.trim(),
    sec_q:isGoogle?null:secQ,sec_a:isGoogle?null:norm(secA),
    email_verified:isGoogle?true:!!emailVerified,auth_provider:isGoogle?'google':null,auth_uid:newAuthUidCo,ts:ts()};
  await sb.post('jex_pending',rec);DB.pending.push(rec);
  toast('Company registration submitted!');UI.loginView='select';UI.googleAuth=null;render();
}
async function approveReg(id,startCash){
  const r=DB.pending.find(x=>x.id===id);if(!r)return;
  const classroomId=document.getElementById('classroom-'+id)?.value||null;
  startCash=parseFloat(startCash)||DB.session.starting_cash||10000;
  // The copy from jex_pending into jex_users (including the legacy password
  // hash, for accounts that still have one) happens entirely inside this
  // function now, since the client itself can no longer read that value.
  // u.id reuses the pending record's id, so a double-click or two admins
  // approving the same registration at once collide on the primary key —
  // the RPC throws instead of silently creating a duplicate account. Catch
  // that so the losing click gets a clear toast instead of an uncaught error.
  let u;
  try{u=await sb.rpc('approve_registration',{p_pending_id:id,p_starting_cash:startCash,p_classroom_id:classroomId||null});}
  catch(e){DB.pending=DB.pending.filter(x=>x.id!==id);render();return toast('This registration was already approved');}
  DB.users.push(u);DB.pending=DB.pending.filter(x=>x.id!==id);
  await logActivity('registration',r.name+' approved ('+r.role+') with '+fmt(startCash),{userId:r.id,userName:r.name,amount:startCash});

  toast(r.name+' approved with '+fmt(startCash));render();
}
async function rejectReg(id){
  const r=DB.pending.find(x=>x.id===id);
  // Runs server-side (rpc_admin_reject_registration) -- this function had
  // NO check at all before, client-side or otherwise, only being reachable
  // from an admin-only UI.
  try{await sb.rpc('rpc_admin_reject_registration',{p_pending_id:id});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.pending=DB.pending.filter(x=>x.id!==id);toast((r?.name||'Registration')+' rejected');render();
}
function switchLoginTab(role){UI.loginTab=role;UI.loginError=null;render();}
function finishLogin(u){
  UI.userId=u.id;const r=u.role;UI.navTab=isAdmin(u)?'admin':r==='company'?'mystock':'market';UI.loginView='select';UI.loginError=null;UI.loginUsername='';
  try{localStorage.setItem(SESSION_KEY,u.id);}catch(e){}
  subscribeRealtime();if(typeof Notification!=='undefined'&&Notification.permission==='default')requestPushPermission();render();return loadAll();
}
async function loginByForm(){
  const username=(get('login-username')?.value||'').trim();
  const pw=get('login-password')?.value||'';
  UI.loginUsername=username;
  if(!username||!pw){UI.loginError='Enter your username and password';return render();}
  const idInput=norm(normalizeUsername(username));
  // Matching by email or username against the pool used to be a client-side
  // DB.users.find() -- bulk DB.users no longer carries email at all (see the
  // email-pii-exposure-fix migration), so the match itself now happens
  // server-side (rpc_resolve_login_identity), scoped to the same pool
  // (UI.loginTab: 'student'|'company'|'admin') the client-side filter used.
  let u;
  try{u=await sb.rpc('rpc_resolve_login_identity',{p_identifier:username,p_pool:UI.loginTab});}catch(e){u=null;}
  if(!u){UI.loginError='Invalid username or password';return render();}
  const idx=DB.users.findIndex(x=>x.id===u.id);
  if(idx>=0)DB.users[idx]=u;else DB.users.push(u);
  // Secretary/Treasurer/Compliance Officer sign in with a username only — their
  // email exists purely as the backing Supabase Auth credential, not something
  // they're meant to use or see day-to-day, unlike Chairman/President. Only
  // enforced when the account actually HAS a username — refusing email with no
  // usable alternative would permanently lock the account out instead.
  if(['secretary','treasurer','compliance_officer'].includes(u.role)&&u.username&&u.email&&idInput===norm(u.email)){
    UI.loginError='This account can only sign in with a username, not an email';return render();
  }
  if((u.auth_uid||u.auth_provider==='google')&&supaAuth){
    // Covers migrated accounts and Google-linked accounts alike — Google accounts can
    // now optionally set a password too (see changePwSupa), so this just attempts a
    // real Supabase Auth sign-in either way rather than hard-blocking Google accounts
    // from ever trying a password. One that never set one simply gets "invalid" below,
    // same as any other wrong/missing credential.
    let error;
    try{({error}=await supaAuth.auth.signInWithPassword({email:u.email,password:pw}));}
    catch(e){error=e;}
    if(error){UI.loginError='Invalid username or password';return render();}
    return finishLogin(u);
  }
  let ok=false;
  try{ok=await sb.rpc('verify_legacy_password',{p_user_id:u.id,p_password:pw});}catch(e){ok=false;}
  if(!ok){UI.loginError='Invalid username or password';return render();}
  // Quietly migrate this account to a real Supabase Auth identity on a successful
  // legacy-password login — same "one less account stuck on the old system" idea
  // as the Google backfill above, just triggered by password login instead of
  // Google. This is what makes trading (which now requires a server-verifiable
  // auth.uid(), see rpc_trade_*) keep working for existing accounts without
  // anyone having to do anything extra. Best-effort and silent either way —
  // login must still succeed on the already-verified legacy path even if this
  // fails (e.g. the account's legacy password is shorter than Supabase Auth's
  // minimum length, so signUp itself gets rejected — an account like that stays
  // on the legacy path and just can't trade until an admin migrates it by hand).
  if(supaAuth&&!u.auth_uid&&u.email){
    try{
      let authUid=null;
      const{data,error}=await supaAuth.auth.signUp({email:u.email,password:pw});
      if(!error&&data&&data.user)authUid=data.user.id;
      else{
        // An Auth account may already exist from a prior migration attempt that
        // didn't finish backfilling auth_uid (e.g. the PATCH below raced or
        // failed) — try signing into it before giving up.
        const signInRes=await supaAuth.auth.signInWithPassword({email:u.email,password:pw});
        if(!signInRes.error&&signInRes.data&&signInRes.data.session)authUid=signInRes.data.session.user.id;
      }
      // Runs server-side (rpc_link_own_auth_uid) -- same JWT-email check as
      // the Google backfill above, now backed by the fresh Supabase Auth
      // session signUp/signInWithPassword just established for this email.
      if(authUid){await sb.rpc('rpc_link_own_auth_uid',{p_user_id:u.id});u.auth_uid=authUid;}
    }catch(e){console.warn('legacy account auth migration failed:',e);}
  }
  return finishLogin(u);
}
function logout(){UI.userId=null;UI.navTab='market';UI.loginView='select';UI.panelTicker=null;UI.companyPage=null;UI.fundPage=null;UI.tradePage=0;UI.googleAuth=null;destroyCharts();try{localStorage.removeItem(SESSION_KEY);}catch(e){}if(supaAuth)supaAuth.auth.signOut().catch(()=>{});render();}
async function changeEmail(uid2,newEmail,pw){
  const u=getUser(uid2);if(!u)return;
  if(!newEmail||!newEmail.includes('@'))return toast('Enter a valid email address');
  if(!pw)return toast('Enter your current password');
  const norm_email=newEmail.trim().toLowerCase();
  // Runs server-side (rpc_change_email), re-verifying the password itself
  // (same verify_legacy_password check, now authoritative instead of just
  // gating a separate client-trusted write) and the email-uniqueness check.
  try{await sb.rpc('rpc_change_email',{p_user_id:uid2,p_cur_pw:pw,p_new_email:norm_email});}
  catch(e){return toast(rpcErrorMessage(e));}
  u.email=norm_email;
  toast('✓ Email updated to '+norm_email);render();
}
// For migrated (real Supabase Auth) accounts — identity is proven by the live signed-in
// session, so no current-password confirmation is needed. Updates the real Auth email
// (what signInWithPassword actually authenticates against) alongside jex_users.email, so
// the two never drift out of sync with each other.
async function changeEmailSupa(uid2,newEmail){
  if(!supaAuth)return toast('Not available right now');
  if(!cu()||uid2!==cu().id)return toast('You can only change your own email');
  if(!newEmail||!newEmail.includes('@'))return toast('Enter a valid email address');
  const norm_email=newEmail.trim().toLowerCase();
  try{
    const{error}=await supaAuth.auth.updateUser({email:norm_email},{emailRedirectTo:window.location.origin+window.location.pathname});
    if(error)return toast('Failed to update email: '+error.message);
  }catch(e){return toast('Failed to update email: '+(e.message||e));}
  // Runs server-side (rpc_change_email_supa) -- operates only on
  // auth.uid()'s own row (no target id accepted at all), so a spoofed uid2
  // can no longer overwrite someone else's jex_users.email.
  try{await sb.rpc('rpc_change_email_supa',{p_new_email:norm_email});}
  catch(e){return toast(rpcErrorMessage(e));}
  cu().email=norm_email;
  toast('✓ Email updated to '+norm_email);render();
}
async function changePw(uid2,cur,nw2,conf){const u=getUser(uid2);if(!u)return;
  if(!nw2||nw2.length<6)return toast('Minimum 6 characters required');if(nw2!==conf)return toast('Passwords do not match');
  // Runs server-side (rpc_change_password), re-verifying the current
  // password itself instead of trusting this client-side check alone --
  // jex_users.password was never column-revoked before this, so a raw
  // PATCH could overwrite ANY row's actual credential.
  try{await sb.rpc('rpc_change_password',{p_user_id:uid2,p_cur_pw:cur,p_new_pw:nw2});}
  catch(e){return toast(rpcErrorMessage(e));}
  toast('Password changed');render();}
// For migrated (real Supabase Auth) accounts — no stored local password to check
// against, so identity is proven by the live signed-in session instead.
async function changePwSupa(nw2,conf){
  if(!supaAuth)return toast('Not available right now');
  if(!nw2||nw2.length<6)return toast('Minimum 6 characters required');
  if(nw2!==conf)return toast('Passwords do not match');
  try{
    const{error}=await supaAuth.auth.updateUser({password:nw2});
    if(error)return toast('Failed to update password: '+error.message);
  }catch(e){return toast('Failed to update password: '+(e.message||e));}
  toast('Password changed');render();
}
async function adminResetPw(uid2,pw){
  if(!isAdmin(cu()))return toast('Admin access required');
  const u=getUser(uid2);if(!u)return;
  if(u.role==='chairman'||u.role==='president')return toast('Chairman and President passwords cannot be reset here');
  // Migrated/Google accounts authenticate via real Supabase Auth, which this legacy
  // password-hash column has no effect on — setting it here would silently do nothing
  // while telling the officer it worked. Route those through a real reset email instead.
  if(u.auth_provider==='google'||u.auth_uid)return toast('This account uses real sign-in — use "Send password reset email" instead');
  if(!pw||pw.length<4)return toast('Min 4 characters');
  // Runs server-side (rpc_admin_reset_password), re-checking every rule
  // above -- they were client-side only.
  try{await sb.rpc('rpc_admin_reset_password',{p_user_id:uid2,p_new_pw:pw});}
  catch(e){return toast(rpcErrorMessage(e));}
  toast(u.name+"'s password reset");render();
}
async function adminSendResetEmail(uid2){
  if(!isAdmin(cu()))return toast('Admin access required');
  const u=getUser(uid2);if(!u)return;
  if(u.role==='chairman'||u.role==='president')return toast('Chairman and President passwords cannot be reset here');
  if(!supaAuth)return toast('Not available right now');
  try{
    const{error}=await supaAuth.auth.resetPasswordForEmail(u.email,{redirectTo:window.location.origin+window.location.pathname});
    if(error)return toast('Could not send reset email: '+error.message);
  }catch(e){return toast('Could not send reset email: '+(e.message||e));}
  toast('Password reset email sent to '+u.email);render();
}
async function toggleEmailNotifications(enabled){
  const u=cu();if(!u)return;
  if(['secretary','treasurer','compliance_officer'].includes(u.role))return toast('Email notifications are not available for this account');
  try{await sb.rpc('rpc_toggle_email_notifications',{p_enabled:!!enabled});}
  catch(e){return toast(rpcErrorMessage(e));}
  u.email_notifications=!!enabled;
  toast(enabled?'Email notifications enabled':'Email notifications disabled');
  render();
}
async function saveNotifEmail(){
  const u=cu();if(!u)return;
  if(['secretary','treasurer','compliance_officer'].includes(u.role))return toast('Email notifications are not available for this account');
  const email=(get('notif-email')?.value||'').trim().toLowerCase();
  if(!email||!email.includes('@'))return toast('Enter a valid email address');
  try{await sb.rpc('rpc_save_notification_email',{p_email:email});}
  catch(e){return toast(rpcErrorMessage(e));}
  u.notification_email=email;
  toast('✓ Notification email saved: '+email);render();
}
async function updateSecQ(uid2,curPw,newQ,newA){const u=getUser(uid2);if(!u)return;
  let okSq=false;
  if(u.auth_uid){
    // Migrated accounts have no legacy password hash to check against — the real
    // credential lives in Supabase Auth, so verifying it means asking Supabase
    // directly rather than the verify_legacy_password RPC (which would always
    // fail here since jex_users.password is null for these accounts).
    if(!supaAuth)return toast('Not available right now');
    try{const{error}=await supaAuth.auth.signInWithPassword({email:u.email,password:curPw});okSq=!error;}catch(e){okSq=false;}
  }else{
    try{okSq=await sb.rpc('verify_legacy_password',{p_user_id:uid2,p_password:curPw});}catch(e){okSq=false;}
  }
  if(!okSq)return toast('Current password incorrect');if(!newQ)return toast('Select a question');if(!newA||newA.trim().length<2)return toast('Enter an answer');
  // The actual write runs server-side (rpc_update_security_question), which
  // re-verifies identity itself (current password for legacy accounts, an
  // actual live Supabase Auth session for migrated ones) instead of
  // trusting the client-side check above alone. Closes a real
  // account-takeover path: sec_a (the answer "Forgot password" checks) was
  // directly PATCH-able on ANY row with no verification at all before this.
  try{await sb.rpc('rpc_update_security_question',{p_user_id:uid2,p_cur_pw:curPw,p_new_q:newQ,p_new_a:newA});}
  catch(e){return toast(rpcErrorMessage(e));}
  u.sec_q=newQ;toast('Security question updated');render();}
async function forgotStep1(email){
  // Was DB.users.find(u=>norm(u.email)===...) -- bulk DB.users no longer
  // carries email (see the email-pii-exposure-fix migration), so this
  // resolves server-side now, same RPC loginByForm uses (pool='any' matches
  // the original's no-role-filter, approved-only, email-only semantics).
  let u;
  try{u=await sb.rpc('rpc_resolve_login_identity',{p_identifier:email,p_pool:'any'});}catch(e){u=null;}
  if(!u)return toast('No account found with that email');
  const idx=DB.users.findIndex(x=>x.id===u.id);
  if(idx>=0)DB.users[idx]=u;else DB.users.push(u);
  if(u.auth_provider==='google'&&supaAuth){
    // Google-linked accounts have a real, Google-verified email, so the built-in
    // email reset is meaningful for them. Migrated-local accounts (auth_uid set,
    // not Google) go through the security question below instead of email —
    // recovery for those should never depend on an email actually being
    // reachable (see reset_migrated_password).
    try{
      const{error}=await supaAuth.auth.resetPasswordForEmail(u.email,{redirectTo:window.location.origin+window.location.pathname});
      if(error)return toast('Could not send reset email: '+error.message);
    }catch(e){return toast('Could not send reset email: '+(e.message||e));}
    toast('Check your email for a password reset link');
    UI.loginView='select';render();
    return;
  }
  UI.forgotUserId=u.id;UI.loginView='forgot-secq';render();
}
async function forgotStep2(answer){const u=getUser(UI.forgotUserId);if(!u)return;
  let okAns=false;
  try{okAns=await sb.rpc('verify_legacy_security_answer',{p_user_id:u.id,p_answer:answer});}catch(e){okAns=false;}
  if(!okAns)return toast('Incorrect answer — try again');
  UI.forgotAnswer=answer;
  UI.loginView='forgot-newpw';render();}
async function forgotStep3(pw,conf){
  const u=getUser(UI.forgotUserId);if(!u)return;
  if(!pw||pw.length<4)return toast('Min 4 characters');
  if(pw!==conf)return toast('Passwords do not match');
  if(u.auth_uid){
    // Migrated account: the real credential lives in Supabase Auth, not
    // jex_users.password — reset_migrated_password re-verifies the security
    // answer itself (never trusts that forgotStep2's check alone is enough,
    // since this RPC is reachable directly) and writes the new password to
    // auth.users on success.
    let ok=false;
    try{ok=await sb.rpc('reset_migrated_password',{p_user_id:u.id,p_answer:UI.forgotAnswer,p_new_password:pw});}catch(e){ok=false;}
    if(!ok)return toast('Could not reset password — start over from Forgot Password');
    toast('Password reset');UI.loginView='select';UI.forgotUserId=null;UI.forgotAnswer=null;render();
    return;
  }
  // Runs server-side (rpc_reset_legacy_password), re-verifying the
  // security answer itself -- same reasoning as reset_migrated_password
  // above: this function is directly reachable, so it can't trust that
  // forgotStep2's check already happened. The previous raw PATCH here had
  // NO server-side check of any kind, making it callable with any
  // UI.forgotUserId to reset ANY account's password outright.
  let ok=false;
  try{ok=await sb.rpc('rpc_reset_legacy_password',{p_user_id:u.id,p_answer:UI.forgotAnswer,p_new_pw:pw});}catch(e){ok=false;}
  if(!ok)return toast('Could not reset password — start over from Forgot Password');
  toast('Password reset');UI.loginView='select';UI.forgotUserId=null;UI.forgotAnswer=null;render();
}
async function finishPasswordRecovery(pw,conf){
  if(!supaAuth)return toast('Not available right now');
  if(!pw||pw.length<6)return toast('Minimum 6 characters required');
  if(pw!==conf)return toast('Passwords do not match');
  try{
    const{error}=await supaAuth.auth.updateUser({password:pw});
    if(error)return toast('Failed to set password: '+error.message);
  }catch(e){return toast('Failed to set password: '+(e.message||e));}
  try{await supaAuth.auth.signOut();}catch(e){}
  try{localStorage.removeItem(RECOVERY_TOKEN_KEY);}catch(e){}
  toast('Password set — you can now log in');
  UI.loginView='select';render();
}

// ═══════════════════════════════════════════════
// NEWS
// ═══════════════════════════════════════════════
async function postNews(ticker,headline,body){
  if(!headline||headline.trim().length<3)return toast('Enter a headline');
  const co=getCo(ticker);if(!co)return;
  if(!canManageCompany(co))return toast('Only this company\'s owner or founders can post news for it');
  // Runs server-side (rpc_post_news), re-checking the same owner-or-
  // founder rule above -- it was client-side only, so a raw POST could
  // fabricate market-moving "news" for any company, indistinguishable
  // from a real company-posted headline.
  let rec;
  try{rec=await sb.rpc('rpc_post_news',{p_ticker:ticker,p_headline:headline.trim(),p_body:(body||'').trim()});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.news.unshift(rec);
  if(document.getElementById('news-notify')?.checked)await pushNotificationToHolders(ticker,'news','📰 '+co.name+': '+headline.trim());
  toast('News posted');UI.companyTab='news';render();
}
async function deleteNews(id){
  const n0=DB.news.find(x=>x.id===id);if(!n0)return;
  const targetCo=getCo(n0.ticker);
  if(!targetCo||!canManageCompany(targetCo))return toast('Only this company\'s owner or founders can delete its news');
  if(!confirm('Delete this news post?'))return;
  // Runs server-side (rpc_delete_news), re-checking the same owner-or-
  // founder rule above -- canManageCompany() was client-side only, so a
  // raw DELETE on jex_news could remove any company's news post.
  try{await sb.rpc('rpc_delete_news',{p_news_id:id});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.news=DB.news.filter(n=>n.id!==id);
  toast('News deleted');render();
}

// ── Activity log ────────────────────────────────────────
async function logActivity(type,description,extras={}){
  try{
    // Hash-chain for audit trail
    const prev=DB.activity.find(a=>a.type!=='snapshot');
    const prevHash=prev?prev.entry_hash||prev.id:'genesis';
    const rec={id:uid(),type,description,ticker:extras.ticker||null,user_id:extras.userId||null,user_name:extras.userName||null,amount:extras.amount||null,ts:ts(),prev_hash:prevHash};
    const content=prevHash+type+description+(extras.amount||'')+(rec.ts||'');
    rec.entry_hash=btoa(encodeURIComponent(content.slice(0,50))).slice(-8);
    await sb.post('jex_activity',rec);
    DB.activity.unshift(rec);
    if(DB.activity.length>200)DB.activity=DB.activity.slice(0,200);
    pushToSheets('activity',{items:DB.activity.slice(0,10)});
  }catch(e){console.warn('Activity log failed:',e);}
}

// ── Announcements ───────────────────────────────────────
async function postAnnouncement(title,body,level){
  if(!title||title.trim().length<3)return toast('Enter a title');
  const u=cu();
  // Runs server-side (rpc_post_announcement) -- this function had NO role
  // check at all before, not even client-side, so anyone who found it in
  // devtools could plant a fake "urgent" banner announcement, the
  // highest-visibility surface in the app (pinned at the top for every user).
  let rec;
  try{rec=await sb.rpc('rpc_post_announcement',{p_title:title.trim(),p_body:(body||'').trim(),p_level:level||'info'});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.announcements.unshift(rec);
  await logActivity('announcement','Announcement posted: '+title.trim(),{userId:u.id,userName:u.name});
  toast('Announcement posted');render();
}
async function deleteAnnouncement(id){
  if(!confirm('Delete this announcement?'))return;
  // Runs server-side (rpc_admin_delete_announcement) -- this function had
  // NO check at all before, client-side or otherwise.
  try{await sb.rpc('rpc_admin_delete_announcement',{p_id:id});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.announcements=DB.announcements.filter(a=>a.id!==id);
  toast('Announcement deleted');render();
}

// ── Limit orders ────────────────────────────────────────
// ═══════════════════════════════════════════════
// COMPANY MEMBERSHIP (CO-FOUNDERS)
// ═══════════════════════════════════════════════
function getMyCompany(userId){
  // Find company where user is lead owner or accepted co-founder
  const asLead=DB.companies.find(c=>c.owner_id===userId);
  if(asLead)return asLead;
  const asMember=DB.companyMembers.find(m=>m.student_id===userId&&m.status==='accepted');
  if(asMember)return DB.companies.find(c=>c.owner_id===asMember.company_user_id);
  return null;
}

function doInviteFounder(companyTicker){
  const studentId=document.getElementById('invite-student')?.value;
  if(!studentId)return toast('Select a student first');
  const student=getUser(studentId);
  const co=DB.companies.find(c=>c.owner_id===companyTicker)||getCo(companyTicker);
  const coName=co?co.name:'this company';
  if(!confirm('Send a founder invitation to '+( student?.name||studentId)+' for '+coName+'?'))return;
  sendFounderInvite(companyTicker,studentId);
}
function doRequestFounderAlloc(){
  const ticker=document.getElementById('alloc-ticker')?.value;
  const studentId=document.getElementById('alloc-student')?.value;
  const shares=document.getElementById('alloc-shares')?.value;
  const reason=document.getElementById('alloc-reason')?.value;
  if(!ticker)return toast('Select a share class');
  if(!studentId)return toast('Select a founder');
  requestFounderAllocation(ticker,studentId,shares,reason);
}
// (merged into sendFounderInvite)
async function respondToInvite(memberId,accept){
  const m=DB.companyMembers.find(x=>x.id===memberId);if(!m)return;
  if(m.student_id!==cu()?.id)return toast('This invitation is not addressed to you');
  if(!confirm(accept?'Accept this founder invitation?':'Decline this founder invitation?'))return;

  // Update jex_company_members status. Runs server-side
  // (rpc_respond_to_invite), re-checking the same "addressed to you" rule
  // above -- it was client-side only, so a raw PATCH could accept/decline
  // any invitation on someone else's behalf.
  try{await sb.rpc('rpc_respond_to_invite',{p_member_id:memberId,p_accept:!!accept});}
  catch(e){return toast(rpcErrorMessage(e));}
  m.status=accept?'accepted':'declined';

  const co=DB.companies.find(c=>c.owner_id===m.company_user_id);
  const u=cu();
  if(accept&&co)_teamContactsLoaded.delete(co.ticker);

  if(accept&&co){
    // jex_company_members is already patched above — that's the source of truth
    // No need to also patch co.founders
    await logActivity('cofound',u.name+' joined '+co.name+' as a founder',{ticker:co.ticker,userId:u.id,userName:u.name});
    await pushNotification(
      m.company_user_id,'invite',
      '✅ '+u.name+' accepted your founder invitation and has joined '+co.name+'!',
      co.ticker
    );
    toast('You joined '+co.name+' as a founder!');
  } else if(!accept&&co){
    await pushNotification(
      m.company_user_id,'invite',
      '❌ '+u.name+' declined your founder invitation for '+co.name+'.',
      co.ticker
    );
    toast('Invitation declined');
  }
  render();
}

// ── Founder share allocations ─────────────────────────────
async function requestFounderAllocation(ticker,studentId,shares,reason){
  if(!ticker)return toast('Select a share class');
  if(!studentId)return toast('Select a founder');
  const stock=getCo(ticker);if(!stock)return toast('Share class "'+ticker+'" not found — is the company listed?');
  if(!canManageCompany(stock))return toast('Only this company\'s owner or founders can request an allocation for it');
  const student=getUser(studentId);if(!student)return toast('Student not found');
  shares=parseInt(shares);
  if(isNaN(shares)||shares<=0)return toast('Enter a valid share count');
  if(shares>stock.shares_avail)return toast('Only '+stock.shares_avail+' shares available in '+ticker);
  // Check for duplicate pending
  if(DB.founderAllocations.find(a=>a.ticker===ticker&&a.student_id===studentId&&a.status==='pending'))
    return toast('Already a pending allocation for '+student.name+' in '+ticker);
  const meta=getClassMeta(ticker);
  const classLabel=meta?'Class '+meta.class:'base';
  // Use parent company name not share class name
  const parentTicker=meta?meta.parent_ticker:ticker;
  const parentCo=getCo(parentTicker);
  const companyName=parentCo?parentCo.name:stock.name;
  const rec={id:uid(),ticker,company_name:companyName,student_id:studentId,student_name:student.name,shares,status:'pending',reason:(reason||'').trim(),ts:ts()};
  try{
    const result=await sb.post('jex_founder_allocations',rec);
    DB.founderAllocations.push(rec);
    await logActivity('founder_alloc',companyName+' requested '+shares+' '+classLabel+' founder shares for '+student.name,{ticker});
    toast('✓ Allocation request submitted: '+shares+'×'+ticker+' for '+student.name);
    render();
  }catch(err){
    console.error('Founder alloc error:',err);
    toast('Error submitting request: '+err.message);
  }
}
async function reviewFounderAllocation(id,approve){
  const a=DB.founderAllocations.find(x=>x.id===id);if(!a)return;
  // Reviewing (especially approving, which grants free shares) runs
  // server-side (rpc_review_founder_allocation) -- previously ANY
  // authenticated client could approve ANY pending allocation, including
  // their own, since only requesting one was gated to the company's owner
  // or founders; approving it was never checked at all.
  let r;
  try{r=await sb.rpc('rpc_review_founder_allocation',{p_id:id,p_approve:approve});}
  catch(e){return toast(rpcErrorMessage(e));}
  a.status=approve?'approved':'rejected';
  if(approve){
    const localStudent=getUser(a.student_id);
    if(localStudent)localStudent.holdings=r.holdings;
    const co=getCo(a.ticker);if(co)co.shares_avail=r.shares_avail;
    await pushNotification(a.student_id,'founder_alloc','🎁 '+a.shares+' founder shares of '+a.company_name+' ('+a.ticker+') have been added to your portfolio!',a.ticker);
    await logActivity('founder_alloc',a.student_name+' granted '+a.shares+' founder shares of '+a.company_name,{ticker:a.ticker,amount:a.shares});
    toast('✓ '+a.student_name+' granted '+a.shares+'×'+a.ticker+' — portfolio updated');
  } else {
    await pushNotification(a.student_id,'founder_alloc','❌ Your founder share request for '+a.shares+'×'+a.ticker+' in '+a.company_name+' was rejected.');
    toast('Allocation rejected');
  }
  render();
}

// ═══════════════════════════════════════════════
// STOCK PRICE ADJUSTMENT (Chairman)
// ═══════════════════════════════════════════════
// Price adjustment runs server-side (rpc_adjust_stock_price), re-checking
// the Chairman/President role itself rather than trusting the client-side
// isChairman() gate.
async function adjustStockPrice(ticker,pct,reason){
  if(!isChairman(cu()))return toast('Only the Chairman or President can adjust stock prices');
  if(!ticker)return toast('Select a ticker');
  pct=parseFloat(pct);
  if(isNaN(pct)||pct===0)return toast('Enter a non-zero percentage');
  if(Math.abs(pct)>100)return toast('Max adjustment is ±100%');
  const co=getCo(ticker);if(!co)return;
  const u=cu();
  const oldPrice=co.price;
  let r;
  try{r=await sb.rpc('rpc_adjust_stock_price',{p_ticker:ticker,p_pct:pct,p_reason:(reason||'').trim()});}
  catch(e){return toast(rpcErrorMessage(e));}
  co.price=r.price;co.price_history=r.price_history;
  const rec={id:uid(),ticker,company_name:co.name,pct,old_price:r.old_price,new_price:r.price,reason:(reason||'').trim(),applied_by:u.name,ts:ts()};
  if(!DB.priceAdjustments)DB.priceAdjustments=[];DB.priceAdjustments.unshift(rec);
  const msg=(pct>=0?'📈':'📉')+' '+co.name+' ('+ticker+') price '+(pct>=0?'boosted by +':'cut by ')+Math.abs(pct)+'%'+(reason?' — '+reason.trim():'');
  const holderIds=DB.users.filter(hu=>hu.role==='student'&&(holdings(hu)[ticker]||0)>0).map(hu=>hu.id);
  await pushNotificationToHolders(ticker,'price_adj',msg);
  await pushNotificationToAll('price_adj',msg,holderIds);
  await logActivity('price_adj',msg,{ticker,userId:u.id,userName:u.name,amount:r.price-oldPrice});
  toast(ticker+' '+(pct>=0?'boosted':'cut')+' by '+Math.abs(pct)+'% → '+fmt(r.price));render();
}

// ═══════════════════════════════════════════════
// FOUNDERS & CO-FOUNDERS
// ═══════════════════════════════════════════════
function isFounder(ticker,userId){
  const co=getCo(ticker);if(!co)return false;
  return DB.companyMembers.some(m=>m.company_user_id===co.owner_id&&m.student_id===userId&&m.status==='accepted');
}
function canManageCompany(co){
  const u=cu();if(!u)return false;
  if(co.owner_id===u.id)return true; // original owner (company account)
  return isFounder(co.ticker,u.id);  // or a founder student
}

// addFounderAtRegistration removed — founders use jex_company_members

// removeFounder v1 removed

// ═══════════════════════════════════════════════
// PRICE ADJUSTMENTS (Chairman tool)
// ═══════════════════════════════════════════════
// applyPriceAdjustment removed (use adjustStockPrice)

// ═══════════════════════════════════════════════
// CO-FOUNDER SYSTEM
// ═══════════════════════════════════════════════

async function removeFounder(memberId,name){
  const m=DB.companyMembers.find(x=>x.id===memberId);if(!m)return;
  const targetCo=DB.companies.find(c=>c.owner_id===m.company_user_id);
  if(!targetCo||!canManageCompany(targetCo))return toast('Only this company\'s owner or founders can remove a founder');
  if(!confirm('Remove '+name+' as a founder? They will lose access to manage this company.'))return;
  // Runs server-side (rpc_remove_founder), re-checking the same
  // owner-or-founder rule above -- it was client-side only.
  try{await sb.rpc('rpc_remove_founder',{p_member_id:memberId});}
  catch(e){return toast(rpcErrorMessage(e));}
  m.status='removed';
  const co=DB.companies.find(c=>c.owner_id===m.company_user_id);
  const u=cu();
  if(co){
    await pushNotification(m.student_id,'invite','❌ You have been removed as a founder of '+co.name+'.',co.ticker);
    await logActivity('cofound',name+' removed as founder of '+co.name,{ticker:co.ticker,userId:u.id,userName:u.name});
  }
  toast(name+' removed as founder');render();
}
async function sendFounderInvite(ownerId,studentId){
  // ownerId = co.owner_id (the company user's id)
  const co=DB.companies.find(c=>c.owner_id===ownerId);
  if(!co)return toast('Company not found');
  if(!canManageCompany(co))return toast('Only this company\'s owner or founders can invite a founder');
  const student=getUser(studentId);if(!student)return toast('Student not found');
  const existing=DB.companyMembers.filter(m=>m.company_user_id===ownerId&&m.status!=='declined');
  if(existing.length>=3)return toast('Maximum 3 founders reached');
  if(existing.find(m=>m.student_id===studentId))return toast(student.name+' is already invited or a member');
  // Runs server-side (rpc_send_founder_invite), re-checking the same
  // owner-or-founder rule above -- it was client-side only, so a raw
  // POST could create a "pending" invite naming yourself as the student
  // for ANY company, then self-accept it via rpc_respond_to_invite
  // (which only ever checks the invite is addressed to you) to gain
  // founder-level rights over a company you have no relationship to.
  const u=cu();
  let rec;
  try{rec=await sb.rpc('rpc_send_founder_invite',{p_owner_id:ownerId,p_student_id:studentId});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.companyMembers.push(rec);
  await pushNotification(
    studentId,'invite',
    '🤝 '+u.name+' has invited you to join '+co.name+' as a founder. Accept or decline below.',
    co.ticker
  );
  toast('Invitation sent to '+student.name);render();
}

// (respondToInvite uses jex_company_members)

// ═══════════════════════════════════════════════
// PRICE ADJUSTMENT (Chairman)
// ═══════════════════════════════════════════════
// applyPriceAdjustment removed (use adjustStockPrice)

// ═══════════════════════════════════════════════
// COMPLIANCE FLAGS
// ═══════════════════════════════════════════════
async function flagAccount(targetId,targetName,targetType,reason){
  if(!reason||reason.trim().length<5)return toast('Enter a reason (at least 5 characters)');
  const u=cu();
  const rec={id:uid(),target_id:targetId,target_name:targetName,target_type:targetType,
    reason:reason.trim(),flagged_by:u.id,flagged_by_name:u.name,
    status:'open',resolution_note:null,resolved_by:null,ts:ts()};
  await sb.post('jex_flags',rec);
  DB.flags.push(rec);
  // Notify Chairman and President
  const admins=DB.users.filter(u2=>u2.role==='chairman'||u2.role==='president');
  for(const a of admins){
    await pushNotification(a.id,'flag','🚩 Compliance flag: '+targetName+' ('+targetType+') — '+reason.trim(),null);
  }
  await logActivity('flag','🚩 '+u.name+' flagged '+targetName+' ('+targetType+'): '+reason.trim(),{userId:u.id,userName:u.name});
  toast('🚩 '+targetName+' flagged and Chairman notified');render();
}
async function resolveFlag(flagId,action,note){
  const f=DB.flags.find(x=>x.id===flagId);if(!f)return;
  const u=cu();
  // Runs server-side (rpc_admin_resolve_flag) -- this had NO check at all
  // before (compliance flags could be resolved/dismissed by anyone).
  let r;
  try{r=await sb.rpc('rpc_admin_resolve_flag',{p_flag_id:flagId,p_action:action,p_note:note||''});}
  catch(e){return toast(rpcErrorMessage(e));}
  if(!r.resolved)return toast('This flag was already resolved');
  f.status=action;f.resolution_note=(note||'').trim();f.resolved_by=u.name;
  await logActivity('flag_resolve',u.name+' '+(action==='resolved'?'resolved':'dismissed')+' flag on '+f.target_name+(note?' — '+note:''),{userId:u.id,userName:u.name});
  toast('Flag '+(action==='resolved'?'resolved':'dismissed'));render();
}
function flagForm(targetId,targetType){
  const targetName=targetType==='company'?(DB.companies.find(c=>c.owner_id===targetId)?.name||'Unknown'):(getUser(targetId)?.name||'Unknown');
  const reason=prompt('Reason for flagging '+targetName+':');
  if(reason===null)return;
  if(!reason||reason.trim().length<5)return toast('Enter a reason (at least 5 characters)');
  flagAccount(targetId,targetName,targetType,reason);
}

// ═══════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════

// Sharpe ratio: (avg session return - risk free) / stddev of returns
// Uses NW history snapshots for the student
function calcSharpe(userId){
  const snaps=DB.nwHistory.filter(n=>n.user_id===userId).sort((a,b)=>a.ts>b.ts?1:-1);
  if(snaps.length<3)return null;
  const returns=[];
  for(let i=1;i<snaps.length;i++){
    const prev=snaps[i-1].nw,curr=snaps[i].nw;
    if(prev>0)returns.push((curr-prev)/prev);
  }
  if(returns.length<2)return null;
  const avg=returns.reduce((s,r)=>s+r,0)/returns.length;
  const variance=returns.reduce((s,r)=>s+Math.pow(r-avg,2),0)/returns.length;
  const stddev=Math.sqrt(variance);
  if(stddev===0)return null;
  // Annualised-ish: risk-free=0 for classroom context
  return Math.round((avg/stddev)*100)/100;
}

// Portfolio beta vs exchange index (market-cap weighted)
function calcBeta(userId){
  const u=getUser(userId);if(!u)return null;
  // Excludes JXI itself -- it wouldn't make sense as a constituent of the
  // "market returns" benchmark it's meant to track.
  const listed=DB.companies.filter(c=>c.status==='listed'&&!c.is_index_fund);
  if(!listed.length)return null;
  // Build market returns from company price histories
  const mktPrices=listed.map(c=>c.price_history||[]);
  if(!mktPrices.length)return null;
  // Simplified: beta = correlation of portfolio value to total market cap change
  const mySnaps=DB.nwHistory.filter(n=>n.user_id===userId).sort((a,b)=>a.ts>b.ts?1:-1).slice(-20);
  if(mySnaps.length<4)return null;
  const myRet=[];for(let i=1;i<mySnaps.length;i++){const p=mySnaps[i-1].nw,c=mySnaps[i].nw;myRet.push(p>0?(c-p)/p:0);}
  // Market return proxy: avg of all company price changes
  const mktRet=listed.map(co=>{
    const h=co.price_history||[];if(h.length<2)return 0;
    return(h[h.length-1].p-h[0].p)/h[0].p;
  });
  const avgMktRet=mktRet.reduce((s,r)=>s+r,0)/Math.max(mktRet.length,1);
  const avgMyRet=myRet.reduce((s,r)=>s+r,0)/Math.max(myRet.length,1);
  if(Math.abs(avgMktRet)<0.0001)return 1;
  return Math.round((avgMyRet/avgMktRet)*100)/100;
}

// Value at Risk (95% confidence, 1-session horizon)
// Based on historical portfolio price moves
function calcVaR(userId){
  const u=getUser(userId);if(!u)return null;
  const mySnaps=DB.nwHistory.filter(n=>n.user_id===userId).sort((a,b)=>a.ts>b.ts?1:-1).slice(-30);
  if(mySnaps.length<5)return null;
  const losses=[];
  for(let i=1;i<mySnaps.length;i++){
    const change=mySnaps[i].nw-mySnaps[i-1].nw;
    if(change<0)losses.push(Math.abs(change));
  }
  if(!losses.length)return 0;
  losses.sort((a,b)=>b-a);
  const idx=Math.floor(losses.length*0.05);
  return Math.round(losses[idx]||losses[0]);
}

// P&L Attribution: break down gains by source
function calcPnLAttribution(userId){
  const u=getUser(userId);if(!u)return null;
  const myTrades=DB.trades.filter(t=>t.buyer_id===userId||t.seller_id===userId);
  let tradePnL=0,divPnL=0,shortPnL=0,unrealised=0;
  // Dividends
  DB.dividends.forEach(d=>{
    const p=(d.payouts||[]).find(x=>x.userId===userId);
    if(p)divPnL+=p.payout;
  });
  // Trade P&L (realised sells minus cost basis)
  const bought={},boughtVal={};
  myTrades.forEach(t=>{
    if(t.buyer_id===userId){bought[t.ticker]=(bought[t.ticker]||0)+t.qty;boughtVal[t.ticker]=(boughtVal[t.ticker]||0)+t.qty*t.price;}
    else{const avgCost=boughtVal[t.ticker]&&bought[t.ticker]?boughtVal[t.ticker]/bought[t.ticker]:t.price;tradePnL+=t.qty*(t.price-avgCost);}
  });
  // Unrealised
  Object.entries(holdings(u)).forEach(([ticker,qty])=>{
    const co=getCo(ticker);if(!co||!qty)return;
    const avgCost=boughtVal[ticker]&&bought[ticker]?boughtVal[ticker]/bought[ticker]:co.price;
    unrealised+=qty*(co.price-avgCost);
  });
  // Short P&L
  const sh=shorts(u)||{};
  Object.entries(sh).forEach(([ticker,pos])=>{
    const co=getCo(ticker);if(!co||!pos)return;
    shortPnL+=(pos.avgPrice-co.price)*pos.qty;
  });
  return{
    trade:Math.round(tradePnL*100)/100,
    dividend:Math.round(divPnL*100)/100,
    short:Math.round(shortPnL*100)/100,
    unrealised:Math.round(unrealised*100)/100,
    total:Math.round((tradePnL+divPnL+shortPnL+unrealised)*100)/100
  };
}

// Company health score (0-100)
function calcHealthScore(co){
  if(!co||co.status!=='listed')return null;
  // A cash-cushion/short-interest/dividend-history score doesn't mean
  // anything for an index fund with no owner, no financials, and no
  // dividends -- the table already renders "—" for a null score.
  if(co.is_index_fund)return null;
  let score=50;
  // Price stability (less volatile = better, up to +20)
  const h=co.price_history||[];
  if(h.length>=2){
    const prices=h.slice(-10).map(p=>p.p);
    const avg=prices.reduce((s,p)=>s+p,0)/prices.length;
    const vola=prices.reduce((s,p)=>s+Math.abs(p-avg)/avg,0)/prices.length;
    score+=Math.max(-20,Math.min(20,Math.round((0.1-vola)*200)));
  }
  // Cash position (more cash = healthier, up to +15)
  const owner=getUser(co.owner_id);
  if(owner){
    const cashRatio=owner.cash/(co.price*co.shares||1);
    score+=Math.min(15,Math.round(cashRatio*30));
  }
  // Short interest penalty (high short = risky, up to -15)
  const totalShorted=DB.users.filter(u=>u.role==='student').reduce((s,u)=>{
    const sh=u.shorts||{};return s+(sh[co.ticker]?.qty||0);
  },0);
  const shortPct=co.shares>0?totalShorted/co.shares:0;
  score-=Math.min(15,Math.round(shortPct*100));
  // Dividend consistency (+10 if paid dividends)
  const divs=DB.dividends.filter(d=>d.ticker===co.ticker);
  if(divs.length>=2)score+=10;
  else if(divs.length===1)score+=5;

  return Math.max(0,Math.min(100,Math.round(score)));
}

// Short squeeze detection
function checkShortSqueezes(){
  if(!isOpen())return;
  DB.companies.filter(c=>c.status==='listed').forEach(co=>{
    const totalShorted=DB.users.filter(u=>u.role==='student').reduce((s,u)=>{
      return s+(u.shorts&&u.shorts[co.ticker]?u.shorts[co.ticker].qty:0);
    },0);
    const shortPct=co.shares>0?totalShorted/co.shares:0;
    if(shortPct<0.15)return; // not enough short interest
    const priceChgPct=priceChg(co)/100;
    if(priceChgPct>0.1){ // price up 10%+ with high short interest
      // NOTE: this dedup key is per-browser (localStorage), not shared across
      // clients, so several simultaneously-open sessions can each independently
      // send one copy of this alert. Low severity (a notification-only duplicate,
      // no money/shares involved) — left as-is rather than shipping a fix that
      // depends on an unverified new production column, given today's incidents
      // already came from that exact mistake. A real fix needs a dedicated
      // per-company column (e.g. squeeze_alert_date) claimed the same atomic way
      // as the stop-loss/price-alert/limit-order fixes, added deliberately with
      // the production schema verified first.
      const key='squeeze_'+co.ticker+'_'+new Date().toDateString();
      if(localStorage.getItem(key))return; // already notified today
      localStorage.setItem(key,'1');
      pushNotificationToAll('halt','🔥 Short squeeze alert: '+co.name+' ('+co.ticker+') is up '+Math.round(priceChgPct*100)+'% with '+Math.round(shortPct*100)+'% short interest. Short sellers may be forced to cover.');
    }
  });
}

// ═══════════════════════════════════════════════
// STOP-LOSS ORDERS
// ═══════════════════════════════════════════════
async function placeStopLoss(ticker,triggerPrice){
  const u=cu(),co=getCo(ticker);if(!u||!co)return;
  if(co.is_index_fund)return toast('Stop-loss orders aren\'t available for JXI yet');
  triggerPrice=parseFloat(triggerPrice);
  if(isNaN(triggerPrice)||triggerPrice<=0)return toast('Enter a valid trigger price');
  if(triggerPrice>=co.price)return toast('Stop-loss must be below current price ('+fmt(co.price)+')');
  const held=(holdings(u)[ticker])||0;
  if(held<=0)return toast('You don&#39;t hold any '+ticker+' shares');
  // Runs server-side (rpc_place_stop_loss), which derives the caller and
  // their real held shares itself instead of trusting this client-built
  // { user_id, shares } -- a raw POST here used to let anyone create a
  // stop-loss order on ANY other user's account with a trigger price at
  // or above the current price, force-selling their real shares the
  // instant any client's poll loop checked it, with zero consent.
  let rec;
  try{rec=await sb.rpc('rpc_place_stop_loss',{p_ticker:ticker,p_trigger_price:triggerPrice});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.stopLossOrders=DB.stopLossOrders.filter(s=>!(s.user_id===u.id&&s.ticker===ticker&&s.status==='active'));
  DB.stopLossOrders.push(rec);
  toast('Stop-loss set: sell '+held+'×'+ticker+' if price drops to '+fmt(triggerPrice));render();
}
function doPlaceStopLoss(ticker){
  placeStopLoss(ticker,document.getElementById('sl-price-'+ticker)?.value);
}
async function cancelStopLoss(id){
  const s0=DB.stopLossOrders.find(x=>x.id===id);
  if(!s0||s0.user_id!==cu()?.id)return toast('You can only cancel your own stop-loss orders');
  // Runs server-side (rpc_cancel_stop_loss), re-checking the same
  // ownership rule above -- it was client-side only.
  try{await sb.rpc('rpc_cancel_stop_loss',{p_id:id});}
  catch(e){return toast(rpcErrorMessage(e));}
  const s=DB.stopLossOrders.find(x=>x.id===id);if(s)s.status='cancelled';
  toast('Stop-loss cancelled');render();
}
// Stop-loss auto-sells are executed server-side (rpc_trigger_stop_loss --
// see stop_loss_engine_migration.sql): every logged-in client polls and
// independently notices a crossed trigger, but the RPC itself re-verifies
// the trigger condition and the atomic active->triggered claim, rather than
// trusting whatever the client PATCHed. The local price check below is
// just a cheap filter so an obviously-not-due order doesn't round-trip to
// the server on every 15s tick -- not the actual security boundary.
async function checkStopLossOrders(){
  if(!isOpen())return;
  const active=DB.stopLossOrders.filter(s=>s.status==='active');
  for(const sl of active){
    const co=getCo(sl.ticker);if(!co)continue;
    if(co.price>sl.trigger_price)continue; // not (locally) triggered yet
    let r;
    try{r=await sb.rpc('rpc_trigger_stop_loss',{p_stop_loss_id:sl.id});}catch(e){continue;}
    if(!r||!r.triggered){
      if(r&&r.reason==='no_shares_held')sl.status='cancelled';
      else if(r&&r.reason==='not_active')sl.status='triggered'; // another client already claimed it
      continue;
    }
    sl.status='triggered';
    const u=getUser(r.user_id);
    if(u){u.cash=r.cash;u.holdings=r.holdings;}
    co.price=r.price;co.shares_avail=r.shares_avail;co.price_history=r.price_history;
    if(r.trade)DB.trades.push(r.trade);
    await pushNotification(r.user_id,'stop_loss','🛑 Stop-loss triggered: sold '+r.sell_qty+'×'+sl.ticker+' @ '+fmt(r.price)+' (trigger: '+fmt(sl.trigger_price)+')',sl.ticker);
    await logActivity('stop_loss',(u?u.name:'Someone')+' stop-loss triggered on '+sl.ticker+' @ '+fmt(r.price),{ticker:sl.ticker,userId:r.user_id,userName:u?u.name:'',amount:r.sell_qty*r.price});
    toast('Stop-loss triggered'+(u?' for '+u.name:'')+': sold '+r.sell_qty+'×'+sl.ticker+' @ '+fmt(r.price));
  }
}
// ═══════════════════════════════════════════════
// NET WORTH HISTORY
// ═══════════════════════════════════════════════
async function snapshotNW(userId){
  const u=getUser(userId);if(!u||u.role!=='student')return;
  const _nw=nw(u),_pv=pv(u);
  const rec={id:uid(),user_id:userId,nw:_nw,cash:Math.round(u.cash*100)/100,portfolio:Math.round(_pv*100)/100,ts:ts()};
  try{await sb.post('jex_nw_history',rec);DB.nwHistory.push(rec);}catch(e){}
}
// ═══════════════════════════════════════════════
// PRICE ALERTS
// ═══════════════════════════════════════════════
async function addPriceAlert(ticker,targetPrice,direction){
  const u=cu();if(!u)return;
  targetPrice=parseFloat(targetPrice);
  if(isNaN(targetPrice)||targetPrice<=0)return toast('Enter a valid price');
  if(!direction)return toast('Select above or below');
  // Runs server-side (rpc_add_price_alert), which derives the caller from
  // their own session instead of trusting this client-supplied user_id --
  // a raw POST here used to let anyone plant a spoofed price-alert
  // notification in ANY other real account (confirmed live: the foreign
  // key on user_id only checks the id is real, not that it's yours).
  let rec;
  try{rec=await sb.rpc('rpc_add_price_alert',{p_ticker:ticker,p_target_price:targetPrice,p_direction:direction});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.priceAlerts.push(rec);
  toast('Alert set: '+ticker+' '+direction+' '+fmt(targetPrice));render();
}
async function deletePriceAlert(id){
  const a0=DB.priceAlerts.find(x=>x.id===id);
  if(!a0||a0.user_id!==cu()?.id)return toast('You can only remove your own price alerts');
  // Runs server-side (rpc_delete_price_alert), re-checking the same
  // ownership rule above -- it was client-side only, so a raw DELETE on
  // jex_price_alerts could remove any user's alert.
  try{await sb.rpc('rpc_delete_price_alert',{p_alert_id:id});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.priceAlerts=DB.priceAlerts.filter(a=>a.id!==id);
  toast('Alert removed');render();
}
async function checkPriceAlerts(){
  const active=DB.priceAlerts.filter(a=>!a.triggered);
  for(const a of active){
    const co=getCo(a.ticker);if(!co)continue;
    const triggered=(a.direction==='above'&&co.price>=a.target_price)||(a.direction==='below'&&co.price<=a.target_price);
    if(!triggered)continue;
    // The actual claim + condition re-check both run server-side now
    // (rpc_trigger_price_alert) -- the local check above is just a cheap
    // filter so an obviously-not-due alert doesn't round-trip on every
    // poll, same as the stop-loss/circuit-breaker polling loops. The RPC
    // re-validates price vs target itself rather than trusting this
    // client-side match.
    let r;
    try{r=await sb.rpc('rpc_trigger_price_alert',{p_id:a.id});}catch(e){continue;}
    if(!r.triggered){if(r.reason==='already_triggered_or_missing')a.triggered=true;continue;}
    a.triggered=true;
    await pushNotification(r.user_id,'price_alert','🎯 Price alert: '+r.ticker+' is '+r.direction+' '+fmt(r.target_price)+' (now '+fmt(r.price)+')',r.ticker);
    toast('Price alert triggered: '+r.ticker+' '+r.direction+' '+fmt(r.target_price));
  }
}

// ═══════════════════════════════════════════════
// CIRCUIT BREAKERS
// ═══════════════════════════════════════════════
async function checkCircuitBreakers(){
  if(!isOpen())return;
  const threshold=DB.session.circuit_breaker_pct||20;
  const openPrices=DB.session.session_open_prices||{};
  for(const co of DB.companies){
    if(isHalted(co.ticker))continue;
    const openPrice=openPrices[co.ticker];
    if(!openPrice)continue;
    const pctMove=Math.abs((co.price-openPrice)/openPrice*100);
    if(pctMove>=threshold){
      // Every logged-in client runs this same check independently; a stale local
      // isHalted() alone isn't enough to stop two clients from both halting the
      // same ticker at once (harmless functionally — resumeStock deletes by
      // ticker, not id — but it does double the halt notification/activity log).
      // Refetch fresh right before acting to close most of that window.
      const freshHalts=await sb.get('jex_halts','ticker=eq.'+co.ticker);
      if(freshHalts.length){DB.halts.push(...freshHalts.filter(h=>!DB.halts.some(x=>x.ticker===h.ticker)));continue;}
      const reason='Circuit breaker: '+co.ticker+' moved '+Math.round(pctMove)+'% from session open (threshold: '+threshold+'%)';
      await haltStock(co.ticker,reason,true);
      toast('⚡ Circuit breaker triggered on '+co.ticker+' — trading halted');
      // Auto-resume after 5 minutes
      setTimeout(async()=>{
        if(isHalted(co.ticker))await resumeStock(co.ticker,true);
      },5*60*1000);
    }
  }
}
// jxi_open_value/session_started_at anchor the JXI headline %-change and the
// 1D chart view to THIS trading day's open, the same way a real index's
// "today" numbers reset every morning instead of showing change since
// inception. Every connected client (any role, not just Chairman/President)
// can independently be the one to first observe a session-open transition or
// a day rollover -- via Realtime, the scheduler poll, or the daily-reset
// check -- and needs to be able to record this, so this goes through its own
// narrowly-scoped RPC (server-recomputes the snapshot from the authoritative
// jex_companies prices itself, never trusting client-submitted values)
// instead of the Chairman/President-gated rpc_admin_save_session used for
// actual session control. The RPC is itself idempotent within the same
// Arizona calendar day, so redundant/racing calls from multiple clients
// detecting the same transition are harmless no-ops after the first one.
async function recordSessionOpenPrices(){
  let r;
  try{r=await sb.rpc('rpc_record_session_open_prices',{});}catch(e){return;}
  if(r&&r.session)Object.assign(DB.session,r.session);
}

// ═══════════════════════════════════════════════
// EARNINGS SURPRISE
// ═══════════════════════════════════════════════




// ═══════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════
// ── Browser push notifications ───────────────────────────
let _pushEnabled=false;
async function requestPushPermission(){
  if(!('Notification' in window))return false;
  if(Notification.permission==='granted'){_pushEnabled=true;return true;}
  if(Notification.permission==='denied')return false;
  const p=await Notification.requestPermission();
  _pushEnabled=p==='granted';return _pushEnabled;
}
function showBrowserPush(title,body){
  if(typeof Notification==='undefined')return;
  if(Notification.permission!=='granted'){_pushEnabled=false;return;}
  // Chrome works best with minimal options
  try{
    const opts={body:body.replace(/[^-]/g,'').trim()||body,tag:'jex-notif',renotify:true};
    const n=new Notification('JEX — '+title,opts);
    n.onclick=()=>{window.focus();n.close();};
    setTimeout(()=>{try{n.close();}catch(e){}},7000);
  }catch(e){
    // Fallback: ServiceWorker registration for Chrome
    if(navigator.serviceWorker&&navigator.serviceWorker.controller){
      navigator.serviceWorker.controller.postMessage({type:'PUSH',title:'JEX — '+title,body});
    }
  }
}
// Restore permission on page load
if(typeof Notification!=='undefined'&&Notification.permission==='granted')_pushEnabled=true;

// ── Email via EmailJS ────────────────────────────────────
// sendEmailNotification()/emailjs.send() is gone -- the EmailJS private key
// now lives server-only (jex_email_secrets) and dispatch happens inside
// rpc_push_notification() via pg_net (see email-pii-exposure-fix migration).

async function pushNotification(userId, type, message, ticker=null){
  try{
    // jex_notifications INSERT is revoked from anon/authenticated entirely
    // now (see the email-pii-exposure-fix migration) -- this RPC is the
    // only way to create one, and does the recipient's email dispatch
    // server-side (pg_net -> EmailJS) in the same call, best-effort.
    const rec=await sb.rpc('rpc_push_notification',{p_user_id:userId,p_type:type,p_message:message,p_ticker:ticker});
    if(userId===UI.userId){
      DB.notifications.unshift(rec);
      // Fire browser push for current user
      const titles={
        dividend:'💰 Dividend received',halt:'⚠️ Trading halted',
        stop_loss:'🛑 Stop-loss triggered',limit_fill:'⚡ Order filled',
        after_hours:'⏰ After-hours order',invite:'🤝 Founder invite',
        ipo:'🏢 IPO update',session:'🕐 Session update',
        price_alert:'🔔 Price alert',resume:'✅ Trading resumed',
        founder_alloc:'🎁 Founder shares',flag:'🚩 Flag raised',bug_report:'🐛 Bug report',contact_admin:'✉️ New message'
      };
      showBrowserPush(titles[type]||'Notification',message);
    }
  }catch(e){console.warn('Notification failed:',e);}
}


async function pushNotificationToHolders(ticker,type,message){
  const holders=DB.users.filter(u=>u.role==='student'&&(holdings(u)[ticker]||0)>0);
  for(const u of holders) await pushNotification(u.id,type,message,ticker);
}
async function pushNotificationToAll(type,message,excludeIds=[]){
  const students=DB.users.filter(u=>u.role==='student'&&u.status==='approved'&&!excludeIds.includes(u.id));
  for(const u of students) await pushNotification(u.id,type,message);
}
async function markAllRead(){
  const unread=DB.notifications.filter(n=>n.user_id===UI.userId&&!n.read);
  // Runs server-side (rpc_mark_notifications_read), scoped to the
  // caller's own rows via auth.uid() rather than a client-supplied id.
  try{await sb.rpc('rpc_mark_notifications_read',{});}catch(e){return;}
  for(const n of unread)n.read=true;
  render();
}
function myUnreadCount(){
  return DB.notifications.filter(n=>n.user_id===UI.userId&&!n.read).length;
}
function myNotifications(){
  return DB.notifications.filter(n=>n.user_id===UI.userId).slice(0,50);
}

// ═══════════════════════════════════════════════
// MARKET HALTS
// ═══════════════════════════════════════════════
function isHalted(ticker){return !!DB.halts.find(h=>h.ticker===ticker);}
async function resetExchange(){
  if(!isAdmin(cu()))return toast('Admin access required');
  const keepAdmins=await new Promise(resolve=>{
    if(confirm('⚠️ FULL RESET\n\nEverything will be deleted:\n• All students and company accounts\n• All classrooms\n• All listed companies and price history\n• All trades, orders, dividends\n• All votes, news, announcements\n• All notifications, flags, minutes\n• All activity logs, price adjustments\n• All limit orders, stop-loss orders\n• All founder allocations, share classes\n• All snapshots and NW history\n\nChairman, President, Secretary, Treasurer and Compliance Officer accounts will be KEPT.\n\nThis CANNOT be undone.'))resolve(true);
    else resolve(false);
  });
  if(!keepAdmins)return;
  if(!confirm('Last chance — type OK in the next box to confirm total reset.'))return;
  const code=prompt('Type RESET to confirm:');
  if(code!=='RESET')return toast('Reset cancelled — you must type RESET');

  toast('Resetting... please wait');
  try{
    // The entire wipe (every table below, officer cash reset, session
    // reset) now runs server-side in one transaction (rpc_admin_full_reset)
    // instead of ~28 separate direct client DELETEs -- those relied on
    // table-level DELETE grants that were just as wide open as the UPDATE
    // grants final_revoke_migration.sql closed, for every table:
    // jex_trades, jex_dividends, jex_buybacks, jex_limit_orders,
    // jex_stop_loss, jex_notifications, jex_halts, jex_activity, jex_news,
    // jex_announcements, jex_minutes, jex_flags, jex_pending,
    // jex_bug_reports, jex_email_verifications, jex_funds,
    // jex_contact_messages, jex_index_history, jex_ipo_applications,
    // jex_dilution_applications, jex_share_classes, jex_class_applications,
    // jex_founder_allocations, jex_company_members, jex_price_adjustments,
    // jex_price_alerts, jex_nw_history, jex_dividend_approvals, jex_votes,
    // jex_vote_ballots, jex_companies, jex_users, jex_classrooms.
    await sb.rpc('rpc_admin_full_reset',{});
    // Clear local DB state entirely
    DB.users=DB.users.filter(isAdmin);
    DB.users.forEach(u=>{u.cash=0;u.holdings={};u.shorts={};u.watchlist=[];});
    DB.companies=[];DB.trades=[];DB.dividends=[];DB.buybacks=[];
    DB.limitOrders=[];DB.stopLossOrders=[];DB.notifications=[];
    DB.halts=[];DB.activity=[];DB.news=[];DB.announcements=[];
    DB.minutes=[];DB.flags=[];DB.pending=[];DB.ipoApps=[];DB.bugReports=[];DB.funds=[];DB.contactMessages=[];DB.indexHistory=[];
    DB.dilApps=[];DB.shareClasses=[];DB.classApps=[];
    DB.founderAllocations=[];DB.companyMembers=[];
    DB.priceAdjustments=[];DB.priceAlerts=[];
    DB.nwHistory=[];DB.votes=[];DB.ballots=[];
    DB.divApprovals=[];DB.classrooms=[];
    UI.classroomFilter=null;UI.lbClassroom=null;
    SHEETS_URL=null;
    // Step 9: Reload fresh from DB
    await loadAll();
    UI.navTab='admin';UI.adminTab='dashboard';UI.companyPage=null;UI.tradePage=0;
    toast('✓ JEX fully reset — clean slate');
    render();
  }catch(err){
    toast('Reset failed: '+err.message);
    console.error('Reset error:',err);
    await loadAll();render();
  }
}
async function haltStock(ticker,reason,systemTriggered=false){
  if(!systemTriggered&&!isAdmin(cu()))return toast('Admin access required');
  if(!ticker)return toast('Select a ticker');
  if(!systemTriggered&&(!reason||reason.trim().length<3))return toast('Enter a reason');
  if(isHalted(ticker))return toast(ticker+' is already halted');
  const u=cu();
  // Runs server-side (rpc_admin_halt_stock) -- the systemTriggered path
  // used to just skip the admin check client-side, so any account could
  // call haltStock(ticker,'fake reason',true) directly and halt anything.
  // The RPC re-validates the circuit-breaker condition itself instead of
  // trusting this boolean.
  let r;
  try{r=await sb.rpc('rpc_admin_halt_stock',{p_ticker:ticker,p_reason:reason||null,p_system_triggered:!!systemTriggered});}
  catch(e){return toast(rpcErrorMessage(e));}
  const rec=r.halt;
  DB.halts.push(rec);
  await logActivity('halt',ticker+' trading halted — '+rec.reason,{ticker,userId:u?.id,userName:rec.halted_by});
  // Notify all students who hold this stock
  const haltedHolderIds=DB.users.filter(hu=>hu.role==='student'&&(holdings(hu)[ticker]||0)>0).map(hu=>hu.id);
  await pushNotificationToHolders(ticker,'halt','⚠️ Trading halted on '+ticker+': '+rec.reason);
  await pushNotificationToAll('halt','⚠️ '+ticker+' trading has been halted: '+rec.reason,haltedHolderIds);
  toast(ticker+' halted');render();
}
async function resumeStock(ticker,systemTriggered=false){
  const u=cu();
  if(!systemTriggered){
    if(!isAdmin(u))return toast('Admin access required');
    if(u.role==='compliance_officer')return toast('Only Chairman or President can resume a halted stock');
    if(!confirm('Resume trading on '+ticker+'?'))return;
  }
  // Runs server-side (rpc_admin_resume_stock) -- same systemTriggered gap
  // as haltStock above: the RPC requires the halt to actually be a
  // circuit-breaker halt with at least 5 real minutes elapsed before
  // honoring a systemTriggered auto-resume, instead of trusting the flag.
  try{await sb.rpc('rpc_admin_resume_stock',{p_ticker:ticker,p_system_triggered:!!systemTriggered});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.halts=DB.halts.filter(h=>h.ticker!==ticker);
  await logActivity('resume',ticker+' trading resumed',{ticker,userId:u?.id,userName:systemTriggered?'System (Circuit Breaker)':u.name});
  await pushNotificationToAll('resume','✅ '+ticker+' trading has resumed');
  toast(ticker+' trading resumed');render();
}

// ═══════════════════════════════════════════════
// ORDER BOOK HELPERS
// ═══════════════════════════════════════════════
function getOrderBook(ticker){
  const open=DB.limitOrders.filter(o=>o.status==='open'&&o.ticker===ticker);
  const bids=open.filter(o=>o.side==='buy').sort((a,b)=>b.limit_price-a.limit_price||new Date(a.created_at)-new Date(b.created_at));
  const asks=open.filter(o=>o.side==='sell').sort((a,b)=>a.limit_price-b.limit_price||new Date(a.created_at)-new Date(b.created_at));
  const bestBid=bids[0]?.limit_price||null;
  const bestAsk=asks[0]?.limit_price||null;
  const spread=bestBid&&bestAsk?Math.round((bestAsk-bestBid)*100)/100:null;
  return{bids,asks,bestBid,bestAsk,spread};
}

// Book-to-book matching and pool fills for resting orders are executed
// server-side (rpc_match_limit_order_book / rpc_fill_limit_vs_pool -- see
// limit_order_engine_migration.sql), closing the gap where matchAgainstBook
// and checkLimitOrders computed both sides of a trade client-side and
// PATCHed jex_users/jex_funds/jex_companies directly for accounts that
// weren't even the caller's own. Placement is now server-side too
// (rpc_place_limit_order): the client can no longer POST an order row
// claiming a user_id/fund_id it doesn't own.
function applyLimitFillToOwner(type,id,cash,holdings){
  if(type==='fund'){const f=getFund(id);if(f){f.cash=cash;f.holdings=holdings;}}
  else{const u=getUser(id);if(u){u.cash=cash;u.holdings=holdings;}}
}
function applyLimitMatchResult(r){
  const co=getCo(r.ticker);if(co){co.price=r.price;co.price_history=r.price_history;}
  if(r.trade)DB.trades.push(r.trade);
  applyLimitFillToOwner(r.buyer_type,r.buyer_id,r.buyer_cash,r.buyer_holdings);
  applyLimitFillToOwner(r.seller_type,r.seller_id,r.seller_cash,r.seller_holdings);
  const bidLocal=DB.limitOrders.find(o=>o.id===r.bid_order_id);
  if(bidLocal){bidLocal.status=r.bid_status;bidLocal.qty=r.bid_qty;if(r.bid_status==='filled')bidLocal.filled_price=r.fill_price;}
  const askLocal=DB.limitOrders.find(o=>o.id===r.ask_order_id);
  if(askLocal){askLocal.status=r.ask_status;askLocal.qty=r.ask_qty;if(r.ask_status==='filled')askLocal.filled_price=r.fill_price;}
  checkPriceAlerts();checkCircuitBreakers();pushBalances();snapshotJXI();
}
function applyLimitPoolFillResult(orderId,r){
  const co=getCo(r.ticker);if(co){co.price=r.price;co.price_history=r.price_history;if('shares_avail'in r)co.shares_avail=r.shares_avail;}
  if(r.trade)DB.trades.push(r.trade);
  applyLimitFillToOwner(r.owner_type,r.owner_id,r.cash,r.holdings);
  if(r.company_owner_id&&r.company_owner_cash!=null){const owner=getUser(r.company_owner_id);if(owner)owner.cash=r.company_owner_cash;}
  const o=DB.limitOrders.find(x=>x.id===orderId);
  if(o){o.status='filled';o.filled_price=r.fill_price;}
  checkPriceAlerts();checkCircuitBreakers();pushBalances();snapshotJXI();
}
// Repeatedly asks the server to match the book (which may resolve OTHER
// pairs too, exactly like the old periodic scan did) until either nothing
// crosses anymore or this specific order stops being open, then tries a
// pool fill for whatever's left. Returns the quantity of THIS order filled.
async function settleLimitOrder(order,cancelIfUnfilled){
  const originalQty=order.qty;
  let filled=0;
  for(let i=0;i<200;i++){
    let r;
    try{r=await sb.rpc('rpc_match_limit_order_book',{p_ticker:order.ticker});}
    catch(e){break;}
    if(!r||!r.matched)break;
    applyLimitMatchResult(r);
    if(r.bid_order_id===order.id||r.ask_order_id===order.id)filled+=r.fill_qty;
    const mine=DB.limitOrders.find(o=>o.id===order.id);
    if(!mine||mine.status!=='open')break;
  }
  let mine=DB.limitOrders.find(o=>o.id===order.id);
  if(mine&&mine.status==='open'){
    const co=getCo(order.ticker);
    const crosses=co&&((order.side==='buy'&&co.price<=order.limit_price)||(order.side==='sell'&&co.price>=order.limit_price));
    if(crosses){
      let pr;
      try{pr=await sb.rpc('rpc_fill_limit_vs_pool',{p_order_id:order.id});}catch(e){pr=null;}
      if(pr&&pr.filled){applyLimitPoolFillResult(order.id,pr);filled+=(originalQty-filled);}
    }
  }
  mine=DB.limitOrders.find(o=>o.id===order.id);
  if(mine&&mine.status==='open'&&cancelIfUnfilled){
    try{await sb.rpc('rpc_cancel_limit_order',{p_order_id:order.id});mine.status='cancelled';}catch(e){}
  }
  return filled;
}
// ── Place a limit order (fundId optional: places on behalf of a fund) ──
async function placeLimitOrder(ticker,side,qty,limitPrice,fundId){
  const co=getCo(ticker);if(!co)return;
  if(co.is_index_fund)return toast('Limit orders aren\'t available for JXI yet — use a market order instead');
  qty=parseInt(qty);limitPrice=parseFloat(limitPrice);
  if(isNaN(qty)||qty<=0)return toast('Enter a valid quantity');
  if(isNaN(limitPrice)||limitPrice<=0)return toast('Enter a valid limit price');
  const orderTypeEl=document.getElementById('limit-order-type');
  const orderType=(orderTypeEl?.value||'gtc').toLowerCase();
  const icebergQtyEl=document.getElementById('limit-iceberg-qty');
  const icebergQty=orderType==='iceberg'&&icebergQtyEl?Math.max(1,parseInt(icebergQtyEl.value)||Math.ceil(qty/4)):null;
  let r;
  try{r=await sb.rpc('rpc_place_limit_order',{p_ticker:ticker,p_side:side,p_qty:qty,p_limit_price:limitPrice,p_order_type:orderType,p_iceberg_visible:icebergQty,p_fund_id:fundId||null});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.limitOrders.push(r.order);
  if(r.status==='after_hours'){
    toast('After-hours order queued: '+qty+'×'+ticker+' @ '+fmt(limitPrice)+' — activates when session opens');
    render();return;
  }
  await logActivity('limit_order',(fundId?getFund(fundId)?.name+"'s fund":cu().name)+' placed limit '+side+' '+qty+'×'+ticker+' @ '+fmt(limitPrice),{ticker,amount:limitPrice});
  const filledQty=await settleLimitOrder(r.order,orderType==='fok');
  if(filledQty>=qty)toast('Limit order fully filled!');
  else if(filledQty>0)toast('Partial fill: '+filledQty+' matched, '+(qty-filledQty)+' queued @ '+fmt(limitPrice));
  else if(orderType!=='fok')toast('Limit '+side+': '+qty+'×'+ticker+' @ '+fmt(limitPrice)+' — waiting for match');
  render();
}

async function activateAfterHoursOrders(){
  const ahOrders=DB.limitOrders.filter(o=>o.status==='after_hours');
  if(!ahOrders.length)return;
  for(const o of ahOrders){
    await sb.patch('jex_limit_orders','id=eq.'+o.id,{status:'open'});
    o.status='open';
    const u=getUser(o.user_id);
    if(u)await pushNotification(u.id,'after_hours','⏰ Your after-hours '+o.side+' order for '+o.qty+'×'+o.ticker+' @ '+fmt(o.limit_price)+' is now active',o.ticker);
  }
  toast(ahOrders.length+' after-hours order'+(ahOrders.length!==1?'s':'')+' activated');
  render();
}
async function cancelLimitOrder(id){
  const o=DB.limitOrders.find(x=>x.id===id);if(!o)return;
  try{await sb.rpc('rpc_cancel_limit_order',{p_order_id:id});}
  catch(e){return toast(rpcErrorMessage(e));}
  o.status='cancelled';
  toast('Order cancelled');render();
}

// ── Periodic check: match crossed orders & fill vs pool ───
async function checkLimitOrders(){
  if(!isOpen())return;
  const openOrders=DB.limitOrders.filter(o=>o.status==='open');
  if(!openOrders.length)return;
  const tickers=[...new Set(openOrders.map(o=>o.ticker))];
  for(const ticker of tickers){
    for(let i=0;i<50;i++){
      let r;
      try{r=await sb.rpc('rpc_match_limit_order_book',{p_ticker:ticker});}
      catch(e){break;}
      if(!r||!r.matched)break;
      applyLimitMatchResult(r);
      const buyerName=r.buyer_type==='fund'?(getFund(r.buyer_id)?.name||'a fund'):(getUser(r.buyer_id)?.name||'someone');
      const sellerName=r.seller_type==='fund'?(getFund(r.seller_id)?.name||'a fund'):(getUser(r.seller_id)?.name||'someone');
      await logActivity('limit_fill',buyerName+' ↔ '+sellerName+': '+r.fill_qty+'×'+ticker+' @ '+fmt(r.fill_price),{ticker,amount:r.fill_price});
      toast(r.fill_qty+'×'+ticker+' matched: '+buyerName+' bought from '+sellerName+' @ '+fmt(r.fill_price));
    }
    for(const o of DB.limitOrders.filter(ord=>ord.ticker===ticker&&ord.status==='open')){
      const co=getCo(ticker);if(!co)continue;
      const shouldFill=(o.side==='buy'&&co.price<=o.limit_price)||(o.side==='sell'&&co.price>=o.limit_price);
      if(!shouldFill)continue;
      let r;
      try{r=await sb.rpc('rpc_fill_limit_vs_pool',{p_order_id:o.id});}
      catch(e){continue;}
      if(!r||!r.filled)continue;
      const qty=o.qty;
      applyLimitPoolFillResult(o.id,r);
      const ownerName=r.owner_type==='fund'?(getFund(r.owner_id)?.name||'a fund'):(getUser(r.owner_id)?.name||'someone');
      await logActivity('limit_fill',ownerName+"'s limit "+o.side+" "+qty+"×"+ticker+" filled vs JEX pool @ "+fmt(r.fill_price),{ticker,amount:r.fill_price});
      if(r.owner_type==='user')await pushNotification(r.owner_id,'limit_fill','⚡ Limit '+o.side+' filled: '+qty+'×'+ticker+' @ '+fmt(r.fill_price),ticker);
      toast(ownerName+"'s limit order filled: "+qty+"×"+ticker+" @ "+fmt(r.fill_price));
    }
  }
}
setInterval(async()=>{await checkLimitOrders();await checkStopLossOrders();await checkPriceAlerts();checkShortSqueezes();},3000);

// ═══════════════════════════════════════════════
// TRADING
// ═══════════════════════════════════════════════
// Market buy/sell/short/cover are executed server-side (rpc_trade_* —
// see trade_engine_migration.sql) so cash/holdings/shares/price can't be
// fabricated by a raw REST call — the client can no longer PATCH those
// columns directly for these four actions. The checks still done here
// (requireOpen, canAccessTicker, funds/qty sanity, etc.) are just fast
// local feedback; the RPC re-derives and re-checks everything itself and
// is the only thing that actually writes the trade.
function rpcErrorMessage(e){
  try{const parsed=JSON.parse(e.message);if(parsed&&parsed.message)return parsed.message;}catch(err){}
  return (e&&e.message)||String(e);
}
function applyTradeResult(ticker,r){
  const u=cu(),co=getCo(ticker);
  if(u){u.cash=r.cash;if('holdings'in r)u.holdings=r.holdings;if('shorts'in r)u.shorts=r.shorts;}
  if(co){co.price=r.price;if('shares_avail'in r)co.shares_avail=r.shares_avail;co.price_history=r.price_history;}
  if(r.owner_id&&r.owner_cash!=null){const owner=getUser(r.owner_id);if(owner)owner.cash=r.owner_cash;}
  // Real backing: minting/redeeming JXI actually buys/sells a basket of its
  // constituents server-side (see rpc_trade_buy/sell's is_index_fund branch)
  // -- apply those price moves immediately instead of waiting for the next
  // poll, so the trader sees the market they just moved right away.
  if(r.constituents)r.constituents.forEach(cu2=>{const c2=getCo(cu2.ticker);if(c2){c2.price=cu2.price;c2.shares_avail=cu2.shares_avail;c2.price_history=cu2.price_history;}});
  if(r.trade)DB.trades.push(r.trade);
  if(u)snapshotNW(u.id);
  checkPriceAlerts();
  checkCircuitBreakers();
  pushBalances();
  snapshotJXI();
  if(r.trade)pushToSheets('trades',{trades:[{ticker,qty:r.trade.qty,price:r.trade.price,type:r.trade.type,ts:r.trade.ts,
    buyer:['exchange','short'].includes(r.trade.buyer_id)?'JEX':getUser(r.trade.buyer_id)?.name||r.trade.buyer_id,
    seller:['exchange','cover'].includes(r.trade.seller_id)?'JEX':getUser(r.trade.seller_id)?.name||r.trade.seller_id}]});
}
async function placeBuy(ticker,qty){
  if(!requireOpen(ticker))return;const u=cu(),co=getCo(ticker);if(!u||!co)return;
  if(!canAccessTicker(ticker,u.id))return toast('This share class is restricted — you are not on the whitelist.');
  if(!checkRateLimit(u.id))return;
  if(u.role==='company'&&co.owner_id===u.id)return toast("You can't buy your own company's stock — use Buyback instead.");
  qty=parseInt(qty);if(isNaN(qty)||qty<=0)return toast('Enter a valid quantity');
  // JXI mints on demand -- shares_avail tracks units outstanding for it (see
  // the is_index_fund branch server-side), not a real liquidity cap, so this
  // fast local check doesn't apply. The server enforces the real limits
  // (funds, session status, halts) either way.
  if(!co.is_index_fund&&co.shares_avail<qty)return toast('Only '+co.shares_avail+' shares available');
  let r;
  try{r=await sb.rpc('rpc_trade_buy',{p_ticker:ticker,p_qty:qty});}
  catch(e){return toast(rpcErrorMessage(e));}
  const oldPrice=r.old_price;
  applyTradeResult(ticker,r);
  const slippage=Math.round((r.price-oldPrice)*100)/100;
  const slipMsg=Math.abs(slippage)>0.01?' (slippage: '+(slippage>0?'+':'')+fmt(slippage)+')':'';
  toast('Bought '+qty+' × '+ticker+' @ '+fmt(r.price)+slipMsg);if(UI.companyPage)render();else openPanel(ticker);
}
async function placeSell(ticker,qty){
  if(!requireOpen(ticker))return;const u=cu(),co=getCo(ticker);if(!u||!co)return;
  if(!checkRateLimit(u.id))return;
  qty=parseInt(qty);if(isNaN(qty)||qty<=0)return toast('Enter a valid quantity');
  const held=(holdings(u)[ticker])||0;if(held<qty)return toast('You only hold '+held+' shares');
  let r;
  try{r=await sb.rpc('rpc_trade_sell',{p_ticker:ticker,p_qty:qty});}
  catch(e){return toast(rpcErrorMessage(e));}
  const oldPrice=r.old_price;
  applyTradeResult(ticker,r);
  const slippageSell=Math.round((oldPrice-r.price)*100)/100;
  const slipMsgSell=Math.abs(slippageSell)>0.01?' (slippage: '+(slippageSell>0?'+':'')+fmt(slippageSell)+')':'';
  toast('Sold '+qty+' × '+ticker+' @ '+fmt(r.price)+slipMsgSell);if(UI.companyPage)render();else openPanel(ticker);
}
async function placeShort(ticker,qty){
  if(!requireOpen(ticker))return;const u=cu(),co=getCo(ticker);if(!u||!co)return;
  if(!canAccessTicker(ticker,u.id))return toast('This share class is restricted — you are not on the whitelist.');
  qty=parseInt(qty);if(isNaN(qty)||qty<=0)return toast('Enter a valid quantity');
  const coll=Math.round(co.price*qty*1.5*100)/100;
  if(u.cash<coll)return toast('Need '+fmt(coll)+' collateral');
  let r;
  try{r=await sb.rpc('rpc_trade_short',{p_ticker:ticker,p_qty:qty});}
  catch(e){return toast(rpcErrorMessage(e));}
  applyTradeResult(ticker,r);
  toast('Shorted '+qty+' × '+ticker+' @ '+fmt(r.trade.price));if(UI.companyPage)render();else openPanel(ticker);
}
async function coverShort(ticker,qty){
  if(!requireOpen(ticker))return;const u=cu(),co=getCo(ticker);if(!u||!co)return;
  qty=parseInt(qty);if(isNaN(qty)||qty<=0)return toast('Enter a valid quantity');
  const short=(shorts(u))[ticker];if(!short||short.qty<qty)return toast('You only have '+(short?.qty||0)+' shorted');
  let r;
  try{r=await sb.rpc('rpc_trade_cover_short',{p_ticker:ticker,p_qty:qty});}
  catch(e){return toast(rpcErrorMessage(e));}
  applyTradeResult(ticker,r);
  toast('Covered '+qty+' × '+ticker+' | P&L: '+(r.pnl>=0?'+':'')+fmt(r.pnl));if(UI.companyPage)render();else openPanel(ticker);
}
async function toggleWatch(ticker){
  const u=cu();if(!u)return;
  const wasWatched=watchlist(u).includes(ticker);
  toast(wasWatched?ticker+' removed from watchlist':ticker+' added to watchlist');
  let r;
  try{r=await sb.rpc('rpc_toggle_watchlist',{p_ticker:ticker});}catch(e){return;}
  u.watchlist=r.watchlist;
  render();
}

// ═══════════════════════════════════════════════
// FUNDS
// ═══════════════════════════════════════════════
const fundUnits=u=>u.fund_units||{};
const MAX_FUND_FEE_PCT=25;
const getFund=id=>DB.funds.find(f=>f.id===id);
const canManageFund=f=>{const u=cu();return !!u&&(u.id===f.manager_id||isChairman(u));};
const fundShortPnl=f=>Object.entries(fundShorts(f)).reduce((s,[t,pos])=>{const c=getCo(t);if(!c)return s;return s+Math.round((pos.avgPrice-c.price)*pos.qty*100)/100;},0);
function currentFundNav(f){
  const holdingsValue=Object.entries(f.holdings||{}).reduce((s,[t,q])=>{const c=getCo(t);return s+(c?c.price*q:0);},0);
  const totalValue=Math.round((f.cash+holdingsValue+fundShortPnl(f))*100)/100;
  return f.units_outstanding>0?Math.round((totalValue/f.units_outstanding)*10000)/10000:10;
}

async function createFund(name,feePct){
  const u=cu();if(!u||u.role!=='company')return toast('Only company accounts can create a fund');
  if(!name||name.trim().length<3)return toast('Enter a fund name (at least 3 characters)');
  feePct=parseFloat(feePct);
  if(isNaN(feePct)||feePct<0||feePct>MAX_FUND_FEE_PCT)return toast('Performance fee must be between 0 and '+MAX_FUND_FEE_PCT+'%');
  // Runs server-side (rpc_create_fund), which always initializes
  // cash/units_outstanding/holdings/shorts to zero/empty itself -- a raw
  // POST here used to let anyone create a fund with an arbitrary
  // fabricated starting cash balance, then spend it on real shares via
  // the legitimate rpc_fund_buy, crediting real money to a real company
  // owner out of nothing.
  let rec;
  try{rec=await sb.rpc('rpc_create_fund',{p_name:name.trim(),p_fee_pct:feePct});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.funds.push(rec);
  await logActivity('fund_create',u.name+' launched a new fund: '+rec.name+' ('+rec.fee_pct+'% performance fee)',{userId:u.id,userName:u.name});
  toast('Fund launched');UI.fundPage=rec.id;render();
}
async function closeFund(fundId){
  const f=getFund(fundId);if(!f)return;
  if(!canManageFund(f))return toast('Only this fund\'s manager or the Chairman can close it');
  if(f.status!=='active')return;
  // Runs server-side (rpc_close_fund), re-checking the same
  // manager-or-Chairman rule above -- it was client-side only.
  try{await sb.rpc('rpc_close_fund',{p_fund_id:fundId});}
  catch(e){return toast(rpcErrorMessage(e));}
  f.status='closed';
  toast('Fund closed to new deposits — existing depositors can still withdraw');render();
}
// Fund deposit/withdraw run server-side (rpc_fund_deposit/rpc_fund_withdraw)
// -- same client-trusted-write gap as everything else in this pass, just on
// the depositor's own cash/fund_units and the fund's cash/units_outstanding.
async function depositToFund(fundId,amount){
  const u=cu();if(!u)return;
  const f=getFund(fundId);if(!f)return toast('Fund not found');
  if(f.status!=='active')return toast('This fund is closed to new deposits');
  amount=parseFloat(amount);
  if(isNaN(amount)||amount<=0)return toast('Enter a valid amount');
  if(u.cash<amount)return toast('Insufficient funds');
  let r;
  try{r=await sb.rpc('rpc_fund_deposit',{p_fund_id:fundId,p_amount:amount});}
  catch(e){return toast(rpcErrorMessage(e));}
  u.cash=r.cash;u.fund_units=r.fund_units;
  f.cash=r.fund_cash;f.units_outstanding=r.units_outstanding;
  await logActivity('fund_deposit',u.name+' deposited '+fmt(amount)+' into '+f.name,{userId:u.id,userName:u.name,amount});
  toast('Deposited '+fmt(amount)+' into '+f.name);render();
}
async function withdrawFromFund(fundId,unitsStr){
  const u=cu();if(!u)return;
  const f=getFund(fundId);if(!f)return toast('Fund not found');
  const position=fundUnits(u)[fundId];
  const held=position?position.units:0;
  const units=parseFloat(unitsStr);
  if(isNaN(units)||units<=0)return toast('Enter a valid number of units');
  if(units>held+0.0001)return toast('You only hold '+held+' units');
  let r;
  try{r=await sb.rpc('rpc_fund_withdraw',{p_fund_id:fundId,p_units:units});}
  catch(e){return toast(rpcErrorMessage(e));}
  u.cash=r.cash;u.fund_units=r.fund_units;
  f.cash=r.fund_cash;f.units_outstanding=r.units_outstanding;
  if(r.fee>0&&r.manager_id){const manager=getUser(r.manager_id);if(manager)manager.cash=r.manager_cash;}
  await logActivity('fund_withdraw',u.name+' withdrew '+fmt(r.net)+' from '+f.name+(r.fee?' (performance fee '+fmt(r.fee)+' to '+f.manager_name+')':''),{userId:u.id,userName:u.name,amount:r.net});
  toast('Withdrew '+fmt(r.net)+' from '+f.name+(r.fee?' (after '+fmt(r.fee)+' performance fee)':''));render();
}
// Fund manager trades are executed server-side (rpc_fund_buy/sell -- see
// fund_trade_engine_migration.sql), the same hardening already applied to
// direct student trades (rpc_trade_*): the client can no longer PATCH
// jex_funds/jex_companies directly to fabricate a fund's cash or holdings.
// The checks below are fast local feedback only; the RPC re-derives and
// re-checks everything and is the only thing that actually writes.
function applyFundTradeResult(fundId,ticker,r){
  const f=getFund(fundId),co=getCo(ticker);
  if(f){f.cash=r.cash;f.holdings=r.holdings;}
  if(co){co.price=r.price;if('shares_avail'in r)co.shares_avail=r.shares_avail;co.price_history=r.price_history;}
  if(r.owner_id&&r.owner_cash!=null){const owner=getUser(r.owner_id);if(owner)owner.cash=r.owner_cash;}
  if(r.trade)DB.trades.push(r.trade);
  checkPriceAlerts();
  checkCircuitBreakers();
  pushBalances();
  snapshotJXI();
}
async function fundBuy(fundId,ticker,qty){
  const f=getFund(fundId);const co=getCo(ticker);if(!f||!co)return;
  if(!requireOpen(ticker))return;
  const u=cu();if(!u||u.id!==f.manager_id)return toast('Only this fund\'s manager can trade on its behalf');
  if(f.status!=='active')return toast('This fund is closed');
  if(co.owner_id===f.manager_id)return toast('A fund cannot trade its own manager\'s company stock — conflict of interest');
  if(!canAccessTicker(ticker,f.manager_id))return toast('This share class is restricted — the fund manager is not on the whitelist.');
  qty=parseInt(qty);if(isNaN(qty)||qty<=0)return toast('Enter a valid quantity');
  if(co.shares_avail<qty)return toast('Only '+co.shares_avail+' shares available');
  let r;
  try{r=await sb.rpc('rpc_fund_buy',{p_fund_id:fundId,p_ticker:ticker,p_qty:qty});}
  catch(e){return toast(rpcErrorMessage(e));}
  applyFundTradeResult(fundId,ticker,r);
  toast('Fund bought '+qty+' × '+ticker+' @ '+fmt(r.price));render();
}
async function fundSell(fundId,ticker,qty){
  const f=getFund(fundId);const co=getCo(ticker);if(!f||!co)return;
  if(!requireOpen(ticker))return;
  const u=cu();if(!u||u.id!==f.manager_id)return toast('Only this fund\'s manager can trade on its behalf');
  if(f.status!=='active')return toast('This fund is closed');
  qty=parseInt(qty);if(isNaN(qty)||qty<=0)return toast('Enter a valid quantity');
  const held=(f.holdings||{})[ticker]||0;if(held<qty)return toast('Fund only holds '+held+' shares');
  let r;
  try{r=await sb.rpc('rpc_fund_sell',{p_fund_id:fundId,p_ticker:ticker,p_qty:qty});}
  catch(e){return toast(rpcErrorMessage(e));}
  applyFundTradeResult(fundId,ticker,r);
  toast('Fund sold '+qty+' × '+ticker+' @ '+fmt(r.price));render();
}
const fundShorts=f=>f.shorts||{};
function applyFundShortResult(fundId,ticker,r){
  const f=getFund(fundId),co=getCo(ticker);
  if(f){f.cash=r.cash;f.shorts=r.shorts;}
  if(co){co.price=r.price;co.price_history=r.price_history;}
  if(r.trade)DB.trades.push(r.trade);
  checkPriceAlerts();
  checkCircuitBreakers();
  pushBalances();
  snapshotJXI();
}
async function fundShort(fundId,ticker,qty){
  const f=getFund(fundId);const co=getCo(ticker);if(!f||!co)return;
  if(!requireOpen(ticker))return;
  const u=cu();if(!u||u.id!==f.manager_id)return toast('Only this fund\'s manager can trade on its behalf');
  if(f.status!=='active')return toast('This fund is closed');
  if(co.owner_id===f.manager_id)return toast('A fund cannot trade its own manager\'s company stock — conflict of interest');
  if(!canAccessTicker(ticker,f.manager_id))return toast('This share class is restricted — the fund manager is not on the whitelist.');
  qty=parseInt(qty);if(isNaN(qty)||qty<=0)return toast('Enter a valid quantity');
  const coll=Math.round(co.price*qty*1.5*100)/100;
  if(f.cash<coll)return toast('Fund needs '+fmt(coll)+' collateral');
  let r;
  try{r=await sb.rpc('rpc_fund_short',{p_fund_id:fundId,p_ticker:ticker,p_qty:qty});}
  catch(e){return toast(rpcErrorMessage(e));}
  applyFundShortResult(fundId,ticker,r);
  toast('Fund shorted '+qty+' × '+ticker+' @ '+fmt(r.trade.price));render();
}
async function fundCoverShort(fundId,ticker,qty){
  const f=getFund(fundId);const co=getCo(ticker);if(!f||!co)return;
  if(!requireOpen(ticker))return;
  const u=cu();if(!u||u.id!==f.manager_id)return toast('Only this fund\'s manager can trade on its behalf');
  if(f.status!=='active')return toast('This fund is closed');
  qty=parseInt(qty);if(isNaN(qty)||qty<=0)return toast('Enter a valid quantity');
  const short=fundShorts(f)[ticker];if(!short||short.qty<qty)return toast('Fund only has '+(short?.qty||0)+' shorted');
  let r;
  try{r=await sb.rpc('rpc_fund_cover_short',{p_fund_id:fundId,p_ticker:ticker,p_qty:qty});}
  catch(e){return toast(rpcErrorMessage(e));}
  applyFundShortResult(fundId,ticker,r);
  toast('Fund covered '+qty+' × '+ticker+' | P&L: '+(r.pnl>=0?'+':'')+fmt(r.pnl));render();
}
async function postFinancials(ticker,period,revenue,profit,summary){
  const co=getCo(ticker);if(!co)return;
  const u=cu();if(!u||u.id!==co.owner_id)return toast('Only the company owner can post financials');
  if(!period||!period.trim())return toast('Enter a period, e.g. Q1 2026');
  revenue=parseFloat(revenue);profit=parseFloat(profit);
  if(isNaN(revenue)||revenue<0)return toast('Enter a valid revenue amount');
  if(isNaN(profit))return toast('Enter a valid profit amount (can be negative for a loss)');
  if(!summary||summary.trim().length<10)return toast('Add a short summary (at least 10 characters)');
  // Runs server-side (rpc_post_financials), re-checking the same
  // owner-only rule above -- it was client-side only.
  let r;
  try{r=await sb.rpc('rpc_post_financials',{p_ticker:ticker,p_period:period.trim(),p_revenue:revenue,p_profit:profit,p_summary:summary.trim()});}
  catch(e){return toast(rpcErrorMessage(e));}
  co.financials=r.financials;
  await pushNotificationToHolders(ticker,'financials','📊 '+co.name+' ('+ticker+') posted financial results for '+r.entry.period+': Revenue '+fmt(revenue)+', Profit '+fmt(profit));
  await logActivity('financials',co.name+' posted financials for '+r.entry.period+' — Rev '+fmt(revenue)+', Profit '+fmt(profit),{ticker,amount:revenue});
  toast('Financial report posted');render();
}
async function updateFundingGoal(ticker,goal,useOfFunds){
  const co=getCo(ticker);if(!co)return;
  if(!canManageCompany(co))return toast('Only this company\'s owner or founders can update the funding goal');
  let g=null;
  if(goal!==''&&goal!=null){
    g=parseFloat(goal);
    if(isNaN(g)||g<0)return toast('Funding goal must be a positive number');
    g=Math.round(g*100)/100;
  }
  const uof=(useOfFunds||'').trim().slice(0,1000)||null;
  // Runs server-side (rpc_update_funding_goal), re-checking the same
  // owner-or-founder rule above -- it was client-side only.
  try{await sb.rpc('rpc_update_funding_goal',{p_ticker:ticker,p_goal:g,p_use_of_funds:uof});}
  catch(e){return toast(rpcErrorMessage(e));}
  co.funding_goal=g;co.use_of_funds=uof;
  toast('Funding goal updated');render();
}
// Buybacks are executed server-side (rpc_buyback) -- besides closing the
// same client-trusted-write gap as every other rpc_* here, the RPC also
// adds the ownership/founder check this function never actually had: any
// authenticated caller could previously invoke doBuyback() for ANY ticker
// and spend their own cash to shrink a company they have no relationship
// to's share count.
async function doBuyback(ticker,qty){
  if(!requireOpen(ticker))return;const owner=cu(),co=getCo(ticker);if(!owner||!co)return;
  qty=parseInt(qty);if(isNaN(qty)||qty<=0)return toast('Enter valid quantity');
  const sold=co.shares-co.shares_avail;if(qty>sold)return toast('Only '+sold+' shares in circulation');
  let r;
  try{r=await sb.rpc('rpc_buyback',{p_ticker:ticker,p_qty:qty});}
  catch(e){return toast(rpcErrorMessage(e));}
  owner.cash=r.cash;
  co.price=r.price;co.shares=r.shares;co.price_history=r.price_history;
  if(r.buyback)DB.buybacks.push(r.buyback);
  toast('Bought back '+qty+' shares @ '+fmt(r.price));render();
}
// Dividend payout itself runs server-side (rpc_pay_dividend) -- the RPC
// re-derives the shareholder list and total, and now enforces the
// Treasurer-approval-above-threshold rule itself too (previously that was
// only a client-side confirm() gate; a company owner could call
// issueDividend(...,preApproved=true) directly and skip Treasurer review
// for any payout size). Everything below the RPC call is just fast local
// preview/confirm UX, not the security boundary.
async function issueDividend(ticker,perShare,note){
  const co=getCo(ticker),owner=cu();if(!co||!owner)return;
  perShare=Math.round(parseFloat(perShare)*100)/100;
  if(isNaN(perShare)||perShare<=0)return toast('Enter a valid per-share amount');
  if(!note||note.trim().length<5)return toast('Please add a note');
  // Fetch all students fresh from Supabase so founder-allocated holdings are current
  const freshStudents=await sb.get('jex_users','role=eq.student&status=eq.approved&select='+JEX_USERS_SAFE_SELECT);
  freshStudents.forEach(fs=>{const local=getUser(fs.id);if(local)Object.assign(local,fs);else DB.users.push(fs);});
  const allT=getCompanyTickers(ticker);
  const sh=freshStudents.filter(s=>allT.some(t=>(s.holdings&&s.holdings[t]||0)>0));
  if(!sh.length)return toast('No shareholders yet');
  const total=sh.reduce((s,u)=>s+allT.reduce((ts2,t)=>ts2+Math.round(((u.holdings&&u.holdings[t])||0)*perShare*100)/100,0),0);
  if(owner.cash<total)return toast('Insufficient funds (need '+fmt(total)+')');
  const divApprovalThreshold=DB.session.dividend_approval_threshold||1000;
  if(total>=divApprovalThreshold){
    const treasurer=DB.users.find(u=>u.role==='treasurer');
    if(treasurer){
      if(!confirm('This dividend total ('+fmt(total)+') requires Treasurer approval. Submit for approval?'))return;
      const req={id:uid(),ticker,company_name:co.name,per_share:perShare,total,note:(document.getElementById('div-note')?.value||'').trim(),requested_by:owner.id,requested_by_name:owner.name,status:'pending',ts:ts()};
      await sb.post('jex_dividend_approvals',req);
      DB.divApprovals.push(req);
      await pushNotification(treasurer.id,'div_approval','💰 Dividend approval needed: '+co.name+' wants to pay '+fmt(total)+' total ('+fmt(perShare)+'/share)',ticker);
      toast('Dividend submitted for Treasurer approval ('+fmt(total)+' exceeds '+fmt(divApprovalThreshold)+' threshold)');
      UI.companyTab='dividends';render();return;
    }
  }
  const sharesAcrossClasses=s=>allT.reduce((sum,t)=>sum+((s.holdings&&s.holdings[t])||0),0);
  if(!confirm('Pay '+fmt(perShare)+'/share to '+sh.length+' shareholder'+(sh.length!==1?'s':'')+' ('+sh.map(s=>s.name+': '+fmt(sharesAcrossClasses(s)*perShare)).join(', ')+')? Total: '+fmt(total)))return;
  let r;
  try{r=await sb.rpc('rpc_pay_dividend',{p_ticker:ticker,p_per_share:perShare,p_note:note.trim()});}
  catch(e){return toast(rpcErrorMessage(e));}
  if(r.owner_id){const o=getUser(r.owner_id);if(o)o.cash=r.owner_cash;}
  // Real backing: if JXI holds shares of this ticker, its cut was passed
  // through to every JXI unit-holder server-side too (see
  // rpc_pay_dividend's jxi_pass_through) -- refresh their balances the same
  // way as the direct shareholders' so this session sees it immediately.
  const jxiPayouts=(r.jxi_pass_through||[]).flatMap(f=>f.payouts);
  await refreshDividendPayoutBalances([...(r.payouts||[]),...jxiPayouts]);
  if(r.dividend_id)DB.dividends.push({id:r.dividend_id,ticker,company_name:co.name,per_share:perShare,total:r.total,note:note.trim(),payouts:r.payouts,jxi_pass_through:r.jxi_pass_through||[],ts:ts()});
  await logActivity('dividend',co.name+' paid dividend '+fmt(perShare)+'/share — total '+fmt(r.total),{ticker,userId:owner.id,userName:owner.name,amount:r.total});
  await pushNotificationToHolders(ticker,'dividend','💰 '+co.name+' paid a dividend of '+fmt(perShare)+'/share');
  pushBalances();
  toast(co.name+' paid '+fmt(perShare)+'/share');UI.companyTab='dividends';render();
}
// Each holder's cash was already updated server-side (rpc_pay_dividend); this
// just re-syncs the client's local cache from the authoritative DB rather
// than re-deriving cash += payout locally (which could drift if the local
// copy was ever stale).
async function refreshDividendPayoutBalances(payouts){
  if(!payouts||!payouts.length)return;
  try{
    const ids=payouts.map(p=>p.userId).join(',');
    const fresh=await sb.get('jex_users','id=in.('+ids+')&select='+JEX_USERS_SAFE_SELECT);
    fresh.forEach(fu=>{const local=getUser(fu.id);if(local)local.cash=fu.cash;});
  }catch(e){}
}
function submitIPOForm(){
  submitIPO(get('ipo-name')?.value,get('ipo-ticker')?.value,get('ipo-price')?.value,get('ipo-shares')?.value,get('ipo-desc')?.value);
}
async function submitIPO(name,ticker,price,shares,desc){
  if(!name||!ticker||!price||!shares)return toast('Fill in all fields');
  if(!name.trim()||name.trim().length<2)return toast('Enter a valid company name');
  ticker=ticker.toUpperCase().replace(/[^A-Z]/g,'');
  if(!ticker||ticker.length<2)return toast('Ticker must be 2-4 letters');
  if(DB.companies.find(c=>c.ticker===ticker)||DB.ipoApps.find(a=>a.ticker===ticker&&a.status!=='rejected'&&a.status!=='withdrawn'))return toast('Ticker already exists or is pending');
  const p=parseFloat(price),s=parseInt(shares);
  if(isNaN(p)||p<=0)return toast('Enter a valid IPO price');
  if(isNaN(s)||s<=0)return toast('Enter a valid share count');
  const app={id:uid(),user_id:UI.userId,name:name.trim(),ticker,price:p,shares:s,description:(desc||'').trim(),status:'pending',ts:ts()};
  await sb.post('jex_ipo_applications',app);
  DB.ipoApps.push(app);
  try{await sb.rpc('rpc_set_own_app_status',{p_status:'pending'});}catch(e){}
  const self=cu();if(self)self.app_status='pending';
  toast('✓ IPO application submitted! Awaiting Chairman approval.');
  UI.appTab='status';
  render();
}
async function reviewIPO(id,approve){
  const app=DB.ipoApps.find(a=>a.id===id);if(!app)return;
  // Runs server-side (rpc_review_ipo) -- this had NO auth check at all
  // before, not even client-side: any authenticated caller could create a
  // fully fabricated listed company (or silently reject someone else's
  // real application). The RPC requires Chairman/President and does the
  // same atomic pending-claim + ticker-uniqueness check the client used to
  // do unsafely, entirely inside the database.
  let r;
  try{r=await sb.rpc('rpc_review_ipo',{p_id:id,p_approve:!!approve});}
  catch(e){return toast(rpcErrorMessage(e));}
  app.status=approve?'approved':'rejected';
  if(r.approved){
    DB.companies.push(r.company);
    const owner=getUser(r.user_id);if(owner)owner.app_status='approved';
    await logActivity('ipo',r.name+' ('+r.ticker+') listed on JEX @ '+fmt(r.price),{ticker:r.ticker,userId:r.user_id,amount:r.price});
    await pushNotification(r.user_id,'ipo','🎉 Your IPO has been approved! '+r.name+' ('+r.ticker+') is now listed on JEX.',r.ticker);
    toast('✓ '+r.name+' ('+r.ticker+') is now listed on JEX!');
  } else {
    const owner=getUser(r.user_id);if(owner)owner.app_status='rejected';
    await pushNotification(r.user_id,'ipo','❌ Your IPO application for '+r.name+' was rejected.');
    toast('IPO application rejected');
  }
  render();
}
async function submitDilution(ticker,newShares,reason){
  if(!newShares||parseInt(newShares)<=0)return toast('Enter valid share count');
  if(!reason||reason.trim().length<10)return toast('Reason too short');
  const co=getCo(ticker);if(!co)return;
  if(!canManageCompany(co))return toast('Only this company\'s owner or founders can request dilution for it');
  if(DB.dilApps.find(d=>d.ticker===ticker&&d.status==='pending'))return toast('Already pending');
  newShares=parseInt(newShares);
  const app={id:uid(),ticker,company_name:co.name,current_shares:co.shares,new_shares:newShares,pct_increase:Math.round((newShares/co.shares)*100),reason:reason.trim(),status:'pending',user_id:UI.userId,ts:ts()};
  await sb.post('jex_dilution_applications',app);DB.dilApps.push(app);
  toast('Dilution application submitted');UI.companyTab='dilution';render();
}
// Dilution approval runs server-side (rpc_review_dilution): does its own
// atomic claim (SELECT ... FOR UPDATE, re-checks status='pending') and now
// requires the caller to actually be Chairman/President -- previously
// reviewDilution had no server-side authorization check at all, only the
// admin UI deciding who saw the approve/reject buttons.
async function reviewDilution(id,approve){
  const app=DB.dilApps.find(d=>d.id===id);if(!app)return;
  let r;
  try{r=await sb.rpc('rpc_review_dilution',{p_app_id:id,p_approve:!!approve});}
  catch(e){return toast(rpcErrorMessage(e));}
  app.status=approve?'approved':'rejected';
  if(r.approved){
    const co=getCo(app.ticker);
    if(co){co.shares=r.shares;co.shares_avail=r.shares_avail;co.price=r.price;co.price_history=r.price_history;}
    toast(app.company_name+': +'+app.new_shares+' shares');
  } else {
    toast('Dilution rejected');
  }
  render();
}

async function removeUser(uid2){
  if(!isAdmin(cu()))return toast('Admin access required');
  const u=getUser(uid2);if(!u)return;
  if(u.role==='chairman'||u.role==='president'){
    if(cu().role!=='chairman')return toast('Only the Chairman can remove Chairman/President accounts');
    if(uid2===cu().id)return toast('You cannot remove your own account');
  }
  if(['secretary','treasurer','compliance_officer'].includes(u.role))return toast('Officer accounts cannot be removed');
  if(!confirm('Remove '+u.name+'? This cannot be undone.'))return;
  // Runs server-side (rpc_admin_remove_user), re-checking the same
  // officer-protection and Chairman-only rules above -- those were
  // client-side only before, so a raw DELETE on jex_users could remove ANY
  // account, including a Chairman's.
  try{await sb.rpc('rpc_admin_remove_user',{p_user_id:uid2});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.users=DB.users.filter(x=>x.id!==uid2);
  DB.dividends.forEach(d=>{d.payouts=(d.payouts||[]).filter(p=>p.userId!==uid2);});
  toast(u.name+' removed');render();
}
async function removeCompany(uid2){
  if(!isAdmin(cu()))return toast('Admin access required');
  const u=getUser(uid2);if(!u)return;
  const listedCo=DB.companies.find(c=>c.owner_id===uid2);
  if(!confirm('Remove '+u.name+'?'+(listedCo?'\n\nListed stock '+listedCo.ticker+' will also be delisted.':'')+'\n\nThis cannot be undone.'))return;
  if(listedCo)await delistCompany(listedCo.ticker,true);
  // Same rpc_admin_remove_user as removeUser() above -- a company account's
  // role falls through its officer/chairman branches unaffected, matching
  // this function's original plain-admin-only check exactly.
  try{await sb.rpc('rpc_admin_remove_user',{p_user_id:uid2});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.users=DB.users.filter(x=>x.id!==uid2);
  DB.ipoApps=DB.ipoApps.filter(a=>a.user_id!==uid2);
  DB.dilApps=DB.dilApps.filter(d=>d.user_id!==uid2);
  toast(u.name+' removed');render();
}
async function removeShareClass(ticker){
  if(!isAdmin(cu()))return toast('Admin access required');
  const meta=DB.shareClasses.find(c=>c.ticker===ticker);
  const co=DB.companies.find(c=>c.ticker===ticker);
  const isConversion=meta&&meta.ticker===meta.parent_ticker;
  const msg=isConversion
    ?'Remove Class '+meta.class+' classification from '+ticker+'? This strips the class metadata but keeps the stock listed and trading. This cannot be undone.'
    :'Remove share class '+ticker+' (Class '+(meta?.class||'?')+')? This will delist the stock and remove all class metadata. This cannot be undone.';
  if(!confirm(msg))return;
  // Runs server-side (rpc_admin_remove_share_class) -- deletes the class
  // metadata, and (if it's a new class rather than a conversion) the
  // trading entry, dilution applications, and news, plus any pending class
  // applications, all in one atomic transaction instead of up to 4
  // separate direct client DELETEs.
  try{await sb.rpc('rpc_admin_remove_share_class',{p_ticker:ticker});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.shareClasses=DB.shareClasses.filter(c=>c.ticker!==ticker);
  if(!isConversion&&co){
    DB.companies=DB.companies.filter(c=>c.ticker!==ticker);
    DB.dilApps=DB.dilApps.filter(d=>d.ticker!==ticker);
    DB.news=DB.news.filter(n=>n.ticker!==ticker);
  }
  DB.classApps=DB.classApps.filter(a=>a.proposed_ticker!==ticker);
  await logActivity('class_removed',(isConversion?'Class '+meta.class+' stripped from':'Share class '+ticker+' removed from')+' '+meta?.company_name,{ticker});
  toast(isConversion?ticker+' class stripped — stock remains listed':ticker+' class removed and delisted');
  render();
}
async function delistCompany(ticker,silent=false){
  if(!isAdmin(cu()))return toast('Admin access required');
  const co=DB.companies.find(c=>c.ticker===ticker);if(!co)return;
  if(!silent&&!confirm('Delist '+co.name+' ('+ticker+')? The company can reapply for IPO later.'))return;
  // Soft delist + cancelling open orders now all run server-side in one
  // transaction (rpc_admin_delist_company) instead of 3 separate direct
  // client writes.
  let r;
  try{r=await sb.rpc('rpc_admin_delist_company',{p_ticker:ticker});}
  catch(e){return toast(rpcErrorMessage(e));}
  co.status='delisted';
  for(const {id,user_id} of r.cancelled_orders){
    const o=DB.limitOrders.find(x=>x.id===id);if(o)o.status='cancelled';
    await pushNotification(user_id,'halt','📋 Limit order cancelled — '+ticker+' has been delisted.',ticker);
  }
  for(const id of r.cancelled_stop_loss){
    const s=(DB.stopLossOrders||[]).find(x=>x.id===id);if(s)s.status='cancelled';
  }
  // Notify shareholders
  await pushNotificationToHolders(ticker,'halt','⚠️ '+co.name+' ('+ticker+') has been delisted from JEX.');
  await logActivity('ipo',co.name+' ('+ticker+') delisted',{ticker});
  if(!silent){toast(co.name+' delisted — company can reapply for IPO');render();}
}
async function relistCompany(ticker){
  if(!isAdmin(cu()))return toast('Admin access required');
  const co=DB.companies.find(c=>c.ticker===ticker);if(!co)return;
  if(!confirm('Allow '+co.name+' to reapply for IPO? This resets their application status.'))return;
  // Resetting shares_avail runs server-side (rpc_admin_relist_company) --
  // same admin-role check as the client-side isAdmin() gate above, now
  // actually enforced.
  let r;
  try{r=await sb.rpc('rpc_admin_relist_company',{p_ticker:ticker});}
  catch(e){return toast(rpcErrorMessage(e));}
  co.status='unlisted';co.shares_avail=r.shares_avail;co.price_history=r.price_history;
  const owner=getUser(r.owner_id);if(owner)owner.app_status='none';
  await pushNotification(co.owner_id,'ipo','🔄 Your company '+co.name+' has been reset — you can now submit a new IPO application.',ticker);
  toast(co.name+' reset — owner can now submit a new IPO application');
  render();
}

// ═══════════════════════════════════════════════
// CHART
// ═══════════════════════════════════════════════
// Chart interval state
const chartIntervals={};
function setChartInterval(canvasId,interval,co){
  if(interval)chartIntervals[canvasId]=interval;
  // Destroy just this chart
  if(charts[canvasId])try{charts[canvasId].destroy();delete charts[canvasId];}catch(e){}
  // Update interval bar buttons in-place without full re-render
  const barId='ibar-'+canvasId;
  const bar=document.getElementById(barId);
  if(bar)bar.innerHTML=buildIntervalButtons(canvasId,co);
  // Keep any "Change" badge (Share classes table rows, the trade panel) and
  // "N pts | Open" line paired with this specific chart in sync with
  // whichever interval is now selected -- same pattern as JXI's
  // setJxiChartInterval(), generalized to every per-company chart.
  const badge=document.getElementById('chg-badge-'+canvasId);
  if(badge){
    badge.className=tickerChgClass(canvasId,co);
    badge.innerHTML=tickerChgBadgeHtml(canvasId,co);
  }
  const meta=document.getElementById('chg-meta-'+canvasId);
  if(meta)meta.innerHTML=tickerChartMetaHtml(canvasId,co);
  setTimeout(()=>{
    buildChart(canvasId,co);
  },20);
}
function buildIntervalButtons(canvasId,co){
  const intervals=[['1d','1D'],['5d','5D'],['1m','1M'],['max','Max']];
  const current=chartIntervals[canvasId]||'1d';
  return intervals.map(([val,label])=>`<button style="font-size:11px;padding:2px 8px;border-radius:4px;cursor:pointer;border:1px solid ${current===val?'var(--blue)':'var(--border2)'};background:${current===val?'var(--blue)':'transparent'};color:${current===val?'white':'var(--text2)'};font-family:var(--font)" onclick="setChartInterval('${canvasId}','${val}',getCo('${co.ticker}'))">${label}</button>`).join('');
}
// Shared by buildChart (per-company) and buildJxiChart (the index) -- the
// 1D view resets fresh every time a session opens, like a real ticker's
// "today" numbers, anchored on the last point before this session started
// (its "open" reference) plus everything since, rather than a rolling
// 24-hour window that would still show yesterday's session bleeding into
// today's. Falls back to the plain rolling-window filterByInterval() when
// no session has opened yet (e.g. a brand new exchange).
function anchorToSessionOpen(allPts,interval){
  if(interval==='1d'&&DB.session.session_started_at){
    const cutoff=DB.session.session_started_at;
    const before=allPts.filter(p=>p.t&&new Date(p.t).getTime()<cutoff);
    const after=allPts.filter(p=>p.t&&new Date(p.t).getTime()>=cutoff);
    return{pts:before.length?[before[before.length-1],...after]:after,anchoredAtOpen:before.length>0};
  }
  return{pts:filterByInterval(allPts,interval),anchoredAtOpen:false};
}
// %-change across whatever range the currently-selected chart interval
// button covers -- first vs. last point of the exact same series buildChart/
// buildJxiChart render, so the headline badge next to a chart always agrees
// with what the chart itself is showing (1D = since session open, 5D/1M =
// that trailing window, Max = since inception) instead of being stuck on a
// fixed "today" number regardless of which button is selected.
function intervalChg(allPts,interval){
  const{pts}=anchorToSessionOpen(allPts,interval);
  if(!pts||pts.length<2||!pts[0].p)return 0;
  return Math.round(((pts[pts.length-1].p-pts[0].p)/pts[0].p*100)*100)/100;
}
function intervalChgLabel(interval){
  return{'1d':'today','5d':'5D','1m':'1M','max':'since listing'}[interval]||'today';
}
// Shared by every "Change" badge that sits next to one specific ticker's own
// interval-selectable chart (Share classes table rows, the trade panel) --
// same reasoning as jxiChgBadgeHtml(), generalized to any canvasId/co pair.
// Keyed off chartIntervals[canvasId], the same state buildChart() itself
// reads, so the badge and its chart always agree on the timeframe.
function tickerChgBadgeHtml(canvasId,co){
  const interval=chartIntervals[canvasId]||'1d';
  const chg=intervalChg(co.price_history||[],interval);
  return fmtChg(chg)+' <span style="font-size:10px;color:var(--text2);font-weight:400">'+intervalChgLabel(interval)+'</span>';
}
function tickerChgClass(canvasId,co){
  const interval=chartIntervals[canvasId]||'1d';
  return intervalChg(co.price_history||[],interval)>=0?'price-up':'price-down';
}
// The trade panel's "N pts | Open: $X" line -- like the badge above, this
// used to always show the since-listing first point/count regardless of
// which interval was selected, disagreeing with both the chart and the
// %-change badge sitting right next to it.
function tickerChartMetaHtml(canvasId,co){
  const interval=chartIntervals[canvasId]||'1d';
  const{pts}=anchorToSessionOpen(co.price_history||[],interval);
  return pts.length+' pts | Open: '+fmt(pts.length?pts[0].p:co.price);
}
function filterByInterval(pts,interval){
  if(!pts||!pts.length)return pts;
  if(interval==='max')return pts;
  const now=Date.now();
  const ms={'1d':86400000,'5d':5*86400000,'1m':30*86400000}[interval];
  if(!ms)return pts;
  const cutoff=now-ms;
  // Filter by real timestamp if available, else fall back to slicing
  const withRealTs=pts.filter(p=>p.t&&p.t.includes('T')&&p.t.includes('Z'));
  if(withRealTs.length>0){
    const filtered=pts.filter(p=>{
      if(!p.t||!p.t.includes('T'))return false;
      try{return new Date(p.t).getTime()>=cutoff;}catch(e){return false;}
    });
    return filtered.length>0?filtered:pts; // return all if nothing in range
  }
  // Fallback: slice from end
  const counts={'1d':Math.min(pts.length,30),'5d':Math.min(pts.length,150),'1m':Math.min(pts.length,500)};
  return pts.slice(-counts[interval]);
}
function buildChartIntervalBar(canvasId,co){
  return '<div id="ibar-'+canvasId+'" style="display:flex;gap:2px;margin-bottom:6px">'+buildIntervalButtons(canvasId,co)+'</div>';
}
function fmtChartLabel(t,interval){
  if(!t)return '';
  // ISO timestamp
  if(t.includes('T')&&t.includes('Z')){
    const d=new Date(t);
    if(interval==='1d')return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    if(interval==='5d')return d.toLocaleDateString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});
    if(interval==='1m')return d.toLocaleDateString([],{month:'short',day:'numeric'});
    return d.toLocaleDateString([],{month:'short',day:'numeric'});
  }
  return t; // fallback for old string labels
}
// Labels the 1D chart's "Open" anchor point (the last point before this
// session started, used to give the day's line a starting reference) --
// literally "Open" only when that point genuinely IS from today. If the
// exchange was closed for a while before reopening, the anchor point can
// predate today by a day or more; calling it "Open" then would misleadingly
// imply it's today's opening price, so it shows its real date instead.
function anchorPointLabel(p){
  const d=p&&p.t?new Date(p.t):null;
  if(!d||isNaN(d))return'Open';
  if(d.toDateString()===new Date().toDateString())return'Open';
  return d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}
function destroyChart(canvasId){
  if(charts[canvasId]){
    try{charts[canvasId].destroy();}catch(e){}
    delete charts[canvasId];
  }
  // Also check Chart.js registry
  const canvas=get(canvasId);
  if(canvas&&window.Chart){
    const existing=Chart.getChart(canvas);
    if(existing)try{existing.destroy();}catch(e){}
  }
}
function buildChart(canvasId,co){
  destroyChart(canvasId);
  const canvas=get(canvasId);if(!canvas||!window.Chart)return;
  const interval=chartIntervals[canvasId]||'1d';
  const allPts=co.price_history||[];
  const{pts,anchoredAtOpen}=anchorToSessionOpen(allPts,interval);
  if(!pts.length)return;
  const prices=pts.map(p=>p.p);
  const labels=pts.map((p,i)=>{
    if(i===pts.length-1&&pts.length>1)return'Now';
    if(i===0&&anchoredAtOpen)return anchorPointLabel(p);
    return fmtChartLabel(p.t,interval);
  });
  const isUp=prices.length>0&&prices[prices.length-1]>=prices[0];
  const lc=isUp?'#00c896':'#ff4d6a';
  const fillColor=isUp?'rgba(0,200,150,0.06)':'rgba(255,77,106,0.06)';
  try{
    charts[canvasId]=new Chart(canvas,{
      type:'line',
      data:{labels,datasets:[{
        data:prices,borderColor:lc,borderWidth:2,
        pointRadius:pts.length>50?0:pts.length>20?1:3,
        pointBackgroundColor:lc,
        fill:true,backgroundColor:fillColor,tension:0.3
      }]},
      options:{
        responsive:true,maintainAspectRatio:false,
        animation:{duration:200},
        plugins:{legend:{display:false},tooltip:{callbacks:{
          label:ctx=>fmt(ctx.parsed.y),
          title:ctx=>ctx[0]?.label||''
        }}},
        scales:{
          x:{grid:{color:'rgba(136,150,168,0.07)'},ticks:{color:'#4a5568',font:{size:10},maxTicksLimit:6,autoSkip:true}},
          y:{grid:{color:'rgba(136,150,168,0.07)'},ticks:{color:'#4a5568',font:{size:10},callback:v=>fmt(v)},beginAtZero:false}
        }
      }
    });
  }catch(e){console.warn('buildChart error:',e);}
}
function buildJxiIntervalButtons(canvasId){
  const intervals=[['1d','1D'],['5d','5D'],['1m','1M'],['max','Max']];
  const current=chartIntervals[canvasId]||'1d';
  return intervals.map(([val,label])=>`<button style="font-size:11px;padding:2px 8px;border-radius:4px;cursor:pointer;border:1px solid ${current===val?'var(--blue)':'var(--border2)'};background:${current===val?'var(--blue)':'transparent'};color:${current===val?'white':'var(--text2)'};font-family:var(--font)" onclick="setJxiChartInterval('${canvasId}','${val}')">${label}</button>`).join('');
}
function buildJxiChartIntervalBar(canvasId){
  return '<div id="ibar-'+canvasId+'" style="display:flex;gap:2px;margin-bottom:6px">'+buildJxiIntervalButtons(canvasId)+'</div>';
}
function setJxiChartInterval(canvasId,interval){
  if(interval)chartIntervals[canvasId]=interval;
  if(charts[canvasId])try{charts[canvasId].destroy();delete charts[canvasId];}catch(e){}
  const bar=document.getElementById('ibar-'+canvasId);
  if(bar)bar.innerHTML=buildJxiIntervalButtons(canvasId);
  // Keep the headline %-badge in sync with whichever interval is now
  // selected, same as the chart itself -- otherwise clicking 5D/1M/Max
  // would move the chart but leave the number next to it stuck on 1D's.
  const badge=document.getElementById('jxi-chg-badge');
  if(badge){
    const chg=intervalChg(getCo('JXI')?.price_history||[],chartIntervals[canvasId]||'1d');
    badge.className=chg>=0?'price-up':'price-down';
    badge.innerHTML=jxiChgBadgeHtml();
  }
  setTimeout(()=>buildJxiChart(canvasId),20);
}
function buildJxiChart(canvasId){
  destroyChart(canvasId);
  const canvas=get(canvasId);if(!canvas||!window.Chart)return;
  const interval=chartIntervals[canvasId]||'1d';
  // JXI's own jex_companies row, not the separate jex_index_history log --
  // see the header comment above renderIndexCard()'s equivalent read.
  const allPts=getCo('JXI')?.price_history||[];
  const{pts,anchoredAtOpen}=anchorToSessionOpen(allPts,interval);
  if(!pts.length)return;
  const prices=pts.map(p=>p.p);
  const labels=pts.map((p,i)=>{
    if(i===pts.length-1&&pts.length>1)return'Now';
    if(i===0&&anchoredAtOpen)return anchorPointLabel(p);
    return fmtChartLabel(p.t,interval);
  });
  const isUp=prices.length>0&&prices[prices.length-1]>=prices[0];
  const lc=isUp?'#00c896':'#ff4d6a';
  const fillColor=isUp?'rgba(0,200,150,0.06)':'rgba(255,77,106,0.06)';
  try{
    charts[canvasId]=new Chart(canvas,{
      type:'line',
      data:{labels,datasets:[{
        data:prices,borderColor:lc,borderWidth:2,
        pointRadius:pts.length>50?0:pts.length>20?1:3,
        pointBackgroundColor:lc,
        fill:true,backgroundColor:fillColor,tension:0.3
      }]},
      options:{
        responsive:true,maintainAspectRatio:false,
        animation:{duration:200},
        plugins:{legend:{display:false},tooltip:{callbacks:{
          label:ctx=>ctx.parsed.y.toFixed(2),
          title:ctx=>ctx[0]?.label||''
        }}},
        scales:{
          x:{grid:{color:'rgba(136,150,168,0.07)'},ticks:{color:'#4a5568',font:{size:10},maxTicksLimit:6,autoSkip:true}},
          y:{grid:{color:'rgba(136,150,168,0.07)'},ticks:{color:'#4a5568',font:{size:10}},beginAtZero:false}
        }
      }
    });
  }catch(e){console.warn('buildJxiChart error:',e);}
}
function impactPreview(co,qty,dir){
  if(!qty||qty<=0)return'';
  if(co.is_index_fund){
    // impactPrice()'s liquidity formula is keyed off co.shares -- for JXI
    // that's units outstanding (often tiny), not a real liquidity pool, so
    // it would always read as a maxed-out fake "12% impact" regardless of
    // quantity. JXI fills always happen at the live index price instead,
    // no price impact, same as the real is_index_fund branch server-side.
    const total=Math.round(co.price*qty*100)/100;
    return `<div style="font-size:12px;margin-top:6px;padding:6px 10px;background:var(--bg3);border-radius:var(--radius)">Fill: <strong>${fmt(co.price)}</strong> <span style="color:var(--text2)">live index price, no price impact</span> &nbsp;|&nbsp; Total: <strong>${fmt(total)}</strong></div>`;
  }
  const np=impactPrice(co,qty,dir),delta=np-co.price,pct=((delta/co.price)*100).toFixed(2),cls=dir==='buy'?'price-up':'price-down';
  return `<div style="font-size:12px;margin-top:6px;padding:6px 10px;background:var(--bg3);border-radius:var(--radius)">Fill: <strong>${fmt(np)}</strong> <span class="${cls}">${delta>=0?'+':''}${fmt(delta)} (${delta>=0?'+':''}${pct}%)</span> &nbsp;|&nbsp; Total: <strong>${fmt(np*qty)}</strong></div>`;
}
function shortPrev(co,qty){if(!qty||qty<=0)return'';const c=Math.round(co.price*qty*1.5*100)/100;return `<div style="font-size:12px;margin-top:6px;padding:6px 10px;background:rgba(83,74,183,0.1);border-radius:var(--radius);color:#AFA9EC">Short ${qty} @ ${fmt(co.price)} | Collateral: <strong>${fmt(c)}</strong></div>`;}
function dilPreview(co,ns){if(!ns||ns<=0)return'';const ta=co.shares+ns,np=Math.max(0.01,Math.round(co.price*(co.shares/ta)*100)/100);return `<div style="font-size:12px;padding:10px;background:var(--bg3);border-radius:var(--radius);margin-top:6px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px"><div><div style="color:var(--text2);margin-bottom:2px">Total after</div><div style="font-weight:500">${ta.toLocaleString()}</div></div><div><div style="color:var(--text2);margin-bottom:2px">Increase</div><div style="font-weight:500;color:var(--amber)">+${Math.round((ns/co.shares)*100)}%</div></div><div><div style="color:var(--text2);margin-bottom:2px">Est. price</div><div style="font-weight:500;color:var(--red)">${fmt(np)}</div></div></div>`;}

// ═══════════════════════════════════════════════
// SHARE CLASSES & VOTES
// ═══════════════════════════════════════════════

// Helper: get class metadata for a ticker (or null if base class)
function getClassMeta(ticker){return DB.shareClasses.find(c=>c.ticker===ticker)||null;}
// Helper: get all tickers for a company (base + classes)
function getCompanyTickers(parentTicker){
  const base=[parentTicker];
  // Classes whose ticker differs from the parent (new classes like BWV.B)
  // Conversions share the same ticker as parent so we exclude duplicates
  const classes=DB.shareClasses
    .filter(c=>c.parent_ticker===parentTicker&&c.ticker!==parentTicker)
    .map(c=>c.ticker);
  return [...base,...classes];
}
// Helper: can this user see/trade this ticker?
function canAccessTicker(ticker,userId){
  const meta=getClassMeta(ticker);
  if(!meta)return true; // base class, always accessible
  if(!meta.restricted)return true;
  if(!userId)return false;
  const u=getUser(userId);
  if(u&&isAdmin(u))return true; // admins see all
  return (meta.whitelist||[]).includes(userId);
}
// Helper: voting power a user has for a company
function getVotingPower(userId,parentTicker){
  const u=getUser(userId);if(!u)return 0;
  const tickers=getCompanyTickers(parentTicker);
  return tickers.reduce((total,ticker)=>{
    const held=(holdings(u)[ticker])||0;if(!held)return total;
    const meta=getClassMeta(ticker);
    const vps=meta?meta.votes_per_share:1; // base class = 1 vote
    return total+held*vps;
  },0);
}

// ── Submit new share class application ───────────────────
async function submitClassApplication(parentTicker,classType,votesPerShare,shares,price,restricted,whitelistIds,reason){
  const co=getCo(parentTicker);if(!co)return;
  const u=cu();
  if(!canManageCompany(co))return toast('Only this company\'s owner or founders can apply for a new share class');
  if(!classType)return toast('Select a class type');
  votesPerShare=parseInt(votesPerShare);
  if(isNaN(votesPerShare)||votesPerShare<0)return toast('Enter valid votes per share');
  shares=parseInt(shares);price=parseFloat(price);
  if(isNaN(shares)||shares<=0)return toast('Enter valid share count');
  if(isNaN(price)||price<=0)return toast('Enter valid price');
  const proposedTicker=parentTicker+'.'+classType;
  if(DB.companies.find(c=>c.ticker===proposedTicker)||DB.classApps.find(a=>a.proposed_ticker===proposedTicker&&a.status==='pending'))
    return toast('A '+classType+' class already exists or is pending for this company');
  const app={id:uid(),parent_ticker:parentTicker,proposed_ticker:proposedTicker,class:classType,
    label:'Class '+classType,votes_per_share:votesPerShare,shares,price,
    restricted:!!restricted,whitelist:whitelistIds||[],
    company_name:co.name,owner_id:u.id,status:'pending',reason:reason||'',ts:ts()};
  await sb.post('jex_class_applications',app);
  DB.classApps.push(app);
  await logActivity('class_app',u.name+' applied for '+co.name+' Class '+classType+' ('+proposedTicker+')',{ticker:parentTicker,userId:u.id,userName:u.name});
  toast('Class '+classType+' application submitted — awaiting Chairman approval');
  UI.companyTab='classes';render();
}

// ── Chairman: approve / reject class application ─────────
async function reviewClassApp(id,approve){
  const app=DB.classApps.find(a=>a.id===id);if(!app)return;
  // Runs server-side (rpc_review_class_application) -- this had NO auth
  // check at all before, not even client-side: any authenticated caller
  // could create a fake share class or listed company. The RPC requires
  // Chairman/President and does the same atomic pending-claim +
  // ticker-uniqueness check the client used to do unsafely.
  let r;
  try{r=await sb.rpc('rpc_review_class_application',{p_id:id,p_approve:!!approve});}
  catch(e){return toast(rpcErrorMessage(e));}
  app.status=approve?'approved':'rejected';
  if(r.approved){
    DB.shareClasses.push(r.share_class);
    if(r.is_conversion){
      await logActivity('class_approved',app.company_name+' '+app.proposed_ticker+' converted to Class '+app.class,{ticker:app.proposed_ticker});
      toast(app.company_name+' ('+app.proposed_ticker+') converted to Class '+app.class+'!');
    } else {
      DB.companies.push(r.company);
      await logActivity('class_approved',app.company_name+' Class '+app.class+' ('+app.proposed_ticker+') listed',{ticker:app.proposed_ticker});
      toast(app.company_name+' Class '+app.class+' listed as '+app.proposed_ticker+'!');
    }
  } else {
    toast('Class application rejected');
  }
  render();
}

// ── Votes ─────────────────────────────────────────────────
async function postVote(parentTicker,question,optA,optB,closesAt){
  if(!question||question.trim().length<5)return toast('Enter a question');
  if(!optA||!optB)return toast('Enter both options');
  const co=getCo(parentTicker);if(!co)return;
  const u=cu();
  if(!canManageCompany(co))return toast('Only this company\'s owner or founders can post a vote');
  // Runs server-side (rpc_post_vote), re-checking the same owner-or-
  // founder rule above -- it was client-side only, so a raw POST could
  // impersonate any company's governance action, posting a fake vote
  // shown to every shareholder exactly like a real one.
  let v;
  try{v=await sb.rpc('rpc_post_vote',{p_ticker:parentTicker,p_question:question.trim(),p_option_a:optA.trim(),p_option_b:optB.trim(),p_closes_at:closesAt||null});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.votes.push(v);
  await logActivity('vote',co.name+' posted vote: '+question.trim(),{ticker:parentTicker,userId:u.id,userName:u.name});
  await pushNotificationToHolders(parentTicker,'vote','🗳️ '+co.name+' posted a vote: '+question.trim());
  toast('Vote posted');UI.companyTab='votes';render();
}
async function castVote(voteId,choice){
  const v=DB.votes.find(x=>x.id===voteId);if(!v)return;
  const u=cu();if(!u)return;
  if(DB.ballots.find(b=>b.vote_id===voteId&&b.voter_id===u.id))return toast('You have already voted');
  const power=getVotingPower(u.id,v.parent_ticker);
  if(power<=0)return toast('You have no voting shares in this company');
  // Runs server-side (rpc_cast_vote), which re-derives the caller's real
  // voting power from their own holdings instead of trusting this
  // client-computed { voter_id, voting_power } -- a raw POST here used to
  // let anyone cast unlimited ballots with an arbitrary inflated
  // voting_power, single-handedly deciding any company's vote regardless
  // of actual share ownership.
  let ballot;
  try{ballot=await sb.rpc('rpc_cast_vote',{p_vote_id:voteId,p_choice:choice});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.ballots.push(ballot);
  toast('Vote cast — '+ballot.voting_power+' vote'+(ballot.voting_power!==1?'s':'')+' counted');render();
}
async function closeVote(voteId){
  const targetV=DB.votes.find(x=>x.id===voteId);if(!targetV)return;
  const targetCo=getCo(targetV.parent_ticker);
  if(!targetCo||!canManageCompany(targetCo))return toast('Only this company\'s owner or founders can close its vote');
  if(!confirm('Close this vote?'))return;
  // Runs server-side (rpc_close_vote), re-checking the same owner-or-
  // founder rule above -- it was client-side only.
  try{await sb.rpc('rpc_close_vote',{p_vote_id:voteId});}
  catch(e){return toast(rpcErrorMessage(e));}
  const v=DB.votes.find(x=>x.id===voteId);if(v){
    v.status='closed';
    // Notify all who voted
    const voters=[...new Set(DB.ballots.filter(b=>b.vote_id===voteId).map(b=>b.voter_id))];
    for(const vid of voters) await pushNotification(vid,'vote_closed','🗳️ Vote closed: "'+v.question+'" — '+v.company_name,v.parent_ticker);
  }
  toast('Vote closed');render();
}
function postVoteForm(parentTicker){
  postVote(parentTicker,
    document.getElementById('vote-q')?.value,
    document.getElementById('vote-a')?.value,
    document.getElementById('vote-b')?.value,
    document.getElementById('vote-closes')?.value);
}
async function deleteVote(voteId){
  const targetV=DB.votes.find(x=>x.id===voteId);if(!targetV)return;
  const targetCo=getCo(targetV.parent_ticker);
  if(!targetCo||!canManageCompany(targetCo))return toast('Only this company\'s owner or founders can delete its vote');
  if(!confirm('Delete this vote and all ballots?'))return;
  // Runs server-side (rpc_delete_vote), re-checking the same owner-or-
  // founder rule above -- canManageCompany() was client-side only, so a
  // raw DELETE on jex_votes could remove any company's vote.
  try{await sb.rpc('rpc_delete_vote',{p_vote_id:voteId});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.votes=DB.votes.filter(x=>x.id!==voteId);
  DB.ballots=DB.ballots.filter(b=>b.vote_id!==voteId);
  toast('Vote deleted');render();
}
function getVoteResults(voteId){
  const ballots=DB.ballots.filter(b=>b.vote_id===voteId);
  const powerA=ballots.filter(b=>b.choice==='A').reduce((s,b)=>s+b.voting_power,0);
  const powerB=ballots.filter(b=>b.choice==='B').reduce((s,b)=>s+b.voting_power,0);
  const total=powerA+powerB;
  return{powerA,powerB,total,pctA:total?Math.round(powerA/total*100):0,pctB:total?Math.round(powerB/total*100):0,count:ballots.length};
}

// ── Render: vote card ─────────────────────────────────────
function renderVoteCard(v,isOwner,isAdminUser){
  const res=getVoteResults(v.id);
  const u=cu();
  const myBallot=DB.ballots.find(b=>b.vote_id===v.id&&b.voter_id===u?.id);
  const myPower=u?getVotingPower(u.id,v.parent_ticker):0;
  const canVote=!myBallot&&myPower>0&&v.status==='open'&&u?.role==='student';
  return '<div class="news-item" style="margin-bottom:12px">'
    +'<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">'
    +'<div><div style="font-weight:500;font-size:14px;margin-bottom:2px">'+esc(v.question)+'</div>'
    +'<div style="font-size:11px;color:var(--text2)">'+esc(v.company_name)+' · '+v.ts+(v.closes_at?' · closes '+v.closes_at:'')+'</div></div>'
    +'<span class="badge '+(v.status==='open'?'b-green':'b-gray')+'">'+v.status+'</span></div>'
    // Results bars
    +'<div style="margin-bottom:10px">'
    +'<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span>'+esc(v.option_a)+'</span><span style="font-family:var(--mono)">'+res.powerA+' votes ('+res.pctA+'%)</span></div>'
    +'<div style="height:8px;background:var(--bg3);border-radius:4px;overflow:hidden;margin-bottom:8px"><div style="height:100%;width:'+res.pctA+'%;background:var(--green);border-radius:4px;transition:width 0.3s"></div></div>'
    +'<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span>'+esc(v.option_b)+'</span><span style="font-family:var(--mono)">'+res.powerB+' votes ('+res.pctB+'%)</span></div>'
    +'<div style="height:8px;background:var(--bg3);border-radius:4px;overflow:hidden"><div style="height:100%;width:'+res.pctB+'%;background:var(--red);border-radius:4px;transition:width 0.3s"></div></div>'
    +'<div style="font-size:11px;color:var(--text2);margin-top:4px">'+res.count+' voter'+(res.count!==1?'s':'')+' · '+res.total+' total votes</div></div>'
    // Voting buttons
    +(canVote?'<div style="display:flex;gap:8px;margin-bottom:8px">'
      +'<button class="btn btn-sm btn-success" onclick="castVote(&quot;'+v.id+'&quot;,&quot;A&quot;)">Vote: '+esc(v.option_a)+'</button>'
      +'<button class="btn btn-sm btn-danger" onclick="castVote(&quot;'+v.id+'&quot;,&quot;B&quot;)">Vote: '+esc(v.option_b)+'</button>'
      +'<span style="font-size:11px;color:var(--text2);line-height:28px">Your voting power: <strong>'+myPower+'</strong></span></div>':'')
    +(myBallot?'<div class="ibox ibox-green" style="padding:6px 10px;margin-bottom:0">You voted: <strong>'+esc(myBallot.choice==='A'?v.option_a:v.option_b)+'</strong> ('+myBallot.voting_power+' votes)</div>':'')
    // Admin/owner controls
    +((isOwner||isAdminUser)?'<div style="display:flex;gap:6px;margin-top:8px">'
      +(v.status==='open'?'<button class="btn btn-sm btn-warning" onclick="closeVote(&quot;'+v.id+'&quot;)">Close vote</button>':'')
      +'<button class="btn btn-sm btn-danger" onclick="deleteVote(&quot;'+v.id+'&quot;)">Delete</button></div>':'')
    +'</div>';
}

// ═══════════════════════════════════════════════
// RENDER: CONFIG
// ═══════════════════════════════════════════════
function renderConfig(){return `<div class="config-page"><div class="config-card"><div style="font-family:var(--mono);font-size:22px;font-weight:600;margin-bottom:4px"><span style="color:var(--amber)">JEX</span> — Setup required</div><div style="font-size:13px;color:var(--text2);margin-bottom:24px">Connect JEX to your Supabase database.</div><div class="ibox ibox-amber" style="margin-bottom:20px"><strong>One-time setup:</strong><br>1. Go to <strong>supabase.com</strong> and create a free account.<br>2. Create a new project.<br>3. Go to <strong>SQL Editor</strong> → paste and run <code>supabase_setup.sql</code>.<br>4. Go to <strong>Project Settings → API</strong> → copy Project URL and anon key.<br>5. Open <code>index.html</code>, paste your values into the two config lines at the top of the script.<br>6. Upload to GitHub.</div><div class="ibox ibox-blue">After setup this screen will be replaced by the JEX login.<br><br>Default logins: <code>chairman@jted.edu / chairman1234</code> and <code>president@jted.edu / president1234</code><br>Secretary and Treasurer accounts must be created via Supabase SQL.</div></div></div>`;}

// ═══════════════════════════════════════════════
// LEGAL: Terms of Service & Bylaws
// ═══════════════════════════════════════════════
const TOS_HTML=`
  <h2>Terms of Service, Rules &amp; Regulations</h2>
  <div class="legal-meta">Effective upon account registration · Subject to amendment by the Chairman, President, or the Board of Trusted Securities (BoTS).</div>
  <p>These Terms of Service govern all participation in the JTED Stock Exchange (JEX), a simulated classroom financial market. By creating an account and agreeing to the Terms of Service at registration, you acknowledge that you have read, understood, and agree to be bound by all rules contained in this document. Ignorance of the rules is not an excuse for violations.</p>

  <h3>1. Participation &amp; Eligibility</h3>
  <p>JEX is a simulated stock exchange operated as part of the JTED program. All participants must be currently enrolled students or approved company representatives operating under instructor supervision.</p>
  <h4>1.1 Account Registration</h4>
  <ul>
    <li>Each participant may hold only one student account. Creating duplicate accounts is prohibited.</li>
    <li>Company accounts are tied to a registered business entity and may be co-managed by up to three approved founders.</li>
    <li>Account credentials (username and password) are the sole responsibility of the account holder. Do not share your password.</li>
    <li>All registrations are subject to Chairman or President approval before the account becomes active.</li>
  </ul>
  <h4>1.2 Account Conduct</h4>
  <ul>
    <li>Participants must use their real name and a valid school email address.</li>
    <li>Impersonating another student, company, or officer is grounds for immediate suspension.</li>
    <li>Accounts found to be operating under false identities will be permanently removed.</li>
  </ul>

  <h3>2. Trading Rules</h3>
  <p>All trading activity on JEX is subject to the following rules. Violations may result in account suspension, forced position closure, financial penalties, or permanent removal.</p>
  <h4>2.1 General Trading</h4>
  <ul>
    <li>Trading is only permitted during open trading sessions as declared by the Chairman or President.</li>
    <li>All trades are final and cannot be reversed except by Chairman or President discretion.</li>
    <li>Orders must be placed in good faith. Placing orders with no intent to hold is prohibited.</li>
    <li>The exchange reserves the right to cancel or void any order at any time without notice.</li>
  </ul>
  <h4>2.2 Prohibited Conduct</h4>
  <div class="legal-warn">The following activities are strictly prohibited and will result in immediate sanctions:</div>
  <ul>
    <li><strong>Wash trading:</strong> Buying and selling the same stock repeatedly to inflate volume or manipulate prices.</li>
    <li><strong>Spoofing:</strong> Placing large limit orders with intent to cancel before execution to mislead the market.</li>
    <li><strong>Front-running:</strong> Using non-public information to trade ahead of known orders.</li>
    <li><strong>Collusion:</strong> Coordinating with other participants to artificially move prices.</li>
    <li><strong>Insider trading:</strong> Executing trades based on material non-public information about a listed company.</li>
    <li><strong>Market manipulation:</strong> Any attempt to artificially influence a stock price through deceptive means.</li>
    <li><strong>Order stuffing:</strong> Placing excessive orders to slow down the exchange or harm other participants.</li>
  </ul>
  <h4>2.3 Short Selling</h4>
  <ul>
    <li>Short selling is permitted during open sessions only.</li>
    <li>A collateral requirement of <strong>150% of the position value</strong> is locked at the time of shorting.</li>
    <li>Short positions must be covered before the account holder's JEX participation ends.</li>
    <li>Uncovered short positions at the end of a final session may be force-closed by the Chairman or President.</li>
  </ul>
  <h4>2.4 Limit &amp; After-Hours Orders</h4>
  <ul>
    <li>Limit orders placed outside of session hours are queued as after-hours orders and activate when the next session opens.</li>
    <li>Day orders expire at session close if unfilled.</li>
    <li>Good-till-cancelled (GTC) orders remain active across sessions until filled or manually cancelled.</li>
  </ul>

  <h3>3. Company Rules</h3>
  <p>Companies listed on JEX are expected to operate transparently and in accordance with good corporate governance standards.</p>
  <h4>3.1 IPO Applications</h4>
  <ul>
    <li>IPO applications must include accurate company information, a realistic IPO price, and a legitimate business description.</li>
    <li>False or misleading IPO disclosures are grounds for immediate delisting and account suspension.</li>
    <li>Once approved, the ticker symbol is permanent and cannot be changed.</li>
  </ul>
  <h4>3.2 Financial Disclosures</h4>
  <ul>
    <li>Companies are expected to post news updates and financial summaries regularly.</li>
    <li>Material events (mergers, product launches, financial results) must be disclosed promptly.</li>
    <li>Deliberately withholding material information to benefit insider traders is a violation.</li>
  </ul>
  <h4>3.3 Dividends &amp; Buybacks</h4>
  <ul>
    <li>Dividends must be paid from actual company cash. Declaring dividends the company cannot afford is prohibited.</li>
    <li>Dividends exceeding the Treasurer-set threshold require prior Treasurer approval.</li>
    <li>Share buybacks reduce the total shares outstanding and must be conducted at fair market value.</li>
  </ul>
  <h4>3.4 Dilution</h4>
  <ul>
    <li>Issuing additional shares requires a formal dilution application approved by the Chairman or President.</li>
    <li>Dilution must be disclosed to all shareholders at the time of approval.</li>
    <li>Excessive dilution used as a tool to harm existing shareholders may be denied.</li>
  </ul>
  <h4>3.5 Delisting</h4>
  <ul>
    <li>Companies may voluntarily apply for delisting. If approved, a buyback window will open for shareholders.</li>
    <li>Involuntary delisting may be imposed by the Chairman or President for compliance violations, insolvency, or fraudulent conduct.</li>
    <li>Shares held in a delisted company become worthless after delisting is finalised.</li>
  </ul>

  <h3>4. Exchange Governance</h3>
  <h4>4.1 Officer Roles</h4>
  <table><thead><tr><th>Role</th><th>Primary Responsibilities</th></tr></thead><tbody>
    <tr><td>Chairman</td><td>Supreme authority. Opens/closes sessions. Approves IPOs, dilutions, share classes, and delistings.</td></tr>
    <tr><td>President</td><td>Deputy to the Chairman. Can open/close sessions. Reviews compliance reports. Co-manages governance.</td></tr>
    <tr><td>Secretary</td><td>Records meeting minutes. Maintains official notices. Documents exchange activity.</td></tr>
    <tr><td>Treasurer</td><td>Reviews and approves large dividend payments. Monitors exchange-wide financial health.</td></tr>
    <tr><td>Compliance Officer</td><td>Investigates suspected violations. Files compliance flags. Reports to Chairman and President.</td></tr>
  </tbody></table>
  <h4>4.2 Disputes &amp; Appeals</h4>
  <ul>
    <li>All disputes must be raised with the Compliance Officer in the first instance.</li>
    <li>The Chairman's decision on any dispute is final and binding.</li>
    <li>Participants who believe an error has occurred may request a review within one trading session.</li>
    <li>Filing repeated frivolous disputes is itself a violation.</li>
  </ul>
  <h4>4.3 Session Control</h4>
  <ul>
    <li>The Chairman or President may open, pause, or close the market at any time.</li>
    <li>Trading halts may be issued for individual stocks or the entire exchange.</li>
    <li>Circuit breakers trigger automatically if a stock moves beyond the set threshold from its session-open price.</li>
    <li>All decisions made under emergency session control are at the officers' sole discretion.</li>
  </ul>

  <h3>5. Sanctions &amp; Enforcement</h3>
  <p>Violations of these rules will be handled progressively, though the Chairman reserves the right to apply any sanction immediately and without prior warning for serious offences.</p>
  <table><thead><tr><th>Level</th><th>Examples</th><th>Possible Sanctions</th></tr></thead><tbody>
    <tr><td>Minor</td><td>Accidental rule breach, first offence, procedural error.</td><td>Written warning via notification. No financial penalty.</td></tr>
    <tr><td>Moderate</td><td>Repeated minor violations, incomplete disclosures, minor collusion.</td><td>Account freeze (1 session). Forced order cancellation.</td></tr>
    <tr><td>Serious</td><td>Wash trading, insider trading, spoofing, deliberate manipulation.</td><td>Account suspended. Positions force-closed at market price.</td></tr>
    <tr><td>Severe</td><td>Fraud, persistent cheating, abuse of officer role, hacking the exchange.</td><td>Permanent account removal. All holdings zeroed. Reported to the Chairman.</td></tr>
  </tbody></table>

  <h3>6. Privacy &amp; Data</h3>
  <p>JEX collects only the information necessary to operate the exchange: name, email, password (hashed), and trading activity.</p>
  <ul>
    <li>Account data is stored securely in a Supabase database accessible only to exchange officers and the instructor.</li>
    <li>Trading history, portfolio data, and net worth records may be reviewed by officers at any time.</li>
    <li>No personal data is sold or shared with third parties outside the classroom program.</li>
    <li>The exchange may be fully reset at the end of a program period, wiping all account data.</li>
  </ul>

  <h3>7. Amendments</h3>
  <p>The Chairman, President, or the Board of Trusted Securities (BoTS), pursuant to Article II of the Bylaws — Corporate Governance section of the School Securities Exchange Application, reserves the right to amend, update, or replace these Terms of Service at any time. Changes will be announced via the JEX announcements system. Continued use of the exchange after an amendment constitutes acceptance of the updated terms. Participants who disagree with material changes should raise their concerns with the Compliance Officer or instructor.</p>

  <h3>8. Disclaimer</h3>
  <p>JEX is a <strong>simulated educational environment</strong>. All currency, stocks, and financial instruments within JEX are fictional and carry no real monetary value. No real money is involved. The exchange is operated solely for educational purposes as part of the JTED program. Any resemblance to real-world companies, stocks, or financial events is coincidental.</p>
  <div class="legal-warn">Strategies or behaviours practised in JEX should not be applied to real financial markets without appropriate professional guidance. The exchange operators assume no liability for decisions made based on JEX participation.</div>

  <h4>By agreeing to the Terms of Service at registration, I confirm that:</h4>
  <ul>
    <li>I have read and understood these Terms of Service, Rules &amp; Regulations in full.</li>
    <li>I agree to abide by all rules set out in this document.</li>
    <li>I understand that violations may result in sanctions up to and including permanent account removal.</li>
    <li>I understand that JEX is a simulated educational environment and no real money is involved.</li>
    <li>I consent to my trading activity being monitored by exchange officers and the instructor.</li>
  </ul>
  <div class="legal-meta">JEX — JTED Stock Exchange | Terms of Service v1.0. This document supersedes all prior verbal or written agreements regarding JEX participation.</div>
`;
const BYLAWS_HTML=`
  <h2>School Securities Exchange — Bylaws</h2>
  <div class="legal-meta">JTED Securities and Exchange Commission · Application for, and Amendments to Application for, Registration as a School Securities Exchange</div>
  <h3>Bylaws — Corporate Governance</h3>
  <ul>
    <li><strong>Article I:</strong> Meetings are every Thursday, after the educational semester, per the Tucson Unified School District Calendar. The purpose of meetings is to elect the President of the Exchange and to approve or reapprove the rules and regulations of the Exchange.</li>
    <li><strong>Article II:</strong> Special meetings may be called by the Chairman, the President, or by at least 51% of public company representatives (hereinafter known as the "Board of Trusted Securities (BoTS)"), defined as board members listed on the Exchange. Every amendment to the bylaws can only be passed and enforced with a vote of 51% on the BoTS. Afterward, it must be signed by the President and only then may it pass. A vote of 2/3 of the vote may override the President's decision.</li>
    <li><strong>Article III:</strong> The President of the Exchange must be a member of the BoTS. To be eligible to run, an individual must first serve as an official board member. Each company is responsible for electing its board members and may establish its own rules for that process.</li>
    <li><strong>Article IV:</strong> The President will be elected through a general election in which only members of BoTS may vote. A candidate must receive a majority of at least 51% of the total vote to win. However, a supermajority of 80% or more automatically overrides the confirmation process.</li>
    <li><strong>Article V:</strong> After the election, the President-elect must be confirmed by the Chairman of the Exchange. If confirmed, the outgoing President transfers all powers and privileges to the new President. If the Chairman withholds confirmation, a new election is required unless the candidate has received a supermajority of 80% or more, in which case confirmation is automatic.</li>
    <li><strong>Article VI:</strong> The Chairman of the Exchange will always be Jeremy Bishop (hereinafter known as "Mr. Bishop"). He may not be removed from this position unless he resigns voluntarily. The Chairman is responsible for approving new users and allocating them capital to trade with, approving IPOs from companies, approving issuances, and new classes of stocks.</li>
    <li><strong>Article VII:</strong> The President may nominate a Secretary, Treasurer and a Compliance Officer. All officers must be confirmed by the Chairman. The President is responsible for approving new users and allocating them capital to trade with, approving IPOs from companies, approving issuances and new classes of stocks, opening and closing trading sessions, manual password resets, and other responsibilities that are reasonable for the day-to-day operations of the Exchange. The President will temporarily be Ariel Ramirez-Angulo until the next meeting.</li>
    <li><strong>Article VIII:</strong> The Secretary takes notes during meetings and is responsible for sending out e-mails or other communications to important board members or officers. The Secretary is also responsible for recording the minutes of every meeting and posting said minutes on the Exchange. The Secretary will temporarily be Kyle Nguyen until the next meeting.</li>
    <li><strong>Article IX:</strong> The Treasurer is responsible for authorizing all financial transactions and documents that the Exchange publishes to the public. The Treasurer is also responsible for monitoring the financial standings of every company listed on the Exchange. The Treasurer will temporarily be John Church until the next meeting.</li>
    <li><strong>Article X:</strong> The Compliance Officer is responsible for monitoring all trading on the Exchange. The Compliance Officer is also responsible for halting any suspicious trades or stocks on the Exchange. The Compliance Officer will temporarily be Benjamin Arvizu until the next meeting.</li>
  </ul>
  <div class="legal-meta">JTED Securities and Exchange Commission · 3300 S Park Ave, Tucson, AZ 85713</div>
`;
function openLegalModal(type){
  const root=document.getElementById('legal-modal-root');if(!root)return;
  root.innerHTML=renderLegalModalHTML(type);
}
function switchLegalTab(type){openLegalModal(type);}
function closeLegalModal(){const root=document.getElementById('legal-modal-root');if(root)root.innerHTML='';}
function renderLegalModalHTML(type){
  const isTos=type!=='bylaws';
  return `<div class="legal-overlay" onclick="if(event.target===this)closeLegalModal()">
    <div class="legal-box">
      <div class="legal-header">
        <div class="legal-tabs">
          <button class="legal-tab ${isTos?'active':''}" onclick="switchLegalTab('tos')">Terms of Service</button>
          <button class="legal-tab ${!isTos?'active':''}" onclick="switchLegalTab('bylaws')">Bylaws</button>
        </div>
        <button class="legal-close" onclick="closeLegalModal()">✕</button>
      </div>
      <div class="legal-body">${isTos?TOS_HTML:BYLAWS_HTML}</div>
    </div>
  </div>`;
}
function renderLegalFooter(){
  return `<div class="app-footer">JEX — JTED Stock Exchange &nbsp;·&nbsp; <a class="legal-link" onclick="openLegalModal('tos')">Terms of Service</a> &nbsp;·&nbsp; <a class="legal-link" onclick="openLegalModal('bylaws')">Bylaws</a> &nbsp;·&nbsp; <a class="legal-link" onclick="openContactAdminModal()">Contact Admin</a> &nbsp;·&nbsp; <span style="opacity:0.5">v${APP_VERSION}</span></div>`;
}

// ═══════════════════════════════════════════════
// BUG REPORTS
// ═══════════════════════════════════════════════
function openBugReportModal(){
  const root=document.getElementById('bug-modal-root');if(!root)return;
  root.innerHTML=renderBugReportModalHTML();
}
function closeBugReportModal(){const root=document.getElementById('bug-modal-root');if(root)root.innerHTML='';}
function renderBugReportModalHTML(){
  return `<div class="legal-overlay" onclick="if(event.target===this)closeBugReportModal()">
    <div class="legal-box" style="max-width:480px;max-height:none">
      <div class="legal-header">
        <div style="font-weight:600;font-size:14px">🐛 Report a bug</div>
        <button class="legal-close" onclick="closeBugReportModal()">✕</button>
      </div>
      <div class="legal-body">
        <div class="ibox ibox-blue" style="margin-bottom:12px">This goes straight to the Chairman and President. Describe what happened and, if you can, attach a screenshot.</div>
        <div class="frow"><label class="flabel">What went wrong?</label>
          <textarea id="bug-desc" rows="4" placeholder="e.g. When I tried to place a limit order on ACME, the price field reset to 0 and the button did nothing..."></textarea>
        </div>
        <div class="frow"><label class="flabel">Screenshot (optional, image files up to 5MB)</label>
          <input type="file" id="bug-screenshot" accept="image/*">
        </div>
        <button class="btn btn-primary" id="bug-submit-btn" onclick="submitBugReport()" style="width:100%">Send report</button>
      </div>
    </div>
  </div>`;
}
async function uploadBugScreenshot(file){
  const ext=(file.name.split('.').pop()||'png').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,8)||'png';
  const path=uid()+'.'+ext;
  const r=await fetch(SUPABASE_URL+'/storage/v1/object/bug-screenshots/'+path,{
    method:'POST',
    headers:{'apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+SUPABASE_ANON_KEY,'Content-Type':file.type||'application/octet-stream'},
    body:file
  });
  if(!r.ok)throw new Error(await r.text());
  return SUPABASE_URL+'/storage/v1/object/public/bug-screenshots/'+path;
}
async function submitBugReport(){
  const u=cu();if(!u)return;
  const desc=(get('bug-desc')?.value||'').trim();
  if(desc.length<10)return toast('Please describe the bug in at least 10 characters');
  const fileInput=get('bug-screenshot');
  const file=fileInput&&fileInput.files&&fileInput.files[0];
  if(file&&file.size>5*1024*1024)return toast('Screenshot must be under 5MB');
  if(file&&!file.type.startsWith('image/'))return toast('Screenshot must be an image file');
  const btn=get('bug-submit-btn');if(btn){btn.disabled=true;btn.textContent='Sending…';}
  try{
    let screenshotUrl=null;
    if(file)screenshotUrl=await uploadBugScreenshot(file);
    const rec={id:uid(),user_id:u.id,user_name:u.name,description:desc,screenshot_url:screenshotUrl,status:'open',page_url:window.location.href,ts:ts()};
    await sb.post('jex_bug_reports',rec);
    DB.bugReports.unshift(rec);
    const admins=DB.users.filter(u2=>u2.role==='chairman'||u2.role==='president');
    for(const a of admins){
      await pushNotification(a.id,'bug_report','🐛 Bug report from '+u.name+': '+desc.slice(0,80),null);
    }
    await logActivity('bug_report','🐛 '+u.name+' reported a bug: '+desc.slice(0,80),{userId:u.id,userName:u.name});
    closeBugReportModal();
    toast('🐛 Bug report sent to the Chairman and President');
    render();
  }catch(e){
    toast('Failed to send bug report: '+(e.message||e));
    if(btn){btn.disabled=false;btn.textContent='Send report';}
  }
}
async function resolveBugReport(reportId){
  const r=DB.bugReports.find(x=>x.id===reportId);if(!r)return;
  const u=cu();
  // Runs server-side (rpc_admin_resolve_bug_report) -- this had NO check
  // at all before.
  let res;
  try{res=await sb.rpc('rpc_admin_resolve_bug_report',{p_report_id:reportId});}
  catch(e){return toast(rpcErrorMessage(e));}
  if(!res.resolved)return toast('This report was already resolved');
  r.status='resolved';r.resolved_by=u.name;
  toast('Bug report marked resolved');render();
}

// ═══════════════════════════════════════════════
// CONTACT ADMIN
// ═══════════════════════════════════════════════
function openContactAdminModal(){
  const root=document.getElementById('contact-modal-root');if(!root)return;
  root.innerHTML=renderContactAdminModalHTML();
  // Chairman/President emails aren't in bulk DB.users any more (see the
  // email-pii-exposure-fix migration) -- this modal is reachable from the
  // footer of every page, logged in or not, so it needs its own public RPC
  // rather than the Chairman/President-only bulk merge loadAll() does.
  safeRpc('rpc_get_leadership_contacts').then(rows=>{
    if(!rows)return;
    let changed=false;
    rows.forEach(r=>{const u=getUser(r.id);if(u&&u.email!==r.email){u.email=r.email;changed=true;}});
    if(changed&&root.innerHTML)root.innerHTML=renderContactAdminModalHTML();
  });
}
function closeContactAdminModal(){const root=document.getElementById('contact-modal-root');if(root)root.innerHTML='';}
const ADMIN_ROLE_ORDER={chairman:0,president:1,secretary:2,treasurer:3,compliance_officer:4};
const ADMIN_ROLE_LABELS={chairman:'Chairman',president:'President',secretary:'Secretary',treasurer:'Treasurer',compliance_officer:'Compliance Officer'};
function renderContactAdminModalHTML(){
  const u=cu();
  const officers=DB.users.filter(isChairman).sort((a,b)=>(ADMIN_ROLE_ORDER[a.role]??9)-(ADMIN_ROLE_ORDER[b.role]??9));
  return `<div class="legal-overlay" onclick="if(event.target===this)closeContactAdminModal()">
    <div class="legal-box" style="max-width:480px;max-height:none">
      <div class="legal-header">
        <div style="font-weight:600;font-size:14px">✉️ Contact Admin</div>
        <button class="legal-close" onclick="closeContactAdminModal()">✕</button>
      </div>
      <div class="legal-body">
        <div class="ibox ibox-blue" style="margin-bottom:12px">Click an officer's email below to contact them directly.</div>
        ${officers.length?`<div>${officers.map(o=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span style="font-size:13px">${esc(o.name)} <span class="badge b-gray" style="font-size:10px;margin-left:4px">${esc(ADMIN_ROLE_LABELS[o.role]||o.role)}</span></span><a href="mailto:${esc(o.email)}" class="legal-link" style="font-size:12px">${esc(o.email)}</a></div>`).join('')}</div>`:'<div class="empty">No officers to contact yet</div>'}
      </div>
    </div>
  </div>`;
}
async function resolveContactMessage(msgId){
  const m=DB.contactMessages.find(x=>x.id===msgId);if(!m)return;
  const u=cu();
  // Runs server-side (rpc_admin_resolve_contact_message) -- this had NO
  // check at all before.
  let r;
  try{r=await sb.rpc('rpc_admin_resolve_contact_message',{p_msg_id:msgId});}
  catch(e){return toast(rpcErrorMessage(e));}
  if(!r.resolved)return toast('This message was already resolved');
  m.status='resolved';m.resolved_by=u.name;
  toast('Message marked resolved');render();
}

// ═══════════════════════════════════════════════
// RENDER: LOGIN
// ═══════════════════════════════════════════════
function renderLogin(){
  const students=DB.users.filter(u=>u.role==='student'&&u.status==='approved');
  const companies=DB.users.filter(u=>u.role==='company'&&u.status==='approved');
  const roleOrder={chairman:0,president:1,secretary:2,treasurer:3,compliance_officer:4};
  const admins=DB.users.filter(u=>isAdmin(u)).sort((a,b)=>(roleOrder[a.role]??9)-(roleOrder[b.role]??9));
  const pending=DB.pending.length;
  if(UI.loginView==='forgot-email'){return `<div class="login-page"><div class="login-card"><div class="login-logo"><span class="jex">JEX</span></div><div class="login-sub">Forgot password — Step 1 of 3</div><div class="frow"><label class="flabel">Your email address</label><input type="email" id="forgot-email" placeholder="you@school.edu" onkeydown="if(event.key==='Enter')forgotStep1(get('forgot-email')?.value)"></div><div class="login-actions"><button class="btn btn-primary" onclick="forgotStep1(get('forgot-email')?.value)">Continue</button><button class="btn" onclick="UI.loginView='select';render()">Back</button></div></div></div>`;}
  if(UI.loginView==='forgot-secq'){const u=getUser(UI.forgotUserId);return `<div class="login-page"><div class="login-card"><div class="login-logo"><span class="jex">JEX</span></div><div class="login-sub">Forgot password — Step 2 of 3</div><div class="ibox ibox-blue" style="margin-bottom:12px">Account: <strong>${esc(u?.name)}</strong></div><div class="frow"><label class="flabel">${u?.sec_q||'Security question'}</label><input type="text" id="forgot-ans" placeholder="Your answer" autocomplete="off" onkeydown="if(event.key==='Enter')forgotStep2(get('forgot-ans')?.value)"></div><div style="font-size:12px;color:var(--text2);margin-bottom:12px">Answers are not case-sensitive.</div><div class="login-actions"><button class="btn btn-primary" onclick="forgotStep2(get('forgot-ans')?.value)">Continue</button><button class="btn" onclick="UI.loginView='forgot-email';render()">Back</button></div></div></div>`;}
  if(UI.loginView==='forgot-newpw'){return `<div class="login-page"><div class="login-card"><div class="login-logo"><span class="jex">JEX</span></div><div class="login-sub">Forgot password — Step 3 of 3</div><div class="success-box">Security question answered correctly.</div><div class="frow"><label class="flabel">New password</label><div class="pw-wrap"><input type="password" id="forgot-pw1" placeholder="New password (min 6 characters)"><button type="button" class="pw-eye" onclick="togglePw('forgot-pw1')" tabindex="-1">👁</button></div></div><div class="frow"><label class="flabel">Confirm new password</label><div class="pw-wrap"><input type="password" id="forgot-pw2" placeholder="Repeat new password"><button type="button" class="pw-eye" onclick="togglePw('forgot-pw2')" tabindex="-1">👁</button></div></div><div class="login-actions"><button class="btn btn-primary" onclick="forgotStep3(get('forgot-pw1')?.value,get('forgot-pw2')?.value)">Reset password</button><button class="btn" onclick="UI.loginView='select';render()">Cancel</button></div></div></div>`;}
  if(UI.loginView==='recover-pw'){return `<div class="login-page"><div class="login-card"><div class="login-logo"><span class="jex">JEX</span></div><div class="login-sub">Set a new password</div><div class="ibox ibox-blue" style="margin-bottom:12px">You followed a password reset link. Choose a new password below.</div><div class="frow"><label class="flabel">New password</label><div class="pw-wrap"><input type="password" id="recover-pw1" placeholder="New password (min 6 characters)"><button type="button" class="pw-eye" onclick="togglePw('recover-pw1')" tabindex="-1">👁</button></div></div><div class="frow"><label class="flabel">Confirm new password</label><div class="pw-wrap"><input type="password" id="recover-pw2" placeholder="Repeat new password"><button type="button" class="pw-eye" onclick="togglePw('recover-pw2')" tabindex="-1">👁</button></div></div><div class="login-actions"><button class="btn btn-primary" onclick="finishPasswordRecovery(get('recover-pw1')?.value,get('recover-pw2')?.value)">Set password</button></div></div></div>`;}
  if(UI.loginView==='register'){
    const ga=UI.googleAuth;
    const gaName=ga?esc(ga.name||''):'';
    const gaEmail=ga?esc(ga.email||''):'';
    const gaUsername=ga?esc(genUsernameFromEmail(ga.email)):'';
    const gaBanner=ga?`<div class="ibox ibox-blue" style="margin-bottom:12px">🔵 Continuing with Google as <strong>${gaEmail}</strong> — no password needed.</div>`
      :`<button type="button" class="google-btn" style="margin-bottom:14px" onclick="signInWithGoogle()">${GOOGLE_G_SVG}<span>Sign up with Google</span></button><div style="text-align:center;font-size:11px;color:var(--text2);margin:-8px 0 14px">or fill in the form below</div>`;
    const studentSecretFields=ga?'':`<div class="frow"><label class="flabel">Password (min 6 characters)</label><div class="pw-wrap"><input type="password" id="reg-pw" placeholder="Choose a password"><button type="button" class="pw-eye" onclick="togglePw('reg-pw')" tabindex="-1">👁</button></div></div>
<div class="frow"><label class="flabel">Security question</label>${secQSelect('reg')}</div><div class="frow"><label class="flabel">Security answer</label><input type="text" id="reg-secq-answer" placeholder="Your answer" autocomplete="off"></div>`;
    const coSecretFields=ga?'':`<div class="frow"><label class="flabel">Password (min 6 characters)</label><div class="pw-wrap"><input type="password" id="reg-co-pw" placeholder="Choose a password"><button type="button" class="pw-eye" onclick="togglePw('reg-co-pw')" tabindex="-1">👁</button></div></div>`;
    const coSecQFields=ga?'':`<div class="frow"><label class="flabel">Security question</label>${secQSelect('reg-co')}</div><div class="frow"><label class="flabel">Security answer</label><input type="text" id="reg-co-secq-answer" placeholder="Your answer" autocomplete="off"></div>`;
    return `<div class="login-page"><div class="login-card"><div class="login-logo"><span class="jex">JEX</span></div><div class="login-sub">Create an account</div>${gaBanner}<div class="reg-tabs"><button class="reg-tab active" id="reg-tab-student" onclick="switchRegTab('student')">Student</button><button class="reg-tab" id="reg-tab-company" onclick="switchRegTab('company')">Company</button></div><div id="reg-student-fields"><div class="frow"><label class="flabel">Full name</label><input type="text" id="reg-name" placeholder="Your name" value="${gaName}"></div><div class="frow"><label class="flabel">Username</label><input type="text" id="reg-username" placeholder="e.g. arielk" autocomplete="username" value="${gaUsername}"></div><div class="frow"><label class="flabel">Email</label><input type="email" id="reg-email" placeholder="you@school.edu" value="${gaEmail}" ${ga?'readonly':''} oninput="onRegEmailChanged('reg')"></div><div id="reg-email-verify">${ga?'':renderRegEmailVerifyHTML('reg')}</div>${studentSecretFields}</div><div id="reg-company-fields" style="display:none"><div class="frow"><label class="flabel">Company name</label><input type="text" id="reg-co-name" placeholder="e.g. Acme Corp" value="${gaName}"></div><div class="frow"><label class="flabel">Username</label><input type="text" id="reg-co-username" placeholder="e.g. acmecorp" autocomplete="username" value="${gaUsername}"></div><div class="frow"><label class="flabel">Email</label><input type="email" id="reg-co-email" placeholder="you@school.edu" value="${gaEmail}" ${ga?'readonly':''} oninput="onRegEmailChanged('reg-co')"></div><div id="reg-co-email-verify">${ga?'':renderRegEmailVerifyHTML('reg-co')}</div>${coSecretFields}<div class="frow"><label class="flabel">Brief description</label><input type="text" id="reg-co-desc" placeholder="e.g. Renewable energy startup"></div><div class="ibox ibox-blue" style="margin-bottom:10px;font-size:12px">After your IPO is approved, you can invite up to 3 founders from My Stock → Founders.</div>${coSecQFields}</div><div style="font-size:12px;color:var(--text2);margin-bottom:12px">Your account will be reviewed before you can sign in. Your classroom will be assigned by your teacher after approval.</div><div class="frow" style="display:flex;align-items:flex-start;gap:8px"><input type="checkbox" id="reg-agree-tos" aria-label="I agree to the Terms of Service and Bylaws" style="width:auto;margin-top:2px"><span style="font-size:12px;color:var(--text2)">I agree to the <a class="legal-link" onclick="openLegalModal('tos')">Terms of Service</a> and <a class="legal-link" onclick="openLegalModal('bylaws')">Bylaws</a>.</span></div><div class="login-actions"><button class="btn btn-primary" onclick="doRegister()">Submit for approval</button><button class="btn" onclick="UI.googleAuth=null;UI.loginView='select';render()">Back</button></div></div></div>`;}
  if(!['admin','company','student'].includes(UI.loginTab))UI.loginTab='student';
  const tabCounts={admin:admins.length,company:companies.length,student:students.length};
  return `<div class="login-page"><div class="login-card"><div class="login-logo"><span class="jex">JEX</span></div><div class="login-tagline">JTED Stock Exchange</div>
  <div class="reg-tabs">
    <button class="reg-tab ${UI.loginTab==='admin'?'active':''}" onclick="switchLoginTab('admin')">Administrators${pending?'<span class="badge b-blue" style="margin-left:4px">'+pending+' pending</span>':''}</button>
    <button class="reg-tab ${UI.loginTab==='company'?'active':''}" onclick="switchLoginTab('company')">Companies</button>
    <button class="reg-tab ${UI.loginTab==='student'?'active':''}" onclick="switchLoginTab('student')">Students</button>
  </div>
  ${UI.loginTab!=='admin'?`<button type="button" class="google-btn" style="margin-bottom:14px" onclick="signInWithGoogle()">${GOOGLE_G_SVG}<span>Sign in with Google</span></button><div style="text-align:center;font-size:11px;color:var(--text2);margin:-8px 0 14px">or use a username and password</div>`:''}
  <div class="login-heading">Log in</div>
  <div class="frow"><label class="flabel">Username or Email</label><input type="text" id="login-username" placeholder="username or you@school.edu" value="${esc(UI.loginUsername)}" autocomplete="username" onkeydown="if(event.key==='Enter')loginByForm()"></div>
  <div class="frow"><label class="flabel">Password</label><div class="pw-wrap"><input type="password" id="login-password" placeholder="Enter password" autocomplete="current-password" onkeydown="if(event.key==='Enter')loginByForm()"><button type="button" class="pw-eye" onclick="togglePw('login-password')" tabindex="-1">👁</button></div></div>
  ${UI.loginError?`<div class="login-error">${esc(UI.loginError)}</div>`:''}
  <div class="login-actions"><button class="btn btn-primary" onclick="loginByForm()">Log in</button></div>
  <div class="login-forgot"><button class="link-btn" onclick="UI.loginView='forgot-email';render()">Forgot password?</button></div>
  <div class="login-signup">Don't have an account? <a class="signup-link" onclick="openRegisterView()">Sign up</a></div></div></div>`;
}
function switchRegTab(type){document.querySelectorAll('.reg-tab').forEach(t=>t.classList.remove('active'));const tab=get('reg-tab-'+type);if(tab)tab.classList.add('active');get('reg-student-fields').style.display=type==='student'?'':'none';get('reg-company-fields').style.display=type==='company'?'':'none';}
function doRegister(){
  if(!get('reg-agree-tos')?.checked)return toast('You must agree to the Terms of Service to register');
  const active=document.querySelector('.reg-tab.active');const type=active?.id==='reg-tab-company'?'company':'student';
  const prefix=type==='student'?'reg':'reg-co';
  const email=norm((get(prefix+'-email')?.value||'').trim());
  const ga=UI.googleAuth;
  if(ga){
    if(norm(ga.email)!==email)return toast('Email must match your Google account');
    if(type==='student')registerStudent(get('reg-name')?.value,get('reg-username')?.value,get('reg-email')?.value,null,null,null,true,'google',ga.authUid);
    else registerCompany(get('reg-co-name')?.value,get('reg-co-username')?.value,get('reg-co-email')?.value,null,get('reg-co-desc')?.value,null,null,true,'google',ga.authUid);
    return;
  }
  const vState=UI.regVerify[prefix];
  const isVerified=!!(vState&&vState.status==='verified'&&vState.email===email);
  if(emailjsReady()&&!isVerified)return toast('Please verify your email address before submitting');
  if(type==='student')registerStudent(get('reg-name')?.value,get('reg-username')?.value,get('reg-email')?.value,get('reg-pw')?.value,get('reg-secq')?.value,get('reg-secq-answer')?.value,isVerified);
  else registerCompany(get('reg-co-name')?.value,get('reg-co-username')?.value,get('reg-co-email')?.value,get('reg-co-pw')?.value,get('reg-co-desc')?.value,get('reg-co-secq')?.value,get('reg-co-secq-answer')?.value,isVerified);
}

// ═══════════════════════════════════════════════
// RENDER: CHROME
// ═══════════════════════════════════════════════
function renderTopbar(){
  const u=cu();
  const unread=myUnreadCount();
  const isLight=document.body.classList.contains('light-mode');
  const bellBtn=u.role==='student'||u.role==='company'?`<button class="logout-btn" style="position:relative;padding:3px 10px" onclick="UI.navTab='notifications';render()">
    🔔${unread?`<span style="position:absolute;top:-4px;right:-4px;background:var(--red);color:white;font-size:10px;min-width:16px;height:16px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:600">${unread}</span>`:''}
  </button>`:'';
  const rtConnected=_realtimeChannels.length>0;
  return `<div class="topbar"><div class="logo"><span class="jex">JEX</span><span class="sep"></span><span class="full">JTED Stock Exchange</span><span style="font-size:10px;margin-left:8px;color:${rtConnected?'var(--green)':'var(--text3)'}" title="${rtConnected?'Real-time connected':'Polling mode'}">${rtConnected?'●':'○'}</span></div><div class="user-pill"><div class="avatar ${avatarClass(u.role)}">${u.name.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase()}</div><span>${u.name}</span>${roleBadge(u.role)}${bellBtn}<button class="logout-btn" onclick="openBugReportModal()" title="Report a bug">🐛</button><button class="theme-btn" onclick="toggleTheme()" title="Toggle light/dark mode">${isLight?'🌙':'☀️'}</button><button class="logout-btn" onclick="logout()">sign out</button></div></div>`;
}
function toggleTheme(){
  document.body.classList.toggle('light-mode');
  try{localStorage.setItem('jex-theme',document.body.classList.contains('light-mode')?'light':'dark');}catch(e){}
  // Re-render topbar only
  const tb=document.querySelector('.topbar');if(tb)tb.outerHTML=renderTopbar();
  render();
}
function renderBanner(){
  const s=DB.session,cls=s.status==='open'?'s-open':s.status==='paused'?'s-paused':'s-closed';
  const _pracBanner=s&&s.practice_mode?'<div style="background:#f0a500;color:#000;text-align:center;padding:4px 12px;font-size:12px;font-weight:700">🎮 PRACTICE MODE — trades do not count toward rankings</div>':'';
  const timer=s.ends_at?'<span id="timer-el" class="timer">...</span>':'';
  const u=cu();const canControl=isAdmin(u);
  // Session open/pause/close is Chairman/President only (isChairman() already covers
  // both roles) — a narrower gate than the other admin controls on this banner, like
  // deleting announcements, which stay open to every officer.
  const canControlSession=isChairman(u);
  const ann=DB.announcements&&DB.announcements[0]||null;
  let annHtml='';
  if(ann){
    const annColor=ann.level==='urgent'?'background:rgba(255,77,106,0.12);border-bottom:1px solid rgba(255,77,106,0.25);color:#ff4d6a':ann.level==='warning'?'background:rgba(240,165,0,0.1);border-bottom:1px solid rgba(240,165,0,0.2);color:var(--amber)':'background:rgba(55,138,221,0.08);border-bottom:1px solid rgba(55,138,221,0.2);color:#85B7EB';
    const delBtn=canControl?('<button class="btn btn-sm btn-danger" style="font-size:11px;padding:2px 8px" onclick="deleteAnnouncement(&#39;'+ann.id+'&#39;)">&#x2715;</button>'):'';
    annHtml='<div style="'+annColor+';padding:8px 20px;font-size:13px;display:flex;align-items:center;justify-content:space-between"><span>📢 <strong>'+esc(ann.title)+'</strong>'+(ann.body?' — '+esc(ann.body):'')+' <span style="font-size:11px;opacity:0.7;margin-left:8px">'+esc(ann.author_name||'')+' · '+(ann.ts||'')+'</span></span>'+delBtn+'</div>';
  }
  let sessionBtns='';
  if(canControlSession){
    const openBtn=s.status!=='open'?'<button class="btn btn-sm btn-success" onclick="setSession(&quot;open&quot;)">Open</button>':'';
    const pauseBtn=s.status==='open'?'<button class="btn btn-sm" style="border-color:var(--amber);color:var(--amber)" onclick="setSession(&quot;paused&quot;)">Pause</button>':'';
    const closeBtn=s.status!=='closed'?'<button class="btn btn-sm btn-danger" onclick="setSession(&quot;closed&quot;)">Close</button>':'';
    sessionBtns='<div style="display:flex;gap:6px">'+openBtn+' '+pauseBtn+' '+closeBtn+'</div>';
  }
  return annHtml+'<div class="session-banner '+cls+'"><span>'+s.label+timer+'</span>'+sessionBtns+'</div>';
}
function renderNav(){
  const u=cu();
  let tabs;
  if(isChairman(u))tabs=[['admin','Admin'],['market','Market'],['funds','Funds'],['leaderboard','Leaderboard'],['trades','All trades'],['settings','Settings']];
  else if(isAdmin(u))tabs=[['admin','Admin'],['market','Market'],['funds','Funds'],['settings','Settings']];
  else if(u.role==='company')tabs=[['market','Market'],['exchange','Exchange'],['portfolio','Portfolio'],['funds','Funds'],['news','News'],['mystock','My stock'],['notifications','🔔'+(myUnreadCount()?` <span class="badge b-red" style="font-size:10px">${myUnreadCount()}</span>`:'')],['settings','Settings']];
  else tabs=[['market','Market'],['exchange','Exchange'],['portfolio','Portfolio'],['funds','Funds'],['leaderboard','Leaderboard'],['orders','Orders'+(()=>{if(!UI.userId)return'';const u=DB.users.find(x=>x.id===UI.userId);if(!u)return'';const open=(DB.limitOrders||[]).filter(o=>o.user_id===u.id&&o.status==='open').length;const ah=(DB.limitOrders||[]).filter(o=>o.user_id===u.id&&o.status==='after_hours').length;const sl=(DB.stopLossOrders||[]).filter(s=>s.user_id===u.id&&s.status==='active').length;const tot=open+ah+sl;return tot?' <span class="badge b-amber" style="font-size:10px">'+tot+'</span>':''})()],['trades','Trades'],['notifications','🔔'+(myUnreadCount()?` <span class="badge b-red" style="font-size:10px">${myUnreadCount()}</span>`:'')],['settings','Settings']];
  return `<div class="nav">${tabs.map(([k,v])=>PAGE_ROUTES.has(k)
    ?`<a class="nav-btn ${UI.navTab===k?'active':''}" href="${pageHref(k)}">${v}</a>`
    :`<button class="nav-btn ${UI.navTab===k?'active':''}" onclick="setTab('${k}')">${v}</button>`).join('')}</div>`;
}

// ═══════════════════════════════════════════════
// RENDER: NEWS (public feed)
// ═══════════════════════════════════════════════
function renderNewsFeed(){
  const items=DB.news;
  const u=cu();const canDelete=isAdmin(u);
  if(!items.length)return`<div class="card"><div class="empty">No company news yet. Companies can post updates from their News tab.</div></div>`;
  return items.map(n=>`<div class="news-item">
    <div class="news-headline">${esc(n.headline)}</div>
    ${n.body?`<div class="news-body">${esc(n.body||"")}</div>`:''}
    <div class="news-meta" style="justify-content:space-between">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="news-ticker">${n.ticker}</span>
        <span>${esc(n.company_name)}</span>
        <span>${n.ts||''}</span>
      </div>
      ${canDelete?`<button class="btn btn-sm btn-danger" onclick="deleteNews('${n.id}')">Delete</button>`:''}
    </div>
  </div>`).join('');
}

// ═══════════════════════════════════════════════
// RENDER: MARKET
// ═══════════════════════════════════════════════
function renderCompanyPage(parentTicker){
  const co=getCo(parentTicker);if(!co)return'<div class="empty">Company not found</div>';
  const u=cu();
  const allTickers=getCompanyTickers(parentTicker);
  const held=(holdings(u)[parentTicker])||0;
  const short=(shorts(u))[parentTicker];
  const chg=priceChg(co);
  const canTrade=u.role==='student'||u.role==='company';
  const isOwner=co.owner_id===u.id;
  const isCoFounder=DB.companyMembers.some(m=>m.company_user_id===co.owner_id&&m.student_id===u.id&&m.status==='accepted');
  const isMember=isOwner||isCoFounder;
  const baseMeta=DB.shareClasses.find(c=>c.ticker===parentTicker);
  const companyVotes=DB.votes.filter(v=>v.parent_ticker===parentTicker);
  const companyNews=DB.news.filter(n=>n.ticker===parentTicker).slice(0,10);
  const companyDivs=DB.dividends.filter(d=>d.ticker===parentTicker).reverse();
  const companyTrades=[...DB.trades].filter(t=>allTickers.includes(t.ticker)).reverse().slice(0,30);
  // Shareholders
  const shareholderMap={};
  allTickers.forEach(ticker=>{
    DB.users.filter(u2=>u2.role==='student'&&(holdings(u2)[ticker]||0)>0).forEach(u2=>{
      if(!shareholderMap[u2.id])shareholderMap[u2.id]={name:u2.name,shares:{}};
      shareholderMap[u2.id].shares[ticker]=(holdings(u2)[ticker]||0);
    });
  });
  const shareholders=Object.values(shareholderMap);
  const totalCirculating=allTickers.reduce((s,t)=>{const c=getCo(t);return s+(c?c.shares-c.shares_avail:0);},0);

  const tab=UI.companyPageTab;

  let html=`<div id="company-page-content">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
    <button class="btn btn-sm" onclick="closeCompanyPage()">← Market</button>
    ${co.logo?`<img src="${co.logo}" style="width:40px;height:40px;object-fit:cover;border-radius:8px;border:1px solid var(--border)">`:''}
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:18px;font-weight:500">${esc(co.name)}</span>
        ${isHalted(parentTicker)?`<span class="badge b-red">⚠️ Trading halted${(()=>{const h=DB.halts.find(x=>x.ticker===parentTicker);return h?' — '+h.reason:'';})()}</span>`:''}
        ${baseMeta?'<span class="badge b-amber">Class '+baseMeta.class+' · '+baseMeta.votes_per_share+'v</span>':''}
        <span class="badge b-gray" style="font-family:var(--mono)">${parentTicker}</span>
        ${canTrade?'<button class="wstar '+(isWatched(parentTicker)?'on':'')+'" onclick="toggleWatchAndRefresh(&quot;'+parentTicker+'&quot;)">'+(isWatched(parentTicker)?'★':'☆')+'</button>':''}
      </div>
      <div style="font-size:13px;color:var(--text2);margin-top:2px">${esc(co.description||'')}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:28px;font-weight:500;font-family:var(--mono)">${fmt(co.price)}</div>
      <div class="${chg>=0?'price-up':'price-down'}" style="font-size:14px">${fmtChg(chg)}</div>
    </div>
  </div>

  <div class="tab-row" style="margin-bottom:16px">
    <button class="tab ${tab==='overview'?'active':''}" onclick="UI.companyPageTab='overview';render()">Overview</button>
    <button class="tab ${tab==='trade'?'active':''}" onclick="UI.companyPageTab='trade';render()">${canTrade?'Trade':'Trade'}</button>

    ${co.is_index_fund?'':`<button class="tab ${tab==='news'?'active':''}" onclick="UI.companyPageTab='news';render()">News ${companyNews.length?'<span class="badge b-amber" style="margin-left:4px">'+companyNews.length+'</span>':''}</button>
    <button class="tab ${tab==='votes'?'active':''}" onclick="UI.companyPageTab='votes';render()">Votes ${companyVotes.filter(v=>v.status==='open').length?'<span class="badge b-green" style="margin-left:4px">'+companyVotes.filter(v=>v.status==='open').length+'</span>':''}</button>`}
    <button class="tab ${tab==='shareholders'?'active':''}" onclick="UI.companyPageTab='shareholders';render()">${co.is_index_fund?'Holders':'Shareholders'}</button>
    ${co.is_index_fund?'':`<button class="tab ${tab==='team'?'active':''}" onclick="UI.companyPageTab='team';render()">Team</button>
    <button class="tab ${tab==='financials'?'active':''}" onclick="UI.companyPageTab='financials';render()">Financials ${co.financials&&co.financials.length?'<span class="badge b-gray" style="margin-left:4px">'+co.financials.length+'</span>':''}</button>
    <button class="tab ${tab==='dividends'?'active':''}" onclick="UI.companyPageTab='dividends';render()">Dividends</button>`}
    ${canTrade?`<button class="tab ${tab==='alerts'?'active':''}" onclick="UI.companyPageTab='alerts';render()">🎯 Alerts ${DB.priceAlerts.filter(a=>a.user_id===u.id&&a.ticker===parentTicker&&!a.triggered).length?'<span class="badge b-blue" style="margin-left:4px">'+DB.priceAlerts.filter(a=>a.user_id===u.id&&a.ticker===parentTicker&&!a.triggered).length+'</span>':''}</button>`:''}
    <button class="tab ${tab==='trades'?'active':''}" onclick="UI.companyPageTab='trades';render()">Trade history</button>
  </div>`;
  // Index funds have no owner/company behind them -- if UI.companyPageTab
  // is left pointing at a tab that was just hidden above (e.g. navigated
  // here right after viewing a real company's Financials tab), fall back to
  // Overview instead of rendering a blank/broken tab body below.
  if(co.is_index_fund&&['news','votes','team','financials','dividends'].includes(tab)){UI.companyPageTab='overview';return renderCompanyPage(parentTicker);}

  if(tab==='overview'&&co.is_index_fund){
    // No owner, no IPO, no share classes, no shorting -- none of the usual
    // company-overview concepts apply to an index tracker. Composition
    // mirrors the constituents table on the market page's index card.
    const idx=computeJXI();
    html+='<div class="grid4" style="margin-bottom:14px">'
      +'<div class="mcard"><div class="mlabel">Price</div><div class="mval" style="font-family:var(--mono)">'+fmt(co.price)+'</div></div>'
      +'<div class="mcard"><div class="mlabel">Holders</div><div class="mval">'+shareholders.length+'</div></div>'
      +'<div class="mcard"><div class="mlabel">Units outstanding</div><div class="mval">'+co.shares.toLocaleString()+'</div></div>'
      +'<div class="mcard"><div class="mlabel">Constituents</div><div class="mval">'+idx.constituents.length+'</div></div>'
      +'</div>'
      +'<div class="ibox ibox-blue" style="margin-bottom:14px">Tracks the JEX Composite Index — an equal-weighted average of every listed company. Price updates automatically to match the live index value and can\'t be manually adjusted. Buying mints new units at the live price; selling redeems them, so there\'s no fixed share supply.</div>';
    html+='<div class="card"><div class="section-title">Composition</div><table><thead><tr><th>Company</th><th>Ticker</th><th class="r">Price</th><th class="r">Today</th></tr></thead>'
      +'<tbody>'+idx.constituents.map(c=>{const cco=getCo(c.ticker);const cchg=cco?priceChg(cco):0;return'<tr><td>'+esc(c.name)+'</td><td><span class="badge b-gray" style="font-family:var(--mono)">'+esc(c.ticker)+'</span></td><td class="r" style="font-family:var(--mono)">'+fmt(c.price)+'</td><td class="r '+(cchg>=0?'price-up':'price-down')+'">'+(cchg>=0?'+':'')+cchg.toFixed(2)+'%</td></tr>';}).join('')
      +'</tbody></table></div>';
  } else if(tab==='overview'){
    // Key stats
    const totalMktCap=allTickers.reduce((s,t)=>{const c=getCo(t);return s+(c?c.price*c.shares:0);},0);
    // Capital raised = total value of all shares sold from exchange pool
    const capitalRaised=DB.trades.filter(t=>allTickers.includes(t.ticker)&&t.seller_id==='exchange').reduce((s,t)=>s+Math.round(t.price*t.qty*100)/100,0);
    const owner=getUser(co.owner_id);
    // Short interest
    const totalShorted=DB.users.filter(u2=>u2.role==='student').reduce((s,u2)=>{
      const sh=u2.shorts||{};
      return s+allTickers.reduce((ts,t)=>ts+(sh[t]?.qty||0),0);
    },0);
    const totalFloat=allTickers.reduce((s,t)=>{const c=getCo(t);return s+(c?c.shares-c.shares_avail:0);},0);
    const shortInterestPct=totalFloat>0?Math.round(totalShorted/totalFloat*1000)/10:0;
    html+='<div class="grid4" style="margin-bottom:14px">'
      +'<div class="mcard"><div class="mlabel">Price</div><div class="mval" style="font-family:var(--mono)">'+fmt(co.price)+'</div></div>'
      +'<div class="mcard"><div class="mlabel">Total market cap</div><div class="mval" style="font-family:var(--mono)">'+fmt(totalMktCap)+'</div></div>'
      +'<div class="mcard"><div class="mlabel">Shareholders</div><div class="mval">'+shareholders.length+'</div></div>'
      +'<div class="mcard"><div class="mlabel">In circulation</div><div class="mval">'+totalCirculating.toLocaleString()+'</div></div>'
      +'</div>'
      +'<div class="grid4" style="margin-bottom:14px">'
      +(()=>{const hs=calcHealthScore(co);return hs!=null?'<div class="mcard"><div class="mlabel">Company health'+infoBubble('A 0-100 score combining price stability (up to ±20), the cash cushion the company holds relative to its market cap (up to +15), short-seller interest against it (up to -15), and dividend history (+5 to +10). Starts from a baseline of 50.')+'</div><div class="mval '+(hs>=70?'green':hs>=40?'':'red')+'" style="font-size:20px">'+hs+'/100</div><div style="font-size:10px;color:var(--text2);margin-top:2px">'+(hs>=70?'✓ Healthy':hs>=40?'⚠ Moderate':'✗ At risk')+'</div></div>':''})()
      +'<div class="mcard"><div class="mlabel">Short interest</div><div class="mval '+(shortInterestPct>20?'red':'')+'">'+shortInterestPct+'%</div><div style="font-size:11px;color:var(--text2);margin-top:2px">'+totalShorted+' shares short</div></div>'
      +'<div class="mcard"><div class="mlabel">Capital raised (IPO)</div><div class="mval" style="font-family:var(--mono);color:var(--green)">'+fmt(capitalRaised)+'</div></div>'
      +'<div class="mcard"><div class="mlabel">Company cash</div><div class="mval" style="font-family:var(--mono)">'+(owner?fmt(owner.cash):'—')+'</div><div style="font-size:10px;color:var(--text2);margin-top:2px">After dividends & buybacks</div></div>'
      +'<div class="mcard"><div class="mlabel">Available shares</div><div class="mval">'+allTickers.reduce((s,t)=>{const c=getCo(t);return s+(c?c.shares_avail:0);},0).toLocaleString()+'</div></div>'
      +'</div>'

    // Funding goal, if the company has set one
    if(co.funding_goal){
      const fundPct=Math.min(100,Math.round(capitalRaised/co.funding_goal*100));
      html+='<div class="card"><div class="section-title">Funding goal</div>'
        +'<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px"><span style="font-weight:500">'+fmt(capitalRaised)+' raised</span><span style="color:var(--text2)">of '+fmt(co.funding_goal)+' goal ('+fundPct+'%)</span></div>'
        +'<div class="sbar-bg" style="height:8px"><div class="sbar-fill" style="height:8px;width:'+fundPct+'%;background:'+(fundPct>=100?'var(--green)':'var(--blue)')+'"></div></div>'
        +(co.use_of_funds?'<div style="font-size:13px;color:var(--text2);margin-top:10px;white-space:pre-wrap">'+esc(co.use_of_funds)+'</div>':'')
        +'</div>';
    }

    // Latest financials, if the company has posted any
    if(co.financials&&co.financials.length){
      const lf=co.financials[0];
      html+='<div class="card" style="cursor:pointer" onclick="UI.companyPageTab=&quot;financials&quot;;render()"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><div class="section-title" style="margin-bottom:0">Latest financials — '+esc(lf.period)+'</div><span style="font-size:12px;color:var(--blue)">View all →</span></div><div class="grid3"><div class="mcard"><div class="mlabel">Revenue</div><div class="mval" style="font-family:var(--mono)">'+fmt(lf.revenue)+'</div></div><div class="mcard"><div class="mlabel">Profit</div><div class="mval" style="font-family:var(--mono);color:'+(lf.profit>=0?'var(--green)':'var(--red)')+'">'+fmt(lf.profit)+'</div></div><div class="mcard"><div class="mlabel">Margin</div><div class="mval" style="font-family:var(--mono)">'+(lf.revenue>0?Math.round(lf.profit/lf.revenue*100)+'%':'—')+'</div></div></div></div>';
    }

    // All share classes
    html+='<div class="card"><div class="section-title">Share classes</div>';
    allTickers.forEach(ticker=>{
      const stock=getCo(ticker);if(!stock)return;
      const meta=getClassMeta(ticker);
      const chartId='cp-chart-'+ticker;
      const classLabel=meta?'Class '+meta.class:'Common';
      const classColor=meta?(meta.class==='A'?'b-blue':meta.class==='B'?'b-amber':'b-teal'):'b-gray';
      html+='<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">'
        +'<div><div style="display:flex;align-items:center;gap:6px;margin-bottom:2px"><span style="font-family:var(--mono);font-weight:500">'+ticker+'</span><span class="badge '+classColor+'">'+classLabel+'</span>'+(meta&&meta.restricted?'<span class="badge b-red">Restricted</span>':'')+'</div>'
        +'<div style="font-size:11px;color:var(--text2)">'+(meta?meta.votes_per_share+' vote'+(meta.votes_per_share!==1?'s':'')+'/share':'1 vote/share')+'</div></div>'
        +'<div><div style="font-size:11px;color:var(--text2);margin-bottom:2px">Price</div><div style="font-family:var(--mono);font-weight:500">'+fmt(stock.price)+'</div></div>'
        +'<div><div style="font-size:11px;color:var(--text2);margin-bottom:2px">Change</div><div id="chg-badge-'+chartId+'" class="'+tickerChgClass(chartId,stock)+'" style="font-family:var(--mono)">'+tickerChgBadgeHtml(chartId,stock)+'</div></div>'
        +'<div><div style="font-size:11px;color:var(--text2);margin-bottom:2px">Available</div><div style="font-size:13px">'+stock.shares_avail.toLocaleString()+' / '+stock.shares.toLocaleString()+'</div></div>'
        +'<div><div style="font-size:11px;color:var(--text2);margin-bottom:2px">Mkt cap</div><div style="font-family:var(--mono);font-size:13px">'+fmt(stock.price*stock.shares)+'</div></div>'
        +'</div>';
    });
    html+='</div>';
  }
  if(tab==='overview'){
    // Price charts -- shared by both branches above (index funds still get
    // their own price chart, just none of the company-specific sections).
    html+='<div class="card"><div class="section-title">Price charts</div>'
      +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">';
    allTickers.forEach(ticker=>{
      const stock=getCo(ticker);if(!stock)return;
      const meta=getClassMeta(ticker);
      const chartId='cp-chart-'+ticker;
      html+='<div><div style="margin-bottom:4px">'
        +'<div style="font-size:12px;font-weight:500;font-family:var(--mono);color:var(--text2)">'+ticker+(meta?' Class '+meta.class:'')+'</div></div>'
        +buildChartIntervalBar(chartId,stock)
        +'<div style="position:relative;height:140px"><canvas id="'+chartId+'"></canvas></div></div>';
    });
    html+='</div></div>';


  }

  else if(tab==='trade'){
    if(!canTrade){html+='<div class="card"><div class="empty">Sign in as a student or company to trade.</div></div>';}
    else{
      const mode=UI.panelMode;
      const book=getOrderBook(parentTicker);
      // Order book display
      html+='<div class="card" style="margin-bottom:14px"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between"><span>Order book'+infoBubble('The list of limit orders waiting to be filled: bids are buy orders below or at their price, asks are sell orders at or above theirs. When a bid and ask cross, they match and trade instantly. If nothing crosses, orders sit here until they do (or a market order fills them from the JEX pool).')+' <span style="font-size:12px;font-weight:400;color:var(--text2)">'+parentTicker+'</span></span></div>';
      if(!book.bids.length&&!book.asks.length){
        html+='<div style="font-size:12px;color:var(--text2);padding:8px 0">No open limit orders — all trades go directly to JEX pool.</div>';
      } else {
        html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">';
        // Asks (sells) - shown in red, best ask at top
        html+='<div><div style="font-size:11px;font-weight:600;color:var(--red);margin-bottom:6px;letter-spacing:0.5px">ASKS (sellers)</div>';
        if(book.asks.length){
          // Show up to 5 best asks
          book.asks.slice(0,5).forEach(o=>{
            const displayQty=o.iceberg_visible||o.qty;
            const isIceberg=o.iceberg_visible&&o.qty>o.iceberg_visible;
            const pct=book.asks[0]?Math.round((o.limit_price/book.asks[0].limit_price)*100):100;
            html+='<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px;margin-bottom:3px;border-radius:4px;position:relative;overflow:hidden">'
              +'<div style="position:absolute;right:0;top:0;bottom:0;background:rgba(255,77,106,0.08);width:'+pct+'%"></div>'
              +'<span style="font-family:var(--mono);font-size:13px;font-weight:500;color:var(--red);position:relative">'+fmt(o.limit_price)+'</span>'
              +'<span style="font-size:12px;color:var(--text2);position:relative">'+displayQty+(isIceberg?'<span title="Iceberg order"> 🧊</span>':'')+' shares</span>'
              +'</div>';
          });
          if(book.asks.length>5)html+='<div style="font-size:11px;color:var(--text3);padding:2px 8px">+' +(book.asks.length-5)+' more</div>';
        } else html+='<div style="font-size:12px;color:var(--text3);padding:4px 8px">No asks</div>';
        html+='</div>';
        // Bids (buys) - shown in green, best bid at top
        html+='<div><div style="font-size:11px;font-weight:600;color:var(--green);margin-bottom:6px;letter-spacing:0.5px">BIDS (buyers)</div>';
        if(book.bids.length){
          book.bids.slice(0,5).forEach(o=>{
            const bidDisplayQty=o.iceberg_visible||o.qty;
            const isBidIceberg=o.iceberg_visible&&o.qty>o.iceberg_visible;
            const pct=book.bids[0]?Math.round((o.limit_price/book.bids[0].limit_price)*100):100;
            html+='<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px;margin-bottom:3px;border-radius:4px;position:relative;overflow:hidden">'
              +'<div style="position:absolute;left:0;top:0;bottom:0;background:rgba(0,200,150,0.08);width:'+pct+'%"></div>'
              +'<span style="font-family:var(--mono);font-size:13px;font-weight:500;color:var(--green);position:relative">'+fmt(o.limit_price)+'</span>'
              +'<span style="font-size:12px;color:var(--text2);position:relative">'+o.qty+' shares</span>'
              +'</div>';
          });
          if(book.bids.length>5)html+='<div style="font-size:11px;color:var(--text3);padding:2px 8px">+' +(book.bids.length-5)+' more</div>';
        } else html+='<div style="font-size:12px;color:var(--text3);padding:4px 8px">No bids</div>';
        html+='</div></div>';
        // Spread
        if(book.spread!==null){
          html+='<div style="display:flex;gap:16px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:12px">'
            +'<span style="color:var(--text2)">Best bid: <strong style="color:var(--green);font-family:var(--mono)">'+fmt(book.bestBid)+'</strong></span>'
            +'<span style="color:var(--text2)">Best ask: <strong style="color:var(--red);font-family:var(--mono)">'+fmt(book.bestAsk)+'</strong></span>'
            +'<span style="color:var(--text2)">Spread: <strong style="font-family:var(--mono)">'+fmt(book.spread)+'</strong></span>'
            +'</div>';
        }
      }
      html+='</div>';
      html+='<div class="grid4" style="margin-bottom:14px">'
        +'<div class="mcard"><div class="mlabel">Current price</div><div class="mval" style="font-family:var(--mono)">'+fmt(co.price)+'</div></div>'
        +'<div class="mcard"><div class="mlabel">Your cash</div><div class="mval" style="font-family:var(--mono)">'+fmt(u.cash)+'</div></div>'
        +'<div class="mcard"><div class="mlabel">You hold</div><div class="mval">'+held+' shares</div></div>'
        +'<div class="mcard"><div class="mlabel">Short position</div><div class="mval '+(short?'red':'')+'">'+( short?short.qty+' @ '+fmt(short.avgPrice):'—')+'</div></div>'
        +'</div>';
      // JXI (is_index_fund): only market buy/sell are wired up server-side
      // (see rpc_trade_buy/sell/short/cover_short's is_index_fund branches)
      // -- limit orders still assume order-book dynamics that don't apply
      // to a NAV-priced instrument, so that control stays hidden. Shorting
      // is enabled: it's collateral-backed borrowing against the live NAV,
      // same shape as any other stock, just priced off jxi_live_value()
      // instead of price-impact.
      const idxFund=!!co.is_index_fund;
      const effMode=mode;
      html+='<div class="card"><div class="ot-toggle">'
        +'<button class="ot-btn '+(effMode==='buy'?'ot-buy':'')+'" onclick="UI.panelMode=&quot;buy&quot;;render()">Buy</button>'
        +'<button class="ot-btn '+(effMode==='sell'?'ot-sell':'')+'" onclick="UI.panelMode=&quot;sell&quot;;render()">Sell</button>'
        +'<button class="ot-btn '+(effMode==='short'?'ot-short':'')+'" onclick="UI.panelMode=&quot;short&quot;;render()">Short</button>'
        +(short?'<button class="ot-btn '+(effMode==='cover'?'ot-cover':'')+'" onclick="UI.panelMode=&quot;cover&quot;;render()">Cover</button>':'')
        +'</div>';
      if(effMode==='buy'){
        html+=(idxFund?'<p style="font-size:12px;color:var(--text2);margin-bottom:8px">Buys mint new units at the live index price — there\'s no fixed supply to run out of.</p>':
          '<p style="font-size:12px;color:var(--text2);margin-bottom:8px">Available: <strong>'+co.shares_avail+'</strong> of '+co.shares.toLocaleString()+'</p>')
          +'<div class="row" style="align-items:flex-end"><div class="frow" style="flex:1"><label class="flabel">Quantity</label><input type="number" id="cp-qty" value="1" min="1"'+(idxFund?'':' max="'+co.shares_avail+'"')+'></div>'
          +'<div style="padding-bottom:12px"><button class="btn btn-success" onclick="disableTradeBtn(this);cpTrade(&quot;buy&quot;)">Buy now</button></div></div>'
          +'<div id="cp-preview">'+impactPreview(co,1,'buy')+'</div>'
          +(idxFund?'':'<hr class="divider" style="margin:10px 0"><div style="font-size:12px;font-weight:500;margin-bottom:8px;color:var(--text2)">Or place a limit buy'+infoBubble('A limit order only fills at your chosen price or better, instead of the current market price right now. It may sit unfilled until the price crosses your limit, or fill instantly if it already has.')+'</div>'
          +'<div class="row" style="align-items:flex-end"><div class="frow" style="flex:1"><label class="flabel">Qty</label><input type="number" id="cp-lmt-qty" value="1" min="1"></div>'
          +'<div class="frow" style="flex:1"><label class="flabel">Limit price ($)</label><input type="number" id="cp-lmt-price" placeholder="'+co.price.toFixed(2)+'" step="0.01" min="0.01"></div>'
          +'<div class="frow" style="flex:1"><label class="flabel">Order type</label><select id="limit-order-type"><option value="gtc">GTC (Good till cancelled)</option><option value="day">Day order (expires at close)</option></select></div>'
          +'<div style="padding-bottom:12px"><button class="btn btn-primary" onclick="cpLimit(&quot;buy&quot;)">Place limit</button></div></div>');
      } else if(effMode==='sell'){
        html+='<p style="font-size:12px;color:var(--text2);margin-bottom:8px">You hold: <strong>'+held+'</strong></p>';
        if(held>0){
          html+='<div class="row" style="align-items:flex-end"><div class="frow" style="flex:1"><label class="flabel">Quantity</label><input type="number" id="cp-qty" value="1" min="1" max="'+held+'"></div>'
            +'<div style="padding-bottom:12px"><button class="btn btn-danger" onclick="disableTradeBtn(this);cpTrade(&quot;sell&quot;)">Sell now</button></div></div>'
            +'<div id="cp-preview">'+impactPreview(co,1,'sell')+'</div>'
            +(idxFund?'':'<hr class="divider" style="margin:10px 0"><div style="font-size:12px;font-weight:500;margin-bottom:8px;color:var(--text2)">Or place a limit sell'+infoBubble('A limit order only fills at your chosen price or better, instead of the current market price right now. It may sit unfilled until the price crosses your limit, or fill instantly if it already has.')+'</div>'
            +'<div class="row" style="align-items:flex-end"><div class="frow" style="flex:1"><label class="flabel">Qty</label><input type="number" id="cp-lmt-sty" value="1" min="1" max="'+held+'"></div>'
            +'<div class="frow" style="flex:1"><label class="flabel">Limit price ($)</label><input type="number" id="cp-lmt-sprice" placeholder="'+co.price.toFixed(2)+'" step="0.01" min="0.01"></div>'
            +'<div class="frow" style="flex:1"><label class="flabel">Type</label><select id="limit-order-type-sell"><option value="gtc">GTC</option><option value="day">Day</option><option value="fok">FOK</option></select></div>'
            +'<div style="padding-bottom:12px"><button class="btn btn-danger" onclick="cpLimit(&quot;sell&quot;)">Place limit</button></div></div>');
        } else {
          html+='<div class="empty" style="padding:16px">You don&#39;t hold any '+parentTicker+'.</div>';
        }
      } else if(effMode==='short'){
        html+='<div class="ibox ibox-purple">Short selling'+infoBubble('Short selling profits when a price FALLS, the opposite of a normal buy. You borrow shares and sell them now; later you buy them back to cover, hopefully at a lower price. The difference is your profit or loss, but losses are uncapped since a price can rise indefinitely.')+' — borrow and sell shares expecting price to fall. Requires 1.5× collateral.</div>'
          +'<div class="row" style="align-items:flex-end"><div class="frow" style="flex:1"><label class="flabel">Quantity to short</label><input type="number" id="cp-qty" value="1" min="1"></div>'
          +'<div style="padding-bottom:12px"><button class="btn btn-purple" onclick="cpTrade(&quot;short&quot;)">Short sell</button></div></div>'
          +'<div id="cp-preview">'+shortPrev(co,1)+'</div>';
      } else if(short){
        html+='<div class="ibox ibox-purple">Buy back borrowed shares to close your position.</div>'
          +'<div style="font-size:13px;margin-bottom:10px">Open: <strong>'+short.qty+' shares</strong> @ avg '+fmt(short.avgPrice)+' | P&L: <span class="'+(( short.avgPrice-co.price)*short.qty>=0?'price-up':'price-down')+'">'+fmt((short.avgPrice-co.price)*short.qty)+'</span></div>'
          +'<div class="row" style="align-items:flex-end"><div class="frow" style="flex:1"><label class="flabel">Quantity to cover</label><input type="number" id="cp-qty" value="'+short.qty+'" min="1" max="'+short.qty+'"></div>'
          +'<div style="padding-bottom:12px"><button class="btn btn-warning" onclick="cpTrade(&quot;cover&quot;)">Cover short</button></div></div>'
          +'<div id="cp-preview">'+impactPreview(co,short.qty,'buy')+'</div>';
      }
      // Stop-loss section -- not offered for JXI, same reasoning as limit/short above.
      if(!idxFund){
      const myStopLoss=DB.stopLossOrders.find(s=>s.user_id===u.id&&s.ticker===parentTicker&&s.status==='active');
      html+='<div class="card" style="margin-top:14px"><div class="section-title">🛑 Stop-loss order</div>'
        +'<div class="ibox ibox-purple">Automatically sells all your shares if the price drops to your trigger price.</div>';
      if(myStopLoss){
        html+='<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;margin-bottom:8px">'
          +'<div><div style="font-size:13px">Active: sell '+myStopLoss.shares+'×'+parentTicker+' if price ≤ <strong style="color:var(--red);font-family:var(--mono)">'+fmt(myStopLoss.trigger_price)+'</strong></div>'
          +'<div style="font-size:11px;color:var(--text2)">Set '+myStopLoss.ts+'</div></div>'
          +'<button class="btn btn-sm btn-danger" onclick="cancelStopLoss(&quot;'+myStopLoss.id+'&quot;)">Cancel</button></div>';
      } else if(held>0) {
        html+='<div class="row" style="align-items:flex-end">'
          +'<div class="frow" style="flex:1"><label class="flabel">Trigger price ($) — current: '+fmt(co.price)+'</label>'
          +'<input type="number" id="sl-price-'+parentTicker+'" placeholder="e.g. '+Math.round(co.price*0.85*100)/100+'" step="0.01" min="0.01" max="'+( Math.round(co.price*0.999*100)/100)+'"></div>'
          +'<div style="padding-bottom:12px"><button class="btn btn-danger" onclick="doPlaceStopLoss(&quot;'+parentTicker+'&quot;)">Set stop-loss</button></div>'
          +'</div>';
      } else {
        html+='<div style="font-size:13px;color:var(--text2)">You don&#39;t hold any '+parentTicker+' shares.</div>';
      }
      html+='</div>';
      }
      html+='</div>';
    }
  }

  else if(tab==='news'){
    html+=companyNews.length?'<div class="card"><div class="section-title">News</div>'+companyNews.map(n=>'<div class="news-item"><div class="news-headline">'+esc(n.headline)+'</div>'+(n.body?'<div class="news-body">'+esc(n.body)+'</div>':'')+'<div class="news-meta">'+(n.ts||'')+'</div></div>').join('')+'</div>':'<div class="card"><div class="empty">No news posted yet.</div></div>';
  }

  else if(tab==='votes'){
    html+=companyVotes.length?companyVotes.map(v=>renderVoteCard(v,isOwner,isAdmin(u))).join(''):'<div class="card"><div class="empty">No votes posted yet.</div></div>';
  }

  else if(tab==='shareholders'){
    html+='<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">Shareholders <span id="shareholder-loading" style="font-size:11px;font-weight:400;color:var(--text2)">Loading fresh data...</span></div><div id="shareholder-table">';
    if(!shareholders.length){html+='<div class="empty">No shareholders yet.</div>';}
    else{
      html+='<table><thead><tr><th>Holder</th>'
        +allTickers.map(t=>'<th class="r">'+t+'</th>').join('')
        +'<th class="r">Total</th><th class="r">Voting power</th></tr></thead><tbody>'
        +shareholders.map(sh=>{
          const total=Object.values(sh.shares).reduce((s,q)=>s+q,0);
          const vp=allTickers.reduce((s,t)=>{const meta=getClassMeta(t);const vps=meta?meta.votes_per_share:1;return s+(sh.shares[t]||0)*vps;},0);
          return '<tr><td style="font-weight:500">'+sh.name+'</td>'
            +allTickers.map(t=>'<td class="r" style="font-family:var(--mono)">'+(sh.shares[t]||0)+'</td>').join('')
            +'<td class="r" style="font-weight:500">'+total+'</td>'
            +'<td class="r" style="color:var(--amber)">'+vp+'</td></tr>';
        }).join('')
        +'</tbody></table>';
    }
    // Also trigger async fresh fetch
    sb.get('jex_users','role=in.(student,company)&status=eq.approved&select='+JEX_USERS_SAFE_SELECT).then(freshUsers=>{
      freshUsers.forEach(fu=>{const local=getUser(fu.id);if(local)Object.assign(local,fu);else DB.users.push(fu);});
      const freshMap={};
      allTickers.forEach(t=>{
        DB.users.filter(u2=>(u2.role==='student'||u2.role==='company')&&(u2.holdings&&u2.holdings[t]||0)>0).forEach(u2=>{
          if(!freshMap[u2.id])freshMap[u2.id]={name:u2.name,shares:{}};
          freshMap[u2.id].shares[t]=(u2.holdings&&u2.holdings[t]||0);
        });
      });
      const loadingLabel=document.getElementById('shareholder-loading');if(loadingLabel)loadingLabel.remove();
      const el=document.getElementById('shareholder-table');if(!el)return;
      const freshSh=Object.values(freshMap);
      if(!freshSh.length){el.innerHTML='<div class="empty">No shareholders yet.</div>';return;}
      el.innerHTML='<table><thead><tr><th>Holder</th>'
        +allTickers.map(t=>'<th class="r">'+t+'</th>').join('')
        +'<th class="r">Total</th><th class="r">Voting power</th></tr></thead><tbody>'
        +freshSh.map(sh=>{const total=Object.values(sh.shares).reduce((s,q)=>s+q,0);const vp=allTickers.reduce((s,t)=>{const meta=getClassMeta(t);const vps=meta?meta.votes_per_share:1;return s+(sh.shares[t]||0)*vps;},0);return '<tr><td style="font-weight:500">'+sh.name+'</td>'+allTickers.map(t=>'<td class="r" style="font-family:var(--mono)">'+(sh.shares[t]||0)+'</td>').join('')+'<td class="r" style="font-weight:500">'+total+'</td><td class="r" style="color:var(--amber)">'+vp+'</td></tr>';}).join('')+'</tbody></table>';
    }).catch(()=>{const loadingLabel=document.getElementById('shareholder-loading');if(loadingLabel)loadingLabel.remove();});
    html+='</div></div>';
  }

  else if(tab==='team'){
    html+=renderCompanyTeamTab(co);
  }

  if(tab==='alerts'&&(u.role==='student'||u.role==='company')){
    const myAlerts=DB.priceAlerts.filter(a=>a.user_id===u.id&&a.ticker===parentTicker&&!a.triggered);
    const triggeredAlerts=DB.priceAlerts.filter(a=>a.user_id===u.id&&a.ticker===parentTicker&&a.triggered);
    html+='<div class="card"><div class="section-title">Set a price alert</div>'
      +'<div class="ibox ibox-blue">Get notified when '+parentTicker+' crosses a price level.</div>'
      +'<div class="row" style="align-items:flex-end">'
      +'<div class="frow" style="flex:1"><label class="flabel">Direction</label><select id="alert-dir"><option value="above">Above</option><option value="below">Below</option></select></div>'
      +'<div class="frow" style="flex:1"><label class="flabel">Target price ($)</label><input type="number" id="alert-price" placeholder="'+co.price.toFixed(2)+'" step="0.01" min="0.01"></div>'
      +'<div style="padding-bottom:12px"><button class="btn btn-primary" onclick="addAlertForm(&quot;'+parentTicker+'&quot;)">Set alert</button></div></div>'
      +(myAlerts.length?'<hr class="divider"><div style="font-size:12px;font-weight:500;margin-bottom:8px">Active alerts</div>'
        +myAlerts.map(a=>'<div class="app-row" style="margin-bottom:6px"><div class="app-info"><div class="app-name">'+(a.direction||a['direction']||'?')+' '+fmt(parseFloat(a.target_price||a['target_price'])||0)+'</div></div>'
          +'<button class="btn btn-sm btn-danger" onclick="deletePriceAlert(&quot;'+a.id+'&quot;)">Remove</button></div>').join(''):'')
      +(triggeredAlerts.length?'<hr class="divider"><div style="font-size:12px;color:var(--text2)">'+triggeredAlerts.length+' triggered alert'+(triggeredAlerts.length!==1?'s':'')+' (historical)</div>':'')
      +'</div>';
  }

  else if(tab==='dividends'){
    if(!companyDivs.length){html+='<div class="card"><div class="empty">No dividends paid yet.</div></div>';}
    else{
      html+='<div class="card"><div class="section-title">Dividend history</div>'
        +'<table><thead><tr><th>Time</th><th>Per share</th><th>Total paid</th><th>Recipients</th><th>Note</th></tr></thead><tbody>'
        +companyDivs.map(d=>'<tr><td style="color:var(--text2)">'+d.ts+'</td><td style="font-family:var(--mono)">'+fmt(d.per_share)+'</td><td style="color:var(--green);font-family:var(--mono)">'+fmt(d.total)+'</td><td>'+(d.payouts||[]).length+'</td><td style="font-size:12px;color:var(--text2)">'+d.note+'</td></tr>').join('')
        +'</tbody></table></div>';
    }
  }

  else if(tab==='financials'){
    html+=renderFinancialsHistory(co.financials);
  }

  else if(tab==='trades'){
    if(!companyTrades.length){html+='<div class="card"><div class="empty">No trades yet.</div></div>';}
    else{
      html+='<div class="card"><div class="section-title">Recent trades</div>'
        +'<table><thead><tr><th>Time</th><th>Ticker</th><th>Price</th><th>Qty</th><th>Value</th><th>Type</th></tr></thead><tbody>'
        +companyTrades.map(t=>'<tr><td style="color:var(--text2)">'+t.ts+'</td><td><span class="badge b-gray" style="font-family:var(--mono)">'+t.ticker+'</span></td><td style="font-family:var(--mono)">'+fmt(t.price)+'</td><td>'+t.qty+'</td><td style="font-family:var(--mono)">'+fmt(t.price*t.qty)+'</td><td><span class="badge '+(t.type==='short'?'b-purple':t.type==='cover'?'b-amber':'b-gray')+'">'+( t.type||'market')+'</span></td></tr>').join('')
        +'</tbody></table></div>';
    }
  }

  return html;
}

function renderTickerBar(){const u=cu();return `<div class="ticker-bar">${DB.companies.filter(c=>c.status==='listed'&&canAccessTicker(c.ticker,u?.id)).map(c=>{const chg=priceChg(c),w=isWatched(c.ticker),halted=isHalted(c.ticker);
  const preMarket=!isOpen()?getPreMarketPrice(c.ticker):null;
  return `<div class="ticker-item ${UI.panelTicker===c.ticker?'active-t':''} ${w?'watched':''} ${halted?'halted-ticker':''}" onclick="openCompanyPage('${c.ticker}')" style="${c.brand_color?'border-color:'+c.brand_color+'30':''}">
  ${c.logo?`<img src="${c.logo}" style="width:24px;height:24px;object-fit:cover;border-radius:4px;margin-bottom:3px">`:``}
  <div class="tsym">${c.ticker}${w?' ★':''}${halted?' ⚠️':''}</div>
  <div class="tprice" style="${halted?'color:var(--red)':''}">${fmt(c.price)}</div>
  ${preMarket?`<div style="font-size:10px;color:var(--amber)">pre: ${fmt(preMarket)}</div>`:`<div class="tchg ${chg>=0?'price-up':'price-down'}">${fmtChg(chg)}</div>`}
  </div>`;}).join('')}</div>`;}
// Shared by the initial render() and setJxiChartInterval()'s in-place patch
// (see below) so the headline badge and the chart it sits next to always
// agree on what timeframe they're both showing.
function jxiChgBadgeHtml(){
  const interval=chartIntervals['jxi-chart']||'1d';
  const chg=intervalChg(getCo('JXI')?.price_history||[],interval);
  const label=intervalChgLabel(interval);
  return`${chg>=0?'+':''}${chg}% <span style="font-size:11px;color:var(--text2);font-weight:400">${label}</span>`;
}
function renderIndexCard(){
  const idx=computeJXI();
  if(!idx.constituents.length)return'';
  const interval=chartIntervals['jxi-chart']||'1d';
  // Both the badge and the chart below read JXI's own jex_companies row
  // (kept fresh by every JXI trade, including real-backing basket moves) --
  // not the separate jex_index_history log, which only advances when
  // snapshotJXI() runs and can drift out of sync with it. Reading two
  // different histories for "the same" %-change is exactly what produced
  // a headline that disagreed with the ticker bar/market table (both of
  // which already use priceChg(), i.e. this same company-row history).
  const jxiHistory=getCo('JXI')?.price_history||[];
  const chg=intervalChg(jxiHistory,interval);
  return `<div class="card">
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:10px">
      <div>
        <div class="section-title" style="margin-bottom:2px">JXI <span style="font-weight:400;color:var(--text2);font-size:12px">JEX Composite</span></div>
        <div style="font-size:28px;font-weight:500;font-family:var(--mono)">${idx.value.toFixed(2)}</div>
      </div>
      <div id="jxi-chg-badge" class="${chg>=0?'price-up':'price-down'}" style="font-size:15px;font-weight:500">${jxiChgBadgeHtml()}</div>
      <div style="margin-left:auto;font-size:12px;color:var(--text2)">${idx.constituents.length} listed compan${idx.constituents.length!==1?'ies':'y'} · equal-weighted · base 1000</div>
    </div>
    ${jxiHistory.length>=2?`${buildJxiChartIntervalBar('jxi-chart')}<div style="position:relative;height:160px;margin-bottom:14px"><canvas id="jxi-chart"></canvas></div>`:'<div class="ibox ibox-blue" style="margin-bottom:14px;font-size:12px">Chart builds up as trades happen — check back after some activity.</div>'}
    <table><thead><tr><th>Company</th><th>Ticker</th><th class="r">Price</th><th class="r">Today</th></tr></thead>
    <tbody>${idx.constituents.map(c=>{const co=getCo(c.ticker);const chg=co?priceChg(co):Math.round(((c.ratio-1)*100)*100)/100;return `<tr><td>${esc(c.name)}</td><td><span class="badge b-gray" style="font-family:var(--mono)">${esc(c.ticker)}</span></td><td class="r" style="font-family:var(--mono)">${fmt(c.price)}</td><td class="r ${chg>=0?'price-up':'price-down'}">${chg>=0?'+':''}${chg.toFixed(2)}%</td></tr>`;}).join('')}</tbody></table>
  </div>`;
}
function getMarketListed(u){
  const searchQ=(document.getElementById('market-search')?.value||'').toLowerCase();
  return DB.companies.filter(c=>c.status==='listed'&&canAccessTicker(c.ticker,u?.id)
    &&(!searchQ||(c.name.toLowerCase().includes(searchQ)||c.ticker.toLowerCase().includes(searchQ))))
    // JXI pinned to the top, like a benchmark/reference instrument on a real
    // exchange -- everything else keeps its normal (creation) order.
    .sort((a,b)=>(b.is_index_fund?1:0)-(a.is_index_fund?1:0));
}
let _marketLastPrices={};
function renderMarketRows(u,listed){
  return listed.map((c,ci)=>{const chg=priceChg(c),fin=c.financials&&c.financials[0];const meta=getClassMeta(c.ticker);
    const classBadge=meta?'<span class="badge" style="font-size:10px;background:rgba(240,165,0,0.12);color:var(--amber);margin-left:4px">Class '+meta.class+' · '+meta.votes_per_share+'v</span>':'';
    const restrictBadge=meta&&meta.restricted?'<span class="badge b-red" style="font-size:10px;margin-left:4px">Restricted</span>':'';
    // Ticker-style flash on the price cell when a price actually moves since
    // the last render (realtime pushes from other clients' trades, or the
    // 3s order-matching poll) — not on every re-render (search typing,
    // watchlist toggles, etc. don't touch c.price so no flash fires).
    const prevPrice=_marketLastPrices[c.ticker];
    const flashClass=prevPrice!=null&&prevPrice!==c.price?(c.price>prevPrice?' flash-up':' flash-down'):'';
    _marketLastPrices[c.ticker]=c.price;
    return`<tr style="cursor:pointer" onclick="openCompanyPage('${c.ticker}')"><td><span style="font-weight:500">${esc(c.name)}</span>${classBadge}${restrictBadge}<br><span style="font-size:11px;color:var(--text2)">${esc(c.description||"")}</span>${fin?`<br><span style="font-size:11px;color:var(--text3)">Rev ${fmt(fin.revenue)} | Profit ${fmt(fin.profit)}</span>`:''}</td><td><span class="badge b-gray copy-ticker" style="font-family:var(--mono)" onclick="copyTicker('${c.ticker}')" title="Click to copy">${c.ticker}</span></td><td class="${flashClass}" style="font-weight:500;font-family:var(--mono)">${fmt(c.price)}${(u.role==='student'&&(holdings(u)[c.ticker]||0)>0)?`<div style="font-size:10px;color:var(--green)">You: ${holdings(u)[c.ticker]}</div>`:''}</td><td class="${chg>=0?'price-up':'price-down'}">${fmtChg(chg)}</td><td><canvas id="spark-${c.ticker}" width="100" height="36" style="display:block"></canvas></td><td>${sharesBar(c)}</td>${(u.role==='student'||u.role==='company')?`<td><button class="wstar ${isWatched(c.ticker)?'on':''}" onclick="toggleWatch('${c.ticker}')">${isWatched(c.ticker)?'★':'☆'}</button></td>${(()=>{const hs=calcHealthScore(c);return hs!=null?`<td style="vertical-align:middle"><span style="font-family:var(--mono);font-size:13px;font-weight:700;color:${hs>=70?'var(--green)':hs>=40?'var(--amber)':'var(--red)'}">${hs}/100</span></td>`:'<td>—</td>';})()}<td><button class="btn btn-sm btn-primary" onclick="openCompanyPage('${c.ticker}')">View</button></td>`:''}</tr>`;}).join('')+(!listed.length?`<tr><td colspan="7"><div class="empty">No listed companies yet</div></td></tr>`:'');
}
function renderMarket(){
  const u=cu();
  const listed=getMarketListed(u);
  const recentNews=DB.news.slice(0,5);
  return `${renderTickerBar()}
    ${renderIndexCard()}
    <div class="card"><div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <div class="section-title" style="margin-bottom:0;flex:1">Listed companies</div>
      <input type="text" id="market-search" placeholder="Search by name or ticker..." style="max-width:240px;padding:6px 10px;font-size:13px" oninput="renderMarketInPlace()">
    </div>
      <table><thead><tr><th>Company</th><th>Ticker</th><th>Price</th><th>Change</th><th>Chart</th><th>Shares</th>${(u.role==='student'||u.role==='company')?'<th>Watch</th><th>Health'+infoBubble('A 0-100 score combining price stability (up to ±20), the companys cash cushion relative to its market cap (up to +15), short-seller interest against it (up to -15), and dividend history (+5 to +10). Starts from a baseline of 50.')+'</th><th></th>':''}</tr></thead>
      <tbody id="market-rows">${renderMarketRows(u,listed)}</tbody></table>
    </div>
    ${(DB.minutes||[]).filter(m=>m.type==='official_notice').length?`<div class="card" style="margin-bottom:14px;border-left:3px solid var(--blue)"><div class="section-title">📋 Official notices</div>${DB.minutes.filter(m=>m.type==='official_notice').slice(0,2).map(m=>`<div style="padding:10px 0;border-bottom:1px solid var(--border)"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px"><div><span class="badge b-blue" style="margin-right:6px;font-size:10px">Notice</span><strong style="font-size:13px">${esc(m.title)}</strong></div><span style="font-size:11px;color:var(--text2)">${m.ts}</span></div><div style="font-size:12px;color:var(--text2);white-space:pre-line;max-height:80px;overflow:hidden">${esc(m.body)}</div></div>`).join('')}</div>`:''}
    ${(DB.minutes||[]).filter(m=>m.type==='minutes').length?`<div class="card" style="margin-bottom:14px"><div class="section-title">📋 Meeting minutes</div>${DB.minutes.filter(m=>m.type==='minutes').slice(0,3).map(m=>`<div style="padding:10px 0;border-bottom:1px solid var(--border)"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px"><strong style="font-size:13px">${esc(m.title)}</strong><span style="font-size:11px;color:var(--text2)">${m.ts} — ${esc(m.author_name)}</span></div><div style="font-size:12px;color:var(--text2);white-space:pre-line;max-height:80px;overflow:hidden">${esc(m.body)}</div></div>`).join('')}${DB.minutes.filter(m=>m.type==='minutes').length>3?`<div style="font-size:12px;color:var(--text2);text-align:center;padding-top:8px">${DB.minutes.filter(m=>m.type==='minutes').length-3} older entries</div>`:''}</div>`:''}
    ${DB.votes.filter(v=>v.status==='open').length?`<div class="card"><div class="section-title">Active shareholder votes</div>`
      +DB.votes.filter(v=>v.status==='open').map(v=>renderVoteCard(v,false,isAdmin(u))).join('')
      +'</div>':''}
    ${recentNews.length?`<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">Company news <span style="font-size:12px;font-weight:400;color:var(--text2)">${DB.news.length} post${DB.news.length!==1?'s':''}</span></div>${recentNews.map(n=>`<div class="news-item"><div class="news-headline">${esc(n.headline)}</div>${n.body?`<div class="news-body">${esc(n.body||"")}</div>`:''}<div class="news-meta" style="justify-content:space-between"><div style="display:flex;align-items:center;gap:10px"><span class="news-ticker">${n.ticker}</span><span>${esc(n.company_name)}</span><span>${n.ts||''}</span></div>${isAdmin(u)?`<button class="btn btn-sm btn-danger" onclick="deleteNews('${n.id}')">Delete</button>`:''}</div></div>`).join('')}${DB.news.length>5?`<div style="font-size:12px;color:var(--text2);text-align:center;padding:8px">Showing 5 of ${DB.news.length} posts</div>`:''}</div>`:''}
    <div id="trade-panel"></div>`;
}
function buildSparklines(){
  setTimeout(()=>{
    DB.companies.filter(c=>c.status==='listed').forEach(c=>{
      const canvas=document.getElementById('spark-'+c.ticker);
      if(!canvas||!window.Chart)return;
      // Always redraw sparkline to show latest prices
      if(charts['spark-'+c.ticker]){
        try{charts['spark-'+c.ticker].destroy();}catch(e){}
        delete charts['spark-'+c.ticker];
      }
      // Today's move, same as everything else (priceChg(), the full-size
      // charts) -- anchored to session-open instead of just "whatever the
      // last 20 raw points happen to be," which could span several days.
      const allPts=(c.price_history||[]).filter(p=>p&&typeof p.p==='number');
      const{pts:anchoredPts}=anchorToSessionOpen(allPts,'1d');
      // Right after the exchange reopens, before anyone's traded yet today,
      // the anchored view can collapse to 0-1 points. Falling back to raw
      // history here would show whatever dramatic move happened BEFORE
      // today's reset -- a flat line at the current price (nothing's
      // happened yet today) is the honest "reset" picture, same as a real
      // market's intraday chart before the first trade of the day.
      const pts=anchoredPts.length>=2?anchoredPts:[anchoredPts[0]||{p:c.price,t:new Date().toISOString()},{p:c.price,t:new Date().toISOString()}];
      if(pts.length<2)return;
      const prices=pts.map(p=>p.p);
      const isUp=prices[prices.length-1]>=prices[0];
      charts['spark-'+c.ticker]=new Chart(canvas,{type:'line',data:{labels:prices.map((_,i)=>i),datasets:[{data:prices,borderColor:isUp?'#00c896':'#ff4d6a',borderWidth:1.5,pointRadius:0,fill:false,tension:0.3}]},options:{responsive:false,animation:false,plugins:{legend:{display:false},tooltip:{enabled:false}},scales:{x:{display:false},y:{display:false}}}});
    });
  },80);
}

function openCompanyPage(ticker){
  UI.companyPage=ticker;UI.companyPageTab='overview';UI.panelMode='buy';UI.tradePage=0;
  destroyCharts();render();
  window.scrollTo({top:0,behavior:'smooth'});
  // Set up swipe navigation after render
  setTimeout(setupCompanyPageSwipe,100);
  // Reflect the open company in the URL (market.html?ticker=X, i.e. today
  // index.html since market has no page file of its own) so the address
  // bar is an actual shareable link, not just in-memory UI state. Only
  // called from the market page's ticker list/table, so no page-identity
  // check needed here.
  if(typeof history!=='undefined')history.pushState({ticker},'','?ticker='+encodeURIComponent(ticker));
  loadCompanyTeamContacts(ticker);
}
// Backs the public "Contact the people behind this company" Team tab and
// the owner's own Founders list -- both need owner+accepted-founder emails,
// which bulk DB.users no longer carries (see the email-pii-exposure-fix
// migration). Memoized per ticker for the page session so switching tabs
// back and forth doesn't refetch; invalidated on respondToInvite() below,
// the one place a company's team composition actually changes client-side.
const _teamContactsLoaded=new Set();
async function loadCompanyTeamContacts(ticker){
  if(!ticker||_teamContactsLoaded.has(ticker))return;
  _teamContactsLoaded.add(ticker);
  const rows=await safeRpc('rpc_get_company_team_contacts',{p_ticker:ticker});
  if(!rows){_teamContactsLoaded.delete(ticker);return;}
  let changed=false;
  rows.forEach(r=>{const u=getUser(r.id);if(u&&u.email!==r.email){u.email=r.email;changed=true;}});
  if(changed)render();
}
function setupCompanyPageSwipe(){
  const el=document.getElementById('company-page-content');
  if(!el||el._swipeInit)return;
  el._swipeInit=true;
  let startX=0,startY=0;
  el.addEventListener('touchstart',e=>{startX=e.touches[0].clientX;startY=e.touches[0].clientY;},{passive:true});
  el.addEventListener('touchend',e=>{
    const dx=e.changedTouches[0].clientX-startX;
    const dy=e.changedTouches[0].clientY-startY;
    if(Math.abs(dx)<Math.abs(dy)||Math.abs(dx)<50)return; // not a horizontal swipe
    const tabs=['overview','trade','shareholders','news','votes','dividends','buyback','dilution'];
    const cur=tabs.indexOf(UI.companyPageTab);
    if(dx<0&&cur<tabs.length-1){UI.companyPageTab=tabs[cur+1];render();setTimeout(setupCompanyPageSwipe,100);}
    else if(dx>0&&cur>0){UI.companyPageTab=tabs[cur-1];render();setTimeout(setupCompanyPageSwipe,100);}
  },{passive:true});
}
function addAlertForm(ticker){
  addPriceAlert(ticker,document.getElementById('alert-price')?.value,document.getElementById('alert-dir')?.value);
}
function cpTrade(mode){
  const t=UI.companyPage;const q=get('cp-qty')?.value;
  if(mode==='buy')placeBuy(t,q);
  else if(mode==='sell')placeSell(t,q);
  else if(mode==='short')placeShort(t,q);
  else if(mode==='cover')coverShort(t,q);
}
function cpLimit(side){
  const t=UI.companyPage;
  if(side==='buy'){
    placeLimitOrder(t,'buy',get('cp-lmt-qty')?.value,get('cp-lmt-price')?.value);
  } else {
    // Sync sell order type selector to the shared limit-order-type element
    const sellTypeEl=get('limit-order-type-sell');
    const sharedTypeEl=get('limit-order-type');
    if(sellTypeEl&&sharedTypeEl)sharedTypeEl.value=sellTypeEl.value;
    placeLimitOrder(t,'sell',get('cp-lmt-sty')?.value,get('cp-lmt-sprice')?.value);
  }
}
function toggleWatchAndRefresh(ticker){toggleWatch(ticker).then(()=>openCompanyPage(ticker));}
function renderMarketInPlace(){
  // Only re-renders the results tbody, never #market-search itself -- replacing
  // the input's own DOM node (the old full-section innerHTML= did that) drops
  // whatever was just typed and loses focus/caret on every keystroke, which is
  // what actually made the search box look broken.
  const u=cu();
  const rows=document.getElementById('market-rows');
  if(rows)rows.innerHTML=renderMarketRows(u,getMarketListed(u));
  setTimeout(()=>buildSparklines(),60);
}
function setupCoSwipe(){
  const el=document.getElementById('co-page-wrap');
  if(!el||el._sw)return;el._sw=true;
  let sx=0,sy=0;
  el.addEventListener('touchstart',e=>{sx=e.touches[0].clientX;sy=e.touches[0].clientY;},{passive:true});
  el.addEventListener('touchend',e=>{
    const dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;
    if(Math.abs(dx)<Math.abs(dy)||Math.abs(dx)<50)return;
    const tabs=['overview','trade','shareholders','news','votes','dividends','buyback','dilution'];
    const cur=tabs.indexOf(UI.companyPageTab);
    if(dx<0&&cur<tabs.length-1)UI.companyPageTab=tabs[cur+1];
    else if(dx>0&&cur>0)UI.companyPageTab=tabs[cur-1];
    else return;
    render();setTimeout(setupCoSwipe,120);
  },{passive:true});
}
function closeCompanyPage(){
  UI.companyPage=null;destroyCharts();render();
  if(typeof history!=='undefined')history.replaceState({},'',location.pathname);
}
function openPanel(ticker){
  // Trade actions call this after an async round-trip (placeBuy/placeSell/
  // placeShort/coverShort) -- by the time it resolves, the user may have
  // navigated off the Market tab (or logged out) entirely, so #market-content
  // and cu() are not guaranteed to still be there. Bail quietly rather than
  // throwing on a null DOM node or a null user.
  const marketContent=document.getElementById('market-content');
  const c=getCo(ticker),u=cu();
  if(!marketContent||!c||!u)return;
  UI.panelTicker=ticker;
  const held=(holdings(u)[ticker])||0,short=(shorts(u))[ticker];
  destroyCharts();
  marketContent.innerHTML=renderMarket();
  const panel=get('trade-panel');if(!panel)return;
  const mode=UI.panelMode,fin=c.financials&&c.financials[0];
  // See the identical idxFund/effMode handling in renderCompanyPage's trade
  // tab -- limit orders still aren't wired up for JXI (hidden here too),
  // but shorting is (rpc_trade_short/cover_short's is_index_fund branch).
  const idxFund=!!c.is_index_fund;
  const effMode=mode;
  panel.innerHTML=`<div class="card" style="border-color:var(--blue)">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div><span style="font-weight:500;font-size:15px">${esc(c.name)}</span> <span class="badge b-gray" style="font-family:var(--mono)">${esc(ticker)}</span>
        <button class="wstar ${isWatched(ticker)?'on':''}" onclick="toggleWatch('${ticker}').then(()=>openPanel('${ticker}'))" style="margin-left:6px">${isWatched(ticker)?'★':'☆'}</button></div>
      <button class="btn btn-sm" onclick="closePanel()">close</button>
    </div>
    <div class="grid4"><div class="mcard"><div class="mlabel">Price</div><div class="mval" style="font-family:var(--mono)">${fmt(c.price)}</div></div><div class="mcard"><div class="mlabel">Your cash</div><div class="mval" style="font-family:var(--mono)">${fmt(u.cash)}</div></div><div class="mcard"><div class="mlabel">You hold</div><div class="mval">${held} shares</div></div><div class="mcard"><div class="mlabel">Short position</div><div class="mval ${short?'red':''}">${short?short.qty+' @ '+fmt(short.avgPrice):'—'}</div></div></div>
    <div style="margin-bottom:4px">${buildChartIntervalBar('panel-chart',c)}</div>
    <div style="position:relative;height:160px;margin-bottom:6px"><canvas id="panel-chart"></canvas></div>
    <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2);margin-bottom:10px"><span id="chg-meta-panel-chart">${tickerChartMetaHtml('panel-chart',c)}</span><span id="chg-badge-panel-chart" class="${tickerChgClass('panel-chart',c)}">${tickerChgBadgeHtml('panel-chart',c)}</span></div>
    ${fin?`<div style="font-size:12px;padding:8px 10px;background:var(--bg3);border-radius:var(--radius);margin-bottom:10px">Latest: Rev <strong>${fmt(fin.revenue)}</strong> | Profit <strong>${fmt(fin.profit)}</strong> — <span style="color:var(--text2)">${esc(fin.summary)}</span></div>`:''}
    <hr class="divider">
    <div class="ot-toggle">
      <button class="ot-btn ${effMode==='buy'?'ot-buy':''}" onclick="UI.panelMode='buy';openPanel('${ticker}')">Buy</button>
      <button class="ot-btn ${effMode==='sell'?'ot-sell':''}" onclick="UI.panelMode='sell';openPanel('${ticker}')">Sell</button>
      <button class="ot-btn ${effMode==='short'?'ot-short':''}" onclick="UI.panelMode='short';openPanel('${ticker}')">Short</button>
      ${short?`<button class="ot-btn ${effMode==='cover'?'ot-cover':''}" onclick="UI.panelMode='cover';openPanel('${ticker}')">Cover</button>`:''}
    </div>
    ${effMode==='buy'?`<p style="font-size:12px;color:var(--text2);margin-bottom:8px">${idxFund?`Buys mint new units at the live index price — there's no fixed supply to run out of.`:`Buy pushes price up. Available: <strong>${c.shares_avail}</strong> of ${c.shares.toLocaleString()}.`}</p>
    <div class="row" style="align-items:flex-end"><div class="frow" style="flex:1"><label class="flabel">Quantity</label><input type="number" id="t-qty" value="1" min="1"${idxFund?'':` max="${c.shares_avail}"`} oninput="document.getElementById('cp-preview')&&(document.getElementById('cp-preview').innerHTML=impactPreview(getCo('${ticker}'),parseInt(this.value)||1,'buy'))"></div><div style="padding-bottom:12px"><button class="btn btn-success" onclick="disableTradeBtn(this);placeBuy('${ticker}',get('t-qty')?.value)">Buy now</button></div></div>
    <div id="t-preview">${impactPreview(c,1,'buy')}</div>
    ${idxFund?'':`<hr class="divider" style="margin:10px 0">
    <div style="font-size:12px;font-weight:500;margin-bottom:8px;color:var(--text2)">Or place a limit buy${infoBubble('A limit order only fills at your chosen price or better, instead of the current market price right now. It may sit unfilled until the price crosses your limit, or fill instantly if it already has.')}</div>
    <div class="row" style="align-items:flex-end">
      <div class="frow" style="flex:1"><label class="flabel">Qty</label><input type="number" id="t-lmt-qty" value="1" min="1"></div>
      <div class="frow" style="flex:1"><label class="flabel">Limit price ($)</label><input type="number" id="t-lmt-price" placeholder="${fmt(c.price)}" step="0.01" min="0.01"></div>
      <div style="padding-bottom:12px"><button class="btn btn-primary" onclick="placeLimitOrder('${ticker}','buy',get('t-lmt-qty')?.value,get('t-lmt-price')?.value)">Place limit</button></div>
    </div>`}`
    :effMode==='sell'?`<p style="font-size:12px;color:var(--text2);margin-bottom:8px">${idxFund?'Sells redeem your units at the live index price.':'Sell pushes price down.'} You hold: <strong>${held}</strong>.</p>${held>0?`<div class="row" style="align-items:flex-end"><div class="frow" style="flex:1"><label class="flabel">Quantity</label><input type="number" id="t-qty" value="1" min="1" max="${held}"></div><div style="padding-bottom:12px"><button class="btn btn-danger" onclick="placeSell('${ticker}',get('t-qty')?.value)">Sell now</button></div></div>
    <div id="t-preview">${impactPreview(c,1,'sell')}</div>
    ${idxFund?'':`<hr class="divider" style="margin:10px 0">
    <div style="font-size:12px;font-weight:500;margin-bottom:8px;color:var(--text2)">Or place a limit sell${infoBubble('A limit order only fills at your chosen price or better, instead of the current market price right now. It may sit unfilled until the price crosses your limit, or fill instantly if it already has.')}</div>
    <div class="row" style="align-items:flex-end">
      <div class="frow" style="flex:1"><label class="flabel">Qty</label><input type="number" id="t-lmt-qty" value="1" min="1" max="${held}"></div>
      <div class="frow" style="flex:1"><label class="flabel">Limit price ($)</label><input type="number" id="t-lmt-price" placeholder="${fmt(c.price)}" step="0.01" min="0.01"></div>
      <div style="padding-bottom:12px"><button class="btn btn-primary" onclick="placeLimitOrder('${ticker}','sell',get('t-lmt-qty')?.value,get('t-lmt-price')?.value)">Place limit</button></div>
    </div>`}`:`<div class="empty" style="padding:16px">You don't hold any ${ticker}.</div>`}`
    :effMode==='short'?`<div class="ibox ibox-purple">Short selling${infoBubble('Short selling profits when a price FALLS, the opposite of a normal buy. You borrow shares and sell them now; later you buy them back to cover, hopefully at a lower price. The difference is your profit or loss, but losses are uncapped since a price can rise indefinitely.')} — borrow and sell shares expecting price to fall. Requires 1.5× collateral.</div><div class="row" style="align-items:flex-end"><div class="frow" style="flex:1"><label class="flabel">Quantity to short</label><input type="number" id="t-qty" value="1" min="1"></div><div style="padding-bottom:12px"><button class="btn btn-purple" onclick="placeShort('${ticker}',get('t-qty')?.value)">Short sell</button></div></div><div id="t-preview">${shortPrev(c,1)}</div>`
    :short?`<div class="ibox ibox-purple">Buy back borrowed shares to close your position.</div><div style="font-size:13px;margin-bottom:10px">Open: <strong>${short.qty} shares</strong> @ avg ${fmt(short.avgPrice)} | P&L: <span class="${(short.avgPrice-c.price)*short.qty>=0?'price-up':'price-down'}">${fmt((short.avgPrice-c.price)*short.qty)}</span></div><div class="row" style="align-items:flex-end"><div class="frow" style="flex:1"><label class="flabel">Quantity to cover</label><input type="number" id="t-qty" value="${short.qty}" min="1" max="${short.qty}"></div><div style="padding-bottom:12px"><button class="btn btn-warning" onclick="coverShort('${ticker}',get('t-qty')?.value)">Cover short</button></div></div><div id="t-preview">${impactPreview(c,short.qty,'buy')}</div>`:''}
  </div>`;
  const qi=get('t-qty');if(qi){qi.addEventListener('input',()=>{const q=parseInt(qi.value)||0,p=get('t-preview');if(!p)return;if(effMode==='buy')p.innerHTML=impactPreview(c,q,'buy');else if(effMode==='sell')p.innerHTML=impactPreview(c,q,'sell');else if(effMode==='short')p.innerHTML=shortPrev(c,q);else if(effMode==='cover')p.innerHTML=impactPreview(c,q,'buy');});}
  panel.scrollIntoView({behavior:'smooth',block:'nearest'});setTimeout(()=>{destroyChart('panel-chart');buildChart('panel-chart',c);},50);
}
function closePanel(){UI.panelTicker=null;destroyCharts();document.getElementById('market-content').innerHTML=renderMarket();}

// ═══════════════════════════════════════════════
// RENDER: LEADERBOARD
// ═══════════════════════════════════════════════
function renderLeaderboard(){
  const lbSnap=DB.session.leaderboard_snapshot;
  const isFrozen=lbSnap&&DB.session.status!=='open';
  let ranked=isFrozen?lbSnap:DB.users.filter(u=>u.role==='student'&&u.status==='approved').map(u=>({...u,_nw:nw(u),_divs:divRec(u),name:u.name,id:u.id,classroom_id:u.classroom_id})).sort((a,b)=>b._nw-a._nw);
  if(UI.lbClassroom)ranked=ranked.filter(u=>u.classroom_id===UI.lbClassroom);
  const rc=i=>i===0?'r-gold':i===1?'r-silver':i===2?'r-bronze':'';
  const frozenBadge=isFrozen?'<span class="badge b-amber" style="font-size:11px;font-weight:400">📸 Frozen at close</span>':'';
  const classroomPicker=DB.classrooms.length?`<select id="lb-classroom" style="width:auto;font-size:12px;padding:5px 8px" onchange="UI.lbClassroom=this.value||null;render()">
      <option value="">All classrooms</option>
      ${DB.classrooms.map(c=>`<option value="${c.id}" ${UI.lbClassroom===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}
    </select>`:'';
  return `<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap"><span>Net worth leaderboard</span><div style="display:flex;align-items:center;gap:8px">${frozenBadge}${classroomPicker}</div></div>${ranked.length?ranked.map((u,i)=>`<div class="lb-row"><div class="lb-rank ${rc(i)}">#${i+1}</div><div><div class="lb-name">${u.name}${!UI.lbClassroom&&getClassroomName(u.classroom_id)?` <span class="badge b-gray" style="font-size:9px">${getClassroomName(u.classroom_id)}</span>`:''}</div><div style="font-size:12px;color:var(--text2)">${isFrozen?'NW: '+fmt(u.nw||u._nw||0):'Cash '+fmt(u.cash)+' | Portfolio '+fmt(pv(u))+' | Dividends '+fmt(u._divs||0)}</div></div><div class="lb-val ${(u.nw||u._nw||0)>=10000?'price-up':'price-down'}">${fmt(u.nw||u._nw||0)}</div></div>`).join(''):`<div class="empty">${UI.lbClassroom?'No students in this classroom':'No students yet'}</div>`}</div>${renderFundLeaderboard()}`;
}
function renderFundLeaderboard(){
  const ranked=(DB.funds||[]).map(f=>{
    const nav=currentFundNav(f);
    const ret=Math.round(((nav/10-1)*100)*100)/100;
    return{...f,_nav:nav,_ret:ret};
  }).sort((a,b)=>b._ret-a._ret);
  const rc=i=>i===0?'r-gold':i===1?'r-silver':i===2?'r-bronze':'';
  return `<div class="card"><div class="section-title">Fund leaderboard</div>${ranked.length?ranked.map((f,i)=>`<div class="lb-row" style="cursor:pointer" onclick="UI.navTab='funds';openFundPage('${f.id}')"><div class="lb-rank ${rc(i)}">#${i+1}</div><div><div class="lb-name">${esc(f.name)}${f.status!=='active'?' <span class="badge b-gray" style="font-size:9px">Closed</span>':''}</div><div style="font-size:12px;color:var(--text2)">Managed by ${esc(f.manager_name)} · AUM ${fmt(fundAUM(f))}</div></div><div class="lb-val ${f._ret>=0?'price-up':'price-down'}">${f._ret>=0?'+':''}${f._ret}%</div></div>`).join(''):'<div class="empty">No funds yet</div>'}</div>`;
}

// ═══════════════════════════════════════════════
// RENDER: PORTFOLIO
// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
// RENDER: FUNDS
// ═══════════════════════════════════════════════
function openFundPage(id){UI.fundPage=id;render();}
function backToFundList(){UI.fundPage=null;render();}
function renderFundsPage(){
  if(UI.fundPage)return renderFundDetail(UI.fundPage);
  return renderFundList();
}
function fundAUM(f){return Math.round((f.cash+Object.entries(f.holdings||{}).reduce((s,[t,q])=>{const c=getCo(t);return s+(c?c.price*q:0);},0))*100)/100;}
function renderFundList(){
  const u=cu();
  const activeFunds=DB.funds.filter(f=>f.status==='active');
  const closedFunds=DB.funds.filter(f=>f.status!=='active');
  let html='';
  if(u.role==='company'){
    html+=`<div class="card"><div class="section-title">Launch a fund</div>
      <div class="ibox ibox-blue" style="margin-bottom:12px">Raise pooled capital from other students and companies, then trade it across the exchange on their behalf. You earn a performance fee only on the profit each depositor realizes when they withdraw — nothing if the fund loses money.</div>
      <div class="frow"><label class="flabel">Fund name</label><input type="text" id="fund-name" placeholder="e.g. Acme Capital Growth Fund"></div>
      <div class="frow"><label class="flabel">Performance fee (0–${MAX_FUND_FEE_PCT}%, charged only on a depositor's profit at withdrawal)</label><input type="number" id="fund-fee" placeholder="10" min="0" max="${MAX_FUND_FEE_PCT}" step="0.1" value="10"></div>
      <button class="btn btn-primary" onclick="createFund(get('fund-name')?.value,get('fund-fee')?.value)">Launch fund</button>
    </div>`;
  }
  html+='<div class="card"><div class="section-title">Active funds</div>';
  if(!activeFunds.length){html+='<div class="empty">No active funds yet</div>';}
  else{
    html+='<table><thead><tr><th>Fund</th><th>Manager</th><th class="r">NAV</th><th class="r">AUM</th><th class="r">Since inception</th><th class="r">Fee</th></tr></thead><tbody>'
      +activeFunds.map(f=>{
        const nav=currentFundNav(f);
        const ret=Math.round(((nav/10-1)*100)*100)/100;
        return `<tr style="cursor:pointer" onclick="openFundPage('${f.id}')">
          <td style="font-weight:500">${esc(f.name)}</td>
          <td style="color:var(--text2)">${esc(f.manager_name)}</td>
          <td class="r" style="font-family:var(--mono)">${fmt(nav)}</td>
          <td class="r" style="font-family:var(--mono)">${fmt(fundAUM(f))}</td>
          <td class="r ${ret>=0?'price-up':'price-down'}">${ret>=0?'+':''}${ret}%</td>
          <td class="r">${f.fee_pct}%</td>
        </tr>`;
      }).join('')
      +'</tbody></table>';
  }
  html+='</div>';
  if(closedFunds.length){
    html+='<div class="card"><div class="section-title">Closed funds</div><table><thead><tr><th>Fund</th><th>Manager</th><th class="r">NAV</th></tr></thead><tbody>'
      +closedFunds.map(f=>`<tr style="cursor:pointer" onclick="openFundPage('${f.id}')"><td>${esc(f.name)}</td><td style="color:var(--text2)">${esc(f.manager_name)}</td><td class="r" style="font-family:var(--mono)">${fmt(currentFundNav(f))}</td></tr>`).join('')
      +'</tbody></table></div>';
  }
  return html;
}
function renderFundDetail(fundId){
  const f=getFund(fundId);
  if(!f)return '<div class="empty">Fund not found</div><button class="btn btn-sm" onclick="backToFundList()">← Funds</button>';
  const u=cu();
  const nav=currentFundNav(f);
  const aum=fundAUM(f);
  const ret=Math.round(((nav/10-1)*100)*100)/100;
  const isManager=u.id===f.manager_id;
  const myPos=(u.role==='student'||u.role==='company')?fundUnits(u)[fundId]:null;

  let html=`<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
    <button class="btn btn-sm" onclick="backToFundList()">← Funds</button>
    <div style="flex:1;min-width:0"><div style="font-size:18px;font-weight:500">${esc(f.name)}</div><div style="font-size:12px;color:var(--text2)">Managed by ${esc(f.manager_name)} ${f.status!=='active'?'<span class="badge b-gray">Closed to new deposits</span>':''}</div></div>
    ${canManageFund(f)&&f.status==='active'?`<button class="btn btn-sm btn-danger" onclick="if(confirm('Close this fund to new deposits? Existing depositors can still withdraw.'))closeFund('${f.id}')">Close fund</button>`:''}
  </div>
  <div class="grid4" style="margin-bottom:14px">
    <div class="mcard"><div class="mlabel">NAV / unit${infoBubble("Total fund value ÷ units outstanding — the price you buy or sell units at, like a stock price.")}</div><div class="mval" style="font-family:var(--mono)">${fmt(nav)}</div></div>
    <div class="mcard"><div class="mlabel">Assets under management</div><div class="mval" style="font-family:var(--mono)">${fmt(aum)}</div></div>
    <div class="mcard"><div class="mlabel">Since inception</div><div class="mval ${ret>=0?'green':'red'}">${ret>=0?'+':''}${ret}%</div></div>
    <div class="mcard"><div class="mlabel">Performance fee</div><div class="mval">${f.fee_pct}%</div></div>
  </div>`;

  html+='<div class="card"><div class="section-title">Holdings</div>';
  const posEntries=Object.entries(f.holdings||{});
  if(!posEntries.length&&!f.cash){html+='<div class="empty">No positions yet</div>';}
  else{
    html+='<table><thead><tr><th>Position</th><th class="r">Qty</th><th class="r">Value</th></tr></thead><tbody>'
      +posEntries.map(([t,q])=>{const c=getCo(t);return `<tr><td style="font-family:var(--mono)">${esc(t)}</td><td class="r">${q}</td><td class="r" style="font-family:var(--mono)">${fmt(c?c.price*q:0)}</td></tr>`;}).join('')
      +`<tr><td>Cash</td><td class="r">—</td><td class="r" style="font-family:var(--mono)">${fmt(f.cash)}</td></tr>`
      +'</tbody></table>';
  }
  html+='</div>';

  const shortEntries=Object.entries(fundShorts(f)).filter(([,s])=>s.qty>0);
  if(shortEntries.length){
    const shortPnl=fundShortPnl(f);
    html+=`<div class="card"><div class="section-title">Short positions</div>
      <table><thead><tr><th>Ticker</th><th class="r">Qty</th><th class="r">Avg price</th><th class="r">Current</th><th class="r">P&L</th><th class="r">Collateral</th></tr></thead><tbody>`
      +shortEntries.map(([t,pos])=>{const c=getCo(t);const p=c?Math.round((pos.avgPrice-c.price)*pos.qty*100)/100:0;
        return `<tr><td style="font-family:var(--mono)">${esc(t)}</td><td class="r">${pos.qty}</td><td class="r" style="font-family:var(--mono)">${fmt(pos.avgPrice)}</td><td class="r" style="font-family:var(--mono)">${c?fmt(c.price):'—'}</td><td class="r ${p>=0?'green':'red'}" style="font-family:var(--mono)">${p>=0?'+':''}${fmt(p)}</td><td class="r" style="font-family:var(--mono)">${fmt(pos.collateral)}</td></tr>`;
      }).join('')
      +`</tbody></table>
      <div style="font-size:12px;color:var(--text2);margin-top:6px">Unrealised short P&L: <strong class="${shortPnl>=0?'green':'red'}">${shortPnl>=0?'+':''}${fmt(shortPnl)}</strong></div>
    </div>`;
  }

  if(u.role==='student'||u.role==='company'){
    html+='<div class="card"><div class="section-title">Your position</div>';
    if(myPos&&myPos.units>0){
      const myValue=Math.round((myPos.units*nav)*100)/100;
      const myGain=Math.round(((nav-myPos.costBasis)*myPos.units)*100)/100;
      html+=`<div class="grid3" style="margin-bottom:12px">
        <div class="mcard"><div class="mlabel">Units held</div><div class="mval">${myPos.units}</div></div>
        <div class="mcard"><div class="mlabel">Current value</div><div class="mval" style="font-family:var(--mono)">${fmt(myValue)}</div></div>
        <div class="mcard"><div class="mlabel">Unrealized gain</div><div class="mval ${myGain>=0?'green':'red'}" style="font-family:var(--mono)">${myGain>=0?'+':''}${fmt(myGain)}</div></div>
      </div>
      <div class="frow"><label class="flabel">Withdraw units (up to ${myPos.units})</label><div style="display:flex;gap:8px"><input type="number" id="fund-withdraw-units" placeholder="units" min="0" max="${myPos.units}" step="0.0001" style="flex:1"><button class="btn btn-danger btn-sm" onclick="withdrawFromFund('${f.id}',get('fund-withdraw-units')?.value)">Withdraw</button></div>
      <div style="font-size:11px;color:var(--text2);margin-top:4px">A ${f.fee_pct}% performance fee applies only to your realized profit at withdrawal.</div></div>`;
    } else {
      html+='<div class="empty" style="margin-bottom:12px">You have no position in this fund</div>';
    }
    if(f.status==='active'){
      html+=`<div class="frow"><label class="flabel">Deposit amount</label><div style="display:flex;gap:8px"><input type="number" id="fund-deposit-amount" placeholder="e.g. 500" min="0" step="0.01" style="flex:1"><button class="btn btn-primary btn-sm" onclick="depositToFund('${f.id}',get('fund-deposit-amount')?.value)">Deposit</button></div></div>`;
    }
    html+='</div>';
  }

  if(isManager&&f.status==='active'){
    // JXI excluded for now -- fund trading still goes through the standard
    // price-impact rpc_trade_buy/sell path, which the JXI branch bypasses
    // entirely (see the migration), so it isn't wired up for funds yet.
    const tradable=DB.companies.filter(c=>c.status==='listed'&&c.owner_id!==f.manager_id&&!c.is_index_fund);
    html+=`<div class="card"><div class="section-title">Trade on behalf of the fund</div>
      <div class="ibox ibox-amber" style="margin-bottom:12px">Fund cash available: <strong>${fmt(f.cash)}</strong>. You cannot trade your own company's stock through this fund.</div>
      <div class="frow"><label class="flabel">Ticker</label><select id="fund-trade-ticker">${tradable.map(c=>`<option value="${c.ticker}">${c.ticker} — ${esc(c.name)} (${fmt(c.price)})</option>`).join('')}</select></div>
      <div class="frow"><label class="flabel">Quantity</label><input type="number" id="fund-trade-qty" min="1" step="1" placeholder="e.g. 10"></div>
      <div class="btn-row"><button class="btn btn-success btn-sm" onclick="fundBuy('${f.id}',get('fund-trade-ticker')?.value,get('fund-trade-qty')?.value)">Buy</button><button class="btn btn-danger btn-sm" onclick="fundSell('${f.id}',get('fund-trade-ticker')?.value,get('fund-trade-qty')?.value)">Sell</button><button class="btn btn-warning btn-sm" onclick="fundShort('${f.id}',get('fund-trade-ticker')?.value,get('fund-trade-qty')?.value)">Short</button><button class="btn btn-sm" onclick="fundCoverShort('${f.id}',get('fund-trade-ticker')?.value,get('fund-trade-qty')?.value)">Cover</button></div>
      <div style="font-size:11px;color:var(--text2);margin-top:4px">Short${infoBubble('Short selling profits when a price FALLS, the opposite of a normal buy. The fund borrows shares and sells them now; Cover buys them back later to close the position. 1.5x the position value gets locked from the fund cash as collateral until covered.')} sells borrowed shares betting the price falls; Cover closes the position.</div>
      <hr class="divider" style="margin:10px 0">
      <div style="font-size:12px;font-weight:500;margin-bottom:8px;color:var(--text2)">Or place a limit order${infoBubble('A limit order only fills at your chosen price or better, instead of the current market price right now. It may sit unfilled until the price crosses your limit, or fill instantly if it already has.')}</div>
      <div class="frow"><label class="flabel">Limit price ($)</label><input type="number" id="fund-lmt-price" step="0.01" min="0.01" placeholder="e.g. 10.00"></div>
      <div class="btn-row"><button class="btn btn-primary btn-sm" onclick="placeLimitOrder(get('fund-trade-ticker')?.value,'buy',get('fund-trade-qty')?.value,get('fund-lmt-price')?.value,'${f.id}')">Limit buy</button><button class="btn btn-primary btn-sm" onclick="placeLimitOrder(get('fund-trade-ticker')?.value,'sell',get('fund-trade-qty')?.value,get('fund-lmt-price')?.value,'${f.id}')">Limit sell</button></div>
    </div>`;
    const fundOpenOrders=DB.limitOrders.filter(o=>o.fund_id===f.id&&o.status==='open');
    if(fundOpenOrders.length){
      html+=`<div class="card"><div class="section-title">Fund's open limit orders</div>
        <table><thead><tr><th>Ticker</th><th>Side</th><th>Qty</th><th class="r">Limit price</th><th></th></tr></thead><tbody>`
        +fundOpenOrders.map(o=>`<tr><td style="font-family:var(--mono)">${esc(o.ticker)}</td><td><span class="badge ${o.side==='buy'?'b-teal':'b-red'}">${o.side}</span></td><td>${o.qty}</td><td class="r" style="font-family:var(--mono)">${fmt(o.limit_price)}</td><td><button class="btn btn-sm btn-danger" onclick="cancelLimitOrder('${o.id}')">Cancel</button></td></tr>`).join('')
        +'</tbody></table></div>';
    }
  }

  return html;
}
function renderPortfolio(){
  const u=cu(),_pv=pv(u),_spnl=sPnl(u),_nw=nw(u);
  const held=Object.entries(holdings(u)),sh=Object.entries(shorts(u)).filter(([,s])=>s.qty>0);
  const _divs=divRec(u),watched=DB.companies.filter(c=>c.status==='listed'&&isWatched(c.ticker));
  const myDivs=DB.dividends.filter(d=>(d.payouts||[]).some(p=>p.userId===u.id)).reverse();

  const tabs=`<div class="tab-row">
    <button class="tab ${UI.portfolioTab==='holdings'?'active':''}" onclick="UI.portfolioTab='holdings';render()">Holdings</button>
    <button class="tab ${UI.portfolioTab==='shorts'?'active':''}" onclick="UI.portfolioTab='shorts';render()">Shorts ${sh.length?'<span class="badge b-purple" style="margin-left:4px">'+sh.length+'</span>':''}</button>
    <button class="tab ${UI.portfolioTab==='watchlist'?'active':''}" onclick="UI.portfolioTab='watchlist';render()">Watchlist ${watched.length?'<span class="badge b-teal" style="margin-left:4px">'+watched.length+'</span>':''}</button>
    <button class="tab ${UI.portfolioTab==='dividends'?'active':''}" onclick="UI.portfolioTab='dividends';render()">Dividends</button>
    <button class="tab ${UI.portfolioTab==='history'?'active':''}" onclick="UI.portfolioTab='history';render()">Trade history</button>
    <button class="tab ${UI.portfolioTab==='nwchart'?'active':''}" onclick="UI.portfolioTab='nwchart';render()">Net worth chart</button>
    <button class="tab" onclick="exportStudentPDF()" style="margin-left:auto;color:var(--blue)">📄 Export PDF</button>
  </div>`;

  if(UI.portfolioTab==='holdings'){
    const rows=held.length?held.map(([t,q])=>{
      const c=getCo(t);if(!c)return'';
      const val=c.price*q,chg=priceChg(c);
      return '<tr><td><span class="badge b-gray" style="font-family:var(--mono)">'+t+'</span></td><td>'+c.name+'</td><td>'+q+'</td><td style="font-family:var(--mono)">'+fmt(c.price)+'</td><td style="font-weight:500;font-family:var(--mono)">'+fmt(val)+'</td><td class="'+(chg>=0?'price-up':'price-down')+'">'+fmtChg(chg)+'</td><td><button class="btn btn-sm" onclick="UI.companyPage=null;setTab(&quot;market&quot;);setTimeout(()=>openPanel(&quot;'+t+'&quot;),50)">Trade</button></td></tr>';
    }).join(''):'<tr><td colspan="7"><div class="empty">No holdings</div></td></tr>';
    const _sharpe=calcSharpe(u.id),_beta=calcBeta(u.id),_var=calcVaR(u.id),_pnl=calcPnLAttribution(u.id);
    const analyticsRow=(_sharpe!=null||_beta!=null||_var!=null)?
      `<div class="grid4" style="margin-bottom:14px">
        ${_sharpe!=null?`<div class="mcard"><div class="mlabel">Sharpe ratio${infoBubble('Measures return per unit of risk you took to get it: your average return divided by how much your returns bounced around. Above 1 is generally considered good, below 0 means you lost money on average.')}</div><div class="mval ${_sharpe>1?'green':_sharpe<0?'red':''}" style="font-size:18px;font-family:var(--mono)">${_sharpe}</div><div style="font-size:10px;color:var(--text2);margin-top:2px">return ÷ risk</div></div>`:''}
        ${_beta!=null?`<div class="mcard"><div class="mlabel">Portfolio beta${infoBubble('How much your portfolio moves relative to the overall market. A beta of 1 means you move with the market; above 1 means bigger swings than the market (more volatile); below 1 means smaller swings.')}</div><div class="mval" style="font-size:18px;font-family:var(--mono)">${_beta}</div><div style="font-size:10px;color:var(--text2);margin-top:2px">vs market</div></div>`:''}
        ${_var!=null?`<div class="mcard"><div class="mlabel">Value at Risk 95%${infoBubble('Based on your worst trading sessions so far, this is roughly how much you could lose in a single session on a bad day (the 5th-percentile loss). It is an estimate from history, not a hard cap.')}</div><div class="mval red" style="font-size:18px;font-family:var(--mono)">${fmt(_var)}</div><div style="font-size:10px;color:var(--text2);margin-top:2px">max 1-session loss</div></div>`:''}
        ${_pnl?`<div class="mcard"><div class="mlabel">Total P&L</div><div class="mval ${_pnl.total>=0?'green':'red'}" style="font-size:18px;font-family:var(--mono)">${_pnl.total>=0?'+':''}${fmt(_pnl.total)}</div></div>`:''}
      </div>
      ${_pnl&&(_pnl.trade||_pnl.dividend||_pnl.unrealised)?`<div class="card" style="margin-bottom:14px"><div class="section-title">P&L Attribution</div><div class="grid4">
        <div class="mcard"><div class="mlabel">Realised trades</div><div class="mval ${_pnl.trade>=0?'green':'red'}" style="font-size:16px;font-family:var(--mono)">${_pnl.trade>=0?'+':''}${fmt(_pnl.trade)}</div></div>
        <div class="mcard"><div class="mlabel">Unrealised gain</div><div class="mval ${_pnl.unrealised>=0?'green':'red'}" style="font-size:16px;font-family:var(--mono)">${_pnl.unrealised>=0?'+':''}${fmt(_pnl.unrealised)}</div></div>
        <div class="mcard"><div class="mlabel">Dividends</div><div class="mval green" style="font-size:16px;font-family:var(--mono)">+${fmt(_pnl.dividend)}</div></div>
        <div class="mcard"><div class="mlabel">Short P&L</div><div class="mval ${_pnl.short>=0?'green':'red'}" style="font-size:16px;font-family:var(--mono)">${_pnl.short>=0?'+':''}${fmt(_pnl.short)}</div></div>
      </div></div>`:''}` : '';
    const _starting=DB.session.starting_cash||10000;
    const _gain=_nw-_starting;
    const _gainPct=Math.round(_gain/_starting*1000)/10;
    return tabs+`<div style="padding:12px 0 14px">
      <div style="font-size:28px;font-weight:700;font-family:var(--mono)">${fmt(_nw)}</div>
      <div style="font-size:14px;color:${_gain>=0?'var(--green)':'var(--red)'};margin-top:2px">${_gain>=0?'+':''}${fmt(_gain)} (${_gain>=0?'+':''}${_gainPct}%) since start</div>
    </div>
    <div class="grid4"><div class="mcard"><div class="mlabel">Cash</div><div class="mval" style="font-family:var(--mono)">${fmt(u.cash)}</div></div><div class="mcard"><div class="mlabel">Portfolio</div><div class="mval" style="font-family:var(--mono)">${fmt(_pv)}</div></div><div class="mcard"><div class="mlabel">Short P&L</div><div class="mval ${_spnl>=0?'green':'red'}" style="font-family:var(--mono)">${fmt(_spnl)}</div></div><div class="mcard"><div class="mlabel">Dividends</div><div class="mval green" style="font-family:var(--mono)">${fmt(_divs)}</div></div></div>${analyticsRow}
    <div class="card"><div class="section-title">Holdings</div><table><thead><tr><th>Ticker</th><th>Company</th><th>Shares</th><th>Price</th><th>Value</th><th>P&L</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  if(UI.portfolioTab==='shorts'){
    const shortRows=sh.length?sh.map(([t,pos])=>{
      const c=getCo(t);if(!c)return'';const p=(pos.avgPrice-c.price)*pos.qty;
      return '<div class="short-pos"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><span style="font-weight:500">'+c.name+' <span class="badge b-gray" style="font-family:var(--mono)">'+t+'</span></span><button class="btn btn-sm btn-warning" onclick="UI.companyPage=null;setTab(&quot;market&quot;);UI.panelMode=&quot;cover&quot;;setTimeout(()=>openPanel(&quot;'+t+'&quot;),50)">Cover</button></div><div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;font-size:12px"><div><div style="color:var(--text2)">Qty</div><div>'+pos.qty+'</div></div><div><div style="color:var(--text2)">Avg price</div><div style="font-family:var(--mono)">'+fmt(pos.avgPrice)+'</div></div><div><div style="color:var(--text2)">Current</div><div style="font-family:var(--mono)">'+fmt(c.price)+'</div></div><div><div style="color:var(--text2)">P&L</div><div style="font-family:var(--mono);color:'+(p>=0?'var(--green)':'var(--red)')+'">'+fmt(p)+'</div></div></div></div>';
    }).join(''):'<div class="empty">No open short positions</div>';
    const collTotal=Object.values(shorts(u)).reduce((s,p)=>s+p.collateral,0);
    return tabs+`<div class="grid3"><div class="mcard"><div class="mlabel">Open shorts</div><div class="mval">${sh.length}</div></div><div class="mcard"><div class="mlabel">Unrealised P&L</div><div class="mval ${_spnl>=0?'green':'red'}" style="font-family:var(--mono)">${fmt(_spnl)}</div></div><div class="mcard"><div class="mlabel">Collateral locked${infoBubble('When you short a stock, 1.5x the value of the shares you borrowed gets set aside from your cash as a safety deposit. You get it back (plus or minus your profit or loss) when you cover the position.')}</div><div class="mval" style="font-family:var(--mono)">${fmt(collTotal)}</div></div></div>${shortRows}`;
  }

  if(UI.portfolioTab==='watchlist'){
    if(!watched.length)return tabs+'<div class="empty">No stocks on your watchlist.<br>Click ☆ on any stock to add it.</div>';
    const wrows=watched.map(c=>{const chg=priceChg(c);return '<tr><td><span class="badge b-gray" style="font-family:var(--mono)">'+c.ticker+'</span></td><td>'+c.name+'</td><td style="font-family:var(--mono)">'+fmt(c.price)+'</td><td class="'+(chg>=0?'price-up':'price-down')+'">'+fmtChg(chg)+'</td><td>'+c.shares_avail.toLocaleString()+'</td><td><button class="wstar on" onclick="toggleWatch(&quot;'+c.ticker+'&quot;)">★</button></td><td><button class="btn btn-sm btn-primary" onclick="UI.companyPage=null;setTab(&quot;market&quot;);setTimeout(()=>openPanel(&quot;'+c.ticker+'&quot;),50)">Trade</button></td></tr>';}).join('');
    return tabs+'<div class="card"><div class="section-title">Watched stocks</div><table><thead><tr><th>Ticker</th><th>Company</th><th>Price</th><th>Change</th><th>Avail.</th><th></th><th></th></tr></thead><tbody>'+wrows+'</tbody></table></div>';
  }

  if(UI.portfolioTab==='history') return tabs+renderTradingHistory();
  if(UI.portfolioTab==='nwchart') return tabs+renderNWChart(u);

  // dividends tab
  if(!myDivs.length)return tabs+'<div class="empty">No dividends received yet</div>';
  const divRows=myDivs.map(d=>{const p=(d.payouts||[]).find(x=>x.userId===u.id);if(!p)return'';return '<tr><td style="color:var(--text2)">'+d.ts+'</td><td><span class="badge b-gray" style="font-family:var(--mono)">'+d.ticker+'</span></td><td style="font-family:var(--mono)">'+fmt(d.per_share)+'</td><td>'+p.shares+'</td><td style="color:var(--green);font-family:var(--mono)">'+fmt(p.payout)+'</td><td style="font-size:12px;color:var(--text2)">'+d.note+'</td></tr>';}).join('');
  return tabs+'<div class="card"><div class="section-title">Dividend history</div><table><thead><tr><th>Time</th><th>Company</th><th>Per share</th><th>Shares</th><th>Received</th><th>Note</th></tr></thead><tbody>'+divRows+'</tbody></table></div>';
}

// ═══════════════════════════════════════════════
// RENDER: TRADES
// ═══════════════════════════════════════════════
function renderTrades(adminView){
  const u=cu();const trades=adminView?DB.trades:[...DB.trades].filter(t=>t.buyer_id===u.id||t.seller_id===u.id);
  return `<div class="card"><div class="section-title">${adminView?'All trades':'Your trades'}</div><table><thead><tr><th>Time</th><th>Ticker</th><th>Price</th><th>Qty</th><th>Type</th>${adminView?'<th>Buyer</th><th>Seller</th>':''}</tr></thead><tbody>${trades.length?[...trades].reverse().map(t=>`<tr><td style="color:var(--text2)">${t.ts}</td><td><span class="badge b-gray" style="font-family:var(--mono)">${t.ticker}</span></td><td style="font-family:var(--mono)">${fmt(t.price)}</td><td>${t.qty}</td><td><span class="badge ${t.type==='short'?'b-purple':t.type==='cover'?'b-amber':t.type==='book_match'?'b-teal':t.type==='limit_buy'||t.type==='limit_sell'?'b-blue':'b-gray'}">${t.type==='book_match'?'matched':t.type==='limit_buy'?'limit buy':t.type==='limit_sell'?'limit sell':t.type||'market'}</span></td>${adminView?`<td>${['exchange','short'].includes(t.buyer_id)?'JEX':getUser(t.buyer_id)?.name||'?'}</td><td>${['exchange','cover'].includes(t.seller_id)?'JEX':getUser(t.seller_id)?.name||'?'}</td>`:''}</tr>`).join(''):`<tr><td colspan="7"><div class="empty">No trades yet</div></td></tr>`}</tbody></table></div>`;
}

// ═══════════════════════════════════════════════
// RENDER: SETTINGS
// ═══════════════════════════════════════════════
function renderSettings(){
  const u=cu();
  const sheetsSection=isChairman(u)?`<div class="card"><div class="section-title">Google Sheets sync</div>
    <div class="ibox ibox-blue">Paste your Google Apps Script web app URL here. JEX will automatically push balance updates to your sheet after every trade, dividend, and balance adjustment.</div>
    <div class="frow"><label class="flabel">Web app URL</label><input type="text" id="sheets-url" placeholder="https://script.google.com/macros/s/..." value="${SHEETS_URL||''}"></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" onclick="saveSheetsUrl(get('sheets-url')?.value)">Save URL</button>
      <button class="btn btn-success" onclick="pushBalances().then(()=>toast('Manual sync sent to Sheets'))">Push now</button>
      ${SHEETS_URL?'<button class="btn btn-danger" onclick="saveSheetsUrl(&quot;&quot;)">Clear</button>':''}
    </div>
    ${SHEETS_URL?'<div style="font-size:12px;color:var(--text2);margin-top:8px">✓ Sync active — pushing to Sheets automatically</div>':''}
  </div>`:'';
  const emailjsSection=isChairman(u)?`<div class="card"><div class="section-title">Email notifications (EmailJS)</div>
    <div class="ibox ibox-blue">Paste your EmailJS service/template/public key here to enable email alerts for students who opt in under Settings → Email notifications. Get these from your EmailJS account dashboard.</div>
    <div class="frow"><label class="flabel">Service ID</label><input type="text" id="ejs-service" placeholder="service_xxxxxxx" value="${DB.session.emailjs_service_id||''}"></div>
    <div class="frow"><label class="flabel">Template ID</label><input type="text" id="ejs-template" placeholder="template_xxxxxxx" value="${DB.session.emailjs_template_id||''}"></div>
    <div class="frow"><label class="flabel">Public key</label><input type="text" id="ejs-pubkey" placeholder="e.g. AbCdEfGhIjKlMnOp" value="${DB.session.emailjs_public_key||''}"></div>
    <div class="frow"><label class="flabel">App URL (optional)</label><input type="text" id="ejs-siteurl" placeholder="https://yourname.github.io/JEX/" value="${esc(DB.session.emailjs_site_url||'')}"></div>
    <button class="btn btn-primary" onclick="saveEmailJSConfig()">Save</button>
    ${DB.session.emailjs_service_id&&DB.session.emailjs_template_id&&DB.session.emailjs_public_key?'<div style="font-size:12px;color:var(--text2);margin-top:8px">✓ Configured — email alerts will send for students with it enabled</div>':''}
    <hr class="divider">
    <div class="ibox ibox-amber">Emails now send from the server, not this browser — EmailJS requires a <strong>Private Key</strong> (Account → API Keys → "Access Token") for that. It's stored server-side only and never shown again once saved.</div>
    <div class="frow"><label class="flabel">Private key</label><input type="password" id="ejs-secret" placeholder="${DB.session.emailjs_secret_configured?'••••••••  (already set — leave blank to keep)':'paste private key'}"></div>
    <button class="btn btn-primary" onclick="saveEmailJSSecret()">Save private key</button>
    ${DB.session.emailjs_secret_configured?'<div style="font-size:12px;color:var(--text2);margin-top:8px">✓ Private key is set</div>':'<div style="font-size:12px;color:var(--amber);margin-top:8px">⚠ No private key set — email sending is disabled until one is saved</div>'}
  </div>`:'';
  const isGoogleAccount=u.auth_provider==='google';
  const isMigratedLocal=!!u.auth_uid&&!isGoogleAccount;
  // Secretary/Treasurer/Compliance Officer sign in with a username only — their
  // backing email is an implementation detail, not something they see or manage,
  // unlike Chairman/President.
  const emailRestrictedRole=['secretary','treasurer','compliance_officer'].includes(u.role);
  const accountCard=`<div class="card"><div class="section-title">Account</div>
    <div class="grid2" style="margin-bottom:12px">
      <div class="mcard"><div class="mlabel">Name</div><div class="mval" style="font-size:16px">${esc(u.name)}</div></div>
      ${emailRestrictedRole?'':`<div class="mcard"><div class="mlabel">Email (login)</div><div class="mval" style="font-size:14px;margin-top:4px;word-break:break-all">${esc(u.email)}</div></div>`}
    </div>
    ${emailRestrictedRole?'':isGoogleAccount?`<div class="ibox ibox-blue">This account uses <strong>Google Sign-In</strong>. Your email is managed by Google and can't be changed here — sign in anytime with the "Sign in with Google" button on the login screen.</div>`
    :isMigratedLocal?`
    <div class="section-title" style="font-size:13px;margin-bottom:8px">Change email address</div>
    <div class="frow"><label class="flabel">New email address</label><input type="email" id="new-email" placeholder="${u.email}" autocomplete="email"></div>
    <button class="btn btn-primary" onclick="changeEmailSupa('${u.id}',get('new-email')?.value)">Update email</button>`
    :`
    <div class="section-title" style="font-size:13px;margin-bottom:8px">Change email address</div>
    <div class="frow"><label class="flabel">New email address</label><input type="email" id="new-email" placeholder="${u.email}" autocomplete="email"></div>
    <div class="frow"><label class="flabel">Confirm with password</label><div class="pw-wrap"><input type="password" id="email-confirm-pw" placeholder="Current password"><button type="button" class="pw-eye" onclick="togglePw('email-confirm-pw')" tabindex="-1">👁</button></div></div>
    <button class="btn btn-primary" onclick="changeEmail('${u.id}',get('new-email')?.value,get('email-confirm-pw')?.value)">Update email</button>`}
  </div>`;
  const passwordCard=isGoogleAccount?`<div class="card"><div class="section-title">Set a password (optional)</div><div class="ibox ibox-blue" style="margin-bottom:10px">Add a password as a backup way to sign in, in case Google Sign-In is ever unavailable. The "Sign in with Google" button keeps working either way.</div><div class="frow"><label class="flabel">New password</label><div class="pw-wrap"><input type="password" id="pw-new" placeholder="New password (min 6 characters)"><button type="button" class="pw-eye" onclick="togglePw('pw-new')" tabindex="-1">👁</button></div></div><div class="frow"><label class="flabel">Confirm new password</label><div class="pw-wrap"><input type="password" id="pw-conf" placeholder="Repeat new password"><button type="button" class="pw-eye" onclick="togglePw('pw-conf')" tabindex="-1">👁</button></div></div><button class="btn btn-primary" onclick="changePwSupa(get('pw-new')?.value,get('pw-conf')?.value)">Set password</button></div>`
    :isMigratedLocal?`<div class="card"><div class="section-title">Change password</div><div class="frow"><label class="flabel">New password</label><div class="pw-wrap"><input type="password" id="pw-new" placeholder="New password (min 6 characters)"><button type="button" class="pw-eye" onclick="togglePw('pw-new')" tabindex="-1">👁</button></div></div><div class="frow"><label class="flabel">Confirm new password</label><div class="pw-wrap"><input type="password" id="pw-conf" placeholder="Repeat new password"><button type="button" class="pw-eye" onclick="togglePw('pw-conf')" tabindex="-1">👁</button></div></div><button class="btn btn-primary" onclick="changePwSupa(get('pw-new')?.value,get('pw-conf')?.value)">Update password</button></div>`
    :`<div class="card"><div class="section-title">Change password</div><div class="frow"><label class="flabel">Current password</label><div class="pw-wrap"><input type="password" id="pw-cur" placeholder="Current password"><button type="button" class="pw-eye" onclick="togglePw('pw-cur')" tabindex="-1">👁</button></div></div><div class="frow"><label class="flabel">New password</label><div class="pw-wrap"><input type="password" id="pw-new" placeholder="New password (min 6 characters)"><button type="button" class="pw-eye" onclick="togglePw('pw-new')" tabindex="-1">👁</button></div></div><div class="frow"><label class="flabel">Confirm new password</label><div class="pw-wrap"><input type="password" id="pw-conf" placeholder="Repeat new password"><button type="button" class="pw-eye" onclick="togglePw('pw-conf')" tabindex="-1">👁</button></div></div><button class="btn btn-primary" onclick="changePw('${u.id}',get('pw-cur')?.value,get('pw-new')?.value,get('pw-conf')?.value)">Update password</button></div>`;
  return sheetsSection+emailjsSection+accountCard+passwordCard+
  `${u.role==='company'?`<div class="card"><div class="section-title">Company branding</div>
    <div class="ibox ibox-blue" style="margin-bottom:10px">Upload a logo image for your company. Shown on your ticker chip and company page. Max 200KB recommended.</div>
    ${(()=>{const co=DB.companies.find(c=>c.owner_id===u.id);return co&&co.logo?`<div style="margin-bottom:10px"><img src="${co.logo}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid var(--border)"></div>`:'';})()}
    <div class="frow"><label class="flabel">Logo image</label><input type="file" id="logo-upload" accept="image/*" onchange="previewLogo(this)"></div>
    <div id="logo-preview" style="margin-bottom:10px"></div>
    <button class="btn btn-primary" onclick="saveLogo()">Save logo</button>
  </div>`:''}
  <div class="card"><div class="section-title">Notifications</div>
    ${(()=>{
      const pushStatus=typeof Notification==='undefined'?'unsupported':Notification.permission;
      const pushRow='<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border)">'
        +'<div><div style="font-size:13px;font-weight:500;margin-bottom:2px">Browser popup notifications</div>'
        +'<div style="font-size:12px;color:'+(pushStatus==='granted'?'var(--green)':pushStatus==='denied'?'var(--red)':'var(--text2)')+'">'+
          (pushStatus==='unsupported'?'Not supported in this browser':pushStatus==='granted'?'✓ Enabled':pushStatus==='denied'?'Blocked — enable in your browser settings':'Not enabled yet')
        +'</div></div>'
        +'<div>'+(pushStatus==='granted'?'<button class="btn btn-sm" onclick="showBrowserPush(&quot;JEX&quot;,&quot;Test notification!&quot;)">Send test</button>':pushStatus==='denied'?'':pushStatus==='unsupported'?'':'<button class="btn btn-sm btn-primary" onclick="requestPushPermission().then(ok=>{ok?toast(&quot;✓ Notifications enabled&quot;):toast(&quot;Permission denied — check browser settings&quot;);render();})">Enable</button>')+'</div>'
        +'</div>';
      const emailRow='<div style="padding:12px 0">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:'+(u.email_notifications?'10px':'0')+'">'
        +'<div><div style="font-size:13px;font-weight:500;margin-bottom:2px">Email notifications</div>'
        +'<div style="font-size:12px;color:var(--text2)">'+(u.email_notifications?'Enabled — sending to '+(u.notification_email||u.email):'Get important alerts sent to your email')+'</div></div>'
        +'<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px"><input type="checkbox" id="email-notif-toggle" '+(u.email_notifications?'checked':'')+'  onchange="toggleEmailNotifications(this.checked)"><span>'+(u.email_notifications?'On':'Off')+'</span></label>'
        +'</div>'
        +(u.email_notifications?'<div class="frow" style="margin-bottom:8px"><label class="flabel">Send to email address</label><input type="email" id="notif-email" placeholder="'+(u.notification_email||u.email)+'" value="'+(u.notification_email||'')+'" autocomplete="email"></div>'
          +'<div style="display:flex;align-items:center;gap:8px"><button class="btn btn-sm btn-primary" onclick="saveNotifEmail()">Save</button>'
          +'<span style="font-size:11px;color:var(--text2)">Alerts for: dividends, session open/close, IPO, stop-loss, order fills</span></div>':'')
        +'</div>';
      const emailNotifRestricted=['secretary','treasurer','compliance_officer'].includes(u.role);
      return pushRow+(emailNotifRestricted?'':emailRow);
    })()}
  </div>
  ${isGoogleAccount?'':`<div class="card"><div class="section-title">Security question</div><div class="ibox ibox-blue" style="margin-bottom:10px">Current question: <strong>${u.sec_q||'Not set'}</strong></div><div class="frow"><label class="flabel">New security question</label>${secQSelect('settings')}</div><div class="frow"><label class="flabel">New security answer</label><input type="text" id="settings-secq-answer" placeholder="Your answer" autocomplete="off"></div><div class="frow"><label class="flabel">Confirm with current password</label><div class="pw-wrap"><input type="password" id="settings-secq-pw" placeholder="Current password"><button type="button" class="pw-eye" onclick="togglePw('settings-secq-pw')" tabindex="-1">👁</button></div></div><button class="btn btn-primary" onclick="updateSecQ('${u.id}',get('settings-secq-pw')?.value,get('settings-secq')?.value,get('settings-secq-answer')?.value)">Update security question</button></div>`}`;
}

// ═══════════════════════════════════════════════
// RENDER: COMPANY PAGES
// ═══════════════════════════════════════════════
function renderApply(){
  const myApp=DB.ipoApps.find(a=>a.user_id===UI.userId);
  return `<div class="tab-row"><button class="tab ${UI.appTab==='status'?'active':''}" onclick="UI.appTab='status';render()">Status</button><button class="tab ${UI.appTab==='apply'?'active':''}" onclick="UI.appTab='apply';render()">${myApp&&myApp.status!=='rejected'?'View':'New application'}</button></div>${UI.appTab==='status'?renderAppStatus(myApp):renderAppForm(myApp)}`;
}
function renderAppStatus(app){
  if(!app)return`<div class="card"><div class="empty">No application yet.<br><br><button class="btn btn-primary" onclick="UI.appTab='apply';render()">Start application</button></div></div>`;
  const co=app.status==='approved'?DB.companies.find(c=>c.ticker===app.ticker):null;
  const sm={pending:'b-amber',approved:'b-green',rejected:'b-red'};
  const notif=app.status==='approved'
    ?'<div class="ibox ibox-green" style="margin-bottom:14px">🎉 <strong>Congratulations! Your IPO has been approved.</strong> Your company <strong>'+esc(app.name)+'</strong> is now listed on JEX as <span style="font-family:var(--mono)">'+esc(app.ticker)+'</span>. Go to <strong>My stock</strong> to manage it.</div>'
    :app.status==='rejected'
    ?'<div class="ibox ibox-red" style="margin-bottom:14px">❌ <strong>Your IPO application was rejected.</strong> You can submit a new application with a different ticker or details.</div>'
    :'<div class="ibox ibox-amber" style="margin-bottom:14px">⏳ <strong>Your application is under review.</strong> The Chairman will approve or reject it shortly.</div>';
  return`<div class="card"><div class="section-title">${esc(app.name)} (${esc(app.ticker)})</div>
    ${notif}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px"><span class="badge ${sm[app.status]||'b-gray'}">${app.status}</span><span style="font-size:12px;color:var(--text2)">Submitted ${app.ts}</span></div>
    <div class="grid2"><div class="mcard"><div class="mlabel">IPO price</div><div class="mval" style="font-family:var(--mono)">${fmt(app.price)}</div></div><div class="mcard"><div class="mlabel">Shares issued</div><div class="mval">${app.shares.toLocaleString()}</div></div></div>
    ${app.status==='approved'&&co?`<hr class="divider"><div class="grid3"><div class="mcard"><div class="mlabel">Current price</div><div class="mval" style="font-family:var(--mono)">${fmt(co.price)}</div></div><div class="mcard"><div class="mlabel">Available shares</div><div class="mval">${co.shares_avail.toLocaleString()}</div></div><div class="mcard"><div class="mlabel">Market cap${infoBubble('Market capitalization: the total value of every share the company has issued, calculated as current price times total shares. It is what the whole company would be worth if you bought up every share at the current price.')}</div><div class="mval" style="font-family:var(--mono)">${fmt(co.price*co.shares)}</div></div></div>`:''}
    ${app.status==='rejected'?`<button class="btn btn-primary" onclick="reapply()">Submit new application</button>`:''}
  </div>`;
}
async function reapply(){
  // Runs server-side (rpc_set_own_app_status) -- withdraws any pending IPO
  // application and resets app_status, both scoped to the caller's own row
  // via auth.uid() rather than a client-supplied id.
  try{await sb.rpc('rpc_set_own_app_status',{p_status:'none'});}catch(e){return toast(rpcErrorMessage(e));}
  const idx=DB.ipoApps.findIndex(a=>a.user_id===UI.userId);if(idx>=0)DB.ipoApps.splice(idx,1);
  const self=cu();if(self)self.app_status='none';
  UI.appTab='apply';render();
}
function renderAppForm(app){
  if(app&&app.status==='pending')return`<div class="card"><div class="empty">Application under review.</div></div>`;
  if(app&&app.status==='approved')return`<div class="card"><div class="empty">Your company is already listed!</div></div>`;
  return`<div class="card"><div class="section-title">IPO application${infoBubble('IPO stands for Initial Public Offering — the first time a company sells shares to the public. Once approved, your stock gets listed on the market and anyone can buy or sell shares of it.')}</div><div class="row"><div class="frow" style="flex:1"><label class="flabel">Company name</label><input type="text" id="ipo-name" placeholder="Acme Corp"></div><div class="frow" style="flex:1"><label class="flabel">Ticker (3-4 letters)</label><input type="text" id="ipo-ticker" placeholder="ACM" maxlength="4" style="text-transform:uppercase"></div></div><div class="row"><div class="frow" style="flex:1"><label class="flabel">IPO price ($)</label><input type="number" id="ipo-price" placeholder="25.00" min="0.01" step="0.01"></div><div class="frow" style="flex:1"><label class="flabel">Total shares</label><input type="number" id="ipo-shares" placeholder="1000" min="1"></div></div><div class="frow"><label class="flabel">Description</label><textarea id="ipo-desc" rows="2" placeholder="Describe your business..."></textarea></div><button class="btn btn-primary" onclick="submitIPOForm()">Submit</button></div>`;
}
function renderMyStock(){
  const u=cu();
  // Lead founder or co-founder
  const co=getMyCompany(u.id);
  const isLead=co&&co.owner_id===u.id;
  if(!co)return renderApply();
  loadCompanyTeamContacts(co.ticker);
  const pendingDil=DB.dilApps.find(d=>d.ticker===co.ticker&&d.status==='pending');
  const myDils=DB.dilApps.filter(d=>d.ticker===co.ticker).reverse();
  const myDivs=DB.dividends.filter(d=>d.ticker===co.ticker).reverse();
  const myBBs=DB.buybacks.filter(b=>b.ticker===co.ticker).reverse();
  const myNews=DB.news.filter(n=>n.ticker===co.ticker);
  const pendingClassApp=DB.classApps.filter(a=>a.owner_id===u.id&&a.status==='pending').length;
  const myVotes=DB.votes.filter(v=>v.parent_ticker===co.ticker);
  return`<div class="tab-row">
    <button class="tab ${UI.companyTab==='stock'?'active':''}" onclick="UI.companyTab='stock';render()">Overview</button>
    <button class="tab ${UI.companyTab==='founders'?'active':''}" onclick="UI.companyTab='founders';render()">Founders</button>
    <button class="tab ${UI.companyTab==='classes'?'active':''}" onclick="UI.companyTab='classes';render()">Share classes ${pendingClassApp?'<span class="badge b-amber" style="margin-left:4px">'+pendingClassApp+'</span>':''}</button>
    <button class="tab ${UI.companyTab==='votes'?'active':''}" onclick="UI.companyTab='votes';render()">Votes ${myVotes.length?'<span class="badge b-purple" style="margin-left:4px">'+myVotes.length+'</span>':''}</button>
    <button class="tab ${UI.companyTab==='news'?'active':''}" onclick="UI.companyTab='news';render()">News ${myNews.length?'<span class="badge b-amber" style="margin-left:4px">'+myNews.length+'</span>':''}</button>

    <button class="tab ${UI.companyTab==='financials'?'active':''}" onclick="UI.companyTab='financials';render()">Financials</button>
    <button class="tab ${UI.companyTab==='dividends'?'active':''}" onclick="UI.companyTab='dividends';render()">Dividends</button>
    <button class="tab ${UI.companyTab==='buyback'?'active':''}" onclick="UI.companyTab='buyback';render()">Buyback</button>
    <button class="tab ${UI.companyTab==='dilution'?'active':''}" onclick="UI.companyTab='dilution';render()">Dilution ${DB.dilApps.filter(d=>getCompanyTickers(co.ticker).includes(d.ticker)&&d.status==='pending').length?'<span class="badge b-amber" style="margin-left:4px">'+DB.dilApps.filter(d=>getCompanyTickers(co.ticker).includes(d.ticker)&&d.status==='pending').length+'</span>':''}</button>
  </div>
  ${UI.companyTab==='stock'?renderStockOverview(co,u)
  :UI.companyTab==='founders'?renderFoundersTab(co,u)
  :UI.companyTab==='classes'?renderClassesTab(co)
  :UI.companyTab==='votes'?renderCompanyVotesTab(co)
  :UI.companyTab==='news'?renderCompanyNewsTab(co,myNews)
  :UI.companyTab==='financials'?renderFinancialsMgmtTab(co,co.financials)
  :UI.companyTab==='dividends'?renderDivTab(co,myDivs)
  :UI.companyTab==='buyback'?renderBBTab(co,myBBs)
  :renderDilTab(co)}`;
}

async function convertBaseClass(parentTicker,classType,votesPerShare,restricted,whitelistIds,reason){
  const co=getCo(parentTicker);if(!co)return;
  const u=cu();
  if(!canManageCompany(co))return toast('Only this company\'s owner or founders can convert its share class');
  if(!classType)return toast('Select a class type');
  votesPerShare=parseInt(votesPerShare);
  if(isNaN(votesPerShare)||votesPerShare<0)return toast('Enter valid votes per share');
  if(!reason||reason.trim().length<5)return toast('Please add a reason');
  // Check not already converted
  if(DB.shareClasses.find(c=>c.ticker===parentTicker))return toast('This stock is already classified');
  if(DB.classApps.find(a=>a.proposed_ticker===parentTicker&&a.status==='pending'))return toast('A conversion is already pending');
  const app={id:uid(),parent_ticker:parentTicker,proposed_ticker:parentTicker,
    class:classType,label:'Class '+classType,votes_per_share:votesPerShare,
    shares:co.shares,price:co.price,
    restricted:!!restricted,whitelist:whitelistIds||[],
    company_name:co.name,owner_id:u.id,status:'pending',
    reason:'[CONVERT] '+(reason||'').trim(),ts:ts()};
  await sb.post('jex_class_applications',app);
  DB.classApps.push(app);
  toast('Conversion request submitted — awaiting Chairman approval');
  UI.companyTab='classes';render();
}
function convertBaseClassForm(parentTicker){
  const classType=document.getElementById('conv-type')?.value;
  const votes=document.getElementById('conv-votes')?.value;
  const restrictedVal=document.getElementById('conv-restricted')?.value;
  const restricted=restrictedVal==='yes';
  const whitelistEl=document.getElementById('conv-whitelist');
  const whitelist=restricted&&whitelistEl?Array.from(whitelistEl.selectedOptions).map(o=>o.value):[];
  const reason=document.getElementById('conv-reason')?.value;
  convertBaseClass(parentTicker,classType,votes,restricted,whitelist,reason);
}

function renderStockOverview(co,u){
  const allTickers=getCompanyTickers(co.ticker);
  const baseMeta=DB.shareClasses.find(c=>c.ticker===co.ticker);
  // Aggregate totals across all classes
  const totalShares=allTickers.reduce((s,t)=>{const c=getCo(t);return s+(c?c.shares:0);},0);
  const totalMarketCap=allTickers.reduce((s,t)=>{const c=getCo(t);return s+(c?c.price*c.shares:0);},0);

  let html=`<div class="grid4">
    <div class="mcard"><div class="mlabel">Base price</div><div class="mval" style="font-family:var(--mono)">${fmt(co.price)}</div></div>
    <div class="mcard"><div class="mlabel">Total market cap</div><div class="mval" style="font-family:var(--mono)">${fmt(totalMarketCap)}</div></div>
    <div class="mcard"><div class="mlabel">Total shares issued</div><div class="mval">${totalShares.toLocaleString()}</div></div>
    <div class="mcard"><div class="mlabel">Company cash</div><div class="mval" style="font-family:var(--mono)">${fmt(u.cash)}</div></div>
  </div>`;

  // Funding goal & use of funds
  html+=`<div class="card"><div class="section-title">Funding goal</div>
    <div class="ibox ibox-blue" style="margin-bottom:12px">Shown to investors on your public company page, with your progress toward it based on capital raised through share sales.</div>
    <div class="frow"><label class="flabel">Goal amount (optional)</label><input type="number" id="fund-goal" placeholder="e.g. 5000" min="0" step="0.01" value="${co.funding_goal!=null?co.funding_goal:''}"></div>
    <div class="frow"><label class="flabel">What will the funds be used for?</label><textarea id="fund-use" rows="3" placeholder="e.g. Filament and print time for prototyping our water bottle design...">${esc(co.use_of_funds||'')}</textarea></div>
    <button class="btn btn-primary btn-sm" onclick="updateFundingGoal('${co.ticker}',get('fund-goal')?.value,get('fund-use')?.value)">Save funding goal</button>
  </div>`;

  // Base stock card
  html+='<div class="card"><div class="section-title">Share classes</div>';

  allTickers.forEach((ticker,i)=>{
    const stock=getCo(ticker);if(!stock)return;
    const meta=getClassMeta(ticker);
    const chartId='co-chart-'+ticker;
    const classLabel=meta?'Class '+meta.class:'Unclassified';
    const classColor=meta?meta.class==='A'?'b-blue':meta.class==='B'?'b-amber':'b-teal':'b-gray';
    const vps=meta?meta.votes_per_share:1;
    html+='<div style="padding:12px;'+(i>0?'border-top:1px solid var(--border);':'')+'display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:12px;align-items:center">'
      +'<div><div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">'
      +'<span style="font-family:var(--mono);font-weight:500">'+ticker+'</span>'
      +'<span class="badge '+classColor+'">'+classLabel+'</span>'
      +(meta&&meta.restricted?'<span class="badge b-red">Restricted</span>':'')
      +'</div>'
      +'<div style="font-size:11px;color:var(--text2)">'+vps+' vote'+(vps!==1?'s':'')+'/share'+(meta&&meta.restricted?' · '+(meta.whitelist||[]).length+' whitelisted':'')+'</div>'
      +'</div>'
      +'<div><div style="font-size:11px;color:var(--text2);margin-bottom:2px">Price</div><div style="font-family:var(--mono);font-weight:500">'+fmt(stock.price)+'</div></div>'
      +'<div><div style="font-size:11px;color:var(--text2);margin-bottom:2px">Change</div><div id="chg-badge-'+chartId+'" class="'+tickerChgClass(chartId,stock)+'" style="font-family:var(--mono)">'+tickerChgBadgeHtml(chartId,stock)+'</div></div>'
      +'<div><div style="font-size:11px;color:var(--text2);margin-bottom:2px">Shares</div><div style="font-size:13px">'+stock.shares.toLocaleString()+' <span style="color:var(--text2);font-size:11px">('+stock.shares_avail.toLocaleString()+' free)</span></div></div>'
      +'<div><div style="font-size:11px;color:var(--text2);margin-bottom:2px">Market cap</div><div style="font-family:var(--mono);font-size:13px">'+fmt(stock.price*stock.shares)+'</div></div>'
      +'</div>';
  });

  html+='</div>';
  // One chart per ticker with interval buttons
  html+='<div class="card"><div class="section-title">Price charts</div>'
    +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">';
  allTickers.forEach(ticker=>{
    const stock=getCo(ticker);if(!stock)return;
    const meta=getClassMeta(ticker);
    const label=ticker===co.ticker?ticker+' (base)':(ticker+' Class '+(meta?meta.class:''));
    const chartId='co-chart-'+ticker;
    html+='<div>'
      +'<div style="font-size:12px;font-weight:500;font-family:var(--mono);margin-bottom:4px;color:var(--text2)">'+label+'</div>'
      +buildChartIntervalBar(chartId,stock)
      +'<div style="position:relative;height:140px"><canvas id="'+chartId+'"></canvas></div>'
      +'</div>';
  });
  html+='</div></div>';
  return html;
}
function renderCompanyTeamTab(co){
  const owner=getUser(co.owner_id);
  const founders=DB.companyMembers.filter(m=>m.company_user_id===co.owner_id&&m.status==='accepted').map(m=>getUser(m.student_id)).filter(Boolean);
  let html='<div class="card"><div class="section-title">Team</div>';
  html+='<div class="ibox ibox-blue" style="margin-bottom:12px">Contact the people behind this company directly.</div>';
  const rows=[];
  if(owner)rows.push({name:owner.name,email:owner.email,role:'Owner'});
  founders.forEach(f=>rows.push({name:f.name,email:f.email,role:'Founder'}));
  if(!rows.length){html+='<div class="empty">No team information available</div>';}
  else{
    html+=rows.map(r=>`<div class="app-row"><div class="app-info"><div class="app-name">${esc(r.name)} <span class="badge b-blue">${r.role}</span></div><div class="app-meta">${r.email?`<a href="mailto:${esc(r.email)}" class="legal-link">${esc(r.email)}</a>`:'No email on file'}</div></div></div>`).join('');
  }
  html+='</div>';
  return html;
}
function renderFoundersTab(co,u){
  const members=DB.companyMembers.filter(m=>m.company_user_id===co.owner_id&&m.status!=='removed');
  const accepted=members.filter(m=>m.status==='accepted');
  const pending=members.filter(m=>m.status==='pending');
  const allTickers=getCompanyTickers(co.ticker);
  const availableStudents=DB.users.filter(u2=>
    u2.role==='student'&&u2.status==='approved'&&
    !members.find(m=>m.student_id===u2.id&&m.status!=='declined')
  );
  const myInvites=DB.companyMembers.filter(m=>m.student_id===u.id&&m.status==='pending');
  let html='';

  if(myInvites.length){
    html+='<div class="card"><div class="section-title">Pending invitations</div>';
    myInvites.forEach(inv=>{
      const invCo=DB.companies.find(c=>c.owner_id===inv.company_user_id);
      html+='<div class="app-row"><div class="app-info">'
        +'<div class="app-name">Founder invitation: <strong>'+(invCo?.name||'Unknown')+'</strong></div>'
        +'<div class="app-meta">Invited by '+inv.invited_by+' · '+inv.ts+'</div></div>'
        +'<div class="btn-row">'
        +'<button class="btn btn-success btn-sm" onclick="respondToInvite(&quot;'+inv.id+'&quot;,true)">Accept</button>'
        +'<button class="btn btn-danger btn-sm" onclick="respondToInvite(&quot;'+inv.id+'&quot;,false)">Decline</button>'
        +'</div></div>';
    });
    html+='</div>';
  }

  html+='<div class="card"><div class="section-title">Founders ('+accepted.length+'/3 accepted)</div>';
  if(!accepted.length&&!pending.length){
    html+='<div class="ibox ibox-amber">No founders yet. Use the form below to invite students as founders.</div>';
  }
  accepted.forEach(m=>{
    const s=getUser(m.student_id);
    html+='<div class="app-row"><div class="app-info">'
      +'<div class="app-name">'+(s?.name||'?')+' <span class="badge b-blue">Founder</span></div>'
      +'<div class="app-meta">'+(s?.email||'')+'</div></div>'
      +'<button class="btn btn-sm btn-danger" onclick="removeFounder(&quot;'+m.id+'&quot;,&quot;'+(s?.name||'?')+'&quot;)">Remove</button>'
      +'</div>';
  });
  pending.forEach(m=>{
    const s=getUser(m.student_id);
    html+='<div class="app-row"><div class="app-info">'
      +'<div class="app-name">'+(s?.name||'?')+' <span class="badge b-gray">Invite pending</span></div>'
      +'<div class="app-meta">Waiting for response</div></div></div>';
  });
  html+='</div>';

  if(accepted.length+pending.length<3){
    html+='<div class="card"><div class="section-title">Invite a founder</div>'
      +'<div class="ibox ibox-blue">Up to 3 students can be founders. They can post news, financials, votes, and request share allocations.</div>'
      +'<div class="row" style="align-items:flex-end">'
      +'<div class="frow" style="flex:1"><label class="flabel">Select student</label>'
      +'<select id="invite-student"><option value="">— Select a student —</option>'
      +availableStudents.map(s=>'<option value="'+s.id+'">'+s.name+'</option>').join('')
      +'</select></div>'
      +'<div style="padding-bottom:12px"><button class="btn btn-primary" onclick="doInviteFounder(&quot;'+co.owner_id+'&quot;)">Send invite</button></div>'
      +'</div></div>';
  } else {
    html+='<div class="ibox ibox-teal">Maximum 3 founders reached.</div>';
  }

  if(co.status==='listed'){
    const allAllocs=DB.founderAllocations.filter(a=>allTickers.includes(a.ticker));
    html+='<div class="card"><div class="section-title">Founder share allocations</div>'
      +'<div class="ibox ibox-teal">Request shares from any share class for any founder. Each request requires Chairman approval.</div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:12px">'
      +'<div><label class="flabel">Founder</label>'
      +'<select id="alloc-student"><option value="">— Select —</option>'
      +accepted.map(m=>{const s=getUser(m.student_id);return s?'<option value="'+s.id+'">'+s.name+'</option>':''}).join('')
      +'</select></div>'
      +'<div><label class="flabel">Share class</label>'
      +'<select id="alloc-ticker"><option value="">— Select —</option>'
      +allTickers.map(t=>{const stock=getCo(t);if(!stock)return'';const meta=getClassMeta(t);return'<option value="'+t+'">'+t+' '+(meta?'(Class '+meta.class+')':'(base)')+' — '+stock.shares_avail+' avail.</option>';}).join('')
      +'</select></div>'
      +'<div><label class="flabel">Shares</label><input type="number" id="alloc-shares" placeholder="e.g. 100" min="1"></div>'
      +'<div><label class="flabel">Reason</label><input type="text" id="alloc-reason" placeholder="Founder compensation"></div>'
      +'</div>'
      +'<button class="btn btn-warning" onclick="doRequestFounderAlloc()">Submit allocation request</button>'
      +(allAllocs.length?'<hr class="divider"><table><thead><tr><th>Founder</th><th>Ticker</th><th>Shares</th><th>Reason</th><th>Status</th></tr></thead><tbody>'
        +allAllocs.map(a=>'<tr><td>'+a.student_name+'</td><td><span class="badge b-gray" style="font-family:var(--mono)">'+a.ticker+'</span></td><td>'+a.shares.toLocaleString()+'</td><td style="font-size:12px;color:var(--text2)">'+(a.reason||'—')+'</td><td><span class="badge '+(a.status==='approved'?'b-green':a.status==='rejected'?'b-red':'b-amber')+'">'+a.status+'</span></td></tr>').join('')
        +'</tbody></table>':'')
      +'</div>';
  }
  return html;
}

function renderClassesTab(co){
  const myClasses=DB.shareClasses.filter(c=>c.parent_ticker===co.ticker&&c.ticker!==co.ticker);
  const myApps=DB.classApps.filter(a=>a.parent_ticker===co.ticker).reverse();
  const students=DB.users.filter(u=>u.role==='student'&&u.status==='approved');
  const studentOptions=students.map(s=>'<option value="'+s.id+'">'+s.name+'</option>').join('');
  const baseIsConverted=!!DB.shareClasses.find(c=>c.ticker===co.ticker);
  const basePendingConversion=!!DB.classApps.find(a=>a.proposed_ticker===co.ticker&&a.status==='pending');
  // Get base class metadata if converted
  const baseMeta=DB.shareClasses.find(c=>c.ticker===co.ticker);
  let html='';

  // ── Current class status ──────────────────────────────
  html+='<div class="card"><div class="section-title">Current share structure</div>';
  if(baseMeta){
    html+='<div class="app-row"><div class="app-info">'
      +'<div class="app-name"><span class="badge b-gray" style="font-family:var(--mono)">'+co.ticker+'</span> <span class="badge b-amber">Class '+baseMeta.class+'</span>'
      +(baseMeta.restricted?'<span class="badge b-red" style="margin-left:4px">Restricted</span>':'')+'</div>'
      +'<div class="app-meta">'+baseMeta.votes_per_share+' vote'+(baseMeta.votes_per_share!==1?'s':'')+'/share · '+co.shares.toLocaleString()+' shares · '+fmt(co.price)
      +(baseMeta.restricted?' · Whitelist: '+(baseMeta.whitelist||[]).map(id=>getUser(id)?.name||id).join(', '):'')+'</div>'
      +'</div></div>';
  } else {
    html+='<div class="app-row"><div class="app-info">'
      +'<div class="app-name"><span class="badge b-gray" style="font-family:var(--mono)">'+co.ticker+'</span> <span class="badge b-gray">Unclassified</span></div>'
      +'<div class="app-meta">No class set · '+co.shares.toLocaleString()+' shares · '+fmt(co.price)+'</div>'
      +'</div></div>';
  }
  if(myClasses.length){
    html+=myClasses.map(c=>{
      const co2=getCo(c.ticker);
      return '<div class="app-row"><div class="app-info">'
        +'<div class="app-name"><span class="badge b-gray" style="font-family:var(--mono)">'+c.ticker+'</span> <span class="badge b-amber">Class '+c.class+'</span>'
        +(c.restricted?'<span class="badge b-red" style="margin-left:4px">Restricted</span>':'')+'</div>'
        +'<div class="app-meta">'+c.votes_per_share+' vote'+(c.votes_per_share!==1?'s':'')+'/share'
        +(co2?' · '+co2.shares.toLocaleString()+' shares · '+fmt(co2.price):'')
        +(c.restricted?' · Whitelist: '+(c.whitelist||[]).map(id=>getUser(id)?.name||id).join(', '):'')+'</div>'
        +'</div></div>';
    }).join('');
  }
  html+='</div>';

  // ── Convert existing stock ────────────────────────────
  if(!baseIsConverted&&!basePendingConversion){
    html+='<div class="card"><div class="section-title">Convert '+co.ticker+' to a share class</div>'
      +'<div class="ibox ibox-amber">This reclassifies your existing <strong>'+co.ticker+'</strong> stock by assigning it a class type and voting rights. The ticker stays the same. Requires Chairman approval.</div>'
      +'<div class="frow"><label class="flabel">Class type</label>'
      +'<select id="conv-type"><option value="">— Select —</option>'
      +'<option value="A">Class A — Standard voting</option>'
      +'<option value="B">Class B — High voting power</option>'
      +'<option value="C">Class C — No votes, dividends only</option>'
      +'</select></div>'
      +'<div class="frow"><label class="flabel">Votes per share</label><input type="number" id="conv-votes" value="1" min="0" placeholder="e.g. 10"></div>'
      +'<div class="frow"><label class="flabel">Restrict to specific students? (optional)</label>'
      +'<select id="conv-restricted"><option value="">No restriction</option><option value="yes">Yes — restricted</option></select></div>'
      +'<div id="conv-whitelist-wrap" style="display:none"><div class="frow"><label class="flabel">Select allowed students</label>'
      +'<select id="conv-whitelist" multiple style="height:90px">'+studentOptions+'</select></div></div>'
      +'<div class="frow"><label class="flabel">Reason</label><textarea id="conv-reason" rows="2" placeholder="e.g. Converting to Class B for founder control..."></textarea></div>'
      +'<button class="btn btn-warning" onclick="convertBaseClassForm(&quot;'+co.ticker+'&quot;)">Submit conversion request</button>'
      +'</div>';
  } else if(basePendingConversion){
    html+='<div class="ibox ibox-amber">A conversion request for <strong>'+co.ticker+'</strong> is pending Chairman approval.</div>';
  }

  // ── Issue new class ───────────────────────────────────
  html+='<div class="card"><div class="section-title">Issue a new share class</div>'
    +'<div class="ibox ibox-teal">Issues a new class with its own ticker (e.g. '+co.ticker+'.B), price, and share count. Trades independently. Requires Chairman approval.</div>'
    +'<div class="frow"><label class="flabel">Class type</label>'
    +'<select id="cls-type"><option value="">— Select —</option>'
    +'<option value="A">Class A — Standard voting</option>'
    +'<option value="B">Class B — High voting power</option>'
    +'<option value="C">Class C — No votes, dividends only</option>'
    +'</select></div>'
    +'<div class="grid2" style="margin-bottom:12px">'
    +'<div class="frow" style="margin-bottom:0"><label class="flabel">Votes per share</label><input type="number" id="cls-votes" value="1" min="0" placeholder="e.g. 10"></div>'
    +'<div class="frow" style="margin-bottom:0"><label class="flabel">IPO price ($)</label><input type="number" id="cls-price" placeholder="25.00" min="0.01" step="0.01"></div>'
    +'</div>'
    +'<div class="frow"><label class="flabel">Total shares to issue</label><input type="number" id="cls-shares" placeholder="1000" min="1"></div>'
    +'<div class="frow"><label class="flabel">Restrict to specific students? (optional)</label>'
    +'<select id="cls-restricted"><option value="">No restriction — open to all</option><option value="yes">Yes — restricted to selected students</option></select></div>'
    +'<div id="cls-whitelist-wrap" style="display:none"><div class="frow"><label class="flabel">Select allowed students (hold Ctrl/Cmd for multiple)</label>'
    +'<select id="cls-whitelist" multiple style="height:100px">'+studentOptions+'</select></div></div>'
    +'<div class="frow"><label class="flabel">Reason for issuance</label><textarea id="cls-reason" rows="2" placeholder="e.g. Issuing Class B to founders..."></textarea></div>'
    +'<button class="btn btn-primary" onclick="submitClassAppForm(&quot;'+co.ticker+'&quot;)">Submit for approval</button>'
    +'</div>';

  // ── Application history ───────────────────────────────
  if(myApps.length){
    html+='<div class="card"><div class="section-title">Application history</div>'
    +myApps.map(a=>{
      const isConv=a.reason&&a.reason.startsWith('[CONVERT]');
      return '<div class="app-row"><div class="app-info">'
        +'<div class="app-name">'+(isConv?'Convert ':'New class ')+'<span class="badge b-gray" style="font-family:var(--mono)">'+a.proposed_ticker+'</span> Class '+a.class+'</div>'
        +'<div class="app-meta">'+a.votes_per_share+' vote'+(a.votes_per_share!==1?'s':'')+'/share'+(isConv?'':' · '+a.shares.toLocaleString()+' shares @ '+fmt(a.price))+(a.restricted?' · Restricted':'')+'</div>'
        +'<div class="app-meta">'+a.ts+'</div></div>'
        +'<span class="badge '+(a.status==='approved'?'b-green':a.status==='rejected'?'b-red':'b-amber')+'">'+a.status+'</span></div>';
    }).join('')+'</div>';
  }
  return html;
}
function submitClassAppForm(parentTicker){
  const clsType=document.getElementById('cls-type')?.value;
  const votes=document.getElementById('cls-votes')?.value;
  const price=document.getElementById('cls-price')?.value;
  const shares=document.getElementById('cls-shares')?.value;
  const restrictedVal=document.getElementById('cls-restricted')?.value;
  const restricted=restrictedVal==='yes';
  const whitelistEl=document.getElementById('cls-whitelist');
  const whitelist=restricted&&whitelistEl?Array.from(whitelistEl.selectedOptions).map(o=>o.value):[];
  const reason=document.getElementById('cls-reason')?.value;
  submitClassApplication(parentTicker,clsType,votes,shares,price,restricted,whitelist,reason);
}
// Toggle whitelist UI
function previewLogo(input){
  const file=input.files[0];if(!file)return;
  if(file.size>500000){toast('Image too large — please use under 500KB');input.value='';return;}
  const reader=new FileReader();
  reader.onload=e=>{
    const p=document.getElementById('logo-preview');
    if(p)p.innerHTML='<img src="'+e.target.result+'" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid var(--border);margin-top:4px">';
    window._pendingLogo=e.target.result;
  };
  reader.readAsDataURL(file);
}
async function saveLogo(){
  const logo=window._pendingLogo;if(!logo)return toast('Select an image first');
  const u=cu();const co=DB.companies.find(c=>c.owner_id===u.id);if(!co)return;
  // Runs server-side (rpc_save_company_logo), re-checking ownership.
  try{await sb.rpc('rpc_save_company_logo',{p_ticker:co.ticker,p_logo:logo});}
  catch(e){return toast(rpcErrorMessage(e));}
  co.logo=logo;
  window._pendingLogo=null;
  toast('Logo saved');render();
}
document.addEventListener('change',function(e){
  if(e.target&&e.target.id==='cls-restricted'){
    const wrap=document.getElementById('cls-whitelist-wrap');
    if(wrap)wrap.style.display=e.target.value==='yes'?'':'none';
  }
  if(e.target&&e.target.id==='conv-restricted'){
    const wrap=document.getElementById('conv-whitelist-wrap');
    if(wrap)wrap.style.display=e.target.value==='yes'?'':'none';
  }
});

function renderCompanyVotesTab(co){
  const u=cu();
  const myVotes=DB.votes.filter(v=>v.parent_ticker===co.ticker);
  return '<div class="card"><div class="section-title">Post a shareholder vote</div>'
    +'<div class="ibox ibox-purple">Students vote weighted by shares × votes-per-share across all your share classes.</div>'
    +'<div class="frow"><label class="flabel">Question</label><input type="text" id="vote-q" placeholder="e.g. Should we expand to renewable energy?"></div>'
    +'<div class="grid2" style="margin-bottom:12px">'
    +'<div class="frow" style="margin-bottom:0"><label class="flabel">Option A</label><input type="text" id="vote-a" placeholder="Yes" value="Yes"></div>'
    +'<div class="frow" style="margin-bottom:0"><label class="flabel">Option B</label><input type="text" id="vote-b" placeholder="No" value="No"></div>'
    +'</div>'
    +'<div class="frow"><label class="flabel">Closing date/time (optional, informational)</label><input type="text" id="vote-closes" placeholder="e.g. Friday 3pm"></div>'
    +'<button class="btn btn-primary" onclick="postVoteForm(&quot;'+co.ticker+'&quot;)">Post vote</button>'
    +'</div>'
    +(myVotes.length?'<div class="section-title" style="margin-bottom:10px">Active & past votes</div>'+myVotes.map(v=>renderVoteCard(v,true,false)).join('')
    :'<div class="card"><div class="empty">No votes posted yet.</div></div>')+
  // Show closed vote results
  (()=>{const closed=myVotes.filter(v=>v.status==='closed');if(!closed.length)return'';
    return'<div class="card"><div class="section-title">📊 Vote results</div>'+closed.map(v=>{
      const ballots=DB.ballots.filter(b=>b.vote_id===v.id);
      const opts={};[v.option1,v.option2].filter(Boolean).forEach(o=>{opts[o]=0;});
      ballots.forEach(b=>{if(opts[b.choice]!==undefined)opts[b.choice]+=(b.weight||1);});
      const total=Object.values(opts).reduce((s,n)=>s+n,0);
      const winner=Object.entries(opts).sort((a,b)=>b[1]-a[1])[0];
      return'<div style="padding:10px 0;border-bottom:1px solid var(--border)"><div style="font-weight:500;margin-bottom:8px">'+esc(v.question)+'</div>'
        +Object.entries(opts).map(([opt,votes])=>{const pct=total>0?Math.round(votes/total*100):0;const win=opt===winner?.[0];
          return'<div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span '+(win?'style="font-weight:600;color:var(--green)"':'')+'>'+esc(opt)+(win?' ✓':'')+'</span><span style="color:var(--text2)">'+votes+' ('+pct+'%)</span></div>'
          +'<div style="background:var(--bg3);border-radius:3px;height:8px"><div style="background:'+(win?'var(--green)':'var(--blue)')+';width:'+pct+'%;height:100%;border-radius:3px"></div></div></div>';}).join('')+'</div>';
    }).join('')+'</div>';})();
}

function renderCompanyNewsTab(co,myNews){
  return`<div class="card"><div class="section-title">Post a news update</div>
    <div class="frow"><label class="flabel">Headline</label><input type="text" id="news-headline" placeholder="e.g. Q2 results exceed expectations" maxlength="120"></div>
    <div class="frow"><label class="flabel">Body (optional)</label><textarea id="news-body" rows="3" placeholder="Add more detail here..."></textarea></div>
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:8px;cursor:pointer"><input type="checkbox" id="news-notify"> Notify all shareholders</label>
    <button class="btn btn-primary" onclick="postNews('${co.ticker}',get('news-headline')?.value,get('news-body')?.value)">Post news</button>
  </div>
  ${myNews.length?`<div class="card"><div class="section-title">Your posts</div>
    ${myNews.map(n=>`<div class="news-item">
      <div class="news-headline">${esc(n.headline)}</div>
      ${n.body?`<div class="news-body">${esc(n.body||"")}</div>`:''}
      <div class="news-meta" style="justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px"><span class="news-ticker">${n.ticker}</span><span>${n.ts||''}</span></div>
        <button class="btn btn-sm btn-danger" onclick="deleteNews('${n.id}')">Delete</button>
      </div>
    </div>`).join('')}</div>`:'<div class="card"><div class="empty">No news posted yet. Use the form above to post your first update.</div></div>'}`;
}

// Also render the company News tab from nav (non-mystock view)
function renderNewsPage(){
  const u=cu();
  const co=DB.companies.find(c=>c.owner_id===u.id);
  if(!co)return`<div class="card"><div class="empty">You need a listed company to post news.<br><br><button class="btn btn-primary" onclick="setTab('mystock')">Apply for IPO</button></div></div>`;
  const myNews=DB.news.filter(n=>n.ticker===co.ticker);
  return renderCompanyNewsTab(co,myNews);
}


function renderDivTab(co,myDivs){
  const owner=cu();
  const allT=getCompanyTickers(co.ticker);
  const totalCirc=allT.reduce((s,t)=>{const c=getCo(t);return s+(c?c.shares-c.shares_avail:0);},0);
  // Fetch fresh holders async and populate
  sb.get('jex_users','role=eq.student&status=eq.approved&select='+JEX_USERS_SAFE_SELECT).then(freshUsers=>{
    freshUsers.forEach(fu=>{const local=getUser(fu.id);if(local)Object.assign(local,fu);else DB.users.push(fu);});
    const freshSh=freshUsers.filter(s=>allT.some(t=>s.holdings&&(s.holdings[t]||0)>0));
    const el=document.getElementById('div-sh-count');if(el)el.textContent=freshSh.length;
    const form=document.getElementById('div-form');
    if(form){
      if(freshSh.length){
        form.innerHTML=`<div class="frow"><label class="flabel">Dividend per share ($)</label><input type="number" id="div-ps" placeholder="e.g. 0.50" min="0.01" step="0.01" oninput="updateDivPrev('${co.ticker}')"></div><div id="div-prev"></div><div class="frow" style="margin-top:10px"><label class="flabel">Note to investors</label><input type="text" id="div-note" placeholder="e.g. Q1 earnings dividend"></div><button class="btn btn-success" onclick="issueDividend('${co.ticker}',get('div-ps')?.value,get('div-note')?.value)">Pay dividend now</button>`;
      } else {
        form.innerHTML='<div class="empty">No shareholders yet.</div>';
      }
    }
  }).catch(()=>{});
  return`<div class="card"><div class="section-title">Pay a dividend${infoBubble('A dividend is a cash payment your company makes to its shareholders, split proportionally by how many shares each person holds. It comes out of the company account cash, not from thin air.')}</div>
    <div class="ibox ibox-teal">Paid from company cash (raised at IPO) to all shareholders. Company cash grows when investors buy shares; dividends reduce it.</div>
    <div class="grid3"><div class="mcard"><div class="mlabel">Company cash</div><div class="mval" style="font-family:var(--mono)">${fmt(owner.cash)}</div></div>
    <div class="mcard"><div class="mlabel">Shareholders</div><div class="mval" id="div-sh-count">loading...</div></div>
    <div class="mcard"><div class="mlabel">In circulation</div><div class="mval">${totalCirc.toLocaleString()}</div></div></div>
    <div id="div-form"><div style="font-size:12px;color:var(--text2);padding:8px 0">Loading shareholders...</div></div>
  </div>${myDivs.length?`<div class="card"><div class="section-title">History</div><table><thead><tr><th>Time</th><th>Per share</th><th>Total</th><th>Recipients</th><th>Note</th></tr></thead><tbody>${myDivs.map(d=>`<tr><td style="color:var(--text2)">${d.ts}</td><td style="font-family:var(--mono)">${fmt(d.per_share)}</td><td style="color:var(--green);font-family:var(--mono)">${fmt(d.total)}</td><td>${(d.payouts||[]).length}</td><td style="font-size:12px;color:var(--text2)">${esc(d.note)}</td></tr>`).join('')}</tbody></table></div>`:''}`;
}
function updateDivPrev(ticker){const co=getCo(ticker);if(!co)return;const ps=parseFloat(get('div-ps')?.value)||0,p=get('div-prev');if(!p)return;if(ps<=0){p.innerHTML='';return;}
  // Use fresh students from DB for preview (may be stale but better than nothing)
  const allT=getCompanyTickers(ticker);
  const freshSh=DB.users.filter(u=>u.role==='student'&&allT.some(t=>u.holdings&&(u.holdings[t]||0)>0));
  const sh=freshSh;
  const total=sh.reduce((s,u)=>s+allT.reduce((ts,t)=>ts+Math.round(((u.holdings&&u.holdings[t])||0)*ps*100)/100,0),0);
  const owner=cu(),ok=owner.cash>=total;p.innerHTML=`<div style="font-size:12px;padding:10px;background:var(--bg3);border-radius:var(--radius);margin-top:6px"><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:6px"><div><div style="color:var(--text2);margin-bottom:2px">Shareholders</div><div style="font-weight:500">${sh.length}</div></div><div><div style="color:var(--text2);margin-bottom:2px">Total</div><div style="color:var(--green);font-family:var(--mono)">${fmt(total)}</div></div><div><div style="color:var(--text2);margin-bottom:2px">After</div><div style="font-family:var(--mono);color:${ok?'var(--text)':'var(--red)'}">${fmt(owner.cash-total)}</div></div></div>${!ok?`<div style="color:var(--red);font-weight:500">Insufficient funds</div>`:''}</div>`;}
function renderFinancialsHistory(financials){
  if(!financials||!financials.length)return'<div class="card"><div class="empty">No financial reports posted yet.</div></div>';
  return financials.map(f=>`<div class="card" style="margin-bottom:10px"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><div class="section-title" style="margin-bottom:0">${esc(f.period)}</div><span style="font-size:11px;color:var(--text2)">${f.ts}</span></div><div class="grid3" style="margin-bottom:8px"><div class="mcard"><div class="mlabel">Revenue</div><div class="mval" style="font-family:var(--mono)">${fmt(f.revenue)}</div></div><div class="mcard"><div class="mlabel">Profit</div><div class="mval" style="font-family:var(--mono);color:${f.profit>=0?'var(--green)':'var(--red)'}">${fmt(f.profit)}</div></div><div class="mcard"><div class="mlabel">Margin</div><div class="mval" style="font-family:var(--mono)">${f.revenue>0?Math.round(f.profit/f.revenue*100)+'%':'—'}</div></div></div><div style="font-size:13px;color:var(--text2)">${esc(f.summary)}</div></div>`).join('');
}
function renderFinancialsMgmtTab(co,myFinancials){
  return`<div class="card"><div class="section-title">Post financial results</div><div class="ibox ibox-blue" style="margin-bottom:12px">Give investors something to evaluate before an IPO, dilution round, or just to build confidence in the stock. Posted reports notify all current shareholders.</div><div class="frow"><label class="flabel">Period</label><input type="text" id="fin-period" placeholder="e.g. Q1 2026"></div><div class="row"><div class="frow" style="flex:1"><label class="flabel">Revenue ($)</label><input type="number" id="fin-revenue" placeholder="10000" min="0" step="0.01"></div><div class="frow" style="flex:1"><label class="flabel">Profit ($, negative for a loss)</label><input type="number" id="fin-profit" placeholder="2500" step="0.01"></div></div><div class="frow"><label class="flabel">Summary for investors</label><textarea id="fin-summary" rows="3" placeholder="e.g. Revenue grew 20% quarter over quarter driven by..."></textarea></div><button class="btn btn-primary" onclick="postFinancials('${co.ticker}',get('fin-period')?.value,get('fin-revenue')?.value,get('fin-profit')?.value,get('fin-summary')?.value)">Post report</button></div><div class="section-title" style="margin:16px 0 8px">History</div>${renderFinancialsHistory(myFinancials)}`;
}
function renderBBTab(co,myBBs){
  const sold=co.shares-co.shares_avail,owner=cu();
  return`<div class="card"><div class="section-title">Share buyback${infoBubble('The company repurchases its own outstanding shares using its cash. This permanently retires the shares (they do not go back into the pool of shares available to buy) and reduces the total share count.')}</div><div class="grid3"><div class="mcard"><div class="mlabel">Company cash</div><div class="mval" style="font-family:var(--mono)">${fmt(owner.cash)}</div></div><div class="mcard"><div class="mlabel">In circulation</div><div class="mval">${sold.toLocaleString()}</div></div><div class="mcard"><div class="mlabel">Current price</div><div class="mval" style="font-family:var(--mono)">${fmt(co.price)}</div></div></div>${sold>0?`<div class="row" style="align-items:flex-end"><div class="frow" style="flex:1"><label class="flabel">Shares to buy back</label><input type="number" id="bb-qty" placeholder="50" min="1" max="${sold}" oninput="updateBBPrev('${co.ticker}')"></div><div style="padding-bottom:12px"><button class="btn btn-primary" onclick="doBuyback('${co.ticker}',get('bb-qty')?.value)">Buy back</button></div></div><div id="bb-prev"></div>`:'<div class="empty">No shares in circulation.</div>'}</div>${myBBs.length?`<div class="card"><div class="section-title">History</div><table><thead><tr><th>Time</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${myBBs.map(b=>`<tr><td style="color:var(--text2)">${b.ts}</td><td>${b.qty}</td><td style="font-family:var(--mono)">${fmt(b.price)}</td><td style="font-weight:500;font-family:var(--mono)">${fmt(b.total)}</td></tr>`).join('')}</tbody></table></div>`:''}`;
}
function updateBBPrev(ticker){const co=getCo(ticker);if(!co)return;const q=parseInt(get('bb-qty')?.value)||0;const p=get('bb-prev');if(p)p.innerHTML=q>0?impactPreview(co,q,'buy'):'';}
function renderDilTab(co){
  // Get all tickers for this company: base + classes
  const allTickers=getCompanyTickers(co.ticker);
  let html='<div class="ibox ibox-blue">Dilution'+infoBubble('Dilution means issuing new shares of your company. It raises new capital, but each existing share now represents a smaller slice of the company, so the price adjusts down proportionally when new shares are approved.')+' issues new shares to raise capital. Requires Chairman approval.</div>';
  allTickers.forEach(ticker=>{
    const stock=getCo(ticker);if(!stock)return;
    const meta=getClassMeta(ticker);
    const label=ticker===co.ticker?'<span class="badge b-gray" style="font-family:var(--mono)">'+ticker+'</span> (base stock)'
      :'<span class="badge b-gray" style="font-family:var(--mono)">'+ticker+'</span> <span class="badge b-amber">Class '+meta.class+'</span>';
    const pending=DB.dilApps.find(d=>d.ticker===ticker&&d.status==='pending');
    const history=DB.dilApps.filter(d=>d.ticker===ticker).reverse();
    html+='<div class="card"><div class="section-title">Dilution — '+label+'</div>';
    if(pending){
      html+='<div class="ibox ibox-amber">A dilution application for <strong>'+ticker+'</strong> is pending Chairman approval.</div>';
    } else {
      html+='<div class="grid2" style="margin-bottom:12px">'
        +'<div class="mcard"><div class="mlabel">Current shares</div><div class="mval">'+stock.shares.toLocaleString()+'</div></div>'
        +'<div class="mcard"><div class="mlabel">Current price</div><div class="mval" style="font-family:var(--mono)">'+fmt(stock.price)+'</div></div>'
        +'</div>'
        +'<div class="frow"><label class="flabel">New shares to issue</label><input type="number" id="dil-shares-'+ticker+'" placeholder="200" min="1" oninput="updateDilPrevFor(&quot;'+ticker+'&quot;)"></div>'
        +'<div id="dil-prev-'+ticker+'"></div>'
        +'<div class="frow" style="margin-top:10px"><label class="flabel">Reason</label><textarea id="dil-reason-'+ticker+'" rows="2" placeholder="e.g. Raising capital for expansion..."></textarea></div>'
        +'<button class="btn btn-warning" onclick="submitDilutionFor(&quot;'+ticker+'&quot;)">Submit application</button>';
    }
    if(history.length){
      html+='<hr class="divider"><div class="section-title" style="font-size:13px;margin-bottom:8px">History</div>'
        +'<table><thead><tr><th>Time</th><th>New shares</th><th>+%</th><th>Reason</th><th>Status</th></tr></thead><tbody>'
        +history.map(d=>'<tr><td style="color:var(--text2)">'+d.ts+'</td><td>+'+d.new_shares.toLocaleString()+'</td><td style="color:var(--amber)">+'+d.pct_increase+'%</td><td style="font-size:12px">'+d.reason+'</td><td><span class="badge '+(d.status==='approved'?'b-green':d.status==='rejected'?'b-red':'b-amber')+'">'+d.status+'</span></td></tr>').join('')
        +'</tbody></table>';
    }
    html+='</div>';
  });
  return html;
}
function updateDilPrevFor(ticker){
  const co=getCo(ticker);if(!co)return;
  const ns=parseInt(document.getElementById('dil-shares-'+ticker)?.value)||0;
  const p=document.getElementById('dil-prev-'+ticker);
  if(p)p.innerHTML=dilPreview(co,ns);
}
function submitDilutionFor(ticker){
  const newShares=document.getElementById('dil-shares-'+ticker)?.value;
  const reason=document.getElementById('dil-reason-'+ticker)?.value;
  submitDilution(ticker,newShares,reason);
}

// ═══════════════════════════════════════════════
// RENDER: ADMIN
// ═══════════════════════════════════════════════
function renderAdmin(){
  const u=cu();
  // renderNav() only ever showed the "Admin" nav button to admin roles, so
  // this had no check of its own -- any other caller fell through the tab
  // ternary below into the secretary/treasurer tab set by default, showing
  // real student balances and org-wide activity to whoever reached this
  // function. That was already reachable from devtools (UI.navTab='admin'
  // is just a global var), but admin.html turns it into a page anyone can
  // type into the address bar, so it needs its own real check now.
  if(!isAdmin(u))return'<div class="card"><div class="empty">Admin access required.</div></div>';
  const chair=isChairman(u);
  const students=DB.users.filter(u=>u.role==='student'&&u.status==='approved');
  const companies=DB.users.filter(u=>u.role==='company'&&u.status==='approved');
  const pIPO=DB.ipoApps.filter(a=>a.status==='pending'),rIPO=DB.ipoApps.filter(a=>a.status!=='pending');
  const pDil=DB.dilApps.filter(d=>d.status==='pending'),rDil=DB.dilApps.filter(d=>d.status!=='pending');
  const pS=DB.pending.filter(r=>r.role==='student'),pC=DB.pending.filter(r=>r.role==='company');

  const openFlags=(DB.flags||[]).filter(f=>f.status==='open').length;
  const openBugReports=(DB.bugReports||[]).filter(b=>b.status==='open').length;
  const openMessages=(DB.contactMessages||[]).filter(m=>m.status==='open').length;
  const messagesTabEntry=['messages',openMessages?'Messages <span class="badge b-red">'+openMessages+'</span>':'Messages'];
  const errorCount=(DB.clientErrors||[]).length;
  const clientErrorsTabEntry=['client_errors',errorCount?'Errors <span class="badge b-red">'+errorCount+'</span>':'Errors'];
  // President can only see: session, balances, passwords
  const presidentTabs=[['dashboard','Dashboard'],['session','Session'],['announcements','Announcements'],['balances','Balances'],['passwords','Reset passwords'],['news','News'],['activity','Activity log']];
  const secretaryTabs=[['announcements','Announcements'],['minutes','Minutes'],['notices','Official notices'],['shareholders','Shareholder registry'],['votes_all','Vote oversight'],['news','News'],messagesTabEntry];
  const sectreTabs=u.role==='secretary'?secretaryTabs:[['announcements','Announcements'],['balances','Balances'],['news','News'],['activity','Activity log'],messagesTabEntry];
  const complianceTabs=[['dashboard','Dashboard'],['balances','Balances'],['trades','All trades'],['activity','Activity log'],['listed','Listed'],['news','News'],['announcements','Announcements'],['flags','Flags'],messagesTabEntry,clientErrorsTabEntry];
  const chairmanTabs=[['dashboard','Dashboard'],['session','Session'],['announcements','Announcements'],['registrations','Registrations'],['passwords','Reset passwords'],['ipo','IPO'],['dilution','Dilution'],['classes','Share classes'],['founder_allocs','Founder shares'],['balances','Balances'],['users','Users'],['listed','Listed'],['news','News'],['activity','Activity log'],['flags',openFlags?'Flags <span class="badge b-red">'+openFlags+'</span>':'Flags'],['bug_reports',openBugReports?'Bug reports <span class="badge b-red">'+openBugReports+'</span>':'Bug reports'],messagesTabEntry,['snapshots','Snapshots'],clientErrorsTabEntry];
  const treasurerTabs=[['balances','Balances'],['cashflow','Cash flow'],['dividends_audit','Dividend audit'],['price_adj_log','Price adjustments'],['budget_warnings','Budget warnings'],['activity','Activity log'],messagesTabEntry,clientErrorsTabEntry];
  const tabs=(chair||isPresident(u))?chairmanTabs:u.role==='compliance_officer'?complianceTabs:u.role==='treasurer'?treasurerTabs:sectreTabs;
  const allowedTabs=tabs.map(([k])=>k);
  if(!allowedTabs.includes(UI.adminTab))UI.adminTab=tabs[0][0];

  return`<div class="tab-row">${tabs.map(([k,v])=>`<button class="tab ${UI.adminTab===k?'active':''}" onclick="UI.adminTab='${k}';render()">${v}${k==='registrations'&&DB.pending.length?` <span class="badge b-blue" style="margin-left:4px">${DB.pending.length}</span>`:''} ${k==='ipo'&&pIPO.length?`<span class="badge b-amber" style="margin-left:4px">${pIPO.length}</span>`:''} ${k==='dilution'&&pDil.length?`<span class="badge b-coral" style="margin-left:4px">${pDil.length}</span>`:''}</button>`).join('')}</div>
  ${UI.adminTab==='session'?renderAdminSession(students)
  :UI.adminTab==='registrations'?renderAdminRegs(pS,pC,students,companies)
  :UI.adminTab==='passwords'?renderAdminPasswords(students,companies)
  :UI.adminTab==='ipo'?renderAdminIPO(pIPO,rIPO)
  :UI.adminTab==='dilution'?renderAdminDilution(pDil,rDil)
  :UI.adminTab==='balances'?renderAdminBalances(students)
  :UI.adminTab==='users'?renderAdminUsers(students,companies,DB.users.filter(u2=>['secretary','treasurer','compliance_officer'].includes(u2.role)&&u2.status==='approved'),DB.users.filter(u2=>['chairman','president'].includes(u2.role)&&u2.status==='approved'))
  :UI.adminTab==='dashboard'?renderAdminDashboard()
  :UI.adminTab==='flags'?renderAdminFlags()
  :UI.adminTab==='bug_reports'?renderAdminBugReports()
  :UI.adminTab==='client_errors'?renderAdminClientErrors()
  :UI.adminTab==='messages'?renderAdminMessages()
  :UI.adminTab==='snapshots'?renderSnapshotTab()
  :UI.adminTab==='minutes'?renderAdminMinutes()
  :UI.adminTab==='notices'?renderAdminOfficialNotices()
  :UI.adminTab==='shareholders'?renderAdminShareholderRegistry()
  :UI.adminTab==='votes_all'?renderAdminVoteOversight()
  :UI.adminTab==='cashflow'?renderTreasurerCashFlow()
  :UI.adminTab==='dividends_audit'?renderTreasurerDividendAudit()
  :UI.adminTab==='price_adj_log'?renderTreasurerPriceLog()
  :UI.adminTab==='budget_warnings'?renderTreasurerBudgetWarnings()
  :UI.adminTab==='founder_allocs'?renderAdminFounderAllocs()
  :UI.adminTab==='news'?renderAdminNews()
  :UI.adminTab==='announcements'?renderAdminAnnouncements()
  :UI.adminTab==='classes'?renderAdminClasses()
  :UI.adminTab==='activity'?renderActivityLog()
  :renderAdminListed()}`;
}

function renderWeeklySchedule(){
  const ws=DB.session.weekly_schedule||{};
  const today=WEEKDAY_KEYS[getAZTime().getDay()];
  return `<div class="section-title" style="font-size:13px;margin-bottom:6px">Weekly schedule</div>
    <div class="ibox ibox-purple" style="margin-bottom:12px">Repeats every week. Enable a day and set its open/close time (Arizona time) — trading will open and close automatically on that schedule, no need to reset it each day. A manual Pause/Close overrides the schedule until its window ends.</div>
    ${WEEKDAY_KEYS.map(day=>{
      const d=ws[day]||{enabled:false,open:{h:16,m:0},close:{h:18,m:30}};
      return `<div class="wk-row ${day===today?'wk-today':''}">
        <label class="wk-daylabel"><input type="checkbox" id="wk-${day}-on" ${d.enabled?'checked':''}> <span>${WEEKDAY_LABELS[day]}</span></label>
        <div class="wk-times">
          <input type="time" id="wk-${day}-open" value="${pad(d.open.h)}:${pad(d.open.m)}" title="Open time">
          <span class="wk-to">to</span>
          <input type="time" id="wk-${day}-close" value="${pad(d.close.h)}:${pad(d.close.m)}" title="Close time">
        </div>
        ${day===today?'<span class="badge b-purple wk-todaybadge">today</span>':''}
      </div>`;
    }).join('')}
    <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="saveWeeklySchedule()">Save weekly schedule</button>
    ${DB.session.weekly_active?'<div class="ibox ibox-green" style="margin-top:10px">🟢 Currently open via the weekly schedule</div>':''}
    ${DB.session.weekly_override?'<div class="ibox ibox-amber" style="margin-top:10px">⏸ Manually overridden for the rest of today\'s window</div>':''}`;
}
function renderAdminSession(students){
  const az=getAZTime(),sched=DB.session.scheduled_close;
  return`<div class="card"><div class="section-title">Session control</div>
    <div class="grid3" style="margin-bottom:14px"><div class="mcard"><div class="mlabel">Status</div><div class="mval">${DB.session.status}</div></div><div class="mcard"><div class="mlabel">Time remaining</div><div class="mval" id="admin-timer-txt">${DB.session.ends_at?Math.max(0,Math.round((DB.session.ends_at-Date.now())/1000))+'s':'—'}</div></div><div class="mcard"><div class="mlabel">Active students</div><div class="mval">${students.length}</div></div></div>
    <div class="ibox ibox-blue" style="margin-bottom:14px">Arizona time (MST, UTC−7): <strong style="font-family:var(--mono)">${fmtAZTime(az)}</strong><br><span style="font-size:11px;opacity:0.8">Arizona does not observe Daylight Saving Time.</span></div>
    <div class="divider"></div>
    <div class="section-title" style="font-size:13px;margin-bottom:10px">Schedule trading hours (MST)</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px">
      <div><label class="flabel">Open time (24h)</label><div style="display:flex;gap:8px;align-items:center"><input type="number" id="sched-start-h" placeholder="HH" min="0" max="23" value="${DB.session.scheduled_open?pad(DB.session.scheduled_open.h):'8'}" style="width:60px"><span style="color:var(--text2);font-weight:500">:</span><input type="number" id="sched-start-m" placeholder="MM" min="0" max="59" value="${DB.session.scheduled_open?pad(DB.session.scheduled_open.m):'0'}" style="width:60px"></div></div>
      <div><label class="flabel">Close time (24h)</label><div style="display:flex;gap:8px;align-items:center"><input type="number" id="sched-end-h" placeholder="HH" min="0" max="23" value="${sched?pad(sched.h):'15'}" style="width:60px"><span style="color:var(--text2);font-weight:500">:</span><input type="number" id="sched-end-m" placeholder="MM" min="0" max="59" value="${sched?pad(sched.m):'0'}" style="width:60px"></div></div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:14px"><button class="btn btn-primary" onclick="scheduleSession()">Set schedule</button><button class="btn" onclick="clearSchedule()">Clear schedule</button></div>
    ${DB.session.scheduled_open||DB.session.scheduled_close?`<div class="ibox ibox-teal" style="margin-bottom:14px">Scheduled: ${DB.session.scheduled_open?pad(DB.session.scheduled_open.h)+':'+pad(DB.session.scheduled_open.m)+' – ':''}${sched?pad(sched.h)+':'+pad(sched.m):''} MST</div>`:''}
    <div class="divider"></div>
    ${renderWeeklySchedule()}
    <div class="divider"></div>
    <div class="section-title" style="font-size:13px;margin-bottom:10px">Circuit breakers</div>
    <div class="ibox ibox-blue" style="margin-bottom:10px">If any stock moves this % from its session-open price, trading is auto-halted for 5 minutes.</div>
    <div class="row" style="align-items:flex-end;margin-bottom:14px">
      <div class="frow" style="flex:1"><label class="flabel">Trigger threshold (%)</label><input type="number" id="cb-pct" value="${DB.session.circuit_breaker_pct||20}" min="1" max="100" step="1"></div>
      <div style="padding-bottom:12px"><button class="btn btn-primary" onclick="saveCBPct()">Save</button></div>
      <div style="padding-bottom:12px;margin-left:4px"><button class="btn" onclick="saveSession({circuit_breaker_pct:null}).then(()=>toast('Circuit breakers disabled'))">Disable</button></div>
    </div>
    ${DB.session.circuit_breaker_pct?`<div style="font-size:12px;color:var(--text2);margin-bottom:4px">Active — halts if any stock moves ±${DB.session.circuit_breaker_pct}% from open</div>`:'<div style="font-size:12px;color:var(--text2);margin-bottom:4px">Circuit breakers disabled</div>'}
    <div class="divider"></div>
    <div class="section-title" style="font-size:13px;margin-bottom:10px">Price bands</div>
    <div class="ibox ibox-blue" style="margin-bottom:10px">Orders outside ±this% of the session-open price are rejected. Prevents accidental price collapses.</div>
    <div class="row" style="align-items:flex-end;margin-bottom:10px">
      <div class="frow" style="flex:1"><label class="flabel">Price band (% from session open)</label><input type="number" id="band-pct" value="${DB.session.price_band_pct||30}" min="1" max="100" step="1"></div>
      <div style="padding-bottom:12px"><button class="btn btn-primary" onclick="savePriceBand()">Save</button></div>
      <div style="padding-bottom:12px;margin-left:4px"><button class="btn" onclick="saveSession({price_band_pct:null}).then(()=>toast('Price bands disabled'))">Disable</button></div>
    </div>
    ${DB.session.price_band_pct?`<div style="font-size:12px;color:var(--text2);margin-bottom:4px">Active — orders must be within ±${DB.session.price_band_pct}% of session-open price</div>`:'<div style="font-size:12px;color:var(--text2);margin-bottom:4px">Price bands disabled</div>'}
    <div class="divider"></div>
    <div class="section-title" style="font-size:13px;margin-bottom:10px">Manual countdown timer</div>
    <div class="row" style="align-items:flex-end;margin-bottom:14px"><div class="frow" style="flex:1"><label class="flabel">Duration (minutes)</label><input type="number" id="sess-mins" value="10" min="1" max="120"></div><div style="padding-bottom:12px"><button class="btn btn-success" onclick="startTimer(parseInt(get('sess-mins').value)||10)">Start timer</button></div></div>
    <div class="divider"></div>
    <div class="section-title" style="font-size:13px;margin-bottom:10px">Manual override</div>
    ${isChairman(cu())?`<div style="display:flex;gap:8px"><button class="btn btn-success" onclick="setSession('open')">Open now</button><button class="btn btn-warning" onclick="setSession('paused')">Pause</button><button class="btn btn-danger" onclick="setSession('closed')">Close now</button></div>`:`<div class="ibox ibox-blue">Only the Chairman or President can open, pause, or close trading.</div>`}
    <div class="divider"></div>
    <div class="section-title" style="font-size:13px;margin-bottom:10px">Stock halts</div>
    ${DB.halts.length?`<div style="margin-bottom:10px">${DB.halts.map(h=>`<div class="app-row" style="margin-bottom:6px"><div class="app-info"><div class="app-name"><span class="badge b-gray" style="font-family:var(--mono)">${h.ticker}</span> <span class="badge b-red">Halted</span></div><div class="app-meta">${esc(h.reason)} — by ${esc(h.halted_by)} at ${h.ts}</div></div><button class="btn btn-sm btn-success" onclick="resumeStock('${h.ticker}')">Resume</button></div>`).join('')}</div>`:'<div style="font-size:12px;color:var(--text2);margin-bottom:10px">No stocks currently halted.</div>'}
    <div class="row" style="align-items:flex-end">
      <div class="frow" style="flex:1"><label class="flabel">Halt a stock</label>
        <select id="halt-ticker"><option value="">— Select ticker —</option>${DB.companies.map(c=>`<option value="${esc(c.ticker)}">${esc(c.ticker)} — ${esc(c.name)}</option>`).join('')}</select>
      </div>
      <div class="frow" style="flex:2"><label class="flabel">Reason</label><input type="text" id="halt-reason" placeholder="e.g. Suspected market manipulation"></div>
      <div style="padding-bottom:12px"><button class="btn btn-danger" onclick="haltStock(get('halt-ticker')?.value,get('halt-reason')?.value)">Halt</button></div>
    </div>
    <div class="divider"></div>
    <div class="section-title" style="font-size:13px;margin-bottom:10px">Order rate limit</div>
    <div class="ibox ibox-blue" style="margin-bottom:10px">Max orders/min (default: 10). Also enforces 0.8s minimum between orders and a burst limit of 3 per 5 seconds. Buttons disable briefly after each trade.</div>
    <div class="row" style="align-items:flex-end;margin-bottom:14px">
      <div class="frow" style="flex:1"><label class="flabel">Orders per minute per student</label><input type="number" id="rate-limit" value="${DB.session.order_rate_limit||10}" min="1" max="60" step="1"></div>
      <div style="padding-bottom:12px"><button class="btn btn-primary" onclick="saveSession({order_rate_limit:parseInt(get('rate-limit')?.value)||10}).then(()=>toast('Rate limit updated'))">Save</button></div>
    </div>
    <div class="divider"></div>
    <div class="section-title" style="font-size:13px;margin-bottom:10px">Treasurer thresholds</div>
    <div class="ibox ibox-blue" style="margin-bottom:10px">These defaults can be changed by Chairman or President. Treasurer can also adjust them from Budget warnings.</div>
    <div class="grid2" style="margin-bottom:12px">
      <div><label class="flabel">Low cash warning ($)</label>
        <div class="row" style="align-items:flex-end">
          <input type="number" id="bw-threshold-session" value="${DB.session.budget_warning_threshold||500}" min="0" step="100" style="flex:1">
          <button class="btn btn-sm btn-primary" onclick="saveBudgetThresholdFrom('bw-threshold-session')">Save</button>
        </div>
      </div>
      <div><label class="flabel">Dividend approval required above ($)</label>
        <div class="row" style="align-items:flex-end">
          <input type="number" id="div-threshold-session" value="${DB.session.dividend_approval_threshold||1000}" min="0" step="100" style="flex:1">
          <button class="btn btn-sm btn-primary" onclick="saveDivThresholdFrom('div-threshold-session')">Save</button>
        </div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="section-title" style="font-size:13px;margin-bottom:10px">🏫 Classroom management</div>
    <div class="ibox ibox-blue" style="margin-bottom:12px">Classrooms are just a way of organizing which students and companies belong together — they don't restrict trading times. Cross-classroom trading is always allowed and display only.</div>

    ${DB.classrooms.length?`<div style="margin-bottom:12px">
      ${DB.classrooms.map(cls=>{
        const isShowing=UI.classroomFilter===cls.id;
        const members=DB.users.filter(u=>u.classroom_id===cls.id&&!isAdmin(u));
        return`<div style="padding:8px;background:var(--bg3);border-radius:var(--radius);margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1">
              <div style="font-weight:500">${esc(cls.name)}</div>
              <div style="font-size:11px;color:var(--text2)">${DB.users.filter(u=>u.classroom_id===cls.id&&u.role==='student').length} students · ${DB.users.filter(u=>u.classroom_id===cls.id&&u.role==='company').length} companies</div>
            </div>
            <button class="btn btn-sm" style="color:var(--text2)" onclick="UI.classroomFilter=UI.classroomFilter===&quot;${cls.id}&quot;?null:&quot;${cls.id}&quot;;render()">${isShowing?'Hide':'View members'}</button>
            <button class="btn btn-sm btn-danger" onclick="deleteClassroom('${cls.id}')">✕</button>
          </div>
          ${isShowing?`<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">${members.length?members.map(u=>`<div style="font-size:12px;color:var(--text2);padding:3px 0">${esc(u.name)} <span style="opacity:0.7">[${u.role}]</span></div>`).join(''):'<div style="font-size:12px;color:var(--text2)">No members yet</div>'}</div>`:''}
        </div>`;
      }).join('')}
    </div>`:'<div style="font-size:12px;color:var(--text2);margin-bottom:12px">No classrooms yet</div>'}

    <div class="section-title" style="font-size:12px;margin-bottom:8px">Add classroom</div>
    <div class="row" style="align-items:flex-end;gap:8px">
      <div class="frow" style="flex:1;margin-bottom:0"><label class="flabel">Classroom name</label><input type="text" id="cls-name" placeholder="e.g. Period 1"></div>
      <div><button class="btn btn-primary btn-sm" onclick="createClassroom()">+ Add classroom</button></div>
    </div>

    <div class="divider" style="margin:14px 0"></div>
    <div class="section-title" style="font-size:12px;margin-bottom:8px">Assign user / company to classroom</div>
    <div class="row" style="align-items:flex-end;gap:8px;flex-wrap:wrap">
      <div class="frow" style="flex:2;min-width:180px"><label class="flabel">User or company</label>
        <select id="reassign-uid">
          <option value="">— Select —</option>
          ${DB.users.filter(u=>!isAdmin(u)).map(u=>`<option value="${u.id}">${esc(u.name)} [${u.role}] — ${getClassroomName(u.classroom_id)||'unassigned'}</option>`).join('')}
        </select>
      </div>
      <div class="frow" style="flex:2;min-width:150px"><label class="flabel">Assign to classroom</label>
        <select id="reassign-cid-select">
          <option value="">— Unassigned —</option>
          ${DB.classrooms.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div><button class="btn btn-primary btn-sm" onclick="reassignClassroom()">Assign</button></div>
    </div>
    <div class="divider"></div>
    <div class="section-title" style="font-size:13px;margin-bottom:10px">🎮 Practice mode</div>
    <div class="ibox ibox-blue" style="margin-bottom:10px">Starting practice mode automatically saves a snapshot. Ending it automatically restores that snapshot, so cash, holdings, and prices go back to exactly where they were before practice started. Students can see they are in practice mode.</div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <div style="font-size:13px">${DB.session.practice_mode?'<span style="color:var(--amber);font-weight:500">🎮 Practice mode is ON</span>':'Practice mode is off'}</div>
      <button class="btn btn-sm ${DB.session.practice_mode?'btn-warning':'btn-primary'}" onclick="togglePracticeMode()">
        ${DB.session.practice_mode?'End practice mode':'Start practice mode'}
      </button>
    </div>
    <div class="divider"></div>
    <div class="section-title" style="font-size:13px;margin-bottom:6px;color:var(--red)">⚠ Danger zone</div>
    <div class="ibox ibox-red" style="margin-bottom:10px">Resets JEX to a clean slate. Deletes all students, companies, trades, and data. Chairman, President, Secretary, Treasurer and Compliance Officer accounts are kept.</div>
    <button class="btn btn-danger" onclick="resetExchange()">🗑 Reset JEX (full wipe)</button>
  </div>`;
}
function renderAdminRegs(pS,pC,students,companies){
  return`<div class="card">
    ${pS.length?`<div class="section-title">Pending students</div>${pS.map(r=>`<div class="app-row"><div class="app-info"><div class="app-name">${esc(r.name)} <span class="badge b-blue">student</span></div><div class="app-meta">${esc(r.email)} ${r.email_verified?'<span class="badge b-green" style="font-size:9px">✓ verified</span>':'<span class="badge b-gray" style="font-size:9px">not verified</span>'} — ${r.ts}</div></div><div class="btn-row" style="align-items:center"><select id="classroom-${r.id}" style="width:110px;font-size:11px"><option value="">No classroom</option>${DB.classrooms.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><input type="number" id="cash-${r.id}" placeholder="Starting $" value="${DB.session.starting_cash||10000}" min="0" style="width:100px"><button class="btn btn-success btn-sm" onclick="approveReg('${r.id}',get('cash-${r.id}')?.value)">Approve</button><button class="btn btn-danger btn-sm" onclick="rejectReg('${r.id}')">Reject</button></div></div>`).join('')}<hr class="divider">`:''}
    ${pC.length?`<div class="section-title">Pending companies</div>${pC.map(r=>`<div class="app-row"><div class="app-info"><div class="app-name">${esc(r.name)} <span class="badge b-amber">company</span></div><div class="app-meta">${esc(r.email)} ${r.email_verified?'<span class="badge b-green" style="font-size:9px">✓ verified</span>':'<span class="badge b-gray" style="font-size:9px">not verified</span>'} — ${esc(r.description||'')} — ${r.ts}</div></div><div class="btn-row" style="align-items:center"><select id="classroom-${r.id}" style="width:110px;font-size:11px"><option value="">No classroom</option>${DB.classrooms.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><input type="number" id="cash-${r.id}" placeholder="Starting $" value="${DB.session.starting_cash||10000}" min="0" style="width:110px"><button class="btn btn-success btn-sm" onclick="approveReg('${r.id}',get('cash-${r.id}')?.value)">Approve</button><button class="btn btn-danger btn-sm" onclick="rejectReg('${r.id}')">Reject</button></div></div>`).join('')}<hr class="divider">`:''}
    ${!DB.pending.length?`<div class="empty" style="padding:16px">No pending registrations</div><hr class="divider">`:''}
    <div class="section-title" style="margin-top:4px">Approved accounts</div>
    ${[...students,...companies].length?`<table><thead><tr><th>Name</th><th>Role</th><th>Email</th><th class="r">Cash</th></tr></thead><tbody>${[...students,...companies].map(u=>`<tr><td>${esc(u.name)}</td><td>${roleBadge(u.role)}</td><td style="color:var(--text2)">${esc(u.email)}</td><td class="r" style="font-family:var(--mono)">${fmt(u.cash)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No approved accounts yet</div>'}
  </div>`;
}
function renderAdminPasswords(students,companies){
  const u=cu();
  // Officers whose passwords can be reset (not other chairmen/presidents)
  const officers=DB.users.filter(x=>['secretary','treasurer','compliance_officer'].includes(x.role)&&x.status==='approved');
  const resetableUsers=[...students,...companies,...officers];
  return`<div class="card"><div class="section-title">Manual password reset</div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:14px">Use only if a user has forgotten both their password and security answer. Chairman and President cannot reset each other's passwords.</p>
    <div class="frow"><label class="flabel">Select user</label><select id="admin-reset-uid" onchange="renderAdminResetForm()"><option value="">— Select a user —</option>${resetableUsers.map(x=>`<option value="${x.id}">${esc(x.name)}${['secretary','treasurer','compliance_officer'].includes(x.role)?'':' ('+esc(x.email)+')'} — ${esc(x.role)}</option>`).join('')}</select></div>
    <div id="admin-reset-form"></div>
  </div>`;
}
function renderAdminResetForm(){
  const uid2=get('admin-reset-uid')?.value;const form=get('admin-reset-form');if(!form)return;
  if(!uid2){form.innerHTML='';return;}const u=getUser(uid2);if(!u){form.innerHTML='';return;}
  const header=`<div style="font-size:13px;margin-bottom:10px;padding:10px;background:var(--bg3);border-radius:var(--radius)">Resetting: <strong>${esc(u.name)}</strong></div>`;
  if(u.auth_uid||u.auth_provider==='google'){
    // Covers both migrated and Google-linked accounts — either way this uses real
    // Supabase Auth, not the legacy password system, so a direct reset here wouldn't
    // actually change their credential. A reset email works regardless of whether a
    // password already exists (Google accounts can now optionally set one too).
    form.innerHTML=header+`<div class="ibox ibox-blue" style="margin-bottom:10px">This account uses real sign-in, not the legacy password system — a direct reset here wouldn't actually change their credential. Send them a password reset email instead.</div><button class="btn btn-primary" onclick="adminSendResetEmail('${u.id}')">Send password reset email</button>`;
    return;
  }
  form.innerHTML=header+`<div style="font-size:12px;color:var(--text2);margin-bottom:10px">Security question: ${esc(u.sec_q||'—')}</div><div class="frow"><label class="flabel">New password</label><div class="pw-wrap"><input type="password" id="admin-reset-pw" placeholder="New password (min 6 characters)"><button type="button" class="pw-eye" onclick="togglePw('admin-reset-pw')" tabindex="-1">👁</button></div></div><button class="btn btn-primary" onclick="adminResetPw('${u.id}',get('admin-reset-pw')?.value)">Reset password</button>`;
}
function renderAdminIPO(pIPO,rIPO){
  return`<div class="card"><div class="section-title">Pending IPO applications</div>${pIPO.length?pIPO.map(a=>`<div class="app-row"><div class="app-info"><div class="app-name">${esc(a.name)} <span class="badge b-gray" style="font-family:var(--mono)">${esc(a.ticker)}</span></div><div class="app-meta">${a.shares.toLocaleString()} shares @ ${fmt(a.price)} — ${esc(a.description||'no desc')}</div></div><div class="btn-row"><button class="btn btn-success btn-sm" onclick="reviewIPO('${a.id}',true)">Approve</button><button class="btn btn-danger btn-sm" onclick="reviewIPO('${a.id}',false)">Reject</button></div></div>`).join(''):'<div class="empty">No pending IPO applications</div>'}${rIPO.length?`<hr class="divider">${rIPO.map(a=>`<div class="app-row"><div class="app-info"><div class="app-name">${esc(a.name)} <span class="badge b-gray" style="font-family:var(--mono)">${esc(a.ticker)}</span></div></div><span class="badge ${a.status==='approved'?'b-green':'b-red'}">${a.status}</span></div>`).join('')}`:''}`;
}
function renderAdminDilution(pDil,rDil){
  return`<div class="card"><div class="section-title">Pending dilution requests</div>${pDil.length?pDil.map(d=>`<div class="app-row"><div class="app-info"><div class="app-name">${esc(d.company_name)} <span class="badge b-gray" style="font-family:var(--mono)">${d.ticker}</span> <span class="badge b-coral">+${d.pct_increase}%</span></div><div class="app-meta">+${d.new_shares.toLocaleString()} shares — "${esc(d.reason)}"</div></div><div class="btn-row"><button class="btn btn-success btn-sm" onclick="reviewDilution('${d.id}',true)">Approve</button><button class="btn btn-danger btn-sm" onclick="reviewDilution('${d.id}',false)">Reject</button></div></div>`).join(''):'<div class="empty">No pending dilution requests</div>'}${rDil.length?`<hr class="divider">${rDil.map(d=>`<div class="app-row"><div class="app-info"><div class="app-name">${esc(d.company_name)} <span class="badge b-gray" style="font-family:var(--mono)">${d.ticker}</span></div><div class="app-meta">+${d.new_shares.toLocaleString()} shares</div></div><span class="badge ${d.status==='approved'?'b-green':'b-red'}">${d.status}</span></div>`).join('')}`:''}`;
}
function renderAdminBalances(students){
  const rows=students.map(u=>({name:u.name,email:u.email,cash:Math.round(u.cash*100)/100,portfolio:Math.round(pv(u)*100)/100,shortPnl:Math.round(sPnl(u)*100)/100,divs:Math.round(divRec(u)*100)/100,nw:nw(u)})).sort((a,b)=>b.nw-a.nw);
  const csvEscape=v=>{if(v==null)return'';const s=String(v).replace(/\n/g,' ');return s.includes(',')||s.includes('"')?'"'+s.replace(/"/g,'""')+'"':s;};
  const csv=[['Rank','Name','Email','Cash','Portfolio','Short P&L','Dividends','Net worth','vs Start'],...rows.map((r,i)=>[i+1,r.name,r.email,r.cash.toFixed(2),r.portfolio.toFixed(2),r.shortPnl.toFixed(2),r.divs.toFixed(2),r.nw.toFixed(2),(r.nw-10000).toFixed(2)])].map(r=>r.map(csvEscape).join(',')).join('\n');
  window._jexCSV=csv;
  return`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><span style="font-size:12px;color:var(--text2)">Live student balances</span><div style="display:flex;gap:8px"><button class="btn btn-sm" style="background:var(--purple);color:white;border-color:var(--purple)" onclick="generatePDFReport()">📄 Full PDF report</button><button class="btn btn-sm btn-success" onclick="downloadCSV()">Download CSV</button><button class="btn btn-sm btn-primary" onclick="const p=get('csv-panel');p.style.display=p.style.display==='none'?'block':'none'">Show CSV to copy</button></div></div>
  <div class="grid4" style="margin-bottom:14px"><div class="mcard"><div class="mlabel">Students</div><div class="mval">${rows.length}</div></div><div class="mcard"><div class="mlabel">Avg net worth</div><div class="mval ${rows.length&&rows.reduce((s,r)=>s+r.nw,0)/rows.length>=10000?'green':''}" style="font-family:var(--mono)">${rows.length?fmt(rows.reduce((s,r)=>s+r.nw,0)/rows.length):'—'}</div></div><div class="mcard"><div class="mlabel">Leader</div><div class="mval" style="font-size:15px;margin-top:4px">${esc(rows[0]?.name||'—')}</div></div><div class="mcard"><div class="mlabel">Total dividends paid</div><div class="mval green" style="font-family:var(--mono)">${fmt(rows.reduce((s,r)=>s+r.divs,0))}</div></div></div>
  <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th style="padding-left:14px">Rank</th><th>Student</th><th>Email</th><th class="r">Cash</th><th class="r">Portfolio</th><th class="r">Short P&L</th><th class="r">Dividends</th><th class="r">Net worth</th><th class="r">vs Start</th></tr></thead>
  <tbody>${rows.length?rows.map((r,i)=>{const vs=r.nw-10000,vc=vs>=0?'price-up':'price-down';return`<tr><td style="padding-left:14px;font-family:var(--mono);font-weight:500;color:${i===0?'var(--amber)':i===1?'var(--text2)':i===2?'#993C1D':'var(--text3)'}">#${i+1}</td><td style="font-weight:500">${esc(r.name)}</td><td style="color:var(--text2);font-size:12px">${esc(r.email)}</td><td class="r" style="font-family:var(--mono)">${fmt(r.cash)}</td><td class="r" style="font-family:var(--mono)">${fmt(r.portfolio)}</td><td class="r ${r.shortPnl>=0?'price-up':'price-down'}" style="font-family:var(--mono)">${r.shortPnl>=0?'+':''}${fmt(r.shortPnl)}</td><td class="r" style="color:var(--green);font-family:var(--mono)">${fmt(r.divs)}</td><td class="r" style="font-weight:500;font-family:var(--mono)">${fmt(r.nw)}</td><td class="r ${vc}" style="font-family:var(--mono)">${vs>=0?'+':''}${fmt(vs)}</td></tr>`;}).join(''):`<tr><td colspan="9"><div class="empty">No approved students yet</div></td></tr>`}
  </tbody></table></div>
  <div id="csv-panel" style="display:none;margin-top:12px"><div class="ibox ibox-teal">Click inside the box, press <strong>Ctrl+A</strong> (Cmd+A) to select all, then <strong>Ctrl+C</strong> to copy.</div><textarea readonly onclick="this.select()" style="width:100%;font-family:var(--mono);font-size:12px;padding:10px;border:1px solid var(--border2);border-radius:var(--radius);background:var(--bg3);color:var(--text);resize:vertical;min-height:160px;line-height:1.5">${csv}</textarea></div>`;
}
function downloadCSV(){const csv=window._jexCSV;if(!csv)return;const blob=new Blob([csv],{type:'text/csv'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='jex_balances.csv';a.click();URL.revokeObjectURL(url);}
async function adjustCompanyCash(uid2){
  if(!isAdmin(cu()))return toast('Admin access required');
  const u=getUser(uid2);if(!u)return;
  const op=document.getElementById('co-cash-op-'+uid2)?.value;
  const amt=parseFloat(document.getElementById('co-cash-amt-'+uid2)?.value);
  if(isNaN(amt)||amt<0)return toast('Enter a valid amount');
  if(!op)return toast('Select an operation');
  const prev=u.cash;
  let newCash;
  // Authorization is re-checked server-side too (admin_adjust_cash resolves the
  // caller's own role from their real Supabase Auth identity), not just trusted
  // from the isAdmin() check above — same defense-in-depth pattern used
  // elsewhere today.
  try{newCash=await sb.rpc('admin_adjust_cash',{p_target_id:uid2,p_op:op,p_amount:amt});}
  catch(e){return toast('Failed to adjust balance: '+(e.message||e));}
  u.cash=newCash;
  await logActivity('balance_adj',op==='add'?'+'+fmt(amt)+' added to '+u.name:op==='subtract'?'-'+fmt(amt)+' removed from '+u.name:u.name+"'s balance set to "+fmt(newCash),{userId:uid2,userName:u.name,amount:newCash-prev});
  toast(u.name+"'s balance updated to "+fmt(newCash));render();
}
async function adjustCash(uid2){
  if(!isAdmin(cu()))return toast('Admin access required');
  const u=getUser(uid2);if(!u)return;
  const op=get('cash-op-'+uid2)?.value;
  const amt=parseFloat(get('cash-amt-'+uid2)?.value);
  if(isNaN(amt)||amt<0)return toast('Enter a valid amount');
  if(!op)return toast('Select an operation');
  const prev=u.cash;
  let newCash;
  try{newCash=await sb.rpc('admin_adjust_cash',{p_target_id:uid2,p_op:op,p_amount:amt});}
  catch(e){return toast('Failed to adjust balance: '+(e.message||e));}
  u.cash=newCash;
  await logActivity('balance_adj',op==='add'?'+'+fmt(amt)+' added to '+u.name:op==='subtract'?'-'+fmt(amt)+' removed from '+u.name:''+u.name+"'s balance set to "+fmt(newCash),{userId:uid2,userName:u.name,amount:newCash-prev});
  pushBalances();
  toast(u.name+"'s balance updated to "+fmt(newCash));render();
}
function renderAdminUsers(students,companies,officers,leadership){
  const u=cu();
  const isTrueChairman=u?.role==='chairman';
  return`${leadership&&leadership.length?`<div class="card"><div class="section-title">Leadership</div>
    <div class="ibox ibox-purple" style="margin-bottom:14px">Chairman and President accounts.${isTrueChairman?' You cannot remove your own account.':' Only the Chairman can remove Chairman/President accounts.'}</div>
    ${leadership.map(x=>`<div class="app-row">
      <div class="app-info">
        <div class="app-name">${esc(x.name)} ${roleBadge(x.role)}${x.id===u?.id?' <span class="badge b-gray">you</span>':''}</div>
        <div class="app-meta">${esc(x.email)}</div>
      </div>
      ${isTrueChairman&&x.id!==u?.id?`<button class="btn btn-sm btn-danger" onclick="removeUser('${x.id}')">Remove</button>`:''}
    </div>`).join('')}
  </div>`:''}
  ${officers&&officers.length?`<div class="card"><div class="section-title">Officers</div>
    <div class="ibox ibox-blue" style="margin-bottom:14px">Secretary, Treasurer, and Compliance Officer accounts.</div>
    ${officers.map(u=>`<div class="app-row">
      <div class="app-info">
        <div class="app-name">${esc(u.name)} ${roleBadge(u.role)}</div>
      </div>
    </div>`).join('')}
  </div>`:''}
  <div class="card"><div class="section-title">Students — balance adjustment</div>
    <div class="ibox ibox-blue" style="margin-bottom:14px">Select an operation, enter an amount, and click Apply to update a student's cash balance. Subtract will not go below $0.</div>
    ${students.length?students.map(u=>`<div class="app-row">
      <div class="app-info">
        <div class="app-name">${esc(u.name)}</div>
        <div class="app-meta">${esc(u.email)} &nbsp;|&nbsp; Cash: <strong style="font-family:var(--mono);color:var(--green)">${fmt(u.cash)}</strong> &nbsp;|&nbsp; Net worth: <strong style="font-family:var(--mono)">${fmt(nw(u))}</strong></div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <select id="cash-op-${u.id}" style="width:90px;font-size:12px;padding:5px 8px">
          <option value="add">Add</option>
          <option value="subtract">Subtract</option>
          <option value="set">Set to</option>
        </select>
        <input type="number" id="cash-amt-${u.id}" placeholder="Amount" min="0" step="0.01" style="width:100px;font-size:12px;padding:5px 8px">
        <button class="btn btn-sm btn-primary" onclick="adjustCash('${u.id}')">Apply</button>
        <button class="btn btn-sm btn-danger" onclick="removeUser('${u.id}')">Remove</button>
      </div>
    </div>`).join(''):`<div class="empty">No students yet</div>`}
  </div>
  ${companies.length?`<div class="card"><div class="section-title">Companies — balance adjustment</div>
    <div class="ibox ibox-blue">Adjust a company account&#39;s cash balance directly.</div>
    ${companies.map(u=>`<div class="app-row">
      <div class="app-info">
        <div class="app-name">${esc(u.name)}</div>
        <div class="app-meta">${esc(u.email)} &nbsp;|&nbsp; Cash: <strong style="font-family:var(--mono);color:var(--green)">${fmt(u.cash)}</strong></div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <select id="co-cash-op-${u.id}" style="width:90px;font-size:12px;padding:5px 8px">
          <option value="add">Add</option>
          <option value="subtract">Subtract</option>
          <option value="set">Set to</option>
        </select>
        <input type="number" id="co-cash-amt-${u.id}" placeholder="Amount" min="0" step="0.01" style="width:100px;font-size:12px;padding:5px 8px">
        <button class="btn btn-sm btn-primary" onclick="adjustCompanyCash('${u.id}')">Apply</button>
        <button class="btn btn-sm btn-danger" onclick="removeCompany('${u.id}')">Remove</button>
      </div>
    </div>`).join('')}
  </div>`:''}`;
}
function renderAdminClasses(){
  const pending=DB.classApps.filter(a=>a.status==='pending');
  const reviewed=DB.classApps.filter(a=>a.status!=='pending');
  // Group active share classes by company
  const byCompany={};
  DB.shareClasses.forEach(c=>{
    if(!byCompany[c.parent_ticker])byCompany[c.parent_ticker]={name:c.company_name,classes:[]};
    byCompany[c.parent_ticker].classes.push(c);
  });
  const activeEntries=Object.entries(byCompany);
  return '<div class="card"><div class="section-title">Pending share class applications '
    +(pending.length?'<span class="badge b-amber" style="margin-left:4px">'+pending.length+'</span>':'')+'</div>'
    +(pending.length?pending.map(a=>'<div class="app-row"><div class="app-info">'
      +'<div class="app-name">'+a.company_name+' — <span class="badge b-gray" style="font-family:var(--mono)">'+a.proposed_ticker+'</span> Class '+a.class+'</div>'
      +'<div class="app-meta">'+a.votes_per_share+' vote'+(a.votes_per_share!==1?'s':'')+'/share · '+a.shares.toLocaleString()+' shares @ '+fmt(a.price)
      +(a.restricted?' · <span class="badge b-red">Restricted</span> to: '+(a.whitelist||[]).map(id=>getUser(id)?.name||id).join(', '):'')+'</div>'
      +(a.reason?'<div class="app-meta">Reason: '+a.reason.replace('[CONVERT]','[Conversion]')+'</div>':'')
      +'</div><div class="btn-row">'
      +'<button class="btn btn-success btn-sm" onclick="reviewClassApp(&quot;'+a.id+'&quot;,true)">Approve</button>'
      +'<button class="btn btn-danger btn-sm" onclick="reviewClassApp(&quot;'+a.id+'&quot;,false)">Reject</button>'
      +'</div></div>').join('')
    :'<div class="empty">No pending applications</div>')
    +'</div>'
    +(activeEntries.length?'<div class="card"><div class="section-title">Active share classes</div>'
      +'<div class="ibox ibox-blue">Removing a <strong>conversion</strong> strips the class label but keeps the stock trading. Removing a <strong>new class</strong> delists it entirely.</div>'
      +activeEntries.map(([parentTicker,entry])=>{
        return '<div style="padding:10px 0;border-bottom:1px solid var(--border)">'
          +'<div style="font-size:12px;font-weight:500;color:var(--text2);margin-bottom:8px;padding:0 2px">'+entry.name+' ('+parentTicker+')</div>'
          +entry.classes.map(c=>{
            const isConv=c.ticker===c.parent_ticker;
            return '<div class="app-row" style="margin-bottom:4px"><div class="app-info">'
              +'<div class="app-name"><span class="badge b-gray" style="font-family:var(--mono)">'+c.ticker+'</span> <span class="badge b-amber">Class '+c.class+'</span>'
              +(isConv?'<span class="badge b-blue" style="margin-left:4px">Conversion</span>':'<span class="badge b-teal" style="margin-left:4px">New class</span>')
              +(c.restricted?'<span class="badge b-red" style="margin-left:4px">Restricted</span>':'')+'</div>'
              +'<div class="app-meta">'+c.votes_per_share+' vote'+(c.votes_per_share!==1?'s':'')+'/share'+(c.restricted?' · '+(c.whitelist||[]).length+' whitelisted':'')+'</div>'
              +'</div>'
              +'<button class="btn btn-sm btn-danger" onclick="removeShareClass(&quot;'+c.ticker+'&quot;)">Remove</button>'
              +'</div>';
          }).join('')
          +'</div>';
      }).join('')+'</div>':'')
    +(reviewed.length?'<div class="card"><div class="section-title">Application history</div>'
      +reviewed.map(a=>'<div class="app-row"><div class="app-info">'
        +'<div class="app-name">'+a.company_name+' — '+a.proposed_ticker+' Class '+a.class+'</div>'
        +'<div class="app-meta">'+a.ts+'</div></div>'
        +'<span class="badge '+(a.status==='approved'?'b-green':a.status==='rejected'?'b-red':'b-gray')+'">'+a.status+'</span></div>'
      ).join('')+'</div>':'');
}
function renderAdminFlags(){
  const u=cu();
  const isCO=u.role==='compliance_officer';
  const isChairPres=u.role==='chairman'||u.role==='president';
  const openFlags=DB.flags.filter(f=>f.status==='open');
  const closedFlags=DB.flags.filter(f=>f.status!=='open');
  const students=DB.users.filter(u2=>u2.role==='student'&&u2.status==='approved');
  const companies=DB.companies.filter(c=>c.status==='listed');

  let html='';

  // Flag creation form (CO only)
  if(isCO){
    html+=`<div class="card"><div class="section-title">Flag an account or trade</div>
      <div class="ibox ibox-purple">Flagging notifies the Chairman and President immediately. Use this when you observe rule violations, suspicious trading patterns, or misleading disclosures.</div>
      <div class="grid2" style="margin-bottom:12px">
        <div><label class="flabel">Type</label>
          <select id="flag-type" onchange="updateFlagTargets()">
            <option value="student">Student</option>
            <option value="company">Company</option>
          </select>
        </div>
        <div><label class="flabel">Target</label>
          <select id="flag-target">
            <option value="">— Select —</option>
            ${students.map(s=>`<option value="${s.id}|${esc(s.name)}|student">${esc(s.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="frow"><label class="flabel">Reason for flagging</label>
        <textarea id="flag-reason" rows="3" placeholder="e.g. Suspected wash trading — student bought and sold BWV 12 times in 5 minutes to inflate price artificially..."></textarea>
      </div>
      <button class="btn btn-danger" onclick="submitFlagForm()">🚩 Submit flag</button>
    </div>`;
  }

  // Open flags
  html+=`<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
    Open flags ${openFlags.length?`<span class="badge b-red">${openFlags.length}</span>`:''}
  </div>`;
  if(!openFlags.length){
    html+='<div class="empty">No open flags</div>';
  } else {
    openFlags.forEach(f=>{
      const flaggedUser=getUser(f.target_id);
      const isHaltedTarget=f.target_type==='company'&&DB.companies.find(c=>c.owner_id===f.target_id||c.ticker===f.target_id);
      html+=`<div style="padding:12px;border:1px solid var(--red);border-radius:var(--radius);margin-bottom:10px;background:rgba(255,77,106,0.04)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:16px">🚩</span>
          <strong>${esc(f.target_name)}</strong>
          <span class="badge b-red">${f.target_type}</span>
          <span style="font-size:11px;color:var(--text2);margin-left:auto">${f.ts} — flagged by ${esc(f.flagged_by_name)}</span>
        </div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:10px">${esc(f.reason)}</div>
        ${isChairPres?`<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="text" id="res-note-${f.id}" placeholder="Resolution note (optional)" style="flex:1;font-size:12px;padding:5px 8px">
          <button class="btn btn-sm btn-success" onclick="resolveFlagForm('${f.id}','resolved')">✓ Resolve</button>
          <button class="btn btn-sm btn-warning" onclick="resolveFlagForm('${f.id}','dismissed')">Dismiss</button>
        </div>`:'<div style="font-size:12px;color:var(--text2)">Awaiting Chairman/President review</div>'}
      </div>`;
    });
  }
  html+='</div>';

  // Closed flags history
  if(closedFlags.length){
    html+=`<div class="card"><div class="section-title">Resolved / dismissed flags</div>
      <table><thead><tr><th>Target</th><th>Type</th><th>Reason</th><th>Status</th><th>Resolved by</th><th>Note</th><th>Time</th></tr></thead>
      <tbody>${closedFlags.map(f=>`<tr>
        <td style="font-weight:500">${esc(f.target_name)}</td>
        <td><span class="badge b-gray">${f.target_type}</span></td>
        <td style="font-size:12px;color:var(--text2);max-width:200px">${esc(f.reason)}</td>
        <td><span class="badge ${f.status==='resolved'?'b-green':'b-gray'}">${f.status}</span></td>
        <td style="font-size:12px;color:var(--text2)">${esc(f.resolved_by)||'—'}</td>
        <td style="font-size:12px;color:var(--text2)">${esc(f.resolution_note)||'—'}</td>
        <td style="font-size:12px;color:var(--text2)">${f.ts||''}</td>
      </tr>`).join('')}</tbody></table>
    </div>`;
  }
  return html;
}
function renderAdminBugReports(){
  const openReports=(DB.bugReports||[]).filter(b=>b.status==='open');
  const closedReports=(DB.bugReports||[]).filter(b=>b.status!=='open');
  let html=`<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
    Open bug reports ${openReports.length?`<span class="badge b-red">${openReports.length}</span>`:''}
  </div>`;
  if(!openReports.length){
    html+='<div class="empty">No open bug reports</div>';
  } else {
    openReports.forEach(b=>{
      html+=`<div style="padding:12px;border:1px solid var(--red);border-radius:var(--radius);margin-bottom:10px;background:rgba(255,77,106,0.04)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:16px">🐛</span>
          <strong>${esc(b.user_name)}</strong>
          <span style="font-size:11px;color:var(--text2);margin-left:auto">${esc(b.ts)}</span>
        </div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:10px;white-space:pre-wrap">${esc(b.description)}</div>
        ${b.screenshot_url?`<div style="margin-bottom:10px"><a href="${esc(b.screenshot_url)}" target="_blank" rel="noopener"><img src="${esc(b.screenshot_url)}" style="max-width:100%;max-height:260px;border-radius:var(--radius);border:1px solid var(--border)"></a></div>`:''}
        <button class="btn btn-sm btn-success" onclick="resolveBugReport('${b.id}')">✓ Mark resolved</button>
      </div>`;
    });
  }
  html+='</div>';
  if(closedReports.length){
    html+=`<div class="card"><div class="section-title">Resolved bug reports</div>
      <table><thead><tr><th>Reporter</th><th>Description</th><th>Resolved by</th><th>Time</th></tr></thead>
      <tbody>${closedReports.map(b=>`<tr>
        <td style="font-weight:500">${esc(b.user_name)}</td>
        <td style="font-size:12px;color:var(--text2);max-width:300px">${esc(b.description)}</td>
        <td style="font-size:12px;color:var(--text2)">${esc(b.resolved_by)||'—'}</td>
        <td style="font-size:12px;color:var(--text2)">${esc(b.ts)||''}</td>
      </tr>`).join('')}</tbody></table>
    </div>`;
  }
  return html;
}
function renderAdminClientErrors(){
  const errors=DB.clientErrors||[];
  let html=`<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
    Uncaught client-side errors ${errors.length?`<button class="btn btn-sm btn-danger" onclick="clearClientErrors()">Clear all</button>`:''}
  </div>
  <div class="ibox ibox-blue">Automatically captured whenever a student's browser hits an uncaught JavaScript error or an unhandled promise rejection — no bug report needed. Normal validation messages (toasts) never show up here.</div>`;
  if(!errors.length){
    html+='<div class="empty">No errors reported</div>';
  } else {
    errors.forEach(e=>{
      html+=`<div style="padding:12px;border:1px solid var(--red);border-radius:var(--radius);margin-bottom:10px;background:rgba(255,77,106,0.04)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
          <span style="font-size:16px">⚠️</span>
          <strong style="font-family:var(--mono);font-size:13px">${esc(e.message)}</strong>
          <span style="font-size:11px;color:var(--text2);margin-left:auto">${esc(e.ts)}</span>
        </div>
        <div style="font-size:12px;color:var(--text2)">${e.user_name?esc(e.user_name)+' ('+esc(e.user_role||'unknown')+')':'Not signed in'}${e.url?' — '+esc(e.url):''}</div>
        ${e.stack?`<pre style="font-size:11px;color:var(--text2);white-space:pre-wrap;margin-top:8px;max-height:120px;overflow:auto">${esc(e.stack)}</pre>`:''}
      </div>`;
    });
  }
  html+='</div>';
  return html;
}
async function clearClientErrors(){
  if(!confirm('Clear all logged client errors?'))return;
  try{await sb.rpc('rpc_admin_clear_client_errors',{});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.clientErrors=[];
  toast('Error log cleared');render();
}
function renderAdminMessages(){
  const openMsgs=(DB.contactMessages||[]).filter(m=>m.status==='open');
  const closedMsgs=(DB.contactMessages||[]).filter(m=>m.status!=='open');
  let html=`<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
    Open messages ${openMsgs.length?`<span class="badge b-red">${openMsgs.length}</span>`:''}
  </div>`;
  if(!openMsgs.length){
    html+='<div class="empty">No open messages</div>';
  } else {
    openMsgs.forEach(m=>{
      html+=`<div style="padding:12px;border:1px solid var(--red);border-radius:var(--radius);margin-bottom:10px;background:rgba(255,77,106,0.04)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:16px">✉️</span>
          <strong>${esc(m.from_name)}</strong>
          <a href="mailto:${esc(m.from_email)}" class="legal-link" style="font-size:12px">${esc(m.from_email)}</a>
          <span style="font-size:11px;color:var(--text2);margin-left:auto">${esc(m.ts)}</span>
        </div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:10px;white-space:pre-wrap">${esc(m.message)}</div>
        <button class="btn btn-sm btn-success" onclick="resolveContactMessage('${m.id}')">✓ Mark resolved</button>
      </div>`;
    });
  }
  html+='</div>';
  if(closedMsgs.length){
    html+=`<div class="card"><div class="section-title">Resolved messages</div>
      <table><thead><tr><th>From</th><th>Message</th><th>Resolved by</th><th>Time</th></tr></thead>
      <tbody>${closedMsgs.map(m=>`<tr>
        <td style="font-weight:500">${esc(m.from_name)}</td>
        <td style="font-size:12px;color:var(--text2);max-width:300px">${esc(m.message)}</td>
        <td style="font-size:12px;color:var(--text2)">${esc(m.resolved_by)||'—'}</td>
        <td style="font-size:12px;color:var(--text2)">${esc(m.ts)||''}</td>
      </tr>`).join('')}</tbody></table>
    </div>`;
  }
  return html;
}
function submitFlagForm(){
  const typeEl=document.getElementById('flag-type');
  const targetEl=document.getElementById('flag-target');
  const reason=document.getElementById('flag-reason')?.value;
  if(!targetEl?.value)return toast('Select a target');
  const [targetId,targetName,targetType]=targetEl.value.split('|');
  flagAccount(targetId,targetName,targetType,reason);
}
function updateFlagTargets(){
  const type=document.getElementById('flag-type')?.value;
  const sel=document.getElementById('flag-target');if(!sel)return;
  const students=DB.users.filter(u=>u.role==='student'&&u.status==='approved');
  const companies=DB.companies.filter(c=>c.status==='listed');
  sel.innerHTML='<option value="">— Select —</option>'
    +(type==='student'?students.map(s=>`<option value="${s.id}|${esc(s.name)}|student">${esc(s.name)}</option>`).join('')
    :companies.map(c=>`<option value="${c.owner_id}|${esc(c.name)}|company">${esc(c.name)} (${esc(c.ticker)})</option>`).join(''));
}
function resolveFlagForm(flagId,action){
  const note=document.getElementById('res-note-'+flagId)?.value;
  resolveFlag(flagId,action,note);
}
function renderAdminDashboard(){
  const students=DB.users.filter(u=>u.role==='student'&&u.status==='approved');
  const companies=DB.companies.filter(c=>c.status==='listed');
  const todayTrades=DB.trades.filter(t=>t.ts&&t.ts.includes(new Date().toLocaleDateString()));
  const totalMktCap=companies.filter(c=>!c.is_index_fund).reduce((s,c)=>s+c.price*c.shares,0);
  const openOrders=DB.limitOrders.filter(o=>o.status==='open').length;
  const halted=DB.halts.length;
  // Biggest mover
  const movers=companies.map(c=>({ticker:c.ticker,name:c.name,chg:priceChg(c)})).sort((a,b)=>Math.abs(b.chg)-Math.abs(a.chg));
  const bigMover=movers[0];
  // Most active stock
  const tradeCounts={};DB.trades.forEach(t=>{tradeCounts[t.ticker]=(tradeCounts[t.ticker]||0)+1;});
  const mostActive=Object.entries(tradeCounts).sort((a,b)=>b[1]-a[1])[0];
  // Top student
  const ranked=students.map(u=>({...u,_nw:nw(u)})).sort((a,b)=>b._nw-a._nw);
  return`<div class="grid4" style="margin-bottom:14px">
    <div class="mcard"><div class="mlabel">Students</div><div class="mval">${students.length}</div></div>
    <div class="mcard"><div class="mlabel">Listed stocks</div><div class="mval">${companies.length}</div></div>
    <div class="mcard"><div class="mlabel">Total market cap</div><div class="mval" style="font-size:16px;font-family:var(--mono)">${fmt(totalMktCap)}</div></div>
    <div class="mcard"><div class="mlabel">Session</div><div class="mval" style="font-size:16px;color:${DB.session.status==='open'?'var(--green)':DB.session.status==='paused'?'var(--amber)':'var(--red)'}">${DB.session.status}</div></div>
  </div>
  <div class="grid4" style="margin-bottom:14px">
    <div class="mcard"><div class="mlabel">Trades today</div><div class="mval">${todayTrades.length}</div></div>
    <div class="mcard"><div class="mlabel">Open orders</div><div class="mval">${openOrders}</div></div>
    <div class="mcard"><div class="mlabel">Halted stocks</div><div class="mval" style="color:${halted?'var(--red)':'var(--text)'}">${halted}</div></div>
    <div class="mcard"><div class="mlabel">Pending registrations</div><div class="mval" style="color:${DB.pending.length?'var(--amber)':'var(--text)'}">${DB.pending.length}</div></div>
  </div>
  <div class="grid4" style="margin-bottom:14px">
    <div class="mcard"><div class="mlabel">🚩 Open flags</div><div class="mval" style="color:${(DB.flags||[]).filter(f=>f.status==='open').length?'var(--red)':'var(--text)'}">${(DB.flags||[]).filter(f=>f.status==='open').length}</div></div>
    <div class="mcard"><div class="mlabel">Price adjustments</div><div class="mval">${(DB.priceAdjustments||[]).length}</div></div>
    <div class="mcard"><div class="mlabel">Halted stocks</div><div class="mval" style="color:${DB.halts.length?'var(--red)':'var(--text)'}">${DB.halts.length}</div></div>
    <div class="mcard"><div class="mlabel">Active limit orders</div><div class="mval">${DB.limitOrders.filter(o=>o.status==='open').length}</div></div>
  </div>
  <div class="grid3" style="margin-bottom:14px">
    <div class="mcard"><div class="mlabel">🏆 Leaderboard leader</div><div class="mval" style="font-size:15px;margin-top:4px">${ranked[0]?.name||'—'}</div>${ranked[0]?`<div style="font-size:12px;color:var(--green);font-family:var(--mono);margin-top:2px">${fmt(ranked[0]._nw)}</div>`:''}
    </div>
    <div class="mcard"><div class="mlabel">📈 Biggest mover</div><div class="mval" style="font-size:15px;margin-top:4px">${bigMover?.ticker||'—'}</div>${bigMover?`<div style="font-size:12px;color:${bigMover.chg>=0?'var(--green)':'var(--red)'};font-family:var(--mono);margin-top:2px">${fmtChg(bigMover.chg)}</div>`:''}
    </div>
    <div class="mcard"><div class="mlabel">🔥 Most traded</div><div class="mval" style="font-size:15px;margin-top:4px">${mostActive?mostActive[0]:'—'}</div>${mostActive?`<div style="font-size:12px;color:var(--text2);margin-top:2px">${mostActive[1]} trades</div>`:''}
    </div>
  </div>
  <div class="card"><div class="section-title">Recent activity</div>
    ${DB.activity.slice(0,10).length?`<table><thead><tr><th>Time</th><th>Type</th><th>Description</th></tr></thead><tbody>
    ${DB.activity.slice(0,10).map(a=>`<tr><td style="color:var(--text2);white-space:nowrap">${a.ts||''}</td><td><span class="badge b-gray">${a.type}</span></td><td style="font-size:12px">${esc(a.description)}</td></tr>`).join('')}
    </tbody></table>`:'<div class="empty">No activity yet</div>'}
  </div>`;
}

function renderAdminFounderAllocs(){
  const pending=DB.founderAllocations.filter(a=>a.status==='pending');
  const reviewed=DB.founderAllocations.filter(a=>a.status!=='pending');
  return '<div class="card"><div class="section-title">Pending founder share allocations '
    +(pending.length?'<span class="badge b-amber" style="margin-left:4px">'+pending.length+'</span>':'')+'</div>'
    +(pending.length?pending.map(a=>'<div class="app-row"><div class="app-info">'
      +'<div class="app-name">'+a.student_name+' <span class="badge b-blue">student</span></div>'
      +'<div class="app-meta"><strong>'+a.shares.toLocaleString()+'</strong> shares of <span style="font-family:var(--mono)">'+a.ticker+'</span> ('+a.company_name+')'+(a.reason?' — '+a.reason:'')+'</div>'
      +'<div class="app-meta">'+a.ts+'</div>'
      +'</div><div class="btn-row">'
      +'<button class="btn btn-success btn-sm" onclick="reviewFounderAllocation(&quot;'+a.id+'&quot;,true)">Approve</button>'
      +'<button class="btn btn-danger btn-sm" onclick="reviewFounderAllocation(&quot;'+a.id+'&quot;,false)">Reject</button>'
      +'</div></div>').join('')
    :'<div class="empty">No pending founder share requests</div>')
    +'</div>'
    +(reviewed.length?'<div class="card"><div class="section-title">History</div>'
      +'<table><thead><tr><th>Student</th><th>Ticker</th><th>Shares</th><th>Reason</th><th>Status</th><th>Time</th></tr></thead><tbody>'
      +reviewed.map(a=>'<tr>'
        +'<td>'+a.student_name+'</td>'
        +'<td><span class="badge b-gray" style="font-family:var(--mono)">'+a.ticker+'</span></td>'
        +'<td>'+a.shares.toLocaleString()+'</td>'
        +'<td style="font-size:12px;color:var(--text2)">'+(a.reason||'—')+'</td>'
        +'<td><span class="badge '+(a.status==='approved'?'b-green':'b-red')+'">'+a.status+'</span></td>'
        +'<td style="font-size:12px;color:var(--text2)">'+a.ts+'</td>'
        +'</tr>').join('')
      +'</tbody></table></div>':'');
}


function renderAdminNews(){
  const items=DB.news;
  if(!items.length)return`<div class="card"><div class="empty">No company news posts yet.</div></div>`;
  return`<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">All company news <span style="font-size:12px;font-weight:400;color:var(--text2)">${items.length} post${items.length!==1?'s':''}</span></div>
    ${items.map(n=>`<div class="news-item">
      <div class="news-headline">${esc(n.headline)}</div>
      ${n.body?`<div class="news-body">${esc(n.body||"")}</div>`:''}
      <div class="news-meta" style="justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="news-ticker">${n.ticker}</span>
          <span>${esc(n.company_name)}</span>
          <span>${n.ts||''}</span>
        </div>
        <button class="btn btn-sm btn-danger" onclick="deleteNews('${n.id}')">Delete</button>
      </div>
    </div>`).join('')}
  </div>`;
}
function renderAdminListed(){
  return`<div class="card"><div class="section-title">Listed companies</div>
    <table><thead><tr><th>Company</th><th>Ticker</th><th class="r">Price</th><th>Change</th><th>Shares</th><th>Owner</th><th></th></tr></thead>
    <tbody>${[...DB.companies].sort((a,b)=>(b.is_index_fund?1:0)-(a.is_index_fund?1:0)).map(c=>{const owner=DB.users.find(u=>u.id===c.owner_id),chg=priceChg(c);return`<tr><td style="font-weight:500">${esc(c.name)}${getClassroomName(c.classroom_id)?` <span class="badge b-gray" style="font-size:10px">${esc(getClassroomName(c.classroom_id))}</span>`:''} ${c.status==='delisted'?'<span class="badge b-red" style="font-size:10px">delisted</span>':''}</td><td><span class="badge b-gray copy-ticker" style="font-family:var(--mono)" onclick="copyTicker('${esc(c.ticker)}')" title="Click to copy">${esc(c.ticker)}</span></td><td class="r" style="font-family:var(--mono)">${fmt(c.price)}</td><td class="r ${chg>=0?'price-up':'price-down'}">${fmtChg(chg)}</td><td>${sharesBar(c)}</td><td style="font-size:12px;color:var(--text2)">${esc(owner?owner.name:'—')}</td><td>${c.status==='delisted'?
    `<button class="btn btn-sm btn-primary" onclick="relistCompany('${c.ticker}')">Re-list</button>`:
    `<button class="btn btn-sm btn-danger" onclick="delistCompany('${c.ticker}')">Delist</button>`
  }</td></tr>`;}).join('')||`<tr><td colspan="7"><div class="empty">No listed companies</div></td></tr>`}
    </tbody></table></div>
  ${isChairman(cu())?`<div class="card"><div class="section-title">Price adjustment</div>
    <div class="ibox ibox-amber">Apply a percentage boost or drop to any stock. Notifies all holders. Use positive % to boost, negative % to drop (e.g. -10 = drop 10%).</div>
    <div class="row" style="align-items:flex-end">
      <div class="frow" style="flex:1"><label class="flabel">Stock</label>
        <select id="adj-ticker"><option value="">— Select —</option>${DB.companies.filter(c=>!c.is_index_fund).map(c=>`<option value="${esc(c.ticker)}">${esc(c.ticker)} — ${esc(c.name)} (${fmt(c.price)})</option>`).join('')}</select>
      </div>
      <div class="frow" style="flex:1"><label class="flabel">Adjustment %</label>
        <input type="number" id="adj-pct" placeholder="e.g. 15 or -10" step="0.1"></div>
      <div class="frow" style="flex:2"><label class="flabel">Reason (optional)</label>
        <input type="text" id="adj-reason" placeholder="e.g. Regulatory fine"></div>
      <div style="padding-bottom:12px"><button class="btn btn-primary" onclick="adjStockForm()">Apply</button></div>
    </div>
    ${DB.priceAdjustments&&DB.priceAdjustments.length?`<hr class="divider"><div style="font-size:12px;font-weight:500;margin-bottom:8px">Recent adjustments</div>
    <table><thead><tr><th>Ticker</th><th>Change</th><th>Old price</th><th>New price</th><th>Reason</th><th>By</th><th>Time</th></tr></thead>
    <tbody>${DB.priceAdjustments.slice(0,10).map(a=>`<tr>
      <td><span class="badge b-gray" style="font-family:var(--mono)">${a.ticker}</span></td>
      <td class="${a.pct>=0?'price-up':'price-down'}" style="font-family:var(--mono)">${a.pct>=0?'+':''}${a.pct}%</td>
      <td style="font-family:var(--mono)">${fmt(a.old_price)}</td>
      <td style="font-family:var(--mono);font-weight:500">${fmt(a.new_price)}</td>
      <td style="font-size:12px;color:var(--text2)">${a.reason||'—'}</td>
      <td style="font-size:12px;color:var(--text2)">${a.applied_by||'—'}</td>
      <td style="font-size:12px;color:var(--text2)">${a.ts||''}</td>
    </tr>`).join('')}</tbody></table>`:''}
  </div>`:''}`;
}

// ═══════════════════════════════════════════════
// RENDER: STUDENT ORDERS (limit orders)
// ═══════════════════════════════════════════════
function renderNotifications(){
  const notifs=myNotifications();
  const u=cu();
  const unread=notifs.filter(n=>!n.read).length;
  const typeIcon={dividend:'💰',news:'📰',vote:'🗳️',vote_closed:'🗳️',ipo:'🏢',session:'🟢',limit_fill:'⚡',after_hours:'⏰',halt:'⚠️',resume:'✅',invite:'🤝',founder_alloc:'🎁',price_adj:'📊'};
  return `<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
    Notifications ${unread?`<span class="badge b-red">${unread} unread</span>`:''}
    ${notifs.length?`<button class="btn btn-sm" onclick="markAllRead()">Mark all read</button>`:''}
  </div>
  ${notifs.length?notifs.map(n=>{
    // Find pending invite that matches this notification
    // Only show buttons for actual pending invites (not accepted/declined/company confirmations)
    const pendingInvite=n.type==='invite'&&n.message.includes('invited you')?
      DB.companyMembers.find(m=>
        m.student_id===u.id&&
        m.status==='pending'
      ):null;
    return `<div style="display:flex;align-items:flex-start;gap:10px;padding:12px 0;border-bottom:1px solid var(--border);opacity:${n.read?'0.55':'1'}">
      <div style="font-size:18px;min-width:28px">${typeIcon[n.type]||'•'}</div>
      <div style="flex:1">
        <div style="font-size:13px${n.read?'':';font-weight:500'}">${esc(n.message)}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${n.ts||''}</div>
        ${pendingInvite?`<div style="display:flex;gap:6px;margin-top:8px">
          <button class="btn btn-sm btn-success" onclick="respondToInvite(&quot;${pendingInvite.id}&quot;,true)">✓ Accept</button>
          <button class="btn btn-sm btn-danger" onclick="respondToInvite(&quot;${pendingInvite.id}&quot;,false)">✕ Decline</button>
        </div>`:''}
      </div>
      ${n.ticker&&n.ticker!==null?`<span class="badge b-gray" style="font-family:var(--mono);font-size:10px">${n.ticker}</span>`:''}
    </div>`;
  }).join(''):`<div class="empty">No notifications yet</div>`}
  </div>`;
}
function renderStudentOrders(){
  const u=cu();
  const myOrders=DB.limitOrders.filter(o=>o.user_id===u.id).reverse();
  const open=myOrders.filter(o=>o.status==='open');
  const afterHours=myOrders.filter(o=>o.status==='after_hours');
  const closed=myOrders.filter(o=>o.status!=='open'&&o.status!=='after_hours');
  const openBook=DB.limitOrders.filter(o=>o.status==='open'&&o.user_id===u.id);
  const bookByTicker={};
  openBook.forEach(o=>{if(!bookByTicker[o.ticker])bookByTicker[o.ticker]=[];bookByTicker[o.ticker].push(o);});
  const ahSection=afterHours.length?`<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">After-hours orders <span class="badge b-amber">${afterHours.length} queued</span></div>
    <div class="ibox ibox-amber">These orders activate automatically when the next session opens.</div>
    <table><thead><tr><th>Ticker</th><th>Side</th><th>Qty</th><th>Limit price</th><th>Placed</th><th></th></tr></thead>
    <tbody>${afterHours.map(o=>`<tr><td><span class="badge b-gray" style="font-family:var(--mono)">${o.ticker}</span></td><td><span class="badge ${o.side==='buy'?'b-teal':'b-red'}">${o.side}</span></td><td>${o.qty}</td><td style="font-family:var(--mono);font-weight:500">${fmt(o.limit_price)}</td><td style="color:var(--text2)">${o.ts}</td><td><button class="btn btn-sm btn-danger" onclick="cancelLimitOrder('${o.id}')">Cancel</button></td></tr>`).join('')}</tbody></table></div>`:'';
  // Active stop-loss orders
  const myStopLoss=DB.stopLossOrders.filter(s=>s.user_id===u.id&&s.status==='active');
  const slSection=myStopLoss.length?`<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">Stop-loss orders <span class="badge b-red">${myStopLoss.length} active</span></div>
    <div class="ibox ibox-purple">These orders automatically sell your shares if the price drops to the trigger price.</div>
    <table><thead><tr><th>Ticker</th><th>Trigger price</th><th>Shares</th><th>Current price</th><th>Gap</th><th></th></tr></thead>
    <tbody>${myStopLoss.map(s=>{const co=getCo(s.ticker);const gap=co?Math.round((co.price-s.trigger_price)/co.price*100*10)/10:0;return`<tr>
      <td><span class="badge b-gray copy-ticker" style="font-family:var(--mono)" onclick="copyTicker('${s.ticker}')">${s.ticker}</span></td>
      <td style="font-family:var(--mono);color:var(--red)">${fmt(s.trigger_price)}</td>
      <td>${s.shares}</td>
      <td style="font-family:var(--mono)">${co?fmt(co.price):'—'}</td>
      <td style="font-family:var(--mono);color:${gap<5?'var(--red)':gap<15?'var(--amber)':'var(--green)'}">${co?gap+'%':'—'}</td>
      <td><button class="btn btn-sm btn-danger" onclick="cancelStopLoss(&quot;${s.id}&quot;)">Cancel</button></td>
    </tr>`}).join('')}</tbody></table>
  </div>`:'';
  return slSection+ahSection+`<div class="card"><div class="section-title">Open limit orders</div>
    ${open.length?`<table><thead><tr><th>Ticker</th><th>Side</th><th>Qty</th><th>Limit price</th><th>Current price</th><th>Placed</th><th></th></tr></thead>
    <tbody>${open.map(o=>{const co=getCo(o.ticker);return`<tr>
      <td><span class="badge b-gray" style="font-family:var(--mono)">${o.ticker}</span></td>
      <td><span class="badge ${o.side==='buy'?'b-teal':'b-red'}">${o.side}</span></td>
      <td>${o.qty}</td>
      <td style="font-family:var(--mono);font-weight:500">${fmt(o.limit_price)}</td>
      <td style="font-family:var(--mono)">${co?fmt(co.price):'—'}</td>
      <td style="color:var(--text2)">${o.ts}</td>
      <td><button class="btn btn-sm btn-danger" onclick="cancelLimitOrder('${o.id}')">Cancel</button></td>
    </tr>`;}).join('')}</tbody></table>`:'<div class="empty">No open limit orders</div>'}
  </div>
  ${closed.length?`<div class="card"><div class="section-title">Order history</div>
    <table><thead><tr><th>Ticker</th><th>Side</th><th>Qty</th><th>Limit</th><th>Fill price</th><th>Status</th><th>Placed</th></tr></thead>
    <tbody>${closed.map(o=>`<tr>
      <td><span class="badge b-gray" style="font-family:var(--mono)">${o.ticker}</span></td>
      <td><span class="badge ${o.side==='buy'?'b-teal':'b-red'}">${o.side}</span></td>
      <td>${o.qty}</td>
      <td style="font-family:var(--mono)">${fmt(o.limit_price)}</td>
      <td style="font-family:var(--mono)">${o.filled_price?fmt(o.filled_price):'—'}</td>
      <td><span class="badge ${o.status==='filled'?'b-green':'b-gray'}">${o.status}</span></td>
      <td style="color:var(--text2)">${o.ts}</td>
    </tr>`).join('')}</tbody></table></div>`:''}`;
}

// ═══════════════════════════════════════════════
// RENDER: TRADING HISTORY (per stock)
// ═══════════════════════════════════════════════
function renderExchangeStats(){
  const listed=DB.companies.filter(c=>c.status==='listed');
  const students=DB.users.filter(u=>u.role==='student'&&u.status==='approved');
  const today=new Date().toLocaleDateString();
  const todayTrades=DB.trades.filter(t=>t.ts&&t.ts.includes(today));
  const totalVol=todayTrades.reduce((s,t)=>s+t.price*t.qty,0);
  const totalMktCap=listed.filter(c=>!c.is_index_fund).reduce((s,c)=>s+c.price*c.shares,0);
  const movers=listed.map(c=>({ticker:c.ticker,name:c.name,chg:priceChg(c),price:c.price})).sort((a,b)=>Math.abs(b.chg)-Math.abs(a.chg));
  const gainers=[...movers].sort((a,b)=>b.chg-a.chg).filter(m=>m.chg>0);
  const losers=[...movers].sort((a,b)=>a.chg-b.chg).filter(m=>m.chg<0);
  const mostActive=[...listed].map(c=>({ticker:c.ticker,name:c.name,trades:todayTrades.filter(t=>t.ticker===c.ticker).length})).sort((a,b)=>b.trades-a.trades);
  const bigTrade=todayTrades.length?todayTrades.reduce((a,b)=>b.price*b.qty>a.price*a.qty?b:a):null;
  const ranked=students.map(u=>({name:u.name,nw:nw(u)})).sort((a,b)=>b.nw-a.nw);
  // Session recaps from minutes
  const recaps=(DB.minutes||[]).filter(m=>m.type==='official_notice'&&m.title.startsWith('Session recap'));
  return`<div class="grid4" style="margin-bottom:14px">
    <div class="mcard"><div class="mlabel">Total market cap</div><div class="mval" style="font-size:18px;font-family:var(--mono)">${fmt(totalMktCap)}</div></div>
    <div class="mcard"><div class="mlabel">Trades today</div><div class="mval" style="font-size:18px">${todayTrades.length}</div></div>
    <div class="mcard"><div class="mlabel">Volume today</div><div class="mval" style="font-size:18px;font-family:var(--mono)">${fmt(totalVol)}</div></div>
    <div class="mcard"><div class="mlabel">Listed stocks</div><div class="mval" style="font-size:18px">${listed.length}</div></div>
  </div>
  <div class="grid3" style="margin-bottom:14px">
    <div class="card" style="margin-bottom:0"><div class="section-title">📈 Top gainers</div>
      ${gainers.slice(0,3).map(m=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <div><span class="badge b-gray copy-ticker" style="font-family:var(--mono)" onclick="copyTicker('${esc(m.ticker)}')">${esc(m.ticker)}</span> <span style="font-size:12px;color:var(--text2)">${esc(m.name)}</span></div>
        <span class="price-up" style="font-family:var(--mono)">+${m.chg.toFixed(1)}%</span>
      </div>`).join('')||'<div class="empty" style="padding:12px">No gainers yet</div>'}
    </div>
    <div class="card" style="margin-bottom:0"><div class="section-title">📉 Top losers</div>
      ${losers.slice(0,3).map(m=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <div><span class="badge b-gray copy-ticker" style="font-family:var(--mono)" onclick="copyTicker('${esc(m.ticker)}')">${esc(m.ticker)}</span> <span style="font-size:12px;color:var(--text2)">${esc(m.name)}</span></div>
        <span class="price-down" style="font-family:var(--mono)">${m.chg.toFixed(1)}%</span>
      </div>`).join('')||'<div class="empty" style="padding:12px">No losers yet</div>'}
    </div>
    <div class="card" style="margin-bottom:0"><div class="section-title">🔥 Most active</div>
      ${mostActive.slice(0,3).map(m=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <div><span class="badge b-gray copy-ticker" style="font-family:var(--mono)" onclick="copyTicker('${esc(m.ticker)}')">${esc(m.ticker)}</span> <span style="font-size:12px;color:var(--text2)">${esc(m.name)}</span></div>
        <span style="font-size:12px;color:var(--text2)">${m.trades} trades</span>
      </div>`).join('')||'<div class="empty" style="padding:12px">No trades yet today</div>'}
    </div>
  </div>
  <div class="grid2" style="margin-bottom:14px">
    <div class="card" style="margin-bottom:0"><div class="section-title">🏆 Leaderboard snapshot</div>
      ${ranked.slice(0,5).map((r,i)=>`<div class="lb-row" style="padding:8px 12px">
        <div class="lb-rank ${i===0?'r-gold':i===1?'r-silver':i===2?'r-bronze':''}">#${i+1}</div>
        <div class="lb-name" style="font-size:13px">${esc(r.name)}</div>
        <div class="lb-val" style="font-size:13px">${fmt(r.nw)}</div>
      </div>`).join('')||'<div class="empty" style="padding:12px">No students yet</div>'}
    </div>
    <div class="card" style="margin-bottom:0"><div class="section-title">💰 Biggest trade today</div>
      ${bigTrade?`<div style="padding:12px 0">
        <div style="font-size:22px;font-weight:500;font-family:var(--mono);margin-bottom:4px">${fmt(bigTrade.price*bigTrade.qty)}</div>
        <div style="font-size:13px;color:var(--text2)">${bigTrade.qty}×<span class="badge b-gray" style="font-family:var(--mono)">${bigTrade.ticker}</span> @ ${fmt(bigTrade.price)}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:4px">${bigTrade.ts}</div>
      </div>`:'<div class="empty" style="padding:16px">No trades yet today</div>'}
    </div>
  </div>
  ${recaps.length?`<div class="card"><div class="section-title">📋 Session recaps</div>
    ${recaps.slice(0,3).map(r=>`<div style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <strong style="font-size:13px">${esc(r.title)}</strong>
        <span style="font-size:11px;color:var(--text2)">${r.ts}</span>
      </div>
      <div style="font-size:12px;color:var(--text2);white-space:pre-line">${esc(r.body)}</div>
    </div>`).join('')}
  </div>`:''}`;
}
function exportStudentPDF(){
  const u=cu();if(!u)return;
  const myTrades=DB.trades.filter(t=>t.buyer_id===u.id||t.seller_id===u.id).reverse();
  const myHoldings=Object.entries(holdings(u)).map(([ticker,qty])=>{const co=getCo(ticker);return{ticker,qty,price:co?co.price:0,value:co?qty*co.price:0};}).filter(h=>h.qty>0);
  const myDivs=DB.dividends.filter(d=>(d.payouts||[]).some(p=>p.userId===u.id));
  const _nw=nw(u),_pv=pv(u),_spnl=sPnl(u),_divs=divRec(u);
  const win=window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>JEX Portfolio — ${esc(u.name)}</title>
  <style>body{font-family:system-ui,sans-serif;padding:32px;color:#1a2233;max-width:800px;margin:0 auto}
  h1{color:#f0a500;font-size:24px;margin-bottom:4px}
  h2{font-size:16px;margin:24px 0 8px;border-bottom:2px solid #f0a500;padding-bottom:4px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
  .card{background:#f4f6fa;border-radius:8px;padding:12px}
  .label{font-size:11px;color:#4a5a72;margin-bottom:4px}
  .val{font-size:20px;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px}
  th{text-align:left;font-size:11px;color:#4a5a72;padding:6px 8px;border-bottom:2px solid #d1d9e6}
  td{padding:6px 8px;border-bottom:1px solid #eef1f7}
  .green{color:#0f6e56}.red{color:#cc2240}
  .mono{font-family:monospace}
  footer{margin-top:32px;font-size:11px;color:#8896a8;text-align:center}
  @media print{button{display:none}}</style></head><body>
  <h1>JEX — Portfolio Report</h1>
  <p style="color:#4a5a72;margin-bottom:24px">${esc(u.name)} &nbsp;|&nbsp; ${esc(u.email)} &nbsp;|&nbsp; Generated ${new Date().toLocaleString()}</p>
  <h2>Summary</h2>
  <div class="grid">
    <div class="card"><div class="label">Cash</div><div class="val mono">${fmt(u.cash)}</div></div>
    <div class="card"><div class="label">Portfolio value</div><div class="val mono">${fmt(_pv)}</div></div>
    <div class="card"><div class="label">Short P&L</div><div class="val mono ${_spnl>=0?'green':'red'}">${fmt(_spnl)}</div></div>
    <div class="card"><div class="label">Net worth</div><div class="val mono">${fmt(_nw)}</div></div>
  </div>
  <div class="grid" style="grid-template-columns:repeat(3,1fr)">
    <div class="card"><div class="label">Dividends received</div><div class="val mono green">${fmt(_divs)}</div></div>
    <div class="card"><div class="label">Total trades</div><div class="val">${myTrades.length}</div></div>
    <div class="card"><div class="label">vs Starting cash</div><div class="val mono ${_nw-10000>=0?'green':'red'}">${_nw-10000>=0?'+':''}${fmt(_nw-10000)}</div></div>
  </div>
  <h2>Holdings</h2>
  ${myHoldings.length?`<table><thead><tr><th>Ticker</th><th>Shares</th><th>Current price</th><th>Value</th></tr></thead><tbody>
  ${myHoldings.map(h=>`<tr><td class="mono">${h.ticker}</td><td>${h.qty}</td><td class="mono">${fmt(h.price)}</td><td class="mono">${fmt(h.value)}</td></tr>`).join('')}
  </tbody></table>`:'<p style="color:#8896a8">No current holdings</p>'}
  <h2>Recent trades (last 50)</h2>
  ${myTrades.length?`<table><thead><tr><th>Time</th><th>Ticker</th><th>Side</th><th>Qty</th><th>Price</th><th>Value</th></tr></thead><tbody>
  ${myTrades.slice(0,50).map(t=>`<tr><td>${t.ts}</td><td class="mono">${t.ticker}</td><td>${t.buyer_id===u.id?'bought':'sold'}</td><td>${t.qty}</td><td class="mono">${fmt(t.price)}</td><td class="mono">${fmt(t.qty*t.price)}</td></tr>`).join('')}
  </tbody></table>`:'<p style="color:#8896a8">No trades yet</p>'}
  <h2>Dividends received</h2>
  ${myDivs.length?`<table><thead><tr><th>Time</th><th>Company</th><th>Per share</th><th>Payout</th></tr></thead><tbody>
  ${myDivs.map(d=>{const p=(d.payouts||[]).find(x=>x.userId===u.id);return`<tr><td>${d.ts}</td><td>${esc(d.company_name)}</td><td class="mono">${fmt(d.per_share)}</td><td class="mono green">${p?fmt(p.payout):'—'}</td></tr>`;}).join('')}
  </tbody></table>`:'<p style="color:#8896a8">No dividends received</p>'}
  <footer>JEX — JTED Stock Exchange &nbsp;|&nbsp; This report was generated automatically</footer>
  <script>window.print();<\/script></body></html>`);
  win.document.close();
}
function renderNWChart(u){
  const history=DB.nwHistory.filter(h=>h.user_id===u.id).slice(-60);
  if(history.length<2)return`<div class="card"><div class="empty">Not enough data yet. Net worth is recorded after each trade.<br><br>Make a few trades to start building your chart.</div></div>`;
  const current=nw(u);
  const first=history[0].nw;
  const change=Math.round((current-first)*100)/100;
  const pctChange=Math.round((change/first)*100*10)/10;
  return`<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
    Net worth over time
    <span class="${change>=0?'price-up':'price-down'}" style="font-size:13px">${change>=0?'+':''}${fmt(change)} (${pctChange>=0?'+':''}${pctChange}%)</span>
  </div>
  <div style="position:relative;height:220px"><canvas id="nw-chart"></canvas></div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:14px">
    <div class="mcard"><div class="mlabel">Starting</div><div class="mval" style="font-size:16px;font-family:var(--mono)">${fmt(first)}</div></div>
    <div class="mcard"><div class="mlabel">Current</div><div class="mval" style="font-size:16px;font-family:var(--mono);color:${current>=first?'var(--green)':'var(--red)'}">${fmt(current)}</div></div>
    <div class="mcard"><div class="mlabel">Peak</div><div class="mval" style="font-size:16px;font-family:var(--mono)">${fmt(Math.max(...history.map(h=>h.nw)))}</div></div>
  </div></div>`;
}
const TRADES_PER_PAGE=20;
function renderTradingHistory(){
  const u=cu();
  const allMyTrades=DB.trades.filter(t=>t.buyer_id===u.id||t.seller_id===u.id).reverse();
  if(!allMyTrades.length)return`<div class="card"><div class="empty">No trades yet</div></div>`;
  const totalPages=Math.ceil(allMyTrades.length/TRADES_PER_PAGE)||1;
  if(UI.tradePage>=totalPages)UI.tradePage=totalPages-1;
  const pageTrades=allMyTrades.slice(UI.tradePage*TRADES_PER_PAGE,(UI.tradePage+1)*TRADES_PER_PAGE);
  const pagCtrl=totalPages>1?`<div style="display:flex;align-items:center;gap:8px;padding:10px 0 0;font-size:13px">
    <button class="btn btn-sm" onclick="UI.tradePage=Math.max(0,UI.tradePage-1);render()" ${UI.tradePage===0?'disabled':''}>← Prev</button>
    <span style="color:var(--text2);flex:1;text-align:center">Page ${UI.tradePage+1} of ${totalPages} · ${allMyTrades.length} total trades</span>
    <button class="btn btn-sm" onclick="UI.tradePage=Math.min(${totalPages-1},UI.tradePage+1);render()" ${UI.tradePage>=totalPages-1?'disabled':''}>Next →</button>
  </div>`:'';
  // Summary stats from ALL trades
  let totalBought=0,totalSpent=0,totalSold=0,totalReceived=0;
  allMyTrades.forEach(t=>{if(t.buyer_id===u.id){totalBought+=t.qty;totalSpent+=t.qty*t.price;}else{totalSold+=t.qty;totalReceived+=t.qty*t.price;}});
  return`<div class="card" style="margin-bottom:14px">
    <div class="grid4">
      <div class="mcard"><div class="mlabel">Total trades</div><div class="mval" style="font-size:18px">${allMyTrades.length}</div></div>
      <div class="mcard"><div class="mlabel">Shares bought</div><div class="mval" style="font-size:18px">${totalBought.toLocaleString()}</div></div>
      <div class="mcard"><div class="mlabel">Shares sold</div><div class="mval" style="font-size:18px">${totalSold.toLocaleString()}</div></div>
      <div class="mcard"><div class="mlabel">Net flow</div><div class="mval ${totalReceived-totalSpent>=0?'green':'red'}" style="font-size:16px;font-family:var(--mono)">${totalReceived-totalSpent>=0?'+':''}${fmt(totalReceived-totalSpent)}</div></div>
    </div>
  </div>
  <div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
    Trade history <span style="font-size:12px;font-weight:400;color:var(--text2)">showing ${UI.tradePage*TRADES_PER_PAGE+1}–${Math.min((UI.tradePage+1)*TRADES_PER_PAGE,allMyTrades.length)} of ${allMyTrades.length}</span>
  </div>
  <table><thead><tr><th>Time</th><th>Ticker</th><th>Side</th><th>Qty</th><th>Price</th><th>Value</th><th>Type</th></tr></thead>
  <tbody>${pageTrades.map(t=>`<tr>
    <td style="color:var(--text2);white-space:nowrap">${t.ts}</td>
    <td><span class="badge b-gray copy-ticker" style="font-family:var(--mono)" onclick="copyTicker('${t.ticker}')" title="Click to copy">${t.ticker}</span></td>
    <td><span class="badge ${t.buyer_id===u.id?'b-teal':'b-red'}">${t.buyer_id===u.id?'bought':'sold'}</span></td>
    <td>${t.qty}</td>
    <td style="font-family:var(--mono)">${fmt(t.price)}</td>
    <td style="font-family:var(--mono)">${fmt(t.qty*t.price)}</td>
    <td><span class="badge b-gray">${t.type==='book_match'?'matched':t.type||'market'}</span></td>
  </tr>`).join('')}</tbody></table>
  ${pagCtrl}</div>`;
}

// ═══════════════════════════════════════════════
// RENDER: ACTIVITY LOG (Chairman only)
// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
// SECRETARY FEATURES
// ═══════════════════════════════════════════════
function renderAdminOfficialNotices(){
  // postOfficialNotice() actually writes to jex_announcements (a styled
  // announcement), not jex_minutes -- this list used to filter jex_minutes
  // for type==='official_notice', which no writer ever set, so it always
  // rendered empty regardless of how many notices were posted.
  const notices=DB.announcements.filter(a=>a.title&&a.title.startsWith('📋 OFFICIAL NOTICE: '));
  const u=cu();
  return`<div class="card"><div class="section-title">Post an official notice</div>
    <div class="ibox ibox-blue">Official notices appear on the market page with a formal styling, distinct from regular announcements. Use for procedural communications like session schedules or deadlines.</div>
    <div class="frow"><label class="flabel">Notice title</label><input type="text" id="notice-title" placeholder="e.g. Notice of upcoming earnings deadline"></div>
    <div class="frow"><label class="flabel">Notice body</label><textarea id="notice-body" rows="5" placeholder="To all market participants:&#10;&#10;Please be advised that..."></textarea></div>
    <button class="btn btn-primary" onclick="postOfficialNotice(get('notice-title')?.value,get('notice-body')?.value)">Post official notice</button>
  </div>
  ${notices.length?`<div class="card"><div class="section-title">Posted notices (${notices.length})</div>
    ${notices.map(a=>`<div style="padding:12px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div><span class="badge b-blue" style="margin-right:6px">Official notice</span><strong>${esc(a.title)}</strong></div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:11px;color:var(--text2)">${a.ts} — ${esc(a.author_name)}</span>
          <button class="btn btn-sm btn-danger" onclick="deleteAnnouncement('${a.id}')">Delete</button>
        </div>
      </div>
      <div style="font-size:13px;color:var(--text2);white-space:pre-line">${esc(a.body)}</div>
    </div>`).join('')}
  </div>`:''}`;
}
async function postMinutes(title,body){
  const u=cu();
  if(!title||title.trim().length<3)return toast('Enter a title');
  if(!body||body.trim().length<10)return toast('Enter meeting notes (at least 10 characters)');
  // Runs server-side (rpc_post_minutes), re-checking that the caller is
  // actually Secretary -- this had NO check at all before, client-side or
  // otherwise, and minutes show on the market page noticeboard to every user.
  let rec;
  try{rec=await sb.rpc('rpc_post_minutes',{p_title:title.trim(),p_body:body.trim()});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.minutes.unshift(rec);
  await logActivity('minutes','Meeting minutes posted: '+title.trim(),{userId:u.id,userName:u.name});
  await pushNotificationToAll('minutes','📋 New meeting minutes posted: '+title.trim());
  toast('Meeting minutes posted');render();
}
async function deleteMinutes(id){
  if(!confirm('Delete these minutes?'))return;
  // Runs server-side (rpc_admin_delete_minutes) -- this function had NO
  // check at all before, client-side or otherwise.
  try{await sb.rpc('rpc_admin_delete_minutes',{p_id:id});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.minutes=DB.minutes.filter(m=>m.id!==id);
  toast('Minutes deleted');render();
}
async function postOfficialNotice(title,body){
  // Official notice = styled announcement from Secretary
  if(!title||!body)return toast('Enter title and body');
  // Runs server-side (rpc_post_official_notice), re-checking that the
  // caller is actually Secretary -- this had NO check at all before,
  // client-side or otherwise, and it posts to the pinned top banner
  // every user sees on login.
  let rec;
  try{rec=await sb.rpc('rpc_post_official_notice',{p_title:title,p_body:body});}
  catch(e){return toast(rpcErrorMessage(e));}
  DB.announcements.unshift(rec);
  toast('Official notice posted');render();
}
function renderAdminMinutes(){
  const u=cu();
  return`<div class="card"><div class="section-title">Post meeting minutes</div>
    <div class="ibox ibox-blue">Minutes are visible to all students on the market page noticeboard.</div>
    <div class="frow"><label class="flabel">Title</label><input type="text" id="min-title" placeholder="e.g. Board meeting — March 21"></div>
    <div class="frow"><label class="flabel">Minutes</label><textarea id="min-body" rows="6" placeholder="Attendees: ...&#10;&#10;Agenda:&#10;1. ...&#10;&#10;Decisions made:&#10;..."></textarea></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" onclick="postMinutes(get('min-title')?.value,get('min-body')?.value)">Post minutes</button>
      <button class="btn" onclick="postOfficialNotice(get('min-title')?.value,get('min-body')?.value)">Post as official notice</button>
    </div>
  </div>
  ${DB.minutes.length?`<div class="card"><div class="section-title">Posted minutes (${DB.minutes.length})</div>
    ${DB.minutes.map(m=>`<div style="padding:12px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <strong>${esc(m.title)}</strong>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:11px;color:var(--text2)">${m.ts} — ${esc(m.author_name)}</span>
          <button class="btn btn-sm btn-danger" onclick="deleteMinutes('${m.id}')">Delete</button>
        </div>
      </div>
      <div style="font-size:13px;color:var(--text2);white-space:pre-line">${esc(m.body)}</div>
    </div>`).join('')}
  </div>`:''}`;
}
function renderAdminShareholderRegistry(){
  const students=DB.users.filter(u=>u.role==='student'&&u.status==='approved');
  const listed=DB.companies.filter(c=>c.status==='listed');
  const allTickers=[...new Set([...listed.map(c=>c.ticker),...DB.shareClasses.map(s=>s.ticker)])];
  return`<div class="card"><div class="section-title">Complete shareholder registry</div>
    <div class="ibox ibox-blue">All students, their holdings, and voting power across every listed company. Read-only.</div>
    <div style="overflow-x:auto"><table><thead><tr>
      <th>Student</th>
      ${allTickers.map(t=>`<th class="r">${esc(t)}</th>`).join('')}
      <th class="r">Total value</th><th class="r">Total votes</th>
    </tr></thead><tbody>
    ${students.map(u=>{
      const totalVal=allTickers.reduce((s,t)=>{const co=getCo(t);const q=(u.holdings&&u.holdings[t])||0;return s+(co?q*co.price:0);},0);
      const totalVotes=allTickers.reduce((s,t)=>{const meta=getClassMeta(t);const vps=meta?meta.votes_per_share:1;const q=(u.holdings&&u.holdings[t])||0;return s+q*vps;},0);
      const hasHoldings=allTickers.some(t=>(u.holdings&&u.holdings[t]||0)>0);
      if(!hasHoldings&&totalVal===0)return'';
      return`<tr>
        <td style="font-weight:500">${esc(u.name)}</td>
        ${allTickers.map(t=>`<td class="r" style="font-family:var(--mono)">${(u.holdings&&u.holdings[t])||0||'—'}</td>`).join('')}
        <td class="r" style="font-family:var(--mono);color:var(--green)">${fmt(totalVal)}</td>
        <td class="r" style="color:var(--amber)">${totalVotes||'—'}</td>
      </tr>`;
    }).join('')}
    </tbody></table></div>
  </div>`;
}
function renderAdminVoteOversight(){
  const open=DB.votes.filter(v=>v.status==='open');
  const closed=DB.votes.filter(v=>v.status!=='open');
  function voteCard(v){
    const co=getCo(v.parent_ticker)||DB.companies.find(c=>c.ticker===v.parent_ticker);
    const ballots=DB.ballots.filter(b=>b.vote_id===v.id);
    const opt1=ballots.filter(b=>b.choice===v.option1).reduce((s,b)=>s+b.weight,0);
    const opt2=ballots.filter(b=>b.choice===v.option2).reduce((s,b)=>s+b.weight,0);
    const total=opt1+opt2||1;
    return`<div style="padding:12px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div><strong>${v.question}</strong> <span class="badge b-gray" style="font-family:var(--mono)">${v.parent_ticker}</span></div>
        <span class="badge ${v.status==='open'?'b-green':'b-gray'}">${v.status}</span>
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px">${co?.name||v.parent_ticker} · ${ballots.length} voters · ${v.ts}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
        <div style="background:var(--bg3);border-radius:4px;padding:6px 8px">${v.option1}: <strong>${opt1}</strong> votes (${Math.round(opt1/total*100)}%)</div>
        <div style="background:var(--bg3);border-radius:4px;padding:6px 8px">${v.option2}: <strong>${opt2}</strong> votes (${Math.round(opt2/total*100)}%)</div>
      </div>
    </div>`;
  }
  return`<div class="card"><div class="section-title">Open votes (${open.length})</div>
    ${open.length?open.map(voteCard).join(''):'<div class="empty">No open votes</div>'}
  </div>
  ${closed.length?`<div class="card"><div class="section-title">Closed votes (${closed.length})</div>
    ${closed.map(voteCard).join('')}
  </div>`:''}`;
}

// ═══════════════════════════════════════════════
// TREASURER FEATURES  
// ═══════════════════════════════════════════════
function renderTreasurerCashFlow(){
  // JXI buys are also 'exchange'-countered trades (minted, not sold by a
  // company) -- excluded here since this is specifically IPO/dilution
  // capital raised BY companies, not units minted for the index fund.
  const totalCapitalRaised=DB.trades.filter(t=>t.seller_id==='exchange'&&!getCo(t.ticker)?.is_index_fund).reduce((s,t)=>s+(t.price*t.qty),0);
  const totalDividendsPaid=DB.dividends.reduce((s,d)=>s+d.total,0);
  const totalBuybacks=DB.buybacks.reduce((s,b)=>s+b.total,0);
  const uniqueOwnerIds=[...new Set(DB.companies.filter(c=>c.status==='listed'&&!c.is_index_fund).map(c=>c.owner_id))];
  const totalCompanyCash=uniqueOwnerIds.reduce((s,oid)=>{const owner=getUser(oid);return s+(owner?owner.cash:0);},0);
  const totalStudentCash=DB.users.filter(u=>u.role==='student'&&u.status==='approved').reduce((s,u)=>s+u.cash,0);
  // Excludes JXI -- its "shares"/price don't represent real backing capital,
  // just outstanding fund units, and double-counting it against the very
  // companies it tracks would distort this stat.
  const totalMarketCap=DB.companies.filter(c=>c.status==='listed'&&!c.is_index_fund).reduce((s,c)=>s+c.price*c.shares,0);
  return`<div class="grid3" style="margin-bottom:14px">
    <div class="mcard"><div class="mlabel">💰 Total capital raised</div><div class="mval" style="font-family:var(--mono);color:var(--green)">${fmt(totalCapitalRaised)}</div><div style="font-size:11px;color:var(--text2);margin-top:4px">From IPO & dilution share sales</div></div>
    <div class="mcard"><div class="mlabel">💸 Total dividends paid</div><div class="mval" style="font-family:var(--mono);color:var(--red)">${fmt(totalDividendsPaid)}</div><div style="font-size:11px;color:var(--text2);margin-top:4px">Across ${DB.dividends.length} payments</div></div>
    <div class="mcard"><div class="mlabel">🔁 Total buybacks</div><div class="mval" style="font-family:var(--mono)">${fmt(totalBuybacks)}</div><div style="font-size:11px;color:var(--text2);margin-top:4px">Across ${DB.buybacks.length} buybacks</div></div>
  </div>
  <div class="grid3" style="margin-bottom:14px">
    <div class="mcard"><div class="mlabel">🏦 Total company cash</div><div class="mval" style="font-family:var(--mono)">${fmt(totalCompanyCash)}</div></div>
    <div class="mcard"><div class="mlabel">👤 Total student cash</div><div class="mval" style="font-family:var(--mono)">${fmt(totalStudentCash)}</div></div>
    <div class="mcard"><div class="mlabel">📈 Total market cap</div><div class="mval" style="font-family:var(--mono)">${fmt(totalMarketCap)}</div></div>
  </div>
  <div class="card"><div class="section-title">Exchange cash flows over time</div>
    <table><thead><tr><th>Time</th><th>Type</th><th>Company</th><th>Amount</th><th>Detail</th></tr></thead><tbody>
    ${[...DB.dividends.map(d=>({ts:d.ts,type:'Dividend',company:d.company_name,amount:-d.total,detail:fmt(d.per_share)+'/share to '+d.payouts.length+' holders'})),
       ...DB.buybacks.map(b=>({ts:b.ts,type:'Buyback',company:DB.companies.find(c=>c.ticker===b.ticker)?.name||b.ticker,amount:-b.total,detail:b.qty+' shares @ '+fmt(b.price)})),
    ].sort((a,b)=>b.ts>a.ts?1:-1).slice(0,50).map(r=>`<tr>
      <td style="color:var(--text2)">${r.ts}</td>
      <td><span class="badge b-gray">${r.type}</span></td>
      <td>${r.company}</td>
      <td class="r" style="font-family:var(--mono);color:var(--red)">${fmt(r.amount)}</td>
      <td style="font-size:12px;color:var(--text2)">${r.detail}</td>
    </tr>`).join('')}
    </tbody></table>
  </div>`;
}
function renderTreasurerDividendAudit(){
  return`<div class="card"><div class="section-title">Dividend audit — all payments</div>
    ${DB.dividends.length?`<table><thead><tr><th>Time</th><th>Company</th><th>Per share</th><th>Total paid</th><th>Recipients</th><th>Note</th></tr></thead><tbody>
    ${[...DB.dividends].reverse().map(d=>{
      const owner=DB.users.find(u=>u.id===DB.companies.find(c=>c.name===d.company_name)?.owner_id);
      return`<tr>
        <td style="color:var(--text2)">${d.ts}</td>
        <td style="font-weight:500">${esc(d.company_name)}</td>
        <td style="font-family:var(--mono)">${fmt(d.per_share)}</td>
        <td style="font-family:var(--mono);font-weight:500;color:var(--red)">${fmt(d.total)}</td>
        <td>${(d.payouts||[]).length} students</td>
        <td style="font-size:12px;color:var(--text2)">${esc(d.note)}</td>
      </tr>`;
    }).join('')}
    </tbody></table>`:'<div class="empty">No dividends paid yet</div>'}
  </div>`;
}
function renderTreasurerPriceLog(){
  return`<div class="card"><div class="section-title">Price adjustment log</div>
    <div class="ibox ibox-blue">All manual price adjustments made by administrators.</div>
    ${(DB.priceAdjustments||[]).length?`<table><thead><tr><th>Time</th><th>Ticker</th><th>Change</th><th>Old price</th><th>New price</th><th>Reason</th><th>By</th></tr></thead><tbody>
    ${DB.priceAdjustments.map(a=>`<tr>
      <td style="color:var(--text2)">${a.ts||''}</td>
      <td><span class="badge b-gray copy-ticker" style="font-family:var(--mono)" onclick="copyTicker('${a.ticker}')">${a.ticker}</span></td>
      <td class="${a.pct>=0?'price-up':'price-down'}" style="font-family:var(--mono)">${a.pct>=0?'+':''}${a.pct}%</td>
      <td style="font-family:var(--mono)">${fmt(a.old_price)}</td>
      <td style="font-family:var(--mono);font-weight:500">${fmt(a.new_price)}</td>
      <td style="font-size:12px;color:var(--text2)">${a.reason||'—'}</td>
      <td style="font-size:12px;color:var(--text2)">${a.applied_by||'—'}</td>
    </tr>`).join('')}
    </tbody></table>`:'<div class="empty">No price adjustments yet</div>'}
  </div>`;
}
function renderTreasurerBudgetWarnings(){
  const threshold=DB.session.budget_warning_threshold||500;
  const divThreshold=DB.session.dividend_approval_threshold||1000;
  const seenOwners=new Set();
  const listed=DB.companies.filter(c=>c.status==='listed'&&!seenOwners.has(c.owner_id)&&seenOwners.add(c.owner_id));
  const warnings=listed.map(co=>{const owner=getUser(co.owner_id);return{co,owner,cash:owner?owner.cash:0};}).filter(w=>w.cash<threshold).sort((a,b)=>a.cash-b.cash);
  const u=cu();
    const canEditThresholds=isChairman(u);
  const thresholdForm=canEditThresholds
    ?'<div class="grid2"><div class="frow"><label class="flabel">Low cash warning threshold ($)</label><div class="row" style="align-items:flex-end"><input type="number" id="bw-threshold" value="'+threshold+'" min="0" step="100" style="flex:1"><button class="btn btn-primary btn-sm" onclick="saveBudgetThreshold()">Save</button></div></div><div class="frow"><label class="flabel">Dividend approval required above ($)</label><div class="row" style="align-items:flex-end"><input type="number" id="div-threshold" value="'+divThreshold+'" min="0" step="100" style="flex:1"><button class="btn btn-primary btn-sm" onclick="saveDivThreshold()">Save</button></div></div></div>'
    :'<div class="ibox ibox-blue">Low cash warning: <strong>'+fmt(threshold)+'</strong> · Dividend approval above: <strong>'+fmt(divThreshold)+'</strong><br><span style="font-size:11px;color:var(--text3)">Thresholds set by Chairman / President in Admin → Session</span></div>';
  return`<div class="card"><div class="section-title">Budget warning settings</div>
    ${thresholdForm} </div>
  <div class="card"><div class="section-title">Low cash warnings ${warnings.length?`<span class="badge b-red">${warnings.length}</span>`:''}</div>
    ${warnings.length?`<div class="ibox ibox-amber">These companies have less than ${fmt(threshold)} in cash. Consider alerting the Chairman.</div>
    ${warnings.map(w=>`<div class="app-row">
      <div class="app-info">
        <div class="app-name">${esc(w.co.name)} <span class="badge b-gray" style="font-family:var(--mono)">${esc(w.co.ticker)}</span></div>
        <div class="app-meta">Cash: <strong style="color:var(--red);font-family:var(--mono)">${fmt(w.cash)}</strong> · Price: ${fmt(w.co.price)} · Market cap: ${fmt(w.co.price*w.co.shares)}</div>
      </div>
      <button class="btn btn-sm btn-warning" onclick="flagForm('${w.co.owner_id}','company')">🚩 Flag</button>
    </div>`).join('')}`:'<div class="empty" style="color:var(--green)">✓ All companies are above the warning threshold</div>'}
  </div>
  <div class="card"><div class="section-title">Pending dividend approvals ${DB.divApprovals.filter(d=>d.status==='pending').length?`<span class="badge b-amber">${DB.divApprovals.filter(d=>d.status==='pending').length}</span>`:''}</div>
    <div class="ibox ibox-blue">Dividends above ${fmt(divThreshold)} require Treasurer approval before they execute.</div>
    ${DB.divApprovals.filter(d=>d.status==='pending').length?DB.divApprovals.filter(d=>d.status==='pending').map(d=>`<div class="app-row">
      <div class="app-info">
        <div class="app-name">${esc(d.company_name)} <span class="badge b-gray" style="font-family:var(--mono)">${d.ticker}</span></div>
        <div class="app-meta">${fmt(d.per_share)}/share · Total: <strong style="font-family:var(--mono)">${fmt(d.total)}</strong> · Requested by ${esc(d.requested_by_name)} · ${d.ts}</div>
        ${d.note?`<div class="app-meta">${esc(d.note)}</div>`:''}
      </div>
      <div class="btn-row">
        <button class="btn btn-success btn-sm" onclick="reviewDivApproval('${d.id}',true)">Approve</button>
        <button class="btn btn-danger btn-sm" onclick="reviewDivApproval('${d.id}',false)">Reject</button>
      </div>
    </div>`).join(''):'<div class="empty">No pending dividend approvals</div>'}
  </div>`;
}

function renderActivityLog(){
  const f=UI.activityFilter||{};
  const typeIcon={trade:'↔',ipo:'🏢',dividend:'💰',news:'📰',announcement:'📢',limit_fill:'⚡',balance_adj:'💵',session:'🕐',registration:'✓',limit_order:'📋',flag:'🚩',cofound:'👥',founder_alloc:'🎁'};
  const typeBadge={trade:'b-gray',ipo:'b-green',dividend:'b-teal',news:'b-amber',announcement:'b-blue',limit_fill:'b-purple',balance_adj:'b-coral',session:'b-gray',registration:'b-blue',limit_order:'b-gray'};
  const types=[...new Set(DB.activity.map(a=>a.type))].sort();
  const filtered=DB.activity.filter(a=>{
    if(f.type&&a.type!==f.type)return false;
    if(f.ticker&&!(a.description||'').toLowerCase().includes(f.ticker.toLowerCase())&&(a.ticker||'').toLowerCase()!==f.ticker.toLowerCase())return false;
    if(f.user&&!(a.user_name||'').toLowerCase().includes(f.user.toLowerCase())&&!(a.description||'').toLowerCase().includes(f.user.toLowerCase()))return false;
    return true;
  });
  return`<div class="card"><div class="section-title" style="display:flex;align-items:center;justify-content:space-between">Activity log <div style="display:flex;align-items:center;gap:8px"><span style="font-size:12px;font-weight:400;color:var(--text2)">${filtered.length} of ${DB.activity.length} events</span><button class="btn btn-sm" onclick="exportTableCSV('activity')">📥 CSV</button></div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;margin-bottom:12px;align-items:end">
      <div><label class="flabel">Filter by type</label>
        <select value="${f.type||''}" onchange="UI.activityFilter=UI.activityFilter||{};UI.activityFilter.type=this.value;render()">
          <option value="" ${!f.type?'selected':''}>All types</option>
          ${types.map(t=>`<option value="${t}" ${f.type===t?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div><label class="flabel">Filter by ticker</label>
        <input type="text" placeholder="e.g. BWV" value="${f.ticker||''}" oninput="UI.activityFilter=UI.activityFilter||{};UI.activityFilter.ticker=this.value;clearTimeout(window._actFilterTimer);window._actFilterTimer=setTimeout(render,300)">
      </div>
      <div><label class="flabel">Filter by user</label>
        <input type="text" placeholder="Name..." value="${f.user||''}" oninput="UI.activityFilter=UI.activityFilter||{};UI.activityFilter.user=this.value;clearTimeout(window._actFilterTimer);window._actFilterTimer=setTimeout(render,300)">
      </div>
      <div><button class="btn btn-sm" onclick="UI.activityFilter={type:'',ticker:'',user:''};render()">Clear filters</button></div>
    </div>
    ${filtered.length?`<table><thead><tr><th>Time</th><th>Type</th><th>Description</th><th>Amount</th><th title="Audit hash">🔒</th></tr></thead>
    <tbody>${filtered.slice(0,100).map(a=>`<tr>
      <td style="color:var(--text2);white-space:nowrap">${a.ts||''}</td>
      <td><span class="badge ${typeBadge[a.type]||'b-gray'}">${typeIcon[a.type]||''} ${a.type}</span></td>
      <td style="font-size:12px">${esc(a.description)}</td>
      <td style="font-family:var(--mono);font-size:12px">${a.amount!=null?(a.amount>=0?'+':'')+fmt(a.amount):''}</td>
      <td title="${a.entry_hash||'no hash'}" style="font-size:9px;color:var(--text3);font-family:var(--mono)">${a.entry_hash?a.entry_hash.slice(-4):'—'}</td>
    </tr>`).join('')}</tbody></table>`:'<div class="empty">No matching activity</div>'}
  </div>`;
}

// ═══════════════════════════════════════════════
// RENDER: ADMIN ANNOUNCEMENTS TAB
// ═══════════════════════════════════════════════
function renderAdminAnnouncements(){
  return`<div class="card"><div class="section-title">Post an announcement</div>
    <div class="ibox ibox-blue">Announcements appear as a banner at the top of the exchange for all users. The most recent one is shown pinned.</div>
    <div class="frow"><label class="flabel">Title</label><input type="text" id="ann-title" placeholder="e.g. Trading closes at 2pm today" maxlength="100"></div>
    <div class="frow"><label class="flabel">Body (optional)</label><textarea id="ann-body" rows="2" placeholder="Additional detail..."></textarea></div>
    <div class="frow"><label class="flabel">Urgency level</label>
      <select id="ann-level">
        <option value="info">Info (blue)</option>
        <option value="warning">Warning (amber)</option>
        <option value="urgent">Urgent (red)</option>
      </select>
    </div>
    <button class="btn btn-primary" onclick="postAnnouncement(get('ann-title')?.value,get('ann-body')?.value,get('ann-level')?.value)">Post announcement</button>
  </div>
  ${DB.announcements.length?`<div class="card"><div class="section-title">All announcements</div>
    ${DB.announcements.map(a=>{
      const lvlColor=a.level==='urgent'?'b-red':a.level==='warning'?'b-amber':'b-blue';
      return`<div class="app-row"><div class="app-info">
        <div class="app-name">${esc(a.title)} <span class="badge ${lvlColor}">${a.level}</span></div>
        ${a.body?`<div class="app-meta">${esc(a.body||"")}</div>`:''}
        <div class="app-meta">${esc(a.author_name)||''} · ${a.ts||''}</div>
      </div><button class="btn btn-sm btn-danger" onclick="deleteAnnouncement('${a.id}')">Delete</button></div>`;
    }).join('')}</div>`:''}`;
}

// ═══════════════════════════════════════════════
// RENDER: PDF REPORT
// ═══════════════════════════════════════════════
function generatePDFReport(){
  const students=DB.users.filter(u=>u.role==='student'&&u.status==='approved').map(u=>({...u,_nw:nw(u),_divs:divRec(u)})).sort((a,b)=>b._nw-a._nw);
  const totalTrades=DB.trades.length;
  const totalDivsPaid=DB.dividends.reduce((s,d)=>s+d.total,0);
  const w=window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>JEX Exchange Report</title>
  <style>
    body{font-family:Arial,sans-serif;font-size:12px;color:#111;max-width:900px;margin:0 auto;padding:20px}
    h1{font-size:22px;margin-bottom:4px}h2{font-size:16px;margin:20px 0 8px;border-bottom:2px solid #f0a500;padding-bottom:4px;color:#0a0e1a}
    h3{font-size:13px;margin:14px 0 6px}
    table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:11px}
    th{background:#0a0e1a;color:white;padding:5px 8px;text-align:left;font-weight:600}
    td{padding:5px 8px;border-bottom:1px solid #e0e0e0}
    tr:nth-child(even)td{background:#f8f8f8}
    .meta{font-size:11px;color:#666;margin-bottom:20px}
    .stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
    .stat{background:#f5f5f5;border-radius:6px;padding:12px;text-align:center}
    .stat-num{font-size:20px;font-weight:bold;color:#0a0e1a}
    .stat-label{font-size:10px;color:#666;margin-top:2px}
    .up{color:#0F6E56}.dn{color:#c0392b}
    .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600}
    .badge-gold{background:#fff3cd;color:#856404}
    @media print{body{max-width:100%}}
  </style></head><body>
  <h1>JEX — JTED Stock Exchange</h1>
  <div class="meta">Report generated ${new Date().toLocaleString()} · Arizona MST</div>
  <div class="stat-grid">
    <div class="stat"><div class="stat-num">${students.length}</div><div class="stat-label">Students</div></div>
    <div class="stat"><div class="stat-num">${DB.companies.length}</div><div class="stat-label">Listed companies</div></div>
    <div class="stat"><div class="stat-num">${totalTrades}</div><div class="stat-label">Total trades</div></div>
    <div class="stat"><div class="stat-num">$${totalDivsPaid.toFixed(0)}</div><div class="stat-label">Dividends paid</div></div>
  </div>
  <h2>Leaderboard</h2>
  <table><thead><tr><th>Rank</th><th>Student</th><th>Cash</th><th>Portfolio</th><th>Short P&L</th><th>Dividends</th><th>Net worth</th><th>vs Start</th></tr></thead><tbody>
  ${students.map((u,i)=>{const vs=u._nw-10000;return`<tr><td>${i===0?'<span class="badge badge-gold">🥇 #1</span>':'#'+(i+1)}</td><td><strong>${esc(u.name)}</strong></td><td>$${u.cash.toFixed(2)}</td><td>$${pv(u).toFixed(2)}</td><td class="${sPnl(u)>=0?'up':'dn'}">$${sPnl(u).toFixed(2)}</td><td>$${u._divs.toFixed(2)}</td><td><strong class="${vs>=0?'up':'dn'}">$${u._nw.toFixed(2)}</strong></td><td class="${vs>=0?'up':'dn'}">${vs>=0?'+':''}$${vs.toFixed(2)}</td></tr>`;}).join('')}
  </tbody></table>
  <h2>Listed Companies</h2>
  <table><thead><tr><th>Company</th><th>Ticker</th><th>Price</th><th>Change</th><th>Shares</th><th>Avail.</th><th>Market cap</th></tr></thead><tbody>
  ${DB.companies.map(c=>{const chg=priceChg(c);return`<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.ticker)}</td><td>$${c.price.toFixed(2)}</td><td class="${chg>=0?'up':'dn'}">${chg>=0?'+':''}${chg.toFixed(2)}%</td><td>${c.shares.toLocaleString()}</td><td>${c.shares_avail.toLocaleString()}</td><td>$${(c.price*c.shares).toFixed(2)}</td></tr>`;}).join('')}
  </tbody></table>
  <h2>All Trades (${DB.trades.length})</h2>
  <table><thead><tr><th>Time</th><th>Ticker</th><th>Price</th><th>Qty</th><th>Type</th><th>Buyer</th><th>Seller</th></tr></thead><tbody>
  ${[...DB.trades].reverse().slice(0,200).map(t=>`<tr><td>${t.ts}</td><td>${esc(t.ticker)}</td><td>$${t.price.toFixed(2)}</td><td>${t.qty}</td><td>${t.type||'market'}</td><td>${['exchange','short'].includes(t.buyer_id)?'JEX':esc(getUser(t.buyer_id)?.name||'?')}</td><td>${['exchange','cover'].includes(t.seller_id)?'JEX':esc(getUser(t.seller_id)?.name||'?')}</td></tr>`).join('')}
  ${DB.trades.length>200?`<tr><td colspan="7" style="text-align:center;color:#666">Showing 200 of ${DB.trades.length} trades</td></tr>`:''}
  </tbody></table>
  <h2>Dividends Paid (${DB.dividends.length})</h2>
  <table><thead><tr><th>Time</th><th>Company</th><th>Per share</th><th>Total</th><th>Recipients</th><th>Note</th></tr></thead><tbody>
  ${DB.dividends.map(d=>`<tr><td>${d.ts}</td><td>${esc(d.company_name)} (${d.ticker})</td><td>$${d.per_share.toFixed(2)}</td><td class="up">$${d.total.toFixed(2)}</td><td>${(d.payouts||[]).length}</td><td>${esc(d.note||'')}</td></tr>`).join('')}
  </tbody></table>
  <h2>Company News (${DB.news.length})</h2>
  <table><thead><tr><th>Time</th><th>Company</th><th>Headline</th><th>Body</th></tr></thead><tbody>
  ${DB.news.map(n=>`<tr><td>${n.ts}</td><td>${esc(n.company_name)} (${esc(n.ticker)})</td><td><strong>${esc(n.headline)}</strong></td><td>${esc(n.body||'—')}</td></tr>`).join('')}
  </tbody></table>
  <div style="margin-top:30px;text-align:center;color:#999;font-size:10px">JEX — JTED Stock Exchange · Generated ${new Date().toLocaleString()}</div>
  </body></html>`);
  w.document.close();
  setTimeout(()=>w.print(),500);
}

// ═══════════════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════════════
function getPageContent(){
  const t=UI.navTab,u=cu();
  if(t==='market'){
    if(UI.companyPage)return renderCompanyPage(UI.companyPage);
    return`<div id="market-content">${renderMarket()}</div>`;
  }
  if(t==='news')return u.role==='company'?renderNewsPage():renderNewsFeed();
  if(t==='portfolio')return renderPortfolio();
  if(t==='leaderboard')return renderLeaderboard();
  if(t==='orders')return renderStudentOrders();
  if(t==='notifications')return renderNotifications();
  if(t==='exchange')return renderExchangeStats();
  if(t==='trades')return renderTrades(isAdmin(u));
  if(t==='mystock')return renderMyStock();
  if(t==='funds')return renderFundsPage();
  if(t==='admin')return renderAdmin();
  if(t==='settings')return renderSettings();
  return '';
}
function render(){
  destroyCharts();
  const app=document.getElementById('app');
  if(!UI.userId){
    // See _oauthReturnActive above -- keep the connecting splash up instead
    // of flashing the login screen while a just-completed Google sign-in is
    // still being resolved into a session.
    if(_oauthReturnActive){app.innerHTML=renderLoadingSplash();return;}
    app.innerHTML=renderLogin()+renderLegalFooter();return;
  }
  const u=cu();if(!u){UI.userId=null;app.innerHTML=renderLogin()+renderLegalFooter();return;}
  const _cu=cu();
  const _isMobileStudent=_cu&&(_cu.role==='student'||_cu.role==='company')&&window.innerWidth<=640;
  const _unread=myUnreadCount();
  const _bnav=_isMobileStudent?`<div class="mobile-bottom-nav">
    <a class="mbn-btn ${UI.navTab==='market'?'active':''}" href="${pageHref('market')}"><span class="mbn-icon">📈</span>Market</a>
    <a class="mbn-btn ${UI.navTab==='exchange'?'active':''}" href="${pageHref('exchange')}"><span class="mbn-icon">🏛</span>Exchange</a>
    <a class="mbn-btn ${UI.navTab==='portfolio'?'active':''}" href="${pageHref('portfolio')}"><span class="mbn-icon">💼</span>Portfolio</a>
    <a class="mbn-btn ${UI.navTab==='orders'?'active':''}" href="${pageHref('orders')}"><span class="mbn-icon">📋</span>Orders</a>
    <a class="mbn-btn ${UI.navTab==='notifications'?'active':''}" href="${pageHref('notifications')}"><span class="mbn-icon">🔔</span><span>${_unread?'<span style="color:var(--red)">'+_unread+'</span>':'Alerts'}</span></a>
  </div>`:'';
  app.innerHTML=`${renderTopbar()}${renderBanner()}${renderNav()}<div class="content${_isMobileStudent?' content-bnav':''}">${getPageContent()}${renderLegalFooter()}</div>${_bnav}`;
  if(DB.session.ends_at&&DB.session.status==='open'&&!sessionTimer)sessionTimer=setInterval(tickTimer,500);
  setTimeout(()=>{
    if(UI.navTab==='mystock'&&UI.companyTab==='stock'){
      const co=DB.companies.find(c=>c.owner_id===UI.userId);
      if(co){
        getCompanyTickers(co.ticker).forEach(ticker=>{
          const stock=getCo(ticker);
          if(stock){destroyChart('co-chart-'+ticker);buildChart('co-chart-'+ticker,stock);}
        });
      }
    }
    if(UI.navTab==='market'&&!UI.companyPage){buildSparklines();buildJxiChart('jxi-chart');}
    if(UI.navTab==='portfolio'&&UI.portfolioTab==='nwchart'){
      setTimeout(()=>{
        const u=cu();if(!u)return;
        const history=DB.nwHistory.filter(h=>h.user_id===u.id).slice(-60);
        if(history.length<2)return;
        const canvas=document.getElementById('nw-chart');if(!canvas||!window.Chart)return;
        if(charts['nw-chart'])try{charts['nw-chart'].destroy();}catch(e){}
        const prices=history.map(h=>h.nw);
        const isUp=prices[prices.length-1]>=prices[0];
        charts['nw-chart']=new Chart(canvas,{type:'line',data:{labels:history.map(h=>h.ts||''),datasets:[{data:prices,borderColor:isUp?'#00c896':'#ff4d6a',borderWidth:2,pointRadius:2,pointBackgroundColor:isUp?'#00c896':'#ff4d6a',fill:true,backgroundColor:isUp?'rgba(0,200,150,0.08)':'rgba(255,77,106,0.08)',tension:0.3}]},
          options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>fmt(ctx.parsed.y)}}},
            scales:{x:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:'#4a5568',font:{size:10},maxTicksLimit:8,autoSkip:true}},y:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:'#4a5568',font:{size:11},callback:v=>fmt(v)},beginAtZero:false}}}});
      },80);
    }
    if(UI.navTab==='market'&&UI.companyPage){
      const allT=getCompanyTickers(UI.companyPage);
      allT.forEach(t=>{const co=getCo(t);if(co){destroyChart('cp-chart-'+t);buildChart('cp-chart-'+t,co);}});
    }
  },60);
}
function setTab(t){UI.navTab=t;UI.panelTicker=null;destroyCharts();render();}

// ═══════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════
function renderLoadingSplash(){
  return `<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px">
    <div style="font-family:var(--mono);font-size:28px;font-weight:700"><span style="color:var(--amber)">JEX</span></div>
    <div style="font-size:13px;color:var(--text2)">Connecting to exchange...</div>
    <div style="width:200px;height:3px;background:var(--bg3);border-radius:2px;overflow:hidden">
      <div style="height:100%;background:var(--blue);border-radius:2px;animation:progress 1.5s ease-in-out infinite"></div>
    </div>
  </div>`;
}
async function boot(){
  if(!isConfigured()){document.getElementById('app').innerHTML=renderConfig();return;}
  // Show loading splash immediately
  // Restore theme before rendering
  try{if(localStorage.getItem('jex-theme')==='light')document.body.classList.add('light-mode');}catch(e){}
  document.getElementById('app').innerHTML=renderLoadingSplash();
  // Set the routed page immediately, before any data loads -- otherwise every
  // render() inside loadAll() (Phase 1, then Phase 2) still targets the
  // 'market' default and briefly flashes the market page before flipping to
  // the real one once data arrives and this was applied too late. The
  // destination is unambiguous from the URL alone (window.__JEX_PAGE__, set
  // inline by each page's own shell before app.js loads), so it doesn't need
  // to wait on the user's role the way the root page's landing-tab redirect
  // below does.
  if(typeof window!=='undefined'&&window.__JEX_PAGE__&&PAGE_ROUTES.has(window.__JEX_PAGE__))UI.navTab=window.__JEX_PAGE__;
  try{
    // Restore session before loadAll so first render() in phase 1 shows correct nav
    const savedId=localStorage.getItem(SESSION_KEY);
    if(savedId){
      UI.userId=savedId; // will be validated after users load
    }
    await loadAll();
    await checkGoogleSession();
    // Validate saved session after load
    if(UI.userId){
      const u=DB.users.find(u=>u.id===UI.userId);
      if(u){
        // Self email/notification_email is already merged in by loadAll()
        // itself (it knows UI.userId by the time it runs, since it's set
        // above before loadAll() is called) -- see rpc_get_own_contact_info.
        // Every routed page (including index.html, whose identity is
        // 'market') already had its destination fixed above, before
        // loadAll(), from the URL alone -- that always wins, market page
        // included: a chairman opening index.html directly lands on market,
        // not their admin dashboard. The role-based landing tab below is only
        // a fallback for the case where no page identity exists at all (e.g.
        // window.__JEX_PAGE__ missing/unrecognized).
        if(!(typeof window!=='undefined'&&window.__JEX_PAGE__&&PAGE_ROUTES.has(window.__JEX_PAGE__))){
          UI.navTab=isAdmin(u)?'admin':u?.role==='company'?'mystock':'market';
          if(isAdmin(u))UI.adminTab='dashboard';
        }
        // loadAll() already rendered twice (Phase 1, then Phase 2 once its
        // data arrived) against the navTab set before loadAll() -- fine in
        // the normal case, but a stale render's own delayed chart-drawing
        // setTimeout (buildJxiChart, etc.) re-checks UI.navTab when it fires
        // and silently no-ops once it no longer matches -- leaving a
        // permanently blank chart canvas sitting in DOM nobody redraws. One
        // more render() here with the final, settled navTab makes the DOM
        // match reality and gives every chart's own timer a stable navTab to
        // fire against.
        render();
        subscribeRealtime();
        // Deep link: index.html?ticker=ACME (the market page) opens straight
        // to that company's page -- the one concrete "share a link" capability
        // the multi-page conversion was for. Unknown/invalid tickers are
        // ignored quietly rather than erroring.
        if(UI.navTab==='market'&&typeof location!=='undefined'){
          const deepTicker=new URLSearchParams(location.search).get('ticker');
          if(deepTicker&&getCo(deepTicker.toUpperCase()))openCompanyPage(deepTicker.toUpperCase());
        }
      } else {
        UI.userId=null; // session invalid
      }
    }
  }catch(err){
    document.getElementById('app').innerHTML=`<div class="config-page"><div class="config-card"><div style="font-family:var(--mono);font-size:20px;font-weight:600;margin-bottom:12px;color:var(--red)">Connection failed</div><div class="ibox ibox-red" style="margin-bottom:16px">Could not connect to Supabase.<br><br><strong>Error:</strong> ${err.message}</div><div style="font-size:13px;color:var(--text2);margin-bottom:12px">Check that your Supabase URL and anon key are correct.</div><button class="btn btn-primary" onclick="boot()">Retry</button></div></div>`;
  }
}
boot();
