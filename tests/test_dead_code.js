// Reachability: nothing in app.js should be unreachable.
//
// Three functions had gone dead without anyone noticing, and one of them was
// not merely wasted space -- checkPriceBand() was the ONLY client-side reader
// of price_band_pct, while the admin panel went on offering the setting and
// telling the instructor it was "Active". Dead code is usually harmless; dead
// code that used to enforce a rule is a rule that quietly stopped being
// enforced. That is the reason this suite exists rather than tidiness.
//
// The analysis is a real call-graph walk, not a grep, because two earlier
// attempts at it were wrong in opposite directions:
//
//   - matching only `name(` missed every function passed as a REFERENCE
//     (setInterval(tickTimer,500), busy(el,label,doRegister)) and reported 15
//     false positives.
//   - not stripping comments counted a function that is only TALKED ABOUT as
//     live: disableTradeBtn looked reachable purely because its replacement's
//     comment named it.
//
// Both corrections are baked in below. Roots are the genuine entry points: an
// inline on*="..." handler anywhere in app.js or the static pages, a call from
// top-level code, or an explicit window.X assignment.
const fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const rawSrc=fs.readFileSync(path.join(ROOT,'app.js'),'utf8');
const html=fs.readdirSync(ROOT).filter(f=>f.endsWith('.html'))
  .map(f=>fs.readFileSync(path.join(ROOT,f),'utf8')).join('\n');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// Only FULL-LINE // comments are stripped, so a "https://" inside a string
// literal is never mistaken for the start of a comment.
function stripComments(t){
  t=t.replace(/\/\*[\s\S]*?\*\//g,' ');
  return t.split('\n').map(l=>/^\s*\/\//.test(l)?'':l).join('\n');
}
const src=stripComments(rawSrc);

const names=[...src.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)].map(m=>m[1]);
const set=new Set(names);
check('the parser found the functions in app.js', names.length>300, 'only '+names.length);

function bodyOf(name){
  const m=new RegExp('^(?:async )?function '+name.replace(/\$/g,'\\$')+'\\s*\\(','m').exec(src);
  if(!m)return {start:-1,end:-1,text:''};
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return {start:m.index,end:i+1,text:src.slice(m.index,i+1)};} }
  return {start:m.index,end:src.length,text:src.slice(m.index)};
}
const BODY={}; for(const n of names) BODY[n]=bodyOf(n);

// Top-level source: everything outside any function declaration.
const spans=names.map(n=>BODY[n]).filter(b=>b.start>=0).sort((a,b)=>a.start-b.start);
let top='',cur=0;
for(const s of spans){ if(s.start>cur) top+=src.slice(cur,s.start); cur=Math.max(cur,s.end); }
top+=src.slice(cur);

// Whole-identifier, not just calls -- so callbacks passed by reference count.
const refs=text=>{
  const out=new Set();
  for(const m of text.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)/g)) if(set.has(m[1])) out.add(m[1]);
  return out;
};

const roots=new Set();
for(const t of [src,html])
  for(const m of t.matchAll(/\bon[a-z]+\s*=\s*(["'`])([\s\S]*?)\1/g))
    for(const f of refs(m[2])) roots.add(f);
for(const f of refs(top)) roots.add(f);
for(const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) if(set.has(m[1])) roots.add(m[1]);

check('entry points were found', roots.size>50, 'only '+roots.size+' roots');

const live=new Set(roots), q=[...roots];
while(q.length){ const f=q.pop(); for(const c of refs(BODY[f]?BODY[f].text:'')) if(!live.has(c)){live.add(c);q.push(c);} }

const dead=names.filter(n=>!live.has(n));
check('no unreachable functions in app.js', dead.length===0,
      dead.length+' unreachable: '+dead.join(', '));

// The specific three that were removed must not come back. A resurrected
// name is a strong hint someone re-added the old implementation rather than
// wiring up the live one.
for(const gone of ['checkPriceBand','setupCoSwipe','disableTradeBtn'])
  check(gone+' stays deleted', !set.has(gone));

// checkPriceBand's removal is only correct because the rule lives server-side
// now. If a client-side reader of price_band_pct ever reappears, it must be
// reachable -- a second dead copy of a live rule is how this started.
const bandReaders=names.filter(n=>/price_band_pct/.test(BODY[n].text));
check('any client-side price-band reader is reachable',
      bandReaders.every(n=>live.has(n)),
      bandReaders.filter(n=>!live.has(n)).join(', '));

console.log(fails?('\n'+fails+' FAILURE(S)'):'\nAll reachability checks passed.');
process.exit(fails?1:0);
