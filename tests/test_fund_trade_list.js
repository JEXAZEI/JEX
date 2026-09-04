// What a fund manager is offered in the "Trade on behalf of the fund" dropdown.
//
// Reported live: JXI sat in that dropdown. One <select> drives six buttons
// there -- Buy / Sell / Short / Cover and Limit buy / Limit sell -- and the two
// limit buttons cannot work on an index. placeLimitOrder refuses them
// client-side ("Limit orders aren't available for JXI yet") and
// rpc_place_limit_order refuses them server-side. Every other trade surface
// hides its limit row when the instrument is an index; a shared dropdown has no
// way to hide half of itself, so the index was listed alongside two buttons
// that were always going to be rejected.
//
// So index funds come out of the list -- EXCEPT when the fund already holds
// units or is short them. This dropdown is the fund's only sell/cover control
// (the Holdings table on the same page is display-only), so removing the row
// outright would strand the position with no way to close it. That is the same
// rule already applied to an index with no constituents: closed for opening,
// open for closing.
//
// Two other exclusions ride along and must not regress: the manager's own
// company (conflict of interest, refused by rpc_fund_buy) and restricted share
// classes the MANAGER is not whitelisted for -- the manager's access, not the
// viewer's, because that is whose whitelist the server checks.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// The filter lives inside renderFundDetail, which builds a page of HTML. Pull
// out the three lines that decide the list and run them directly -- rendering
// the whole page would need the DOM, and what is being pinned is the choice of
// rows, not the markup.
const m=/const fundShortQty=[\s\S]*?const tradable=DB\.companies\.filter\([\s\S]*?\);/.exec(src);
if(!m){console.log('FAIL: could not find the fund trade list filter');process.exit(1);}
const FILTER=m[0];

let FUND=null,COMPANIES=[],ACCESS=()=>true;
global.fundShorts=f=>f.shorts||{};
global.canAccessTicker=(t,uid)=>ACCESS(t,uid);
// Test companies are hidden from every list in the app unless dev mode is on.
let TEST_OWNERS=new Set();
global.isHiddenTestEntity=id=>TEST_OWNERS.has(id);
const listFor=(fund,companies,access)=>{
  FUND=fund;COMPANIES=companies;ACCESS=access||(()=>true);
  global.DB={companies:COMPANIES};
  const f=FUND;
  // The snippet declares `const tradable`, which lives in eval's own scope --
  // trailing it with a bare reference makes that the completion value.
  return eval(FILTER+';tradable').map(c=>c.ticker);
};

const co=(ticker,extra)=>Object.assign({ticker,name:ticker+' Inc',status:'listed',
  price:10,owner_id:'other',is_index_fund:false},extra||{});
const JXI=()=>co('JXI',{is_index_fund:true,name:'JEX Composite Index Fund',price:124.52});
const CLS=()=>co('CLS',{is_index_fund:true,index_classroom_id:'c1',name:'Period 3 Index'});
const fund=extra=>Object.assign({id:'f1',manager_id:'mgr',cash:5000,holdings:{},shorts:{}},extra||{});

// ── the report: an index the fund has nothing to do with is not offered ──
let out=listFor(fund(),[co('ACME'),JXI(),co('BOLT')]);
check('JXI is gone from a fund holding no units', !out.includes('JXI'), out.join(','));
check('...and the ordinary companies are all still there',
      out.join(',')==='ACME,BOLT', out.join(','));

// A classroom index is the same instrument with a different name.
out=listFor(fund(),[co('ACME'),CLS()]);
check('a classroom index is excluded too', !out.includes('CLS'), out.join(','));

// ── but a position the fund already has must stay closeable ──
out=listFor(fund({holdings:{JXI:12}}),[co('ACME'),JXI()]);
check('a fund holding units keeps the row so it can sell', out.includes('JXI'), out.join(','));

out=listFor(fund({shorts:{JXI:{qty:4,avgPrice:120}}}),[co('ACME'),JXI()]);
check('a fund short the index keeps the row so it can cover', out.includes('JXI'), out.join(','));

