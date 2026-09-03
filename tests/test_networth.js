// Net worth.
//
// nw() is the single number the class competes on. It also feeds
// snapshotNW() -> jex_nw_history, which is where the portfolio chart, Sharpe,
// VaR and beta all come from -- so an error here is not one wrong figure, it
// is every derived statistic quietly wrong for the rest of the semester.
//
// The rule it has to obey: net worth changes when the MARKET moves, never
// because the student moved their own money from one place to another.
// Buying a share, opening a short, depositing into a fund -- each of those
// converts cash into something of equal value at that instant, so net worth
// must be flat across all of them.
//
// It was not. fund_units was missing from the sum entirely, so a deposit
// looked like a straight loss of the whole amount.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const near=(a,b,t)=>Math.abs(a-b)<=(t===undefined?0.01:t);

// ── pull the real definitions out of app.js ──
function grabConst(name){
  // Not anchored to the line start: holdings/shorts/watchlist share one line.
  const m=new RegExp('(?:^|;)const '+name+'=','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  m.index += m[0].startsWith(';') ? 1 : 0;
  let depth=0;
  for(let i=m.index;i<src.length;i++){
    const c=src[i];
    if('([{'.includes(c))depth++;
    else if(')]}'.includes(c))depth--;
    else if(c===';'&&depth===0)return src.slice(m.index,i+1);
  }
  throw new Error('unterminated: '+name);
}
function grabFn(name){
  const m=new RegExp('^function '+name+'\\(','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(m.index,i+1);} }
}

global.DB={companies:[],funds:[],dividends:[]};
global.getCo=t=>DB.companies.find(c=>c.ticker===t);
for(const n of ['holdings','shorts','watchlist','pv','sPnl','shortCollateral','fundValue','nw'])
  eval(grabConst(n).replace(new RegExp('^const '+n+'='),'global.'+n+'='));
// currentFundNav is now just fundAUM() split across units outstanding -- one
// definition of a fund's total value, shared with the AUM figure on screen.
eval(grabFn('fundAUM').replace('function fundAUM','global.fundAUM=function'));
eval(grabFn('currentFundNav').replace('function currentFundNav','global.currentFundNav=function'));
// fundAUM also reaches for the fund's short book.
global.fundShortPnl=f=>Object.entries(f.shorts||{}).reduce((s,[t,p])=>{
  const c=getCo(t);return c?s+(p.avgPrice-c.price)*p.qty:s;},0);
global.fundShortCollateral=f=>Object.entries(f.shorts||{}).reduce((s,[,p])=>s+(p.collateral||0),0);

const reset=()=>{
  DB.companies=[
    {ticker:'ACME',price:10,shares:1000,shares_avail:500},
    {ticker:'BETA',price:20,shares:500,shares_avail:200},
  ];
  DB.funds=[{id:'f-1',name:'Fund',cash:1000,holdings:{},shorts:{},units_outstanding:100,fee_pct:10,status:'active'}];
};
const student=extra=>Object.assign({id:'u1',role:'student',cash:10000,holdings:{},shorts:{},fund_units:{}},extra||{});

console.log('=== the basics ===');
reset();
check('cash alone is net worth', nw(student())===10000, String(nw(student())));
check('shares are marked at the live price',
  nw(student({cash:0,holdings:{ACME:10}}))===100, String(nw(student({cash:0,holdings:{ACME:10}}))));
check('a ticker that no longer exists contributes nothing, and does not throw',
  nw(student({cash:5,holdings:{GONE:99}}))===5);
check('empty/absent collections are tolerated',
  nw({id:'u',role:'student',cash:42})===42);

console.log('\n=== moving your own money must not change net worth ===');
reset();
{
  // Buy: 10000 cash -> 20 shares of ACME at 10 plus 9800 cash.
  const before=nw(student());
  const after =nw(student({cash:9800,holdings:{ACME:20}}));
  check('buying shares is net-worth neutral', near(before,after), before+' -> '+after);
}
{
  // Short 10 BETA at 20: 150% collateral = 300 locked out of cash.
  const before=nw(student());
  const after =nw(student({cash:9700,shorts:{BETA:{qty:10,avgPrice:20,collateral:300}}}));
  check('opening a short is net-worth neutral', near(before,after), before+' -> '+after);
}
{
  // Deposit 400 into a fund at NAV 10 -> 40 units. THE REGRESSION.
  const before=nw(student());
  const after =nw(student({cash:9600,fund_units:{'f-1':{units:40,costBasis:10}}}));
  check('depositing into a fund is net-worth neutral', near(before,after), before+' -> '+after);
  check('and the deposit is not silently lost', after>9600,
    'net worth '+after+' is no better than the cash left over');
}
{
  // All three at once.
  const before=nw(student());
  const after =nw(student({cash:9100,holdings:{ACME:20},
    shorts:{BETA:{qty:10,avgPrice:20,collateral:300}},
    fund_units:{'f-1':{units:40,costBasis:10}}}));
  check('all three together are net-worth neutral', near(before,after), before+' -> '+after);
}

console.log('\n=== net worth DOES move when the market moves ===');
reset();
{
  const u=student({cash:0,holdings:{ACME:10}});
  const before=nw(u);
  getCo('ACME').price=11;
  check('a share price rise raises it', near(nw(u),before+10), before+' -> '+nw(u));
}
reset();
{
  const u=student({cash:9700,shorts:{BETA:{qty:10,avgPrice:20,collateral:300}}});
  const before=nw(u);
  getCo('BETA').price=18;                       // shorted at 20, now 18
  check('a short in profit raises it by the gain', near(nw(u),before+20), before+' -> '+nw(u));
  getCo('BETA').price=22;
  check('a short under water lowers it', nw(u)<before, String(nw(u)));
}
reset();
{
  const u=student({cash:9600,fund_units:{'f-1':{units:40,costBasis:10}}});
  const before=nw(u);
  DB.funds[0].cash=1500;                        // the fund gained 500 on 100 units
  check('a fund that gains lifts its depositors', near(nw(u),before+200), before+' -> '+nw(u));
  DB.funds[0].cash=500;
  check('a fund that loses drags them down', nw(u)<before, String(nw(u)));
}

console.log('\n=== fund-unit edge cases ===');
reset();
check('units in a fund that no longer exists are skipped, not counted as NaN',
  nw(student({cash:100,fund_units:{'gone':{units:5,costBasis:10}}}))===100);
check('a zero-unit position contributes nothing',
  nw(student({cash:100,fund_units:{'f-1':{units:0,costBasis:10}}}))===100);
check('a malformed position does not throw',
  nw(student({cash:100,fund_units:{'f-1':null}}))===100);
{
  // An empty fund is worth 10 a unit by convention -- units bought into it
  // must be valued the same way rather than at zero.
  DB.funds[0].units_outstanding=0; DB.funds[0].cash=0;
  check('an empty fund still values units at the 10 baseline',
    nw(student({cash:0,fund_units:{'f-1':{units:3,costBasis:10}}}))===30,
    String(nw(student({cash:0,fund_units:{'f-1':{units:3,costBasis:10}}}))));
}

console.log('\n=== a round trip through a fund returns you to where you started ===');
reset();
{
  const start=nw(student());
  // deposit 400 -> 40 units, then withdraw all 40 at an unchanged NAV
  const mid=nw(student({cash:9600,fund_units:{'f-1':{units:40,costBasis:10}}}));
  const end=nw(student({cash:10000}));
  check('deposit then withdraw leaves net worth unchanged',
    near(start,mid)&&near(mid,end), [start,mid,end].join(' -> '));
}

console.log('\n=== source wiring ===');
check('nw() includes a fund term', /const nw=u=>Math\.round\(\(u\.cash\+pv\(u\)\+sPnl\(u\)\+shortCollateral\(u\)\+fundValue\(u\)\)/.test(src));
check('fundValue marks units at the live NAV', /const fundValue=[\s\S]{0,300}currentFundNav\(f\)\*pos\.units/.test(src));
check('fundValue guards a missing fund', /const fundValue=[\s\S]{0,300}return f\?/.test(src));
check('fundValue guards a zero/absent unit count', /const fundValue=[\s\S]{0,300}!\(pos\.units>0\)/.test(src));
// Whatever renders the leaderboard must use the same nw(), not its own sum.
check('the leaderboard ranks on nw()', /function renderLeaderboard[\s\S]{0,3000}nw\(/.test(src));

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
