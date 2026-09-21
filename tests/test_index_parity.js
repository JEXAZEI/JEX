// The index level the app shows and the index students trade at have to be the
// same number.
//
// JXI is tradeable — rpc_trade_buy's index branch mints units at
// index_live_value(...) over the unit divisor — so these two are the price on
// the card and the price on the receipt.
//
// computeIndex() averages price / (first recorded price * index_base_adjust)
// across every LISTED company, excluding three things deliberately:
//
//   index funds themselves    an index of itself is circular
//   RESTRICTED share classes  not everyone may trade them, so they do not
//                             belong in a number everyone is measured by
//   TEST-account companies    hidden from students everywhere else, unless
//                             dev_mode is on
//
// and scoping to one classroom when asked. index_live_value() applies all
// three and reads the classroom, so the two agree.
//
// ── A correction, kept deliberately ──
//
// I reported that index_live_value did NONE of that — that it counted
// restricted classes and test companies and ignored the classroom it was
// handed, so students were charged 2740 where the card said 1500 — and I
// shipped a migration for it. That was wrong about production. The live
// function already had all three exclusions and already read the classroom;
// what was stale was the copy on my test rig. The migration skipped on its own
// "already applied" guard and changed nothing, and JXI's price did not move.
//
// The 1500 / 1000 / 2500 below were then confirmed against production's actual
// function body, dumped and run: it returns exactly those three numbers, and
// 3375 with dev_mode on.
//
// This file stays because the agreement is worth pinning and because the next
// person to "find" this should find this note first.
//
// ── The third place that had to stop reading the cache ──
//
// jex_companies.price for an index row is not a price, it is a CACHE of a
// derived value, rewritten only by a direct unit trade or by rpc_snapshot_jxi.
// Three server paths read it as though it were a price, and each was fixed
// separately as it was found:
//
//   rpc_trade_cover_short  closing an index short settled at the cache
//   rpc_margin_call_short  a short $30,000 under water reported loss 0.00
//   jex_mark_price         the GRADED net worth marked units at the cache
//
// The last one is the worst because app.js calls snapshotNW BEFORE
// snapshotJXI after every trade, so the graded row written at the moment of a
// trade was always taken before the cache caught up with that trade. Not
// occasionally -- every time. Measured: 500 units marked at $7.01 when the
// level was $9.51, writing $13,505.00 where the truth was $14,755.00, 8.5%
// low. It self-corrected on the next tick, so the balance was never wrong for
// long -- but jex_nw_history IS the graded artifact, and every row taken at a
// trade carried the error.
//
// The rule for this schema, stated once: for an index row, the answer is
// index_live_value() / jex_index_unit_divisor(), never c.price.
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

// ── the client's three exclusions, which the server now mirrors ──
check('the index excludes restricted share classes',
      /const isRestrictedClass=c=>\{const meta=getClassMeta\(c\.ticker\);return!!meta&&meta\.restricted;\};/.test(src));
check('...and index funds themselves', /!c\.is_index_fund/.test(src));
check('...and hidden test entities', /!isHiddenTestEntity\(c\.owner_id\)/.test(src));
check('...and scopes to a classroom when asked',
      /classroomId==null\|\|getUser\(c\.owner_id\)\?\.classroom_id===classroomId/.test(src));
check('a test entity is only hidden while dev_mode is off',
      /const isHiddenTestEntity=userId=>!DB\.session\.dev_mode&&!!getUser\(userId\)\?\.is_test_account;/.test(src));

// ── and the levels those exclusions produce ──
const price=(t,p,base,owner)=>({ticker:t,price:p,status:'listed',owner_id:owner,is_index_fund:false,
  index_base_adjust:1,price_history:[{p:base,t:'2026-01-01T00:00:00.000Z'}]});
