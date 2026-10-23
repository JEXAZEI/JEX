// sql/president_password.sql: the Chairman can set the President's password.
//
// Verified on a copy of production's code with Supabase-shaped auth tables
// (pgcrypto in `extensions`, as on Supabase): signed out, the President, a
// student, the Treasurer, the Chairman on their own or a student's account,
// an unknown id, 5 characters and 73 bytes were all refused with nothing
// changed; the Chairman's change made the new password verify and the old
// one fail (bcrypt $2a$10$, also accepted by an independent bcrypt library),
// removed the President's 2 sessions and 3 refresh tokens and left the
// Chairman's alone, logged "President's password changed by Chair" as the
// server, and told the President in the app; neither held the password. An
// account on the old password system got the sha256 the sign-in checks.
// This guards what the files can show.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const raw=fs.readFileSync(path.join(__dirname,'..','sql','president_password.sql'),'utf8');
const sql=raw.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');
const pre=fs.readFileSync(path.join(__dirname,'..','sql','preflight.sql'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const body=sql.slice(sql.indexOf('create or replace function public.rpc_admin_set_president_password'),sql.indexOf('$fn$;'));

// ── the migration's rails ──
check('refuses where a sign-in password cannot be set', /auth\.users\.encrypted_password not found/.test(sql)
      && /has_table_privilege\('auth\.users', 'UPDATE'\)/.test(sql) && /pgcrypto is not installed/.test(sql));
check('...or where the server-events helpers are missing', /run server_events_batch1\.sql to batch4 first/.test(sql));
check('every check comes before anything is created',
      sql.indexOf('run server_events_batch1.sql to batch4 first')<sql.indexOf('execute replace(v_body'));
check('finds pgcrypto wherever it is installed', /set search_path to public, \{crypto\}/.test(body) && /replace\(v_body, '\{crypto\}', quote_ident\(v_crypto\)\)/.test(sql));
check('signed-out visitors cannot call it', /revoke all on function public\.rpc_admin_set_president_password\(text, text\) from public, anon/.test(sql)
      && /grant execute on function public\.rpc_admin_set_president_password\(text, text\) to authenticated/.test(sql));

// ── who, and on whom ──
check('the caller comes from the login, not the browser', /select \* into v_me from jex_users where auth_uid = auth\.uid\(\);/.test(body));
check('the Chairman only', /if v_me\.role is distinct from 'chairman' then\s*raise exception 'Only the Chairman can change the President''s password'/.test(body));
check('the President only, locked while it changes',
      /select \* into v_pres from jex_users where id = p_user_id for update;\s*if v_pres\.id is null or v_pres\.role is distinct from 'president' then/.test(body));
check('6 to 72 characters (72 bytes is bcrypt\'s limit)', /length\(p_new_pw\) < 6/.test(body) && /octet_length\(p_new_pw\) > 72/.test(body));
check('every refusal comes before anything changes', body.indexOf('octet_length')<body.indexOf('update auth.users'));

// ── what it changes ──
check('a real sign-in gets a bcrypt password', /update auth\.users set encrypted_password = crypt\(p_new_pw, gen_salt\('bf', 10\)\), updated_at = now\(\)\s*where id = v_pres\.auth_uid;/.test(body));
check('...and a missing sign-in account is an error, not a silent no-op', /if not found then\s*raise exception 'The President''s sign-in account was not found/.test(body));
check('...and the President is signed out everywhere', /delete from auth\.sessions where user_id = v_pres\.auth_uid;/.test(body)
      && /delete from auth\.refresh_tokens where user_id = v_pres\.auth_uid::text;/.test(body));
check('...unless the database will not allow it, which does not undo the change', /exception when insufficient_privilege or undefined_table then\s*v_devices := null;/.test(body));
check('an old-system account gets the sha256 its sign-in checks', /set password = encode\(digest\(p_new_pw, 'sha256'\), 'hex'\)/.test(body));
check('logged as the server, and the President told in the app, not by email',
      /perform jex_log\('password_reset', 'President''s password changed by '/.test(body) && /perform jex_notify\(v_pres\.id, 'security',[\s\S]*?null, false\);/.test(body));
check('the password is never logged or returned', !/p_new_pw\s*(\|\||,\s*null, v_pres)/.test(body) && !/'password', p_new_pw/.test(body));

// ── the page ──
const fn=src.slice(src.indexOf('async function adminSetPresidentPw('),src.indexOf('async function adminSendResetEmail('));
check('the page asks the server', /sb\.rpc\('rpc_admin_set_president_password',\{p_user_id:uid2,p_new_pw:pw\}\)/.test(fn));
check('...only for the Chairman', /if\(cu\(\)\?\.role!=='chairman'\)return toast/.test(fn));
check('...after checking length and the confirmation locally', /pw\.length<6/.test(fn) && /new TextEncoder\(\)\.encode\(pw\)\.length>72/.test(fn) && /pw!==conf/.test(fn));
check('...and saying they will be signed out', /signed out on every device/.test(fn));
check('...writing no log entry or notice itself, and fetching the server\'s', !/rpc_log_activity|pushNotification/.test(fn) && /afterServerEvent\(\)/.test(fn));
check('...and clearing the typed password', /\['admin-pres-pw1','admin-pres-pw2'\]\.forEach\(id=>\{const el=get\(id\);if\(el\)el\.value='';\}\)/.test(fn));
check('the card is built for the Chairman only', /const presidents=u\?\.role==='chairman'\?DB\.users\.filter\(x=>x\.role==='president'&&x\.status==='approved'\):\[\];/.test(src));
check('the fields are not autofilled with a saved password', (src.match(/id="admin-pres-pw[12]"[^>]*autocomplete="new-password"/g)||[]).length===2);
check('the notice has its own icon and push title', /security:'🔑'\}/.test(src) && /security:'🔑 Your password was changed'/.test(src));

// ── preflight ──
check('preflight checks the feature is in place', /\('the Chairman can set the President''s password', 'rpc_admin_set_president_password', 'if v_me\.role is distinct from ''chairman'' then'\)/.test(pre));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
