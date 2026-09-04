// When a short gets closed out from under you.
//
// Run against the app's own nw()/sPnl(), a student with $10,000 who shorts 100
// shares at $20 -- a $2,000 position, $3,000 collateral -- looked like this:
//
//     price     short P&L    net worth
//     $20               0       10,000
//     $50          -3,000        7,000   <- losses now equal the collateral
//     $100         -8,000        2,000
//     $120        -10,000            0
//     $140        -12,000       -2,000   <- negative
//
// Nothing stopped at $50. The collateral is locked at the ENTRY price and
// never marked to market, so it was never a floor -- just the first $3,000
// they lose. The loss ran unbounded on a $2,000 trade, and a 2.5x move is
// very reachable when one trade can move a price 12%.
//
// The far end was worse than a big loss: covering releases the collateral and
// applies the loss, so past a point cash goes negative -- and if the server
// refuses the cover for insufficient funds, the student cannot get out at all
// and the position keeps growing against them for the rest of the term.
//
// The line is 80% of the collateral, not 100%, because the forced buy-back is
// itself a market buy: it pushes the price up and pays the higher price, so
// the closing trade has to fit inside what is left. At 100% there would be
// nothing left to buy with, which is the hole this closes.
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
eval(grabConst('MARGIN_CALL_AT').replace(/^const /,'global.'));
eval(grabFn('shortMarginLine').replace('function shortMarginLine','global.shortMarginLine=function'));

const pos=(qty,avg,coll)=>({qty,avgPrice:avg,collateral:coll});
// The standard shape: 150% of entry value.
const std=(qty,avg)=>pos(qty,avg,Math.round(avg*qty*1.5*100)/100);

// ── where the line falls ──
// 150% collateral, closed at 80% of it: avg + 0.8*1.5*avg = 2.2 * avg.
check('a $20 short is closed at $44', shortMarginLine(std(100,20))===44,
      String(shortMarginLine(std(100,20))));
check('...which is 2.2x the entry price', shortMarginLine(std(100,20))===20*2.2);
check('the multiple holds at another price', shortMarginLine(std(50,10))===22,
      String(shortMarginLine(std(50,10))));
check('...and does not depend on the size', shortMarginLine(std(7,10))===22,
      String(shortMarginLine(std(7,10))));

// The line has to sit BELOW the point where the collateral is gone, or there
// is nothing left to buy the shares back with.
const line=shortMarginLine(std(100,20));
const collGone=20+3000/100;   // loss == collateral, at $50
check('the line is below the collateral-exhausted price', line<collGone,
      line+' vs '+collGone);
check('...leaving a fifth of the collateral to close with',
      Math.round((3000-(line-20)*100)*100)/100===600,
      String(Math.round((3000-(line-20)*100)*100)/100));

// ── it triggers on the way up, and not before ──
const crossed=(p,pp)=>{const l=shortMarginLine(pp);return l!=null&&p>=l;};
const P=std(100,20);
check('flat is not a margin call', !crossed(20,P));
check('a winning short is certainly not', !crossed(5,P));
check('down 10% is not', !crossed(18,P));
check('up 100% is not yet', !crossed(40,P));
check('a cent below the line is not', !crossed(43.99,P));
check('exactly at the line IS', crossed(44,P));
check('above it certainly is', crossed(60,P));
check('...and so is the runaway case', crossed(140,P));

// ── shapes that must never produce a call ──
check('a closed-out position has no line', shortMarginLine(pos(0,20,3000))===null);
check('a negative qty has no line', shortMarginLine(pos(-5,20,3000))===null);
check('no collateral means no line', shortMarginLine(pos(100,20,0))===null);
check('a null position does not throw', shortMarginLine(null)===null);
check('an empty object does not throw', shortMarginLine({})===null);
check('a missing collateral does not throw', shortMarginLine({qty:10,avgPrice:5})===null);
// A string from jsonb must not concatenate into nonsense.
check('numeric strings are coerced, not concatenated',
      shortMarginLine({qty:'100',avgPrice:'20',collateral:'3000'})===44,
      String(shortMarginLine({qty:'100',avgPrice:'20',collateral:'3000'})));

// ── a non-standard collateral ratio still works out ──
// The line is defined against what was ACTUALLY posted, not against an assumed
// 150%, so an old position opened under a different rule is handled correctly.
check('double collateral moves the line further out',
      shortMarginLine(pos(100,20,6000))===68, String(shortMarginLine(pos(100,20,6000))));
