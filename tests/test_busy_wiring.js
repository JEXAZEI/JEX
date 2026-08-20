// Every busy()-wrapped onclick must (a) parse as JS once the browser decodes
// the HTML entities, and (b) call a handler that returns a promise -- a
// fire-and-forget handler makes busy() re-enable the button instantly, so the
// guard would look wired up while doing nothing.
const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync(require('path').join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

const decode=s=>s.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');

// Pull every onclick="busy(...)" attribute out of the source.
const attrs=[...src.matchAll(/onclick="(busy\(this,[^"]*)"/g)].map(m=>m[1]);
check('found the wrapped handlers', attrs.length>=30, 'found '+attrs.length);

console.log('\n=== every wrapped onclick parses as JS ===');
let bad=[];
for(const a of attrs){
  // The surrounding source may be a JS string built by concatenation, e.g.
  // ...&quot;'+ticker+'&quot;... -- substitute a literal for the spliced value
  // so the handler body can be parsed on its own.
  const js=decode(a).replace(/'\s*\+[^+]+\+\s*'/g,'X');
  try{new vm.Script('(function(){'+js+'})');}catch(e){bad.push({js:js.slice(0,90),err:e.message});}
}
check('no wrapped onclick is a syntax error', bad.length===0, JSON.stringify(bad.slice(0,3),null,1));

console.log('\n=== label quoting ===');
check('no label uses bare single quotes (breaks inside \'...\' concatenation)',
  !/busy\(this,'/.test(src), "found busy(this,'");
check('all labels use &quot;', attrs.every(a=>/busy\(this,&quot;/.test(a)));

console.log('\n=== every wrapped handler returns a promise ===');
const names=new Set();
for(const a of attrs){
  let m=/\(\)=>([a-zA-Z_]+)\(/.exec(a)||/busy\(this,&quot;[^&]*&quot;,([a-zA-Z_]+)\)/.exec(a);
  if(m)names.add(m[1]);
}
check('extracted a handler name from every wrapped onclick', names.size>0);
const noPromise=[];
for(const n of names){
  if(new RegExp('^async function '+n+'\\(','m').test(src))continue;
  const body=new RegExp('^function '+n+'\\([^)]*\\)\\{[\\s\\S]*?\\n\\}','m').exec(src);
  // Any `return someCall(...)` counts, wherever it sits on the line -- these
  // dispatch as `if(mode==='buy')return placeBuy(...)`, so requiring return to
  // start the line missed them. `return toast(...)` is excluded: it is the
  // early-out for validation failures and returns undefined, so it says
  // nothing about whether the real work is handed back to busy().
  if(body&&/\breturn (?!toast\b)[a-z]\w*\(/.test(body[0]))continue;
  noPromise.push(n);
}
check('no wrapped handler is fire-and-forget', noPromise.length===0, noPromise.join(', '));
console.log('   ('+names.size+' distinct handlers wrapped)');

console.log('\n=== the earlier breakage cannot recur ===');
check('no onclick contains an unescaped quote that would end its attribute',
  !/onclick="[^"]*busy\(this,'[^']*'/.test(src));

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
