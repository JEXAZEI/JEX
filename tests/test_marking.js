// Marking the close, and the position cap.
//
// Both exist because of classroom scale, not because of anything a real
// exchange would need to be told.
//
// ── Marking ──
//
// The leaderboard is graded. nw() marks every holding at co.price, the last
// print, and on this exchange the last print is one click away from being
// whatever a student wants it to be:
//
//     AZEI, 1,099 shares issued. The impact model's liquidity term is
//     shares*0.05 = 54.95, so impact = min((qty/54.95)*0.015, 0.12).
//     A 257-share buy moves the price 7.0%.
//
// Buy, let the snapshot land, and the whole position is revalued 7% higher.
// Real exchanges settle the official mark through a closing auction precisely
// because a single late trade is trivial to place, and marking the close is a
// prosecuted offence rather than a clever trick.
//
// markPrice() marks at the session's volume-weighted average instead. The
// property that matters is not "it is an average" -- it is that moving a VWAP
// requires being most of the volume, which costs the price impact on every one
// of those trades. That property is MEASURED below, not asserted.
//
// ── The position cap ──
//
// Nothing capped how much of one company a single person could own. At
// classroom scale that is not theoretical: 257 unsold AZEI shares at $27.19,
// with 7% impact, is about $7,478 against $10,000 of starting cash. One
// student, day one, can buy every available share and still have $2,500 left.
// After that nobody else can buy it and that student alone sets its price.
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
const bind=n=>eval(grabFn(n).replace('function '+n,'global.'+n+'=function'));
const grabConst=n=>{const m=new RegExp('^const '+n+'=.*$','m').exec(src);if(!m)throw new Error('not found: '+n);return m[0];};
// A multi-line arrow const needs brace matching, not a single-line regex.
const grabArrow=n=>{
  const m=new RegExp('^const '+n+'=','m').exec(src);
  if(!m)throw new Error('not found: '+n);
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(m.index,i+1);} }
  throw new Error('unterminated: '+n);
};

// `eval('const X=1')` binds X inside the eval only, so rewrite the declaration
// to assign onto global instead.
const bindConst=n=>eval(grabConst(n).replace(/^const /,'global.'));
bindConst('MARK_MIN_TRADES');bindConst('MARK_RECENT_PRINTS');bindConst('POSITION_CAP_PCT');
bindConst('MARK_MAX_TRADE_WEIGHT');
bind('vwap');bind('sessionTrades');bind('markPrice');bind('positionCap');bind('positionHeadroom');
global.holdings=u=>u.holdings||{};
eval(grabArrow('positionCapMsg').replace(/^const /,'global.'));

const positionCapFor=issued=>Math.floor(issued*POSITION_CAP_PCT);
const T=(ticker,qty,price,ms)=>({ticker,qty,price,created_at:new Date(ms).toISOString()});
const SESSION_START=Date.parse('2026-09-08T15:00:00Z');
const setup=(trades,price)=>{
  global.DB={session:{session_started_at:new Date(SESSION_START).toISOString()},
             trades:trades.slice().reverse(),          // DB.trades is newest-first
             companies:[{ticker:'AZEI',price:price==null?27.19:price,shares:1099,is_index_fund:false}]};
  return DB.companies[0];
};

console.log('=== vwap ===');
// (100@10, 1@110): the cap is 25 so the big trade is capped, but the small one
// is untouched -- weighting by size still means the 1-share print barely counts.
check('weights by quantity, not by trade count',
      vwap([{qty:100,price:10},{qty:1,price:110}])<15,
      String(vwap([{qty:100,price:10},{qty:1,price:110}])));
check('no single trade may carry more than its capped weight',
      vwap([{qty:1000,price:100},{qty:1000,price:100},{qty:1000,price:100},{qty:9000,price:200}])<200,
      String(vwap([{qty:1000,price:100},{qty:1000,price:100},{qty:1000,price:100},{qty:9000,price:200}])));
check('one trade is its own vwap', vwap([{qty:5,price:20}])===20);
check('no trades is null, not zero -- zero would mark a portfolio at nothing',
      vwap([])===null);
