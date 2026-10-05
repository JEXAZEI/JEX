// rpc_push_notification let any signed-in account send any text to any
// student, and email it from the exchange's own account. See
// sql/push_notification_guard.sql. Since server_events_batch4.sql the web
// cannot call it at all; the rules below still describe it, and the server's
// own notifications are checked against them.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'..','sql','push_notification_guard.sql'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

const arr=name=>{
  const m=new RegExp(name+" text\\[\\] := array\\[([^\\]]*)\\]").exec(sql);
  if(!m)throw new Error('no '+name+' in the migration');
  return m[1].match(/'([a-z_]+)'/g).map(s=>s.slice(1,-1));
};
const allowed=arr('v_allowed_types'),important=arr('v_important');
const officerSends=arr('v_officer_sends'),officerReceives=arr('v_officer_receives');

// The app no longer sends notifications at all: every one is written by the
// database function that did the thing (server_events_batch1-4.sql), and
// rpc_push_notification is closed to the web. What used to be checked against
// the app's calls is now checked against the server's.
check('the page never sends a notification itself', !/rpc_push_notification|pushNotification\w*\(/.test(src));
const ev=['server_events_batch1.sql','server_events_batch2.sql','server_events_batch3.sql','server_events_batch4.sql']
  .map(f=>fs.readFileSync(path.join(__dirname,'..','sql',f),'utf8')).join('\n');
// The type is the second argument of jex_notify and jex_notify_holders, the
// first of jex_notify_students.
const sent=[...new Set([
  ...[...ev.matchAll(/jex_notify(?:_holders)?\((?:[^,()]|\([^()]*\))+,\s*'([a-z_]+)'/g)].map(m=>m[1]),
  ...[...ev.matchAll(/jex_notify_students\(\s*'([a-z_]+)'/g)].map(m=>m[1])])].sort();
check('found the server\'s notification types', sent.length>=20, sent.join(','));
for(const t of sent)check('"'+t+'" is a type the exchange already knew', allowed.includes(t)||t==='squeeze');
const imp=(ev.match(/v_important text\[\] := array\[([^\]]*)\]/)||[])[1]||'';
check('the server emails exactly the types the guard emailed',
      JSON.stringify(imp.match(/'([a-z_]+)'/g).map(x=>x.slice(1,-1)).sort())===JSON.stringify(important.slice().sort()));
check('...and a squeeze alert is not one of them', !important.includes('squeeze') && !imp.includes("'squeeze'"));
const b4=fs.readFileSync(path.join(__dirname,'..','sql','server_events_batch4.sql'),'utf8');
check('the web cannot call rpc_push_notification', /public\.rpc_push_notification\(text,text,text,text\) from public, anon, authenticated/.test(b4));

// The email.
check('email from a non-officer to someone else carries no student-written text',
      /v_email_msg := 'You have a new ' \|\| v_label \|\| ' notification on JEX\. Sign in to read it\.';/.test(sql));
check('...and it is the officer-or-self branch that carries the message',
      /if v_is_officer or v_caller = p_user_id then\s*v_email_subject := 'JEX Alert — ' \|\| left\(/.test(sql));
check('the sender is recorded on every row', /values \(gen_random_uuid\(\)::text, p_user_id, p_type, v_msg, v_ticker, false,[\s\S]{0,120}v_caller, now\(\)\)/.test(sql));
check('rate limited per sender and per recipient', /v_n >= v_limit/.test(sql) && /if v_n >= 10 then/.test(sql));
check('a CASE is never inside an IF condition (PL/pgSQL reads its THEN as the IF\'s)',
      !/if [^;\n]*case when[^;\n]* end then/i.test(sql));
check('refuses to run over a body it was not written against', /v_md5 <> '0c8c3d95ced037fc3361baff09520618'/.test(sql));
check('the browser push has a title for a margin call', /margin_call:'⚠️ Margin call'/.test(src));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
