// Who gets told about a fill.
//
// There is no server-side cron, so every logged-in client runs the matching
// loop every 3 seconds. Whichever browser noticed a crossing pair announced
// it -- to its own user, whoever that happened to be:
//
//     5×ACME matched: Jane Smith bought from Bob Jones @ $11.01
//     Ariel Ramirez-Angulo's limit order filled: 3×ACME @ $11.01
//
// The second of those is a real line from a test run of this suite, before the
// fix. Both name people who have nothing to do with the viewer.
//
// A real tape is public in price and size and anonymous in identity. This was
// the opposite: full names, to the whole room, for leaving a tab open. And in
// a classroom the names are the sensitive half -- knowing WHO is selling tells
// you who is losing.
//
// The trade still shows on the Market and Trades pages. What changed is that
// the interrupting toast is now only for people it concerns: the two sides,
// a fund's manager, and admins running the session.
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
function grabConst(name){
  const m=new RegExp('(?:^|;)const '+name+'=','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  const start=m.index+(m[0].startsWith(';')?1:0);
  let depth=0;
  for(let i=start;i<src.length;i++){
    const c=src[i];
    if('([{'.includes(c))depth++;
    else if(')]}'.includes(c))depth--;
    else if(c===';'&&depth===0)return src.slice(start,i+1);
  }
  throw new Error('unterminated: '+name);
}

const JANE ={id:'u-jane',name:'Jane Smith',role:'student'};
const BOB  ={id:'u-bob', name:'Bob Jones', role:'student'};
const NOSY ={id:'u-nosy',name:'Nosy Parker',role:'student'};
const CHAIR={id:'u-adm', name:'Chairperson',role:'chairman'};
const FUND ={id:'f1',name:'Growth Fund',manager_id:'u-jane'};

let viewer=NOSY, toasts=[], acts=[], notes=[];
global.toast=m=>{toasts.push(String(m));};
global.fmt=n=>'$'+Number(n).toFixed(2);
global.isOpen=()=>true;
global.cu=()=>viewer;
global.getUser=id=>[JANE,BOB,NOSY,CHAIR].find(u=>u.id===id)||null;
global.getFund=id=>id===FUND.id?FUND:null;
global.getCo=t=>DB.companies.find(c=>c.ticker===t)||null;
global.applyLimitMatchResult=()=>{};
global.applyLimitPoolFillResult=(id)=>{const o=DB.limitOrders.find(x=>x.id===id);if(o)o.status='filled';};
global.logActivity=async(...a)=>{acts.push(a);};
global.pushNotification=async(...a)=>{notes.push(a);};
global.isAdmin=eval('('+grabConst('isAdmin').replace(/^const isAdmin=/,'').replace(/;$/,'')+')');
eval(grabFn('myFillSide'));
eval(grabFn('checkLimitOrders'));

// One book match between Jane and Bob, then nothing further to match.
let served=0;
const bookMatch={matched:true,fill_qty:5,fill_price:11.01,ticker:'ACME',
  buyer_type:'user',buyer_id:'u-jane',seller_type:'user',seller_id:'u-bob',
  bid_order_id:'b1',ask_order_id:'a1'};
const setup=(mode)=>{
  served=0; toasts=[]; acts=[]; notes=[];
  global.DB={companies:[{ticker:'ACME',price:11.01}],limitOrders:[
    {id:'b1',user_id:'u-jane',ticker:'ACME',side:'buy',qty:5,limit_price:11.01,status:'open'}]};
  global.sb={rpc:async(fn)=>{
    if(fn==='rpc_match_limit_order_book') return (mode==='book'&&served++===0)?bookMatch:{matched:false};
    if(fn==='rpc_fill_limit_vs_pool') return mode==='pool'
      ? {filled:true,fill_qty:3,fill_price:11.01,owner_type:'user',owner_id:'u-jane'}
      : {filled:false};
    return null;
  }};
};

(async()=>{

  // ── a book match ──
  for(const [who,label,shown] of [[NOSY,'an uninvolved classmate',false],
                                  [JANE,'the buyer',true],
                                  [BOB,'the seller',true],
                                  [CHAIR,'an admin',true]]){
    viewer=who; setup('book');
    await checkLimitOrders();
    check('book match: '+label+(shown?' is told':' is told nothing'),
          (toasts.length>0)===shown, JSON.stringify(toasts));
    if(!shown) check('...and sees neither name',
          !toasts.some(t=>/Jane|Bob/.test(t)), JSON.stringify(toasts));
  }

  // The activity log is a separate, access-controlled surface -- it must still
  // record every fill regardless of who happened to be polling.
  viewer=NOSY; setup('book');
  await checkLimitOrders();
  check('the fill is still written to the activity log', acts.length===1,
        JSON.stringify(acts));

  // ── a pool fill ──
  for(const [who,label,shown] of [[NOSY,'an uninvolved classmate',false],
                                  [JANE,'the order owner',true],
                                  [CHAIR,'an admin',true]]){
    viewer=who; setup('pool');
    await checkLimitOrders();
    check('pool fill: '+label+(shown?' is told':' is told nothing'),
          (toasts.length>0)===shown, JSON.stringify(toasts));
  }

  viewer=NOSY; setup('pool');
  await checkLimitOrders();
  check('the owner still gets the notification even when a stranger polled',
        notes.length===1 && notes[0][0]==='u-jane', JSON.stringify(notes));

  // ── a fund's manager counts as a participant ──
  check('a fund is mine when I manage it',
        (viewer=JANE, myFillSide('fund','f1'))===true);
  check('...and not when I do not',
        (viewer=BOB, myFillSide('fund','f1'))===false);
  check('a user side matches on id',
        (viewer=BOB, myFillSide('user','u-bob'))===true);
  check('an unknown fund is not mine',
        (viewer=JANE, myFillSide('fund','f-nope'))===false);
  check('a null id is not mine',
        (viewer=JANE, myFillSide('user',null))===false);

  // ── price alerts, the third loop with the same shape ──
  //
  // Holdings and cash ARE public in JEX -- they are in JEX_USERS_SAFE_SELECT,
  // deliberately, because the leaderboard ranks by net worth. A target price
  // is not: it lives on jex_price_alerts and is a private intention. And an
  // alert somebody else set is noise to everyone but them.
  eval(grabFn('checkPriceAlerts'));
  const setupAlert=()=>{
    toasts=[]; notes=[];
    global.DB={companies:[{ticker:'ACME',price:12}],
      priceAlerts:[{id:'a1',user_id:'u-jane',ticker:'ACME',direction:'above',target_price:11,triggered:false}]};
    global.sb={rpc:async()=>({triggered:true,user_id:'u-jane',ticker:'ACME',
      direction:'above',target_price:11,price:12})};
  };
  for(const [who,label,shown] of [[NOSY,'an uninvolved classmate',false],
                                  [JANE,'the person who set it',true],
                                  [CHAIR,'an admin',true]]){
    viewer=who; setupAlert();
    await checkPriceAlerts();
    check('price alert: '+label+(shown?' is told':' is told nothing'),
          (toasts.length>0)===shown, JSON.stringify(toasts));
  }
  viewer=NOSY; setupAlert();
  await checkPriceAlerts();
  check('the alert still fires and notifies its owner from a stranger’s poll',
        DB.priceAlerts[0].triggered===true && notes.length===1 && notes[0][0]==='u-jane',
        JSON.stringify(notes));
  check('...and the target price is not shown to the stranger',
        !toasts.some(t=>/11/.test(t)), JSON.stringify(toasts));

  console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll fill-privacy checks passed.'));
  process.exit(fails?1:0);
})();
