// Conversion rights.
//
// ── What was wrong ──
//
// A share class's price was a number the applicant typed into a form. Nothing
// tied it to the company it was a class OF. rpc_submit_class_application stored
// it verbatim (`v_price := p_price;`) and rpc_review_class_application listed
// the class at that number however long the application had been sitting
// (`values (..., v_app.price, ...)`).
//
// On its own that is only untidy. Combined with rpc_pay_dividend it is an
// exploit, because that function builds its ticker list as the parent plus
// every class and then pays a FLAT amount per share to all of them. So:
//
//     ACME trades at $50. Issue ACME.B at $2. Buy 1000 ACME.B for $2,000.
//     ACME pays $1/share. ACME.B collects $1,000 -- a 50% yield, against
//     the 2% every honest ACME holder gets, for the same claim.
//
// Zero applications had ever been filed and no one held a class share, so this
// had never fired. It would have fired the first lesson anyone used the
// feature.
//
// ── The fix ──
//
// A class gets a conversion ratio N: one ACME.B is worth N ACME. That one
// number sets the listing price (parent price x N, derived at approval), sets
// the dividend (a class share is paid as N base shares -- see
// test_dividend_total.js), and is a right the holder can exercise: convert N
// class shares into N x ratio base shares, one way.
//
// The right is the part that makes the ratio self-enforcing rather than a house
// rule. If ACME.B ever trades above 5 x ACME, anyone holding it converts and
// sells into ACME, and the gap closes -- the same mechanism that keeps GOOG and
// GOOGL within about a percent of each other. It can still drift BELOW, by
// roughly what the votes are worth, which is what happens in reality.
//
// ── What this file checks ──
//
// The client half: that the price is no longer typed anywhere, that every
// caller of the RPC sends a ratio, that the conversion panel appears on BOTH
// pages a holder could be on, and that convertShareClass refuses everything it
// should before it spends a round trip. The server half is checked by the
// migration's own verification select.
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
const bindFn=n=>eval(grabFn(n).replace(new RegExp('^(async )?function '+n),(m,a)=>(a||'')+'global.'+n+'=function'));

console.log('=== the typed price is gone ===');

// The single most important assertion in this file. If an IPO price input ever
// comes back, the ratio becomes decoration and the exploit is open again.
check('the class application form has no price input',
      !/id="cls-price"/.test(src));
check('...and has a conversion ratio input instead',
      /id="cls-ratio"/.test(src));
check('submitClassApplication takes a ratio, not a price',
      /async function submitClassApplication\(parentTicker,classType,votesPerShare,shares,ratio,restricted,whitelistIds,reason\)/.test(src));
check('...and the form passes the ratio through in that position',
      /submitClassApplication\(parentTicker,clsType,votes,shares,ratio,restricted,whitelist,reason\)/.test(src));
check('...reading it from the ratio input',
      /const ratio=document\.getElementById\('cls-ratio'\)\?\.value/.test(src));

// Both call sites. The conversion path (reclassifying a company's own stock)
// must send ratio 1: it is the SAME shares, so one of them is still one of
// them. Sending anything else would let a company mint a multiplier on the
// stock it already had outstanding.
const rpcCalls=src.match(/sb\.rpc\('rpc_submit_class_application',\{[\s\S]{0,400}?\}\)/g)||[];
check('both call sites of the application RPC were found', rpcCalls.length===2, String(rpcCalls.length));
check('no call site still sends p_price', rpcCalls.every(c=>!/p_price/.test(c)),
      rpcCalls.filter(c=>/p_price/.test(c)).join(' | '));
check('every call site sends p_conversion_ratio', rpcCalls.every(c=>/p_conversion_ratio/.test(c)));
check('the reclassify path pins the ratio to 1',
      rpcCalls.some(c=>/p_convert:true/.test(c)&&/p_conversion_ratio:1/.test(c)));

