// Keyboard shortcuts must never move money.
//
// JEX already has shortcuts: M/P/L/N switch tabs, B/S/O act on an open company
// page, Escape closes it. They are scoped well -- B and S only SWITCH THE
// PANEL to buy or sell, they do not place an order.
//
// This suite exists to keep it that way. The temptation with a trading app is
// to make B actually buy, and that is a bad trade on a school Chromebook: a
// stray keypress on a shared or unlocked machine spends someone's money, with
// no dialog and no undo. Every order in JEX goes through a button the student
// aimed at.
//
// So: the handler may navigate, switch tabs and change panels freely, and must
// not call anything that trades. It must also keep the two guards that stop it
// hijacking ordinary typing.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// The global keydown handler, brace-matched from its registration.
function grabHandler(){
  const marker="document.addEventListener('keydown',function(e){";
  const i=src.indexOf(marker);
  if(i<0)throw new Error('the global keydown handler is gone');
  let j=src.indexOf('{',i+marker.length-1),d=0;
  for(;j<src.length;j++){
    if(src[j]==='{')d++;
    else if(src[j]==='}'){d--;if(!d)return src.slice(i,j+1);}
  }
  throw new Error('unterminated keydown handler');
}
const handler=grabHandler();
// Comments describe the rules; they must not be mistaken for code.
const code=handler.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:])\/\/.*$/gm,'$1');

// ── nothing that trades ──
//
// Every function that can move cash, shares or an order. If a shortcut ever
// calls one of these, a keypress spends money.
const MONEY=['placeBuy','placeSell','placeShort','coverShort','cpTrade','cpLimit',
             'placeLimitOrder','doBuyback','issueDividend','placeStopLoss','doPlaceStopLoss',
             'cancelStopLoss','cancelLimitOrder','fundBuy','fundSell','fundShort',
             'fundCoverShort','depositToFund','withdrawFromFund','approveReg','rejectReg',
             'togglePracticeMode','toggleDevMode','resetExchange','doRestoreSnapshot',
             'haltStock','resumeStock','setSession','startTimer','scheduleSession'];
for(const fn of MONEY){
  check('no shortcut calls '+fn+'()',
        !new RegExp('\\b'+fn+'\\s*\\(').test(code),
        'found a call to '+fn+' inside the keydown handler');
}

