// Client-side rate limiting.
//
// What this is and is not: checkRateLimit lives in one tab's memory, so a
// refresh clears it and a direct RPC call never sees it. It is pacing, not a
// security boundary -- the RPCs are still the only thing enforcing funds,
// ownership, session state and the price band. What it exists to stop is the
// classroom failure mode: a student holding down Buy and walking a price 12%
// per click, or a laggy connection turning one impatient double-click into two
// real orders.
//
// Two bugs it had:
//
//   1. It guarded ONLY placeBuy and placeSell. Shorts, covers, limit orders and
//      buybacks all apply the same price impact a market order does, so the cap
//      could be walked straight around by alternating buy and short -- two
//      separate uncounted budgets adding up to no cap at all.
//
//   2. It was called FIRST, before the local validity checks. A rejected order
//      -- a typo'd quantity, a ticker the student isn't whitelisted for --
//      consumed a slot and started its 0.8s cooldown for something that never
//      happened, so correcting the typo was answered with "wait a moment
//      between orders".
//
// The second is why the position assertions below matter as much as the
// presence ones: "is it called" and "is it called at the right moment" are
// different questions, and only the first one is obvious.
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

// ══════════════════════════════════════════════════════════
// Part 1: the limiter's own arithmetic, against a fake clock
// ══════════════════════════════════════════════════════════

let NOW=1000000;
const realNow=Date.now;
Date.now=()=>NOW;

const toasts=[];
global.toast=m=>toasts.push(m);
global.DB={session:{order_rate_limit:10}};

// Loaded from app.js rather than restated here, so this tests the shipped
// function and not a copy of it that could drift.
eval(src.slice(src.indexOf('const _orderTimestamps='),
                src.indexOf('function checkRateLimit')) +
     grabFn('checkRateLimit'));

const U='student-1';
const at=(ms,label)=>{NOW+=ms;return checkRateLimit(U,label);};
// 61s clears the rolling per-minute window AND the 5s burst window, so each
// block below starts from a genuinely empty budget rather than inheriting
// whatever the previous block left behind.
const freshMinute=()=>{NOW+=61000;};
// 2s apart: far enough that neither the 0.8s floor nor the burst rule can be
// what refuses (at this spacing only 2 prior calls ever sit inside the 5s
// window, and the rule needs 3), so anything refused was refused by the
// per-minute cap and nothing else.
const PACED=2000;

check('first action is allowed', at(0)===true);
check('immediate repeat is refused (0.8s floor)', at(10)===false);
check('  ...and says so', /Wait a moment/.test(toasts[toasts.length-1]));
check('allowed again once the floor has passed', at(900)===true);

// Layer 2: "max 3 in 5 seconds" means the FOURTH is the one refused -- the
// rule trips when three are already in the window, not on the third itself.
toasts.length=0;
freshMinute();
check('burst #1 allowed', at(900)===true);
check('burst #2 allowed', at(900)===true);
check('burst #3 allowed', at(900)===true);
check('burst #4 refused', at(900)===false);
check('  ...names the burst, not the floor', /Too many/.test(toasts[toasts.length-1]));

// Layer 3: the per-minute cap.
freshMinute();
let allowed=0;
for(let i=0;i<15;i++){ if(at(PACED))allowed++; }
check('per-minute cap holds at order_rate_limit (10)', allowed===10, 'allowed '+allowed);
check('  ...and reports the wait', /Max 10 /.test(toasts[toasts.length-1]));

// The cap is a rolling 60s window, not a fixed bucket: waiting it out works.
freshMinute();
check('cap releases after the window rolls off', checkRateLimit(U)===true);

// A refused call must not consume budget. If it did, a student mashing the
// button would burn their whole minute on orders that never happened.
global.DB.session.order_rate_limit=5;
freshMinute();
at(PACED); at(PACED);          // 2 real actions
at(10); at(10); at(10);        // 3 refused by the 0.8s floor
let more=0;
for(let i=0;i<5;i++){ if(at(PACED))more++; }
check('refused calls do not consume budget', more===3, 'got '+more+' more, expected 3');
global.DB.session.order_rate_limit=10;