console.log('\n=== the ratio itself ===');
bindFn('getClassMeta');bindFn('classRatio');bindFn('ratioLabel');
global.holdings=u=>u.holdings||{};

global.DB={shareClasses:[{ticker:'ACME.B',parent_ticker:'ACME',conversion_ratio:5}],
           companies:[],users:[]};
check('ratioLabel names the parent, not a bare number',
      ratioLabel(getClassMeta('ACME.B'),'ACME')==='5 ACME', ratioLabel(getClassMeta('ACME.B'),'ACME'));
check('a 1:1 class says so explicitly',
      ratioLabel(1,'ACME')==='1 ACME (1:1)', ratioLabel(1,'ACME'));
check('ratioLabel accepts a bare ratio as well as a meta row',
      ratioLabel(5,'ACME')===ratioLabel(getClassMeta('ACME.B'),'ACME'));
check('a garbage ratio still labels as 1, never 0',
      ratioLabel(0,'ACME')==='1 ACME (1:1)', ratioLabel(0,'ACME'));

console.log('\n=== the listing price preview ===');
bindFn('classPricePreview');
global.esc=s=>String(s);
global.fmt=n=>'$'+Number(n).toFixed(2);
const co={ticker:'ACME',price:20};
check('the preview quotes parent price x ratio',
      /\$100\.00/.test(classPricePreview(co,5)), classPricePreview(co,5));
check('...and says it will be recalculated at approval',
      /Chairman approves/.test(classPricePreview(co,5)));
check('...and spells out the dividend and conversion consequences',
      /5× the dividend/.test(classPricePreview(co,5))&&/converts into 5 ACME/.test(classPricePreview(co,5)));
check('a 1:1 class does not claim a multiplier it does not have',
      !/×/.test(classPricePreview(co,1))&&/\$20\.00/.test(classPricePreview(co,1)),
      classPricePreview(co,1));
// Everything that must not render a price.
for(const [bad,label] of [[0,'zero'],[-1,'negative'],[1.5,'fractional'],[101,'over 100'],
                          ['','empty'],['abc','unparseable']]){
  check('a '+label+' ratio refuses to quote a price',
        !/Lists at/.test(classPricePreview(co,bad)), classPricePreview(co,bad));
}
check('a parent with no price refuses to quote one',
      !/Lists at/.test(classPricePreview({ticker:'ACME',price:0},5)));
check('...and does not throw on a missing company',
      typeof classPricePreview(null,5)==='string');

console.log('\n=== the conversion panel appears where a holder actually is ===');
bindFn('renderConversionPanel');
global.getCo=t=>(DB.companies||[]).find(c=>c.ticker===t)||null;
global.isHalted=t=>(DB.halts||[]).some(h=>h.ticker===t);
global.infoBubble=()=>'';
const setup=()=>{global.DB={
  halts:[],
  shareClasses:[{ticker:'ACME.B',parent_ticker:'ACME',class:'B',conversion_ratio:5}],
  companies:[{ticker:'ACME',price:20,status:'listed'},
             {ticker:'ACME.B',price:90,status:'listed'}],
  users:[]};};
const stu=h=>({id:'s1',role:'student',holdings:h});

setup();
// A class is a listed company in its own right, so a student can open ACME.B's
// page straight from the market table. Looking only for children would have put
// the button on the parent's page and nowhere else -- the page they are least
// likely to be on when they want it.
const onParent=renderConversionPanel(getCo('ACME'),stu({'ACME.B':10}));
const onClass =renderConversionPanel(getCo('ACME.B'),stu({'ACME.B':10}));
check('the panel renders on the parent company page', /Convert<\/button>/.test(onParent));
check('the panel renders on the class page too', /Convert<\/button>/.test(onClass));
check('...and both offer the same conversion', /10 held → up to 50 ACME/.test(onParent)
      &&/10 held → up to 50 ACME/.test(onClass));

check('a holder of nothing sees no panel',
      renderConversionPanel(getCo('ACME'),stu({ACME:100}))==='');