// A broader net: any RPC or write from a keypress at all.
check('no shortcut calls an RPC directly', !/sb\s*\.\s*rpc\s*\(/.test(code));
check('no shortcut POSTs or PATCHes directly',
      !/sb\s*\.\s*(post|patch|put|del|delete)\s*\(/.test(code));
check('no shortcut confirms an action', !/\bconfirm\s*\(/.test(code));

// ── the guards that stop it hijacking typing ──
check('typing in a field is left alone',
      /activeElement/.test(code) && /INPUT/.test(code) && /TEXTAREA/.test(code),
      'the form-field guard is missing');
check('SELECT elements are included in that guard', /SELECT/.test(code));
check('browser and OS combos are left alone',
      /metaKey/.test(code) && /ctrlKey/.test(code) && /altKey/.test(code),
      'the modifier guard is missing -- Ctrl+P etc. would be swallowed');
check('shortcuts do nothing when signed out', /if\(!UI\.userId\)return;/.test(code));

// ── what it IS allowed to do, so the suite fails loudly if they vanish ──
// These are the shortcuts students are told about; losing one silently would
// be its own small bug.
for(const [key,what] of [["'m'",'market'],["'p'",'portfolio'],["'l'",'leaderboard'],
                         ["'b'",'buy panel'],["'s'",'sell panel'],["'o'",'overview']]){
  check('the '+what+' shortcut ('+key+') still exists',
        new RegExp("key===" + key).test(code), key+' is gone');
}
check('escape still closes an open company page',
      /key===.escape./.test(code) && /closeCompanyPage\(\)/.test(code));

// ── B and S switch the panel, they do not trade ──
// The exact pair that would be tempting to "improve" into a real order.
// Brace-matched, not [^}]*: the 's' branch now has nested braces (the
// double-tap bookkeeping), and a lazy character class silently matched
// nothing, which made this check pass by examining an empty string.
function branch(k){
  const i=code.indexOf("if(key==='"+k+"'){");
  if(i<0)return '';
  let j=code.indexOf('{',i),d=0;
  for(;j<code.length;j++){ if(code[j]==='{')d++; else if(code[j]==='}'){d--;if(!d)return code.slice(i,j+1);} }
  return '';
}
const bLine=branch('b'), sLine=branch('s'), cLine=branch('c');
check("the 'b' branch was found at all", bLine.length>0);
check("the 's' branch was found at all", sLine.length>0);
// Matched on CALLS, not on the word "trade" -- UI.companyPageTab='trade' is a
// string assignment naming a tab, and an earlier version of this check flagged
// it as if it placed one.
const callsSomething=s=>(s.match(/\b[A-Za-z_$][\w$]*\s*\(/g)||[])
  .map(x=>x.replace(/\s*\($/,''))
  .filter(x=>!['if','render'].includes(x));
check("'b' only opens the buy panel and repaints",
      /panelMode='buy'/.test(bLine) && callsSomething(bLine).length===0,
      bLine+' -> calls '+JSON.stringify(callsSomething(bLine)));
// 's' now means Sell once, Short twice; 'c' means Cover. All three are panel
// switches and none may DO anything -- but they are allowed to read, which is
// the whole point of 'c' only firing when a short exists. The allowlist is
// exactly the pure reads: the double-tap clock, and the accessor that answers
// "is there a short here". Nothing that writes is on it, and the MONEY sweep
// above still covers the entire handler regardless.
const PURE_READS=['Date','now','shorts','getCo'];
const callsIn=s2=>callsSomething(s2).filter(x=>!PURE_READS.includes(x));
check("'s' opens the sell panel and nothing else",
      /panelMode=again\?'short':'sell'/.test(sLine) && callsIn(sLine).length===0,
      sLine+' -> calls '+JSON.stringify(callsIn(sLine)));
check("...and the second press is what makes it Short, on a short timer",
      /_lastKey\.k==='s'&&now-_lastKey\.at<[0-9]+/.test(sLine), sLine);
// Short is the riskier half of the pair, so it must be the one that costs the
// extra press -- never the default a single tap lands on.
check("...so a single press can never open Short",
      !/panelMode=again\?'sell':'short'/.test(sLine), sLine);
// 'c' opens Cover only when there is a short to cover, matching the panel,
// which only renders a Cover button under the same condition.
check("'c' checks for an open short before opening Cover",
      /shorts\(u\)/.test(cLine) && /qty>0/.test(cLine) && /panelMode='cover'/.test(cLine),
      cLine);
check("...and does nothing at all when there is no short",
      /if\(pos&&pos\.qty>0\)\{/.test(cLine), cLine);
check("'c' reads to decide, and does nothing else", callsIn(cLine).length===0,
      JSON.stringify(callsIn(cLine)));
// And the allowlist itself must stay honest: none of those may be a writer.
check('the read allowlist contains nothing that moves money',
      !PURE_READS.some(fn=>MONEY.includes(fn)), PURE_READS.join(','));

// ── the list and the handler must not drift apart ──
//
// JEX had four working shortcuts and nothing telling anyone they existed, so
// in practice it had none. The SHORTCUTS list drives the help card; if it and
// the handler disagree, students are either told about a key that does nothing
// or not told about one that does. Both are worth failing a build over.
function grabFn(name){
  const m=new RegExp('^(?:async )?function '+name+'\\(','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(m.index,i+1);} }
  throw new Error('unterminated: '+name);
}
function grabConst(name){
  const m=new RegExp('(?:^|;)const '+name+'=','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  const start=m.index+(m[0].startsWith(';')?1:0);
  let depth=0;
  for(let i=start;i<src.length;i++){
    const c=src[i];
    if('([{'.includes(c))depth++;
    else if(')]}'.includes(c))depth--;
    else if(c===';'&&depth===0)return src.slice(start,i+1);
  }
  throw new Error('unterminated: '+name);
}
const SHORTCUTS=eval('('+grabConst('SHORTCUTS').replace(/^const SHORTCUTS=/,'').replace(/;$/,'')+')');
const norm=k=>({esc:'escape'}[k.toLowerCase()]||k.toLowerCase());
const documented=new Set(SHORTCUTS.map(s=>norm(s.keys)));
const handled=new Set((code.match(/key===['"]([^'"]+)['"]/g)||[])
  .map(m=>m.replace(/key===['"]/,'').replace(/['"]$/,'')));
// Two entries are not single-key literals, so they need matching to the branch
// that implements them rather than to a key=== comparison.
if(/_lastKey\.k==='s'/.test(code))handled.add('s s');
if(/key>='1'&&key<='9'/.test(code))handled.add('1-9');

for(const k of documented)
  check('the documented shortcut "'+k+'" is actually handled', handled.has(k),
        'the help card promises it but the handler has no branch');
for(const k of handled)
  check('the handled key "'+k+'" is documented', documented.has(k),
        'it works but no student is told it exists');

check('every entry has a key and a description',
      SHORTCUTS.every(s=>s.keys&&s.what), JSON.stringify(SHORTCUTS));
check('the list is not empty', SHORTCUTS.length>=10, String(SHORTCUTS.length));

// ── the help card itself ──
global.UI={showShortcuts:false};
global.esc=s=>String(s);
eval(grabFn('renderShortcutHelp'));
check('the card renders nothing when closed', renderShortcutHelp()==='');
UI.showShortcuts=true;
const card=renderShortcutHelp();
check('the card renders when opened', card.length>0);
for(const s of SHORTCUTS)
  check('the card lists '+s.keys, card.includes(s.keys), s.keys+' missing from the card');
check('the card says shortcuts never place an order', /needs the button/i.test(card));
check('the card says typing is not interrupted', /typing in a box/i.test(card));
check('the card can be dismissed', /showShortcuts=false/.test(card));

// '?' must reach the toggle for everyone, admins included -- it is gated
// before the student/company role check, not inside it.
const qIndex=code.indexOf("key==='?'");
const roleIndex=code.indexOf("role==='student'");
check('the help key works for admins too, not just students',
      qIndex>-1 && qIndex<roleIndex,
      "'?' is inside the student/company branch");

// ── a keydown that carries no key must not throw ──
//
// From the live Errors tab, ten times in an hour on real students' browsers:
//
//     Uncaught TypeError: Cannot read properties of undefined
//                         (reading 'toLowerCase')
//     at HTMLDocument.<anonymous> (app.js:2083)
//
// That line was `const key=e.key.toLowerCase()`. Most of them were on the
// sign-in page, which is where password managers and autofill are busiest: a
// synthetic keydown dispatched as a plain Event -- document.dispatchEvent(new
// Event('keydown')) -- has no .key at all, and some mobile keyboards and
// extensions send exactly that.
//
// Everything above this line is read from the source. This part RUNS the
// handler, because "it looks guarded" is how the guard went missing.
const fnSrc=handler.slice(handler.indexOf('function(e){'));
let acted=[];
global.document={activeElement:null,getElementById:()=>null};
global.UI=Object.assign(global.UI||{},{userId:'u1',navTab:'market',companyPage:null,
  companyPageTab:'overview',panelMode:'buy',showShortcuts:false});
global.cu=()=>({id:'u1',role:'student'});
global.render=()=>{acted.push('render');};
global.setTab=t=>{acted.push('tab:'+t);};
global.closeCompanyPage=()=>{acted.push('closeCompanyPage');};
global.isAdmin=()=>false;
global.setTimeout=(f)=>{try{f();}catch(e){}return 0;};
const handle=eval('('+fnSrc+')');
const press=(ev,active)=>{
  acted=[];
  document.activeElement=active||null;
  let threw=null;
  try{handle(ev);}catch(err){threw=err;}
  return{acted,threw};
};
const ev=(k,extra)=>Object.assign({key:k,preventDefault(){},shiftKey:false},extra||{});

// The exact shapes that were crashing.
check('a keydown with no key property at all does not throw',
      press({preventDefault(){}}).threw===null, String(press({preventDefault(){}}).threw));
check('a keydown whose key is undefined does not throw',
      press(ev(undefined)).threw===null, String(press(ev(undefined)).threw));
check('a keydown whose key is null does not throw',
      press(ev(null)).threw===null, String(press(ev(null)).threw));
check('a non-string key does not throw', press(ev(13)).threw===null, String(press(ev(13)).threw));
check('no event object at all does not throw',
      press(null).threw===null, String(press(null).threw));
check('...and none of those did anything either',
      press({preventDefault(){}}).acted.length===0, JSON.stringify(press({}).acted));

// Still works for a real keypress -- the guard must not have turned it off.
check('a real keypress still switches tabs',
      press(ev('m')).acted.includes('tab:market'), JSON.stringify(press(ev('m')).acted));
check('...and is case-insensitive', press(ev('M')).acted.includes('tab:market'));
check('...and Escape still reaches the handler',
      (UI.companyPage='ACME', press(ev('Escape')).acted.includes('closeCompanyPage')));
UI.companyPage=null;

// An IME sends a keydown per keystroke while composing; those are letters
// being typed, not commands.
check('a composing keystroke is ignored', press(ev('m',{isComposing:true})).acted.length===0,
      JSON.stringify(press(ev('m',{isComposing:true})).acted));
check('...including the keyCode 229 form',
      press(ev('m',{keyCode:229})).acted.length===0);

// The typing guards, exercised rather than grepped.
check('typing in an input is left alone',
      press(ev('m'),{tagName:'INPUT'}).acted.length===0);
check('typing in a textarea is left alone',
      press(ev('m'),{tagName:'TEXTAREA'}).acted.length===0);
check('a focused select is left alone',
      press(ev('m'),{tagName:'SELECT'}).acted.length===0);
check('a contenteditable region is left alone',
      press(ev('m'),{tagName:'DIV',isContentEditable:true}).acted.length===0);
check('a focused button is NOT left alone',
      press(ev('m'),{tagName:'BUTTON'}).acted.includes('tab:market'));

// Browser and OS combos still pass through untouched.
for(const mod of ['metaKey','ctrlKey','altKey'])
  check(mod+' combinations are left to the browser',
        press(ev('p',{[mod]:true})).acted.length===0, mod);

// ── digits pick a tab, on every tabbed page ──
//
// One rule instead of a letter per page. It clicks the button that is actually
// on screen, which is what lets it work for the Admin tab set without knowing
// it -- that set differs for Chairman, Treasurer, Secretary and Compliance,
// and a hardcoded list here would go stale the first time one changed.
const digit=(code.match(/if\(key>='1'&&key<='9'\)\{[\s\S]*?\n  \}/)||[''])[0];
check('the digit branch exists', digit.length>0);
check('...and reads the tabs from the DOM, not from a list it keeps',
      /querySelector\('\.tab-row'\)/.test(digit) && /querySelectorAll\('\.tab'\)/.test(digit), digit);
check('...clicking the button rather than assigning UI state directly',
      /\.click\(\)/.test(digit) && !/UI\.[a-zA-Z]+Tab=/.test(digit), digit);
check('...and does nothing when the page has no tabs', /if\(row\)\{/.test(digit), digit);
check('...or when that tab does not exist', /if\(tab\)\{?/.test(digit), digit);
// It has to reach admins, who are excluded from the student/company branch.
const digitIndex=code.indexOf("key>='1'");
check('digits work for admins too, not just students',
      digitIndex>-1 && digitIndex<code.indexOf("role==='student'"),
      'the digit branch is inside the student/company branch');
// A digit must not trade, same rule as every other shortcut. It clicks a tab
// button, and tab buttons only ever set UI state -- but a button matching
// .tab could one day do more, so this is the line to hold.
check('a digit never calls a trade function directly',
      !MONEY.some(fn=>new RegExp('\\b'+fn+'\\s*\\(').test(digit)), digit);

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll keyboard-shortcut checks passed.'));
process.exit(fails?1:0);
