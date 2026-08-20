// Fake Supabase, loaded BEFORE app.js so the real app boots unmodified.
//
// Everything else in tests/ verifies extracted functions in Node. This is the
// only harness that runs the actual page: real DOM, real render(), real event
// handlers, real boot path. It exists because static analysis cannot catch a
// TypeError in a render branch nobody executed.
//
// It intercepts window.fetch for PostgREST (/rest/v1/<table> and
// /rest/v1/rpc/<fn>) and replaces WebSocket, then seeds a small exchange.
(function(){
'use strict';

const now = new Date().toISOString();
const TS = 'Aug 20, 9:15:00 AM';

// ── Seed data ──────────────────────────────────────────
const DATA = {
  jex_users: [
    {id:'u-chair', name:'Admin', username:'admin', role:'chairman', status:'approved', cash:0,
     holdings:{}, shorts:{}, watchlist:[], fund_units:{}, created_at:now},
    {id:'u-stu', name:'Ariel Ramirez-Angulo', username:'ariel', role:'student', status:'approved',
     cash:8500, holdings:{ACME:20, JXI:5}, shorts:{BETA:{qty:10, avgPrice:12, collateral:180}},
     watchlist:['ACME'], fund_units:{'f-1':{units:10, costBasis:10}}, classroom_id:'c-1', created_at:now},
    {id:'u-stu2', name:'Bea <script>alert(1)</script>', username:'bea', role:'student', status:'approved',
     cash:9000, holdings:{BETA:5}, shorts:{}, watchlist:[], fund_units:{}, classroom_id:'c-1', created_at:now},
    {id:'u-co', name:'Acme Corp', username:'acme', role:'company', status:'approved', cash:5000,
     holdings:{}, shorts:{}, watchlist:[], fund_units:{}, description:'We make things', classroom_id:'c-1', created_at:now},
    {id:'u-treas', name:'Treasurer', username:'treasurer', role:'treasurer', status:'approved',
     cash:0, holdings:{}, shorts:{}, watchlist:[], fund_units:{}, created_at:now},
    // The officer roles each get their OWN admin tab set (renderAdmin's
    // allowedTabs check silently rewrites UI.adminTab to their first tab),
    // so their panels can only be exercised while signed in as them.
    {id:'u-sec', name:'Secretary', username:'secretary', role:'secretary', status:'approved',
     cash:0, holdings:{}, shorts:{}, watchlist:[], fund_units:{}, created_at:now},
    {id:'u-comp', name:'Compliance Officer', username:'compliance', role:'compliance_officer',
     status:'approved', cash:0, holdings:{}, shorts:{}, watchlist:[], fund_units:{}, created_at:now},
    {id:'u-pres', name:'President', username:'president', role:'president', status:'approved',
     cash:0, holdings:{}, shorts:{}, watchlist:[], fund_units:{}, created_at:now},
  ],
  jex_companies: [
    {id:'c-acme', ticker:'ACME', name:'Acme Corp', price:12.5, shares:1000, shares_avail:400,
     status:'listed', owner_id:'u-co', description:'We make things',
     price_history:[{p:10,t:'2026-08-01T00:00:00Z'},{p:12.5,t:now}], financials:[], index_base_adjust:1, created_at:now},
    {id:'c-beta', ticker:'BETA', name:'Beta & Sons "Quoted"', price:9.75, shares:800, shares_avail:300,
     status:'listed', owner_id:'u-co', description:'Rival firm',
     price_history:[{p:10,t:'2026-08-01T00:00:00Z'},{p:9.75,t:now}], financials:[], index_base_adjust:1, created_at:now},
    {id:'c-jxi', ticker:'JXI', name:'JEX Index', price:112.5, shares:50, shares_avail:50,
     status:'listed', owner_id:null, is_index_fund:true, index_classroom_id:null,
     fund_holdings:{ACME:20,BETA:20}, description:'Index',
     price_history:[{p:100,t:'2026-08-01T00:00:00Z'},{p:112.5,t:now}], financials:[], index_base_adjust:1, created_at:now},
  ],
  jex_session: [{id:1, status:'open', label:'Session open', ends_at:null, scheduled_open:null,
    scheduled_close:null, starting_cash:10000, circuit_breaker_pct:20, price_band_pct:30,
    session_open_prices:{ACME:12, BETA:10, JXI:110}, circuit_cooldowns:{},
    session_started_at:Date.now()-3600000, dividend_approval_threshold:1000, order_rate_limit:10,
    weekly_schedule:null, weekly_active:false, leaderboard_snapshot:null, sheets_url:null, dev_mode:false}],
  jex_trades: [
    {id:2, ticker:'ACME', qty:5, price:12.5, buyer_id:'u-stu', seller_id:'exchange', type:'market', ts:TS},
    {id:1, ticker:'BETA', qty:10, price:12, buyer_id:'short', seller_id:'u-stu', type:'short', ts:TS},
  ],
  jex_announcements:[{id:'a-1', title:'Welcome <b>all</b>', body:'Trade well', author_name:'Admin', ts:TS, created_at:now}],
  jex_halts:[], jex_pending:[
    {id:'p-1', name:'New Student', username:'newbie', role:'student', sec_q:'pet', description:null,
     ts:TS, created_at:now, classroom_id:null, auth_provider:null, email_verified:true, auth_uid:null}],
  jex_news:[{id:'n-1', ticker:'ACME', headline:'Acme ships', body:'Big news & more', company_name:'Acme Corp', ts:TS, created_at:now}],
  jex_ipo_applications:[{id:'i-1', user_id:'u-stu2', name:'Gamma', ticker:'GAM', price:5, shares:500,
    description:'A new co', status:'pending', ts:TS, created_at:now}],
  jex_dilution_applications:[{id:'d-1', ticker:'ACME', company_name:'Acme Corp', current_shares:1000,
    new_shares:200, pct_increase:20, reason:'Raising capital for expansion', status:'pending',
    user_id:'u-co', ts:TS, created_at:now}],
  jex_dividends:[{id:'dv-1', ticker:'ACME', company_name:'Acme Corp', per_share:0.25, total:125,
    note:'Quarterly payout', payouts:[{userId:'u-stu',name:'Ariel',shares:20,payout:5}],
    jxi_pass_through:[], ts:TS, created_at:now}],
  jex_buybacks:[{id:'b-1', ticker:'ACME', company_name:'Acme Corp', qty:10, price:12, total:120, ts:TS, created_at:now}],
  jex_limit_orders:[{id:'lo-1', user_id:'u-stu', ticker:'ACME', side:'buy', qty:5, limit_price:11,
    status:'open', order_type:'gtc', created_at:now}],
  jex_share_classes:[], jex_class_applications:[],
  jex_votes:[{id:'v-1', parent_ticker:'ACME', company_name:'Acme Corp', question:'Expand? <b>yes</b>',
    option1:'Yes & go', option2:'No', status:'open', ts:TS, created_at:now}],
  jex_vote_ballots:[], jex_price_alerts:[],
  jex_nw_history:[
    {id:'nw-1', user_id:'u-stu', nw:8000, cash:8000, portfolio:0, ts:TS, created_at:'2026-08-19T10:00:00Z'},
    {id:'nw-2', user_id:'u-stu', nw:8300, cash:8100, portfolio:200, ts:TS, created_at:'2026-08-19T14:00:00Z'},
    {id:'nw-3', user_id:'u-stu', nw:8583, cash:8500, portfolio:250, ts:TS, created_at:'2026-08-20T09:00:00Z'},
  ],
  jex_company_members:[], jex_founder_allocations:[], jex_price_adjustments:[],
  jex_classrooms:[{id:'c-1', name:'Period A', ts:TS, created_at:now}],
  jex_stop_loss:[], jex_minutes:[], jex_dividend_approvals:[],
  jex_funds:[{id:'f-1', name:'Test Growth Fund', manager_id:'u-co', cash:1000, holdings:{},
    shorts:{}, units_outstanding:100, fee_pct:2, status:'active', description:'Fund',
    funding_goal:5000, created_at:now}],
  jex_index_history:[
    {id:'ih-1', value:1000, ts:TS, created_at:'2026-08-19T10:00:00Z'},
    {id:'ih-2', value:1125, ts:TS, created_at:'2026-08-20T09:00:00Z'},
  ],
  jex_snapshots:[{id:'s-1', label:'Practice round 1', created_by:'Admin', ts:TS, created_at:now}],
  jex_activity:[{id:'ac-1', type:'trade', description:'Ariel bought 5 ACME', ticker:'ACME',
    user_id:'u-stu', user_name:'Ariel', amount:62.5, ts:TS, prev_hash:'genesis', entry_hash:'abc12345', created_at:now}],
  jex_notifications:[], jex_flags:[], jex_bug_reports:[], jex_client_errors:[],
};

window.__JEX_STUB__ = {data:DATA, rpcCalls:[], errors:[], charts:[], consoleErrors:[]};

// Console errors are a real signal -- app.js logs a lot of caught failures
// there rather than rethrowing, and those never reach window.onerror.
(function(){
  const realErr = console.error.bind(console);
  console.error = function(){
    try{ window.__JEX_STUB__.consoleErrors.push(Array.prototype.map.call(arguments, a =>
      a && a.message ? a.message : String(a)).join(' ')); }catch(e){}
    realErr.apply(console, arguments);
  };
})();

// ── PostgREST-ish query evaluation ─────────────────────
function applyQuery(rows, qs){
  let out = rows.slice();
  const p = new URLSearchParams(qs||'');
  for(const [k,v] of p.entries()){
    if(k==='select'||k==='order'||k==='limit'||k==='offset')continue;
    const m=/^(eq|neq|gt|gte|lt|lte|is|in|not)\.(.*)$/.exec(v);
    if(!m)continue;
    const [,op,val]=m;
    out=out.filter(r=>{
      const cell=r[k];
      switch(op){
        case 'eq': return String(cell)===val;
        case 'neq': return String(cell)!==val;
        case 'is': return val==='null'?cell==null:val==='true'?cell===true:cell===false;
        case 'in': return val.replace(/^\(|\)$/g,'').split(',').includes(String(cell));
        case 'not': {
          const im=/^in\.\((.*)\)$/.exec(val);
          if(im)return !im[1].split(',').includes(String(cell));
          const nm=/^is\.(.*)$/.exec(val);
          if(nm)return nm[1]==='true'?cell!==true:nm[1]==='null'?cell!=null:cell!==false;
          return true;
        }
        default: return true;
      }
    });
  }
  const ord=p.get('order');
  if(ord){
    const [col,dir]=ord.split('.');
    out.sort((a,b)=>{const x=a[col],y=b[col];return (x>y?1:x<y?-1:0)*(dir==='desc'?-1:1);});
  }
  const lim=p.get('limit');
  if(lim)out=out.slice(0,parseInt(lim,10));
  return out;
}

// ── RPC handlers ───────────────────────────────────────
const RPC = {
  rpc_get_my_notifications: ()=>[],
  rpc_get_own_contact_info: ()=>({email:'ariel@example.com'}),
  rpc_session_tick: ()=>({session:DATA.jex_session[0], changed:false}),
  rpc_snapshot_jxi: ()=>({id:'ih-x', value:1125, ts:TS, created_at:new Date().toISOString()}),
  rpc_snapshot_nw: ()=>({id:'nw-x', user_id:'u-stu', nw:8583, cash:8500, portfolio:250, ts:TS, created_at:new Date().toISOString()}),
  rpc_log_activity: (p)=>({id:'ac-x', type:p.p_type, description:p.p_description, ticker:p.p_ticker,
    user_id:p.p_user_id, user_name:p.p_user_name, amount:p.p_amount, ts:TS, prev_hash:'abc12345',
    entry_hash:'def67890', created_at:new Date().toISOString()}),
  rpc_expire_day_orders: ()=>({expired:[]}),
  rpc_activate_after_hours_orders: ()=>({activated:[]}),
  rpc_match_limit_order_book: ()=>({matched:false}),
  rpc_fill_limit_vs_pool: ()=>({filled:false}),
  rpc_check_email_taken: ()=>false,
  rpc_admin_list_flags: ()=>[],
  rpc_admin_list_bug_reports: ()=>[],
  rpc_admin_list_client_errors: ()=>[],
  rpc_admin_list_retention_candidates: ()=>[],
  rpc_set_own_app_status: ()=>null,
  rpc_trade_buy: (p)=>{
    const co=DATA.jex_companies.find(c=>c.ticker===p.p_ticker);
    const price=Math.round(co.price*1.01*100)/100;
    const trade={id:99, ticker:p.p_ticker, qty:p.p_qty, price, buyer_id:'u-stu', seller_id:'exchange', type:'market', ts:TS};
    DATA.jex_trades.unshift(trade);
    return {cash:8000, holdings:{ACME:20+p.p_qty, JXI:5}, price, shares_avail:co.shares_avail-p.p_qty,
      price_history:co.price_history.concat([{p:price,t:new Date().toISOString()}]), old_price:co.price, trade};
  },
};

// ── fetch interception ─────────────────────────────────
const realFetch = window.fetch.bind(window);
window.fetch = async function(url, opts){
  const u = String(url && url.url ? url.url : url);
  if(u.indexOf('/rest/v1/')===-1) return realFetch(url, opts);
  const method = (opts && opts.method) || 'GET';
  const after = u.split('/rest/v1/')[1];

  if(after.indexOf('rpc/')===0){
    const fn = after.slice(4).split('?')[0];
    let params={}; try{params=JSON.parse((opts&&opts.body)||'{}');}catch(e){}
    window.__JEX_STUB__.rpcCalls.push({fn, params});
    const h = RPC[fn];
    const body = h ? h(params) : null;
    return new Response(body===null?'':JSON.stringify(body), {status:200, headers:{'Content-Type':'application/json'}});
  }

  const [table, qs] = after.split('?');
  const rows = DATA[table] || [];
  if(method==='GET') return new Response(JSON.stringify(applyQuery(rows, qs)), {status:200, headers:{'Content-Type':'application/json'}});
  if(method==='POST'){
    let d={}; try{d=JSON.parse((opts&&opts.body)||'{}');}catch(e){}
    rows.push(d);
    return new Response(JSON.stringify([d]), {status:201, headers:{'Content-Type':'application/json'}});
  }
  if(method==='PATCH') return new Response('[]', {status:200, headers:{'Content-Type':'application/json'}});
  if(method==='DELETE') return new Response('', {status:204});
  return new Response('[]', {status:200, headers:{'Content-Type':'application/json'}});
};

// ── WebSocket stub (realtime) ──────────────────────────
window.WebSocket = function(){
  this.readyState = 1;
  this.send = function(){};
  this.close = function(){ if(this.onclose) this.onclose({code:1000, reason:'stub'}); };
  const self=this;
  setTimeout(function(){
    if(self.onopen) self.onopen({});
    if(self.onmessage) self.onmessage({data:JSON.stringify({ref:'1', event:'phx_reply', payload:{status:'ok'}})});
  }, 5);
  // Drive a realtime event so handleRealtimeUpdate + the coalescer actually run.
  setTimeout(function(){
    if(!self.onmessage) return;
    self.onmessage({data:JSON.stringify({event:'postgres_changes', payload:{data:{
      table:'jex_companies', eventType:'UPDATE',
      new:Object.assign({}, DATA.jex_companies[0], {price:13.25})}}})});
    self.onmessage({data:JSON.stringify({event:'postgres_changes', payload:{data:{
      table:'jex_trades', eventType:'INSERT',
      new:{id:100, ticker:'ACME', qty:2, price:13.25, buyer_id:'u-stu2', seller_id:'exchange', type:'market', ts:TS}}}})});
  }, 900);
};
window.WebSocket.prototype = {};

// ── supabase-js stub (auth only) ───────────────────────
window.supabase = {
  createClient: function(){
    return {
      auth: {
        getSession: async()=>({data:{session:null}, error:null}),
        signInWithPassword: async()=>({data:{session:null}, error:{message:'stub'}}),
        signInWithOAuth: async()=>({data:{}, error:null}),
        signUp: async()=>({data:{user:null, session:null}, error:{message:'stub'}}),
        signOut: async()=>({error:null}),
        onAuthStateChange: ()=>({data:{subscription:{unsubscribe(){}}}}),
        updateUser: async()=>({data:{}, error:null}),
        resetPasswordForEmail: async()=>({data:{}, error:null}),
      },
    };
  },
};

// ── Chart.js stub ──────────────────────────────────────
// The real library is a CDN script the harness cannot load. app.js only ever
// constructs charts, reads Chart.getChart(canvas) to find a stale one, and
// calls .destroy() -- so that is the whole surface we need. Configs are kept
// so a test can assert what was plotted.
const _charts = new Map();
function ChartStub(canvas, config){
  this.canvas = canvas; this.config = config; this.destroyed = false;
  this.data = config && config.data;
  this.options = config && config.options;
  this.update = function(){};
  this.resize = function(){};
  this.destroy = function(){ this.destroyed = true; _charts.delete(canvas); };
  _charts.set(canvas, this);
  window.__JEX_STUB__.charts.push(this);
}
ChartStub.getChart = function(c){ return _charts.get(c) || undefined; };
ChartStub.register = function(){};
window.Chart = ChartStub;

// ── EmailJS stub ───────────────────────────────────────
window.emailjs = {
  init: function(){},
  send: async function(){ return {status:200, text:'OK'}; },
};

// ── error capture ──────────────────────────────────────
window.addEventListener('error', e=>{
  window.__JEX_STUB__.errors.push({type:'error', message:e.message,
    source:(e.filename||'')+':'+e.lineno, stack:e.error&&e.error.stack});
});
window.addEventListener('unhandledrejection', e=>{
  const r=e.reason;
  window.__JEX_STUB__.errors.push({type:'unhandledrejection',
    message:r&&r.message?r.message:String(r), stack:r&&r.stack});
});

// Boot straight into a signed-in student.
try{ localStorage.setItem('jex-session-v3','u-stu'); }catch(e){}
})();
