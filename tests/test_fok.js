// Fill-or-kill has to mean fill-or-kill.
//
// Two silent failures sat on top of each other, and the second only started
// mattering once the first was fixed.
//
//   1. The Sell tab's order-type dropdown was ignored, so a student choosing
//      FOK actually sent GTC. Fixed separately (test_limit_order_type.js);
//      until then this path barely ran.
//
//   2. When a FOK did not fill, settleLimitOrder cancelled it -- and swallowed
//      any failure of that cancel entirely:
//
//          try{ await sb.rpc('rpc_cancel_limit_order',...);
//               mine.status='cancelled'; }catch(e){}
//
//      A failed cancel left the order OPEN and live on the book, with nothing
//      said. The student asked for "all of it right now or none of it" and
//      silently got a standing order, exposed to a fill they believed they had
//      declined.
//
//   3. And a FOK that did not fill produced NO message at all, because the
//      only toast on that branch was `else if(orderType!=='fok')`. Worked,
//      failed and still-pending were indistinguishable.
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

let toasts=[],reported=[],cancelFails=false,cancelCalls=0;
global.toast=m=>{toasts.push(String(m));};
global.fmt=n=>'$'+Number(n).toFixed(2);
global.render=()=>{};
global.isOpen=()=>true;
global.getCo=()=>({ticker:'ACME',price:12,is_index_fund:false});
global.getUser=()=>({id:'u1',name:'Ada'});
global.getFund=()=>null;
global.cu=()=>({id:'u1',name:'Ada'});
global.isAdmin=()=>false;
global.myFillSide=()=>true;
global.applyLimitMatchResult=()=>{};
global.applyLimitPoolFillResult=()=>{};
global.logActivity=async()=>{};
global.pushNotification=async()=>{};
global.reportClientError=(m,s,src2)=>{reported.push({m,src:src2});};
eval(grabFn('settleLimitOrder'));

const ORDER={id:'o1',user_id:'u1',ticker:'ACME',side:'buy',qty:5,limit_price:12,status:'open'};
const reset=()=>{
  toasts=[];reported=[];cancelCalls=0;
  global.DB={limitOrders:[{...ORDER}]};
  global.sb={rpc:async(fn)=>{
    if(fn==='rpc_match_limit_order_book')return{matched:false};
    if(fn==='rpc_fill_limit_vs_pool')return{filled:false,reason:'not_crossed'};
    if(fn==='rpc_cancel_limit_order'){cancelCalls++;if(cancelFails)throw new Error('Failed to fetch');return{cancelled:true};}
    return null;
  }};
};
const status=()=>DB.limitOrders.find(o=>o.id==='o1').status;

(async()=>{

  // ── the cancel works ──
  cancelFails=false; reset();
  const filled=await settleLimitOrder({...ORDER},true);
  check('an unfilled FOK is cancelled', status()==='cancelled', status());
  check('...having actually asked the server', cancelCalls===1, String(cancelCalls));
  check('...and nothing was filled', filled===0, String(filled));
  check('...with no alarming message', toasts.length===0, JSON.stringify(toasts));

  // ── the cancel fails ──
  cancelFails=true; reset();
  await settleLimitOrder({...ORDER},true);
  check('a failed cancel does NOT claim the order is gone', status()==='open', status());
  check('...and warns that it is still live',
        toasts.some(t=>/still live on the book/i.test(t)), JSON.stringify(toasts));
  check('...tells the student how to deal with it',
        toasts.some(t=>/Orders page/i.test(t)), JSON.stringify(toasts));
  check('...and files it for the instructor',
        reported.length===1 && /FOK cancel failed/.test(reported[0].m),
        JSON.stringify(reported));

  // ── a plain limit order is never cancelled ──
  cancelFails=false; reset();
  await settleLimitOrder({...ORDER},false);
  check('a GTC order is left resting, not cancelled', status()==='open', status());
  check('...and the cancel RPC is never called', cancelCalls===0, String(cancelCalls));
  check('...silently, because resting is what it asked for',
        toasts.length===0, JSON.stringify(toasts));

  // ── an order that filled is not then cancelled ──
  cancelFails=false; reset();
  DB.limitOrders[0].status='filled';
  await settleLimitOrder({...ORDER},true);
  check('a filled FOK is not cancelled afterwards', cancelCalls===0, String(cancelCalls));

  // ── the placement path must not contradict the warning ──
  // placeLimitOrder announces "the order was cancelled" only when the local
  // status really says so. Otherwise settleLimitOrder has already warned that
  // it is live, and saying both would be a contradiction on screen.
  const place=grabFn('placeLimitOrder');
  check('the FOK message is gated on the real status',
        /o\.status===.cancelled./.test(place), 'gate not found in placeLimitOrder');
  check('...and a FOK is no longer excluded from all messaging',
        !/orderType!==.fok.\)toast/.test(place), 'the old else-if is still there');

  console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll fill-or-kill checks passed.'));
  process.exit(fails?1:0);
})();