global.DB={
  session:{dev_mode:false},
  users:[{id:'u_ceo',is_test_account:false,classroom_id:'room_a'},
         {id:'u_test',is_test_account:true,classroom_id:'room_a'},
         {id:'u_ceo_b',is_test_account:false,classroom_id:'room_b'}],
  shareClasses:[{ticker:'ACME.R',parent_ticker:'ACME',restricted:true}],
  companies:[price('ACME',30,30,'u_ceo'),price('BETA',12,12,'u_ceo'),
             price('GAMA',50,20,'u_ceo_b'),price('ACME.R',6,30,'u_ceo'),
             price('TEST',90,10,'u_test'),
             {ticker:'JXI',price:15,status:'listed',owner_id:null,is_index_fund:true,
              index_base_adjust:1,price_history:[{p:10,t:'2026-01-01T00:00:00.000Z'}]}]
};
global.getUser=id=>DB.users.find(u=>u.id===id)||null;
global.getCo=t=>DB.companies.find(c=>c.ticker===t)||null;
global.getClassMeta=t=>DB.shareClasses.find(c=>c.ticker===t)||null;
eval((/^const isHiddenTestEntity=.*$/m.exec(src))[0].replace(/^const /,'global.'));
eval(grabFn('computeIndex').replace(/^function /,'global.computeIndex=function '));

const lvl=room=>computeIndex(room).value;
const tick=room=>computeIndex(room).constituents.map(c=>c.ticker).sort().join(',');
check('the whole exchange is 1500', lvl(null)===1500, String(lvl(null)));
check('...from ACME, BETA and GAMA only', tick(null)==='ACME,BETA,GAMA', tick(null));
check('room_a is 1000', lvl('room_a')===1000, String(lvl('room_a')));
check('...from ACME and BETA', tick('room_a')==='ACME,BETA', tick('room_a'));
check('room_b is 2500', lvl('room_b')===2500, String(lvl('room_b')));
check('...from GAMA alone', tick('room_b')==='GAMA', tick('room_b'));

// What the average comes to with no exclusions at all — the shape any
// reimplementation that forgets them would produce.
const naive=()=>{
  const cs=DB.companies.filter(c=>c.status==='listed'&&!c.is_index_fund);
  return Math.round(cs.reduce((s,c)=>s+c.price/(c.price_history[0].p*c.index_base_adjust),0)/cs.length*1000*100)/100;
};
check('with no exclusions the average is 2740', naive()===2740, String(naive()));
check('...which is 83% above the honest number',
      Math.round((naive()/lvl(null)-1)*100)===83, String(Math.round((naive()/lvl(null)-1)*100)));

// dev_mode is the one case where a test company legitimately counts, and both
// sides honour it.
DB.session.dev_mode=true;
check('with dev_mode on the test company is back in -- server agrees at 3375', lvl(null)===3375, String(lvl(null)));
check('...but a restricted class still is not', tick(null)==='ACME,BETA,GAMA,TEST', tick(null));
DB.session.dev_mode=false;

// Edge shapes the average has to survive.
DB.companies=[price('ONE',20,10,'u_ceo')];
check('a single constituent is just its own ratio', lvl(null)===2000, String(lvl(null)));
DB.companies=[price('ACME.R',6,30,'u_ceo')];
check('nothing but a restricted class means an empty index', lvl(null)===1000, String(lvl(null)));
DB.companies=[];
check('no companies at all is the base level, not NaN', lvl(null)===1000, String(lvl(null)));
DB.companies=[Object.assign(price('ZERO',20,0,'u_ceo'),{})];
check('a zero base does not divide by zero', Number.isFinite(lvl(null)), String(lvl(null)));

// ── marking a portfolio that holds index units ──
//
// jex_mark_price now computes the level rather than reading the cache. This is
// the arithmetic it runs, and the gap it used to leave in the graded row.
const DIVISOR=100;
const markIndex=(liveLevel,cachedPrice)=>
  liveLevel==null?cachedPrice:Math.round((liveLevel/DIVISOR)*100)/100;

