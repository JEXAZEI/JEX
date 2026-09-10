// Leaving the exchange is a process, and the client half of it.
//
// Delisting used to be one admin button: flip status to 'delisted', cancel
// open orders, done. Shareholders kept shares that still counted at full price
// on the graded leaderboard, and got nothing. The rules page described a
// buyback window that did not exist and said the shares became worthless,
// which was not true either.
//
// Now a company applies, states whether it is going private or bankrupt, and
// gives a reason that is published. The President or Chairman sets what
// shareholders are paid. rpc_review_delisting does the settlement under a lock
// and is proven against a copy of the database; what this file guards is
// everything the server cannot:
//
//   * The client must never compute the settlement itself. It applies what the
//     server reported and nothing else -- a locally-invented payout would
//     disagree with the balances the server actually wrote.
//
//   * '' and 0 are different answers for the settlement price. Blank means the
//     President has not filled it in; 0 means the shareholders are wiped out,
//     which is a legitimate bankruptcy outcome. Treating blank as 0 would pay
//     everyone nothing on a mis-click.
//
//   * A going-private settlement of 0 is a contradiction and must be refused
//     client-side too, not just by the server.
//
//   * The reason is the point of the feature. It has to be published to
//     shareholders when filed, and escaped wherever it is displayed -- it is
//     student-authored text on a page everyone reads.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

