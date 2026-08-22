// Admin controls that claim to be off must actually be off.
//
// Two settings in the admin panel have a Disable button, and both wrote null
// while their reader defaulted the null straight back to the original number:
//
//   circuit_breaker_pct   client: `DB.session.circuit_breaker_pct||20`
//   price_band_pct        server: `coalesce(v_band_pct,30)`
//
// So pressing Disable changed the label to "disabled" and changed nothing
// else. The breaker went on halting at 20%, the band went on rejecting at
// 30%. This is a nastier shape than an ordinary bug: the instructor is told
// the rule is off, so when a stock halts anyway the app looks broken in some
// other way entirely, and the one setting that would explain it has already
// been ruled out.
//
// The `||` and `coalesce` are not wrong in themselves -- they are the right
// default for "this session row predates the setting". They are wrong once
// null is ALSO the value that means "off", because then one value has two
// meanings and the reader cannot tell them apart. That is the thing this
// suite pins down.
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

// ── behavioural: disabled means no halts ──
let halted=[];
global.isOpen=()=>true;
global.isHalted=t=>halted.includes(t);
global.haltStock=async(t)=>{halted.push(t);};
global.toast=()=>{};
global.sb={get:async()=>[]};
global.pushNotification=async()=>{};
global.logActivity=async()=>{};
global.render=()=>{};

eval(grabFn('checkCircuitBreakers'));

// A stock 40% below session open -- far past any plausible threshold, and
// DOWNWARD, which is the direction the price band does not cover.
function scenario(breakerPct){
  halted=[];
  global.DB={
    session:{status:'open', circuit_breaker_pct:breakerPct,
             session_open_prices:{ACME:10}, circuit_cooldowns:{}},
    companies:[{ticker:'ACME', price:6}],
    halts:[],
  };
}

(async()=>{
scenario(20);
await checkCircuitBreakers();
check('an enabled breaker halts a 40% move', halted.includes('ACME'));

scenario(null);
await checkCircuitBreakers();
check('a DISABLED breaker (null) halts nothing', !halted.includes('ACME'),
      'halted anyway: the Disable button does not disable');

scenario(0);
await checkCircuitBreakers();
check('a zero threshold is also treated as disabled', !halted.includes('ACME'));

scenario(50);
await checkCircuitBreakers();
check('a 40% move does not trip a 50% threshold', !halted.includes('ACME'));

// The breaker is symmetric: it is what actually bounds DOWNWARD moves, since
// the server-side price band is only checked on buy-side RPCs. If this ever
// became one-directional, the downside would have no limit at all.
scenario(20);
DB.companies[0].price=14;      // +40%
await checkCircuitBreakers();
check('the breaker is symmetric -- it halts upward moves too', halted.includes('ACME'));

// ── static: no reader may default the "off" value back on ──
//
// Comments are stripped first. Both of these checks failed on their first run
// against the FIX, not against the bug -- they were matching the comment that
// quotes the old `circuit_breaker_pct||20` to explain why it was wrong. A
// static check that reads prose is a static check that can be argued with.
const stripComments=t=>t.replace(/\/\*[\s\S]*?\*\//g,' ')
  .split('\n').map(l=>/^\s*\/\//.test(l)?'':l).join('\n');
const code=stripComments(src);
const body=stripComments(grabFn('checkCircuitBreakers'));
check('checkCircuitBreakers does not resurrect a null threshold',
      !/circuit_breaker_pct\s*\|\|/.test(body),
      'found a `||` fallback, which turns Disable back into a live threshold');
check('checkCircuitBreakers returns early when disabled',
      /if\(!threshold\)return;/.test(body));

// Same trap, anywhere else in the client.
const revived=[...code.matchAll(/^.*(circuit_breaker_pct|price_band_pct)\s*\|\|\s*\d+.*$/gm)]
  .map(m=>m[0].trim())
  // The DB.session literal's own defaults are fine: that is the pre-load
  // placeholder, not a reader deciding whether the rule is on.
  .filter(l=>!/^session:\{id:1/.test(l))
  // Admin-panel input values legitimately show a number when unset.
  .filter(l=>!/id="cb-pct"|id="band-pct"/.test(l));
check('no other client reader defaults a disabled setting back on',
      revived.length===0, revived.join('\n    '));

console.log(fails?('\n'+fails+' FAILURE(S)'):'\nAll disable-control checks passed.');
process.exit(fails?1:0);
})();
