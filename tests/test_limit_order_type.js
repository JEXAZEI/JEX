// The order type a student picks has to be the order type that gets sent.
//
// The company page renders two mutually exclusive limit panels with two
// DIFFERENT selects:
//
//   buy panel   <select id="limit-order-type">       GTC / Day
//   sell panel  <select id="limit-order-type-sell">  GTC / Day / FOK
//
// placeLimitOrder read only the first. On the Sell tab that element is not in
// the DOM at all, so orderType fell back to 'gtc' -- a student choosing FOK
// ("fill completely right now or cancel") silently got a resting good-till-
// cancelled order instead, which is close to the opposite instruction.
//
// cpLimit() tried to paper over it by copying the sell select's value into the
// buy select before dispatching. That could never have worked: the target
// element only exists while the buy panel is rendered, and it is not, because
// the sell panel is.
//
// Nobody had ever placed a limit order on this exchange (the census said
// limit_orders: 0), so nothing had exercised either half.
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

// A DOM with exactly one panel rendered at a time, which is the whole point.
let dom={},sent=null,toasts=[];
global.document={getElementById:id=>dom[id]||null};
global.toast=m=>{toasts.push(String(m));};
global.render=()=>{};
global.fmt=n=>String(n);
global.checkRateLimit=()=>true;
global.holdings=u=>u.holdings||{};
global.getCo=t=>({ticker:t,is_index_fund:false,price:30,shares:1000,shares_avail:500});
global.getFund=()=>({name:'F'});
global.logActivity=async()=>{};
global.settleLimitOrder=async()=>{};
global.pushBalances=()=>{};
global.snapshotNW=()=>{};
global.applyTradeResult=()=>{};
global.pushTradeToSheets=()=>{};
global.getUser=()=>USER;
global.rpcErrorMessage=e=>String(e&&e.message||e);
global.DB={limitOrders:[],session:{}};
const USER={id:'u1',cash:100000,holdings:{ACME:50}};
global.cu=()=>USER;
global.sb={rpc:async(fn,p)=>{sent={fn,p};return{order:{id:'o1',ticker:p.p_ticker}};}};
eval(grabFn('placeLimitOrder'));

const buyPanel = t => ({'limit-order-type':{value:t}});
const sellPanel = t => ({'limit-order-type-sell':{value:t}});
const run = async (side,panel) => {dom=panel;sent=null;toasts=[];
  await placeLimitOrder('ACME',side,'5','30');return sent&&sent.p;};

(async()=>{

  // ── the bug ──
  let p=await run('sell', sellPanel('fok'));
  check('a FOK sell is sent as FOK', p && p.p_order_type==='fok',
        p?String(p.p_order_type):'no rpc: '+JSON.stringify(toasts));
  p=await run('sell', sellPanel('day'));
  check('a Day sell is sent as Day', p && p.p_order_type==='day', p&&String(p.p_order_type));
  p=await run('sell', sellPanel('gtc'));
  check('a GTC sell is sent as GTC', p && p.p_order_type==='gtc', p&&String(p.p_order_type));

  // ── the buy side, which always worked, must keep working ──
  p=await run('buy', buyPanel('day'));
  check('a Day buy is sent as Day', p && p.p_order_type==='day', p&&String(p.p_order_type));
  p=await run('buy', buyPanel('gtc'));
  check('a GTC buy is sent as GTC', p && p.p_order_type==='gtc', p&&String(p.p_order_type));

  // ── the two panels are never in the DOM together, but if they ever are,
  //    each side must still read its own select rather than the other's ──
  dom=Object.assign(buyPanel('gtc'), sellPanel('fok'));
  sent=null; toasts=[];
  await placeLimitOrder('ACME','sell','5','30');
  check('with both selects present, sell reads the sell one',
        sent && sent.p.p_order_type==='fok', sent&&String(sent.p.p_order_type));
  dom=Object.assign(buyPanel('day'), sellPanel('fok'));
  sent=null; toasts=[];
  await placeLimitOrder('ACME','buy','5','30');
  check('...and buy reads the buy one',
        sent && sent.p.p_order_type==='day', sent&&String(sent.p.p_order_type));

  // ── the market quick-panel renders NO select, and never has ──
  // Falling through to gtc is correct there: its UI offers no choice, so
  // sending anything else would be inventing an instruction.
  p=await run('sell', {});
  check('no select at all still sends gtc', p && p.p_order_type==='gtc', p&&String(p.p_order_type));
  p=await run('buy', {});
  check('...on the buy side too', p && p.p_order_type==='gtc', p&&String(p.p_order_type));

  // ── case is normalised, since the value comes from a DOM string ──
  p=await run('sell', sellPanel('FOK'));
  check('an upper-case value is normalised', p && p.p_order_type==='fok', p&&String(p.p_order_type));

  // ── the guards in front of it still fire ──
  dom=sellPanel('fok'); sent=null; toasts=[];
  await placeLimitOrder('ACME','sell','999','30');
  check('an unbacked sell limit is still refused before the RPC',
        sent===null && toasts.some(t=>/only hold/i.test(t)), JSON.stringify(toasts));
  dom=buyPanel('gtc'); sent=null; toasts=[];
  await placeLimitOrder('ACME','buy','100000','30');
  check('an unaffordable buy limit is still refused before the RPC',
        sent===null && toasts.some(t=>/would cost/i.test(t)), JSON.stringify(toasts));

  // ── and the dead sync is gone ──
  // It copied one select's value into the other before dispatching. Leaving it
  // in place would be harmless but misleading: it reads as though it is what
  // makes the sell side work, when the target is never in the DOM.
  const cpLimit=grabFn('cpLimit');
  check('cpLimit no longer pretends to sync the two selects',
        !/sharedTypeEl/.test(cpLimit), cpLimit);

  console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll limit-order-type checks passed.'));
  process.exit(fails?1:0);
})();
