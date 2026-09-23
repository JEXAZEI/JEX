// rpc_push_notification let any signed-in account send any text to any
// student, and email it from the exchange's own account. See
// sql/push_notification_guard.sql. These checks keep the server's rules and
// the app's calls in step, because a mismatch fails SILENTLY: the app swallows
// notification errors, so a type the server refuses is simply never delivered.
// That is exactly how 'margin_call' went undelivered from the day margin calls
// shipped.
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

// Every type the app sends, with the function that sends it.
const calls=[];
const fnAt=i=>{
  const before=src.slice(0,i);
  const all=[...before.matchAll(/^(?:async )?function ([A-Za-z_]+)\(/gm)];
  return all.length?all[all.length-1][1]:'(top level)';
};
for(const m of src.matchAll(/pushNotification(ToAll|ToHolders)?\(\s*(?:[^,()]+(?:\([^()]*\))?\s*,\s*)?'([a-z_]+)'/g)){
  // pushNotification(user,'type',...)  pushNotificationToAll('type',...)  pushNotificationToHolders(ticker,'type',...)
  calls.push({type:m[2],fn:fnAt(m.index)});
}
const types=[...new Set(calls.map(c=>c.type))].sort();
check('found the app\'s notification calls', calls.length>=30, String(calls.length));

for(const t of types)
  check('the server accepts "'+t+'", which the app sends', allowed.includes(t));
check('margin_call is accepted, and emailed', allowed.includes('margin_call')&&important.includes('margin_call'));

// Officer-only types must only be sent from functions that officers alone reach.
// Each of these is gated -- client-side and, for reviewIPO/postMinutes, by the
// RPC it calls first -- so a student's browser never gets as far as sending.
const officerOnlyFns=['setSession','togglePracticeMode','adjustStockPrice','reviewIPO','relistCompany','postMinutes'];
for(const c of calls.filter(c=>officerSends.includes(c.type)))
  check(c.type+' is sent from '+c.fn+', which only an officer reaches', officerOnlyFns.includes(c.fn));
const gate={setSession:/if\(!isChairman\(cu\(\)\)\)/,togglePracticeMode:/if\(!isAdmin\(cu\(\)\)\)/,
  adjustStockPrice:/if\(!isChairman\(cu\(\)\)\)/,relistCompany:/if\(!isAdmin\(cu\(\)\)\)/,
  reviewIPO:/rpc_review_ipo/,postMinutes:/rpc_post_minutes/};
for(const [fn,re] of Object.entries(gate)){
  const i=src.search(new RegExp('^(?:async )?function '+fn+'\\(','m'));
  check(fn+' is gated before it notifies', i>=0&&re.test(src.slice(i,i+900)));
}

// Officer-addressed types go only to officers.
for(const m of src.matchAll(/const admins=DB\.users\.filter\(u2=>u2\.role==='chairman'\|\|u2\.role==='president'\);\s*for\(const a of admins\)\{\s*await pushNotification\(a\.id,'([a-z_]+)'/g))
  check(m[1]+' is addressed to the Chairman and President', officerReceives.includes(m[1]));

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
