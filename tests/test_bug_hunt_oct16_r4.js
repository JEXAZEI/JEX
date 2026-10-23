// Regression checks for the fourth bug hunt.
// Behaviour where the function runs on its own; the source text where it
// needs the whole page.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
function extractFn(name){
  const m=new RegExp('^(?:async )?function '+name+'\\(','m').exec(src);
  if(!m)throw new Error('no function '+name);
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--; if(d===0)return src.slice(m.index,i+1);} }
}
const load=name=>eval('('+extractFn(name)+')');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── the frozen leaderboard is this close's, or it is not shown ──
{
  const lbSnapshotIsCurrent=load('lbSnapshotIsCurrent');
  const T0=Date.parse('2026-10-15T16:00:00Z');
  const snap=[{id:'a',name:'A',nw:11000,taken_at:T0}];
  const trade=(ms)=>({id:ms,created_at:new Date(ms).toISOString()});
  global.DB={session:{status:'closed',session_started_at:T0-3600000},trades:[trade(T0-60000)]};
  check('a snapshot taken at this close, with nothing traded since, is shown',lbSnapshotIsCurrent(snap));
  DB.session.status='paused';
  check('a pause is not a close: live standings',!lbSnapshotIsCurrent(snap));
  DB.session.status='open';
  check('an open market: live standings',!lbSnapshotIsCurrent(snap));
  DB.session.status='closed';
  DB.trades=[trade(T0+86400000),trade(T0-60000)];
  check('a later session traded and closed on its own timer: the old snapshot is not shown',!lbSnapshotIsCurrent(snap));
  DB.trades=[];DB.session.session_started_at=new Date(T0+86400000).toISOString();
  check('a session began after the snapshot (ISO start): not shown',!lbSnapshotIsCurrent(snap));
  DB.session.session_started_at=T0+86400000;
  check('a session began after the snapshot (ms start): not shown',!lbSnapshotIsCurrent(snap));
  DB.session.session_started_at=null;
  check('no session start recorded and nothing traded since: shown',lbSnapshotIsCurrent(snap));
  check('a snapshot from before taken_at existed cannot be placed: live',!lbSnapshotIsCurrent([{id:'a',name:'A',nw:1}]));
  check('an empty snapshot: live',!lbSnapshotIsCurrent([]));
  check('no snapshot: live',!lbSnapshotIsCurrent(null));
}
check('the close stamps its snapshot',/taken_at:takenAt\}\)\)\.sort\(byNwThenName\('nw'\)\)/.test(src));
check('the leaderboard asks lbSnapshotIsCurrent',/const isFrozen=lbSnapshotIsCurrent\(lbSnap\);/.test(src));

// ── officer queues and ballots refresh ──
{
  global.DB={pending:[{id:'p1'}],ipoApps:[],dilApps:[],delistApps:[],classApps:[],ballots:[{id:'b1'}]};
  global.QUEUE_KEYS=['pending','ipoApps','dilApps','delistApps','classApps','ballots'];
  const queueSignature=load('queueSignature');global.queueSignature=queueSignature;
  const applyQueueReads=load('applyQueueReads');
  let before=queueSignature();
  applyQueueReads([[{id:'p1'},{id:'p2'}],[{id:'i1',status:'pending'}],null,null,null,[{id:'b1'},{id:'b2'}]],before);
  check('a registration that arrived since page load appears',DB.pending.length===2);
  check('a new IPO application appears',DB.ipoApps.length===1);
  check('a list nobody asked for is left alone',Array.isArray(DB.dilApps)&&DB.dilApps.length===0);
  check('another student\'s ballot reaches the tally',DB.ballots.length===2);
  before=queueSignature();
  DB.pending=DB.pending.filter(p=>p.id!=='p1');            // approved while the read was out
  DB.ballots.push({id:'b3'});                               // cast while the read was out
  applyQueueReads([[{id:'p1'},{id:'p2'}],null,null,null,null,[{id:'b1'},{id:'b2'}]],before);
  check('a registration approved while the read was out does not come back',!DB.pending.some(p=>p.id==='p1'));
  check('a ballot cast while the read was out is kept',DB.ballots.some(b=>b.id==='b3'));
  applyQueueReads(null,before);
  check('a failed sweep changes nothing',DB.ballots.length===3);
}
check('the sweep starts the reads and applies them before the email merge',
  /const queuesP=queueReads\(cu\(\)\);[\s\S]{0,4000}applyQueueReads\(await queuesP,queuesBefore\);[\s\S]{0,400}rpc_admin_get_all_emails/.test(src));
