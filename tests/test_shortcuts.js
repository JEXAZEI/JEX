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
const bLine=(code.match(/if\(key==='b'\)\{[^}]*\}/)||[''])[0];
const sLine=(code.match(/if\(key==='s'\)\{[^}]*\}/)||[''])[0];
// Matched on CALLS, not on the word "trade" -- UI.companyPageTab='trade' is a
// string assignment naming a tab, and an earlier version of this check flagged
// it as if it placed one.
const callsSomething=s=>(s.match(/\b[A-Za-z_$][\w$]*\s*\(/g)||[])
  .map(x=>x.replace(/\s*\($/,''))
  .filter(x=>!['if','render'].includes(x));
check("'b' only opens the buy panel and repaints",
      /panelMode='buy'/.test(bLine) && callsSomething(bLine).length===0,
      bLine+' -> calls '+JSON.stringify(callsSomething(bLine)));
check("'s' only opens the sell panel and repaints",
      /panelMode='sell'/.test(sLine) && callsSomething(sLine).length===0,
      sLine+' -> calls '+JSON.stringify(callsSomething(sLine)));

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

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll keyboard-shortcut checks passed.'));
process.exit(fails?1:0);
