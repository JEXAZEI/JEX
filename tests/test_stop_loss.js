// Whose screen a stop-loss shows up on.
//
// There is no server-side cron in JEX, so the browsers are the scheduler:
// every logged-in client polls, notices ANY due stop-loss, and calls
// rpc_trigger_stop_loss, which re-verifies the trigger and makes the atomic
// active->triggered claim. That design is fine -- the server is still the
// boundary.
//
// What was not fine is where the result was announced. The toast fired on
// whichever student's browser happened to notice first, naming the student who
// had just been sold out and the price it happened at:
//
//     Stop-loss triggered for Jane Smith: sold 20×ACME @ $9.80
//
// That is another student's position and their trigger level, broadcast to a
// classmate for doing nothing but leaving a tab open. In a trading game a
// trigger price is worth knowing: it tells you exactly where someone will be
// forced to sell.
//
// The owner still gets the notification, which is the durable private channel.
// Admins keep the live toast, because watching the market react is part of
// running a session.
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

const JANE={id:'u-jane',name:'Jane Smith',role:'student',cash:1000,holdings:{ACME:20}};
const BOB ={id:'u-bob', name:'Bob Jones',role:'student',cash:1000,holdings:{}};
const CHAIR={id:'u-adm',name:'Chairperson',role:'chairman',cash:0,holdings:{}};

let toasts=[],notified=[],viewer=BOB;
global.toast=m=>{toasts.push(String(m));};
global.fmt=n=>'$'+Number(n).toFixed(2);
global.isOpen=()=>true;
global.getUser=id=>[JANE,BOB,CHAIR].find(u=>u.id===id)||null;
global.cu=()=>viewer;
global.getCo=t=>DB.companies.find(c=>c.ticker===t)||null;
global.pushNotification=async(uid,kind,msg)=>{notified.push({uid,kind,msg});};
global.logActivity=async()=>{};
global.pushTradeToSheets=()=>{};
// A due stop-loss that the server accepts.
global.sb={rpc:async()=>({triggered:true,user_id:'u-jane',sell_qty:20,price:9.8,
  cash:1196,holdings:{},shares_avail:420,price_history:[],trade:{id:'t1'}})};

// isAdmin is a top-level const arrow; a const declared inside eval never
// reaches global, so bind it explicitly.
global.isAdmin=eval('('+grabConst('isAdmin').replace(/^const isAdmin=/,'').replace(/;$/,'')+')');
eval(grabFn('checkStopLossOrders'));

const reset=()=>{
  toasts=[];notified=[];
  global.DB={companies:[{ticker:'ACME',price:9.80,shares_avail:400,price_history:[]}],
    trades:[],
    stopLossOrders:[{id:'sl1',user_id:'u-jane',ticker:'ACME',trigger_price:10,status:'active'}]};
};

(async()=>{

  // ── a classmate must not be told ──
  viewer=BOB; reset();
  await checkStopLossOrders();
  check('a classmate is shown nothing', toasts.length===0, JSON.stringify(toasts));
  check('...and specifically not the owner by name',
        !toasts.some(t=>/Jane/.test(t)), JSON.stringify(toasts));
  check('...nor the price it happened at',
        !toasts.some(t=>/9\.80/.test(t)), JSON.stringify(toasts));
  check('the sale still went through on the classmate’s poll',
        DB.stopLossOrders[0].status==='triggered');
  check('...and the owner still gets the notification',
        notified.length===1 && notified[0].uid==='u-jane', JSON.stringify(notified));

  // ── the owner is told ──
  viewer=JANE; reset();
  await checkStopLossOrders();
  check('the owner is told', toasts.length===1, JSON.stringify(toasts));
  check('...without their own name read back at them',
        toasts.length===1 && !/Jane/.test(toasts[0]), JSON.stringify(toasts));
  check('...and with the quantity and price', toasts.length===1
        && /20/.test(toasts[0]) && /9\.80/.test(toasts[0]), JSON.stringify(toasts));

  // ── an admin is told, and told whose it was ──
  viewer=CHAIR; reset();
  await checkStopLossOrders();
  check('an admin is told', toasts.length===1, JSON.stringify(toasts));
  check('...including whose it was', toasts.length===1 && /Jane/.test(toasts[0]),
        JSON.stringify(toasts));

  // ── the engine itself still behaves ──
  viewer=BOB; reset();
  DB.companies[0].price=11;                       // above the trigger
  await checkStopLossOrders();
  check('an order whose price has not crossed is left alone',
        DB.stopLossOrders[0].status==='active' && notified.length===0);

  viewer=BOB; reset();
  global.sb={rpc:async()=>({triggered:false,reason:'no_shares_held'})};
  await checkStopLossOrders();
  check('the server refusing for no shares cancels it locally',
        DB.stopLossOrders[0].status==='cancelled');
  check('...and announces nothing', toasts.length===0, JSON.stringify(toasts));

  viewer=BOB; reset();
  global.sb={rpc:async()=>({triggered:false,reason:'not_active'})};
  await checkStopLossOrders();
  check('another client having claimed it first marks it triggered, not cancelled',
        DB.stopLossOrders[0].status==='triggered');

  viewer=BOB; reset();
  global.sb={rpc:async()=>{throw new Error('network');}};
  await checkStopLossOrders();
  check('a thrown RPC leaves the order alone rather than losing it',
        DB.stopLossOrders[0].status==='active');

  viewer=JANE; reset();
  global.isOpen=()=>false;
  await checkStopLossOrders();
  check('nothing triggers while the session is closed',
        DB.stopLossOrders[0].status==='active' && toasts.length===0);
  global.isOpen=()=>true;

  console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll stop-loss checks passed.'));
  process.exit(fails?1:0);
})();
