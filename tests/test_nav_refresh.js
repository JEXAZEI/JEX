// Navigation shortcuts refresh, and repaint exactly once.
//
// The tab keys used to only call setTab. A student looking at a stale price
// had no way to ask for a fresh one: the background sweep backs off to 60s
// whenever the realtime socket is healthy, so on a quiet room the numbers can
// sit unchanged for a minute while everything is working perfectly. "Nothing
// is happening" and "nothing has happened" look identical.
//
// Four things have to hold, and only the first is obvious:
//
//   1. Pressing a tab key fetches. It must bypass autoRefresh's own rate limit
//      -- calling autoRefresh() plainly would return immediately almost every
//      time, and the keys would appear dead in exactly the situation that
//      makes someone press them.
//
//   2. It repaints ONCE. setTab does destroyCharts() then render(), and charts
//      rebuild with an animation, so calling it while already on the tab tore
//      the chart down and re-animated it with the data already on screen, then
//      did it again when the fetch landed. The graph visibly moved twice for
//      one keypress and the first move showed nothing new. This was reported
//      from the classroom, not found here.
//
//   3. Holding a key must not stack sweeps, and neither must pressing two
//      different tab keys in quick succession. autoRefresh is a 15-query
//      fan-out; on school wifi a leaned-on keyboard would launch dozens.
//
//   4. It must still only READ. tests/test_shortcuts.js holds the whole
//      handler to "a keypress never moves money"; this pins the specific
//      helper so a later change cannot quietly widen it.
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
const fn=grabFn('navRefresh');

// ── shape ──
check('navRefresh exists', fn.length>0);
check('...it asks for a refresh', /autoRefresh\(\)/.test(fn), fn);
check('...bypassing the rate limit, or it would usually no-op',
      /_lastRefresh=0/.test(fn), fn);
check('...behind an in-flight guard, so key repeat cannot stack sweeps',
      /_manualRefreshing/.test(fn), fn);
check('...navigating only when not already there',
      /UI\.navTab!==tab\|\|UI\.companyPage/.test(fn), fn);
check('...and it moves no money',
      !/(placeBuy|placeSell|placeShort|coverShort|sb\s*\.\s*rpc|sb\s*\.\s*post)/.test(fn), fn);
check('the in-flight flag is declared', /let _manualRefreshing=false;/.test(src));

// Every navigation key must route through it -- one of them keeping its own
// copy is how the two drift.
const HANDLER_KEYS=[['m','market'],['e','exchange'],['p','portfolio'],['f','funds'],
                    ['l','leaderboard'],['t','trades'],['n','notifications'],['o','orders']];
