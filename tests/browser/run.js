#!/usr/bin/env node
// Boots the REAL app.js in headless Chromium against tests/browser/stub.js and
// drives it through every page and several interactions, failing on any
// uncaught error, unhandled rejection, or console error.
//
//   node tests/browser/run.js            run it
//   node tests/browser/run.js --keep     leave the generated page in place
//
// Everything else under tests/ verifies extracted functions in Node. This is
// the only harness that runs the actual page: real DOM, real render(), real
// event handlers, real boot path. Static analysis cannot catch a TypeError in
// a render branch nobody executed.
//
// The result comes back over an XHR POST to this script's own static server
// rather than --dump-dom + --virtual-time-budget. --dump-dom fires on the load
// event, which is too early for an async driver, and the app's own 3s poll
// keeps virtual time from ever draining. The stub only patches window.fetch,
// so XMLHttpRequest is a clean channel the app cannot interfere with.
const {spawn} = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http');

const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find(p=>{try{fs.accessSync(p);return true;}catch(e){return false;}});
if(!CHROME){console.error('No Chromium found under /opt/pw-browsers');process.exit(2);}

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8731;
const WALL_TIMEOUT_MS = 150000;
// The in-page watchdog fires first, so a stall is reported with the name of
// the step that hung rather than as a bare runner timeout.
const DRIVER_WATCHDOG_MS = 100000;

// One result slot per browser run; main() re-arms it before each scenario.
let resolveResult = null;
function armResult(){ return new Promise(r=>{resolveResult=r;}); }