// A zeroed-out position is not a position. Both dicts keep the key around
// after the last unit is sold or the short is fully covered, so a plain
// `in`/truthiness test would have re-admitted the row forever.
out=listFor(fund({holdings:{JXI:0}}),[co('ACME'),JXI()]);
check('a fully sold holding does not keep the row', !out.includes('JXI'), out.join(','));
out=listFor(fund({shorts:{JXI:{qty:0,avgPrice:120}}}),[co('ACME'),JXI()]);
check('a fully covered short does not keep the row', !out.includes('JXI'), out.join(','));

// Holding one index does not re-admit a different one.
out=listFor(fund({holdings:{JXI:3}}),[JXI(),CLS()]);
check('holding JXI does not bring the classroom index back',
      out.join(',')==='JXI', out.join(','));

// ── the exclusions that were already there ──
out=listFor(fund(),[co('ACME'),co('MINE',{owner_id:'mgr'}),co('BOLT')]);
check("the manager's own company is still excluded", !out.includes('MINE'), out.join(','));

// A holding in your own company must NOT re-admit it -- that exclusion is a
// conflict-of-interest rule the server enforces on every side, not a
// can't-open-but-can-close rule like the index.
out=listFor(fund({holdings:{MINE:50}}),[co('ACME'),co('MINE',{owner_id:'mgr'})]);
check("...even when the fund somehow holds it", !out.includes('MINE'), out.join(','));

out=listFor(fund(),[co('ACME'),co('ACME.B')],(t)=>t!=='ACME.B');
check('a restricted class the manager cannot access is excluded',
      !out.includes('ACME.B'), out.join(','));

// The whitelist that matters is the MANAGER's, not the person looking at the
// page. Assert the argument actually passed, since both are user ids and a
// mix-up would look fine in every other check here.
let seen=[];
listFor(fund(),[co('ACME')],(t,uid)=>{seen.push(uid);return true;});
check('access is checked against the manager', seen.every(x=>x==='mgr'), seen.join(','));

// ── unlisted companies never appear ──
out=listFor(fund(),[co('ACME'),co('PEND',{status:'pending'}),co('DEAD',{status:'delisted'})]);
check('only listed companies are offered', out.join(',')==='ACME', out.join(','));

// ── nothing to trade is an empty list, not a crash ──
out=listFor(fund(),[JXI()]);
check('an exchange with only an index yields an empty list', out.length===0, out.join(','));
out=listFor(fund({holdings:null,shorts:null}),[co('ACME'),JXI()]);
check('a fund with null holdings/shorts does not throw', out.join(',')==='ACME', out.join(','));

// ── test companies are hidden here too ──
//
// Reported from a live screenshot: this dropdown was offering "TCO2 - Test
// Company 2". Sixteen other lists filter test accounts out -- the market
// table, the ticker bar, the index basket, the leaderboard, the funds list,
// news, votes, the shareholder registry -- and this was the only ticker list
// in the app that did not, so a test company showed up here and nowhere else.
TEST_OWNERS=new Set(['tester']);
out=listFor(fund(),[co('ACME'),co('TCO2',{owner_id:'tester'}),co('BOLT')]);
check('a test company is not offered', !out.includes('TCO2'), out.join(','));
check('...and the real ones still are', out.join(',')==='ACME,BOLT', out.join(','));

// Unlike the index rule, this exclusion is NOT relaxed by a holding. An index
// position is real money that has to stay closeable; a position in a test
// company is itself part of the test, and dev mode -- which is what makes test
// accounts visible everywhere else in the app -- brings it straight back.
out=listFor(fund({holdings:{TCO2:5}}),[co('ACME'),co('TCO2',{owner_id:'tester'})]);
check('holding a test company does not re-admit it', !out.includes('TCO2'), out.join(','));

// Dev mode is what makes test accounts visible everywhere else, and
// isHiddenTestEntity already encodes that, so nothing extra is needed here --
// with the flag off, they come back.
TEST_OWNERS=new Set();
out=listFor(fund(),[co('ACME'),co('TCO2',{owner_id:'tester'})]);
check('in dev mode a test company is offered again', out.includes('TCO2'), out.join(','));

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll fund trade-list checks passed.'));
process.exit(fails?1:0);
