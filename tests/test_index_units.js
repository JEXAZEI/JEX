// The unit count on an index row has to follow the trade that changed it.
//
// An index mints units on a buy and burns them on a sell, so the server moves
// BOTH counts together:
//
//     shares = v_co.shares + p_qty, shares_avail = v_co.shares_avail + p_qty
//
// but rpc_trade_buy/sell and rpc_fund_buy/sell all report only shares_avail
// back. applyTradeResult and applyFundTradeResult wrote that one and left
// co.shares at its pre-trade value.
//
// Two consequences. sharesBar() renders co.shares as "units outstanding" for
// an index, so the figure shown for the instrument just traded was stale --
// too low after a buy, too high after a sell. And locally shares_avail crept
// above shares, which is the one relationship the schema's own check
// constraint forbids; the client was carrying a state the database would
// refuse.
//
// Ordinary companies are unaffected: their share count does not move on a
// trade, only the float does.
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

const USER={id:'u1',name:'Ada',cash:10000,holdings:{},shorts:{}};
const FUND={id:'f1',name:'Fund',manager_id:'u1',cash:10000,holdings:{},shorts:{}};
global.cu=()=>USER;
global.getUser=id=>id===USER.id?USER:null;
global.getFund=id=>id===FUND.id?FUND:null;
global.getCo=t=>DB.companies.find(c=>c.ticker===t)||null;
global.snapshotNW=()=>{};
global.checkPriceAlerts=()=>{};
global.checkCircuitBreakers=()=>{};
global.pushBalances=()=>{};
global.snapshotJXI=()=>{};
global.pushTradeToSheets=()=>{};
global.toast=()=>{};
global.render=()=>{};
eval(grabFn('applyTradeResult'));
eval(grabFn('applyFundTradeResult'));

const reset=()=>{
  USER.cash=10000;USER.holdings={};USER.shorts={};
  FUND.cash=10000;FUND.holdings={};FUND.shorts={};
  global.DB={trades:[],companies:[
    {ticker:'JXI',is_index_fund:true,price:100,shares:100,shares_avail:100,price_history:[]},
    {ticker:'ACME',is_index_fund:false,price:50,shares:1000,shares_avail:400,price_history:[]}]};
};
const jxi=()=>getCo('JXI');
const acme=()=>getCo('ACME');

// ── a student buys 25 index units: both counts rise by 25 ──
reset();
applyTradeResult('JXI',{cash:7500,holdings:{JXI:25},price:100,shares_avail:125,price_history:[]});
check('a buy raises units outstanding', jxi().shares===125, String(jxi().shares));
check('...in step with the float', jxi().shares_avail===125, String(jxi().shares_avail));
check('...never leaving avail above shares', jxi().shares_avail<=jxi().shares);

// ── and a sell burns them ──
reset();
applyTradeResult('JXI',{cash:11000,holdings:{},price:100,shares_avail:90,price_history:[]});
check('a sell lowers units outstanding', jxi().shares===90, String(jxi().shares));
check('...in step with the float', jxi().shares_avail===90);

// ── the same through a fund ──
reset();
applyFundTradeResult('f1','JXI',{cash:9000,holdings:{JXI:10},price:100,shares_avail:110,price_history:[]});
check('a fund buy raises units outstanding too', jxi().shares===110, String(jxi().shares));
reset();
applyFundTradeResult('f1','JXI',{cash:10500,holdings:{},price:100,shares_avail:95,price_history:[]});
check('a fund sell lowers it too', jxi().shares===95, String(jxi().shares));

// ── an ordinary company must NOT have its share count touched ──
// Only the float moves on a normal trade; the share count is set by IPO,
// dilution and buyback, none of which come through here.
reset();
applyTradeResult('ACME',{cash:9500,holdings:{ACME:10},price:51,shares_avail:390,price_history:[]});
check('an ordinary buy leaves the share count alone', acme().shares===1000, String(acme().shares));
check('...and moves only the float', acme().shares_avail===390, String(acme().shares_avail));
reset();
applyFundTradeResult('f1','ACME',{cash:9500,holdings:{ACME:10},price:51,shares_avail:390,price_history:[]});
check('a fund trade in an ordinary company leaves it alone too', acme().shares===1000);

// ── short and cover report no shares_avail at all ──
// Their index branch changes neither count, so nothing must be inferred.
reset();
applyTradeResult('JXI',{cash:8500,shorts:{JXI:{qty:5,avgPrice:100}},price:100,price_history:[]});
check('a short leaves both counts untouched',
      jxi().shares===100 && jxi().shares_avail===100,
      jxi().shares+'/'+jxi().shares_avail);
reset();
applyTradeResult('JXI',{cash:9500,shorts:{},price:100,price_history:[]});
check('a cover leaves both counts untouched',
      jxi().shares===100 && jxi().shares_avail===100);

// ── repeated trades accumulate correctly ──
reset();
applyTradeResult('JXI',{cash:9000,holdings:{JXI:10},price:100,shares_avail:110,price_history:[]});
applyTradeResult('JXI',{cash:8000,holdings:{JXI:20},price:100,shares_avail:120,price_history:[]});
applyTradeResult('JXI',{cash:8500,holdings:{JXI:15},price:100,shares_avail:115,price_history:[]});
check('three trades in a row land on the right count', jxi().shares===115, String(jxi().shares));

// ── a missing shares field must not produce NaN ──
reset();
delete jxi().shares;
applyTradeResult('JXI',{cash:9000,holdings:{JXI:10},price:100,shares_avail:110,price_history:[]});
check('a company with no share count does not become NaN',
      Number.isFinite(jxi().shares), String(jxi().shares));

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll index-unit checks passed.'));
process.exit(fails?1:0);
