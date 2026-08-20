// 404.html must render correctly no matter how deep the unmatched path is,
// because GitHub Pages serves it for every miss. That rules out relative
// asset references, and makes the link-rewriting logic load-bearing.
const fs=require('fs'),path=require('path'),vm=require('vm');
const raw=fs.readFileSync(path.join(__dirname,'..','404.html'),'utf8');
// Analyse real markup only. The file carries an explanatory comment that
// quotes `<link href="app.css">` as the thing it deliberately avoids, and
// naming Supabase as something it does not load -- matching those would be
// a false positive on the page's own documentation.
const html=raw.replace(/<!--[\s\S]*?-->/g,'');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

console.log('=== self-contained (survives a deep path) ===');
const relRefs=[...html.matchAll(/(?:src|href)="(?!https?:|\/|data:|#)([^"]+)"/g)].map(m=>m[1]);
check('no relative asset or link references', relRefs.length===0, relRefs.join(', '));
check('does not load app.css', !/href="[^"]*app\.css"/.test(html));
check('does not load app.js', !/src="[^"]*app\.js"/.test(html));
check('does not pull in Supabase', !/supabase/i.test(html));
check('styles are inlined', /<style>/.test(html));
check('favicon is a self-contained data: URI', /icon"\s+href="data:image\/svg/.test(html));
const ext=[...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m=>m[1]);
check('only external refs are Google Fonts (degrade to system-ui)',
  ext.every(u=>/fonts\.(googleapis|gstatic)\.com/.test(u)), ext.join(', '));
check('font stack falls back without the webfont', /system-ui/.test(html));

console.log('\n=== works with JavaScript disabled ===');
check('links have real hrefs in the markup', /href="\/JEX\/index\.html"/.test(html)&&/href="\/JEX\/portfolio\.html"/.test(html));
check('no-JS hrefs are absolute, not relative', !/href="index\.html"/.test(html));

console.log('\n=== the root-derivation script ===');
const script=/<script>([\s\S]*?)<\/script>/.exec(html)[1];
function runAt(pathname,hostname){
  const els={};
  const doc={getElementById:id=>els[id]||(els[id]={textContent:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;}})};
  const ctx={location:{pathname,hostname,search:''},document:Object.assign(doc,{body:{classList:{add(){}}}}),localStorage:{getItem:()=>null}};
  vm.createContext(ctx); new vm.Script(script).runInContext(ctx);
  return els;
}
let e=runAt('/JEX/nope','jexazei.github.io');
check('project page, shallow miss -> /JEX/', e['go-market'].attrs.href==='/JEX/index.html', e['go-market'].attrs.href);
e=runAt('/JEX/a/b/c/deep','jexazei.github.io');
check('project page, DEEP miss -> still /JEX/', e['go-market'].attrs.href==='/JEX/index.html', e['go-market'].attrs.href);
check('portfolio link rewritten too', e['go-portfolio'].attrs.href==='/JEX/portfolio.html', e['go-portfolio'].attrs.href);
e=runAt('/jex/Nope','jexazei.github.io');
check('repo segment matched case-insensitively', e['go-market'].attrs.href==='/jex/index.html', e['go-market'].attrs.href);
e=runAt('/nope','jex.example.com');
check('custom domain at root -> /', e['go-market'].attrs.href==='/index.html', e['go-market'].attrs.href);
e=runAt('/a/b/c','jex.example.com');
check('custom domain, deep miss -> /', e['go-market'].attrs.href==='/index.html', e['go-market'].attrs.href);

console.log('\n=== requested path is surfaced ===');
e=runAt('/JEX/typoed-page','jexazei.github.io');
check('shows what was actually requested', e['path'].textContent==='/JEX/typoed-page', e['path'].textContent);

console.log('\n=== theme + resilience ===');
check('honours the saved jex-theme key', /jex-theme/.test(script)&&/light-mode/.test(script));
check('light-mode palette is defined', /body\.light-mode\{/.test(html));
check('every script block is wrapped in try/catch', (script.match(/try\{/g)||[]).length>=3);
(()=>{ // a browser with localStorage blocked must not blank the page
  const els={};
  const ctx={location:{pathname:'/JEX/x',hostname:'jexazei.github.io',search:''},
    document:{getElementById:id=>els[id]||(els[id]={textContent:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;}}),body:{classList:{add(){}}}},
    localStorage:{getItem(){throw new Error('blocked');}}};
  vm.createContext(ctx);
  let threw=false;
  try{new vm.Script(script).runInContext(ctx);}catch(err){threw=true;}
  check('blocked localStorage does not throw', !threw);
  check('and the links are still rewritten', els['go-market'].attrs.href==='/JEX/index.html');
})();

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
