// Every page must load the CURRENT app.js and app.css.
//
// GitHub Pages serves both with a cache lifetime, and school networks add
// proxies of their own. For a normal week that is fine. It is not fine while
// fixes are being pushed to a live graded exchange: a student can keep running
// the previous app.js against a database that has already moved on, and a
// client and server that disagree about the rules is the exact failure this
// project has spent the most effort eliminating.
//
// tools/cachebust.js stamps a content hash into each page's asset tags, so a
// changed file is a different URL and cannot be served from cache, while an
// unchanged file keeps its hash and stays cached.
//
// Running that by hand means eventually forgetting to. A stale stamp is worse
// than no stamp, because it looks deliberate -- so this recomputes the hashes
// and fails if any page disagrees. Fix with:
//
//     node tools/cachebust.js
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.join(__dirname,'..');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

const hash=f=>crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(root,f)))
  .digest('hex').slice(0,10);

const jsV=hash('app.js'), cssV=hash('app.css');
const pages=fs.readdirSync(root).filter(f=>f.endsWith('.html')).sort();

check('there are pages to check', pages.length>0);

// Pages that actually load the app, found by looking rather than by a list --
// a new page added later is covered without anyone remembering to add it here.
const loaders=pages.filter(p=>{
  const h=fs.readFileSync(path.join(root,p),'utf8');
  return /<script\s+src="app\.js(\?[^"]*)?">/.test(h);
});
check('the app pages were found', loaders.length>=12, loaders.length+' found');

for(const page of loaders){
  const html=fs.readFileSync(path.join(root,page),'utf8');
  const js=html.match(/<script\s+src="app\.js(\?v=([a-f0-9]+))?">/);
  const css=html.match(/<link\s+rel="stylesheet"\s+href="app\.css(\?v=([a-f0-9]+))?">/);
  check(page+' stamps app.js with the current hash',
        js && js[2]===jsV, js?('has '+(js[2]||'no stamp')+', expected '+jsV):'no app.js tag');
  check(page+' stamps app.css with the current hash',
        css && css[2]===cssV, css?('has '+(css[2]||'no stamp')+', expected '+cssV):'no app.css tag');
}

// 404.html discusses both filenames in a comment and loads neither. An earlier
// version of the stamper matched on the attribute alone and rewrote that
// comment, leaving it quietly describing something untrue. Pin that.
const notfound=fs.readFileSync(path.join(root,'404.html'),'utf8');
check('404.html still loads neither asset',
      !/<script\s+src="app\.js/.test(notfound) && !/<link\s+rel="stylesheet"\s+href="app\.css/.test(notfound),
      '404.html is meant to be self-contained');
check('...and its comment was not rewritten by the stamper',
      !/app\.(js|css)\?v=/.test(notfound),
      'the stamper edited prose in 404.html');

// The stamper must be idempotent and must agree with this test, or the two
// drift and the suite starts lying.
const before=loaders.map(p=>fs.readFileSync(path.join(root,p),'utf8'));
let checkOut='',checkOk=true;
try{
  // execFileSync THROWS on a non-zero exit. Catching it is the point: when the
  // stamps are stale this must report a failed check, not die with a stack
  // trace that buries the twelve real failures above it.
  checkOut=require('child_process').execFileSync(process.execPath,
    [path.join(root,'tools','cachebust.js'),'--check'],{stdio:'pipe'}).toString();
}catch(e){
  checkOk=false;
  checkOut=((e.stdout||'')+(e.stderr||'')).toString();
}
const after=loaders.map(p=>fs.readFileSync(path.join(root,p),'utf8'));
check('the stamper agrees nothing is stale', checkOk, checkOut.trim());
check('...and --check changed no file',
      before.every((b,i)=>b===after[i]), 'a --check run wrote to disk');

console.log(fails?('\n'+fails+' check(s) failed -- run: node tools/cachebust.js'):'\nall checks passed');
process.exit(fails?1:0);
