// A sale into a company's unsold pool is paid for BY that company.
//
// It used not to be. A market BUY moved cash from the student to the company
// owner -- zero sum -- but a market SELL credited the seller and debited
// nobody, while the shares went back into the company's unsold pool. The
// company kept the money AND got the shares back, and the difference was
// created out of nothing. Measured against a copy of the live database, ten
// buy/sell cycles of a single share took the money supply from $200.00 to
// $472.10, all of it landing with the company owner. Two students who talk to
// each other -- one owning a company, the other cycling trades -- farm that at
// no cost, on a graded leaderboard.
//
// Four server paths did it, not one: rpc_trade_sell, rpc_fund_sell,
// rpc_trigger_stop_loss, and rpc_fill_limit_vs_pool. The last was the worst,
// because it is farmable on demand: buy at market, rest a sell limit, collect
// cash nobody paid.
//
// The server fix is a migration, and the server is where it is proven. What
// this file guards is the CLIENT half -- the thing a migration cannot enforce:
//
//   * A sell order that cannot fill because the company is short of cash rests
//     on the book. That is correct. Silence is not. The student is watching an
//     order sit there and has no way to know it is the company's balance and
//     not their own price that is stopping it. This is the same reasoning the
//     neighbouring 'limit_would_be_breached' branch already applies.
//
//   * ...but only on the order they just placed. checkLimitOrders() retries
//     every resting order on a timer, so a toast on that path would repeat the
//     same sentence forever. Silence there is the deliberate choice, and this
//     pins it so a later change cannot "helpfully" add one.
//
//   * An unrecognised refusal must never be mistaken for a fill, and must
//     never mark a stop-loss as triggered. A stop that reads 'triggered'
//     having never sold is a student's protection quietly disappearing.
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

let toasts=[];
global.toast=m=>{toasts.push(String(m));};
global.fmt=n=>'$'+Number(n).toFixed(2);
global.render=()=>{};
global.isOpen=()=>true;
global.getCo=()=>({ticker:'AZEI',price:27.21,is_index_fund:false});
global.getUser=()=>({id:'u1',name:'Ada'});
global.getFund=()=>null;
global.cu=()=>({id:'u1',name:'Ada'});
global.isAdmin=()=>false;
global.myFillSide=()=>true;
global.applyLimitMatchResult=()=>{};
global.applyLimitPoolFillResult=()=>{};
global.logActivity=async()=>{};
global.pushNotification=async()=>{};
global.reportClientError=()=>{};
eval(grabFn('settleLimitOrder'));

const ORDER={id:'o1',user_id:'u1',ticker:'AZEI',side:'sell',qty:20,limit_price:27.00,status:'open'};
let poolReply={filled:false,reason:'not_crossed'};
const reset=()=>{
  toasts=[];
  global.DB={limitOrders:[{...ORDER}]};
  global.sb={rpc:async(fn)=>{
    if(fn==='rpc_match_limit_order_book')return{matched:false};
    if(fn==='rpc_fill_limit_vs_pool')return poolReply;
    if(fn==='rpc_cancel_limit_order')return{cancelled:true};
    return null;
  }};
};
const status=()=>DB.limitOrders.find(o=>o.id==='o1').status;

(async()=>{

  // ── the company cannot pay ──
  poolReply={filled:false,reason:'company_cannot_pay',needed:542.60,company_has:10};
  reset();
  const filled=await settleLimitOrder({...ORDER},false);

  check('a refused fill does not count as filled', filled===0, String(filled));
  check('...and the order is left resting, not cancelled', status()==='open', status());
  check('...the student is actually told something', toasts.length===1, JSON.stringify(toasts));
  check('...that names the company, not their price',
        toasts.some(t=>/AZEI does not have the cash/i.test(t)), JSON.stringify(toasts));
  check('...quotes what the sale would cost',
        toasts.some(t=>/\$542\.60/.test(t)), JSON.stringify(toasts));
  check('...and what the company actually holds',
        toasts.some(t=>/\$10\.00/.test(t)), JSON.stringify(toasts));
  check('...and says how it eventually clears',
        toasts.some(t=>/another investor buys them from you/i.test(t)), JSON.stringify(toasts));
  check('...without claiming the price was the problem',
        !toasts.some(t=>/past your limit/i.test(t)), JSON.stringify(toasts));

  // The server may omit the numbers; the sentence must still stand up.
  poolReply={filled:false,reason:'company_cannot_pay'};
  reset();
  await settleLimitOrder({...ORDER},false);
  check('the message survives a reply with no figures in it',
        toasts.length===1 && /does not have the cash/i.test(toasts[0])
        && !/undefined|NaN|\$null/i.test(toasts[0]), JSON.stringify(toasts));

  // ── the neighbouring branch still works ──
  poolReply={filled:false,reason:'limit_would_be_breached'};
  reset();
  await settleLimitOrder({...ORDER},false);
  check('a limit-breach refusal still says so, and says it differently',
        toasts.length===1 && /past your limit/i.test(toasts[0]), JSON.stringify(toasts));

  // ── a fill-or-kill that cannot be paid for must still be killed ──
  poolReply={filled:false,reason:'company_cannot_pay',needed:542.60,company_has:10};
  reset();
  await settleLimitOrder({...ORDER},true);
  check('a FOK refused for lack of company cash is cancelled, not left live',
        status()==='cancelled', status());

  // ── the retry loop stays quiet ──
  const sweep=grabFn('checkLimitOrders');
  check('checkLimitOrders treats any non-fill as a skip',
        /if\(!r\|\|!r\.filled\)continue;/.test(sweep), 'skip guard not found');
  // It does toast, but only on fills, which happen once. The refusal path has
  // to reach `continue` before any of that, or a resting order would announce
  // itself on every tick forever.
  check('...and never announces a refusal, because it runs on a timer',
        !/company_cannot_pay/.test(sweep),
        'a per-tick message for a resting order would repeat forever');
  // Scoped to the pool-fill section: the toast further up belongs to the
  // book-matching loop, which is a different path and fills between two
  // students rather than against the company.
  const poolPart=sweep.slice(sweep.indexOf("rpc_fill_limit_vs_pool"));
  check('...the skip happens before any message is built',
        poolPart.indexOf('if(!r||!r.filled)continue;') < poolPart.indexOf('toast('),
        'the guard must precede the toast on the pool path');

  // ── the stop-loss loop must not mistake a refusal for a fire ──
  const stops=grabFn('checkStopLossOrders');
  check('a stop-loss result is only believed when triggered is true',
        /if\(!r\|\|!r\.triggered\)\{/.test(stops), 'triggered guard not found');
  check('...and only two specific reasons change its status',
        (stops.match(/r\.reason===/g)||[]).length===2, 'unexpected number of reason branches');
  check('...so company_cannot_pay leaves it active to retry',
        !/company_cannot_pay/.test(stops),
        'if this path ever special-cases it, it must NOT mark the stop triggered');

  console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
  process.exit(fails?1:0);
})();
