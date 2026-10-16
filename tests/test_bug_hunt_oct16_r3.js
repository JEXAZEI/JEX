// Regression checks for the third bug hunt (what was left after round two).
// Behaviour where the function runs on its own; the source text where it
// needs the whole page.
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
const loadConst=name=>eval(extractConst(name).replace('const ','global.'));
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

global.DB={session:{starting_cash:10000}};

// ── ties share a place ──
{
  const tieRanks=load('tieRanks');
  const r=tieRanks([12000,11000,11000,10500.004,10500]);
  check('equal net worth shares a place: 1, 2, 2, 4, 4',r.join(',')==='1,2,2,4,4',r.join(','));
  check('an empty board ranks nothing',tieRanks([]).length===0);
  loadConst('byNwThenName');
  const rows=[{name:'Zed',nw:5},{name:'Ann',nw:5},{name:'Bo',nw:9}].sort(byNwThenName('nw'));
  check('level students are listed by name, the same on every screen',rows.map(x=>x.name).join(',')==='Bo,Ann,Zed');
}
for(const [what,re] of [
  ['the live leaderboard',/lb-rank \$\{rc\(lbRanks\[i\]-1\)\}">#\$\{lbRanks\[i\]\}/],
  ['the Balances table',/#\$\{rk\}<\/td>/],
  ['the graded CSV',/\[balRanks\[i\],r\.name/],
  ['the PDF report',/'#'\+pdfRanks\[i\]/],
  ['Sheets',/rows\.forEach\(\(r,i\)=>\{r\.rank=sheetRanks\[i\];\}\)/],
])check(what+' ranks ties together',re.test(src));

// ── each student measured from what they started with ──
{
  loadConst('startingCash');loadConst('startFor');
  DB.startCash={a:600,z:0};
  check('an account approved with $600 is measured from $600',startFor({id:'a'})===600);
  check('an account approved with $0 is measured from $0, not the setting',startFor({id:'z'})===0);
  check('an account with nothing recorded uses the session setting',startFor({id:'b'})===10000);
  DB.startCash=undefined;
  check('before the SQL runs, everyone uses the session setting',startFor({id:'a'})===10000);
}
check('the column is fetched on its own, so a missing column cannot break the page',
  /sb\.get\('jex_users','select=id,starting_cash'\)\.then\(\s*r=>[\s\S]{0,120},\s*\(\)=>\(\{\}\)\)/.test(src)
  &&!/JEX_USERS_SAFE_SELECT = '[^']*starting_cash/.test(src));
check('a student approved now is measured from what they were approved with',/\(DB\.startCash\|\|\(DB\.startCash=\{\}\)\)\[u\.id\]=startCash;/.test(src));

// ── capital raised counts all history, not the last 200 prints ──
{
  global.safeRpc=async()=>null;global.render=()=>{};global._capRaisedAt=Date.now();
  global.getCo=t=>({ticker:t,is_index_fund:t==='JXI'});
  global.refreshCapitalRaised=()=>{};
  const capitalRaisedFor=load('capitalRaisedFor');
  DB.trades=[{id:'502',ticker:'ACME',seller_id:'exchange',price:10,qty:2},
             {id:'500',ticker:'ACME',seller_id:'exchange',price:10,qty:1},
             {id:'501',ticker:'ACME',seller_id:'s1',price:12,qty:1},
             {id:'503',ticker:'JXI',seller_id:'exchange',price:50,qty:1}];
  DB.capitalRaised=null;
  check('without the server total it falls back to the visible prints',capitalRaisedFor(['ACME'])===30);
  DB.capitalRaised={max_id:500,by_ticker:{ACME:4000,JXI:900,GONE:100}};
  check('server total plus only the prints after it -- nothing counted twice',capitalRaisedFor(['ACME'])===4020,capitalRaisedFor(['ACME']));
  check('the exchange-wide figure leaves the index out and keeps delisted companies',capitalRaisedFor(null)===4120,capitalRaisedFor(null));
  DB.capitalRaised={max_id:null,by_ticker:{}};
  check('an empty trade table on the server counts every print here',capitalRaisedFor(['ACME'])===30);
  DB.capitalRaised={max_id:'abc',by_ticker:{ACME:4000}};
  check('an id it cannot compare takes the server figure alone',capitalRaisedFor(['ACME'])===4000);
}
check('the company page and the overview both use it',
  /const capitalRaised=capitalRaisedFor\(allTickers\);/.test(src)&&/const totalCapitalRaised=capitalRaisedFor\(null\);/.test(src));

// ── one vote deadline rule: ISO or created_at + 24h ──
{
  global.VOTE_WINDOW_MS=24*3600*1000;
  const voteDeadline=load('voteDeadline');
  const created='2026-10-15T10:00:00Z',plus24=Date.parse(created)+VOTE_WINDOW_MS;
  check('an ISO closes_at is the deadline',voteDeadline({closes_at:'2026-10-20T12:00:00Z',created_at:created})===Date.parse('2026-10-20T12:00:00Z'));
  check('free text the browser can parse ("October 20") is not a deadline',voteDeadline({closes_at:'October 20',created_at:created})===plus24);
  check('"2026-10-20 15:00" is not a deadline either, as on the server',voteDeadline({closes_at:'2026-10-20 15:00',created_at:created})===plus24);
}
check('Close vote is offered only while the vote is open by its deadline',/\+\(openNow\?'<button class="btn btn-sm btn-warning" onclick="closeVote/.test(src));

// ── officers can moderate, through their own functions ──
{
  global.isAdmin=u=>['chairman','secretary'].includes(u?.role);
  global.isFounder=()=>false;
  let me={id:'chair',role:'chairman'};global.cu=()=>me;
  global.canManageCompany=load('canManageCompany');
  global.canModerateCompany=load('canModerateCompany');
  loadConst('moderationRpc');
  const co={ticker:'ACME',owner_id:'co1'};
  check('an officer can remove a company\'s news or vote',canModerateCompany(co));
  check('...through the officer function',moderationRpc(co,'rpc_delete_news','rpc_admin_delete_news')==='rpc_admin_delete_news');
  me={id:'co1',role:'company'};
  check('the company itself still uses its own function',moderationRpc(co,'rpc_delete_news','rpc_admin_delete_news')==='rpc_delete_news');
  me={id:'s9',role:'student'};
  check('a student who is neither cannot',!canModerateCompany(co));
}
for(const fn of ['rpc_admin_delete_news','rpc_admin_close_vote','rpc_admin_delete_vote'])
  check('app calls '+fn,src.includes("'"+fn+"'"));

// ── short preview shows the fill the sale will get ──
{
  global.fmt=n=>'$'+Number(n).toFixed(2);
  global.bandClamp=(t,p)=>p;global.borrowable=()=>null;
  loadConst('impactPrice');
  const html=load('shortPrev')({ticker:'ACME',price:10,shares:1000},55);
  check('short 55 of a $10 stock previews the impacted ~$9.84, not $10',/Short 55 @ ~\$9\.84/.test(html),html);
}

// ── pages built around an account you do not have ──
check('an officer opening portfolio, orders or mystock by URL lands on Admin',
  /const allowed=t=>t==='portfolio'\|\|t==='orders'\?!isAdmin\(u\)\s*:t==='mystock'\?u\.role==='company'/.test(src)
  &&/if\(u&&!allowed\(UI\.navTab\)\)UI\.navTab=/.test(src));

// ── the label says what the column is ──
check('the holdings column that shows today\'s move is called Today, not P&L',/<th>Value<\/th><th title="[^"]*">Today<\/th>/.test(src));

console.log(fails?fails+' FAILED':'all passed');
process.exit(fails?1:0);
