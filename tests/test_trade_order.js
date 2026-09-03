// Which end of DB.trades a trade goes on, and which end the screens read from.
//
// DB.trades is newest-first everywhere it is filled from the server: the boot
// load is order=created_at.desc, the 20-second poll is order=id.desc, and the
// realtime handler unshifts. But every path that added a trade the CURRENT
// user had just made pushed it onto the END -- filing your own trade at the
// oldest position in the list.
//
// Two screens then read the wrong end:
//
//   * the company page's "Recent trades" reversed the list and took the first
//     30, so it showed that company's OLDEST 30 trades ever -- on the page a
//     student opens right after trading, looking for the trade they just made;
//
//   * the paginated Trade history reversed it too, putting the oldest trades of
//     the term on page 1. That one LOOKED right, because your own trades sat at
//     the tail and the reverse brought them back to the front -- two bugs
//     cancelling, until you reloaded and the server's correctly-ordered rows
//     came back interleaved with everyone else's.
//
// Realised P&L was never affected: calcPnLAttribution() sorts by id before
// walking, precisely because array order cannot be relied on. This suite pins
// the order anyway, because that sort is the only thing that was defending it.
//
// The tape on the Trades tab is also capped here. DB.trades starts at the last
// 200 rows but only grows while a tab is open -- the poll and the realtime feed
// both merge in every trade anyone on the exchange makes, and nothing trims it
// -- and that screen built one row per trade on every render, three seconds
// apart, all class long.
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
function grabConst(name){
  const m=new RegExp('^const '+name+'=.*$','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  return m[0];
}

const ME={id:'u1',name:'Ada',role:'student'};
global.cu=()=>ME;
global.getUser=id=>id===ME.id?ME:{id,name:'Someone'};
global.getCo=t=>(DB.companies||[]).find(c=>c.ticker===t)||null;
global.esc=s=>String(s);
global.fmt=n=>'$'+Number(n).toFixed(2);
global.UI={tradePage:0};
eval(grabConst('TRADE_TAPE_MAX').replace(/^const /,'global.'));
eval(grabConst('TRADES_PER_PAGE').replace(/^const /,'global.'));
eval(grabFn('recordLocalTrade').replace('function recordLocalTrade','global.recordLocalTrade=function'));
eval(grabFn('renderTrades').replace('function renderTrades','global.renderTrades=function'));
eval(grabFn('renderTradingHistory').replace('function renderTradingHistory','global.renderTradingHistory=function'));

// id N is the Nth trade ever; higher id = more recent. Newest first.
const trade=(id,extra)=>Object.assign({id,ts:'2026-08-25T12:00:'+String(id%60).padStart(2,'0')+'Z',
  ticker:'ACME',qty:1,price:10+id,buyer_id:'u1',seller_id:'exchange',type:'market'},extra||{});
const feed=n=>{const a=[];for(let i=n;i>=1;i--)a.push(trade(i));return a;};   // newest first

// ── a trade you just made goes to the front ──
global.DB={trades:feed(3),companies:[]};
recordLocalTrade(trade(4));
check('your own trade lands at the newest end', DB.trades[0].id===4, String(DB.trades[0].id));
check('...and the list stays newest-first',
      DB.trades.map(t=>t.id).join(',')==='4,3,2,1', DB.trades.map(t=>t.id).join(','));

// Realtime and the local apply can both deliver the same row.
recordLocalTrade(trade(4));
check('the same trade is not recorded twice', DB.trades.length===4, String(DB.trades.length));
check('...and nothing else moved', DB.trades.map(t=>t.id).join(',')==='4,3,2,1');

// Shapes that must not throw.
const before=DB.trades.length;
recordLocalTrade(null);recordLocalTrade(undefined);
check('a missing trade is ignored', DB.trades.length===before);

// ── "Recent trades" on a company page must be the recent ones ──
// The expression under test is the one line that builds that list; running it
// directly keeps this honest about which end it takes, without needing the
// whole company page's DOM.
const m=/const companyTrades=DB\.trades\.filter\(.*\);/.exec(src);
check('the company-page trade list is still one expression', !!m);
if(m){
  global.allTickers=['ACME'];
  global.DB={trades:feed(50),companies:[]};
  const companyTrades=eval(m[0].replace(/^const companyTrades=/,'').replace(/;$/,''));
  check('"Recent trades" starts at the newest trade',
        companyTrades[0].id===50, String(companyTrades[0].id));
  check('...and holds the 30 most recent, not the 30 oldest',
        companyTrades.length===30&&companyTrades[companyTrades.length-1].id===21,
        companyTrades.length+' ending at '+companyTrades[companyTrades.length-1].id);
}

// ── page 1 of Trade history is the trade you just made ──
global.DB={trades:feed(45),companies:[]};
UI.tradePage=0;
let html=renderTradingHistory();
check('page 1 leads with the newest trade', html.includes('$55.00'), 'no $55.00');
check('...and does not contain the oldest', !html.includes('$11.00'));
check('...and reports the right total', html.includes('45 total trades'));
check('...over the right number of pages', html.includes('Page 1 of 3'), 'pages');

UI.tradePage=2;
html=renderTradingHistory();
check('the last page holds the oldest trade', html.includes('$11.00'));
check('...and not the newest', !html.includes('$55.00'));

// A page number left over from a longer list must not render an empty page.
global.DB={trades:feed(5),companies:[]};
UI.tradePage=7;
html=renderTradingHistory();
check('a stale page number falls back to the last real page', UI.tradePage===0, String(UI.tradePage));
check('...and still shows the trades', html.includes('$15.00'));

// Someone else's trades are not in your history at all.
global.DB={trades:[trade(9,{buyer_id:'other',seller_id:'other2'}),trade(8)],companies:[]};
UI.tradePage=0;
html=renderTradingHistory();
check('another student\'s trade is not in your history', !html.includes('$19.00'));
check('...but yours is', html.includes('$18.00'));

global.DB={trades:[],companies:[]};
check('no trades is an empty state, not a crash', /No trades yet/.test(renderTradingHistory()));

// ── the tape is capped ──
global.DB={trades:feed(600),companies:[]};
html=renderTrades(true);
let rows=(html.match(/<tr><td style="color:var\(--text2\)"/g)||[]).length;
check('the admin tape renders at most '+TRADE_TAPE_MAX+' rows', rows===TRADE_TAPE_MAX, String(rows));
check('...taken from the newest end', html.includes('$610.00'), 'newest missing');
check('...not the oldest', !html.includes('$11.00'));
check('...and says how many it is showing',
      html.includes('latest '+TRADE_TAPE_MAX+' of 600'), 'no count');

// Under the cap, everything shows and nothing is claimed about a cap.
global.DB={trades:feed(12),companies:[]};
html=renderTrades(true);
rows=(html.match(/<tr><td style="color:var\(--text2\)"/g)||[]).length;
check('a short tape shows every trade', rows===12, String(rows));
check('...with no "latest N of" note', !html.includes('latest '), 'unexpected note');

// A student's own tape is filtered first, then capped.
global.DB={trades:feed(600).map((t,i)=>i%2?Object.assign({},t,{buyer_id:'other'}):t),companies:[]};
html=renderTrades(false);
rows=(html.match(/<tr><td style="color:var\(--text2\)"/g)||[]).length;
check('a student sees at most the cap of their OWN trades', rows===TRADE_TAPE_MAX, String(rows));
check('...counted against their own total, not the exchange\'s',
      html.includes('of 300'), 'wrong total');

global.DB={trades:[],companies:[]};
check('an empty tape is an empty state', /No trades yet/.test(renderTrades(true)));

// ── the admin PDF export takes the newest 200, then orders them ──
// It reversed first and sliced second, which takes the OLDEST 200: an
// instructor exporting mid-term got the first 200 trades of the year and
// nothing since. The operations have to happen in this order, so this is
// checked on the source -- the export writes into a new window, which there is
// no DOM here to open.
check('the admin export slices the newest 200 before ordering them',
      /const recentTrades=DB\.trades\.slice\(0,200\)\.reverse\(\);/.test(src));
check('...and no longer reverses the whole list first',
      !/\[\.\.\.DB\.trades\]\.reverse\(\)\.slice/.test(src));
check('...and says which 200 they are',
      /most recent 200 of/.test(src));

// ── the same mistake in the other newest-first lists ──
// Every table loaded order=created_at.desc has to be prepended to, not
// appended to. jex_votes had the identical bug and no self-correction: it is
// not in the 20-second poll, so a vote you posted sat at the bottom of your own
// company's vote list until a full page reload, while everyone else -- served
// by the realtime handler, which unshifts -- saw it at the top.
[['DB.votes',            'jex_votes'],
 ['DB.news',             'jex_news'],
 ['DB.announcements',    'jex_announcements'],
 ['DB.minutes',          'jex_minutes'],
 ['DB.snapshots',        'jex_snapshots'],
 ['DB.founderAllocations','jex_founder_allocations']].forEach(([arr,table])=>{
  const pushes=new RegExp(arr.replace('.','\\.')+'\\.push\\(','g');
  check('nothing appends to '+arr+' ('+table+' loads newest-first)',
        !pushes.test(src), (src.match(pushes)||[]).join(' '));
});

// ── the admin PDF export takes the newest 200, then orders them ──
process.exit(fails?1:0);
