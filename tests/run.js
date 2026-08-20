#!/usr/bin/env node
// JEX regression suite.
//
//   node tests/run.js            run everything
//   node tests/run.js beta pnl   run only suites whose name matches
//
// Each suite is a standalone script that exits non-zero on failure, so any
// of them can also be run directly: node tests/test_beta.js
//
// These are pure Node -- no browser, no network, no database. They work by
// reading app.js, extracting the function under test, and evaluating it
// against mocked dependencies. That means they verify the real shipped code
// rather than a copy, but it also means they cannot exercise anything that
// only exists server-side (the SQL RPCs) or in a browser (actual DOM
// rendering). Server-side behaviour has to be checked against the database.
const {execFileSync}=require('child_process');
const fs=require('fs'),path=require('path');

const dir=__dirname;
const filter=process.argv.slice(2);
const suites=fs.readdirSync(dir).filter(f=>/^test_.*\.js$/.test(f)).sort()
  .filter(f=>!filter.length||filter.some(q=>f.includes(q)));

if(!suites.length){console.error('No suites match: '+filter.join(' '));process.exit(1);}

let failed=[],passed=0,totalChecks=0;
for(const s of suites){
  let out='',ok=true;
  try{out=execFileSync(process.execPath,[path.join(dir,s)],{encoding:'utf8',stdio:['ignore','pipe','pipe']});}
  catch(e){ok=false;out=(e.stdout||'')+(e.stderr||'');}
  const checks=(out.match(/^PASS: /gm)||[]).length+(out.match(/^FAIL: /gm)||[]).length;
  totalChecks+=checks;
  if(ok){passed++;console.log(`  ok    ${s.padEnd(32)} ${checks} checks`);}
  else{
    failed.push(s);
    console.log(`  FAIL  ${s.padEnd(32)} ${checks} checks`);
    for(const line of out.split('\n'))if(/^FAIL: |Error|SyntaxError/.test(line))console.log('          '+line);
  }
}

console.log(`\n${passed}/${suites.length} suites passed, ${totalChecks} checks total`);
if(failed.length){console.log('failed: '+failed.join(', '));process.exit(1);}
