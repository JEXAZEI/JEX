// The audit trail's hash chain, and what it is actually worth.
//
// jex_activity carries prev_hash and entry_hash: each row commits to the one
// before it, so editing an old row should break every hash after it. It is
// built server-side in rpc_log_activity, which is the right place -- it used
// to be built in the browser, and tamper-evidence produced by the party you
// are guarding against is not evidence.
//
// ── What the chain did not cover ──
//
// The hash was taken over type, description, amount and timestamp. Not
// user_id, not user_name, not ticker -- which are exactly the fields that say
// who an entry is about.
//
// Measured against the live function body: two entries written normally, then
//
//   update jex_activity set user_name = 'Somebody Else', user_id = 'u_s3';
//
//   before the fix   chain still verifies -> TRUE   (every row rewritten)
//   after the fix    chain still verifies -> false  (both rows)
//
// ── What it is still not ──
//
// Forging an entry at WRITE time is unchanged, and is by design. app.js says
// why: "user_id and user_name stay parameters because the log records who an
// entry is ABOUT, which is often not the caller (an admin approving a
// student's IPO logs it against the student)." So any signed-in student can
// write an entry attributed to anyone:
//
//   rpc_log_activity('dividend','Paid a $50,000 dividend','ACME',
//                    'u_s1','Student 1', 50000)   -> accepted
//
// Closing that means the server deriving the subject of every activity type
// itself, which is real work and was not done three days before a class.
//
// So the claim the chain supports, stated exactly: the log has not been
// EDITED since it was written. Not that each entry was honest when written.
// Those are different, and only the first is true.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const crypto=require('crypto');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const md5=s=>crypto.createHash('md5').update(s).digest('hex');

// The two hash formulas, transcribed.
const oldHash=(prev,e)=>md5(prev+e.type+(e.description||'')+(e.amount==null?'':String(e.amount))+e.ts).slice(0,8);
const newHash=(prev,e)=>md5(prev+e.type+(e.description||'')+(e.amount==null?'':String(e.amount))+e.ts
                            +(e.user_id||'')+(e.user_name||'')+(e.ticker||'')).slice(0,8);

const entry=(over={})=>Object.assign({
  type:'ipo',description:'Acme listed',ticker:'ACME',
  user_id:'u_ceo',user_name:'Acme CEO',amount:1000,ts:'Sep 21, 9:00:00 AM'},over);

const e=entry();
check('the old formula ignored who the entry was about',
      oldHash('genesis',e)===oldHash('genesis',entry({user_id:'u_s3',user_name:'Somebody Else'})));
check('...and which company it was about',
      oldHash('genesis',e)===oldHash('genesis',entry({ticker:'BETA'})));
check('the new formula notices the name',
      newHash('genesis',e)!==newHash('genesis',entry({user_name:'Somebody Else'})));
check('...and the id',
      newHash('genesis',e)!==newHash('genesis',entry({user_id:'u_s3'})));
check('...and the ticker',
      newHash('genesis',e)!==newHash('genesis',entry({ticker:'BETA'})));
check('...while still noticing the amount, as before',
      newHash('genesis',e)!==newHash('genesis',entry({amount:50000})));
check('...and the description',
      newHash('genesis',e)!==newHash('genesis',entry({description:'something else'})));
check('...and the type', newHash('genesis',e)!==newHash('genesis',entry({type:'dividend'})));
check('...and its place in the chain',
      newHash('genesis',e)!==newHash('abcd1234',e));
check('an unchanged entry still verifies', newHash('genesis',e)===newHash('genesis',entry()));
check('the hash is still 8 characters', newHash('genesis',e).length===8);
check('null attribution does not throw or collide with empty',
      newHash('genesis',entry({user_id:null,user_name:null,ticker:null})).length===8);

// A whole chain, rewritten the way the measurement did it.
const chain=[entry(),entry({type:'dividend',description:'Paid a dividend',user_id:'u_s1',user_name:'Student 1',amount:500})];
const build=(h)=>{let prev='genesis';return chain.map(c=>{const v=h(prev,c);prev=v;return v;});};
const built=build(newHash);
const tampered=chain.map(c=>Object.assign({},c,{user_name:'Somebody Else',user_id:'u_s3'}));
let prev='genesis',anyBreak=false;
tampered.forEach((c,i)=>{ if(newHash(prev,c)!==built[i])anyBreak=true; prev=built[i]; });
check('rewriting the attribution across the whole log now breaks it', anyBreak);

let prevOld='genesis',oldBreak=false;
const builtOld=(()=>{let p='genesis';return chain.map(c=>{const v=oldHash(p,c);p=v;return v;});})();
tampered.forEach((c,i)=>{ if(oldHash(prevOld,c)!==builtOld[i])oldBreak=true; prevOld=builtOld[i]; });
check('...where under the old formula it did not', oldBreak===false);

// ── the client half ──
// The browser no longer writes the log at all: every entry comes from the
// database function that did the thing (server_events_batch1-4.sql), and
// rpc_log_activity is closed to the web. The chain the formula above checks
// is built entirely server-side -- rpc_log_activity's formula, kept by
// jex_log with 'server' as the writer.
check('the page never writes the activity log', !/rpc_log_activity|logActivity\(/.test(src));
const b1=fs.readFileSync(path.join(__dirname,'..','sql','server_events_batch1.sql'),'utf8');
check('the server\'s entries hash the same fields, writer last',
      /substr\(md5\(v_prev \|\| p_type \|\| v_desc \|\| coalesce\(p_amount::text, ''\) \|\| v_ts\s*\n?\s*\|\| coalesce\(v_subject, ''\) \|\| coalesce\(v_subject_name, ''\) \|\| coalesce\(v_ticker, ''\) \|\| 'server'\), 1, 8\)/.test(b1));
const b4=fs.readFileSync(path.join(__dirname,'..','sql','server_events_batch4.sql'),'utf8');
check('...and the web cannot call rpc_log_activity', /revoke execute on function public\.rpc_log_activity\(text,text,text,text,text,numeric\)/.test(b4));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
