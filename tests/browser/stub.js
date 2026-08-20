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
    // A name carrying a double quote and an apostrophe. Both are legal in the
    // registration form, and both land inside JS string literals in generated
    // onclick attributes -- which is where quoting goes wrong silently.
    {id:'u-quote', name:'Quinn "Q" O\'Brien', username:'quinn', role:'student', status:'approved',
     cash:7000, holdings:{ACME:4}, shorts:{}, watchlist:[], fund_units:{}, classroom_id:'c-1', created_at:now},
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
  jex_company_members:[{id:'cm-1', company_user_id:'u-co', student_id:'u-quote',
    status:'accepted', ts:TS, created_at:now}],
  jex_founder_allocations:[], jex_price_adjustments:[],
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

// ── A small server-side model ──────────────────────────
// The trade RPCs below reimplement the real Postgres functions' arithmetic --
// the same impact curve, the same 150% short collateral, the same rounding --
// so the driver can assert concrete numbers instead of "it did not throw".
// They exist to verify the CLIENT: that it applies the result it gets back,
// that its own pre-checks fire, and that the UI reflects the new state. They
// are not a substitute for testing the SQL, which runs in Postgres and is
// never executed here.
//
// The caller is read off UI.userId. The real functions derive it from
// auth.uid(); a harness has no session, and the driver switches users
// constantly, so this is the honest equivalent.
//
// It has to be a BARE reference, not window.UI: app.js declares "let UI" at
// the top level of a classic script, so UI lives in the global lexical
// environment and never appears as a window property. window.UI is undefined,
// and reading .userId off it makes every trade RPC fail in a way that looks
// like a server rejection.
const r2 = n => Math.round(n*100)/100;
const nowIso = () => new Date().toISOString();
const currentUserId = () => { try{ return UI.userId; }catch(e){ return null; } };
const caller = () => {
  const u = DATA.jex_users.find(x=>x.id===currentUserId());
  if(!u) reject('Not authenticated');
  return u;
};
const findCo = t => DATA.jex_companies.find(c=>c.ticker===t);
const priceImpact = (co, qty) => Math.min((qty/(co.shares*0.05))*0.015, 0.12);
// Rejections come back the way PostgREST reports a RAISE EXCEPTION: a non-2xx
// with a JSON body carrying `message`, which is exactly what rpcErrorMessage()
// unwraps. Returning a plain object here would silently look like success.
function reject(message){ const e = new Error(message); e.__rpcReject = message; throw e; }
function requireOpenSession(ticker){
  const sess = DATA.jex_session[0];
  if(sess.status !== 'open') reject('Trading is '+(sess.status||'closed')+'. Wait for the session to open.');
  if(DATA.jex_halts.some(h=>h.ticker===ticker)) reject(ticker+' trading is currently halted.');
}
function pushPrice(co, price){
  co.price = price;
  co.price_history = (co.price_history||[]).concat([{p:price, t:nowIso()}]);
}
let _tradeSeq = 1000;
function recordTrade(t){
  const trade = Object.assign({id:_tradeSeq++, ts:TS}, t);
  DATA.jex_trades.unshift(trade);
  return trade;
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
    const co=findCo(p.p_ticker), u=caller();
    if(!co) reject('Company not found');
    requireOpenSession(p.p_ticker);
    const old=co.price;
    const price=Math.max(0.01, r2(co.price*(1+priceImpact(co,p.p_qty))));
    const cost=r2(price*p.p_qty);
    if(u.cash < cost) reject('Not enough cash (need '+cost+')');
    if(!co.is_index_fund && co.shares_avail < p.p_qty) reject('Only '+co.shares_avail+' shares available');
    u.cash=r2(u.cash-cost);
    u.holdings=Object.assign({}, u.holdings); u.holdings[p.p_ticker]=(u.holdings[p.p_ticker]||0)+p.p_qty;
    pushPrice(co, price);
    // JXI mints on demand: units outstanding go UP, they are not drawn from a
    // fixed float. Same branch the real rpc_trade_buy takes.
    co.shares_avail = co.is_index_fund ? co.shares_avail+p.p_qty : co.shares_avail-p.p_qty;
    if(co.is_index_fund) co.shares = Math.max(co.shares, co.shares_avail);
    const trade=recordTrade({ticker:p.p_ticker, qty:p.p_qty, price, buyer_id:u.id, seller_id:'exchange', type:'market'});
    return {cash:u.cash, holdings:u.holdings, price, shares_avail:co.shares_avail,
            price_history:co.price_history, old_price:old, trade};
  },
  rpc_trade_sell: (p)=>{
    const co=findCo(p.p_ticker), u=caller();
    if(!co) reject('Company not found');
    requireOpenSession(p.p_ticker);
    const held=(u.holdings||{})[p.p_ticker]||0;
    if(held < p.p_qty) reject('You only hold '+held+' shares');
    const old=co.price;
    const price=Math.max(0.01, r2(co.price*(1-priceImpact(co,p.p_qty))));
    u.cash=r2(u.cash + r2(price*p.p_qty));
    u.holdings=Object.assign({}, u.holdings);
    u.holdings[p.p_ticker]=held-p.p_qty;
    if(!u.holdings[p.p_ticker]) delete u.holdings[p.p_ticker];
    pushPrice(co, price);
    co.shares_avail = co.is_index_fund ? co.shares_avail-p.p_qty : co.shares_avail+p.p_qty;
    const trade=recordTrade({ticker:p.p_ticker, qty:p.p_qty, price, buyer_id:'exchange', seller_id:u.id, type:'market'});
    return {cash:u.cash, holdings:u.holdings, price, shares_avail:co.shares_avail,
            price_history:co.price_history, old_price:old, trade};
  },
  rpc_trade_short: (p)=>{
    const co=findCo(p.p_ticker), u=caller();
    if(!co) reject('Company not found');
    requireOpenSession(p.p_ticker);
    const old=co.price;
    const price=Math.max(0.01, r2(co.price*(1-priceImpact(co,p.p_qty))));
    // 150% of entry value, matching jxi_short_migration.sql.
    const collateral=r2(price*p.p_qty*1.5);
    if(u.cash < collateral) reject('Need '+collateral+' collateral');
    u.cash=r2(u.cash-collateral);
    u.shorts=Object.assign({}, u.shorts);
    const prev=u.shorts[p.p_ticker];
    if(prev){
      const totalQty=prev.qty+p.p_qty;
      u.shorts[p.p_ticker]={qty:totalQty,
        avgPrice:r2((prev.avgPrice*prev.qty + price*p.p_qty)/totalQty),
        collateral:r2(prev.collateral+collateral)};
    } else {
      u.shorts[p.p_ticker]={qty:p.p_qty, avgPrice:price, collateral};
    }
    pushPrice(co, price);
    const trade=recordTrade({ticker:p.p_ticker, qty:p.p_qty, price, buyer_id:'short', seller_id:u.id, type:'short'});
    return {cash:u.cash, shorts:u.shorts, price, shares_avail:co.shares_avail,
            price_history:co.price_history, old_price:old, trade};
  },
  rpc_trade_cover_short: (p)=>{
    const co=findCo(p.p_ticker), u=caller();
    if(!co) reject('Company not found');
    requireOpenSession(p.p_ticker);
    const sh=(u.shorts||{})[p.p_ticker];
    if(!sh || sh.qty < p.p_qty) reject('You only have '+((sh&&sh.qty)||0)+' shorted');
    const old=co.price;
    const price=Math.max(0.01, r2(co.price*(1+priceImpact(co,p.p_qty))));
    const released=r2(sh.collateral * (p.p_qty/sh.qty));
    const pnl=r2((sh.avgPrice - price) * p.p_qty);
    u.cash=r2(u.cash + released + pnl);
    u.shorts=Object.assign({}, u.shorts);
    if(sh.qty === p.p_qty) delete u.shorts[p.p_ticker];
    else u.shorts[p.p_ticker]={qty:sh.qty-p.p_qty, avgPrice:sh.avgPrice, collateral:r2(sh.collateral-released)};
    pushPrice(co, price);
    const trade=recordTrade({ticker:p.p_ticker, qty:p.p_qty, price, buyer_id:u.id, seller_id:'cover', type:'cover'});
    return {cash:u.cash, shorts:u.shorts, price, shares_avail:co.shares_avail,
            price_history:co.price_history, old_price:old, pnl, trade};
  },
  rpc_toggle_watchlist: (p)=>{
    const u=caller();
    const wl=(u.watchlist||[]).slice();
    const i=wl.indexOf(p.p_ticker);
    if(i>=0) wl.splice(i,1); else wl.push(p.p_ticker);
    u.watchlist=wl;
    return {watchlist:wl};
  },
  rpc_place_limit_order: (p)=>{
    const u=caller();
    requireOpenSession(p.p_ticker);
    const order={id:'lo-'+(_tradeSeq++), user_id:u.id, ticker:p.p_ticker, side:p.p_side,
      qty:p.p_qty, limit_price:p.p_limit_price, status:'open', order_type:p.p_order_type||'gtc',
      fund_id:p.p_fund_id||null, created_at:nowIso()};
    DATA.jex_limit_orders.push(order);
    return {order};
  },
  rpc_cancel_limit_order: (p)=>{
    const o=DATA.jex_limit_orders.find(x=>x.id===p.p_order_id);
    if(!o) reject('Order not found');
    if(o.user_id!==(caller()||{}).id) reject('That is not your order');
    o.status='cancelled';
    return {cancelled:true, order:o};
  },
  // ── The instructor's own daily workflow ──────────────
  rpc_admin_save_session: (p)=>{
    Object.assign(DATA.jex_session[0], p.p_data||{});
    return {session: DATA.jex_session[0]};
  },
  rpc_push_notification: (p)=>{
    const rec={id:'nt-'+(_tradeSeq++), user_id:p.p_user_id, type:p.p_type, message:p.p_message,
      ticker:p.p_ticker||null, read:false, ts:TS, created_at:nowIso()};
    DATA.jex_notifications.push(rec);
    return rec;
  },
  rpc_push_notification_all: (p)=>{
    const made=[];
    for(const u of DATA.jex_users){
      if((p.p_exclude_ids||[]).includes(u.id)) continue;
      const rec={id:'nt-'+(_tradeSeq++), user_id:u.id, type:p.p_type, message:p.p_message,
        ticker:p.p_ticker||null, read:false, ts:TS, created_at:nowIso()};
      DATA.jex_notifications.push(rec); made.push(rec);
    }
    return made;
  },
  rpc_record_session_open_prices: ()=>{
    const m={};
    DATA.jex_companies.forEach(c=>{m[c.ticker]=c.price;});
    DATA.jex_session[0].session_open_prices=m;
    // The client does Object.assign(DB.session, r.session), so the whole row
    // has to come back, not just the field that changed.
    return {session:DATA.jex_session[0]};
  },
  rpc_post_session_recap: (p)=>{
    const rec={id:'min-'+(_tradeSeq++), type:'session_recap', title:p.p_title, body:p.p_body,
      author_name:(caller()||{}).name||'Admin', ts:TS, created_at:nowIso()};
    DATA.jex_minutes.unshift(rec);
    return rec;
  },
  rpc_post_minutes: (p)=>{
    const rec={id:'min-'+(_tradeSeq++), type:'minutes', title:p.p_title, body:p.p_body,
      author_name:(caller()||{}).name||'Secretary', ts:TS, created_at:nowIso()};
    DATA.jex_minutes.unshift(rec);
    return rec;
  },
  rpc_post_official_notice: (p)=>{
    const rec={id:'a-'+(_tradeSeq++), title:p.p_title, body:p.p_body, level:'notice',
      author_name:(caller()||{}).name||'Secretary', ts:TS, created_at:nowIso()};
    DATA.jex_announcements.unshift(rec);
    return rec;
  },
  rpc_post_announcement: (p)=>{
    const rec={id:'a-'+(_tradeSeq++), title:p.p_title, body:p.p_body, level:p.p_level||'info',
      author_name:(caller()||{}).name||'Admin', ts:TS, created_at:nowIso()};
    DATA.jex_announcements.unshift(rec);
    return rec;
  },
  rpc_mark_notifications_read: ()=>{
    const id=currentUserId();
    DATA.jex_notifications.forEach(n=>{ if(n.user_id===id) n.read=true; });
    return null;
  },
  rpc_expire_day_orders: ()=>({expired:[]}),
  approve_registration: (p)=>{
    const r=DATA.jex_pending.find(x=>x.id===p.p_pending_id);
    if(!r) reject('This registration was already approved');
    const u={id:'u-new-'+(_tradeSeq++), name:r.name, username:r.username, role:r.role,
      status:'approved', cash:p.p_starting_cash, holdings:{}, shorts:{}, watchlist:[],
      fund_units:{}, classroom_id:p.p_classroom_id||null, created_at:nowIso()};
    DATA.jex_users.push(u);
    DATA.jex_pending = DATA.jex_pending.filter(x=>x.id!==p.p_pending_id);
    return u;
  },
  rpc_review_ipo: (p)=>{
    const a=DATA.jex_ipo_applications.find(x=>x.id===p.p_id);
    if(!a) reject('Application not found');
    if(a.status!=='pending') reject('This application was already reviewed');
    a.status = p.p_approve ? 'approved' : 'rejected';
    if(!p.p_approve) return {approved:false, application:a};
    const owner={id:'u-ipo-'+(_tradeSeq++), name:a.name, username:a.ticker.toLowerCase(),
      role:'company', status:'approved', cash:0, holdings:{}, shorts:{}, watchlist:[],
      fund_units:{}, created_at:nowIso()};
    DATA.jex_users.push(owner);
    const co={id:'c-'+a.ticker, ticker:a.ticker, name:a.name, price:a.price, shares:a.shares,
      shares_avail:a.shares, status:'listed', owner_id:owner.id, description:a.description,
      price_history:[{p:a.price, t:nowIso()}], financials:[], index_base_adjust:1, created_at:nowIso()};
    DATA.jex_companies.push(co);
    return {approved:true, name:a.name, ticker:a.ticker, company:co, owner, application:a};
  },
  rpc_review_dilution: (p)=>{
    const a=DATA.jex_dilution_applications.find(x=>x.id===p.p_app_id);
    if(!a) reject('Application not found');
    if(a.status!=='pending') reject('This application was already reviewed');
    a.status = p.p_approve ? 'approved' : 'rejected';
    if(!p.p_approve) return {approved:false, application:a};
    const co=findCo(a.ticker);
    const newShares=co.shares + a.new_shares;
    // Price adjusts down proportionally; the index is held flat by
    // index_base_adjust, exactly as the shipped migration does it.
    const price=Math.max(0.01, r2(co.price * co.shares / newShares));
    const adj=(co.index_base_adjust||1) * (co.shares/newShares);
    co.shares=newShares; co.shares_avail=co.shares_avail + a.new_shares;
    co.index_base_adjust=adj;
    pushPrice(co, price);
    return {approved:true, application:a, company:co, price, shares:newShares,
            shares_avail:co.shares_avail, price_history:co.price_history, index_base_adjust:adj};
  },
  rpc_cast_vote: (p)=>{
    const u=caller();
    const v=DATA.jex_votes.find(x=>x.id===p.p_vote_id);
    if(!v) reject('Vote not found');
    if(DATA.jex_vote_ballots.some(b=>b.vote_id===p.p_vote_id&&b.voter_id===u.id)) reject('You have already voted');
    const power=(u.holdings||{})[v.parent_ticker]||0;
    if(power<=0) reject('You have no voting shares in this company');
    const ballot={id:'b-'+(_tradeSeq++), vote_id:p.p_vote_id, voter_id:u.id, choice:p.p_choice,
      voting_power:power, ts:TS, created_at:nowIso()};
    DATA.jex_vote_ballots.push(ballot);
    return ballot;
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
    let body = null;
    if(h){
      try{ body = h(params); }
      catch(e){
        if(e && e.__rpcReject)
          return new Response(JSON.stringify({message:e.__rpcReject, code:'P0001'}),
            {status:400, headers:{'Content-Type':'application/json'}});
        throw e;
      }
    }
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

// ── Scenarios ──────────────────────────────────────────
// The seeded exchange above is a mid-semester classroom. These transforms
// produce the states that actually break render code: the empty exchange the
// app is in on the first day of class, a closed session, a halted ticker, a
// student who has never traded, and a company with share classes.
const SCENARIO = (new URLSearchParams(location.search).get('scenario')) || 'default';
window.__JEX_STUB__.scenario = SCENARIO;
const SCENARIOS = {
  default: function(){},

  // Day one: the chairman has set up the exchange and nothing has happened
  // yet. Every "latest", "first", "max" and "average" in a render path is
  // reading an empty array here.
  empty: function(){
    DATA.jex_companies.length = 0;
    DATA.jex_trades.length = 0;
    DATA.jex_users = DATA.jex_users.filter(u=>u.role!=='company');
    DATA.jex_users.forEach(u=>{u.holdings={};u.shorts={};u.watchlist=[];u.fund_units={};});
    for(const t of ['jex_news','jex_announcements','jex_dividends','jex_buybacks','jex_votes',
                    'jex_limit_orders','jex_ipo_applications','jex_dilution_applications',
                    'jex_nw_history','jex_index_history','jex_funds','jex_activity',
                    'jex_snapshots','jex_classrooms','jex_pending'])
      DATA[t].length = 0;
    DATA.jex_session[0].session_open_prices = {};
    DATA.jex_session[0].status = 'closed';
  },

  // Trading closed. Buy/sell controls must render as disabled rather than
  // throwing, and the session banner must say so.
  closed: function(){
    DATA.jex_session[0].status = 'closed';
    DATA.jex_session[0].label = 'Market closed';
  },

  // A halted ticker plus a live circuit-breaker cooldown.
  halted: function(){
    DATA.jex_halts.push({id:'h-1', ticker:'ACME', reason:'Circuit breaker', ts:TS, created_at:now});
    DATA.jex_session[0].circuit_cooldowns = {BETA: Date.now()+120000};
  },

  // Someone who joined today: no holdings, no shorts, no history, no trades,
  // no net-worth snapshots. Every chart and every average has one row or none.
  newstudent: function(){
    const u = DATA.jex_users.find(x=>x.id==='u-stu');
    u.holdings={}; u.shorts={}; u.watchlist=[]; u.fund_units={};
    u.cash = 10000; u.classroom_id = null;
    DATA.jex_trades.length = 0;
    DATA.jex_nw_history.length = 0;
    DATA.jex_limit_orders.length = 0;
    DATA.jex_dividends.length = 0;
  },

  // A company that has been split into share classes, which is the one case
  // where a ticker on screen is not a row in jex_companies by itself.
  classes: function(){
    DATA.jex_share_classes.push(
      {id:'sc-1', ticker:'ACME.A', parent_ticker:'ACME', class:'A', votes_per_share:10,
       restricted:false, whitelist:[], ts:TS, created_at:now});
    DATA.jex_companies.push(
      {id:'c-acme-a', ticker:'ACME.A', name:'Acme Corp Class A', price:14, shares:200,
       shares_avail:150, status:'listed', owner_id:'u-co', description:'Voting class',
       price_history:[{p:14,t:now}], financials:[], index_base_adjust:1, created_at:now});
    DATA.jex_users.find(u=>u.id==='u-stu').holdings['ACME.A'] = 3;
  },

  // Values that are legal in the database but that render code tends to
  // assume away: nulls where a string is expected, a company with no price
  // history at all, an empty name, a zero price, a negative balance.
  ragged: function(){
    DATA.jex_companies.push(
      {id:'c-null', ticker:'NUL', name:'', price:0, shares:0, shares_avail:0, status:'listed',
       owner_id:null, description:null, price_history:null, financials:null, created_at:now});
    DATA.jex_users.find(u=>u.id==='u-stu').cash = -25.5;
    DATA.jex_users.push({id:'u-noname', name:null, username:null, role:'student',
      status:'approved', cash:0, holdings:null, shorts:null, watchlist:null,
      fund_units:null, created_at:now});
    DATA.jex_trades.push({id:3, ticker:'NUL', qty:0, price:0, buyer_id:null, seller_id:null,
      type:null, ts:null});
    DATA.jex_news.push({id:'n-null', ticker:'NUL', headline:'', body:null,
      company_name:null, ts:null, created_at:now});
  },
};
(SCENARIOS[SCENARIO] || SCENARIOS.default)();

// Boot straight into a signed-in student.
try{ localStorage.setItem('jex-session-v3','u-stu'); }catch(e){}
})();
