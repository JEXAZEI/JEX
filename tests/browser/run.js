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
  const step = async (name, fn) => {
    out.inFlight = name;
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
  // placeBuy/placeSell go through checkRateLimit(), which enforces THREE
  // limits: a 0.8s minimum gap, at most 3 orders in any 5s window, and at
  // most order_rate_limit (10) per minute. Firing orders back to back is
  // exactly what that is there to stop, so the driver paces itself rather
  // than fighting it -- 1.8s keeps a steady stream under the burst rule.
  // Shorts, covers, watchlist toggles and votes are not rate limited.
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
