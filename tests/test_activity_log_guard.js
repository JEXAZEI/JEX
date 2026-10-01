// rpc_log_activity accepted anything from any signed-in account: a "type" of
// <img src=x onerror=...>, a forged Chairman session entry, a $5,000
// withdrawal blamed on another student, 200,000 characters, 1,000 entries in a
// row -- and recorded nothing about who wrote them. Concurrent writers forked
// the hash chain (15 forks in 160 entries with four writers). See
// sql/activity_log_guard.sql; every rule there was exercised against
// production's own function body on a local database.
const fs=require('fs'),path=require('path');
const sql=fs.readFileSync(path.join(__dirname,'..','sql','activity_log_guard.sql'),'utf8');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const i=sql.indexOf('create or replace function public.rpc_log_activity(');
const body=sql.slice(i,sql.indexOf('$body$;',i)).split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');

// ── server rules ──
check('a type must be a plain word', /if v_type !~ '\^\[a-z_\]\{1,40\}\$' then raise exception 'Invalid activity type'/.test(body));
const officerTypes=(/v_officer_types text\[\] := array\[([\s\S]*?)\];/.exec(body)||[])[1];
const offList=officerTypes?officerTypes.match(/'([a-z_]+)'/g).map(s=>s.slice(1,-1)):[];
check('seven officer-only types', offList.length===7, offList.join(','));
check('...refused to anyone else', /if v_type = any\(v_officer_types\) and not v_is_officer then/.test(body));
check('the writer comes from the login, not the call', /select id, role into v_uid, v_role from jex_users where auth_uid = auth\.uid\(\);/.test(body)
      && /v_uid, clock_timestamp\(\)\)/.test(body));
check('...and is part of the hash', /\|\| coalesce\(v_ticker, ''\) \|\| v_uid\), 1, 8\)/.test(body));
check('lengths: description 500, ticker 20, subject 100',
      /v_desc := left\(coalesce\(p_description, ''\), 500\);/.test(body) && /, 20\);/.test(body) && /p_user_id, ''\)\), ''\), 100\)/.test(body));
check('60 a minute, 300 for officers', /v_limit := case when v_is_officer then 300 else 60 end;/.test(body));
check('entries are chained one at a time', /perform pg_advisory_xact_lock\(hashtext\('jex_activity_chain'\)\);/.test(body));
check('...and stamped under the lock, so created_at order is chain order', /clock_timestamp\(\)/.test(body) && !/v_uid, now\(\)\)/.test(body));
check('leftover table grants revoked', /revoke truncate, trigger, references on public\.jex_activity from anon, authenticated;/.test(sql));
check('refuses unless the live body is the production version', /v_fp <> '7a38c217cc13a60d7ab3f4c3ff477fa8'/.test(sql));
check('"already applied" marker is text only the new body contains', /position\('logged_by' in v_src\) > 0/.test(sql) && /logged_by/.test(body));

// ── the app's calls fit the rules ──
const fns=[...src.matchAll(/^(?:async )?function ([A-Za-z_]+)\(/gm)].map(m=>({at:m.index,name:m[1]}));
const fnAt=at=>{let n='(top)';for(const f of fns){if(f.at<=at)n=f.name;else break;}return n;};
const calls=[...src.matchAll(/logActivity\(\s*'([^']*)'/g)].map(m=>({type:m[1],fn:fnAt(m.index)}));
check('found the app\'s activity calls', calls.length>=35, String(calls.length));
for(const t of [...new Set(calls.map(c=>c.type))].sort())
  check('"'+t+'" is a plain word the server accepts', /^[a-z_]{1,40}$/.test(t));
const officerFns={setSession:/if\(!isChairman\(cu\(\)\)\)/,adjustStockPrice:/if\(!isChairman\(cu\(\)\)\)/,
  adjustCash:/if\(!isAdmin\(cu\(\)\)\)/,adjustCompanyCash:/if\(!isAdmin\(cu\(\)\)\)/,
  removeShareClass:/if\(!isAdmin\(cu\(\)\)\)/,doRestoreSnapshot:/if\(!isAdmin\(cu\(\)\)\)/,
  postMinutes:/rpc_post_minutes/,approveReg:/approve_registration/};
for(const c of calls.filter(c=>offList.includes(c.type))){
  check(c.type+' is logged from '+c.fn+', which only an officer reaches', !!officerFns[c.fn]);
  const at=src.search(new RegExp('^(?:async )?function '+c.fn+'\\(','m'));
  if(officerFns[c.fn])check('...'+c.fn+' is gated before it logs', officerFns[c.fn].test(src.slice(at,at+2500)));
}

// ── the page ──
check('the Activity tab shows who wrote an entry when it is not who it is about',
      /if\(!a\|\|!a\.logged_by\|\|a\.logged_by===a\.user_id\)return'';/.test(src)
      && /written by \$\{esc\(activityWriterName\(a\)\)\}/.test(src));
check('...and the CSV export carries it', /\['ts','type','description','amount','about','written_by'\]/.test(src));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
