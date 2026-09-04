// The little price line on every market row.
//
// It used to be a Chart.js instance per listed company, rebuilt on EVERY market
// render -- every click, every realtime trade anyone in the room made, every
// autoRefresh -- because render() rebuilds app.innerHTML wholesale and takes
// every <canvas> with it. Thirteen companies meant thirteen chart
// constructions and thirteen destructions per repaint, each one building
// scales, controllers and a resize observer before drawing a pixel.
//
// Nothing in a 100x36 sparkline needs a charting library, so it is inline SVG
// now: a stroked path in the row markup, drawn once and cached until the data
// behind it changes. What that has to keep is not the pixels -- it is the
// MEANING, which is what this suite pins:
//
//   * green when today is up, red when down, grey when flat, matching the
//     %-change in the cell beside it;
//   * the same "today" window as everything else on the row (anchored to
//     session open, not a rolling 24 hours);
//   * a flat line, not an empty box, before the first trade of a session;
//   * nothing that can break the row it is embedded in.
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

global.DB={session:{session_started_at:null},companies:[]};
eval(grabConst('SPARK_W').replace(/^const /,'global.SPARK_W=undefined;var '));
eval(grabConst('_ptMs').replace(/^const /,'global.'));
global._sparkCache=new Map();
eval(grabFn('ptMs'));
eval(grabFn('filterByInterval'));
eval(grabFn('anchorToSessionOpen'));
eval(grabFn('drawSparkline'));
eval(grabFn('sparklineSVG'));

const T=n=>new Date(Date.UTC(2026,7,25,12,0,n)).toISOString();
const co=(ticker,prices,extra)=>Object.assign({ticker,price:prices[prices.length-1],
  price_history:prices.map((p,i)=>({p,t:T(i)}))},extra||{});
const colorOf=svg=>(/stroke="(#[0-9a-f]{6})"/.exec(svg)||[])[1];
const UP='#00c896',DOWN='#ff4d6a',FLAT='#8896a8';
const fresh=()=>{_sparkCache.clear();};

// ── the colour has to agree with the number next to it ──
fresh();
let svg=sparklineSVG(co('UP',[10,12,15]));
check('a rising series draws green', colorOf(svg)===UP, colorOf(svg));
fresh();
svg=sparklineSVG(co('DN',[15,12,10]));
check('a falling series draws red', colorOf(svg)===DOWN, colorOf(svg));
fresh();
svg=sparklineSVG(co('FL',[10,12,10]));
check('a series that ends where it started draws grey', colorOf(svg)===FLAT, colorOf(svg));
// Ends higher after dipping: still up. The colour is first-vs-last, exactly
// like priceChg(), not "the last tick".
fresh();
svg=sparklineSVG(co('DIP',[10,5,11]));
check('a dip that recovers is still green', colorOf(svg)===UP, colorOf(svg));

// ── it is valid, self-contained SVG ──
fresh();
svg=sparklineSVG(co('ACME',[10,11,12,11,13]));
check('it is an svg element', /^<svg /.test(svg)&&/<\/svg>$/.test(svg), svg.slice(0,40));
check('...at the row size', /width="100"/.test(svg)&&/height="36"/.test(svg));
check('...containing exactly one path', (svg.match(/<path /g)||[]).length===1);
check('...that is stroked, not filled', /fill="none"/.test(svg));
check('...with no unclosed tag or stray quote',
      (svg.match(/</g)||[]).length===(svg.match(/>/g)||[]).length,
      svg);
check('...and no script or event handler in it',
      !/<script|on[a-z]+=/i.test(svg), svg);

// Every coordinate must be a real number. One NaN in a path makes the browser
// drop the whole path silently -- an empty cell with no error anywhere.
const d=(/ d="([^"]*)"/.exec(svg)||[])[1]||'';
const coords=(d.match(/-?[0-9]*\.?[0-9]+/g)||[]);
check('the path has coordinates at all', coords.length>=4, String(coords.length));
check('every coordinate is finite', coords.every(c=>Number.isFinite(parseFloat(c))),
      coords.filter(c=>!Number.isFinite(parseFloat(c))).join(','));
check('...and inside the 100x36 box',
      coords.every(c=>{const v=parseFloat(c);return v>=-10&&v<=110;}),
      coords.filter(c=>{const v=parseFloat(c);return v<-10||v>110;}).join(','));
