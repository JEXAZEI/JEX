// What a dividend actually costs, before the button is pressed.
//
// Three decisions are made from the client's preview total, all of them BEFORE
// rpc_pay_dividend is ever called:
//
//   * "No shareholders yet"      -- refuses outright
//   * "Insufficient funds (need X)" -- refuses outright
//   * whether it crosses the Treasurer approval threshold
//
// So the preview has to agree with the server, and it did not. Two gaps, both
// read straight out of the deployed rpc_pay_dividend source:
//
// 1. The server pays the index funds too. JXI and every classroom index hold
//    real shares of their constituents in fund_holdings, and the RPC passes
//    that slice through to the fund's unit-holders:
//
//        fund_payout = fund_shares * per_share * (eligible_units / total_units)
//
//    The client counted only direct shareholders. Since the index holds shares
//    of every listed company, that understated the cost of essentially every
//    dividend -- so one could read as under the threshold here and be refused
//    by the server for being over it, after the student clicked pay. And a
//    company held ONLY through the index has no direct shareholders at all, so
//    "No shareholders yet" blocked a dividend the server would have paid.
//
// 2. The server rounds once per holder, on their total across every share
//    class. The client rounded per ticker and then summed, which is a
//    different number for a multi-class company -- cents, but cents either
//    side of a threshold.
//
// eligible_units counts approved students only, exactly like the direct loop:
// units held by anyone else are not paid, and the company is not charged for
// them. That asymmetry is deliberate server-side and is mirrored here.
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
eval(grabFn('dividendPassThrough').replace('function dividendPassThrough','global.dividendPassThrough=function'));

const stu=(id,holdings,extra)=>Object.assign({id,name:id,role:'student',status:'approved',holdings},extra||{});
const setup=(fundHoldings,fundUnits,users)=>{
  global.DB={users,companies:[
    {ticker:'JXI',is_index_fund:true,shares:fundUnits,fund_holdings:fundHoldings},
    {ticker:'ACME',is_index_fund:false,shares:1000,price:10}]};
};

// ── the case that was missing entirely ──
// JXI holds 100 ACME. 100 units outstanding, all held by approved students.
// At $0.50/share the fund's slice is 100 * 0.50 * (100/100) = 50.00.
setup({ACME:100},100,[stu('a',{JXI:60}),stu('b',{JXI:40})]);
let r=dividendPassThrough('ACME',0.5);
check('the index fund\'s shares are paid too', r.total===50, String(r.total));
check('...and reported per fund', r.cuts.length===1&&r.cuts[0].ticker==='JXI',
      JSON.stringify(r.cuts));

// Only 60 of 100 units are held by approved students, so only 60% is paid --
// and the company is only charged for that 60%.
setup({ACME:100},100,[stu('a',{JXI:60})]);
r=dividendPassThrough('ACME',0.5);
check('unheld units are not paid for', r.total===30, String(r.total));

// A unit-holder who is not an approved student is not eligible, same as the
// direct loop.
setup({ACME:100},100,[stu('a',{JXI:50}),
                      stu('b',{JXI:50},{status:'pending'}),
                      stu('c',{JXI:0})]);
r=dividendPassThrough('ACME',0.5);
check('a pending student is not eligible', r.total===25, String(r.total));
setup({ACME:100},100,[stu('a',{JXI:50}),
                      Object.assign(stu('co',{JXI:50}),{role:'company'})]);
r=dividendPassThrough('ACME',0.5);
check('a company account holding units is not eligible either', r.total===25, String(r.total));

// ── the shapes that must contribute nothing ──
setup({BETA:100},100,[stu('a',{JXI:100})]);
check('a fund holding a different company pays nothing',
      dividendPassThrough('ACME',0.5).total===0);
setup({},100,[stu('a',{JXI:100})]);
check('a fund holding nothing pays nothing',
      dividendPassThrough('ACME',0.5).total===0);
setup({ACME:100},0,[stu('a',{JXI:100})]);
check('a fund with no units outstanding pays nothing, not Infinity',
      dividendPassThrough('ACME',0.5).total===0);
setup({ACME:100},100,[stu('a',{JXI:0})]);
check('a fund whose units nobody holds pays nothing',
      dividendPassThrough('ACME',0.5).total===0);
setup({ACME:100},100,[]);
check('no users at all does not throw',
      dividendPassThrough('ACME',0.5).total===0);

// Nulls the schema permits.
global.DB={users:[{id:'x',role:'student',status:'approved',holdings:null}],
           companies:[{ticker:'JXI',is_index_fund:true,shares:100,fund_holdings:null},
                      {ticker:'CBX',is_index_fund:true,shares:null,fund_holdings:{ACME:5}}]};
check('null fund_holdings and null holdings do not throw',
      dividendPassThrough('ACME',0.5).total===0);
global.DB={users:[],companies:[]};
check('an empty exchange does not throw', dividendPassThrough('ACME',0.5).total===0);

// ── more than one index ──
// A classroom index and JXI can both hold the same company.
global.DB={users:[stu('a',{JXI:100,CBX:50})],companies:[
  {ticker:'JXI',is_index_fund:true,shares:100,fund_holdings:{ACME:100}},
  {ticker:'CBX',is_index_fund:true,shares:50,fund_holdings:{ACME:40}},
  {ticker:'ACME',is_index_fund:false,shares:1000}]};
r=dividendPassThrough('ACME',0.5);
check('every index that holds the stock pays through', r.cuts.length===2, JSON.stringify(r.cuts));
check('...and the totals add up', r.total===70, String(r.total));   // 50 + 20

// ── rounding matches the server: two decimals, per fund ──
setup({ACME:3},7,[stu('a',{JXI:7})]);
r=dividendPassThrough('ACME',0.333);
check('the payout is rounded to cents', r.total===Math.round(r.total*100)/100, String(r.total));
check('...to the value the server computes', r.total===1, String(r.total));  // 3*0.333*1 = 0.999

// ── and the caller uses it ──
check('issueDividend adds the pass-through to its total',
      /const pass=dividendPassThrough\(ticker,perShare\);[\s\S]{0,200}?directTotal\+pass\.total/.test(src));
check('...and refuses on the combined total, like the server',
      /if\(total<=0\)return toast\('No shareholders yet'\)/.test(src));
check('...and no longer refuses just because nobody holds it directly',
      !/if\(!sh\.length\)return toast\('No shareholders yet'\)/.test(src));
check('the direct half rounds once per holder, not once per ticker',
      /const shares=allT\.reduce[\s\S]{0,120}?Math\.round\(shares\*perShare\*100\)\/100/.test(src));

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll dividend-total checks passed.'));
process.exit(fails?1:0);