for(const [k,tab] of HANDLER_KEYS){
  check("'"+k+"' routes through navRefresh('"+tab+"')",
        new RegExp("key==='"+k+"'\\)\\{navRefresh\\('"+tab+"'\\)").test(src),
        "'"+k+"' still navigates without refreshing");
}
check('no tab key still calls setTab directly in the handler',
      !/key==='[meplftn]'\)\{setTab\(/.test(src),
      'a key kept its own navigation and will repaint twice');

// The card must not lie about what the keys do.
check('the help card says the tab keys refresh',
      /tab keys also refresh/i.test(src), 'the card still describes them as plain navigation');

// ── behaviour ──
let refreshCalls=0, tabs=[], renders=0, toasts=[], resolveIt=null, rejectIt=null;
global.setTab=t=>{tabs.push(t);renders++;global.UI.navTab=t;global.UI.companyPage=null;};
global.render=()=>{renders++;};
global.toast=t=>{toasts.push(String(t));};
global.autoRefresh=()=>{refreshCalls++;return new Promise((res,rej)=>{resolveIt=res;rejectIt=rej;});};
global.UI={navTab:'portfolio',companyPage:null};
global._lastRefresh=12345;
global._manualRefreshing=false;

// `let`/`const` at eval top level bind inside the eval, so the helper is
// rewritten to touch the globals the stubs above installed.
const runnable=fn
  .replace(/\b_lastRefresh\b/g,'global._lastRefresh')
  .replace(/\b_manualRefreshing\b/g,'global._manualRefreshing')
  .replace(/\bTAB_LABELS\b/g,'global.TAB_LABELS');
global.TAB_LABELS={market:'Market',exchange:'Exchange',portfolio:'Portfolio',
  funds:'Funds',leaderboard:'Leaderboard',trades:'Trades',orders:'Orders',
  notifications:'Notifications'};
eval(runnable);

const reset=(navTab,companyPage)=>{
  refreshCalls=0;tabs=[];renders=0;toasts=[];
  global.UI={navTab:navTab,companyPage:companyPage||null};
  global._manualRefreshing=false;global._lastRefresh=12345;
};

(async()=>{
  // ── arriving from elsewhere ──
  reset('portfolio');
  navRefresh('market');
  check('navigating switches tab', tabs.join(',')==='market', tabs.join(','));
  check('...repaints once for the arrival', renders===1, String(renders));
  check('...fires one refresh', refreshCalls===1, String(refreshCalls));
  check('...clears the rate limit first', global._lastRefresh===0, String(global._lastRefresh));
  check('...and says nothing until the data is back', toasts.length===0, JSON.stringify(toasts));
  resolveIt(); await new Promise(r=>setTimeout(r,0));
  check('...then names the tab it refreshed',
        toasts.join()==='Market refreshed', JSON.stringify(toasts));

  // ── the reported bug: already on the tab ──
  for(const [tab,label] of [['market','Market'],['leaderboard','Leaderboard'],['trades','Trades']]){
    reset(tab);
    navRefresh(tab);
    check('on '+tab+' already: no tab switch', tabs.length===0, tabs.join(','));
    check('...so it repaints ONCE, not twice', renders===0, renders+' repaints before the fetch');
    check('...and still fetches', refreshCalls===1, String(refreshCalls));
    resolveIt(); await new Promise(r=>setTimeout(r,0));
    check('...toast names '+label, toasts.join()===label+' refreshed', JSON.stringify(toasts));
  }

  // ── notifications keeps its own navigation ──
  reset('portfolio');
  navRefresh('notifications');
  check('notifications does not go through setTab', tabs.length===0, tabs.join(','));
  check('...but does move and repaint', global.UI.navTab==='notifications'&&renders===1,
        global.UI.navTab+'/'+renders);
  resolveIt(); await new Promise(r=>setTimeout(r,0));

  // ── an open company page counts as "not there" ──
  reset('market','AZEI');
  navRefresh('market');
  check('an open company page is still navigated out of', tabs.join(',')==='market', tabs.join(','));
  resolveIt(); await new Promise(r=>setTimeout(r,0));

  // ── key repeat, and two different keys ──
  reset('portfolio');
  navRefresh('market'); navRefresh('market'); navRefresh('market');
  check('holding a key does not stack sweeps', refreshCalls===1, refreshCalls+' sweeps');
  check('...and does not repaint again once arrived', tabs.length===1, String(tabs.length));
  navRefresh('portfolio');
  check('a different tab key mid-sweep still navigates',
        tabs.join(',')==='market,portfolio', tabs.join(','));
  check('...but does not start a second sweep', refreshCalls===1, refreshCalls+' sweeps');
  resolveIt(); await new Promise(r=>setTimeout(r,0));
  check('...and the guard is released afterwards',
        global._manualRefreshing===false, String(global._manualRefreshing));

  // ── a failed refresh must say so ──
  reset('portfolio');
  navRefresh('market');
  rejectIt(new Error('offline')); await new Promise(r=>setTimeout(r,0));
  check('a failed refresh does not claim success',
        toasts.length===1 && !/refreshed$/.test(toasts[0]), JSON.stringify(toasts));
  check('...it says the refresh failed', /could not refresh/i.test(toasts[0]||''), JSON.stringify(toasts));
  check('...and still releases the guard, so the keys are not dead afterwards',
        global._manualRefreshing===false, String(global._manualRefreshing));

  console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
  process.exit(fails?1:0);
})();
