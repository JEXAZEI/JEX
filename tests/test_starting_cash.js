// "vs Start" must be measured against what students actually started with.
//
// The Chairman sets the starting allocation per session, and it is passed to
// approve_registration when each student is approved. But every "vs Start"
// figure in the app hardcoded 10000 regardless:
//
//   the leaderboard's up/down colour
//   the Balances table's vs Start column
//   the Balances CSV that gets EXPORTED FOR GRADING
//   the average-net-worth colour
//   the Portfolio page's "vs Starting cash" card
//   the PDF report
//
// With a session set to 600, every one of those was wrong by 9400 -- and the
// CSV is the graded artifact, so it was the worst place for it to be wrong. A
// student who doubled their money would export as down 8800.
//
// One helper now, read from the session. This file pins that none of them
// drift back to a literal.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

check('the helper exists', /const startingCash=\(\)=>\{/.test(src));
check('...it reads the session setting', /DB\.session&&DB\.session\.starting_cash/.test(src));
check('...and falls back to 10000 only when unusable',
      /return v>0\?v:10000;/.test(src), 'a zero or missing setting must not make every figure NaN');

// ── no "vs start" comparison may use a literal any more ──
//
// Matched narrowly: the point is net worth compared against a bare 10000, not
// every appearance of the number. `*10000)/10000` is four-decimal NAV rounding
// in fundNav() and is none of this file's business.
const offenders=[];
for(const m of src.matchAll(/[^\n]*10000[^\n]*/g)){
  const line=m[0];
  if(/\*10000\)\/10000/.test(line))continue;              // NAV rounding
  if(/starting_cash/.test(line))continue;                  // the helper itself
  if(/return v>0\?v:10000;/.test(line))continue;           // the fallback
  if(/placeholder="10000"/.test(line))continue;            // a form hint
  if(/^\s*\/\//.test(line))continue;                       // a comment
  // A net-worth comparison looks like nw-10000 or nw>=10000.
  if(/(nw|_nw|net)\s*[-><=]+\s*10000/i.test(line)||/10000\s*[-><=]+\s*(nw|_nw)/i.test(line))
    offenders.push(line.trim().slice(0,90));
}
check('no net-worth figure still compares against a hardcoded 10000',
      offenders.length===0, JSON.stringify(offenders));

// ── the sites that had to change ──
for(const [what,re] of [
  ['the leaderboard colour', /\(u\.nw\|\|u\._nw\|\|0\)>=startingCash\(\)/],
  ['the Balances vs Start column', /const vs=r\.nw-startingCash\(\)/],
  ['the graded CSV', /\(r\.nw-startingCash\(\)\)\.toFixed\(2\)/],
  ['the average-net-worth colour', /rows\.length>=startingCash\(\)/],
  ['the Portfolio card', /_nw-startingCash\(\)>=0/],
  ['the PDF report', /u\._nw-startingCash\(\)/],
  ['the leaderboard row builder', /nw\(u\)-startingCash\(\)/],
]){
  check(what+' uses the helper', re.test(src), 'still hardcoded');
}

// The exported column has to say what it is measured against, or a session
// that is not 10000 produces a column nobody can interpret later.
check('the CSV header names the baseline it measured against',
      /'vs Start \('\+fmt\(startingCash\(\)\)\+'\)'/.test(src),
      'the header still just says "vs Start"');

// ── behaviour ──
const m=/const startingCash=\(\)=>\{[\s\S]*?\n\};/.exec(src);
check('the helper was extractable', !!m);
global.DB={session:{starting_cash:600}};
eval(m[0].replace('const startingCash=','global.startingCash='));
check('a 600 session reports 600', startingCash()===600, String(startingCash()));
global.DB={session:{starting_cash:10000}};
check('a 10000 session reports 10000', startingCash()===10000, String(startingCash()));
global.DB={session:{}};
check('a missing setting falls back to 10000', startingCash()===10000, String(startingCash()));
global.DB={session:{starting_cash:0}};
check('a zero setting falls back rather than making every figure the raw total',
      startingCash()===10000, String(startingCash()));
global.DB={session:{starting_cash:'750'}};
check('a numeric string is coerced, not concatenated',
      startingCash()===750, String(startingCash()));
global.DB={};
check('no session at all does not throw', startingCash()===10000, String(startingCash()));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