check('a holder of zero class shares sees no panel',
      renderConversionPanel(getCo('ACME'),stu({'ACME.B':0}))==='');
check('a non-trading role sees no panel',
      renderConversionPanel(getCo('ACME'),{id:'a',role:'chairman',holdings:{'ACME.B':10}})==='');
check('no user at all does not throw', renderConversionPanel(getCo('ACME'),null)==='');

// The edge: class marked at 90, worth 5 x 20 = 100 converted. Converting is
// +10/share, which is the arbitrage that enforces the ceiling.
check('the panel shows what the swap is worth right now', /\+\$10\.00 per share/.test(onParent), onParent);
setup();DB.companies[1].price=110;   // class ABOVE its ratio
check('...and shows it as negative when the class is above its ratio',
      /-\$10\.00 per share/.test(renderConversionPanel(getCo('ACME'),stu({'ACME.B':10}))));

setup();DB.halts=[{ticker:'ACME'}];
let halted=renderConversionPanel(getCo('ACME'),stu({'ACME.B':10}));
check('a halt on the parent disables the button', /disabled/.test(halted));
check('...and says why', /paused while trading is halted/.test(halted));
setup();DB.halts=[{ticker:'ACME.B'}];
check('a halt on the class disables it too',
      /disabled/.test(renderConversionPanel(getCo('ACME'),stu({'ACME.B':10}))));
setup();DB.companies[0].status='delisted';
halted=renderConversionPanel(getCo('ACME'),stu({'ACME.B':10}));
check('a delisted parent disables the button', /disabled/.test(halted));
check('...and says why', /ACME is not trading/.test(halted));

// A conversion-type class (same ticker as its parent) is a relabelling of the
// company's own stock. There is nothing to convert INTO, and offering it would
// mean swapping a share for itself.
setup();DB.shareClasses=[{ticker:'ACME',parent_ticker:'ACME',class:'B',conversion_ratio:1}];
check('a reclassified base stock offers no conversion',
      renderConversionPanel(getCo('ACME'),stu({ACME:100}))==='');

console.log('\n=== convertShareClass refuses before it spends a round trip ===');
// Everything below must be caught client-side. The RPC re-checks all of it --
// it is the security boundary, not this -- but a student who typed 999 should
// be told so instead of watching a spinner.
const conv=grabFn('convertShareClass');
check('it refuses a non-class ticker', /is not a convertible share class/.test(conv));
check('it refuses a class whose ticker IS its parent',
      /meta\.ticker===meta\.parent_ticker/.test(conv));