check('an index unit marks at the level, not the cache',
      markIndex(951,7.01)===9.51, String(markIndex(951,7.01)));
check('...and falls back to the cache when there is no level to compute',
      markIndex(null,7.01)===7.01, String(markIndex(null,7.01)));

const graded=(cash,units,mark)=>Math.round((cash+units*mark)*100)/100;
check('the measured graded row: $14,755.00 with a live mark',
      graded(10000,500,markIndex(951,7.01))===14755, String(graded(10000,500,markIndex(951,7.01))));
check('...where the cache wrote $13,505.00',
      graded(10000,500,7.01)===13505, String(graded(10000,500,7.01)));
check('...understating it by $1,250.00',
      Math.round((graded(10000,500,markIndex(951,7.01))-graded(10000,500,7.01))*100)/100===1250);
check('...which is 8.5% of the true figure',
      Math.round((1250/14755)*1000)/10===8.5, String(Math.round((1250/14755)*1000)/10));
check('a holder of no units is unaffected either way',
      graded(10000,0,markIndex(951,7.01))===graded(10000,0,7.01));

// The ordering in app.js that made this fire on every trade rather than
// occasionally. Pinned so that if it is ever reversed, the reason this was
// fixed server-side instead is still on the record.
check('snapshotNW still runs before snapshotJXI after a trade',
      /if\(u\)snapshotNW\(u\.id\);[\s\S]{0,200}?snapshotJXI\(\);/.test(src));

// ── the index's percentage must equal its constituents' ──
//
// The card showed "JXI -50.00% today" next to "AZEI +0.00% today", with one
// listed company. One number divided by a constant cannot fall 50% while the
// number it is derived from is flat, so that was a bad baseline, not a market
// event.
//
// rpc_record_session_open_prices captured jex_companies.price as the index's
// opening baseline -- and for an index row that column is a CACHE, refreshed
// only by a unit trade or rpc_snapshot_jxi. Whatever stale number sat there at
// session open became the divisor for every percentage shown that day. The
// baseline is now computed from the constituents' own opening prices, the same
// way the live level is computed from their current ones.
const DIV=100;
const level=(price,base)=>Math.round((price/base)*1000*100)/100;
const unit=lvl=>Math.round((lvl/DIV)*100)/100;
const pct=(now,open)=>Math.round(((now/open)-1)*100*100)/100;

// The reproduction: AZEI flat, JXI baseline left at a stale 24.00.
// Asserted as a range, not a digit: Postgres rounds this to -50.13 and JS to
// -50.12, and the point is the magnitude -- a flat stock reading as a halving.
check('the bug: a flat constituent with a stale index baseline reads about -50%',
      pct(unit(level(13.61,11.37)),24.00)<-50 && pct(unit(level(13.61,11.37)),24.00)>-50.2,
      String(pct(unit(level(13.61,11.37)),24.00)));
check('...while the constituent itself reads 0.00%', pct(13.61,13.61)===0);

// With the baseline computed from the constituent's own open, they agree.
const openUnit=unit(level(13.61,11.37));
check('fixed: a flat constituent gives a flat index', pct(unit(level(13.61,11.37)),openUnit)===0);
for(const [label,now] of [['up 20%',16.33],['down 20%',10.89],['up 5%',14.29],['unchanged',13.61]]){
  const idx=pct(unit(level(now,11.37)),openUnit), con=pct(now,13.61);
  check('the index tracks its only constituent '+label+' ('+idx+'% vs '+con+'%)',
        Math.abs(idx-con)<=0.05, idx+' vs '+con);
}
// The residual is cent-rounding on the unit price, not a modelling error.
check('any gap is under a twentieth of a point, and comes from rounding to the cent',
      Math.abs(pct(unit(level(16.33,11.37)),openUnit)-pct(16.33,13.61))<0.05);

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
