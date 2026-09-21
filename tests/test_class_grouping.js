// A company's tickers belong together in the market list.
//
// A share class is its own jex_companies row: ACME.B is a separate listing
// from ACME, with its own price, float, chart and shareholders. The market
// table sorted on nothing but "index fund first" and let everything else keep
// creation order -- so a class landed wherever it was approved. A company that
// added a Class B in week six appeared at the BOTTOM of the table, several
// unrelated companies away from its own base stock, and nothing on either row
// said the two were the same business.
//
// It looked coherent only by accident, when a class happened to be created
// immediately after its parent. That is the "sometimes that does not happen"
// this fixes.
//
// The rule: a family keeps the seat of its base stock, so the table's order is
// unchanged for any company WITHOUT share classes. Inside a family the base
// stock comes first and its classes follow in letter order. An index fund
// stays pinned to the very top.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

function grabConst(name){
  const m=new RegExp('(?:^|;)const '+name+'=','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  const start=m.index+(m[0].startsWith(';')?1:0);
  let d=0;
  for(let i=start;i<src.length;i++){
    const ch=src[i];
    if(ch==='('||ch==='{'||ch==='[')d++;
    else if(ch===')'||ch==='}'||ch===']')d--;
    else if(ch===';'&&d===0)return src.slice(start,i+1);
  }
  throw new Error('unterminated: '+name);
}
function grabFn(name){
  const m=new RegExp('^function '+name+'\\(','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(m.index,i+1);} }
  throw new Error('unterminated: '+name);
}

global.DB={shareClasses:[],companies:[]};
global.getClassMeta=t=>DB.shareClasses.find(c=>c.ticker===t)||null;
eval(grabConst('classParentOf').replace(/^const /,'global.'));
eval(grabConst('familyOf').replace(/^const /,'global.'));
eval(grabConst('classRank').replace(/^const /,'global.'));
eval(grabFn('groupByCompany').replace(/^function /,'global.groupByCompany=function '));

const co=(ticker,isIndex)=>({ticker,is_index_fund:!!isIndex});
const cls=(ticker,parent,letter,ratio)=>{
  DB.shareClasses.push({ticker,parent_ticker:parent,class:letter,conversion_ratio:ratio==null?1:ratio});
  return co(ticker);
};
const order=list=>groupByCompany(list).map(c=>c.ticker).join(' ');

// ── the measured case: a class approved long after its parent ──
DB.shareClasses=[];
let market=[co('JXI',true),co('ACME'),co('BETA'),co('GAMA'),co('DELT'),cls('ACME.B','ACME','B')];
check('before: the class was created last, so it sorted last',
      market.map(c=>c.ticker).join(' ')==='JXI ACME BETA GAMA DELT ACME.B');
check('after: it sits directly under its parent',
      order(market)==='JXI ACME ACME.B BETA GAMA DELT', order(market));

// ── companies without classes do not move ──
DB.shareClasses=[];
market=[co('JXI',true),co('ACME'),co('BETA'),co('GAMA')];
check('a table with no share classes is left exactly as it was',
      order(market)==='JXI ACME BETA GAMA', order(market));

// ── several classes, several companies ──
DB.shareClasses=[];
market=[co('JXI',true),co('ACME'),co('BETA'),co('GAMA'),
        cls('BETA.C','BETA','C'),cls('ACME.B','ACME','B'),cls('BETA.A','BETA','A'),cls('ACME.C','ACME','C')];
check('each family gathers under its own parent, classes in letter order',
      order(market)==='JXI ACME ACME.B ACME.C BETA BETA.A BETA.C GAMA', order(market));

// ── the index stays pinned even when created late ──
DB.shareClasses=[];
market=[co('ACME'),cls('ACME.B','ACME','B'),co('BETA'),co('JXI',true)];
check('an index fund created last still pins to the top',
      order(market)==='JXI ACME ACME.B BETA', order(market));

// ── a class whose parent is filtered out keeps its seat ──
//
// Search, a delisting, or a restricted parent can all remove the base stock
// from the list while a class remains. It should not be flung to one end.
DB.shareClasses=[];
market=[co('JXI',true),co('ACME'),cls('BETA.B','BETA','B'),co('GAMA')];
check('an orphaned class sorts where it is, not at an extreme',
      order(market)==='JXI ACME BETA.B GAMA', order(market));

// ── degenerate shapes ──
DB.shareClasses=[];
check('an empty market does not throw', order([])==='');
check('a single company is itself', order([co('ACME')])==='ACME');
DB.shareClasses=[];
market=[cls('ACME.B','ACME','B'),co('ACME')];
check('a class listed before its parent still puts the parent first',
      order(market)==='ACME ACME.B', order(market));
DB.shareClasses=[{ticker:'ACME',parent_ticker:'ACME',class:'A',conversion_ratio:1}];
check('a class row pointing at itself is treated as a base stock, not a child',
      classParentOf(co('ACME'))===null);
DB.shareClasses=[{ticker:'ACME.X',parent_ticker:'ACME',conversion_ratio:1}];
check('a class with no letter recorded sorts after lettered ones, not before',
      classRank(co('ACME.X'))==='￿');
check('...and the base stock always outranks every class', ''<'A'&&''<'￿');

// sorting must not mutate the caller's array
DB.shareClasses=[];
const original=[co('BETA'),co('ACME')];
const snapshot=original.map(c=>c.ticker).join(' ');
groupByCompany(original);
check('grouping does not reorder the array it was handed',
      original.map(c=>c.ticker).join(' ')===snapshot);

// ── search pulls in the whole family ──
check('searching a company name matches its family, not just the literal row',
      /const hitFamilies=new Set\(visible\.filter\(matches\)\.map\(familyOf\)\);/.test(src));
check('...and the family filter is what the market list returns',
      /groupByCompany\(visible\.filter\(c=>hitFamilies\.has\(familyOf\(c\)\)\|\|matches\(c\)\)\)/.test(src));

// ── the row says why it is there ──
check('a class row names its parent ticker', /↳ share class of/.test(src));
check('...and is indented so the grouping is visible, not just implied',
      /parentTicker\?' style="padding-left:20px;border-left:2px solid var\(--border\)"':''/.test(src));
check('...and shows the conversion ratio, which is what makes it comparable',
      /converts 1 → \$\{ratio\}/.test(src));

// ── applied everywhere a company list is shown, not just one table ──
check('the market table groups', /return groupByCompany\(visible\.filter/.test(src));
check('the scrolling ticker bar groups', /groupByCompany\(DB\.companies\.filter\(c=>c\.status==='listed'&&canAccessTicker/.test(src));
check('the exchange stats table groups', /const listed=groupByCompany\(DB\.companies\.filter\(c=>c\.status==='listed'&&!isHiddenTestEntity/.test(src));
check('the shareholder registry groups', /const listed=groupByCompany\(DB\.companies\.filter\(c=>c\.status==='listed'\)\);/.test(src));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