check('thin collateral brings it closer in',
      shortMarginLine(pos(100,20,1000))===28, String(shortMarginLine(pos(100,20,1000))));

// ── the poller ──
const poll=grabFn('checkMarginCalls');
check('it does nothing while the market is closed', /if\(!isOpen\(\)\)return;/.test(poll));
check('it skips a halted ticker', /isHalted\(ticker\)/.test(poll), poll);
check('it scans every user, not just the signed-in one', /for\(const u of DB\.users\|\|\[\]\)/.test(poll));
check('it skips positions that are already closed', /!\(pos\.qty>0\)/.test(poll));
check('it re-reads the line from the position, not from a stored trigger',
      /shortMarginLine\(pos\)/.test(poll));
check('it only acts when the server agrees it happened', /if\(!r\|\|!r\.called\)continue;/.test(poll));

// Two very different failures, which must not be treated alike.
//
// Before the migration runs the function is simply absent, and that is
// expected -- a deploy reaches students before the SQL does. Reporting it
// would file an error three times a second forever.
check('a missing RPC is tolerated quietly',
      /PGRST202\|Could not find the function\|does not exist/.test(poll), poll);
// Anything else means the safety net is DOWN: a short that should be closing
// is not, and it drifts further from recoverable every tick. Swallowing that
// looks exactly like working.
check('any OTHER failure is reported, not swallowed',
      /reportClientError\('margin call failed for/.test(poll), poll);
check('...and the two are told apart by the message, not lumped together',
      /if\(!\/PGRST202/.test(poll), poll);
check('a failure never stops the rest of the poll', /continue;\n      \}/.test(poll), poll);

// Whose screen it lands on. Same rule as the stop-loss toast: any client can
// trigger anyone's margin call, so an ungated toast would tell a classmate
// that another student was just bought in, and at what price.
check('the toast is gated to the owner or an admin',
      /me\.id===r\.user_id\|\|isAdmin\(me\)/.test(poll), poll);
check('...while the owner always gets the durable notification',
      /pushNotification\(r\.user_id,'margin_call'/.test(poll));
check('the notification says what it cost them',
      /Loss '\+fmt\(Math\.abs\(r\.pnl\)\)/.test(poll), poll);

// ── applying the result ──
const apply=grabFn('applyMarginCallResult');
check('the closed-out student is the one credited, not whoever polled',
      /getUser\(r\.user_id\)/.test(apply)&&!/\bcu\(\)/.test(apply), apply);
check('the short is replaced by the server copy, not edited locally',
      /u\.shorts=r\.shorts/.test(apply));
check('the forced buy-in shows up on the tape', /recordLocalTrade\(r\.trade\)/.test(apply));
check('...and the price it moved to is applied', /co\.price=r\.price/.test(apply));

// ── the student can see it coming ──
//
// A margin call that arrives with no warning is a rule they never had a chance
// to act on. The price it will happen at sits beside the position from the
// moment it is opened, not only once it is nearly hit.
const shortsTab=/if\(UI\.portfolioTab==='shorts'\)\{[\s\S]*?\n  \}/.exec(src);
check('the shorts tab was found', !!shortsTab);
const tab=shortsTab?shortsTab[0]:'';
check('every open short shows the price it closes out at',
      /const mline=shortMarginLine\(pos\)/.test(tab)&&/marginCell/.test(tab), tab.slice(0,200));
check('...using the same function the poller triggers on',
      (src.match(/shortMarginLine\(/g)||[]).length>=3,
      String((src.match(/shortMarginLine\(/g)||[]).length));
check('...and explains what it means', /losses have used up 80% of the collateral/.test(tab));
check('...and warns as it gets close', /near\?'var\(--amber\)'/.test(tab), tab.slice(0,400));
// A position with no computable line must render nothing rather than "null".
check('a position with no line renders no cell', /mline==null\?''/.test(tab), tab.slice(0,400));

// The warning threshold has to sit between opening and the call itself, or it
// is either always on or never on.
const P2=std(100,20);
const warnAt=20+(shortMarginLine(P2)-20)*0.75;
check('the amber warning starts before the call, not at it',
      warnAt>20&&warnAt<shortMarginLine(P2), warnAt+' vs '+shortMarginLine(P2));
check('...three quarters of the way there', Math.round(warnAt*100)/100===38,
      String(Math.round(warnAt*100)/100));

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll margin-call checks passed.'));
process.exit(fails?1:0);
