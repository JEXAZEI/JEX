// preflight.sql's "fixes_still_applied" is only worth reading if every marker
// is text a migration actually put into the function. A marker that matches
// nothing reads `false` on a healthy database -- a false alarm five minutes
// before class -- and a marker copied from a comment reads `true` after the
// fix is gone.
//
// So each marker has to appear in some file under sql/ as executable text,
// i.e. on a line that is not a comment.
const fs=require('fs'),path=require('path');
const dir=path.join(__dirname,'..','sql');
const pre=fs.readFileSync(path.join(dir,'preflight.sql'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// Unescape a SQL literal body: '' -> '
const unq=s=>s.replace(/''/g,"'");
// Strip comment lines, then collapse the migrations' own quoting, so a marker
// can be found whether a file wrote it directly or inside a string literal.
const code=fs.readdirSync(dir).filter(f=>f.endsWith('.sql')&&f!=='preflight.sql')
  .map(f=>fs.readFileSync(path.join(dir,f),'utf8').split('\n')
    .filter(l=>!/^\s*--/.test(l)).join('\n'))
  .join('\n');
const haystack=code+'\n'+unq(code)+'\n'+unq(unq(code));

const block=pre.slice(pre.indexOf("'fixes_still_applied'"),pre.indexOf(') m(label, fn, marker)'));
const rows=[...block.matchAll(/\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*\)/g)]
  .map(m=>({label:unq(m[1]),fn:unq(m[2]),marker:unq(m[3])}));

check('the preflight lists 23 markers', rows.length===23, String(rows.length));
check('the header says how many there are', /Twenty-three markers/.test(pre));
for(const r of rows){
  check(r.fn+': "'+r.label+'" is text a migration really wrote', haystack.includes(r.marker), r.marker);
}

// The checks that are about data rather than a function body.
check('preflight flags any function still writing UTC times',
      /'functions_writing_utc_times'/.test(pre) && /p\.prosrc ~ 'to_char\\\(\\s\*now\\\(\\\)\\s\*,'/.test(pre));
check('...any dilution the chart would draw as a crash', /'unmarked_dilutions'/.test(pre));
check('...and a stale JXI open', /'jxi_open_is_honest'/.test(pre) && /index_open_from\(s\.session_open_prices/.test(pre));
check('preflight changes nothing: no insert, update, delete or DDL',
      !/^\s*(insert|update|delete|create|alter|drop|truncate)\b/im.test(pre.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n')));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
