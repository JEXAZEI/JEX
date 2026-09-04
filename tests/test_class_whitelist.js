// Who can see and trade a restricted share class.
//
// The database just told us this whole feature has never run once:
//
//     applications_ever: 0
//
// rpc_submit_class_application takes p_whitelist as text[] and inserted it
// straight into a jsonb column, and Postgres has no implicit cast between
// those, so EVERY application was rejected before the statement ran -- with or
// without a whitelist, new class or conversion. fix_class_application_whitelist
// .sql adds to_jsonb() and the count above confirms nothing had ever got
// through.
//
// Which means every reader of this column is about to run against live data for
// the first time, and the one share class that does exist was created by some
// other route with a whitelist none of this code has ever seen.
//
// The shape matters more than it looks. '{}'::jsonb is an empty OBJECT, not an
// empty array -- and that was the DEFAULT in the broken insert. ({}).includes
// is undefined and ({}).map throws. canAccessTicker() is called from
// renderTickerBar() and getMarketListed() on every single render, so a
// whitelist of the wrong shape is not a broken tab, it is a blank page for
// everyone.
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
  const m=new RegExp('^const '+name+'=','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  let depth=0;
  for(let i=m.index;i<src.length;i++){
    const c=src[i];
    if('([{'.includes(c))depth++;
    else if(')]}'.includes(c))depth--;
    else if(c===';'&&depth===0)return src.slice(m.index,i+1);
  }
  throw new Error('unterminated: '+name);
}

const USERS={'u-stu':{id:'u-stu',role:'student'},'u-other':{id:'u-other',role:'student'},
             'u-chair':{id:'u-chair',role:'chairman'}};
global.DB={shareClasses:[]};
global.getUser=id=>USERS[id]||null;
global.isAdmin=u=>!!u&&(u.role==='chairman'||u.role==='president');
eval(grabFn('getClassMeta'));
eval(grabConst('classWhitelist').replace(/^const /,'global.'));
eval(grabFn('canAccessTicker'));

const cls=(whitelist,restricted)=>{
  DB.shareClasses=[{ticker:'ACME.B',parent_ticker:'ACME',class:'B',
    votes_per_share:5,restricted:restricted!==false,whitelist}];
};

// ── the shape the broken default would have written ──
cls({});
check('an empty jsonb OBJECT does not throw', (()=>{try{canAccessTicker('ACME.B','u-stu');return true;}catch(e){return false;}})());
check('...and admits nobody', canAccessTicker('ACME.B','u-stu')===false);
check('...while still letting an admin through', canAccessTicker('ACME.B','u-chair')===true);
check('classWhitelist turns it into an array', Array.isArray(classWhitelist({whitelist:{}})));

// An array that made a round trip through something that keyed it by index.
cls({'0':'u-stu','1':'u-other'});
check('an index-keyed object is read as the list it was',
      canAccessTicker('ACME.B','u-stu')===true&&canAccessTicker('ACME.B','u-other')===true);
check('...and still excludes anyone not in it',
      canAccessTicker('ACME.B','u-nobody')===false);

// ── the shape the fix actually writes: a jsonb array ──
cls(['u-stu']);
check('a whitelisted student gets access', canAccessTicker('ACME.B','u-stu')===true);
check('...and everyone else does not', canAccessTicker('ACME.B','u-other')===false);
cls([]);
check('an empty array admits nobody', canAccessTicker('ACME.B','u-stu')===false);

// ── nulls the column permits ──
for(const [label,w] of [['null',null],['undefined',undefined],['a string','u-stu'],
                        ['a number',7],['a boolean',true]]){
  cls(w);
  let threw=false,out=null;
  try{out=canAccessTicker('ACME.B','u-stu');}catch(e){threw=true;}
  check('a whitelist of '+label+' does not throw', !threw);
  check('...and fails closed', out===false, String(out));
}
// A bare string must not be read as a list of its characters, and must not
// match by substring.
cls('u-student-extra');
check('a string whitelist does not match by substring',
      canAccessTicker('ACME.B','u-stu')===false);

// ── an unrestricted class, and a base ticker ──
cls(['u-stu'],false);
check('an unrestricted class is open to everyone', canAccessTicker('ACME.B','u-other')===true);
DB.shareClasses=[];
check('a ticker with no class metadata is always accessible',
      canAccessTicker('ACME','u-other')===true);
check('...even signed out', canAccessTicker('ACME',null)===true);
cls(['u-stu']);
check('a restricted class is closed when signed out',
      canAccessTicker('ACME.B',null)===false);

// ── and nothing reads the column raw any more ──
// .length on an object is undefined ("undefined whitelisted") and .map on one
// throws, which takes the Share classes tab down with it.
check('no reader touches .whitelist without going through the helper',
      !/\.whitelist\s*\|\|\s*\[\]/.test(src),
      (src.match(/.{0,40}\.whitelist\s*\|\|\s*\[\].{0,20}/g)||[]).join(' ~ '));
check('the helper is used everywhere the column is displayed',
      (src.match(/classWhitelist\(/g)||[]).length>=6,
      String((src.match(/classWhitelist\(/g)||[]).length));

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll share-class whitelist checks passed.'));
process.exit(fails?1:0);
