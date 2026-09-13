// The ex-dividend drop -- the client half of it.
//
// A dividend moves cash out of a company and, until the server migration that
// goes with this file, did not touch the share price. That makes a dividend
// free money to anyone who is not a shareholder until just before it pays:
//
//     buy  ->  dividend pays  ->  sell straight back
//
// Measured against the real trade functions on a copy of production, a $5.00
// dividend handed the buyer $454 of $500, out of the paying owner's cash. And
// it is foreseeable -- every client fetches jex_dividend_approvals at boot, so
// a pending dividend's ticker and per-share amount sit in DB.divApprovals in
// every browser, and the dividends large enough to need approval are exactly
// the ones that go through that queue.
//
// The client half shipped on Sep 8 and then sat inert for five days, because
// the commit said "the server migrations follow once I have the deployed
// source" and that one was never sent. So this file pins the things that were
// wrong with the client half while nobody could see it run:
//
//   1. it stamped the word "ex-dividend" into price_history where a timestamp
//      goes, and computeIndex sorts that shared axis as strings
//   2. it never moved session_open_prices, which is what the day's percent
//      change and the trade ticket's band limits are measured from
//   3. the Treasurer-approved path did not apply the drop at all -- and those
//      are the biggest dividends in the app
//   4. the payable/threshold preview did not count student-run funds, which
//      the server now pays and charges the company for
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── wiring ──
check('the Treasurer-approved path applies the drop too',
      /const dropsA=applyExDividend\(r\)\?r\.new_prices:null;/.test(src),
      'the largest dividends in the app are the ones that go through that path');
check('the direct path applies the drop',
      /const drops=r\.new_prices\|\|null;\s*\n\s*applyExDividend\(r\);/.test(src));
check('the preview counts the student-run funds',
      /const fundCut=fundDividendCut\(allT,perShare\);/.test(src));
check('...and adds them into the total the decisions are made from',
      /directTotal\+pass\.total\+fundCut/.test(src),
      'otherwise a dividend looks payable here and is refused by the server');

// The stale comment that claimed the two halves disagreed about share classes.
check('no comment still claims the server ignores the conversion ratio',
      !/which the server does NOT do/.test(src));

// ── behaviour ──
const grab=name=>{
  const re=new RegExp('function '+name+'\\([\\s\\S]*?\\n\\}','m');
  const m=re.exec(src);
  if(!m)throw new Error('could not find '+name+' in app.js');
  return m[0];
};
global.DB={session:{session_open_prices:{ACME:30}},funds:[],companies:[]};
const companies={};
global.getCo=t=>companies[t]||null;
global.classRatio=t=>t==='ACME.B'?5:1;
eval(grab('applyExDividend').replace(/^function /,'global.applyExDividend=function '));
eval(grab('fundDividendCut').replace(/^function /,'global.fundDividendCut=function '));

// A server that has not run the migration returns no new_prices at all. The
// client must stay correct, and must say so rather than pretend it applied
// something.
check('an un-migrated server is a no-op, reported as false',
      applyExDividend({total:10})===false);
check('...and it did not invent a price', global.DB.session.session_open_prices.ACME===30);

companies['ACME']={ticker:'ACME',price:30,price_history:[{p:30,t:'2026-09-13T00:00:00.000Z'}]};
const applied=applyExDividend({new_prices:{ACME:29},session_open_prices:{ACME:29}});
check('a migrated server applies the drop', applied===true&&companies['ACME'].price===29,
      String(companies['ACME'].price));
check('the reference price moves with it', global.DB.session.session_open_prices.ACME===29,
      'the band and the day\'s percent change are both measured from it');

// The bug that made this worth its own check: computeIndex builds ONE time axis
// out of every constituent's stamps, sorts it as strings, and walks each
// history with `h[j+1].t <= t`. 'ex-dividend' sorts after every ISO date
// ('e' > '2'), so the label became a phantom final point on the axis and pulled
// every other constituent's cursor to its end to meet it.
const last=companies['ACME'].price_history[companies['ACME'].price_history.length-1];
check('the history point carries a real timestamp, not a label',
      !isNaN(Date.parse(last.t))&&last.t!=='ex-dividend', JSON.stringify(last));
check('...which still sorts after the point before it',
      last.t>companies['ACME'].price_history[0].t, JSON.stringify(last.t));

// A price of zero or below is not a price. The server floors at 0.01; the
// client must not accept a bad one and blank out a company.
companies['ZERO']={ticker:'ZERO',price:5,price_history:[]};
applyExDividend({new_prices:{ZERO:0}});
check('a zero price is refused rather than applied', companies['ZERO'].price===5);
applyExDividend({new_prices:{GONE:12}});
check('a price for a company this client does not have does not throw', true);

// ── what the funds are owed ──
global.DB.funds=[{holdings:{ACME:200}},{holdings:{ACME:0}},{holdings:{}},{}];
check('funds holding the stock are counted', fundDividendCut(['ACME'],1)===200,
      String(fundDividendCut(['ACME'],1)));
check('a fund with no holdings at all does not throw', fundDividendCut(['NOPE'],1)===0);
global.DB.funds=[{holdings:{'ACME.B':10}}];
check('a share class counts at its conversion ratio',
      fundDividendCut(['ACME','ACME.B'],1)===50, String(fundDividendCut(['ACME','ACME.B'],1)));
global.DB.funds=[{holdings:{ACME:7}},{holdings:{ACME:7}}];
check('each fund is rounded once, the way the server rounds it',
      fundDividendCut(['ACME'],0.125)===1.76, String(fundDividendCut(['ACME'],0.125)));
global.DB.funds=undefined;
check('no funds loaded yet does not throw', fundDividendCut(['ACME'],1)===0);

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