check('trades with no quantity contribute nothing', vwap([{qty:0,price:99},{qty:10,price:5}])===5);
check('junk rows do not poison the average', vwap([{qty:'x',price:null},{qty:10,price:5}])===5);
check('rounds to cents', vwap([{qty:3,price:10},{qty:1,price:10.005}])===10);

console.log('\n=== the anti-pump property, measured ===');
// A quiet session: five honest trades around $27.
const honest=[T('AZEI',20,27.10,SESSION_START+1e5),T('AZEI',30,27.15,SESSION_START+2e5),
              T('AZEI',25,27.20,SESSION_START+3e5),T('AZEI',40,27.19,SESSION_START+4e5),
              T('AZEI',35,27.22,SESSION_START+5e5)];
let co=setup(honest);
const baseMark=markPrice(co);
check('a quiet session marks near the traded price', Math.abs(baseMark-27.18)<0.05, String(baseMark));

// Now the pump: one 257-share buy at the impacted price, as the last print.
// impact = min((257/(1099*0.05))*0.015, 0.12) = 7.01% -> 29.10
const impacted=Math.round(27.19*(1+Math.min((257/(1099*0.05))*0.015,0.12))*100)/100;
check('the pump really does move the last print 7%',
      Math.abs(impacted-29.10)<0.02, String(impacted));
co=setup(honest.concat([T('AZEI',257,impacted,SESSION_START+6e5)]),impacted);
const pumpedMark=markPrice(co);
const lastPrintGain=(impacted-27.19)/27.19*100;
const markGain=(pumpedMark-baseMark)/baseMark*100;
check('the LAST PRINT jumps about 7%', Math.abs(lastPrintGain-7.0)<0.3, lastPrintGain.toFixed(2)+'%');
console.log('       last print +'+lastPrintGain.toFixed(2)+'%, graded mark +'+markGain.toFixed(2)+'%');

// THE assertion. Not "the mark moves less" -- that is a feeling. The question
// is whether the pump PAYS, and it is the position cap and the mark together
// that decide, which is why neither alone was enough.
//
//   cost  = what the pumper paid above the new mark for the shares they bought
//   gain  = the revaluation of everything they already held
//   and the position cap bounds how much they can already hold.
const perShareGain=pumpedMark-baseMark;
const pumpCost=257*(impacted-pumpedMark);
const maxHeld=positionCapFor(1099);              // 20% of AZEI's issued shares
const bestCaseGain=maxHeld*perShareGain;
console.log('       pump cost $'+pumpCost.toFixed(2)+
            ', best-case revaluation $'+bestCaseGain.toFixed(2)+
            ' (capped at '+maxHeld+' shares)');
check('pumping the close LOSES money once the position cap bounds the holding',
      bestCaseGain < pumpCost,
      'gain $'+bestCaseGain.toFixed(2)+' vs cost $'+pumpCost.toFixed(2));
check('...and it would have PAID without the cap, which is why both shipped together',
      (2000*perShareGain) > pumpCost,
      'an uncapped 2,000-share holder would gain $'+(2000*perShareGain).toFixed(2));

// And the honest case is not punished: a real, sustained move marks through.
co=setup([T('AZEI',50,30,SESSION_START+1e5),T('AZEI',50,31,SESSION_START+2e5),
          T('AZEI',50,32,SESSION_START+3e5),T('AZEI',50,33,SESSION_START+4e5)],33);
check('a genuine sustained move IS reflected in the mark',
      markPrice(co)>31 && markPrice(co)<32.5, String(markPrice(co)));

console.log('\n=== fallbacks -- it must never mark a portfolio at nothing ===');
co=setup([]);
check('a stock that has not traded marks at its price', markPrice(co)===27.19);
co=setup([T('AZEI',10,26,SESSION_START+1e5)]);
check('one trade this session is below the minimum, so it falls back', markPrice(co)===27.19,
      String(markPrice(co)));
// Trades from BEFORE the session are out of the session window, but still
// usable as recent prints -- better than the last print alone.
co=setup([T('AZEI',10,26,SESSION_START-9e6),T('AZEI',10,26,SESSION_START-8e6),T('AZEI',10,26,SESSION_START-7e6)]);
check('pre-session trades fall through to the recent-prints window', markPrice(co)===26,
      String(markPrice(co)));