const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
const server = http.createServer((req,res)=>{
  if(req.method==='POST' && req.url==='/__result'){
    let body='';
    req.on('data',c=>{body+=c;});
    req.on('end',()=>{res.writeHead(200);res.end('ok');resolveResult(body);});
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if(p==='/')p='/tests/browser/harness.html';
  const f = path.join(ROOT, p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('nope');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
});

// The scenario script runs INSIDE the page.
// Shared preamble for every driver: the step runner and DOM readers.
const PRELUDE = `
  const out = {steps:[], errors:[], notes:[], consoleErrors:[]};
  // Exposed so the wrapper can post partial progress if a step hangs -- a
  // driver that stalls used to report nothing at all, which says only "it
  // broke somewhere" and costs a bisect to turn into a location.
  window.__OUT__ = out;
  out.startedAt = Date.now();
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const stub = window.__JEX_STUB__;
  // ── the rate limiter, between steps ──────────────────────
  //
  // checkRateLimit guards nine different actions now -- buys, sells, shorts,
  // covers, limit orders, buybacks, fund deposits and withdrawals, dividends
  // -- and they all share ONE budget of order_rate_limit (10) per minute.
  // That is right for a student and wrong for a driver: a scenario that
  // exercises all nine would spend most of its runtime asleep, and would then
  // fail on the budget rather than on anything about the app.
  //
  // So each step starts with the limiter's memory wiped. Within a step it is
  // fully live -- which is what makes 'back-to-back orders are rate limited'
  // below a real test, since both of its orders happen inside one step.
  // The limiter's own three layers are covered exhaustively, against a fake
  // clock, in tests/test_rate_limit.js.
  //
  // Reached through new Function because _orderTimestamps and _lastOrderTime
  // are top-level const in a classic script, and top-level const/let are NOT
  // window properties. That trap has cost this harness two debugging rounds
  // already, so this asserts it actually got the objects instead of quietly
  // resetting nothing and leaving the sleeps to carry the run.
  let __limiter = null;
  try { __limiter = new Function('return {ts:_orderTimestamps, last:_lastOrderTime}')(); }
  catch(e){ out.errors.push('cannot reach the rate limiter state: '+((e&&e.message)||e)); }
  if(__limiter && (!__limiter.ts || !__limiter.last))
    out.errors.push('rate limiter state resolved to something unexpected');
  const resetLimiter = () => {
    if(!__limiter) return;
    for(const k of Object.keys(__limiter.ts)) delete __limiter.ts[k];
    for(const k of Object.keys(__limiter.last)) delete __limiter.last[k];
  };

  const step = async (name, fn) => {
    out.inFlight = name;
    resetLimiter();
    const t0 = Date.now();
    try { const r = await fn(); out.steps.push({name, ok:true, info:(r===undefined?'':String(r))+' ['+(Date.now()-t0)+'ms]'}); }
    catch(e){ out.steps.push({name, ok:false, info:(e && e.message)||String(e), stack:e && e.stack}); }
    out.inFlight = null;
  };
  const appText = () => (document.getElementById('app')||{}).textContent || '';
  const appHtml = () => (document.getElementById('app')||{}).innerHTML || '';

  // ── inline-handler audit ────────────────────────────────
  // Nearly every control in JEX is an onclick="..." string built by
  // concatenating HTML, so a handler can be broken in two ways no unit test
  // and no amount of reading will catch: the attribute can fail to PARSE
  // (a name with an apostrophe closing the JS string early, a stray quote
  // from user data), or it can call a function that no longer exists (renamed,
  // deleted, or never defined). Both are silent -- the button just does
  // nothing, or throws into the console, when a student presses it.
  //
  // This parses every handler attribute in the rendered DOM and resolves the
  // functions it calls, without firing any of them, so it is safe to run over
  // every page in every scenario.
  const HANDLER_ATTRS = ['onclick','oninput','onchange','onsubmit','onkeydown','onkeyup','onblur','onfocus'];
  const JS_BUILTINS = new Set(['if','for','while','switch','catch','return','typeof','function','new',
    'String','Number','Boolean','Array','Object','JSON','Math','Date','parseInt','parseFloat','isNaN',
    'alert','confirm','prompt','setTimeout','setInterval','encodeURIComponent','decodeURIComponent',
    'Promise','RegExp','Set','Map','Error','console','window','document','event','this']);
  // window[fn] is NOT the right test: app.js is a classic script, so its
  // top-level const/let/function names live in the global LEXICAL environment,
  // which inline handlers resolve against but which never appears as a window
  // property. get -- declared as "const get=id=>document.getElementById(id)"
  // -- is reachable from every onclick in the app and invisible on window.
  // Evaluating "typeof <name>" in global scope consults both records.
  const _resolved = new Map();
  const resolvesGlobally = fn => {
    if(_resolved.has(fn)) return _resolved.get(fn);
    let ok = false;
    try{ ok = new Function('return typeof '+fn)() === 'function'; }catch(e){ ok = false; }
    _resolved.set(fn, ok);
    return ok;
  };
  const HANDLER_SEL = HANDLER_ATTRS.map(a=>'['+a+']').join(',');
  const _seenHandlers = new Set();   // the same attribute string recurs on
                                     // every render; analyse each one once
  const auditHandlers = (where, bad) => {
    const root = document.getElementById('app'); if(!root) return 0;
    let checked=0;
    for(const el of root.querySelectorAll(HANDLER_SEL)){
      for(const attr of HANDLER_ATTRS){
        const code = el.getAttribute(attr);
        if(code===null) continue;
        const key = attr+'\\u0000'+code;
        if(_seenHandlers.has(key)) continue;
        _seenHandlers.add(key);
        checked++;
        try{ new Function('event', code); }
        catch(e){ bad.push(where+' <'+el.tagName.toLowerCase()+' '+attr+'> DOES NOT PARSE: '+
          ((e&&e.message)||e)+' -- '+code.slice(0,120)); continue; }
        // Resolve every called identifier that is not a member access
        // (x.foo()), not a local, and not a builtin.
        const re = /(^|[^.\\w$'"])([A-Za-z_$][\\w$]*)\\s*\\(/g;
        let m;
        while((m = re.exec(code))){
          const fn = m[2];
          if(JS_BUILTINS.has(fn)) continue;
          if(!resolvesGlobally(fn))
            bad.push(where+' <'+el.tagName.toLowerCase()+' '+attr+'> calls missing '+fn+'() -- '+code.slice(0,120));
        }
      }
    }
    return checked;
  };
`;

// Every page, every tab, every role -- in whatever state the scenario left the
// exchange in. Used for the variant scenarios (empty exchange, closed session,
// halted ticker, brand-new student, share classes, ragged nulls), where the
// question is not "does the feature work" but "does anything throw".
const SWEEP_DRIVER = `
(async () => {
${PRELUDE}
  await sleep(1800);
  const NAV = ['market','exchange','portfolio','orders','trades','funds','news',
               'notifications','leaderboard','settings','mystock','admin'];
  const PORT = ['holdings','shorts','watchlist','dividends','history','nwchart'];
  const CPT  = ['overview','trade','news','votes','shareholders','team','financials',
                'dividends','alerts','trades'];
  const MST  = ['stock','founders','classes','votes','news','financials','dividends','buyback','dilution'];
  const ADT  = ['dashboard','session','announcements','registrations','passwords','ipo','dilution',
                'classes','founder_allocs','balances','users','listed','news','activity','flags',
                'bug_reports','retention','snapshots','client_errors','trades','cashflow',
                'dividends_audit','price_adj_log','budget_warnings','minutes','notices',
                'shareholders','votes_all'];

  const T0 = Date.now();
  const el = () => (Date.now()-T0)+'ms';
  await step('boot leaves the splash', ()=>{
    const t = appText();
    if(/Connecting to (JEX|exchange)/.test(t)) throw new Error('still on the splash');
    if(!t.trim()) throw new Error('#app is empty');
    return el()+' -- '+t.replace(/\\s+/g,' ').trim().slice(0,40);
  });

  // Each render is tried individually so one throwing page does not hide the
  // rest -- the point of a sweep is the complete list of what breaks in this
  // state, not the first thing that breaks.
  let handlersChecked = 0;
  const handlerBad = [];
  const tryRender = (where, bad) => {
    try{
      render();
      if(!document.getElementById('app').innerHTML.trim()) bad.push(where+': #app went blank');
      handlersChecked += auditHandlers(where, handlerBad);
    }catch(e){ bad.push(where+': '+((e&&e.message)||e)+(e&&e.stack?'  @ '+String(e.stack).split('\\n')[1].trim():'')); }
  };

  const users = DB.users.map(u=>u.id);
  for(const uid of users){
    const role = (DB.users.find(u=>u.id===uid)||{}).role;
    await step('sweep every page as '+role+' ('+uid+')', ()=>{
      UI.userId = uid; UI.companyPage=null; UI.fundPage=null;
      const bad=[]; let n=0;
      for(const nav of NAV){
        UI.navTab = nav;
        if(nav==='portfolio'){ for(const p of PORT){ UI.portfolioTab=p; tryRender(nav+'/'+p,bad); n++; } UI.portfolioTab='holdings'; }
        else if(nav==='admin'){ for(const a of ADT){ UI.adminTab=a; tryRender(nav+'/'+a,bad); n++; } UI.adminTab='dashboard'; }
        else if(nav==='mystock'){ for(const m of MST){ UI.companyTab=m; tryRender(nav+'/'+m,bad); n++; } UI.companyTab='stock'; }
        else { tryRender(nav,bad); n++; }
      }
      UI.navTab='market';
      if(bad.length) throw new Error(bad.length+'/'+n+' renders failed -- '+bad.slice(0,6).join(' | '));
      return n+' renders, '+el();
    });
  }

  await step('every listed ticker opens, on every tab', ()=>{
    UI.userId = (DB.users.find(u=>u.role==='student')||DB.users[0]).id;
    UI.navTab='market';
    const bad=[]; let n=0;
    for(const co of DB.companies){
      for(const t of CPT){ UI.companyPage=co.ticker; UI.companyPageTab=t; tryRender(co.ticker+'/'+t,bad); n++; }
    }
    UI.companyPage=null; UI.companyPageTab='overview'; render();
    if(bad.length) throw new Error(bad.length+'/'+n+' renders failed -- '+bad.slice(0,6).join(' | '));
    return n+' renders across '+DB.companies.length+' tickers';
  });

  await step('every fund page opens', ()=>{
    UI.navTab='funds';
    for(const f of DB.funds||[]){ UI.fundPage=f.id; render(); }
    UI.fundPage=null; render();
    return (DB.funds||[]).length+' funds';
  });

  await step('signed-out views still render', ()=>{
    const keep=UI.userId; UI.userId=null;
    for(const lv of ['select','register','forgot-email','forgot-secq','forgot-newpw','recover-pw']){
      UI.loginView=lv; render();
      if(!appText().trim()) throw new Error('blank login view '+lv);
    }
    UI.loginView='select'; UI.userId=keep; render();
  });

  await step('a realtime repaint in this state does not throw', ()=>{
    renderBackground(); renderBackground();
  });

  await step('every inline handler parses and resolves', ()=>{
    const uniq = [...new Set(handlerBad)];
    if(uniq.length) throw new Error(uniq.length+' broken handler(s) of '+handlersChecked+
      ' checked -- '+uniq.slice(0,8).join('  ||  '));
    return handlersChecked+' handlers across every page';
  });

  await sleep(300);
  out.errors = stub.errors;
  out.consoleErrors = stub.consoleErrors;
  return out;
})()
`;

const DRIVER = `
(async () => {
${PRELUDE}
  await sleep(2200);   // boot + the stub's realtime events at t=900ms

  await step('boot leaves the splash', ()=>{
    const t = appText();
    if(/Connecting to (JEX|exchange)/.test(t)) throw new Error('still on the splash');
    if(!t.trim()) throw new Error('#app is empty');
    return t.replace(/\\s+/g,' ').trim().slice(0,40);
  });
  await step('signed in as the seeded student', ()=>{
    if(UI.userId !== 'u-stu') throw new Error('UI.userId='+UI.userId);
  });
  await step('company data loaded', ()=>{
    if(!DB.companies.length) throw new Error('no companies');
    return DB.companies.length+' companies';
  });

  // Every routed page must render without throwing.
  for(const tab of ['market','exchange','portfolio','orders','trades','funds','news','notifications','leaderboard','settings']){
    await step('render page: '+tab, ()=>{
      UI.navTab = tab; UI.companyPage = null; UI.fundPage = null;
      render();
      const t = appText();
      if(!t.trim()) throw new Error('blank page');
      return t.length+' chars';
    });
  }

  // Portfolio sub-tabs.
  for(const pt of ['holdings','shorts','watchlist','dividends','history','nwchart']){
    await step('portfolio tab: '+pt, ()=>{
      UI.navTab='portfolio'; UI.portfolioTab=pt; render();
      if(!appText().trim()) throw new Error('blank portfolio tab');
      return appText().length+' chars';
    });
  }
  await step('reset portfolio tab', ()=>{ UI.portfolioTab='holdings'; });

  // A fund's own page.
  await step('fund page renders', ()=>{
    UI.navTab='funds'; UI.fundPage='f-1'; render();
    if(!appText().includes('Test Growth Fund')) throw new Error('fund name missing');
    UI.fundPage=null;
  });

  // Every admin tab, signed in as the role that actually owns it.
  // renderAdmin() silently rewrites UI.adminTab to the role's first tab when
  // the tab is not in that role's set, so driving them all as the chairman
  // renders the Dashboard 26 times and proves nothing. Each tab is asserted
  // to have STAYED selected.
  const ADMIN_ROLES = {
    'u-chair': ['dashboard','session','announcements','registrations','passwords','ipo','dilution',
                'classes','founder_allocs','balances','users','listed','news','activity','flags',
                'bug_reports','retention','snapshots','client_errors'],
    'u-pres':  ['dashboard','session','announcements','balances','passwords','news','activity'],
    'u-treas': ['balances','cashflow','dividends_audit','price_adj_log','budget_warnings','activity','client_errors'],
    'u-sec':   ['announcements','minutes','notices','shareholders','votes_all','news'],
    'u-comp':  ['dashboard','balances','trades','activity','listed','news','announcements','flags','client_errors'],
  };
  for(const uid of Object.keys(ADMIN_ROLES)){
    for(const at of ADMIN_ROLES[uid]){
      await step('admin tab ['+uid+']: '+at, ()=>{
        UI.userId=uid; UI.navTab='admin'; UI.companyPage=null; UI.adminTab=at; render();
        if(UI.adminTab!==at) throw new Error('tab was rewritten to '+UI.adminTab+' -- not in this role\\'s set');
        const t = appText();
        if(!t.trim()) throw new Error('blank admin tab');
        if(/Admin access required/.test(t)) throw new Error('role rejected from the admin page');
        return t.length+' chars';
      });
    }
  }
  await step('a student cannot render the admin page', ()=>{
    UI.userId='u-stu'; UI.navTab='admin'; render();
    if(!/Admin access required/.test(appText())) throw new Error('a student got admin content');
  });
  await step('admins see the ordinary pages too', ()=>{
    UI.userId='u-chair';
    for(const t of ['market','portfolio','trades','exchange','leaderboard','settings','orders','notifications','funds','news']){
      UI.navTab=t; render(); if(!appText().trim()) throw new Error('blank '+t+' as chairman');
    }
    UI.navTab='market';
  });
  await step('back to student', ()=>{ UI.userId='u-stu'; UI.navTab='market'; UI.adminTab='dashboard'; render(); });

  // Company page + every one of its real tabs (UI.companyPageTab -- NOT
  // UI.companyTab, which belongs to the company-account 'mystock' page).
  await step('open a company page', ()=>{ UI.navTab='market'; UI.companyPage='ACME'; render();
    if(!appText().includes('Acme')) throw new Error('company page missing name'); });
  for(const ct of ['overview','trade','news','votes','shareholders','team','financials','dividends','alerts','trades']){
    await step('company page tab: '+ct, ()=>{
      UI.companyPageTab=ct; render();
      if(!appText().trim()) throw new Error('blank');
      return appText().length+' chars';
    });
  }
  // The index fund has no owner, no news and no votes -- those tabs must
  // redirect rather than dereference a null company.
  for(const ct of ['overview','trade','shareholders','trades','news','votes','team','financials','dividends','alerts']){
    await step('JXI page tab: '+ct, ()=>{
      UI.companyPage='JXI'; UI.companyPageTab=ct; render();
      if(!appText().includes('JXI')) throw new Error('JXI page missing');
      return appText().length+' chars';
    });
  }
  await step('reset to overview', ()=>{ UI.companyPage=null; UI.companyPageTab='overview'; UI.navTab='market'; render(); });

  // The company account's own management page and every tab on it.
  await step('company account view', ()=>{
    UI.userId='u-co'; UI.navTab='mystock'; UI.companyPage=null; render();
    if(!appText().trim()) throw new Error('blank mystock'); });
  for(const ct of ['stock','founders','classes','votes','news','financials','dividends','buyback','dilution']){
    await step('mystock tab: '+ct, ()=>{
      UI.companyTab=ct; render();
      if(!appText().trim()) throw new Error('blank');
      return appText().length+' chars';
    });
  }
  await step('back to student again', ()=>{ UI.userId='u-stu'; UI.navTab='market'; UI.companyPage=null; UI.companyTab='stock'; render(); });

  // XSS: the seeded student name and vote question contain payloads.
  await step('user-typed payload is not live HTML', ()=>{
    UI.navTab='leaderboard'; render();
    const h = appHtml();
    if(/<script>alert\\(1\\)<\\/script>/.test(h)) throw new Error('unescaped <script> in leaderboard');
    if(document.querySelector('#app script')) throw new Error('a <script> element was injected');
    if(!/Bea/.test(appText())) throw new Error('payload user missing from leaderboard entirely');
    return 'escaped';
  });
  await step('vote question payload escaped', ()=>{
    UI.navTab='market'; UI.companyPage='ACME'; UI.companyTab='votes'; render();
    if(document.querySelector('#app script')) throw new Error('script element injected via vote');
    if(document.querySelector('#app b')) throw new Error('<b> from a vote question rendered as live HTML');
    UI.companyPage=null; UI.companyTab='stock';
  });
  await step('company name with quotes and & survives', ()=>{
    UI.navTab='market'; render();
    if(!appText().includes('Beta & Sons "Quoted"')) throw new Error('name mangled: '+appText().slice(0,200));
    return 'intact';
  });

  // Realtime: the stub pushed a price change + a trade at t=900ms.
  await step('realtime price update applied', ()=>{
    const co = DB.companies.find(c=>c.ticker==='ACME');
    if(co.price !== 13.25) throw new Error('price is '+co.price+', expected 13.25');
  });
  await step('realtime trade merged', ()=>{
    if(!DB.trades.some(t=>String(t.id)==='100')) throw new Error('trade 100 missing');
  });

  // Typed input must survive a background repaint. This is the regression
  // that made realtime look dead: the quantity box blocked every render.
  await step('the trade panel actually has a quantity field', ()=>{
    UI.navTab='market'; UI.companyPage='ACME'; UI.companyPageTab='trade'; render();
    const q = document.getElementById('cp-qty');
    if(!q) throw new Error('no #cp-qty on the trade tab -- inputs: '+
      Array.prototype.map.call(document.querySelectorAll('#app input'),i=>i.id||i.type).join(','));
    return 'present';
  });
  await step('typed quantity survives a realtime repaint', ()=>{
    UI.navTab='market'; UI.companyPage='ACME'; UI.companyPageTab='trade'; render();
    const q = document.getElementById('cp-qty');
    if(!q) throw new Error('no #cp-qty');
    q.value = '42';
    renderBackground();
    const after = document.getElementById('cp-qty');
    if(!after) throw new Error('cp-qty gone after repaint');
    if(after.value !== '42') throw new Error('cp-qty became '+after.value);
    after.value='';
    return 'preserved';
  });
  await step('a typed quantity does NOT block the repaint', ()=>{
    UI.navTab='market'; UI.companyPage='ACME'; UI.companyPageTab='trade'; render();
    const q = document.getElementById('cp-qty'); if(!q) throw new Error('no #cp-qty');
    q.value = '42';
    const r = userIsFillingForm();
    if(r) throw new Error('repaint blocked by an unfocused field: '+r);
    q.focus();
    if(!userIsFillingForm()) throw new Error('a FOCUSED field should still defer');
    q.blur(); q.value='';
    return 'ok';
  });

  // Draft persistence. The news tab is used rather than dilution because the
  // seeded exchange already has a PENDING dilution application, and the app
  // correctly hides the form while one is outstanding.
  await step('textarea draft survives a repaint', ()=>{
    UI.userId='u-co'; UI.navTab='mystock'; UI.companyPage=null; UI.companyTab='news'; render();
    const ta = document.getElementById('news-body');
    if(!ta) throw new Error('no #news-body on the news tab -- textareas: '+
      Array.prototype.map.call(document.querySelectorAll('#app textarea'),t=>t.id||'(none)').join(','));
    const id = ta.id;
    ta.value = 'raising capital for expansion';
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    render();
    const again = document.getElementById(id);
    if(!again) throw new Error('textarea gone');
    if(again.value !== 'raising capital for expansion') throw new Error('draft lost: '+again.value);
    again.value=''; again.dispatchEvent(new Event('input',{bubbles:true}));
    UI.userId='u-stu'; UI.navTab='market'; UI.companyTab='stock';
    return 'restored ('+id+')';
  });

  // busy(): a real click must disable then re-enable.
  await step('busy() disables and restores a button', async ()=>{
    let done=false;
    const btn=document.createElement('button'); btn.textContent='Go'; document.body.appendChild(btn);
    const p = busy(btn,'Working…',()=>new Promise(r=>setTimeout(()=>{done=true;r();},60)));
    if(btn.disabled!==true) throw new Error('not disabled during the call');
    await p;
    if(btn.disabled!==false) throw new Error('not re-enabled afterwards');
    if(btn.textContent!=='Go') throw new Error('label not restored: '+btn.textContent);
    if(!done) throw new Error('fn did not run');
    btn.remove();
    return 'ok';
  });
  await step('busy() re-enables even when the action throws', async ()=>{
    const btn=document.createElement('button'); btn.textContent='Go'; document.body.appendChild(btn);
    try{ await busy(btn,'Working…',()=>{ throw new Error('boom'); }); }catch(e){}
    if(btn.disabled!==false) throw new Error('left disabled after a throw');
    btn.remove();
    return 'ok';
  });

  // A real trade through the real code path.
  await step('a market buy applies its result', async ()=>{
    UI.userId='u-stu'; UI.navTab='market'; UI.companyPage='ACME'; UI.companyPageTab='trade'; render();
    const before = DB.trades.length;
    await placeBuy('ACME', 3);
    if(DB.trades.length <= before) throw new Error('no trade recorded');
    if(!stub.rpcCalls.some(c=>c.fn==='rpc_trade_buy')) throw new Error('rpc_trade_buy never called');
    return 'ok';
  });

  await step('charts were constructed, not skipped', ()=>{
    if(!stub.charts.length) throw new Error('no Chart was ever constructed');
    const bad = stub.charts.filter(c=>!c.config||!c.config.data);
    if(bad.length) throw new Error(bad.length+' charts built with no data');
    return stub.charts.length+' charts';
  });

  // ── The flows a student actually uses, fired for real ───────────────
  // Everything above proves pages render and handlers resolve. These call the
  // real handlers and check the arithmetic that comes back out, against a
  // stub that reimplements the server's impact curve and 150% collateral.
  const CO = () => DB.companies.find(c=>c.ticker==='ACME');
  const ME = () => DB.users.find(u=>u.id==='u-stu');
  // Tight, because the price impact of a small order is small: 5 shares of a
  // 1000-share company moves the price 0.15%, about two cents. A loose
  // tolerance here would let a REFUSED order pass as a successful one.
  const near = (a,b,tol) => Math.abs(a-b) <= (tol===undefined?0.005:tol);
  const impact = (co,qty) => Math.min((qty/(co.shares*0.05))*0.015, 0.12);
  // checkRateLimit() enforces THREE limits: a 0.8s minimum gap, at most 3
  // actions in any 5s window, and at most order_rate_limit (10) per minute.
  // It now covers every money-moving action -- buys, sells, shorts, covers,
  // limit orders, buybacks, fund deposits and withdrawals, dividends -- all
  // sharing one budget. (It used to guard only buys and sells, which meant
  // alternating buy/short walked straight around the cap.)
  //
  // Firing actions back to back is exactly what it is there to stop, so where
  // a step performs two in a row the driver paces itself rather than fighting
  // it -- 1.8s keeps a steady stream under the burst rule. ACROSS steps the
  // limiter is reset instead of slept through; see resetLimiter in PRELUDE for
  // why. Watchlist toggles and votes are still not rate limited.
  const paceOrders = () => sleep(1800);
  const clearBurstWindow = () => sleep(5200);
  // Whatever the app last told the user. Included in failures so a refused
  // order says WHY instead of just showing an unchanged number.
  const lastToast = () => ((document.getElementById('toast')||{}).textContent||'').trim();

  await step('a market buy moves cash, holdings and the price together', async ()=>{
    UI.userId='u-stu'; UI.navTab='market'; UI.companyPage='ACME'; UI.companyPageTab='trade'; render();
    const co=CO(), me=ME();
    const cash0=me.cash, held0=(me.holdings.ACME||0), avail0=co.shares_avail, p0=co.price;
    const expPrice=Math.max(0.01, Math.round(p0*(1+impact(co,5))*100)/100);
    await paceOrders();
    await placeBuy('ACME', 5);
    const c=CO(), m=ME();
    if(!near(c.price, expPrice)) throw new Error('price '+c.price+' expected '+expPrice+' -- toast: '+lastToast());
    if(m.holdings.ACME !== held0+5) throw new Error('holdings '+m.holdings.ACME+' expected '+(held0+5)+' -- toast: '+lastToast());
    if(!near(m.cash, Math.round((cash0-expPrice*5)*100)/100)) throw new Error('cash '+m.cash);
    if(c.shares_avail !== avail0-5) throw new Error('shares_avail '+c.shares_avail);
    return 'paid '+Math.round((cash0-m.cash)*100)/100+' for 5 @ '+expPrice;
  });

  await step('the new holding and price show up on the page', ()=>{
    UI.navTab='portfolio'; UI.portfolioTab='holdings'; render();
    const t=appText();
    if(!/ACME/.test(t)) throw new Error('ACME missing from holdings after buying it');
    UI.navTab='market'; UI.companyPage='ACME'; UI.companyPageTab='overview'; render();
    if(!appText().includes(String(CO().price))) throw new Error('the new price is not on the company page');
    return 'shown';
  });

  await step('selling more than you hold is refused before any RPC', async ()=>{
    const before = stub.rpcCalls.filter(c=>c.fn==='rpc_trade_sell').length;
    const cash0 = ME().cash;
    await paceOrders();
    await placeSell('ACME', 99999);
    if(stub.rpcCalls.filter(c=>c.fn==='rpc_trade_sell').length !== before)
      throw new Error('the client sent an oversized sell to the server');
    if(ME().cash !== cash0) throw new Error('cash changed on a refused sell');
    return 'refused locally';
  });

  await step('a market sell returns cash and drops the price', async ()=>{
    const co=CO(), me=ME();
    const cash0=me.cash, held0=me.holdings.ACME, p0=co.price;
    const expPrice=Math.max(0.01, Math.round(p0*(1-impact(co,3))*100)/100);
    await paceOrders();
    await placeSell('ACME', 3);
    const c=CO(), m=ME();
    if(!near(c.price, expPrice)) throw new Error('price '+c.price+' expected '+expPrice+' -- toast: '+lastToast());
    if(m.holdings.ACME !== held0-3) throw new Error('holdings '+m.holdings.ACME+' -- toast: '+lastToast());
    if(!near(m.cash, Math.round((cash0+expPrice*3)*100)/100)) throw new Error('cash '+m.cash);
    if(c.price >= p0) throw new Error('selling did not push the price down');
    return 'received '+Math.round((m.cash-cash0)*100)/100;
  });

  await step('shorting locks 150% collateral', async ()=>{
    const co=CO(), me=ME();
    const cash0=me.cash, p0=co.price;
    const expPrice=Math.max(0.01, Math.round(p0*(1-impact(co,4))*100)/100);
    const expColl=Math.round(expPrice*4*1.5*100)/100;
    await placeShort('ACME', 4);
    const m=ME();
    const sh=(m.shorts||{}).ACME;
    if(!sh) throw new Error('no short position recorded');
    if(sh.qty!==4) throw new Error('qty '+sh.qty);
    if(!near(sh.collateral, expColl)) throw new Error('collateral '+sh.collateral+' expected '+expColl);
    if(!near(m.cash, Math.round((cash0-expColl)*100)/100)) throw new Error('cash '+m.cash);
    return 'locked '+expColl;
  });

  await step('the short is visible on the portfolio page', ()=>{
    UI.navTab='portfolio'; UI.portfolioTab='shorts'; render();
    if(!/ACME/.test(appText())) throw new Error('the ACME short is not listed');
    UI.portfolioTab='holdings';
  });

  await step('covering releases the collateral and books the P&L', async ()=>{
    const me=ME(), co=CO();
    const sh=Object.assign({}, me.shorts.ACME);
    const cash0=me.cash, p0=co.price;
    const expPrice=Math.max(0.01, Math.round(p0*(1+impact(co,4))*100)/100);
    const expPnl=Math.round((sh.avgPrice-expPrice)*4*100)/100;
    await coverShort('ACME', 4);
    const m=ME();
    if(m.shorts && m.shorts.ACME) throw new Error('the short was not closed');
    const moved=Math.round((m.cash-cash0)*100)/100;
    const expMoved=Math.round((sh.collateral+expPnl)*100)/100;
    if(!near(moved, expMoved, 0.03)) throw new Error('cash moved '+moved+', expected '+expMoved);
    return 'released '+sh.collateral+' with P&L '+expPnl;
  });

  await step('covering more than you are short is refused before any RPC', async ()=>{
    const before = stub.rpcCalls.filter(c=>c.fn==='rpc_trade_cover_short').length;
    await coverShort('ACME', 10);
    if(stub.rpcCalls.filter(c=>c.fn==='rpc_trade_cover_short').length !== before)
      throw new Error('the client sent a cover with no position to the server');
    return 'refused locally';
  });

  // The rate limiter is the thing standing between one enthusiastic student
  // and a hundred orders, so it gets its own check rather than only being
  // worked around above.
  // ── the price band ────────────────────────────────────────
  //
  // The band was enforced on every path that pushes a price UP and no path
  // that pushes one DOWN. These drive a price into the floor for real rather
  // than asserting the rule is present somewhere.
  //
  // Severity, stated accurately: the circuit breaker (symmetric, 20%) already
  // halted a stock that had moved too far, and trips before the 30% band
  // would -- so the downside was never unbounded. The band is PREVENTIVE
  // where the breaker is REACTIVE, and it was the preventive half that a
  // single large sell could overshoot straight through.
  const bandOf = t => {
    const s=stub.data.jex_session[0], open=s.session_open_prices[t];
    return {lower:Math.round(open*(1-s.price_band_pct/100)*100)/100,
            upper:Math.round(open*(1+s.price_band_pct/100)*100)/100, open};
  };

  // The circuit breaker has to be out of the way for any of this. It halts at
  // 20% from session open and the band sits at 30%, so parking a price ON the
  // floor is by definition past the breaker -- the first run of these steps
  // halted ACME and then cascaded into six later, unrelated failures.
  //
  // That is the breaker behaving exactly right, and it is worth stating what
  // it means: in normal operation a stock reaches the band's floor only when
  // the breaker is disabled or set wider than the band. The band is the
  // backstop, not the first line.
  const withoutBreaker = async fn => {
    const s=stub.data.jex_session[0], saved=s.circuit_breaker_pct;
    s.circuit_breaker_pct=null; DB.session.circuit_breaker_pct=null;
    try{ return await fn(); }
    finally{
      s.circuit_breaker_pct=saved; DB.session.circuit_breaker_pct=saved;
      stub.data.jex_halts.length=0; DB.halts.length=0;
    }
  };
  // Everything these steps touch, put back afterwards, so a later step never
  // inherits a price parked at the floor or a hollowed-out holding.
  let bandSaved=null;
  const saveBandState = () => {
    const acme=stub.data.jex_companies.find(c=>c.ticker==='ACME');
    const beta=stub.data.jex_companies.find(c=>c.ticker==='BETA');
    const u=stub.data.jex_users.find(x=>x.id==='u-stu');
    bandSaved={acme:acme.price, beta:beta.price, avail:acme.shares_avail,
               holdings:Object.assign({},u.holdings), shorts:JSON.parse(JSON.stringify(u.shorts||{})),
               cash:u.cash};
  };
  const restoreBandState = () => {
    if(!bandSaved)return;
    const acme=stub.data.jex_companies.find(c=>c.ticker==='ACME');
    const beta=stub.data.jex_companies.find(c=>c.ticker==='BETA');
    const u=stub.data.jex_users.find(x=>x.id==='u-stu');
    acme.price=bandSaved.acme; beta.price=bandSaved.beta; acme.shares_avail=bandSaved.avail;
    u.holdings=bandSaved.holdings; u.shorts=bandSaved.shorts; u.cash=bandSaved.cash;
    stub.data.jex_halts.length=0; DB.halts.length=0;
    DB.companies=JSON.parse(JSON.stringify(stub.data.jex_companies));
    DB.users=DB.users.map(x=>x.id==='u-stu'?Object.assign({},x,{holdings:u.holdings,shorts:u.shorts,cash:u.cash}):x);
  };

  await step('a sell cannot push a price below the band floor', async ()=>{
    saveBandState();
    return withoutBreaker(async ()=>{
      const b=bandOf('ACME');
      // Park the price just above the floor and hand the seller enough stock
      // that one order's impact would clear it comfortably.
      const sco=stub.data.jex_companies.find(c=>c.ticker==='ACME');
      sco.price=b.lower+0.05;
      const su=stub.data.jex_users.find(u=>u.id==='u-stu');
      su.holdings=Object.assign({}, su.holdings, {ACME:400});
      DB.companies=JSON.parse(JSON.stringify(stub.data.jex_companies));
      DB.users=DB.users.map(x=>x.id==='u-stu'?Object.assign({},x,{holdings:su.holdings}):x);
      await placeSell('ACME', 300);
      const after=CO().price;
      if(after < b.lower-0.001)
        throw new Error('price fell to '+after+', through the floor of '+b.lower);
      return 'held at '+after+' (floor '+b.lower+')';
    });
  });

  await step('the sell still EXECUTES at the floor -- the holder is not trapped', async ()=>{
    // The whole reason for clamping instead of rejecting. A student holding a
    // stock at the floor must still be able to get out; rejecting would refuse
    // every sell at any size, since every sell pushes the price lower.
    return withoutBreaker(async ()=>{
      const before=(ME().holdings.ACME||0), cash0=ME().cash;
      await placeSell('ACME', 50);
      const sold=before-(ME().holdings.ACME||0);
      if(sold!==50) throw new Error('the sell did not go through: '+sold+' of 50 -- toast: '+lastToast());
      if(ME().cash<=cash0) throw new Error('the seller received nothing');
      return 'sold 50 at the floor, +'+Math.round((ME().cash-cash0)*100)/100;
    });
  });

  await step('shorting cannot push a price below the floor either', async ()=>{
    return withoutBreaker(async ()=>{
      const b=bandOf('ACME');
      await placeShort('ACME', 200);
      const after=CO().price;
      if(after < b.lower-0.001) throw new Error('a short drove the price to '+after);
      return 'held at '+after;
    });
  });

  await step('a buy is REFUSED at the ceiling, not clamped', async ()=>{
    // Deliberately different from the sell side. Refusing a buy costs a
    // student an opportunity; refusing a sell would cost them the exit.
    return withoutBreaker(async ()=>{
      const b=bandOf('BETA');
      const sbeta=stub.data.jex_companies.find(c=>c.ticker==='BETA');
      sbeta.price=b.upper-0.02;
      // The client refuses locally when shares_avail is short, which would
      // stop the order before it ever reached the band and make this step
      // pass for entirely the wrong reason -- it did, on the first run.
      sbeta.shares_avail=Math.max(sbeta.shares_avail, 2000);
      DB.companies=JSON.parse(JSON.stringify(stub.data.jex_companies));
      const sent=()=>stub.rpcCalls.filter(c=>c.fn==='rpc_trade_buy').length;
      const before=sent(), price0=sbeta.price;
      await placeBuy('BETA', 400);
      if(sent()===before) throw new Error('the order never reached the server, so this proves nothing');
      const now=DB.companies.find(c=>c.ticker==='BETA').price;
      if(now > b.upper+0.001) throw new Error('a buy broke through the ceiling to '+now);
      if(now !== price0) throw new Error('the buy was clamped rather than refused -- price moved to '+now);
      return 'refused: '+lastToast();
    });
  });

  await step('a disabled band stops banding', async ()=>{
    // coalesce(v_band_pct,30) meant clearing the setting silently restored it
    // to 30% while the admin panel said "disabled". Same bug the circuit
    // breaker had client-side.
    return withoutBreaker(async ()=>{
      const sess=stub.data.jex_session[0], saved=sess.price_band_pct;
      sess.price_band_pct=null; DB.session.price_band_pct=null;
      try{
        const sco=stub.data.jex_companies.find(c=>c.ticker==='ACME');
        const b={lower:Math.round(sess.session_open_prices.ACME*0.7*100)/100};
        // Start AT the floor: with the band on, a sell here cannot move the
        // price at all. Any movement proves the band really is off.
        sco.price=b.lower;
        const su=stub.data.jex_users.find(u=>u.id==='u-stu');
        su.holdings=Object.assign({}, su.holdings, {ACME:400});
        DB.companies=JSON.parse(JSON.stringify(stub.data.jex_companies));
        DB.users=DB.users.map(x=>x.id==='u-stu'?Object.assign({},x,{holdings:su.holdings}):x);
        await placeSell('ACME', 300);
        const after=CO().price;
        if(after >= b.lower) throw new Error('the price did not move below the floor ('+after+
          '), so a disabled band was still being enforced');
        return 'unbanded, fell through '+b.lower+' to '+after;
      } finally { sess.price_band_pct=saved; DB.session.price_band_pct=saved; restoreBandState(); }
    });
  });

  await step('a stock below the floor is not frozen -- a buy can lift it back', async ()=>{
    // The freeze. Sells cannot move a below-floor stock (the clamp holds it,
    // correctly), so if buys are refused too then NOTHING anyone does can
    // shift the price until the next session open. The old reject asked "is
    // the result outside the band" instead of "does this order make things
    // worse", and a buy from below the floor is still below the floor.
    saveBandState();
    return withoutBreaker(async ()=>{
      try{
        const b=bandOf('ACME');
        const sco=stub.data.jex_companies.find(c=>c.ticker==='ACME');
        sco.price=Math.round((b.lower-1.00)*100)/100;      // stranded below the floor
        sco.shares_avail=Math.max(sco.shares_avail, 2000);
        DB.companies=JSON.parse(JSON.stringify(stub.data.jex_companies));
        const before=CO().price;
        const sent=()=>stub.rpcCalls.filter(c=>c.fn==='rpc_trade_buy').length;
        const n0=sent();
        await placeBuy('ACME', 50);
        if(sent()===n0) throw new Error('the buy never reached the server, so this proves nothing');
        const after=CO().price;
        if(after<=before)
          throw new Error('the price did not rise ('+before+' -> '+after+'): the stock is still frozen');
        if(after>b.lower)
          throw new Error('one buy jumped it past the floor to '+after+', which is not the intent');
        return before+' -> '+after+', lifted back toward the '+b.lower+' floor';
      } finally { restoreBandState(); }
    });
  });

  await step('...but a buy pushing further above the ceiling is still refused', async ()=>{
    saveBandState();
    return withoutBreaker(async ()=>{
      try{
        const b=bandOf('BETA');
        const sbeta=stub.data.jex_companies.find(c=>c.ticker==='BETA');
        sbeta.price=Math.round((b.upper+1.00)*100)/100;    // already above the ceiling
        sbeta.shares_avail=Math.max(sbeta.shares_avail, 2000);
        DB.companies=JSON.parse(JSON.stringify(stub.data.jex_companies));
        const before=DB.companies.find(c=>c.ticker==='BETA').price;
        await placeBuy('BETA', 400);
        const after=DB.companies.find(c=>c.ticker==='BETA').price;
        if(after!==before)
          throw new Error('a buy moved an already-over-ceiling stock further up: '+before+' -> '+after);
        return 'refused at '+before+' (ceiling '+b.upper+')';
      } finally { restoreBandState(); }
    });
  });

  await step('back-to-back orders are rate limited', async ()=>{
    await clearBurstWindow();   // the 3-in-5s rule must not pre-empt this
    const co=CO(), held0=(ME().holdings.ACME||0);
    const sent = () => stub.rpcCalls.filter(c=>c.fn==='rpc_trade_buy').length;
    const before = sent();
    await placeBuy('ACME', 1);
    if(sent() !== before+1) throw new Error('the first order did not go through -- toast: '+lastToast());
    await placeBuy('ACME', 1);   // immediately after -- inside the 800ms gap
    if(sent() !== before+1) throw new Error('a second order inside the gap reached the server');
    if((ME().holdings.ACME||0) !== held0+1) throw new Error('the blocked order still changed holdings');
    await paceOrders();
    await placeBuy('ACME', 1);   // after the gap it is allowed again
    if(sent() !== before+2) throw new Error('an order after the gap was still blocked -- toast: '+lastToast());
    return 'one through, one blocked, one through';
  });

  await step('the watchlist toggles both ways and persists to the page', async ()=>{
    const on0 = (ME().watchlist||[]).includes('BETA');
    await toggleWatch('BETA');
    if((ME().watchlist||[]).includes('BETA') === on0) throw new Error('toggle did nothing');
    UI.navTab='portfolio'; UI.portfolioTab='watchlist'; render();
    const shown = /BETA/.test(appText());
    if(shown !== !on0) throw new Error('the watchlist page disagrees with the stored list');
    await toggleWatch('BETA');
    if((ME().watchlist||[]).includes('BETA') !== on0) throw new Error('toggling back did not restore it');
    UI.portfolioTab='holdings';
    return 'both directions';
  });

  await step('a limit order is queued and shows on the orders page', async ()=>{
    const before = DB.limitOrders.length;
    await placeLimitOrder('ACME','buy',2,1.5,'gtc');
    if(DB.limitOrders.length <= before) throw new Error('no order recorded');
    UI.navTab='orders'; UI.companyPage=null; render();
    if(!/ACME/.test(appText())) throw new Error('the queued order is not on the orders page');
    return DB.limitOrders.length+' orders';
  });

  await step('a vote is cast with the right voting power', async ()=>{
    UI.navTab='market'; UI.companyPage='ACME'; UI.companyPageTab='votes'; render();
    const shares=(ME().holdings||{}).ACME||0;
    await castVote('v-1','option1');
    const b=DB.ballots.find(x=>x.vote_id==='v-1'&&x.voter_id==='u-stu');
    if(!b) throw new Error('no ballot recorded');
    if(b.voting_power !== shares) throw new Error('power '+b.voting_power+' but holds '+shares);
    return shares+' votes';
  });

  await step('voting twice is refused', async ()=>{
    const before = DB.ballots.length;
    await castVote('v-1','option2');
    if(DB.ballots.length !== before) throw new Error('a second ballot was accepted');
    return 'refused';
  });

  // Session state must actually gate trading, not just grey a button out.
  await step('a closed session blocks a buy and says so', async ()=>{
    const cash0 = ME().cash;
    DB.session.status='closed'; stub.data.jex_session[0].status='closed';
    const before = stub.rpcCalls.filter(c=>c.fn==='rpc_trade_buy').length;
    await paceOrders();
    await placeBuy('ACME', 1);
    if(ME().cash !== cash0) throw new Error('cash changed while the session was closed');
    const after = stub.rpcCalls.filter(c=>c.fn==='rpc_trade_buy').length;
    DB.session.status='open'; stub.data.jex_session[0].status='open';
    return after===before ? 'refused locally' : 'refused by the server';
  });

  await step('a halted ticker blocks a buy', async ()=>{
    const cash0 = ME().cash;
    DB.halts.push({id:'h-x', ticker:'ACME', reason:'test', ts:'now'});
    stub.data.jex_halts.push({id:'h-x', ticker:'ACME', reason:'test', ts:'now'});
    await paceOrders();
    await placeBuy('ACME', 1);
    if(ME().cash !== cash0) throw new Error('a halted ticker still traded');
    DB.halts=DB.halts.filter(h=>h.id!=='h-x');
    stub.data.jex_halts.length=0;
    return 'blocked';
  });

  await step('a server rejection surfaces as a message, not a crash', async ()=>{
    const me=ME(); const cash0=me.cash;
    me.cash = 0.01;                      // client thinks it can afford nothing
    const before = stub.errors.length;
    await paceOrders();
    await placeBuy('ACME', 1000000);     // and the server would refuse anyway
    if(stub.errors.length !== before) throw new Error('the rejection produced an uncaught error');
    me.cash = cash0;
    return 'handled';
  });

  // ── The instructor's own workflow ───────────────────────────────────
  // Opening and closing the session, and approving what students file, are
  // the actions the teacher performs live in front of a class. If any of
  // them throws or half-applies, the lesson stops.
  await step('the chairman can open and close the session', async ()=>{
    UI.userId='u-chair'; UI.navTab='admin'; UI.adminTab='session'; UI.companyPage=null; render();
    await setSession('closed');
    if(DB.session.status!=='closed') throw new Error('close left status '+DB.session.status);
    render();
    await setSession('open');
    if(DB.session.status!=='open') throw new Error('open left status '+DB.session.status);
    render();
    if(!appText().trim()) throw new Error('the session panel went blank');
    return 'closed then reopened';
  });

  await step('opening the session notifies students', ()=>{
    // Checked on the server side of the stub, not DB.notifications: the
    // client only merges a notification into DB when it is addressed to the
    // signed-in user, and the chairman is signed in here. That restraint is
    // the point -- an admin's browser must not accumulate other students'
    // notifications.
    const n = stub.data.jex_notifications.filter(x=>x.type==='session');
    if(!n.length) throw new Error('no session notifications were pushed');
    if(!n.some(x=>x.user_id==='u-stu')) throw new Error('the student got no session notification');
    if(DB.notifications.some(x=>x.user_id && x.user_id!=='u-chair'))
      throw new Error("the chairman's browser holds another user's notifications");
    return n.length+' pushed, none leaked into the admin session';
  });

  await step('opening the session records the opening prices', async ()=>{
    // setSession() fires recordSessionOpenPrices() without awaiting it, so the
    // new prices land a moment after the call returns. That is fine in the app
    // -- the server writes jex_session itself and is the authority for the
    // price band -- but the check has to wait for it rather than race it.
    for(let i=0;i<20 && (DB.session.session_open_prices||{}).ACME===12;i++) await sleep(50);
    const p = DB.session.session_open_prices||{};
    if(!p.ACME) throw new Error('no opening price recorded for ACME');
    if(Math.abs(p.ACME - DB.companies.find(c=>c.ticker==='ACME').price) > 0.001)
      throw new Error('opening price '+p.ACME+' does not match the live price');
    return 'ACME opened at '+p.ACME;
  });

  await step('a student cannot control the session', async ()=>{
    UI.userId='u-stu';
    const was = DB.session.status;
    await setSession('closed');
    UI.userId='u-chair';
    if(DB.session.status !== was) throw new Error('a student closed the market');
    return 'refused';
  });

  await step('approving a registration creates the student', async ()=>{
    UI.userId='u-chair'; UI.navTab='admin'; UI.adminTab='registrations'; render();
    const pend = DB.pending[0];
    if(!pend) throw new Error('nothing pending to approve');
    const users0 = DB.users.length;
    await approveReg(pend.id, 10000, null);
    if(DB.users.length !== users0+1) throw new Error('no user was created');
    if(DB.pending.some(p=>p.id===pend.id)) throw new Error('the request stayed in the queue');
    const made = DB.users[DB.users.length-1];
    if(made.cash !== 10000) throw new Error('starting cash '+made.cash);
    render();
    if(!appText().trim()) throw new Error('the registrations tab went blank afterwards');
    return made.name+' @ '+made.cash;
  });

  await step('approving an IPO lists the company and it is tradeable', async ()=>{
    UI.adminTab='ipo'; render();
    const app = DB.ipoApps.find(a=>a.status==='pending');
    if(!app) throw new Error('no pending IPO');
    await reviewIPO(app.id, true);
    const co = DB.companies.find(c=>c.ticker===app.ticker);
    if(!co) throw new Error(app.ticker+' was not listed');
    if(co.shares_avail !== app.shares) throw new Error('float '+co.shares_avail+' expected '+app.shares);
    UI.navTab='market'; UI.companyPage=null; render();
    if(!appText().includes(app.ticker)) throw new Error('the new ticker is not on the market page');
    UI.navTab='admin';
    return app.ticker+' listed with '+co.shares_avail+' shares';
  });

  await step('approving a dilution adjusts price and share count together', async ()=>{
    UI.adminTab='dilution'; render();
    const app = DB.dilApps.find(d=>d.status==='pending');
    if(!app) throw new Error('no pending dilution');
    const co = DB.companies.find(c=>c.ticker===app.ticker);
    const shares0=co.shares, price0=co.price, cap0=shares0*price0;
    await reviewDilution(app.id, true);
    const c = DB.companies.find(x=>x.ticker===app.ticker);
    if(c.shares !== shares0+app.new_shares) throw new Error('shares '+c.shares);
    if(c.price >= price0) throw new Error('price did not adjust down: '+c.price);
    // Issuing shares raises capital; it must not conjure or destroy market cap
    // through the price adjustment itself.
    const cap1=c.shares*c.price;
    if(Math.abs(cap1-cap0) > cap0*0.01)
      throw new Error('market cap moved from '+cap0.toFixed(2)+' to '+cap1.toFixed(2));
    return shares0+'->'+c.shares+' shares, '+price0+'->'+c.price;
  });

  await step('a reviewed application cannot be reviewed twice', async ()=>{
    const done = DB.dilApps.find(d=>d.status==='approved');
    if(!done) throw new Error('no reviewed dilution to retry');
    const co = DB.companies.find(x=>x.ticker===done.ticker);
    const shares0 = co.shares;
    await reviewDilution(done.id, true);
    if(co.shares !== shares0) throw new Error('a second approval issued shares again');
    return 'refused';
  });

  await step('the admin pages still render after all of that', ()=>{
    UI.userId='u-chair'; UI.navTab='admin';
    for(const at of ['dashboard','session','registrations','ipo','dilution','listed','users','activity']){
      UI.adminTab=at; render();
      if(!appText().trim()) throw new Error('blank admin tab '+at+' after the workflow');
    }
    UI.userId='u-stu'; UI.navTab='market'; UI.adminTab='dashboard'; render();
  });

  // ── Funds ───────────────────────────────────────────────────────────
  // A student's money leaves their account and comes back through someone
  // else's hands, so the conservation checks matter more here than anywhere.
  const FUND = () => DB.funds.find(f=>f.id==='f-1');
  await step('depositing buys units at the current NAV', async ()=>{
    UI.userId='u-stu2'; UI.navTab='funds'; UI.fundPage='f-1'; UI.companyPage=null; render();
    const me=DB.users.find(u=>u.id==='u-stu2'), f=FUND();
    const nav0=currentFundNav(f);
    const cash0=me.cash, fundCash0=f.cash, units0=f.units_outstanding;
    await depositToFund('f-1', 500);
    const m=DB.users.find(u=>u.id==='u-stu2'), g=FUND();
    const pos=(m.fund_units||{})['f-1'];
    if(!pos) throw new Error('no position recorded');
    if(Math.abs(m.cash-(cash0-500))>0.01) throw new Error('cash '+m.cash);
    if(Math.abs(g.cash-(fundCash0+500))>0.01) throw new Error('fund cash '+g.cash);
    const expUnits=Math.round((500/nav0)*10000)/10000;
    if(Math.abs(pos.units-expUnits)>0.001) throw new Error('units '+pos.units+' expected '+expUnits);
    if(Math.abs(g.units_outstanding-(units0+expUnits))>0.001)
      throw new Error('units outstanding '+g.units_outstanding);
    if(Math.abs(pos.costBasis-nav0)>0.01) throw new Error('cost basis '+pos.costBasis+' expected '+nav0);
    return expUnits+' units @ NAV '+nav0;
  });

  await step('depositing into a fund does not destroy net worth', async ()=>{
    const me=DB.users.find(u=>u.id==='u-stu2');
    const nwBefore=nw(me);
    await depositToFund('f-1', 400);
    const nwAfter=nw(DB.users.find(u=>u.id==='u-stu2'));
    const drop=Math.round((nwBefore-nwAfter)*100)/100;
    if(Math.abs(drop)>0.02)
      throw new Error('net worth fell by '+drop+' after depositing 400 -- fund units are not counted');
    return 'net worth held at '+nwAfter;
  });

  await step('the deposit shows on the fund page', ()=>{
    UI.navTab='funds'; UI.fundPage='f-1'; render();
    if(!appText().trim()) throw new Error('the fund page went blank');
    if(!/Test Growth Fund/.test(appText())) throw new Error('fund name missing');
  });

  await step('withdrawing at an unchanged NAV returns the money and charges no fee', async ()=>{
    const me=DB.users.find(u=>u.id==='u-stu2'), f=FUND();
    const mgr=DB.users.find(u=>u.id===f.manager_id);
    const pos=(me.fund_units||{})['f-1'];
    const cash0=me.cash, mgrCash0=mgr?mgr.cash:0;
    const units=pos.units;
    const nav=currentFundNav(f);
    await withdrawFromFund('f-1', units);
    const m=DB.users.find(u=>u.id==='u-stu2');
    if((m.fund_units||{})['f-1']) throw new Error('the position was not closed');
    const back=Math.round((m.cash-cash0)*100)/100;
    const expected=Math.round(units*nav*100)/100;
    if(Math.abs(back-expected)>0.02) throw new Error('got back '+back+', expected '+expected);
    const mgrNow=DB.users.find(u=>u.id===f.manager_id);
    if(mgrNow && Math.abs(mgrNow.cash-mgrCash0)>0.01)
      throw new Error('a fee was charged with no profit: '+(mgrNow.cash-mgrCash0));
    return 'returned '+back+', no fee';
  });

  await step('the performance fee is charged on profit only, and only once', async ()=>{
    const f=FUND(), me=DB.users.find(u=>u.id==='u-stu2');
    await depositToFund('f-1', 1000);
    const pos=Object.assign({}, (DB.users.find(u=>u.id==='u-stu2').fund_units||{})['f-1']);
    // The fund gains value: hand it cash so NAV per unit rises.
    const g=FUND();
    g.cash=Math.round((g.cash*1.5)*100)/100;
    stub.data.jex_funds[0].cash=g.cash;
    const nav1=currentFundNav(FUND());
    if(nav1<=pos.costBasis) throw new Error('NAV did not rise: '+nav1+' vs '+pos.costBasis);
    const mgr=DB.users.find(u=>u.id===FUND().manager_id);
    const mgrCash0=mgr.cash, cash0=DB.users.find(u=>u.id==='u-stu2').cash;
    // Fund deposits and withdrawals share the trade rate limiter now, and this
    // step does one of each. Without the pace the withdrawal is refused by the
    // 0.8s floor, the position stays open, and the failure surfaces as "fee 0"
    // -- and then again in the NEXT step as a unit count carrying this step's
    // leftover position.
    await paceOrders();
    await withdrawFromFund('f-1', pos.units);
    const m=DB.users.find(u=>u.id==='u-stu2');
    const mgrNow=DB.users.find(u=>u.id===FUND().manager_id);
    const gross=Math.round(pos.units*nav1*100)/100;
    const profit=Math.round((nav1-pos.costBasis)*pos.units*100)/100;
    const expFee=Math.round(profit*(FUND().fee_pct||0)/100*100)/100;
    const feeTaken=Math.round((mgrNow.cash-mgrCash0)*100)/100;
    const netGot=Math.round((m.cash-cash0)*100)/100;
    if(Math.abs(feeTaken-expFee)>0.02) throw new Error('fee '+feeTaken+', expected '+expFee);
    if(Math.abs(netGot-(gross-expFee))>0.03)
      throw new Error('net '+netGot+', expected '+(gross-expFee));
    // Nothing may be created: what left the fund equals what the two people got.
    if(Math.abs((netGot+feeTaken)-gross)>0.03)
      throw new Error('net+fee '+(netGot+feeTaken)+' != gross '+gross);
    return 'fee '+feeTaken+' on profit '+profit;
  });

  await step('a fund with a short prices deposits and withdrawals the same', async ()=>{
    // THE EXPLOIT. rpc_fund_deposit computed NAV without the fund's short
    // collateral; rpc_fund_withdraw computed it with. Deposit at the low
    // price, withdraw at the high one, keep the difference -- and every other
    // unit-holder's NAV falls to pay for it. Only bites once a manager shorts
    // something, which is why nobody had hit it yet.
    UI.userId='u-stu2'; UI.navTab='funds'; UI.fundPage='f-1'; render();
    const f=FUND(), sf=stub.data.jex_funds.find(x=>x.id==='f-1');
    const shortBook={BETA:{qty:10, avgPrice:20, collateral:300}};
    f.shorts=shortBook; sf.shorts=shortBook;
    f.cash=1000; sf.cash=1000;
    f.units_outstanding=100; sf.units_outstanding=100;
    const beta=DB.companies.find(c=>c.ticker==='BETA');
    beta.price=20; stub.data.jex_companies.find(c=>c.ticker==='BETA').price=20;

    const navBefore=currentFundNav(FUND());
    if(Math.abs(navBefore-13)>0.01)
      throw new Error('NAV should be 13.00 with the collateral counted, got '+navBefore);

    const me=DB.users.find(u=>u.id==='u-stu2');
    const cash0=me.cash;
    await depositToFund('f-1', 130);
    const pos=(DB.users.find(u=>u.id==='u-stu2').fund_units||{})['f-1'];
    if(!pos) throw new Error('no position after depositing');
    // 130 at a NAV of 13 is 10 units. At the buggy NAV of 10 it was 13.
    if(Math.abs(pos.units-10)>0.01)
      throw new Error('minted '+pos.units+' units for 130 -- expected 10 at NAV 13; '+
        'a higher number means deposits are still priced without short collateral');

    await paceOrders();   // same shared limiter as the deposit above
    await withdrawFromFund('f-1', pos.units);
    const back=Math.round((DB.users.find(u=>u.id==='u-stu2').cash-cash0)*100)/100;
    if(back>0.02)
      throw new Error('deposit-then-withdraw produced '+back+' of risk-free profit');
    return 'round trip net '+back+' at NAV '+navBefore;
  });

  await step('withdrawing more units than you hold is refused', async ()=>{
    const before=stub.rpcCalls.filter(c=>c.fn==='rpc_fund_withdraw').length;
    await withdrawFromFund('f-1', 99999);
    if(stub.rpcCalls.filter(c=>c.fn==='rpc_fund_withdraw').length!==before)
      throw new Error('the client sent an oversized withdrawal to the server');
    UI.userId='u-stu'; UI.navTab='market'; UI.fundPage=null;
    return 'refused locally';
  });

  // ── Dividends and buybacks ──────────────────────────────────────────
  await step('a dividend moves exactly what it debits', async ()=>{
    UI.userId='u-co'; UI.navTab='mystock'; UI.companyTab='dividends'; UI.companyPage=null; render();
    const co=DB.companies.find(c=>c.ticker==='ACME');
    const owner=DB.users.find(u=>u.id===co.owner_id);
    const holders=DB.users.filter(u=>((u.holdings||{}).ACME||0)>0);
    if(!holders.length) throw new Error('nobody holds ACME to pay a dividend to');
    const before=new Map(DB.users.map(u=>[u.id,u.cash]));
    const ownerCash0=owner.cash;
    const perShare=0.10;
    const expTotal=Math.round(holders.reduce((s,h)=>s+h.holdings.ACME*perShare,0)*100)/100;
    // issueDividend() asks for confirmation, and headless Chromium
    // auto-dismisses dialogs -- which would silently make this step assert
    // that nothing happened.
    const realConfirm=window.confirm; window.confirm=()=>true;
    try{ await issueDividend('ACME', perShare, 'Test payout'); }
    finally{ window.confirm=realConfirm; }
    const ownerNow=DB.users.find(u=>u.id===co.owner_id);
    const debited=Math.round((ownerCash0-ownerNow.cash)*100)/100;
    let credited=0;
    for(const h of holders){
      const now=DB.users.find(u=>u.id===h.id);
      credited+=now.cash-before.get(h.id);
    }
    credited=Math.round(credited*100)/100;
    if(Math.abs(debited-expTotal)>0.02) throw new Error('debited '+debited+', expected '+expTotal);
    if(Math.abs(credited-debited)>0.02)
      throw new Error('credited '+credited+' but debited '+debited+' -- money was created or lost');
    return debited+' out, '+credited+' in';
  });

  await step('a dividend the company cannot afford is refused', async ()=>{
    const co=DB.companies.find(c=>c.ticker==='ACME');
    const owner=DB.users.find(u=>u.id===co.owner_id);
    const cash0=owner.cash;
    const realConfirm=window.confirm; window.confirm=()=>true;
    try{ await issueDividend('ACME', 999999, 'Cannot afford this'); }
    finally{ window.confirm=realConfirm; }
    if(DB.users.find(u=>u.id===co.owner_id).cash!==cash0)
      throw new Error('an unaffordable dividend still moved money');
    return 'refused';
  });

  await step('a buyback retires shares and is paid by the company', async ()=>{
    UI.userId='u-co'; UI.navTab='mystock'; UI.companyTab='buyback'; render();
    const co=DB.companies.find(c=>c.ticker==='ACME');
    const owner=DB.users.find(u=>u.id===co.owner_id);
    const clicker=DB.users.find(u=>u.id==='u-co');
    const shares0=co.shares, avail0=co.shares_avail, ownerCash0=owner.cash;
    const circulating=shares0-avail0;
    if(circulating<2) throw new Error('nothing in circulation to buy back');
    await doBuyback('ACME', 2);
    const c=DB.companies.find(x=>x.ticker==='ACME');
    const o=DB.users.find(u=>u.id===co.owner_id);
    if(c.shares!==shares0-2) throw new Error('shares '+c.shares+', expected '+(shares0-2));
    if(c.shares_avail!==avail0)
      throw new Error('shares_avail moved: bought-back shares must be retired, not returned to the float');
    if(o.cash>=ownerCash0) throw new Error('the company was not debited');
    if(c.shares_avail>c.shares) throw new Error('shares_avail exceeds shares');
    return 'retired 2, company paid '+Math.round((ownerCash0-o.cash)*100)/100;
  });

  await step('a buyback bigger than the float is refused', async ()=>{
    const co=DB.companies.find(c=>c.ticker==='ACME');
    const owner=DB.users.find(u=>u.id===co.owner_id);
    const shares0=co.shares, cash0=owner.cash;
    await doBuyback('ACME', 999999);
    if(DB.companies.find(x=>x.ticker==='ACME').shares!==shares0)
      throw new Error('shares changed on a refused buyback');
    if(DB.users.find(u=>u.id===co.owner_id).cash!==cash0)
      throw new Error('cash changed on a refused buyback');
    UI.userId='u-stu'; UI.navTab='market'; UI.companyTab='stock'; render();
    return 'refused';
  });

  // ── The 3s poll loop ────────────────────────────────────────────────
  // checkLimitOrders / checkStopLossOrders / checkPriceAlerts run on a timer
  // in every open browser and move real money with nobody clicking anything.
  // They are called here directly rather than waited for, so the assertions
  // are deterministic.
  await step('two crossing limit orders match against each other', async ()=>{
    UI.userId='u-stu'; UI.navTab='orders'; UI.companyPage=null; render();
    // Clear the book first. The seeded lo-1 also crosses, and a matching
    // engine is allowed to resolve every crossing pair it finds -- so without
    // this the deltas below measure two fills, not one, and the step would be
    // asserting the wrong arithmetic while looking like it passed.
    for(const o of DB.limitOrders) if(o.status==='open') o.status='cancelled';
    for(const o of stub.data.jex_limit_orders) if(o.status==='open') o.status='cancelled';
    const buyer=DB.users.find(u=>u.id==='u-stu'), seller=DB.users.find(u=>u.id==='u-quote');
    // Give the seller shares to sell and put both sides on the book.
    seller.holdings=Object.assign({}, seller.holdings, {ACME:10});
    stub.data.jex_users.find(u=>u.id==='u-quote').holdings={ACME:10};
    const mk=(id,uid,side,qty,px,ageMs)=>({id, user_id:uid, ticker:'ACME', side, qty,
      limit_price:px, status:'open', order_type:'gtc',
      created_at:new Date(Date.now()-ageMs).toISOString()});
    const ask=mk('lo-ask','u-quote','sell',4,11.00,20000);   // resting, sets the price
    const bid=mk('lo-bid','u-stu','buy',4,11.50,10000);
    DB.limitOrders.push(ask,bid);
    stub.data.jex_limit_orders.push(ask,bid);
    const bCash=buyer.cash, sCash=seller.cash;
    const bHeld=(buyer.holdings.ACME||0), sHeld=(seller.holdings.ACME||0);
    await checkLimitOrders();
    if(DB.limitOrders.find(o=>o.id==='lo-ask').status!=='filled') throw new Error('the ask did not fill');
    if(DB.limitOrders.find(o=>o.id==='lo-bid').status!=='filled') throw new Error('the bid did not fill');
    const b=DB.users.find(u=>u.id==='u-stu'), sl=DB.users.find(u=>u.id==='u-quote');
    if((b.holdings.ACME||0)!==bHeld+4) throw new Error('buyer holdings '+b.holdings.ACME);
    if((sl.holdings.ACME||0)!==sHeld-4) throw new Error('seller holdings '+(sl.holdings.ACME||0));
    const paid=Math.round((bCash-b.cash)*100)/100;
    const got =Math.round((sl.cash-sCash)*100)/100;
    // The resting ask set the price: 4 x 11.00.
    if(paid!==44) throw new Error('buyer paid '+paid+', expected 44');
    if(got!==44) throw new Error('seller received '+got+', expected 44');
    if(paid!==got) throw new Error('cash was created or destroyed: '+paid+' vs '+got);
    if(Math.abs(DB.companies.find(c=>c.ticker==='ACME').price-11)>0.001)
      throw new Error('the fill did not set the price to 11');
    return 'matched 4 @ 11, cash conserved';
  });

  await step('a limit order that does not cross is left alone', async ()=>{
    const co=DB.companies.find(c=>c.ticker==='ACME');
    const far={id:'lo-far', user_id:'u-stu', ticker:'ACME', side:'buy', qty:2,
      limit_price:Math.round((co.price-5)*100)/100, status:'open', order_type:'gtc',
      created_at:new Date().toISOString()};
    DB.limitOrders.push(far); stub.data.jex_limit_orders.push(far);
    const cash0=DB.users.find(u=>u.id==='u-stu').cash;
    await checkLimitOrders();
    if(DB.limitOrders.find(o=>o.id==='lo-far').status!=='open') throw new Error('a non-crossing order filled');
    if(DB.users.find(u=>u.id==='u-stu').cash!==cash0) throw new Error('cash moved on a non-crossing order');
    return 'still resting';
  });

  await step('a resting order fills against the pool when the price reaches it', async ()=>{
    const co=DB.companies.find(c=>c.ticker==='ACME');
    const me=DB.users.find(u=>u.id==='u-stu');
    const o={id:'lo-pool', user_id:'u-stu', ticker:'ACME', side:'buy', qty:3,
      limit_price:Math.round((co.price+1)*100)/100, status:'open', order_type:'gtc',
      created_at:new Date().toISOString()};
    DB.limitOrders.push(o); stub.data.jex_limit_orders.push(o);
    const cash0=me.cash, held0=(me.holdings.ACME||0), avail0=co.shares_avail;
    await checkLimitOrders();
    const filled=DB.limitOrders.find(x=>x.id==='lo-pool');
    if(filled.status!=='filled') throw new Error('the crossing order did not fill: '+filled.status);
    const m=DB.users.find(u=>u.id==='u-stu');
    if((m.holdings.ACME||0)!==held0+3) throw new Error('holdings '+m.holdings.ACME);
    if(m.cash>=cash0) throw new Error('cash did not decrease');
    if(DB.companies.find(c=>c.ticker==='ACME').shares_avail!==avail0-3)
      throw new Error('the float was not reduced');
    return 'filled vs the pool @ '+filled.filled_price;
  });

  await step('the poll loop does nothing while the session is closed', async ()=>{
    const co=DB.companies.find(c=>c.ticker==='ACME');
    const o={id:'lo-closed', user_id:'u-stu', ticker:'ACME', side:'buy', qty:1,
      limit_price:Math.round((co.price+5)*100)/100, status:'open', order_type:'gtc',
      created_at:new Date().toISOString()};
    DB.limitOrders.push(o); stub.data.jex_limit_orders.push(o);
    DB.session.status='closed'; stub.data.jex_session[0].status='closed';
    await checkLimitOrders(); await checkStopLossOrders();
    DB.session.status='open'; stub.data.jex_session[0].status='open';
    if(DB.limitOrders.find(x=>x.id==='lo-closed').status!=='open')
      throw new Error('an order filled while trading was closed');
    // and it fills once trading reopens
    await checkLimitOrders();
    if(DB.limitOrders.find(x=>x.id==='lo-closed').status!=='filled')
      throw new Error('the order did not fill after reopening');
    return 'held, then filled on reopen';
  });

  await step('a stop-loss sells when the price falls through its trigger', async ()=>{
    const co=DB.companies.find(c=>c.ticker==='ACME');
    const me=DB.users.find(u=>u.id==='u-stu');
    const held0=(me.holdings.ACME||0);
    if(held0<3) throw new Error('not holding enough to test a stop-loss: '+held0);
    const sl={id:'sl-1', user_id:'u-stu', ticker:'ACME', qty:3,
      trigger_price:Math.round((co.price+1)*100)/100,   // already below trigger
      status:'active', ts:'now', created_at:new Date().toISOString()};
    DB.stopLossOrders.push(sl); stub.data.jex_stop_loss.push(sl);
    const cash0=me.cash;
    await checkStopLossOrders();
    const after=DB.users.find(u=>u.id==='u-stu');
    if(DB.stopLossOrders.find(x=>x.id==='sl-1').status!=='triggered')
      throw new Error('the stop-loss did not trigger');
    if((after.holdings.ACME||0)!==held0-3) throw new Error('holdings '+after.holdings.ACME);
    if(after.cash<=cash0) throw new Error('no proceeds credited');
    return 'sold 3, credited '+Math.round((after.cash-cash0)*100)/100;
  });

  await step('a stop-loss on shares you no longer hold cancels itself', async ()=>{
    const sl={id:'sl-none', user_id:'u-stu2', ticker:'ACME', qty:5,
      trigger_price:99999, status:'active', ts:'now', created_at:new Date().toISOString()};
    DB.stopLossOrders.push(sl); stub.data.jex_stop_loss.push(sl);
    await checkStopLossOrders();
    const s=DB.stopLossOrders.find(x=>x.id==='sl-none');
    if(s.status==='triggered') throw new Error('it sold shares that were not there');
    if(s.status!=='cancelled') throw new Error('expected cancelled, got '+s.status);
    return 'cancelled';
  });

  await step('a price alert fires once and only once', async ()=>{
    const co=DB.companies.find(c=>c.ticker==='ACME');
    const a={id:'pa-1', user_id:'u-stu', ticker:'ACME', direction:'above',
      target_price:Math.round((co.price-1)*100)/100, triggered:null,
      created_at:new Date().toISOString()};
    DB.priceAlerts.push(a); stub.data.jex_price_alerts.push(a);
    await checkPriceAlerts();
    if(!DB.priceAlerts.find(x=>x.id==='pa-1').triggered) throw new Error('the alert did not fire');
    const calls=()=>stub.rpcCalls.filter(c=>c.fn==='rpc_trigger_price_alert').length;
    const before=calls();
    await checkPriceAlerts();
    if(calls()!==before) throw new Error('a triggered alert was re-sent to the server');
    return 'fired once';
  });

  await step('an alert whose target is not met stays quiet', async ()=>{
    const co=DB.companies.find(c=>c.ticker==='ACME');
    const a={id:'pa-2', user_id:'u-stu', ticker:'ACME', direction:'above',
      target_price:Math.round((co.price*10)*100)/100, triggered:null,
      created_at:new Date().toISOString()};
    DB.priceAlerts.push(a); stub.data.jex_price_alerts.push(a);
    await checkPriceAlerts();
    if(DB.priceAlerts.find(x=>x.id==='pa-2').triggered) throw new Error('it fired below target');
    return 'quiet';
  });

  await step('the poll loop runs clean twice in a row', async ()=>{
    const before = stub.errors.length;
    for(let i=0;i<2;i++){
      await checkLimitOrders(); await checkStopLossOrders(); await checkPriceAlerts();
      checkShortSqueezes(); await checkCircuitBreakerAutoResume();
    }
    if(stub.errors.length!==before) throw new Error('the poll loop produced an uncaught error');
    return 'clean';
  });

  // ── Circuit breakers ────────────────────────────────────────────────
  await step('a big move halts the ticker, and the halt blocks trading', async ()=>{
    const co=DB.companies.find(c=>c.ticker==='BETA');
    // Session open was 10; push it well past the 20% breaker.
    co.price=20; stub.data.jex_companies.find(c=>c.ticker==='BETA').price=20;
    DB.session.circuit_cooldowns={}; stub.data.jex_session[0].circuit_cooldowns={};
    await checkCircuitBreakers();
    if(!DB.halts.some(h=>h.ticker==='BETA')) throw new Error('the breaker did not trip');
    const me=DB.users.find(u=>u.id==='u-stu');
    const cash0=me.cash;
    await paceOrders();
    await placeBuy('BETA', 1);
    if(DB.users.find(u=>u.id==='u-stu').cash!==cash0)
      throw new Error('a halted ticker still traded');
    return 'halted and blocked';
  });

  await step('a halted ticker is not halted twice', async ()=>{
    const before=DB.halts.filter(h=>h.ticker==='BETA').length;
    await checkCircuitBreakers();
    const after=DB.halts.filter(h=>h.ticker==='BETA').length;
    if(after!==before) throw new Error('duplicate halts: '+before+' -> '+after);
    return 'one halt';
  });

  await step('resuming sets a cooldown so it cannot immediately re-halt', async ()=>{
    await resumeStock('BETA', true);
    if(DB.halts.some(h=>h.ticker==='BETA')) throw new Error('still halted after resume');
    const cd=(DB.session.circuit_cooldowns||{}).BETA;
    if(!cd||cd<=Date.now()) throw new Error('no live cooldown was set: '+cd);
    // The price is still way past the threshold; the cooldown is the only
    // thing stopping an immediate re-halt.
    await checkCircuitBreakers();
    if(DB.halts.some(h=>h.ticker==='BETA')) throw new Error('re-halted during the cooldown');
    return 'cooldown holds';
  });

  await step('a ticker inside the band is never halted', async ()=>{
    const co=DB.companies.find(c=>c.ticker==='BETA');
    co.price=10.5; stub.data.jex_companies.find(c=>c.ticker==='BETA').price=10.5;
    DB.session.circuit_cooldowns={}; stub.data.jex_session[0].circuit_cooldowns={};
    DB.halts=DB.halts.filter(h=>h.ticker!=='BETA');
    stub.data.jex_halts=stub.data.jex_halts.filter(h=>h.ticker!=='BETA');
    await checkCircuitBreakers();
    if(DB.halts.some(h=>h.ticker==='BETA')) throw new Error('a 5% move tripped a 20% breaker');
    return 'left alone';
  });

  // ── Arizona time ────────────────────────────────────────────────────
  // Everything in JEX is Arizona time, and this page runs with TZ set by the
  // scenario -- so these read wrong if any of it falls back to the device's
  // own timezone. The mobile/default runs use the container's TZ; the
  // timezone scenarios re-run the same checks from UTC and Tokyo.
  await step('the admin clock shows Arizona time, whatever the device says', ()=>{
    UI.userId='u-chair'; UI.navTab='admin'; UI.adminTab='session'; UI.companyPage=null; render();
    const t = appText();
    // Matched loosely on purpose: the label around it contains a U+2212 minus
    // sign, and the clock itself can carry a U+202F narrow no-break space
    // before AM/PM depending on the ICU build.
    const m = /([A-Z][a-z][a-z], [A-Z][a-z][a-z] [0-9]+, [0-9]+:[0-9]+:[0-9]+[ \u00a0\u202f]?(?:AM|PM)) MST/.exec(t);
    if(!m){
      const i = t.indexOf('Arizona time');
      throw new Error('no Arizona clock on the session panel; around the label: '+
        (i<0 ? '(label missing entirely) '+t.slice(0,160) : JSON.stringify(t.slice(i, i+90))));
    }
    // What Arizona actually is, computed independently of app.js.
    const truth = new Date().toLocaleString('en-US',{timeZone:'America/Phoenix',weekday:'short',
      month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true});
    const hh = s => /([0-9][0-9]):([0-9][0-9])/.exec(s);
    const a = hh(m[1]), b = hh(truth);
    if(!a || !b || a[1] !== b[1]) throw new Error('panel says '+m[1]+', Arizona is '+truth);
    return m[1];
  });

  await step("a client-written timestamp matches the server's format", ()=>{
    const mine = ts();
    // Postgres to_char emits a plain ASCII space before AM/PM. Intl may emit
    // U+202F instead, and a ts that differs from the server's by an invisible
    // character is a ts that will not compare equal to it.
    const odd = [...mine].map((c,i)=>[i,c.charCodeAt(0)]).filter(([,c])=>c>126);
    if(odd.length) throw new Error('ts() contains non-ASCII '+JSON.stringify(odd)+' in '+JSON.stringify(mine));
    if(!/^[A-Z][a-z][a-z] [0-9]+, [0-9]+:[0-9][0-9]:[0-9][0-9] (AM|PM)$/.test(mine))
      throw new Error('ts() is not in the server format: '+JSON.stringify(mine));
    // The seeded rows carry exactly what the server writes.
    const seeded = (DB.trades.find(t=>t.ts)||{}).ts;
    if(seeded && !/^[A-Z][a-z][a-z] [0-9]+, /.test(seeded))
      throw new Error('the seeded ts is not in the expected shape: '+seeded);
    return mine;
  });

  await step("today's trades are counted, not silently zero", ()=>{
    // Seed a trade stamped with today's Arizona date, in the server's format,
    // and check the figures that read it.
    const p = new Intl.DateTimeFormat('en-US',{timeZone:'America/Phoenix',month:'short',day:'numeric'})
      .formatToParts(new Date());
    const g = t => (p.find(x=>x.type===t)||{}).value;
    const todayTs = g('month')+' '+g('day')+', 10:00:00 AM';
    DB.trades.push({id:9001, ticker:'ACME', qty:4, price:10, buyer_id:'u-stu',
                    seller_id:'exchange', type:'market', ts:todayTs});
    UI.userId='u-chair'; UI.navTab='admin'; UI.adminTab='dashboard'; render();
    const dash = appText();
    if(/Trades today[^0-9]*0[^0-9]/.test(dash))
      throw new Error("the admin dashboard still reads 0 trades today");
    UI.navTab='exchange'; render();
    const ex = appText();
    if(!ex.trim()) throw new Error('exchange stats went blank');
    // The volume figure must have moved off zero now that a trade is dated today.
    if(ex.indexOf('$0.00')>=0 && ex.indexOf('$40.00')<0)
      out.notes.push('exchange volume still reads $0.00 -- check the figure wiring');
    DB.trades = DB.trades.filter(t=>t.id!==9001);
    UI.userId='u-stu'; UI.navTab='market'; UI.adminTab='dashboard'; render();
    return 'counted';
  });

  await step('the CSV export filename carries the Arizona date', ()=>{
    const stamp = azDateStamp();
    const p = new Intl.DateTimeFormat('en-US',{timeZone:'America/Phoenix',year:'numeric',
      month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const g = t => (p.find(x=>x.type===t)||{}).value;
    const want = g('year')+'-'+g('month')+'-'+g('day');
    if(stamp !== want) throw new Error('stamp '+stamp+' expected '+want);
    return stamp;
  });

  // ── Practice mode: the instructor's undo button ─────────────────────
  // The whole promise is that practice trades can be rolled back. These
  // drive the failure paths deliberately, because that is where the promise
  // used to break -- silently, mid-class.
  const yes = async fn => { const c=window.confirm; window.confirm=()=>true;
    try{ return await fn(); } finally{ window.confirm=c; } };

  await step('a practice round rolls back the trades made during it', async ()=>{
    UI.userId='u-chair'; UI.navTab='admin'; UI.adminTab='snapshots'; UI.companyPage=null; render();
    DB.session.status='open'; stub.data.jex_session[0].status='open';
    const me=stub.data.jex_users.find(u=>u.id==='u-stu');
    const cash0=me.cash, held0=(me.holdings.ACME||0);
    const co0=stub.data.jex_companies.find(c=>c.ticker==='ACME').price;

    await yes(()=>togglePracticeMode());
    if(!DB.session.practice_mode) throw new Error('practice mode did not start');
    if(!DB.session.practice_snapshot_id) throw new Error('no snapshot id was recorded');

    // Trade during the practice round.
    UI.userId='u-stu'; UI.navTab='market'; render();
    await paceOrders();
    await placeBuy('ACME', 4);
    const mid=stub.data.jex_users.find(u=>u.id==='u-stu');
    if((mid.holdings.ACME||0)===held0) throw new Error('the practice trade did not happen');

    UI.userId='u-chair'; UI.navTab='admin'; UI.adminTab='snapshots'; render();
    await yes(()=>togglePracticeMode());
    if(DB.session.practice_mode) throw new Error('practice mode did not end');

    const after=stub.data.jex_users.find(u=>u.id==='u-stu');
    if(Math.abs(after.cash-cash0)>0.01) throw new Error('cash not rolled back: '+after.cash+' vs '+cash0);
    if((after.holdings.ACME||0)!==held0) throw new Error('holdings not rolled back: '+after.holdings.ACME);
    const coNow=stub.data.jex_companies.find(c=>c.ticker==='ACME').price;
    if(Math.abs(coNow-co0)>0.01) throw new Error('price not rolled back: '+coNow+' vs '+co0);
    return 'rolled back to '+cash0;
  });

  await step('a failed snapshot does NOT start practice mode', async ()=>{
    // The old code flipped the flag with whatever came back, null included:
    // the banner said practice mode was on, everyone traded believing it was
    // reversible, and at the end there was nothing to restore.
    UI.userId='u-chair'; UI.navTab='admin'; UI.adminTab='snapshots'; render();
    stub.failSnapshotSave = true;
    try{ await yes(()=>togglePracticeMode()); }
    finally{ stub.failSnapshotSave = false; }
    if(DB.session.practice_mode)
      throw new Error('practice mode started with no snapshot -- nothing would be reversible');
    if(DB.session.practice_snapshot_id)
      throw new Error('a snapshot id was recorded despite the save failing');
    return 'refused to start';
  });

  await step('a failed restore keeps practice mode ON and keeps the snapshot', async ()=>{
    // The old code nulled practice_snapshot_id BEFORE restoring. If the
    // restore then failed, the id was gone with it and every practice trade
    // was permanent.
    UI.userId='u-chair'; UI.navTab='admin'; UI.adminTab='snapshots'; render();
    await yes(()=>togglePracticeMode());
    if(!DB.session.practice_mode) throw new Error('could not start practice mode for this check');
    const snapId=DB.session.practice_snapshot_id;
    if(!snapId) throw new Error('no snapshot id to lose');

    stub.failSnapshotRestore = true;
    try{ await yes(()=>togglePracticeMode()); }
    finally{ stub.failSnapshotRestore = false; }

    if(!DB.session.practice_mode)
      throw new Error('practice mode was turned off even though the restore failed');
    if(DB.session.practice_snapshot_id!==snapId)
      throw new Error('the snapshot id was discarded on a failed restore -- the rollback is now unreachable');

    // And retrying once the failure clears must work.
    await yes(()=>togglePracticeMode());
    if(DB.session.practice_mode) throw new Error('the retry did not end practice mode');
    return 'held the snapshot, then recovered';
  });

  await step('doRestoreSnapshot reports success and failure', async ()=>{
    const id=stub.data.jex_snapshots[0] && stub.data.jex_snapshots[0].id;
    if(!id) throw new Error('no snapshot to restore');
    const okRes=await doRestoreSnapshot(id);
    if(okRes!==true) throw new Error('a successful restore returned '+okRes);
    stub.failSnapshotRestore = true;
    let badRes;
    try{ badRes=await doRestoreSnapshot(id); }
    finally{ stub.failSnapshotRestore = false; }
    if(badRes!==false) throw new Error('a failed restore returned '+badRes);
    return 'true / false';
  });

  await step('a non-admin cannot restore a snapshot', async ()=>{
    UI.userId='u-stu';
    const id=stub.data.jex_snapshots[0].id;
    const before=stub.rpcCalls.filter(c=>c.fn==='rpc_admin_restore_snapshot').length;
    const res=await doRestoreSnapshot(id);
    if(res!==false) throw new Error('a student got '+res+' from a restore');
    if(stub.rpcCalls.filter(c=>c.fn==='rpc_admin_restore_snapshot').length!==before)
      throw new Error('a student\u2019s restore reached the server');
    UI.userId='u-chair';
    return 'refused';
  });

  await step('restoring clears working orders and stop-losses', async ()=>{
    UI.userId='u-chair'; UI.navTab='admin'; UI.adminTab='snapshots'; render();
    const o={id:'lo-snap', user_id:'u-stu', ticker:'ACME', side:'buy', qty:1,
      limit_price:1, status:'open', order_type:'gtc', created_at:new Date().toISOString()};
    DB.limitOrders.push(o); stub.data.jex_limit_orders.push(o);
    const sl={id:'sl-snap', user_id:'u-stu', ticker:'ACME', qty:1, trigger_price:1,
      status:'active', ts:'now', created_at:new Date().toISOString()};
    DB.stopLossOrders.push(sl); stub.data.jex_stop_loss.push(sl);
    const id=stub.data.jex_snapshots[0].id;
    await doRestoreSnapshot(id);
    if(stub.data.jex_limit_orders.some(x=>x.id==='lo-snap'&&x.status==='open'))
      throw new Error('an open order survived the restore');
    if(stub.data.jex_stop_loss.length)
      throw new Error('a stop-loss survived the restore');
    UI.userId='u-stu'; UI.navTab='market'; render();
    return 'cleared';
  });

  // ── Day one: registration and login ─────────────────────────────────
  // Thirty students all signing up and signing in at once is the very first
  // thing that has to work, and none of this path had ever been executed.
  const loginAs = async (tab, username, password) => {
    UI.userId=null; UI.loginView='select'; UI.loginTab=tab; UI.companyPage=null; render();
    const un=document.getElementById('login-username');
    const pw=document.getElementById('login-password');
    if(!un||!pw) throw new Error('no login form -- inputs: '+
      Array.prototype.map.call(document.querySelectorAll('#app input'),i=>i.id||i.type).join(','));
    un.value=username; pw.value=password;
    await loginByForm();
  };

  await step('a migrated account signs in with its real password', async ()=>{
    await loginAs('student','ariel','correcthorse');
    if(UI.userId!=='u-stu') throw new Error('not signed in: UI.userId='+UI.userId+
      ', error='+UI.loginError);
    if(!/Ariel/.test(appText())) throw new Error('signed in but the page does not show them');
    return 'in as '+UI.userId;
  });

  await step('the wrong password is refused, and says nothing useful', async ()=>{
    await loginAs('student','ariel','notmypassword');
    if(UI.userId) throw new Error('a wrong password signed in');
    if(!UI.loginError) throw new Error('no error shown');
    if(/exist|unknown|no such|not found/i.test(UI.loginError))
      throw new Error('the message leaks whether the account exists: '+UI.loginError);
    return UI.loginError;
  });

  await step('an unknown username gets the SAME message as a wrong password', async ()=>{
    await loginAs('student','ariel','notmypassword');
    const wrongPw=UI.loginError;
    await loginAs('student','nosuchperson','anything');
    if(UI.userId) throw new Error('an unknown username signed in');
    if(UI.loginError!==wrongPw)
      throw new Error('different messages let you enumerate accounts: '+
        JSON.stringify(wrongPw)+' vs '+JSON.stringify(UI.loginError));
    return 'identical: '+UI.loginError;
  });

  await step('a student cannot sign in on the admin tab', async ()=>{
    await loginAs('admin','ariel','correcthorse');
    if(UI.userId) throw new Error('a student signed in through the admin pool');
    return 'refused';
  });

  await step('an empty form is refused without a round trip', async ()=>{
    const before=stub.rpcCalls.filter(c=>c.fn==='rpc_resolve_login_identity').length;
    await loginAs('student','','');
    if(stub.rpcCalls.filter(c=>c.fn==='rpc_resolve_login_identity').length!==before)
      throw new Error('an empty form still queried the server');
    if(!UI.loginError) throw new Error('no error shown');
    return UI.loginError;
  });

  await step('a legacy account signs in and is migrated to real auth', async ()=>{
    const had=stub.auth.accounts.has('quinn@example.com');
    if(had) out.notes.push('quinn already had an auth account before this step');
    await loginAs('student','quinn','oldpassword1');
    if(UI.userId!=='u-quote') throw new Error('legacy login failed: '+UI.loginError);
    // The point of the legacy path: it quietly creates a real Auth identity,
    // which is what lets the account keep trading.
    if(!stub.auth.accounts.has('quinn@example.com'))
      throw new Error('signed in but no Auth identity was created -- this account cannot trade');
    return 'migrated';
  });

  await step("a legacy account's wrong password is still refused", async ()=>{
    await loginAs('student','quinn','wrongwrong');
    if(UI.userId) throw new Error('a wrong legacy password signed in');
    return UI.loginError;
  });

  // An unbacked sell limit order, found by the randomised run below and pinned
  // here so it stays fixed. Two separate things have to hold, and only the
  // second one actually protects the exchange.
  await step('a sell limit order must be backed by shares', async ()=>{
    const before=DB.limitOrders.length;
    const me=ME();
    const held=(me.holdings||{}).BETA||0;
    await placeLimitOrder('BETA','sell',held+500,1.00,null);
    if(DB.limitOrders.length!==before)
      throw new Error('an unbacked sell limit order was accepted onto the book');
    return 'refused at placement';
  });

  await step('a limit order that can no longer settle is cancelled, not filled', async ()=>{
    // The case a placement-time check CANNOT catch: the order was legitimate
    // when placed and stopped being so afterwards. Own some, promise them to
    // the book, then sell them out from under the promise.
    saveBandState();
    return withoutBreaker(async ()=>{
      try{
        const sco=stub.data.jex_companies.find(c=>c.ticker==='ACME');
        const seller=stub.data.jex_users.find(u=>u.id==='u-stu2');
        const buyer =stub.data.jex_users.find(u=>u.id==='u-stu');
        stub.data.jex_limit_orders.length=0;
        seller.holdings=Object.assign({},seller.holdings,{ACME:5});
        buyer.cash=Math.max(buyer.cash, 10000);
        // A matching pair that WOULD cross.
        stub.data.jex_limit_orders.push(
          {id:'lo-ask', user_id:'u-stu2', ticker:'ACME', side:'sell', qty:5,
           limit_price:1.00, status:'open', created_at:new Date(Date.now()-1000).toISOString()},
          {id:'lo-bid', user_id:'u-stu',  ticker:'ACME', side:'buy',  qty:5,
           limit_price:sco.price+50, status:'open', created_at:new Date().toISOString()});
        // ...and now the seller no longer has them.
        seller.holdings=Object.assign({},seller.holdings); delete seller.holdings.ACME;
        const r=await sb.rpc('rpc_match_limit_order_book',{p_ticker:'ACME'});
        if(r&&r.matched)
          throw new Error('the book matched against shares the seller no longer held');
        const after=(stub.data.jex_users.find(u=>u.id==='u-stu2').holdings||{}).ACME||0;
        if(after<0) throw new Error('the seller went to '+after+' shares');
        const ask=stub.data.jex_limit_orders.find(o=>o.id==='lo-ask');
        if(ask.status==='open')
          throw new Error('the unsettleable order is still resting on the book, where it will '+
            'block every match behind it and fail again on every poll');
        // The reason code has to match what the server actually sends, or
        // settleLimitOrder cannot tell the student WHY their order went. The
        // deployed function returns seller_insufficient_shares /
        // buyer_insufficient_funds, so the stub says the same words.
        if(r.reason!=='seller_insufficient_shares')
          throw new Error('reason was "'+r.reason+'" but the deployed function sends seller_insufficient_shares');
        if(r.cancelled_order_id!=='lo-ask')
          throw new Error('cancelled_order_id was '+r.cancelled_order_id+', not the ask');
        return 'not matched, order '+ask.status+', reason '+r.reason;
      } finally { stub.data.jex_limit_orders.length=0; restoreBandState(); }
    });
  });

  // ══════════════════════════════════════════════════════════
  // Randomised conservation run
  // ══════════════════════════════════════════════════════════
  //
  // Every other step in this file checks a situation someone thought of. The
  // bugs that actually hurt are the ones nobody thought of -- the fund NAV
  // gap, the buy-side-only price band, the frozen ticker. So this one does not
  // pick situations at all: it fires hundreds of arbitrary operations at the
  // exchange and, after EVERY ONE, checks that the books still balance.
  //
  // It cannot find a bug in your Postgres functions -- it drives the stub,
  // which is my model of them. What it CAN do is prove the model is
  // internally consistent under pressure, and an invariant that breaks here is
  // worth going and checking against the real SQL, because the two are meant
  // to implement the same arithmetic.
  //
  // Seeded, so a failure is reproducible rather than "it went red once on
  // Tuesday". The seed and the operation number are in the message.
  //
  // The invariants are deliberately the ones that are TRUE BY CONSTRUCTION for
  // a correct exchange, not approximations:
  //
  //   shares       every share exists in exactly one place. sum(all holdings)
  //                + shares_avail never changes for a company, no matter what
  //                trades happen. Only issuance and buybacks may move it, and
  //                those are excluded from the operation mix for that reason.
  //   fund units   units_outstanding equals the sum of what unit-holders hold.
  //                A deposit that mints the wrong number of units breaks this
  //                -- which is exactly the class of bug the NAV gap was.
  //   floors       no negative cash, no negative holding, no negative unit
  //                count. Postgres has CHECK constraints for the first two;
  //                this catches the client and the model disagreeing before
  //                the database has to.
  //   collateral   every open short holds exactly 150% of its entry value.
  //   numbers      nothing is NaN. A single NaN silently poisons net worth,
  //                the leaderboard and every statistic derived from it.
  const mulberry32 = a => () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };

  // Several seeds, because one seed explores exactly one path through the
  // engine and proves nothing about the others. Each is cheap (~1.3s) and
  // deterministic, so a failure names the seed and can be replayed exactly.
  for(const SEED of [20260823, 7, 991117]){
  await step('randomised trading keeps the books balanced (seed '+SEED+')', async ()=>{
    const OPS = 250;
    const rnd = mulberry32(SEED);
    const pick = arr => arr[Math.floor(rnd()*arr.length)];

    // Full snapshot; this run mutates everything and must leave no trace.
    const savedStub = JSON.parse(JSON.stringify(stub.data));
    const savedDB   = JSON.parse(JSON.stringify({users:DB.users, companies:DB.companies,
                                                 funds:DB.funds, session:DB.session}));
    const savedUser = UI.userId;

    return withoutBreaker(async ()=>{
      try{
        // Tradeable, non-index tickers only. JXI mints on demand, so its
        // shares_avail is units outstanding rather than a fixed float and the
        // conservation identity below does not apply to it.
        const tickers = stub.data.jex_companies
          .filter(c=>!c.is_index_fund && c.status!=='delisted').map(c=>c.ticker);
        const students = stub.data.jex_users.filter(u=>u.role==='student').map(u=>u.id);
        const fundIds  = (stub.data.jex_funds||[]).map(f=>f.id);
        if(!tickers.length || !students.length) throw new Error('nothing to fuzz with');

        // Baseline the conserved quantities rather than assuming the seed is
        // already balanced -- what matters is that they do not CHANGE.
        const sharesOf = t => stub.data.jex_users.reduce((n,u)=>n+((u.holdings||{})[t]||0), 0)
                            + (stub.data.jex_companies.find(c=>c.ticker===t).shares_avail||0);
        const unitsOf  = f => stub.data.jex_users.reduce((n,u)=>{
                                const p=(u.fund_units||{})[f]; return n+(p&&p.units||0); }, 0);
        const priceOf  = t => (stub.data.jex_companies.find(c=>c.ticker===t)||{}).price || 1;
        const baseShares = {}; tickers.forEach(t=>baseShares[t]=sharesOf(t));
        // The GAP between the fund's own unit count and what holders actually
        // hold -- baselined, not assumed zero. Earlier steps deliberately park
        // a fund at units_outstanding=100 with a single 10-unit holder to test
        // NAV, so demanding equality here fails before the fuzz even starts.
        // What must not change is the gap: a deposit that mints the wrong
        // number of units moves it, which is exactly the NAV-gap bug's shape.
        const gapOf = f => Math.round(((stub.data.jex_funds.find(x=>x.id===f)||{}).units_outstanding||0)
                                      - unitsOf(f)) ;
        const baseGap = {}; fundIds.forEach(f=>baseGap[f]=gapOf(f));

        const bad = (i, op, msg) =>
          new Error('seed '+SEED+', op #'+i+' ('+op+'): '+msg);

        let attempted=0, succeeded=0;
        for(let i=0;i<OPS;i++){
          resetLimiter();                      // pacing is not what this tests
          UI.userId = pick(students);
          const t = pick(tickers);
          const qty = 1 + Math.floor(rnd()*40);
          const op = pick(['buy','buy','sell','sell','short','cover','limit',
                           'fundIn','fundOut']);
          attempted++;
          const before = JSON.stringify(stub.data.jex_users.map(u=>u.cash));
          try{
            if(op==='buy')        await placeBuy(t, qty);
            else if(op==='sell')  await placeSell(t, qty);
            else if(op==='short') await placeShort(t, qty);
            else if(op==='cover') await coverShort(t, qty);
            else if(op==='limit') await placeLimitOrder(t, rnd()<0.5?'buy':'sell', qty,
                                     Math.round(priceOf(t)*(0.8+rnd()*0.4)*100)/100, null);
            else if(op==='fundIn'  && fundIds.length)
              await depositToFund(pick(fundIds), Math.round(rnd()*500*100)/100);
            else if(op==='fundOut' && fundIds.length)
              await withdrawFromFund(pick(fundIds), Math.round(rnd()*5*100)/100);
          }catch(e){ /* a refused order is a legitimate outcome, not a failure */ }
          if(JSON.stringify(stub.data.jex_users.map(u=>u.cash))!==before) succeeded++;

          // ── the books, after every single operation ──
          for(const u of stub.data.jex_users){
            if(!(u.cash >= -0.005)) throw bad(i, op, u.id+' has negative cash: '+u.cash);
            if(Number.isNaN(u.cash)) throw bad(i, op, u.id+' cash is NaN');
            for(const [tk,n] of Object.entries(u.holdings||{})){
              if(!(n >= 0)) throw bad(i, op, u.id+' holds '+n+' of '+tk);
              if(Number.isNaN(n)) throw bad(i, op, u.id+' holding of '+tk+' is NaN');
            }
            for(const [tk,sh] of Object.entries(u.shorts||{})){
              if(!sh) continue;
              if(!(sh.qty >= 0)) throw bad(i, op, u.id+' short qty '+sh.qty+' on '+tk);
              // RELATIVE tolerance, and the reason matters more than the number.
              //
              // collateral accumulates the cash actually deducted on each
              // short, every instalment rounded to a cent. avgPrice is a
              // rounded weighted average. Two independently rounded numbers
              // cannot stay exactly consistent: short 10 at 12.34 then 7 at
              // 13.01 and collateral is 321.71 while 1.5 x 12.62 x 17 is
              // 321.81.
              //
              // The drift is in avgPrice, which is DERIVED, not in the money.
              // Cover releases collateral * (qty/sh.qty), so exactly what was
              // locked comes back. Recomputing collateral from avgPrice to
              // make this exact would make the locked cash differ from the
              // cash deducted, which really would create or destroy money.
              //
              // So this is not the check being loosened to go green. An actual
              // formula error -- dropping the 1.5, using the current price
              // instead of the entry price -- is wrong by tens of percent and
              // still caught. Rounding drift is a fraction of one percent.
              const want = Math.round(sh.avgPrice*sh.qty*1.5*100)/100;
              if(Math.abs((sh.collateral||0) - want) > Math.max(0.05, want*0.01))
                throw bad(i, op, u.id+' short on '+tk+' holds '+sh.collateral+
                  ' collateral, 150% of entry is '+want+' -- off by '+
                  (Math.round(Math.abs(sh.collateral-want)/want*10000)/100)+'%, too much for rounding');
              if(sh.collateral < 0) throw bad(i, op, u.id+' short collateral is negative');
            }
            for(const [fid,pos] of Object.entries(u.fund_units||{})){
              if(pos && !(pos.units >= 0)) throw bad(i, op, u.id+' holds '+pos.units+' units of '+fid);
            }
          }
          for(const tk of tickers){
            const now = sharesOf(tk);
            if(now !== baseShares[tk])
              throw bad(i, op, tk+': shares went from '+baseShares[tk]+' to '+now+
                ' -- stock was created or destroyed by trading');
          }
          for(const fid of fundIds){
            const f = stub.data.jex_funds.find(x=>x.id===fid);
            if(Math.abs(gapOf(fid) - baseGap[fid]) > 0.5)
              throw bad(i, op, fid+': units_outstanding minus holders went from '+
                baseGap[fid]+' to '+gapOf(fid)+' -- a deposit or withdrawal minted the wrong number');
            if(Number.isNaN(f.cash)) throw bad(i, op, fid+' fund cash is NaN');
            if(!(f.cash >= -0.005)) throw bad(i, op, fid+' fund cash went negative: '+f.cash);
          }
          for(const c of stub.data.jex_companies){
            if(Number.isNaN(c.price)) throw bad(i, op, c.ticker+' price is NaN');
            if(!(c.price > 0)) throw bad(i, op, c.ticker+' price fell to '+c.price);
          }
        }
        return OPS+' ops, '+succeeded+' changed money, books balanced throughout';
      } finally {
        // Restored IN PLACE. stub.data is the very object the stub's own
        // handlers close over -- reassigning it hands the tests a fresh copy
        // while the engine goes on writing to the original, and the two
        // silently diverge. That is exactly what happened on the first run:
        // registration afterwards wrote to the old object and the assertions
        // read the new one, so a passing feature looked broken.
        for(const k of Object.keys(savedStub)){
          if(Array.isArray(stub.data[k])){
            stub.data[k].length = 0;
            JSON.parse(JSON.stringify(savedStub[k])).forEach(r=>stub.data[k].push(r));
          }
        }
        DB.users=savedDB.users; DB.companies=savedDB.companies;
        DB.funds=savedDB.funds; Object.assign(DB.session, savedDB.session);
        UI.userId=savedUser;
        stub.data.jex_halts.length=0; DB.halts.length=0;
      }
    });
  });
  }

  await step('resolving a login identity hands back no secrets', async ()=>{
    // This RPC takes a USERNAME ONLY and is callable by anyone, before any
    // password has been checked -- so whatever it returns is readable by an
    // unauthenticated stranger for any account they can name.
    //
    // Anything hash-shaped in that response would be crackable OFFLINE, where
    // no server-side throttle can reach it. That makes this a stricter
    // boundary than the bulk read, not a looser one, even though this returns
    // a single row the caller is about to log in as.
    //
    // email is expected and required: loginByForm needs it to call
    // supaAuth.signInWithPassword for migrated accounts.
    const row=await sb.rpc('rpc_resolve_login_identity',{p_identifier:'ariel',p_pool:'student'});
    if(!row) throw new Error('a known username did not resolve');
    for(const f of ['password','sec_a','legacy_password']){
      if(row[f]!==undefined) throw new Error('rpc_resolve_login_identity returned '+f+
        ' -- an unauthenticated caller can harvest that for any username and crack it offline');
    }
    // Nor anything else that is none of a stranger's business. These are not
    // secrets in the hash sense -- every signed-in student already sees the
    // balances through the bulk read -- but this lookup happens BEFORE any
    // password is checked, so whatever it returns is public to anyone who can
    // guess a username. notification_email is the sharpest of them: a personal
    // address the student chose to enter, that login has no use for at all.
    for(const f of ['notification_email','cash','holdings','shorts','fund_units','watchlist']){
      if(row[f]!==undefined) throw new Error('rpc_resolve_login_identity returned '+f+
        ' -- readable by anyone who can guess a username, before any password check');
    }
    // email must survive: supaAuth.signInWithPassword needs the real address,
    // so there is no version of this that keeps it from the client.
    if(!row.email) throw new Error('email is missing, so migrated sign-in cannot work');
    return 'login fields only';
  });

  // ── password recovery: the takeover chain ─────────────────
  //
  // Driven end to end rather than reasoned about, because this is the one
  // path in JEX that needs no cleverness to abuse: the security question is
  // one of eight canned ones and sec_q ships in the bulk user list, so an
  // attacker knows WHICH question before they start guessing. Guess the
  // answer, then reset_migrated_password writes a new password into the auth
  // store, and the account is theirs.
  //
  // "u-stu" is the target here, and the attacker is nobody -- these calls run
  // signed out, exactly as they would from a console on the login screen.
  await step('a wrong security answer is refused', async ()=>{
    UI.userId=null;
    stub.recoveryAttempts.clear();
    UI.forgotUserId='u-stu';
    await forgotStep2('not-the-answer');
    if(UI.loginView==='forgot-newpw') throw new Error('a wrong answer advanced to the reset screen');
    return 'refused';
  });

  await step('the right security answer advances, and is case-insensitive', async ()=>{
    stub.recoveryAttempts.clear();
    UI.userId=null; UI.forgotUserId='u-stu'; UI.loginView='forgot-secq';
    await forgotStep2('  REX  ');           // stored as 'rex'
    if(UI.loginView!=='forgot-newpw') throw new Error('the correct answer did not advance');
    return 'advanced';
  });

  await step('guessing the security answer is throttled after 8 attempts', async ()=>{
    stub.recoveryAttempts.clear();
    UI.userId=null; UI.forgotUserId='u-stu'; UI.loginView='forgot-secq';
    const sent = () => stub.rpcCalls.filter(c=>c.fn==='verify_legacy_security_answer').length;
    const before = sent();
    // Eight wrong guesses: all reach the server, all refused on the merits.
    for(let i=0;i<8;i++) await forgotStep2('guess-'+i);
    if(sent() !== before+8) throw new Error('only '+(sent()-before)+' of 8 guesses reached the server');
    if(UI.loginView==='forgot-newpw') throw new Error('a wrong guess advanced');
    // The ninth is refused by the throttle, and must SAY so -- the failure
    // this guards against is the catch turning a lockout into "Incorrect
    // answer -- try again", which tells a student who is answering correctly
    // to keep trying forever.
    await forgotStep2('guess-9');
    const t = lastToast();
    if(!/Too many attempts/i.test(t))
      throw new Error('the 9th attempt was not reported as throttled -- toast: '+t);
    return '8 through, 9th throttled';
  });

  await step('the throttle still refuses even the CORRECT answer once tripped', async ()=>{
    // The point of the counter: an attacker who guesses right on attempt 20
    // still gets nothing. If a correct answer bypassed the throttle, the
    // throttle would only be slowing a brute force down, not stopping it.
    stub.recoveryAttempts.clear();
    UI.userId=null; UI.forgotUserId='u-stu'; UI.loginView='forgot-secq';
    for(let i=0;i<9;i++) await forgotStep2('guess-'+i);
    await forgotStep2('rex');
    if(UI.loginView==='forgot-newpw')
      throw new Error('the correct answer got through AFTER the account was throttled');
    if(!/Too many attempts/i.test(lastToast()))
      throw new Error('expected a throttle message, got: '+lastToast());
    return 'still refused';
  });

  await step('the password reset itself is throttled, not just the oracle', async ()=>{
    // reset_migrated_password reads sec_a directly instead of calling the
    // verify function, so it needs its OWN guard. Without that, skipping
    // step 2 and brute-forcing step 3 directly would be completely uncounted
    // -- and step 3 is the one that actually takes the account over.
    stub.recoveryAttempts.clear();
    UI.userId=null; UI.forgotUserId='u-stu'; UI.forgotAnswer='wrong-answer';
    const sent = () => stub.rpcCalls.filter(c=>c.fn==='reset_migrated_password').length;
    const before = sent();
    for(let i=0;i<8;i++) await forgotStep3('newpassword1','newpassword1');
    if(sent() !== before+8) throw new Error('only '+(sent()-before)+' of 8 resets reached the server');
    await forgotStep3('newpassword1','newpassword1');
    if(!/Too many attempts/i.test(lastToast()))
      throw new Error('the 9th reset attempt was not throttled -- toast: '+lastToast());
    return '8 through, 9th throttled';
  });

  await step('a throttled account is not left with a changed password', async ()=>{
    // The whole point. After all that guessing, the real credential must be
    // untouched -- verified by actually signing in with it.
    stub.recoveryAttempts.clear();
    UI.userId=null; UI.forgotUserId=null; UI.forgotAnswer=null;
    await loginAs('student','ariel','correcthorse');
    if(!UI.userId) throw new Error('the original password no longer works -- the account WAS taken over');
    return 'original password still works';
  });

  await step('a fresh load drops every cached email', async ()=>{
    // loginByForm caches the caller's own row, email included. A reload
    // rebuilds DB.users from the bulk endpoint, which carries no emails at
    // all -- so nothing persists between sessions.
    const fresh=await sb.get('jex_users','order=created_at.asc&select='+JEX_USERS_SAFE_SELECT);
    const withEmail=fresh.filter(u=>u.email||u.notification_email);
    if(withEmail.length) throw new Error(withEmail.length+' rows came back from the bulk read with an email');
    // Exact column names: email_notifications is a boolean preference, not an
    // address, and is legitimately in the list.
    const cols=JEX_USERS_SAFE_SELECT.split(',').map(c=>c.trim());
    const addr=cols.filter(c=>c==='email'||c==='notification_email');
    if(addr.length)
      throw new Error('the bulk select asks for '+addr.join(' and ')+': '+JEX_USERS_SAFE_SELECT);
    DB.users=fresh;   // leave the cache in the state a reload would produce
    return fresh.length+' rows, none with an email';
  });


  await step('registering files a pending request, not an account', async ()=>{
    UI.userId=null; UI.loginView='register'; UI.loginTab='student'; render();
    const pending0=DB.pending.length, users0=DB.users.length;
    await registerStudent('Newcomer Student','newcomer','newcomer@example.com',
      'goodpassword','pet','Rex',true);
    if(DB.users.length!==users0) throw new Error('registration created a live account directly');
    if(stub.data.jex_pending.length!==pending0+1)
      throw new Error('no pending request was filed');
    const rec=stub.data.jex_pending[stub.data.jex_pending.length-1];
    if(rec.role!=='student') throw new Error('role came out as '+rec.role);
    return rec.name+' pending';
  });

  await step('a company registration files a pending request too', async ()=>{
    // registerCompany was one of only three server-touching functions in
    // app.js that nothing in either harness reached. It is a near-copy of
    // registerStudent, and a line-by-line diff of the two turned up no
    // asymmetry -- but "I read it and it looked the same" is exactly the
    // claim this harness exists to stop anyone making.
    UI.userId=null; UI.loginView='register'; UI.loginTab='company'; render();
    const pending0=stub.data.jex_pending.length, users0=DB.users.length;
    await registerCompany('Newco Industries','newco','newco@example.com',
      'goodpassword','We make excellent widgets','pet','Rex',true);
    if(DB.users.length!==users0) throw new Error('company registration created a live account directly');
    if(stub.data.jex_pending.length!==pending0+1) throw new Error('no pending request was filed');
    const rec=stub.data.jex_pending[stub.data.jex_pending.length-1];
    if(rec.role!=='company') throw new Error('role came out as '+rec.role);
    // The description is the one field a company signup carries that a
    // student's does not -- and the one the approval screen shows.
    if(!rec.description||!/widgets/.test(rec.description))
      throw new Error('the description did not reach the pending row: '+rec.description);
    return rec.name+' pending';
  });

  await step('a company registration without a description is refused', async ()=>{
    const before=stub.data.jex_pending.length;
    await registerCompany('Nodesc Corp','nodesc','nodesc@example.com',
      'goodpassword','','pet','Rex',true);
    if(stub.data.jex_pending.length!==before)
      throw new Error('a company with no description was filed anyway');
    return 'refused';
  });

  await step('a registration cannot choose its own role', ()=>{
    // The RPC pins the role; the raw POST it replaced let a signup claim
    // chairman and get approved through a screen that showed nothing odd.
    const calls=stub.rpcCalls.filter(c=>c.fn==='rpc_register_pending');
    if(!calls.length) throw new Error('no registration was sent');
    const elevated=stub.data.jex_pending.filter(r=>
      !['student','company'].includes(r.role));
    if(elevated.length) throw new Error('a pending row carries role '+elevated[0].role);
    return 'pinned to student/company';
  });

  await step('a duplicate username is refused', async ()=>{
    const before=stub.data.jex_pending.length;
    await registerStudent('Someone Else','ariel','different@example.com',
      'goodpassword','pet','Rex',true);
    if(stub.data.jex_pending.length!==before)
      throw new Error('a duplicate username was accepted');
    return 'refused';
  });

  await step('a duplicate email is refused', async ()=>{
    const before=stub.data.jex_pending.length;
    await registerStudent('Another Person','anotherperson','ariel@example.com',
      'goodpassword','pet','Rex',true);
    if(stub.data.jex_pending.length!==before)
      throw new Error('a duplicate email was accepted');
    return 'refused';
  });

  await step('a short password is refused before any account is made', async ()=>{
    const before=stub.data.jex_pending.length;
    const authBefore=stub.auth.accounts.size;
    await registerStudent('Short Password','shortpw','shortpw@example.com',
      'abc','pet','Rex',true);
    if(stub.data.jex_pending.length!==before) throw new Error('a short password was accepted');
    if(stub.auth.accounts.size!==authBefore)
      throw new Error('an orphan Auth account was created for a rejected registration');
    return 'refused';
  });

  await step('signing back in leaves the app usable', async ()=>{
    await loginAs('student','ariel','correcthorse');
    if(UI.userId!=='u-stu') throw new Error('could not sign back in: '+UI.loginError);
    for(const t of ['market','portfolio','orders','leaderboard','settings']){
      UI.navTab=t; render();
      if(!appText().trim()) throw new Error('blank '+t+' after signing back in');
    }
    UI.navTab='market'; render();
    return 'usable';
  });

  await step("no other student's email is cached in this browser", async ()=>{
    // The column grants exclude email from bulk jex_users reads, and the
    // harness strips it the same way. One row legitimately carries an email:
    // rpc_resolve_login_identity returns the caller's OWN row on sign-in,
    // because loginByForm needs the address to call Supabase Auth with. The
    // invariant that matters is that nobody ELSE's turns up.
    const withEmail=DB.users.filter(u=>u.email);
    const others=withEmail.filter(u=>u.id!==UI.userId);
    if(others.length) throw new Error(others.length+" other user(s) have an email cached here: "+
      others.map(u=>u.username).join(','));
    const secrets=DB.users.filter(u=>u.password||u.sec_a||u.legacy_password);
    if(secrets.length) throw new Error('password material reached the client for '+
      secrets.map(u=>u.username).join(','));
    return withEmail.length+' of '+DB.users.length+' rows carry an email (own only)';
  });

  await step('logout renders the login screen', ()=>{
    UI.companyPage=null; UI.navTab='market';
    logout();
    const t = appText();
    if(!/Sign in|Log in|Login|Register|Create account/i.test(t)) throw new Error('no login UI: '+t.slice(0,80));
  });
  // Every signed-out view, including the recovery flows nobody clicks through
  // until a student is locked out mid-class.
  for(const lv of ['select','register','forgot-email','forgot-secq','forgot-newpw','recover-pw']){
    await step('login view: '+lv, ()=>{
      UI.userId=null; UI.loginView=lv; render();
      if(!appText().trim()) throw new Error('blank login view');
      return appText().length+' chars';
    });
  }
  await step('register form: both role tabs', ()=>{
    UI.userId=null; UI.loginView='register';
    for(const lt of ['student','company']){ UI.loginTab=lt; render(); if(!appText().trim()) throw new Error('blank '+lt); }
    UI.loginTab='student';
  });

  await sleep(300);
  out.errors = stub.errors;
  out.consoleErrors = stub.consoleErrors;
  return out;
})()
`;

(async function main(){
  await new Promise(r=>server.listen(PORT, r));
  const harness = fs.readFileSync(path.join(__dirname,'harness.html'),'utf8');
  const keep = process.argv.includes('--keep');
  const only = (process.argv.find(a=>a.startsWith('--only='))||'').split('=')[1];

  // The full driver exercises the mid-semester exchange end to end. The
  // variants re-run a whole-app sweep against a deliberately awkward state --
  // the empty exchange the app is actually in on day one, a closed session, a
  // halted ticker, a student who has never traded, a company split into share
  // classes, and rows carrying the nulls the schema permits.
  const SCENARIOS = [
    {name:'default',    driver:DRIVER,       args:[]},
    // The same populated exchange, swept: this is where the inline-handler
    // audit has the most to look at, because the rich pages are the ones that
    // build onclick strings out of ids, tickers and student names.
    {name:'default',    driver:SWEEP_DRIVER, args:[], label:'default-sweep'},
    {name:'empty',      driver:SWEEP_DRIVER, args:[]},
    {name:'closed',     driver:SWEEP_DRIVER, args:[]},
    {name:'halted',     driver:SWEEP_DRIVER, args:[]},
    {name:'newstudent', driver:SWEEP_DRIVER, args:[]},
    {name:'classes',    driver:SWEEP_DRIVER, args:[]},
    {name:'ragged',     driver:SWEEP_DRIVER, args:[]},
    // Same seeded exchange, phone-sized viewport: renders the mobile bottom
    // nav branch (_isMobileStudent, window.innerWidth<=640) that the desktop
    // runs never touch.
    {name:'default',    driver:DRIVER,       args:['--window-size=380,780'], label:'mobile'},
    // The same run with the DEVICE in another timezone. Every Arizona-time bug
    // this suite has found was invisible from Arizona and only showed up
    // elsewhere -- a student at home, or a laptop whose clock was never set.
    {name:'default',    driver:DRIVER,       args:[], label:'tz-utc',   tz:'UTC'},
    {name:'default',    driver:DRIVER,       args:[], label:'tz-tokyo', tz:'Asia/Tokyo'},
  ].filter(sc => !only || (sc.label||sc.name)===only);

  let totalFailed=0, totalSteps=0, failedScenarios=[];
  for(const sc of SCENARIOS){
    const label = sc.label || sc.name;
    console.log('\n\u001b[1m### scenario: '+label+'\u001b[0m');
    const file = '_driven_'+label+'.html';
    // A replacer FUNCTION, never a replacement string: String.replace expands
    // $&, $', $` and $n inside a string replacement, and the driver contains
    // the character class [^.\\w$'"] -- whose $' spliced the rest of the
    // document into the middle of a regex literal, so the injected script
    // failed to PARSE and the page did nothing at all. No steps, no watchdog,
    // no error: just a runner timeout with no information in it.
    const driven = harness.replace('</body>', () => '<script>\n' +
      'function __post(res){\n' +
      '  // XHR, not fetch: the stub owns window.fetch and the app owns everything else.\n' +
      '  const x = new XMLHttpRequest();\n' +
      '  x.open("POST","/__result",true);\n' +
      '  x.setRequestHeader("Content-Type","text/plain");\n' +
      '  x.send(JSON.stringify(res));\n}\n' +
      '(async()=>{\n' +
      '  let done=false;\n' +
      '  // Watchdog: if a step hangs, post what has run so far plus the name of\n' +
      '  // the step still in flight, instead of leaving the runner with nothing.\n' +
      '  setTimeout(()=>{ if(done) return;\n' +
      '    const o = window.__OUT__ || {steps:[],errors:[],notes:[]};\n' +
      '    o.stalled = o.inFlight || "(before the first step)";\n' +
      '    o.errors = (window.__JEX_STUB__||{}).errors||[];\n' +
      '    o.consoleErrors = (window.__JEX_STUB__||{}).consoleErrors||[];\n' +
      '    __post(o); }, ' + DRIVER_WATCHDOG_MS + ');\n' +
      '  let res;\n' +
      '  try{ res = await (' + sc.driver + '); }\n' +
      '  catch(e){ res = window.__OUT__ || {steps:[], errors:[], notes:[]};\n' +
      '           res.steps.push({name:"DRIVER CRASHED", ok:false, info:(e&&e.message)||String(e), stack:e&&e.stack});\n' +
      '           res.errors=(window.__JEX_STUB__||{}).errors||[];\n' +
      '           res.consoleErrors=(window.__JEX_STUB__||{}).consoleErrors||[]; }\n' +
      '  done=true;\n' +
      '  __post(res);\n})();\n</script></body>');
    // Check the injected script PARSES before spending 150s finding out the
    // hard way. A driver with a syntax error runs nothing at all -- no steps,
    // no watchdog, no console error that anything is listening for -- and
    // looks exactly like a hang. Two separate escaping slips cost a debugging
    // round each before this existed.
    // Escapes eaten by the template literal. The driver is written inside a JS
    // template literal, where an unrecognized escape like \\d collapses to a
    // bare d -- so /[0-9]{2}/ written as a \\d regex silently becomes /d{2}/,
    // which still COMPILES and still runs and simply never matches. A test
    // that cannot fail is worse than no test, so regexes in the driver are
    // written without backslash escapes and this catches any that are not.
    {
      const EATEN=/[^A-Za-z0-9\\]([dwsSDWbB])[{+*?]/;
      const lits=(sc.driver.match(/\/(?![\/*])(?:\\.|\[[^\]]*\]|[^\/\n\\])+\/[gimsuy]*/g)||[]);
      const bad=lits.filter(l=>EATEN.test(l));
      if(bad.length){
        console.log('  DRIVER REGEX LOOKS LIKE AN ESCAPE WAS EATEN by the template literal:');
        for(const b of bad.slice(0,6)) console.log('        '+b);
        console.log('        (write driver regexes without backslash escapes, e.g. [0-9] not \\d)');
        totalFailed++; failedScenarios.push(label);
        continue;
      }
    }
    try{ new Function(sc.driver); }
    catch(e){
      console.log('  DRIVER DOES NOT PARSE: '+((e&&e.message)||e));
      const m=/:(\d+)\b/.exec((e&&e.stack)||'');
      const lines=sc.driver.split('\n');
      const near=lines.findIndex(l=>/step\(/.test(l)&&l.includes("'")&&l.includes('"'));
      if(near>=0) console.log('  possibly near line '+(near+1)+': '+lines[near].trim().slice(0,120));
      totalFailed++; failedScenarios.push(label);
      continue;
    }
    fs.writeFileSync(path.join(__dirname,file), driven);

    const userDir = fs.mkdtempSync('/tmp/jex-chrome-');
    const got = armResult();
    const chrome = spawn(CHROME, ['--headless','--disable-gpu','--no-sandbox','--disable-dev-shm-usage',
      '--user-data-dir='+userDir, '--no-first-run', '--disable-extensions'].concat(sc.args).concat([
      'http://127.0.0.1:'+PORT+'/tests/browser/'+file+'?scenario='+sc.name]),
      {stdio:['ignore','ignore','pipe'],
       env: sc.tz ? Object.assign({}, process.env, {TZ:sc.tz}) : process.env});
    let stderr=''; chrome.stderr.on('data',d=>{stderr+=d;});

    let timer;
    const raw = await Promise.race([got, new Promise(r=>{timer=setTimeout(()=>r(null), WALL_TIMEOUT_MS);})]);
    clearTimeout(timer);
    try{ chrome.kill('SIGKILL'); }catch(e){}
    try{fs.rmSync(userDir,{recursive:true,force:true});}catch(e){}
    if(!keep){ try{fs.unlinkSync(path.join(__dirname,file));}catch(e){} }

    if(raw===null){
      console.error('  the driver never posted a result within '+(WALL_TIMEOUT_MS/1000)+'s.');
      const interesting = stderr.split('\n').filter(l=>l && !/dbus|DEPRECATED|Fontconfig|GLES|vulkan|sandbox/i.test(l));
      if(interesting.length) console.error('  chromium stderr:\n  '+interesting.slice(0,15).join('\n  '));
      totalFailed++; failedScenarios.push(label);
      continue;
    }

    const res = JSON.parse(raw);
    let failed=0;
    if(res.stalled){
      failed++;
      console.log('  STALLED in step: '+res.stalled+'  (after '+res.steps.length+' completed steps)');
    }
    for(const s2 of res.steps){
      if(s2.ok){ console.log('  ok    '+s2.name+(s2.info?'   ('+s2.info+')':'')); }
      else { failed++; console.log('  FAIL  '+s2.name+'   '+(s2.info||''));
             if(s2.stack)console.log('        '+String(s2.stack).split('\n').slice(0,3).join('\n        ')); }
    }
    for(const n of res.notes||[]) console.log('  note  '+n);

    if((res.errors||[]).length){
      console.log('  -- uncaught errors / unhandled rejections in the page:');
      for(const e of res.errors){
        failed++;
        console.log('  ERROR ['+e.type+'] '+e.message+(e.source?'  @ '+e.source:''));
        if(e.stack)console.log('        '+String(e.stack).split('\n').slice(0,4).join('\n        '));
      }
    }
    const ce = (res.consoleErrors||[]).filter(m=>!/Failed to load resource|net::ERR/.test(m));
    if(ce.length){
      console.log('  -- console.error() output (not necessarily fatal):');
      for(const m of ce.slice(0,20)) console.log('        '+m.slice(0,200));
    }

    totalSteps += res.steps.length;
    totalFailed += failed;
    if(failed) failedScenarios.push(label);
    console.log('  '+(res.steps.length-res.steps.filter(x=>!x.ok).length)+'/'+res.steps.length+' steps passed');
  }

  server.close();
  console.log('\n'+(failedScenarios.length
    ? failedScenarios.length+' scenario(s) failed: '+[...new Set(failedScenarios)].join(', ')
    : 'all scenarios green')+'  ('+totalSteps+' steps total)');
  process.exit(totalFailed?1:0);
})();
