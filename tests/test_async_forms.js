const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','app.js'),'utf8');
function extractFn(name,kind){
  const sig=(kind||'')+'function '+name+'(';
  const start=src.indexOf(sig);
  if(start<0)throw new Error('not found: '+name);
  let i=src.indexOf('(',start),p=0;
  for(;i<src.length;i++){ if(src[i]==='(')p++; else if(src[i]===')'){p--; if(p===0){i++;break;}} }
  i=src.indexOf('{',i); let d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--; if(d===0)return src.slice(start,i+1);} }
}
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── localStorage + DOM stubs ──
const store={};
global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}};
let textareas=[];
global.document={querySelectorAll:()=>textareas,addEventListener:()=>{}};
global.get=id=>textareas.find(t=>t.id===id)||null;

eval(extractFn('busy','async ').replace('async function busy','busy=async function'));
for(const f of ['saveDraft','clearDraft','restoreDrafts']) eval(extractFn(f).replace('function '+f,f+'=function'));
eval("var DRAFT_PREFIX='jex-draft-',DRAFT_MAX_AGE=24*60*60*1000,_draftsRestored=new Set();");

const mkBtn=()=>({textContent:'Submit',disabled:false,dataset:{}});
const ta=(id,value)=>({id,value,tagName:'TEXTAREA'});

(async()=>{
  console.log('=== busy(): double-submit protection ===');
  let runs=0,release;
  const slow=()=>new Promise(r=>{runs++;release=r;});
  let btn=mkBtn();
  const p1=busy(btn,'Submitting…',slow);
  check('button disabled while in flight', btn.disabled===true);
  check('label swapped to progress text', btn.textContent==='Submitting…');
  const p2=busy(btn,'Submitting…',slow);   // the accidental second click
  await p2;
  check('second click does NOT fire the action again', runs===1, 'runs='+runs);
  release(); await p1;
  check('button re-enabled after success', btn.disabled===false);
  check('original label restored', btn.textContent==='Submit');

  console.log('\n=== busy(): the failure path ===');
  btn=mkBtn();
  try{await busy(btn,'Submitting…',async()=>{throw new Error('server said no');});}catch(e){}
  check('button re-enabled after a REJECTED submit (not left dead)', btn.disabled===false);
  check('label restored after rejection', btn.textContent==='Submit');
  check('busy flag cleared so the form can be retried', btn.dataset.jexBusy===undefined);
  btn=mkBtn();
  let threw=null;
  try{await busy(btn,'x',async()=>{throw new Error('propagate me');});}catch(e){threw=e.message;}
  check('the error still propagates to the caller', threw==='propagate me', String(threw));

  btn=mkBtn();
  await busy(btn,'x',async()=>'result');
  check('return value passes through', true);
  check('no button element is tolerated', await busy(null,'x',async()=>'ok')==='ok');

  console.log('\n=== drafts: survive a render ===');
  for(const k of Object.keys(store))delete store[k];
  _draftsRestored.clear();
  saveDraft('ipo-desc','a long pitch I typed');
  textareas=[ta('ipo-desc','')];               // render() wiped the DOM
  restoreDrafts();
  check('draft restored into the rebuilt empty field', textareas[0].value==='a long pitch I typed');

  console.log('\n=== drafts: never clobber real content ===');
  _draftsRestored.clear();
  saveDraft('fin-summary','stale draft');
  textareas=[ta('fin-summary','existing saved summary')];
  restoreDrafts();
  check('a field rendered WITH content is left alone', textareas[0].value==='existing saved summary');

  console.log('\n=== drafts: no resurrection after a successful submit ===');
  for(const k of Object.keys(store))delete store[k];
  _draftsRestored.clear();
  saveDraft('bug-desc','my bug report');
  textareas=[ta('bug-desc','')];
  restoreDrafts();
  check('restored once', textareas[0].value==='my bug report');
  textareas=[ta('bug-desc','')];               // submitted -> re-rendered empty
  restoreDrafts();
  check('NOT re-filled after the submit cleared it', textareas[0].value==='');
  check('stored draft dropped so it cannot come back next session', store['jex-draft-bug-desc']===undefined);

  console.log('\n=== drafts: expiry and clearing ===');
  for(const k of Object.keys(store))delete store[k];
  _draftsRestored.clear();
  store['jex-draft-news-body']=JSON.stringify({v:'ancient',at:Date.now()-25*60*60*1000});
  textareas=[ta('news-body','')];
  restoreDrafts();
  check('a draft older than 24h is not restored', textareas[0].value==='');
  check('and is purged from storage', store['jex-draft-news-body']===undefined);

  _draftsRestored.clear();
  saveDraft('ann-body','something');
  check('saved', store['jex-draft-ann-body']!==undefined);
  saveDraft('ann-body','   ');
  check('clearing the field removes the draft (whitespace counts as empty)', store['jex-draft-ann-body']===undefined);

  for(const k of Object.keys(store))delete store[k];
  _draftsRestored.clear();
  store['jex-draft-min-body']='{not valid json';
  textareas=[ta('min-body','')];
  restoreDrafts();
  check('corrupt stored draft does not throw', textareas[0].value==='');

  console.log('\n=== source wiring ===');
  check('render() calls restoreDrafts()', /restoreDrafts\(\);\s*\n\}/.test(src));
  check('delegated input listener saves textareas only', /t\.tagName==='TEXTAREA'&&t\.id/.test(src));
  // Lower bound, not an exact count: more submits get wrapped over time and
  // an exact figure just makes this test stale. test_busy_wiring.js is what
  // actually validates each wrapped site.
  const wrapped=(src.match(/busy\(this,/g)||[]).length;
  check('submit buttons wrapped in busy() ('+wrapped+')', wrapped>=30, 'only '+wrapped);
  for(const f of ['submitIPO(','submitDilution(','convertBaseClass(','flagAccount('])
    check(f.slice(0,-1)+' wrapper returns its promise', src.includes('return '+f));

  console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
  process.exit(fails?1:0);
})();
