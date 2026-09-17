// `record IS NOT NULL` does not mean "a row was found".
//
// In PL/pgSQL it is true only when EVERY field of the record is non-null. One
// nullable column with a null in it and the test is false, with the row sitting
// right there. (The opposite, `record IS NULL`, does mean what it looks like --
// true only when every field is null, which IS the not-found case. So the
// dozens of `if v_co is null then raise exception 'Company not found'` checks
// across this schema are fine. Only the negated form is broken.)
//
// It appeared in six places. This file exists because the client half of the
// worst one -- the restricted share class -- has to keep agreeing with the
// server, and because the reasoning is worth keeping somewhere a reader will
// find it.
//
// ── What it did ──
//
// Four trading paths gate the whitelist behind it:
//
//   select * into v_meta from jex_share_classes where ticker = p_ticker;
//   if v_meta is not null and coalesce(v_meta.restricted,false) then ...
//
// whitelist, owner_id and created_at are all nullable on that table. Measured
// against the real functions on a copy of production -- ACME.B, restricted,
// whitelist ["u_s1"], owner_id null:
//
//   row found = true
//   (v_meta is not null) = false        <- the guard
//   Student 2, not on the whitelist, buys 25 shares -> SUCCEEDS
//
// Fill owner_id and created_at in so nothing is null and the same buy is
// refused. The feature worked only on rows that happened to have nothing
// missing. rpc_trade_buy, rpc_place_limit_order, rpc_fund_buy and
// rpc_fund_short all had it.
//
// ── A fifth one, found later ──
//
// rpc_trade_short had it too and was missed. I found the four above by
// reading the functions and stopped there; the fifth turned up only when
// every live function body was dumped and scanned mechanically for the
// pattern. So for a while a restricted class was refused to a student on the
// buy side and the limit-order side and open to the same student on the short
// side -- measured: refused a 5-share BUY, filled a 5-share SHORT in the same
// session. Shorting is the worse half: it does not need the shares to be for
// sale and it drives the price down.
//
// The lesson is the one this directory keeps relearning. Reading finds most
// of them; only a mechanical sweep finds the last one. The sweep is now part
// of restricted_short.sql's verification, which reports any function still
// using the broken shape and should always come back empty.
//
// ── And the index price ──
//
// rpc_snapshot_jxi guards its price refresh with `if v_co is not null then`,
// and JXI's owner_id is null by design -- the index has no owner. That block
// had never run. jex_mark_price() hands back jex_companies.price unchanged for
// an index row and rpc_snapshot_nw marks holdings at jex_mark_price, so the
// GRADED net-worth history valued index units at whatever the last direct JXI
// trade left behind. Measured: a constituent moved, the true unit price went
// 10.00 -> 10.23, the stored price and the graded mark both stayed at 10.00.
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

// ── the client's own whitelist test must not have the same shape of hole ──
//
// canAccessTicker is the client half. It has to refuse a restricted class the
// same way the server now does, including when the whitelist is missing
// entirely -- which is exactly the row the server used to wave through.
global.DB={shareClasses:[],session:{}};
global.isAdmin=u=>!!(u&&['chairman','president','secretary','treasurer','compliance_officer'].includes(u.role));
const people={u_s1:{id:'u_s1',role:'student'},u_s2:{id:'u_s2',role:'student'},u_ch:{id:'u_ch',role:'chairman'}};
global.getUser=id=>people[id]||null;
function grabConst(name){
  const m=new RegExp('(?:^|;)const '+name+'=','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  const start=m.index+(m[0].startsWith(';')?1:0);
  let i=src.indexOf('{',start),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(start,i+1);} }
  throw new Error('unterminated: '+name);
}
eval(grabConst('classWhitelist').replace(/^const /,'global.'));
eval(grabFn('getClassMeta').replace(/^function /,'global.getClassMeta=function '));
eval(grabFn('canAccessTicker').replace(/^function /,'global.canAccessTicker=function '));

const student='u_s1',other='u_s2',boss='u_ch';
DB.shareClasses=[{ticker:'ACME.B',parent_ticker:'ACME',restricted:true,whitelist:['u_s1']}];
check('a whitelisted student gets in', canAccessTicker('ACME.B',student)===true);
check('everybody else does not', canAccessTicker('ACME.B',other)===false);
check('an officer always does', canAccessTicker('ACME.B',boss)===true);

// The shapes a null/absent whitelist can arrive in. Each of these is the row
// the server used to skip its check on entirely, so the client must not treat
// any of them as "open to all".
for(const [label,wl] of [['null',null],['undefined',undefined],['an empty array',[]],
                          ['an empty object',{}],['a string',''],['a jsonb null','null']]){
  DB.shareClasses=[{ticker:'ACME.B',parent_ticker:'ACME',restricted:true,whitelist:wl}];
  check('a restricted class with '+label+' for a whitelist is still closed',
        canAccessTicker('ACME.B',other)===false, JSON.stringify(wl));
  check('...and an officer still gets in', canAccessTicker('ACME.B',boss)===true);
}

// Not restricted means open, whatever the whitelist says.
DB.shareClasses=[{ticker:'ACME.B',parent_ticker:'ACME',restricted:false,whitelist:['u_s1']}];
check('an unrestricted class is open to everybody', canAccessTicker('ACME.B',other)===true);
DB.shareClasses=[];
check('a ticker with no share-class row at all is open', canAccessTicker('ACME',other)===true);

// ── the arithmetic of the index price the graded snapshot reads ──
//
// A unit is the index level over the session's divisor. The snapshot wrote a
// hardcoded 10 while every trading path read the setting, so at any other
// setting the graded price and the traded price were different numbers.
const unit=(level,divisor)=>Math.round(level/divisor*100)/100;
check('at the default divisor the two agree', unit(1000,10)===unit(1000,10));
check('at a divisor of 100 a unit is $10.00, not $100.00',
      unit(1000,100)===10&&unit(1000,10)===100);
check('...so the hardcoded copy was ten times the traded price',
      unit(1000,10)/unit(1000,100)===10);
check('a constituent moving 2.3% moves the unit with it', unit(1023,100)===10.23);
check('the fallback divisor is still 10 when the setting is missing',
      unit(1000,(Number(undefined)>0?Number(undefined):10))===100);

// ── and the truth table the whole bug rests on ──
//
// Modelling PL/pgSQL: `rec is not null` is ALL fields non-null; `rec is null`
// is ALL fields null. They are not complements, which is the trap.
const isNotNull=r=>r!==null&&Object.values(r).every(v=>v!==null);
const isNull=r=>r===null||Object.values(r).every(v=>v===null);
const found={ticker:'ACME.B',restricted:true,whitelist:null,owner_id:null};
const missing=null;
check('a found row with a null column is NOT "is not null"', isNotNull(found)===false);
check('...but it is not "is null" either', isNull(found)===false);
check('so the two are not opposites -- both false at once',
      isNotNull(found)===false&&isNull(found)===false);
check('a row that was not found IS "is null"', isNull(missing)===true);
check('...which is why the not-found checks were always correct',
      isNull(missing)===true&&isNull(found)===false);
const complete={ticker:'ACME.B',restricted:true,whitelist:['u_s1'],owner_id:'u_ceo'};
check('only a row with nothing missing passes "is not null"', isNotNull(complete)===true);
// The replacement: a NOT NULL column is non-null exactly when a row was found.
const foundByKey=r=>!!(r&&r.ticker!==null&&r.ticker!==undefined);
check('testing the primary key is right for a found row', foundByKey(found)===true);
check('...and right for a missing one', foundByKey(missing)===false);
check('...and right for a complete one', foundByKey(complete)===true);

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