check('no NaN reaches the path', !/NaN|Infinity|undefined/.test(svg), svg);

// ── the shapes that used to be empty boxes ──
fresh();
check('a company with no history still draws something',
      /<path /.test(sparklineSVG({ticker:'NEW',price:20,price_history:[]})));
fresh();
check('...and one with a single point too',
      /<path /.test(sparklineSVG(co('ONE',[20]))));
fresh();
check('...and one with a null history',
      /<path /.test(sparklineSVG({ticker:'NUL',price:5,price_history:null})));
fresh();
svg=sparklineSVG(co('ONE',[20]));
check('a single point draws flat grey, not a diagonal',
      colorOf(svg)===FLAT, colorOf(svg));

// A price of zero must not divide by zero or vanish.
fresh();
svg=sparklineSVG(co('ZERO',[0,0]));
check('an all-zero series does not produce NaN', !/NaN/.test(svg), svg);

// ── the same "today" window as the rest of the row ──
// anchorToSessionOpen keeps the last point BEFORE the session opened as the
// open reference, plus everything since. A sparkline drawn over all of
// history instead would show yesterday's move on today's row.
fresh();
const hist=[{p:100,t:T(1)},{p:50,t:T(2)},{p:52,t:T(3)},{p:54,t:T(4)}];
DB.session.session_started_at=Date.parse(T(3));
svg=sparklineSVG({ticker:'SESS',price:54,price_history:hist});
check('the session window is used, so a pre-open crash is not today\'s move',
      colorOf(svg)===UP, colorOf(svg));
DB.session.session_started_at=null;
fresh();
svg=sparklineSVG({ticker:'SESS',price:54,price_history:hist});
check('...while with no session open it spans what it has',
      colorOf(svg)===DOWN, colorOf(svg));

// ── a term of history is sampled down, not drawn point by point ──
// A hundred pixels cannot show 3000 points, and emitting 3000 curve segments
// per row is most of what made the old version expensive.
fresh();
const long=[];for(let i=0;i<3000;i++)long.push(10+Math.sin(i/50)*3);
svg=sparklineSVG(co('LONG',long));
const segs=(svg.match(/C/g)||[]).length;
check('a 3000-point history is sampled down', segs<100, segs+' segments');
check('...and still ends on the real last price',
      colorOf(svg)===(long[long.length-1]>=long[0]?UP:DOWN), colorOf(svg));
check('...without a giant path string', svg.length<6000, String(svg.length));

// ── the cache must not outlive the data ──
fresh();
const c1=co('CACHE',[10,11]);
const first=sparklineSVG(c1);
check('the same data returns the same drawing', sparklineSVG(c1)===first);
// A trade arrives: one more point.
c1.price_history=c1.price_history.concat([{p:30,t:T(9)}]);c1.price=30;
check('a new price point redraws it', sparklineSVG(c1)!==first);
// A price change with the SAME number of points (the server rewrote the last
// one) must also redraw -- the fingerprint carries the latest point itself.
const before=sparklineSVG(c1);
c1.price_history=c1.price_history.slice(0,-1).concat([{p:1,t:T(9)}]);c1.price=1;
check('a rewritten last point redraws it', sparklineSVG(c1)!==before);
check('...and flips the colour', colorOf(sparklineSVG(c1))===DOWN);
// Opening a new session changes the window even when no price moved.
const steady=co('STEADY',[10,20,30]);
const preSession=sparklineSVG(steady);
DB.session.session_started_at=Date.parse(T(2));
check('opening a session redraws the window', sparklineSVG(steady)!==preSession);
DB.session.session_started_at=null;

// Two companies must not share a cache entry.
fresh();
const a=sparklineSVG(co('AAA',[10,20]));
const b=sparklineSVG(co('BBB',[20,10]));
check('each ticker gets its own drawing', colorOf(a)===UP&&colorOf(b)===DOWN,
      colorOf(a)+'/'+colorOf(b));

// ── and Chart.js is no longer involved ──
check('no sparkline Chart instance is built any more',
      !/charts\['spark-/.test(src)&&!/buildSparklines/.test(src));
check('the market row embeds the svg directly',
      /<td>\$\{sparklineSVG\(c\)\}<\/td>/.test(src));

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll sparkline checks passed.'));
process.exit(fails?1:0);