global.DB={session:{},trades:[],companies:[{ticker:'AZEI',price:27.19,shares:1099}]};
check('no session_started_at at all does not throw', markPrice(getCoStub())===27.19);
function getCoStub(){return DB.companies[0];}
global.DB={session:{session_started_at:'not a date'},trades:[T('AZEI',5,20,SESSION_START)],
           companies:[{ticker:'AZEI',price:27.19,shares:1099}]};
check('an unparseable session start does not throw', typeof markPrice(getCoStub())==='number');
check('a null company is 0, not a crash', markPrice(null)===0);
co=setup(honest);co.is_index_fund=true;
check('an index unit is marked at its derived price, not its own tape',
      markPrice(co)===co.price);

console.log('\n=== position cap ===');
global.DB={companies:[{ticker:'AZEI',price:27.19,shares:1099,is_index_fund:false}]};
const azei=DB.companies[0];
check('the cap is 20% of shares ISSUED', positionCap(azei)===Math.floor(1099*0.20));
check('...which is 219 shares of AZEI', positionCap(azei)===219, String(positionCap(azei)));
check('an index fund has no cap -- it IS a basket, and mints on demand',
      positionCap({ticker:'JXI',shares:100,is_index_fund:true})===null);
check('a company with no shares issued has no cap, not a cap of 0',
      positionCap({ticker:'X',shares:0})===null);
check('a null company does not throw', positionCap(null)===null);

const holder=q=>({holdings:{AZEI:q}});
check('headroom is what is left under the cap', positionHeadroom(azei,holder(19))===200);
check('a holder at the cap has zero headroom', positionHeadroom(azei,holder(219))===0);
check('a holder OVER the cap has zero headroom, never negative',
      positionHeadroom(azei,holder(400))===0);
check('holding nothing means the whole cap is available',
      positionHeadroom(azei,{holdings:{}})===219);
check('null holdings does not throw', positionHeadroom(azei,{holdings:null})===219);
check('no user means no opinion, not a block', positionHeadroom(azei,null)===null);

// The exploit this exists to stop.
check('the cap makes buying the whole unsold float impossible',
      257 > positionCap(azei), '257 unsold vs cap of '+positionCap(azei));

console.log('\n=== the refusal has to teach, not just refuse ===');
const msgUnder=positionCapMsg(azei,holder(19));
check('it says the limit', /20%/.test(msgUnder), msgUnder);
check('it says how many that is', /219/.test(msgUnder));
check('it says how many more they may buy', /200 more/.test(msgUnder), msgUnder);
const msgAt=positionCapMsg(azei,holder(219));
check('at the cap it says what to do instead', /Sell some before buying more/.test(msgAt), msgAt);
// Two students were ALREADY above the cap when it shipped -- 373 and 344 of
// AZEI's 1,099, which is 85% of the float between them. They are grandfathered:
// nobody is forced to sell, they simply cannot add. The message has to say that
// rather than telling someone holding 373 that 373 is the limit.
const msgOver=positionCapMsg(azei,holder(373));
check('a grandfathered holder is told they keep their shares',
      /You keep them/.test(msgOver), msgOver);
check('...and is not told 373 is the limit', !/373 shares of AZEI, exactly/.test(msgOver));
check('...and still cannot buy more', positionHeadroom(azei,holder(373))===0);

console.log('\n=== wired into the buy path ===');
const buy=grabFn('placeBuy');
check('placeBuy checks the cap', /positionHeadroom\(co,u\)/.test(buy));
check('...and refuses with the explanatory message', /positionCapMsg\(co,u\)/.test(buy));
check('...before the rate limiter, so a refusal costs no cooldown',
      buy.indexOf('positionHeadroom')<buy.indexOf('checkRateLimit'));
check('...and before the RPC is called',
      buy.indexOf('positionHeadroom')<buy.indexOf("sb.rpc('rpc_trade_buy'"));
// The client is pacing, not enforcement -- same as every other guard here.
check('the server is still the boundary (the RPC is what actually moves shares)',
      /sb\.rpc\('rpc_trade_buy'/.test(buy));

console.log('\n=== the boot fetch must supply what marking needs ===');
check('jex_trades is fetched with created_at',
      /jex_trades','order=created_at\.desc&limit=200&select=[^']*created_at/.test(src));

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll marking and position-cap checks passed.'));
process.exit(fails?1:0);