function grabFn(name){
  const m=new RegExp('^(?:async )?function '+name+'\\(','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(m.index,i+1);} }
  throw new Error('unterminated: '+name);
}

// ── wiring ──
check('delistApps has a slot in DB', /delistApps:\[\]/.test(src));
check('...is fetched at boot', /jex_delist_applications/.test(src));
check('...and is cleared by the dev-mode reset',
      /DB\.delistApps=\[\]/.test(src), 'a reset would leave stale applications behind');
check('the company page has a Delisting tab', /UI\.companyTab==='delisting'/.test(src));
check('the admin page has a Delisting tab', /\['delisting','Delisting'\]/.test(src));
check('shareholders see a badge while an application is pending',
      /pendingDelisting\(parentTicker\)/.test(src),
      'a company could apply to leave with nothing shown on its page');

// ── the rules must describe what the code does ──
const rules=src.slice(src.indexOf('3.5 Delisting'), src.indexOf('3.5 Delisting')+2600);
check('rules no longer promise a buyback window that does not exist',
      !/buyback window will open/.test(rules), 'the old claim is still there');
check('...and no longer claim delisted shares are simply worthless',
      !/become worthless after delisting is finalised/.test(rules));
check('...they describe going private', /going private/i.test(rules));
check('...and bankruptcy', /bankrupt/i.test(rules));
check('...and say the reason is published', /published|notified/i.test(rules));
check('...and say shorts are closed on settlement', /short position/i.test(rules));

// ── the reason is student-authored text shown to everyone ──
for(const fn of ['renderDelistTab','renderAdminDelisting','delistOutcomeHTML']){
  const body=grabFn(fn);
  const showsReason=/a\.reason|app\.reason/.test(body);
  if(showsReason)check(fn+' escapes the reason it displays',
    /esc\((?:a|app)\.reason\)/.test(body), 'unescaped student text on a public page');
  if(/settlement_note/.test(body))check(fn+' escapes the settlement note',
    /esc\(a\.settlement_note\)/.test(body), 'unescaped officer text');
}

// ── the client must not invent the settlement ──
const review=grabFn('reviewDelisting');
check('review applies the server figures',
      /r\.settlement_price/.test(review) && /r\.total_paid/.test(review), review.slice(0,0)||'');
check('...and does not compute a payout itself',
      !/payout_ratio\s*\*/.test(review) && !/shares\s*\*\s*price/.test(review),
      'the client is doing settlement arithmetic');
check('...it notifies the holders the server says it paid',
      /r\.payouts/.test(review) && /pushNotification\(/.test(review));

// ── behaviour ──
let toasts=[],rpcCalls=[],confirmed=true;
global.toast=t=>{toasts.push(String(t));};
global.fmt=n=>'$'+Number(n).toFixed(2);
global.render=()=>{};
global.esc=s2=>String(s2);
global.confirm=()=>confirmed;
global.get=id=>({'delist-settle-A':{value:global._priceVal},
                 'delist-note-A':{value:'note'}})[id]||null;
global.getCo=()=>({ticker:'AZEI',name:'Azalea',price:27.21,shares:2000,owner_id:'u_az',status:'listed'});
global.getUser=id=>({id,name:'x',cash:0,holdings:{}});
global.pushNotification=async()=>{};
global.pushNotificationToHolders=async()=>{};
global.logActivity=async()=>{};
global.rpcErrorMessage=e=>String(e&&e.message||e);
global.delistExposure=()=>({shares:769,holders:3,shorts:1});
global.DELIST_KIND_LABEL={going_private:'Going private',bankruptcy:'Bankruptcy'};
global.sb={rpc:async(fn,args)=>{rpcCalls.push({fn,args});return{approved:true,settlement_price:args.p_settlement_price,
  shareholders_paid:0,shares_settled:0,total_paid:0,shortfall:0,payout_ratio:1,shorts_closed:0,
  payouts:[],owner_id:'u_az',owner_cash:0,cancelled_orders:[],cancelled_stop_loss:[]};}};
eval(grabFn('reviewDelisting'));

const APP=(kind)=>[{id:'A',ticker:'AZEI',kind:kind,status:'pending',proposed_price:30,reason:'r'}];

(async()=>{
  // blank price is not zero
  global.DB={delistApps:APP('bankruptcy'),limitOrders:[],stopLossOrders:[]};
  toasts=[];rpcCalls=[];global._priceVal='';
  await reviewDelisting('A',true);
  check('a blank settlement price is refused, not read as zero',
        rpcCalls.length===0 && /enter 0 if/i.test(toasts.join()), JSON.stringify(toasts));

  // zero IS a valid bankruptcy answer
  global.DB={delistApps:APP('bankruptcy'),limitOrders:[],stopLossOrders:[]};
  toasts=[];rpcCalls=[];global._priceVal='0';
  await reviewDelisting('A',true);
  check('zero is accepted for a bankruptcy — being wiped out is an outcome',
        rpcCalls.length===1 && rpcCalls[0].args.p_settlement_price===0,
        JSON.stringify(toasts)+JSON.stringify(rpcCalls.map(c=>c.args)));

  // zero is NOT valid for going private
  global.DB={delistApps:APP('going_private'),limitOrders:[],stopLossOrders:[]};
  toasts=[];rpcCalls=[];global._priceVal='0';
  await reviewDelisting('A',true);
  check('zero is refused for a going-private — that is bankruptcy',
        rpcCalls.length===0 && /bankruptcy/i.test(toasts.join()), JSON.stringify(toasts));

  // negative is never valid
  global.DB={delistApps:APP('bankruptcy'),limitOrders:[],stopLossOrders:[]};
  toasts=[];rpcCalls=[];global._priceVal='-5';
  await reviewDelisting('A',true);
  check('a negative settlement price is refused',
        rpcCalls.length===0 && /negative/i.test(toasts.join()), JSON.stringify(toasts));

  // the settlement is irreversible, so it must be confirmed
  global.DB={delistApps:APP('bankruptcy'),limitOrders:[],stopLossOrders:[]};
  toasts=[];rpcCalls=[];global._priceVal='5';confirmed=false;
  await reviewDelisting('A',true);
  check('declining the confirmation settles nothing', rpcCalls.length===0, JSON.stringify(rpcCalls));
  confirmed=true;

  // rejecting needs no price and must not settle
  global.DB={delistApps:APP('going_private'),limitOrders:[],stopLossOrders:[]};
  toasts=[];rpcCalls=[];global._priceVal='';
  global.sb={rpc:async(fn,args)=>{rpcCalls.push({fn,args});return{approved:false};}};
  await reviewDelisting('A',false);
  check('rejecting works without a settlement price', rpcCalls.length===1, JSON.stringify(toasts));
  check('...and sends no price', rpcCalls[0].args.p_settlement_price===null, JSON.stringify(rpcCalls[0].args));
  check('...and says the company stays listed', /stays listed/i.test(toasts.join()), JSON.stringify(toasts));

  console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
  process.exit(fails?1:0);
})();