check('it refuses when the parent is not listed', /is not trading/.test(conv));
check('it refuses zero or garbage quantities', /Enter how many/.test(conv));
check('it refuses more than the holder owns', /qty>held/.test(conv));
check('it refuses a fraction', /qty\*r!==Math\.floor\(qty\*r\)/.test(conv));
check('it refuses while halted', /isHalted\(ticker\)\|\|isHalted\(meta\.parent_ticker\)/.test(conv));
check('it confirms before acting, and says it is one way',
      /confirm\('Convert '[\s\S]{0,200}?one way/.test(conv));
check('the confirm comes BEFORE the RPC call',
      conv.indexOf('confirm(')<conv.indexOf("sb.rpc('rpc_convert_share_class'"));
check('it rate-limits, like every other order path',
      /checkRateLimit\(u\.id,'trades'\)/.test(conv));
check('...after the confirm, so cancelling costs nothing',
      conv.indexOf('confirm(')<conv.indexOf('checkRateLimit'));

// The RPC is the boundary; the client only applies what comes back.
check('it sends only the ticker and quantity -- the holder is derived server-side',
      /sb\.rpc\('rpc_convert_share_class',\{p_ticker:ticker,p_qty:qty\}\)/.test(conv));
check('it surfaces an RPC error as a toast rather than throwing',
      /catch\(e\)\{return toast\(rpcErrorMessage\(e\)\)/.test(conv));
// Applied by the id the RPC reports, not by cu() -- the same bug that once
// overwrote a founder's balance with their company's.
check('it applies the result to the user the RPC names',
      /getUser\(r2\.user_id\)/.test(conv));
check('it takes the holdings the server returned rather than re-deriving them',
      /holder\.holdings=r2\.holdings/.test(conv));
check('it updates both share counts from the RPC result',
      /cls\.shares=r2\.class_shares/.test(conv)&&/parent\.shares=r2\.parent_shares/.test(conv));
check('it touches neither price -- a conversion is a swap, not a dilution',
      !/\.price=/.test(conv));
check('it logs the conversion to the audit trail', /logActivity\('class_convert'/.test(conv));

console.log('\n=== the shareholders table ===');
// Summing raw share counts across classes is a mixed unit the moment a ratio is
// anything but 1: ten ACME plus ten ACME.B at ratio 5 is not "20 shares", and
// the dividend does not pay it as 20.
bindFn('shareholderTableHTML');
setup();
const sh=[{name:'Robin',shares:{ACME:10,'ACME.B':10}}];
let table=shareholderTableHTML(sh,['ACME','ACME.B']);
check('the total is base equivalents when a ratio is in play', /<td class="r" style="font-weight:500">60<\/td>/.test(table), table);
check('...and the header says so', /Total \(base equiv\.\)/.test(table));
check('the per-class columns stay raw counts', /">10<\/td>/.test(table));

// With no ratios anywhere it must print exactly what it printed before, header
// included -- this table is on every company page, most of which have no
// classes at all.
DB.shareClasses=[{ticker:'ACME.B',parent_ticker:'ACME',conversion_ratio:1}];
table=shareholderTableHTML(sh,['ACME','ACME.B']);
check('a 1:1 exchange still totals 20', /<td class="r" style="font-weight:500">20<\/td>/.test(table), table);
check('...and the header is unchanged', /<th class="r">Total<\/th>/.test(table)&&!/base equiv/.test(table));

// Voting power is votes_per_share, NOT the ratio. They are deliberately
// separate: a Class B can carry ten votes and convert 1:1, or one vote and
// convert 5:1. Weighting votes by the ratio would silently conflate them.
DB.shareClasses=[{ticker:'ACME.B',parent_ticker:'ACME',conversion_ratio:5,votes_per_share:10}];
table=shareholderTableHTML(sh,['ACME','ACME.B']);
check('voting power uses votes_per_share, not the conversion ratio',
      /<td class="r" style="color:var\(--amber\)">110<\/td>/.test(table), table);   // 10*1 + 10*10

check('the table is written once, not once per render path',
      (src.match(/<th class="r">Voting power<\/th>/g)||[]).length===1);
check('both render paths call it',
      (src.match(/shareholderTableHTML\(/g)||[]).length===3);   // 1 definition + 2 call sites

console.log('\n=== the ratio is visible everywhere a class is ===');
for(const [rx,label] of [
  [/converts to '\+ratioLabel\(c,co\.ticker\)/, 'the company Classes tab'],
  [/converts to '\+ratioLabel\(Number\(a\.conversion_ratio\)\|\|1,a\.parent_ticker\)/, 'the application history'],
  [/converts to '\+ratioLabel\(r,a\.parent_ticker\)/, "the Chairman's pending queue"],
  [/converts to '\+ratioLabel\(c,c\.parent_ticker\)/, 'the admin share-class list'],
  [/converts to '\+ratioLabel\(meta,meta\.parent_ticker\)/, 'the company page overview'],
]) check(label+' shows the ratio', rx.test(src), label);

// The Chairman is the one making the decision, and the price is derived at the
// moment they click Approve -- so the queue has to show what approving NOW
// would list it at, not the number filed days ago.
check("the Chairman's queue prices the application at today's parent price",
      /lists at '\+at[\s\S]{0,200}?as of now/.test(src));

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll conversion-rights checks passed.'));
process.exit(fails?1:0);
