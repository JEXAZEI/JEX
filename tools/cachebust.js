#!/usr/bin/env node
// Stamps a content hash onto the app.js and app.css links in every page.
//
// ── Why ──
//
// GitHub Pages serves these with a short cache lifetime, and school networks
// add proxies of their own. That is fine for a normal week and not fine when a
// fix is being pushed to a live graded exchange: a student can keep running the
// previous app.js for as long as their cache holds it, against a database that
// has already moved on. Client and server disagreeing about the rules is the
// exact failure mode this project has spent a lot of effort eliminating.
//
// A hash in the query string means a changed file is a different URL, so the
// browser cannot serve the old one. An unchanged file keeps its hash and stays
// cached, which is the point -- this is not cache-defeating, it is
// cache-correctness.
//
// ── Why per file, not one shared version ──
//
// app.css changes rarely. Stamping both with a combined hash would re-download
// the stylesheet every time a line of JavaScript moved, on classroom wifi.
//
// ── Keeping it honest ──
//
// Running this by hand means forgetting to run it, and a stale stamp is worse
// than none: it looks deliberate. tests/test_cachebust.js recomputes the hashes
// and fails if any page disagrees, so the suite catches it before a deploy can.
//
//   node tools/cachebust.js          stamp the pages (prints what changed)
//   node tools/cachebust.js --check  report drift, change nothing, exit 1 if stale
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.join(__dirname,'..');
const checkOnly=process.argv.includes('--check');

const hash=f=>crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(root,f)))
  .digest('hex').slice(0,10);

// The two assets, and the attribute each is referenced by.
// Matched as WHOLE TAGS, not just as `href="app.css"`. An earlier version
// anchored on the attribute alone and stamped a reference inside a COMMENT in
// 404.html -- that page explains why it avoids a relative <link href="app.css">
// and does not load either asset. Rewriting prose is worse than not stamping:
// it leaves a comment quietly describing something untrue.
const ASSETS=[
  {file:'app.js',  re:/(<script\s+src=")app\.js(\?v=[a-f0-9]+)?("><\/script>)/g},
  {file:'app.css', re:/(<link\s+rel="stylesheet"\s+href=")app\.css(\?v=[a-f0-9]+)?(">)/g}
];

const pages=fs.readdirSync(root).filter(f=>f.endsWith('.html')).sort();
let changed=[],stale=[];

for(const page of pages){
  const p=path.join(root,page);
  let html=fs.readFileSync(p,'utf8'),before=html;
  for(const {file,re} of ASSETS){
    const v=hash(file);
    // Handles the bare tag and an already-stamped one, so re-running is
    // idempotent.
    html=html.replace(re,(m,a,cur,c)=>(cur===('?v='+v))?m:(a+file+'?v='+v+c));
  }
  if(html!==before){
    if(checkOnly)stale.push(page);
    else{fs.writeFileSync(p,html);changed.push(page);}
  }
}

if(checkOnly){
  if(stale.length){
    console.error('Stale cache-busting stamps in: '+stale.join(', '));
    console.error('Run: node tools/cachebust.js');
    process.exit(1);
  }
  console.log('All '+pages.length+' pages carry current stamps.');
} else {
  for(const {file} of ASSETS)console.log(file+' -> '+hash(file));
  console.log(changed.length?('stamped: '+changed.join(', ')):'nothing to change');
}
