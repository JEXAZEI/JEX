// Regression checks for the October 14 bug hunt. Each block names what was
// wrong; the functions run are the real ones pulled out of app.js.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
function extractFn(name){
  const start=src.indexOf('function '+name+'(');
  if(start<0)throw new Error('no function '+name);
  let i=src.indexOf('{',start),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--; if(d===0)return src.slice(start,i+1);} }
}
function extractConst(name){
  const start=src.indexOf('const '+name+'=');
  if(start<0)throw new Error('no const '+name);
  let i=start,d=0;
  for(;i<src.length;i++){const ch=src[i];
    if('{(['.includes(ch))d++; else if('})]'.includes(ch))d--;
    else if(ch===';'&&d===0)return src.slice(start,i+1);}
}
const load=name=>eval('('+extractFn(name)+')');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// shared stubs
global.esc=eval('('+extractConst('esc').replace(/^const esc=/,'').replace(/;$/,'')+')');
global.fmt=n=>'$'+Number(n).toFixed(2);
global.DB={};global.UI={};

// ── votes: ballots are 'A'/'B' with voting_power ──
// The admin oversight and the company "Vote results" read option1/option2
// and weight, so every tally read 0.
global.getVoteResults=load('getVoteResults');
global.isVoteOpen=v=>v.status==='open';
global.getCo=t=>(DB.companies||[]).find(c=>c.ticker===t);
DB.companies=[{ticker:'ACME',name:'Acme'}];
DB.votes=[{id:'v1',parent_ticker:'ACME',question:'Go?',option_a:'Yes',option_b:'No',status:'closed',ts:'Oct 14'}];
DB.ballots=[{vote_id:'v1',choice:'A',voting_power:60},{vote_id:'v1',choice:'B',voting_power:40}];
{
  const html=load('renderAdminVoteOversight')();
  check('admin vote oversight shows the real tally',/Yes: <strong>60<\/strong> votes \(60%\)/.test(html)&&/No: <strong>40<\/strong> votes \(40%\)/.test(html),html.replace(/\s+/g,' ').slice(0,400));
}

// ── Treasurer cash flow: newest first, and the company name escaped ──
{
  global.cu=()=>({id:'t'});
  DB.dividends=[
    {ts:'Oct 9, 2:00:00 PM',created_at:'2026-10-09T21:00:00Z',company_name:'<img src=x onerror=alert(1)>',total:10,per_share:1,payouts:null},
    {ts:'Oct 14, 9:00:00 AM',created_at:'2026-10-14T16:00:00Z',company_name:'Acme',total:20,per_share:2,payouts:[{}]},
  ];
  DB.buybacks=[{ts:'Oct 13, 1:00:00 PM',created_at:'2026-10-13T20:00:00Z',ticker:'ACME',total:5,qty:1,price:5}];
  DB.users=[];DB.trades=[];DB.companies=[{ticker:'ACME',name:'Acme',status:'listed'}];
  global.getUser=id=>DB.users.find(u=>u.id===id);
  let html='';
  try{html=load('renderTreasurerCashFlow')();}catch(e){html='THREW '+e.message;}
  check('cash flow survives a dividend with no payouts list',!/^THREW/.test(html),html);
  check('cash flow escapes the company name',!/<img src=x/.test(html));
  const order=[...html.matchAll(/<td style="color:var\(--text2\)">([^<]+)<\/td>/g)].map(m=>m[1]);
  check('cash flow is newest first',order.join('|')==='Oct 14, 9:00:00 AM|Oct 13, 1:00:00 PM|Oct 9, 2:00:00 PM',order.join('|'));
}

// ── CSV export keeps zeros ──
{
  let out='';
  global.Blob=function(parts){out=parts.join('');};
  global.URL={createObjectURL:()=>'blob:'};
  global.document={createElement:()=>({click(){}})};
  global.neutralizeFormula=load('neutralizeFormula');
  load('exportCSV')('x.csv',[{name:'Ana',cash:0,nw:950}],['name','cash','nw']);
  check('a 0 in a CSV cell is written as 0',out.split('\n')[1]==='Ana,0,950',out);
}

// ── push notification body ──
// /[^-\x7F]/ deleted everything except hyphens: "Stop-loss ..." became "-".
{
  const line=src.match(/body:body\.replace\((\/[^,]+\/gu?),''\)/);
  const re=line&&eval(line[1]);
  const body=re&&'🛑 Stop-loss triggered: sold 5×ACME @ $9.50'.replace(re,'').trim();
  check('push body keeps the message text',body==='Stop-loss triggered: sold 5×ACME @ $9.50',body);
}

// ── a cover is clamped at the band ceiling, not refused ──
{
  global.bandLimits=()=>({upper:39,lower:21,open:30,pct:30});
  global.bandClamp=load('bandClamp');
  eval(extractConst('impactPrice').replace('const ','global.'));
  global.impactPreview=load('impactPreview');
  const co={ticker:'ACME',price:38.5,shares:2000};
  check('cover fill price is held at the ceiling',impactPrice(co,400,'cover')===39);
  const html=impactPreview(co,400,'cover');
  check('cover preview does not say "refused"',!/refused/.test(html)&&/held at the \$39\.00 ceiling/.test(html),html);
  check('a plain buy still warns it would be refused',/refused/.test(impactPreview(co,400,'buy')));
}

// ── hidden test accounts are not labelled "Index funds" ──
{
  global.holdings=u=>u.holdings||{};
  global.isHiddenTestEntity=id=>id==='test';
  DB.users=[{id:'s1',name:'S',role:'student',holdings:{ACME:10}},{id:'test',name:'T',role:'student',holdings:{ACME:40}}];
  DB.funds=[];
  DB.companies=[{ticker:'ACME',shares:100,shares_avail:50}];
  const map=load('buildShareholderMap')(['ACME']);
  check('no phantom index row for a hidden account\'s shares',!map.index_ACME,JSON.stringify(map));
}

// ── realtime reads the wire shape ──
{
  check('realtime reads record/old_record/type from the raw socket',
    /d\.record\|\|d\.new/.test(src)&&/d\.old_record\|\|d\.old/.test(src)&&/d\.type\|\|d\.eventType/.test(src));
}

// ── autoRefresh keeps DB.trades newest-first ──
check('new trades are merged as one batch, order kept',
  /DB\.trades\.unshift\(\.\.\.newTrades\.filter\(t=>!existingIds\.has\(t\.id\)\)\)/.test(src));

// ── the student PDF lists the newest 50 ──
check('student PDF does not reverse the newest-first trade list',
  !/const myTrades=DB\.trades\.filter\(t=>t\.buyer_id===u\.id\|\|t\.seller_id===u\.id\)\.reverse\(\)/.test(src));

// ── trade buttons hold while the order is in flight ──
for(const fn of ['placeSell','placeShort','coverShort','fundBuy','fundSell','fundShort','fundCoverShort']){
  const bare=new RegExp('onclick="'+fn+'\\(');
  check(fn+' is never wired without busy()',!bare.test(src));
}

// ── company logo is escaped in every <img> ──
check('every logo <img> escapes its src',!/<img src="\$\{c?o?\.logo\}"/.test(src)&&!/<img src="\$\{c\.logo\}"/.test(src));

console.log(fails?fails+' FAILED':'all passed');
process.exit(fails?1:0);
