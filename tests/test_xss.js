// Stored XSS guard.
//
// JEX builds HTML with template strings and innerHTML, and renders content
// one student typed to every other student. A single unescaped field is
// account takeover: a company owner puts a payload in a dividend note or a
// vote option, and it runs in the Chairman's browser.
//
// Two halves: esc() must actually neutralise payloads, and no render site
// may interpolate user-typed text without it. The second half is a static
// scan of app.js -- it is what stops this rotting again the next time
// someone adds a table.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── esc() itself ──
// Whole line, not /const esc=[^;]+;/ -- the definition's own replacement map
// contains "&amp;", so stopping at the first semicolon truncates it mid-string.
const escSrc=/^const esc=.*$/m.exec(src)[0];
eval(escSrc.replace('const ','var '));

console.log('=== esc() neutralises payloads ===');
const payloads=[
  ['<script>alert(1)</script>','script tag'],
  ['<img src=x onerror=alert(1)>','img onerror'],
  ['" onmouseover="alert(1)','attribute break-out (double quote)'],
  ["' onmouseover='alert(1)",'attribute break-out (single quote)'],
  ['</td><td><script>alert(1)</script>','table cell break-out'],
  ['<svg/onload=alert(1)>','svg onload'],
  ['javascript:alert(1)','javascript: URI'],
  ['&lt;script&gt;','already-encoded text'],
];
for(const [p,label] of payloads){
  const out=esc(p);
  check('escapes '+label, !/<[a-zA-Z/]/.test(out)&&!/"/.test(out)&&!/'/.test(out), JSON.stringify(out));
}
check('esc(null) is empty, not "null"', esc(null)==='');
check('esc(undefined) is empty', esc(undefined)==='');
check('esc(0) keeps the zero', esc(0)==='0');
check('ampersand escaped first (no double-encoding artefacts)', esc('&<')==='&amp;&lt;');
check('plain text is unchanged', esc('Acme Corp 2026')==='Acme Corp 2026');

// ── static scan: no unescaped user text in any render ──
console.log('\n=== no render site interpolates user text unescaped ===');
const USER_TEXT=/\.(?:name|company_name|user_name|student_name|flagged_by_name|requested_by_name|reviewed_by|resolved_by|description|reason|note|resolution_note|title|body|question|option1|option2|label|username|headline|summary|page_url|answer|message)\b/;
const SAFE=/\b(?:esc|fmt|fmtChg|Number|parseInt|parseFloat|Math\.\w+|encodeURIComponent|JSON\.stringify)\s*\(/;
const HTML=/<(?:div|span|td|tr|th|p|h[1-6]|li|option|button|strong|em|small|a|table|tbody|thead|section|label|input|textarea|img|br|hr)\b/i;

// These two only COMPARE r.reason to a literal and render fixed strings.
const ALLOW=[
  /r\.reason===['"]departed['"]\?/,
];

const bad=[];
src.split('\n').forEach((ln,i)=>{
  if(!(ln.includes('<')&&HTML.test(ln)))return;
  const exprs=[];
  for(const m of ln.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g))exprs.push(m[1]);
  for(const m of ln.matchAll(/'\s*\+\s*([^+]{1,120}?)\s*\+\s*'/g))exprs.push(m[1]);
  for(const raw of exprs){
    const e=raw.trim();
    if(!USER_TEXT.test(e))continue;
    if(SAFE.test(e))continue;
    if(ALLOW.some(rx=>rx.test(e)))continue;
    if(e.includes('`'))continue; // nested template: its own interpolations are scanned on their own line
    bad.push('line '+(i+1)+': '+e.slice(0,80));
  }
});
check('zero unescaped user-text render sites', bad.length===0, '\n     '+bad.join('\n     '));

console.log('\n=== second-hop sinks ===');
// User text also reaches the DOM indirectly: a payload typed into a vote
// question ends up inside a notification message, and inside an activity
// log description. Those sinks re-render it to OTHER users, so they have to
// escape even though the text was assembled elsewhere.
const sinks=[
  [/\$\{esc\(a\.description\)\}/,'activity log description'],
  [/\$\{esc\(n\.message\)\}/,'notification message'],
  [/\$\{esc\(n\.headline\)\}/,'news headline'],
  [/esc\(ann\.title\)/,'announcement title'],
  [/esc\(ann\.body\)/,'announcement body'],
];
for(const [rx,label] of sinks)check(label+' is escaped at render', rx.test(src), label);
// toast() must stay textContent-based -- switching it to innerHTML would
// reopen every message built by string concatenation at once.
check('toast() uses textContent, not innerHTML',
  /function toast\(msg\)\{[^}]*\.textContent=msg/.test(src)&&!/function toast\(msg\)\{[^}]*innerHTML/.test(src));

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
