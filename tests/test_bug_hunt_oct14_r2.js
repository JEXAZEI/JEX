// Regression checks for the second October 14 bug hunt. Behaviour where the
// function can run on its own; the source text where it needs the whole page.
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

// ── one row per id, whichever of realtime and the RPC lands first ──
{
  global._stateEpoch=0;
  const upsertById=load('upsertById');
  const list=[{id:'d1',total:50,from:'realtime'}];
  upsertById(list,{id:'d1',total:50,payouts:[1]});
  check('a dividend realtime already delivered is not stored twice',list.length===1&&list[0].payouts&&list[0].payouts.length===1,JSON.stringify(list));
  const orders=[];const mine=upsertById(orders,{id:'o1',status:'open'});
  upsertById(orders,{id:'o1',status:'cancelled'});
  check('a limit order is one row, and its status follows the latest copy',orders.length===1&&mine.status==='cancelled');
  const classes=[{ticker:'ACME.B'}];upsertById(classes,{ticker:'ACME.B',ratio:5},false,'ticker');
  check('share classes merge by ticker',classes.length===1&&classes[0].ratio===5);
}
for(const [what,re] of [
  ['the Treasurer-approved dividend',/upsertById\(DB\.dividends,\{id:r\.dividend_id,ticker:da\.ticker/],
  ['the direct dividend',/upsertById\(DB\.dividends,\{id:r\.dividend_id,ticker,/],
  ['a new limit order',/r\.order=upsertById\(DB\.limitOrders,r\.order\)/],
  ['a buyback tender',/upsertById\(DB\.limitOrders,r\.tender\)/],
])check(what+' goes through upsertById',re.test(src));
check('no dividend or limit order is pushed raw any more',
  !/DB\.dividends\.push\(\{id:r\.dividend_id/.test(src)&&!/DB\.limitOrders\.push\(r\.(order|tender)\)/.test(src));

// ── the realtime socket does not reconnect itself in a loop ──
check('unsubscribing detaches the old socket before closing it',
  /unsubscribe:\(\)=>\{ws\.onclose=ws\.onerror=ws\.onmessage=ws\.onopen=null;clearInterval\(heartbeatInterval\);ws\.close\(\);\}/.test(src));
check('logout closes the live feed',/function logout\(\)\{[\s\S]{0,400}_realtimeChannels\.forEach\(ch=>\{try\{ch\.unsubscribe\(\);\}catch\(e\)\{\}\}\);_realtimeChannels=\[\];_rtJoined=false;/.test(src));
check('logout drops other people\'s emails',/function logout\(\)\{[\s\S]{0,600}delete u\.email;/.test(src));

// ── polls do not put older reads over newer state ──
check('autoRefresh runs one sweep at a time',/if\(_refreshInFlight\)return;/.test(src)&&/finally\{_refreshInFlight=false;\}/.test(src));
check('autoRefresh replaces companies/session/orders only when nothing newer arrived',
  /const quiet=_stateEpoch===epochBefore;/.test(src)&&/if\(quiet\)DB\.limitOrders=newLimitOrders;/.test(src));
check('sessionAutoTick decides open/close at apply time',
  !/if\(!UI\.userId\)return;\n  const wasOpen=DB\.session\.status==='open';\n  let r;/.test(src)&&/if\(_stateEpoch!==epochBefore\)return;/.test(src));

// ── graded numbers use the graded mark everywhere ──
check('the frozen leaderboard at the close ranks on nwMark',/const lbSnap2=lbStudents\.map\(s=>\(\{name:s\.name,nw:nwMark\(s\)/.test(src));
check('the PDF report ranks on nwMark',/map\(u=>\(\{\.\.\.u,_nw:nwMark\(u\),_divs:divRec\(u\)\}\)\)/.test(src));
check('the balances CSV export is marked',/portfolio:Math\.round\(pvMark\(u\)\*100\)\/100,net_worth:nwMark\(u\)/.test(src));
check('Sheets gets the marked net worth',/nw:nwMark\(u\),vsStart:Math\.round\(\(nwMark\(u\)-startingCash\(\)\)/.test(src));
check('the live leaderboard row shows the marked portfolio',/'Cash '\+fmt\(u\.cash\)\+' \| Portfolio '\+fmt\(pvMark\(u\)\)/.test(src));

// ── the dividend preview charges what the payment charges ──
check('the dividend preview uses dividendCost',/const total=dividendCost\(ticker,Math\.round\(ps\*100\)\/100,/.test(src));

// ── fill price rounded like Postgres numeric ──
{
  global.bandClamp=(t,p)=>p;
  eval(extractConst('impactPrice').replace('const ','global.'));
  const p=impactPrice({ticker:'X',price:10,shares:1000},55,'buy');
  check('a $10.165 fill rounds to $10.17, as the server does',p===10.17,p);
}

// ── Max short and the margin line, to the cent ──
{
  const maxShortQty=load('maxShortQty');
  check('$3.03 collateralises two shares at $1.01',maxShortQty(1.01,3.03)===2,maxShortQty(1.01,3.03));
  check('...and never one the trade would refuse',(()=>{for(let c=1;c<500;c+=0.37){c=Math.round(c*100)/100;for(const pr of [1.01,2.33,7.77,13.1]){const q=maxShortQty(pr,c);if(Math.round(pr*q*1.5*100)/100>c||Math.round(pr*(q+1)*1.5*100)/100<=c-1e-9)return false;}}return true;})());
  global.MARGIN_CALL_AT=0.8;
  const line=load('shortMarginLine')({qty:3,avgPrice:10,collateral:45.05});
  check('the margin line is the first cent that crosses',line===22.02,line);
}

// ── a closed fund can still wind down ──
check('fundSell allows a closed fund',/async function fundSell\([\s\S]{0,600}f\.status!=='active'&&f\.status!=='closed'/.test(src));
check('fundCoverShort allows a closed fund',/async function fundCoverShort\([\s\S]{0,600}f\.status!=='active'&&f\.status!=='closed'/.test(src));
check('a closed fund holding positions gets a wind-down panel',/isManager&&f\.status==='closed'/.test(src));

// ── the buyback preview lifts what the server lifts ──
check('the buyback preview skips insiders and out-of-band asks, and caps by cash',
  /const insider=id=>/.test(src)&&/o\.limit_price>band\.upper/.test(src)&&/Math\.floor\(\(cashFor-spend\)\/a\.limit_price\+1e-9\)/.test(src));

// ── UI flows with awkward data ──
{
  const userInitials=load('userInitials');
  const i=userInitials('🚀🚀 Rocket Co');
  check('initials never split an emoji in half',!/[\ud800-\udbff](?![\udc00-\udfff])/.test(i)&&i==='🚀R',JSON.stringify(i));
  const wholeQty=load('wholeQty');
  check('whole shares only: 1.5, 2.9, -5, 0 and blank are refused',[ '1.5','2.9','-5','0','',null,'abc'].every(v=>wholeQty(v)===0));
  check('...and 1e3 is the thousand it says, 12 is 12',wholeQty('1e3')===1000&&wholeQty(' 12 ')===12&&wholeQty(7)===7);
}
check('no trade handler parses its quantity with parseInt',!/qty=parseInt\(qty\)/.test(src));
check('officers are not shown news Delete the server refuses',!/const canDelete=isAdmin\(u\);/.test(src));
check('vote Close/Delete only for the company\'s owner or founders',/\(isOwner\|\|isAdminUser\)&&\(c=>c&&canManageCompany\(c\)\)\(getCo\(v\.parent_ticker\)\)/.test(src));
check('co-founders are not shown a financials form the server refuses',/function renderFinancialsMgmtTab\(co,myFinancials\)\{[\s\S]{0,200}cu\(\)\?\.id!==co\.owner_id/.test(src));
check('Back and Forward follow the company page',/addEventListener\('popstate'/.test(src));
check('a typed dividend survives the shareholder fetch',/const typed=\['div-ps','div-note'\]/.test(src));
check('a long announcement wraps instead of widening the page',/<span style="min-width:0;overflow-wrap:anywhere">📢/.test(src));

console.log(fails?fails+' FAILED':'all passed');
process.exit(fails?1:0);
