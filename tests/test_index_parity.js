// The index level the app SHOWS against the one the server TRADES at.
//
// JXI is tradeable — rpc_trade_buy's index branch mints units at
// index_live_value(...) over the unit divisor — so these two numbers are the
// price on the card and the price on the receipt.
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
// and scoping to one classroom when asked.
//
// index_live_value() excluded only the first. It counted restricted classes
// and test companies, and it took p_classroom_id and never looked at it — so
// every classroom-scoped index was priced off the whole exchange.
//
// Measured against the real function on a copy of production. Five listed
// tickers: ACME and BETA at ratio 1.0 in room_a, GAMA at 2.5 in room_b, a
// restricted ACME.R at 0.2, a test company TEST at 9.0.
//
//                    the client showed    the server charged
//   whole exchange        1500                  2740
//   room_a                1000                  2740
//   room_b                2500                  2740
//
// A student buying index units saw 15.00 and was charged 27.40. After the
// migration the server returns 1500 / 1000 / 2500 — the same three numbers,
// on both LF and CRLF bodies.
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

// What the server used to charge: everything except the index row.
const naive=()=>{
  const cs=DB.companies.filter(c=>c.status==='listed'&&!c.is_index_fund);
  return Math.round(cs.reduce((s,c)=>s+c.price/(c.price_history[0].p*c.index_base_adjust),0)/cs.length*1000*100)/100;
};
check('the old server number was 2740', naive()===2740, String(naive()));
check('...which is 83% above what the card said',
      Math.round((naive()/lvl(null)-1)*100)===83, String(Math.round((naive()/lvl(null)-1)*100)));

// dev_mode is the one case where a test company legitimately counts, and the
// server now follows the client into it.
DB.session.dev_mode=true;
check('with dev_mode on the test company is back in', lvl(null)===3375, String(lvl(null)));
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

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