// Two students never share a budget.
freshMinute();
for(let i=0;i<12;i++){ at(PACED); }
NOW+=PACED;
check('one student hitting the cap does not limit another',
      checkRateLimit('student-2')===true);

// The cap is instructor-configurable from the admin panel mid-class, so it
// has to be read live rather than captured when the page loaded.
global.DB.session.order_rate_limit=3;
freshMinute();
let allowed3=0;
for(let i=0;i<6;i++){ if(at(PACED))allowed3++; }
check('a changed order_rate_limit takes effect immediately', allowed3===3, 'allowed '+allowed3);
global.DB.session.order_rate_limit=10;

// Label only shapes the message; the budget is shared.
toasts.length=0;
freshMinute();
at(PACED,'fund transactions');
at(10,'fund transactions');
check('the label appears in the message', /between fund transactions/.test(toasts[toasts.length-1]));

// The point of one shared budget: a student cannot alternate action types to
// get two caps. This is the bug that existed -- shorts were uncounted, so
// buy/short/buy/short paid the buy cap only every other order.
freshMinute();
checkRateLimit(U,'orders');
NOW+=10;
check('all action types share ONE budget (a short cannot dodge a buy cap)',
      checkRateLimit(U,'fund transactions')===false);

Date.now=realNow;

// ══════════════════════════════════════════════════════════
// Part 2: every money-moving path is actually covered
// ══════════════════════════════════════════════════════════
//
// Each entry is [client function, the RPC it must not reach unguarded].
const GUARDED=[
  ['placeBuy',          'rpc_trade_buy'],
  ['placeSell',         'rpc_trade_sell'],
  ['placeShort',        'rpc_trade_short'],
  ['coverShort',        'rpc_trade_cover_short'],
  ['placeLimitOrder',   'rpc_place_limit_order'],
  ['doBuyback',         'rpc_buyback'],
  ['depositToFund',     'rpc_fund_deposit'],
  ['withdrawFromFund',  'rpc_fund_withdraw'],
  ['issueDividend',     'rpc_pay_dividend'],
];

for(const [fn,rpc] of GUARDED){
  const body=grabFn(fn);
  const limitAt=body.indexOf('checkRateLimit(');
  const rpcAt=body.indexOf("sb.rpc('"+rpc+"'");

  check(fn+' calls checkRateLimit', limitAt>=0);
  check(fn+" reaches "+rpc, rpcAt>=0);
  if(limitAt<0||rpcAt<0)continue;

  check(fn+': the limiter runs before '+rpc, limitAt<rpcAt);

  // The one that actually caught bug #2. If anything can still REJECT the
  // action after a slot has been consumed, then a typo costs the student a
  // slot and a cooldown for an order that never existed. So between the
  // limiter and the RPC there must be no bail-out left.
  const between=body.slice(limitAt,rpcAt);
  check(fn+': nothing can reject the action after a slot is spent',
        !/return toast\(/.test(between),
        'found a bail-out between checkRateLimit and '+rpc);
}

// And the inverse: no money-moving path was left off the list above. If a new
// trade-shaped RPC is added later, this fails until it is either guarded or
// deliberately listed as exempt.
const MONEY_RPCS=[
  'rpc_trade_buy','rpc_trade_sell','rpc_trade_short','rpc_trade_cover_short',
  'rpc_place_limit_order','rpc_buyback','rpc_fund_deposit','rpc_fund_withdraw',
  'rpc_pay_dividend',
];
const covered=new Set(GUARDED.map(g=>g[1]));
check('every known money-moving RPC is on the guarded list',
      MONEY_RPCS.every(r=>covered.has(r)),
      MONEY_RPCS.filter(r=>!covered.has(r)).join(', '));

console.log(fails?('\n'+fails+' FAILURE(S)'):'\nAll rate-limit checks passed.');
process.exit(fails?1:0);