check('ballots are read for everyone',/read\('jex_vote_ballots','order=created_at\.asc'\)/.test(src));
check('pending registrations are read only by officers',/officer\?read\('jex_pending'/.test(src));

// ── a remembered Cover mode with nothing to cover falls back to Buy ──
{
  const coverFallback=load('coverFallback');
  check('cover with no short shows Buy, not an empty panel',coverFallback('cover',undefined)==='buy');
  check('cover with a fully covered position shows Buy',coverFallback('cover',{qty:0,avgPrice:5})==='buy');
  check('cover with an open short stays on Cover',coverFallback('cover',{qty:3})==='cover');
  check('other modes are untouched',coverFallback('sell',undefined)==='sell'&&coverFallback('short',undefined)==='short');
  check('both trade panels use it',(src.match(/const effMode=coverFallback\(mode,short\);/g)||[]).length===2);
}

// ── smaller ones ──
check('a dividend sent for approval carries the note the owner typed',/p_note:note\.trim\(\)\}\);\}\s*catch\(e\)\{return toast\(rpcErrorMessage\(e\)\);\}\s*DB\.divApprovals\.push/.test(src));
check('Balances and its CSV leave hidden test accounts out, like the leaderboard',
  /renderAdminBalances\(students\.filter\(s=>!isHiddenTestEntity\(s\.id\)\)\)/.test(src));
check('the Sheets balances leave hidden test accounts out',
  /const students=DB\.users\.filter\(u=>u\.role==='student'&&u\.status==='approved'&&!isHiddenTestEntity\(u\.id\)\);\n  \/\/ email dropped/.test(src));

