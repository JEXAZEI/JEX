// M refreshes the market, not just the tab.
//
// It used to only call setTab('market'). A student looking at a stale price
// had no way to ask for a fresh one: the background sweep backs off to 60s
// whenever the realtime socket is healthy, so on a quiet room the prices can
// sit unchanged for a minute while everything is working perfectly. "Nothing
// is happening" and "nothing has happened" look identical.
//
// Three things have to hold, and only the first is obvious:
//
//   1. Pressing M fetches. It must bypass autoRefresh's own rate limit --
//      calling autoRefresh() plainly would return immediately almost every
//      time, and the key would appear to do nothing.
//
//   2. Holding M must not stack sweeps. Key repeat fires continuously, and
//      autoRefresh is a 15-query fan-out; without an in-flight guard a leaned-on
//      keyboard would launch dozens of them at a school's bandwidth.
//
//   3. It must still only READ. tests/test_shortcuts.js holds the whole
//      handler to "a keypress never moves money"; this pins the specific new
//      call so a later change cannot quietly widen it.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// The 'm' branch, brace-matched out of the keydown handler.
function branch(k){
  const i=src.indexOf("if(key==='"+k+"'){");
  if(i<0)return '';
  let j=src.indexOf('{',i),d=0;
  for(;j<src.length;j++){ if(src[j]==='{')d++; else if(src[j]==='}'){d--;if(!d)return src.slice(i,j+1);} }
  return '';
}
const m=branch('m');
check("the 'm' branch was found at all", m.length>0, 'brace matching failed');
check('...it still opens the Market tab', /setTab\('market'\)/.test(m), m);
check('...but only when not already there',
      /UI\.navTab!=='market'\|\|UI\.companyPage/.test(m),
      'setTab is unconditional, so the chart repaints twice for one keypress');
check('...it asks for a refresh', /autoRefresh\(\)/.test(m), m);
check('...bypassing the rate limit, or it would usually no-op',
      /_lastRefresh=0/.test(m), m);
check('...behind an in-flight guard, so key repeat cannot stack sweeps',
      /_manualRefreshing/.test(m), m);
check('...and it still moves no money',
      !/(placeBuy|placeSell|placeShort|coverShort|sb\s*\.\s*rpc|sb\s*\.\s*post)/.test(m), m);

// The guard variable has to actually exist, not just be referenced.
check('the in-flight flag is declared', /let _manualRefreshing=false;/.test(src),
      '_manualRefreshing is used but never declared');

// The help card must not lie about what the key does.
check('the shortcuts card mentions the refresh',
      /\{keys:'M',\s*what:'Market[^']*refresh/i.test(src),
      'SHORTCUTS still describes M as plain navigation');

// ── behaviour, not just shape ──
//
// Run the real branch with autoRefresh stubbed, and count the calls.
let refreshCalls=0, tabs=[], toasts=[], resolveIt=null;
// Faithful enough to matter: the real setTab moves UI.navTab, which is exactly
// what the "am I already there?" guard reads.
global.setTab=t=>{tabs.push(t);global.UI.navTab=t;global.UI.companyPage=null;};
global.toast=t=>{toasts.push(String(t));};
global.autoRefresh=()=>{refreshCalls++;return new Promise(r=>{resolveIt=r;});};
global._lastRefresh=12345;
global._manualRefreshing=false;
// Somewhere other than the Market to begin with.
global.UI={navTab:'portfolio',companyPage:null};

// `let` at top level of an eval binds inside the eval, so the branch is
// rewritten to touch the globals the stubs above installed.
const runnable=m
  .replace(/^if\(key==='m'\)\{/,'(async()=>{')
  .replace(/\breturn;\s*\}$/,'})();')
  .replace(/\b_lastRefresh\b/g,'global._lastRefresh')
  .replace(/\b_manualRefreshing\b/g,'global._manualRefreshing');

(async()=>{
  eval(runnable);
  check('pressing M switches to the Market', tabs.join(',')==='market', tabs.join(','));
  check('...and fires exactly one refresh', refreshCalls===1, String(refreshCalls));
  check('...having cleared the rate limit first', global._lastRefresh===0,
        String(global._lastRefresh));
  check('...and says nothing until the data is actually back',
        toasts.length===0, JSON.stringify(toasts));

  // Key repeat: three more presses while the first is still in flight.
  eval(runnable); eval(runnable); eval(runnable);
  check('holding M does not stack sweeps', refreshCalls===1,
        refreshCalls+' sweeps were launched');
  // The chart is torn down and re-animated by setTab. Calling it again when
  // already on the Market made the graph move once with stale data and again
  // when the fetch landed -- two movements for one keypress, the first showing
  // nothing new.
  check('...and does not repaint the tab again once already there',
        tabs.length===1, tabs.length+' setTab calls -> that many chart redraws');

  // Let the first one land.
  resolveIt();
  await new Promise(r=>setTimeout(r,0));
  check('the student is told when it finishes',
        toasts.length===1 && /refreshed/i.test(toasts[0]), JSON.stringify(toasts));
  check('...and the guard is released for the next press',
        global._manualRefreshing===false, String(global._manualRefreshing));

  // A press after it completes refreshes again.
  eval(runnable);
  check('a later press refreshes again', refreshCalls===2, String(refreshCalls));

  // ── the reported bug, directly ──
  // Already on the Market: exactly one repaint, and it is the one carrying
  // fresh prices. Zero setTab calls means zero extra chart animations.
  resolveIt();
  await new Promise(r=>setTimeout(r,0));
  refreshCalls=0; tabs=[]; toasts=[];
  global.UI={navTab:'market',companyPage:null};
  global._manualRefreshing=false;
  eval(runnable);
  check('pressing M while already on the Market does not re-select the tab',
        tabs.length===0, tabs.join(',')+' -> each one re-animates the chart');
  check('...but still fetches', refreshCalls===1, String(refreshCalls));

  // An open company page counts as "not on the Market", so M still navigates
  // out of it.
  refreshCalls=0; tabs=[]; global._manualRefreshing=false;
  global.UI={navTab:'market',companyPage:'AZEI'};
  eval(runnable);
  check('M still leaves an open company page', tabs.join(',')==='market', tabs.join(','));

  // A failed refresh must say so rather than claim success.
  refreshCalls=0; toasts=[]; global._manualRefreshing=false;
  global.autoRefresh=()=>{refreshCalls++;return Promise.reject(new Error('offline'));};
  eval(runnable);
  await new Promise(r=>setTimeout(r,0));
  check('a failed refresh does not claim the market was refreshed',
        toasts.length===1 && !/^Market refreshed/.test(toasts[0]), JSON.stringify(toasts));
  check('...it says the refresh failed',
        /could not refresh/i.test(toasts[0]||''), JSON.stringify(toasts));
  check('...and still releases the guard, so M is not dead afterwards',
        global._manualRefreshing===false, String(global._manualRefreshing));

  console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
  process.exit(fails?1:0);
})();
