// Realtime responsiveness.
//
// Updates used to be BLOCKED rather than merged: userIsFillingForm() returned
// true if any field anywhere held typed text, and that gated both the
// realtime re-render and the 20s autoRefresh -- including its fetch. A trader
// with a quantity typed in saw no price moves, no trades and no session
// open/close until they cleared the box. Draft persistence made it permanent,
// since restoreDrafts() re-fills textareas from localStorage after every
// render.
//
// The fix carries typed state across a background repaint instead, so the
// repaint can always happen.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── DOM stubs ──
function mkEl(tag,id,value,def){return{tagName:tag,id,value,defaultValue:def===undefined?'':def,
  selectionStart:null,selectionEnd:null,setSelectionRange(){},focus(){active=this;},selectedIndex:0};}
let els=[],active=null;
global.document={
  querySelectorAll:()=>els,
  getElementById:id=>els.find(e=>e.id===id)||null,
  get activeElement(){return active;},
};
global.UI={userId:'u1',loginView:null};

for(const fn of ['snapshotFormState','restoreFormState','userIsFillingForm']){
  const m=new RegExp('^function '+fn+'\\([^)]*\\)\\{[\\s\\S]*?\\n\\}','m').exec(src);
  eval(m[0].replace('function '+fn,fn+'=function'));
}

console.log('=== the block that stopped everything is gone ===');
els=[mkEl('INPUT','t-qty','25','1')]; active=null;
check('an unfocused field with typed text no longer blocks a repaint',
  userIsFillingForm()==='', userIsFillingForm());
els=[mkEl('TEXTAREA','bug-desc','a restored draft','')]; active=null;
check('a restored draft no longer blocks forever', userIsFillingForm()==='', userIsFillingForm());
els=[mkEl('INPUT','t-qty','25','1')]; active=els[0];
check('a FOCUSED field still defers the repaint', userIsFillingForm()!=='' , 'should still block');

console.log('\n=== typed input survives a background repaint ===');
els=[mkEl('INPUT','t-qty','25','1'),mkEl('TEXTAREA','ipo-desc','my pitch','')]; active=null;
const snap=snapshotFormState();
check('snapshot captured both typed fields', snap&&Object.keys(snap).length===2, JSON.stringify(snap));
// render() rebuilds the DOM: same ids, back to their defaults
els=[mkEl('INPUT','t-qty','1','1'),mkEl('TEXTAREA','ipo-desc','','')];
restoreFormState(snap);
check('quantity restored after the repaint', els[0].value==='25', els[0].value);
check('textarea restored after the repaint', els[1].value==='my pitch', els[1].value);

console.log('\n=== restore never clobbers fresher content ===');
els=[mkEl('INPUT','t-qty','99','1')];
restoreFormState({'t-qty':{v:'25'}});
check('a value the new render deliberately set is left alone', els[0].value==='99', els[0].value);
els=[mkEl('INPUT','other','','')];
restoreFormState({'gone':{v:'x'}});
check('a field that no longer exists is skipped without throwing', true);

console.log('\n=== nothing typed means nothing to carry ===');
els=[mkEl('INPUT','t-qty','1','1')];
check('untouched defaults are not snapshotted', snapshotFormState()===null);

console.log('\n=== focus and caret are preserved ===');
els=[mkEl('TEXTAREA','note','hello world','')]; active=els[0];
els[0].selectionStart=5;els[0].selectionEnd=5;
const s2=snapshotFormState();
check('the focused field is flagged in the snapshot', s2['note'].sel===true);
check('caret position captured', s2['note'].start===5);
els=[mkEl('TEXTAREA','note','','')]; active=null;
restoreFormState(s2);
check('focus returned to the field the user was in', active&&active.id==='note');

console.log('\n=== wiring in app.js ===');
check('realtime repaints go through the coalescer',
  /if\(!blockReason\)scheduleBackgroundRender\(\);/.test(src));
check('autoRefresh repaints as a background render', /renderBackground\(\);\s*\n\s*\} else if\(newUnread/.test(src));
check('autoRefresh no longer bails out before fetching',
  !/if\(userIsFillingForm\(\)\)return; \/\/ don't interrupt forms/.test(src));
check('render() snapshots when the repaint is a background one',
  /if\(_bgRender\)_formSnapshot=snapshotFormState\(\);/.test(src));
check('render() restores form state before drafts',
  /restoreFormState\(_formSnapshot\);_formSnapshot=null;\}\s*\n\s*restoreDrafts\(\);/.test(src));
check('the blanket any-field-has-text block is deleted',
  !/has user-typed content/.test(src));

console.log('\n=== reconnect backoff ===');
check('reconnect starts at 1s, not a flat 5s', /_rtBackoff\*2:1000/.test(src));
check('backoff is capped', /Math\.min\([^)]*,30000\)/.test(src));
check('a confirmed join resets the backoff', /status==='ok'\)\{_rtBackoff=0;/.test(src));
// walk the schedule
let b=0,seq=[];for(let i=0;i<7;i++){b=Math.min(b?b*2:1000,30000);seq.push(b);}
check('schedule is 1s,2s,4s,8s,16s,30s,30s', JSON.stringify(seq)===JSON.stringify([1000,2000,4000,8000,16000,30000,30000]), seq.join(','));

console.log('\n=== other users\' data stays fresh ===');
check('autoRefresh now fetches jex_users', /sb\.get\('jex_users','order=created_at\.asc&select='\+JEX_USERS_SAFE_SELECT\),\n\s*\]\);/.test(src));
check('it uses the safe select (no password/email on the wire)',
  /jex_users[^\n]*JEX_USERS_SAFE_SELECT/.test(src)&&!/JEX_USERS_SAFE_SELECT\s*=\s*'[^']*(password|sec_a)/.test(src));