(async()=>{
  // ── the circuit breaker leaves the index alone ──
  {
    const checkCircuitBreakers=load('checkCircuitBreakers');
    const halts=[];
    global.isOpen=()=>true;global.isHalted=()=>false;global.toast=()=>{};
    global.sb={get:async()=>[]};
    global.haltStock=async t=>{halts.push(t);return true;};
    global.DB={session:{circuit_breaker_pct:20,session_open_prices:{JXI:1000,AZEI:10},circuit_cooldowns:{}},
      companies:[{ticker:'JXI',is_index_fund:true,price:1500},{ticker:'AZEI',price:10.5}],halts:[]};
    await checkCircuitBreakers();
    check('an index is not halted on a derived price against a cached open',!halts.includes('JXI'),halts.join(','));
    DB.companies[1].price=13;
    await checkCircuitBreakers();
    check('a stock that moved 30% still trips',halts.includes('AZEI'),halts.join(','));
  }

  // ── the watchlist says what happened, after it happened ──
  {
    const toggleWatch=load('toggleWatch');
    const toasts=[];
    global.toast=m=>toasts.push(m);global.render=()=>{};
    global.rpcErrorMessage=e=>e.message;
    const me={id:'u',watchlist:[]};
    global.cu=()=>me;global.watchlist=u=>u.watchlist||[];
    global.sb={rpc:async()=>{throw new Error('offline');}};
    await toggleWatch('AZEI');
    check('a failed watchlist change says so, not "added"',toasts.length===1&&/Could not/.test(toasts[0])&&!/added/.test(toasts[0]),toasts.join('|'));
    global.sb={rpc:async()=>({watchlist:['AZEI']})};
    toasts.length=0;
    await toggleWatch('AZEI');
    check('a successful one says added, after the server agreed',toasts[0]==='AZEI added to watchlist'&&me.watchlist[0]==='AZEI',toasts.join('|'));
  }

  // ── answering an invite from a company that has not listed yet ──
  {
    const respondToInvite=load('respondToInvite');
    const toasts=[];
    global.DB={companyMembers:[{id:'m1',student_id:'s',company_user_id:'c',status:'pending'}],companies:[]};
    global.cu=()=>({id:'s'});global.confirm=()=>true;global.afterServerEvent=()=>{};global.render=()=>{};
    global.getUser=id=>id==='c'?{id:'c',name:'Acme Co'}:null;
    global._teamContactsLoaded=new Set();
    global.sb={rpc:async()=>({})};global.toast=m=>toasts.push(m);
    await respondToInvite('m1',true);
    check('accepting an invite from an unlisted company says so',toasts[0]==='You joined Acme Co as a founder!',toasts.join('|'));
  }

  // ── the session recap names only what the class can see ──
  {
    const generateSessionRecap=load('generateSessionRecap');
    let posted=null;
    global.DB={session:{dev_mode:false},minutes:[],
      users:[{id:'t',role:'student',status:'approved',name:'Tester',is_test_account:true},
             {id:'a',role:'student',status:'approved',name:'Ann'},
             {id:'tc',role:'company',status:'approved',name:'TestCo',is_test_account:true}],
      companies:[{ticker:'TST',name:'Test',status:'listed',owner_id:'tc'},{ticker:'AZEI',name:'Azei',status:'listed',owner_id:'x'}],
      trades:[{ticker:'TST',qty:1000,price:50,ts:'T'},{ticker:'AZEI',qty:2,price:10,ts:'T'}]};
    global.getUser=id=>DB.users.find(u=>u.id===id);
    global.isHiddenTestEntity=userId=>!DB.session.dev_mode&&!!getUser(userId)?.is_test_account;
    global.byNwThenName=key=>(a,b)=>(b[key]-a[key])||String(a.name).localeCompare(String(b.name));
    global.nwMark=s=>s.id==='t'?99999:10500;
    global.priceChg=c=>c.ticker==='TST'?40:2;
    global.isTodayTs=()=>true;global.azDateLabel=()=>'Oct 16';
    global.fmt=n=>'$'+Number(n).toFixed(2);
    global.sb={rpc:async(fn,p)=>{posted=p;return {id:'m'};}};
    await generateSessionRecap({});
    const body=posted&&posted.p_body||'';
    check('the recap leader is a real student, not a hidden test account',/leader: Ann/.test(body)&&!/Tester/.test(body),body);
    check('the biggest mover and biggest trade are not a hidden test company',!/TST/.test(body)&&/AZEI/.test(body),body);
  }

  // ── a failed snapshot is not reported as saved ──
  {
    const saveSnapshot=load('saveSnapshot');
    const toasts=[];global.toast=m=>toasts.push(m);global.render=()=>{};
    global.isAdmin=()=>true;global.cu=()=>({id:'c'});
    global.doSaveSnapshot=async()=>{toasts.push('permission denied');return null;};
    await saveSnapshot('Before Friday');
    check('a failed snapshot leaves its error on screen, not "Snapshot saved"',toasts.join('|')==='permission denied',toasts.join('|'));
    global.doSaveSnapshot=async()=>'s1';toasts.length=0;
    await saveSnapshot('Before Friday');
    check('a saved snapshot still says so',toasts[0]==='✓ Snapshot saved: Before Friday',toasts.join('|'));
  }

  // ── a news notification failure is the message that stays ──
  {
    const postNews=load('postNews');
    const toasts=[];global.toast=m=>toasts.push(m);global.render=()=>{};global.clearDraft=()=>{};
    global.UI={};global.DB={news:[]};
    global.getCo=()=>({ticker:'AZEI'});global.canManageCompany=()=>true;
    global.upsertById=(l,r)=>l.unshift(r);global.rpcErrorMessage=e=>e.message;
    global.document={getElementById:id=>id==='news-notify'?{checked:true}:null};
    global.sb={rpc:async fn=>{if(fn==='rpc_post_news')return {id:'n1'};throw new Error('rate limited');}};
    await postNews('AZEI','Big headline','body');
    check('the last word is that holders were not notified',/could not be notified — rate limited/.test(toasts[toasts.length-1]),toasts.join('|'));
  }

  // ── each toast gets its full time on screen ──
  {
    const fnSrc=extractFn('toast');
    check('a new toast cancels the previous one\'s hide timer',/clearTimeout\(_toastTimer\);_toastTimer=setTimeout/.test(fnSrc));
  }

  console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
  process.exit(fails?1:0);
})();
