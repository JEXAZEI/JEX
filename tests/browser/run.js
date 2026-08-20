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
const WALL_TIMEOUT_MS = 90000;

let resolveResult;
const resultPromise = new Promise(r=>{resolveResult=r;});

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
const DRIVER = `
(async () => {
  const out = {steps:[], errors:[], notes:[], consoleErrors:[]};
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const stub = window.__JEX_STUB__;
  const step = async (name, fn) => {
    try { const r = await fn(); out.steps.push({name, ok:true, info:r===undefined?'':String(r)}); }
    catch(e){ out.steps.push({name, ok:false, info:(e && e.message)||String(e), stack:e && e.stack}); }
  };
  const appText = () => (document.getElementById('app')||{}).textContent || '';
  const appHtml = () => (document.getElementById('app')||{}).innerHTML || '';

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
  const userDir = fs.mkdtempSync('/tmp/jex-chrome-');

  const harness = fs.readFileSync(path.join(__dirname,'harness.html'),'utf8');
  const driven = harness.replace('</body>', `<script>
(async()=>{
  let res;
  try{ res = await (${DRIVER}); }
  catch(e){ res = {steps:[{name:'DRIVER CRASHED', ok:false, info:(e&&e.message)||String(e), stack:e&&e.stack}],
                   errors:(window.__JEX_STUB__||{}).errors||[], notes:[],
                   consoleErrors:(window.__JEX_STUB__||{}).consoleErrors||[]}; }
  // XHR, not fetch: the stub owns window.fetch and the app owns everything else.
  const x = new XMLHttpRequest();
  x.open('POST','/__result',true);
  x.setRequestHeader('Content-Type','text/plain');
  x.send(JSON.stringify(res));
})();
</script></body>`);
  fs.writeFileSync(path.join(__dirname,'_driven.html'), driven);

  const chrome = spawn(CHROME, ['--headless','--disable-gpu','--no-sandbox','--disable-dev-shm-usage',
    '--user-data-dir='+userDir, '--no-first-run', '--disable-extensions',
    `http://127.0.0.1:${PORT}/tests/browser/_driven.html`],
    {stdio:['ignore','ignore','pipe']});
  let stderr='';
  chrome.stderr.on('data',d=>{stderr+=d;});

  const timeout = new Promise(r=>setTimeout(()=>r(null), WALL_TIMEOUT_MS));
  const raw = await Promise.race([resultPromise, timeout]);

  try{ chrome.kill('SIGKILL'); }catch(e){}
  server.close();
  if(!process.argv.includes('--keep')){
    try{fs.unlinkSync(path.join(__dirname,'_driven.html'));}catch(e){}
  }
  try{fs.rmSync(userDir,{recursive:true,force:true});}catch(e){}

  if(raw===null){
    console.error('The driver never posted a result within '+(WALL_TIMEOUT_MS/1000)+'s.');
    const interesting = stderr.split('\n').filter(l=>l && !/dbus|DEPRECATED|Fontconfig|GLES|vulkan|sandbox/i.test(l));
    if(interesting.length) console.error('Chromium stderr:\n'+interesting.slice(0,25).join('\n'));
    process.exit(1);
  }

  const res = JSON.parse(raw);
  let failed=0;
  for(const s of res.steps){
    if(s.ok){ console.log('  ok    '+s.name+(s.info?'   ('+s.info+')':'')); }
    else { failed++; console.log('  FAIL  '+s.name+'   '+(s.info||''));
           if(s.stack)console.log('        '+String(s.stack).split('\n').slice(0,3).join('\n        ')); }
  }
  for(const n of res.notes||[]) console.log('  note  '+n);

  if((res.errors||[]).length){
    console.log('\nUncaught errors / unhandled rejections in the page:');
    for(const e of res.errors){
      failed++;
      console.log('  ['+e.type+'] '+e.message+(e.source?'  @ '+e.source:''));
      if(e.stack)console.log('      '+String(e.stack).split('\n').slice(0,4).join('\n      '));
    }
  } else console.log('\nNo uncaught errors or unhandled rejections.');

  const ce = (res.consoleErrors||[]).filter(m=>!/Failed to load resource|net::ERR/.test(m));
  if(ce.length){
    console.log('\nconsole.error() output (not necessarily fatal):');
    for(const m of ce.slice(0,30)) console.log('  '+m.slice(0,200));
  }

  console.log('\n'+(res.steps.length-res.steps.filter(s=>!s.ok).length)+'/'+res.steps.length+' steps passed');
  process.exit(failed?1:0);
})();