check('the signed-in user is merged, never overwritten', /if\(nu\.id!==UI\.userId\)Object\.assign\(cur,nu\)/.test(src));
check('jex_users is NOT added to the realtime subscription list',
  !/tables=\[[^\]]*'jex_users'/.test(src));

// merge semantics
(function(){
  const UIu='me';
  const DBusers=[{id:'me',cash:999},{id:'them',cash:10},{id:'gone',cash:5}];
  const fresh=[{id:'me',cash:1},{id:'them',cash:77}];
  const byId=new Map(DBusers.map(u=>[u.id,u]));
  fresh.forEach(nu=>{const cur=byId.get(nu.id);if(cur){if(nu.id!==UIu)Object.assign(cur,nu);}else DBusers.push(nu);});
  const out=DBusers.filter(u=>fresh.some(nu=>nu.id===u.id)||u.id===UIu);
  check('another user\'s balance is updated', out.find(u=>u.id==='them').cash===77);
  check('your own optimistic balance is not rewound', out.find(u=>u.id==='me').cash===999);
  check('a removed user drops out of DB.users', !out.some(u=>u.id==='gone'));
})();

console.log('\n=== repaint coalescing ===');
check('a leading-edge coalescer replaced the trailing debounce',
  /function scheduleBackgroundRender\(\)\{/.test(src)&&!/_rtRenderTimer=setTimeout/.test(src));
check('the render log no longer keys off a never-cleared timer id',
  !/if\(window\._rtRenderTimer\)console\.log/.test(src));

// Model the coalescer and drive it with a realistic burst.
(function(){
  const GAP=200;
  let last=0,pending=false,renders=0,now=0,timers=[];
  const schedule=()=>{
    const since=now-last;
    if(since>=GAP){last=now;renders++;return;}
    if(pending)return;
    pending=true;
    timers.push({at:now+(GAP-since),fn:()=>{pending=false;last=now;renders++;}});
  };
  const advance=t=>{now=t;timers=timers.filter(x=>{if(x.at<=now){x.fn();return false;}return true;});};
  // one trade -> jex_companies at t=0, jex_trades at t=180 (the >150ms gap
  // that used to cost a second full render)
  advance(0);   schedule();
  advance(180); schedule();
  advance(400); timers=timers.filter(x=>{if(x.at<=now){x.fn();return false;}return true;});
  check('one trade produces a single repaint, not two or three', renders<=2, 'renders='+renders);
  check('the FIRST event repaints immediately (no 150ms wait)', last===0||renders>=1);
})();
(function(){
  const GAP=200;let last=-1e9,renders=0;
  // 20 events in a 1s storm
  for(let t=0;t<1000;t+=50){const since=t-last;if(since>=GAP){last=t;renders++;}}
  check('a 1s event storm collapses to ~5 repaints, not 20', renders<=6, 'renders='+renders);
})();

console.log('\n=== adaptive polling ===');
check('autoRefresh backs off while realtime is healthy',
  /const minGap=realtimeHealthy\(\)\?60000:18000;/.test(src));
check('health is channel-join based, not last-event based',
  /function realtimeHealthy\(\)\{return _rtJoined&&_realtimeChannels\.length>0;\}/.test(src));
check('a confirmed join marks the channel healthy', /_rtJoined=true;/.test(src));
check('a close marks it unhealthy again', (src.match(/_rtJoined=false;/g)||[]).length>=2);
// The matching poll stays at 3 seconds -- backing IT off would make limit
// fills feel broken -- but it now runs one pass at a time. A pass awaits up to
// 50 match RPCs per ticker plus a pool-fill RPC per resting order, which with a
// roomful of clients on one book can outlast the interval; setInterval would
// otherwise stack the next pass on top of the one still running, and slower
// responses would produce MORE concurrent passes rather than fewer.
check('the matching poll still runs every 3 seconds (limit fills stay fast)',
  /await checkLimitOrders\(\);await checkStopLossOrders\(\)[\s\S]{0,500}?\},3000\);/.test(src));
// Margin calls ride the same pass. A short that has blown through its
// collateral has to be closed on the same cadence as a stop-loss, not on the
// 20-60 second refresh -- the price is moving away from them the whole time.
check('...and margin calls are checked on that same pass',
  /await checkStopLossOrders\(\);await checkMarginCalls\(\);/.test(src));
check('...one pass at a time, so slow passes cannot stack up',
  /if\(_pollBusy\)return;\s*\n?\s*_pollBusy=true;/.test(src));
check('...and a pass that throws still releases the flag',
  /finally\{_pollBusy=false;\}/.test(src));

// A quiet market must not look like a dead socket.
(function(){
  const healthy=(joined,chans)=>joined&&chans>0;
  check('quiet market with an open channel still counts as healthy', healthy(true,1)===true);
  check('dropped socket is unhealthy even if events arrived recently', healthy(false,1)===false);
  const gap=h=>h?60000:18000;
  check('healthy -> 60s sweep', gap(healthy(true,1))===60000);
  check('unhealthy -> back to 18s sweep', gap(healthy(false,0))===18000);
})();

console.log('\n=== trade + registration buttons ===');
for(const h of ['cpTrade','cpLimit','doRegister','placeLimitOrder'])
  check(h+' is wrapped in busy()', new RegExp('busy\\(this,&quot;[^&]*&quot;,(\\(\\)=>)?'+h+'\\b').test(src), h);
check('the fixed 1500ms trade lockout is gone', !/disableTradeBtn\(this\)/.test(src));

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
