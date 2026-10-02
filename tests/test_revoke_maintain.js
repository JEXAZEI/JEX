// Postgres 17's MAINTAIN privilege -- part of "grant all" -- was still held by
// anon and authenticated after revoke_truncate.sql, and in the defaults for
// new tables. With production's SELECT-only grants it was the only thing
// letting a signed-out caller LOCK a table in ACCESS EXCLUSIVE mode, blocking
// every read and write. See sql/revoke_maintain.sql, exercised on Postgres
// 17.10 with production's grants: LOCK and REINDEX refused after, reads
// unchanged, new tables default to SELECT only; on Postgres 16 a no-op.
const fs=require('fs'),path=require('path');
const sql=fs.readFileSync(path.join(__dirname,'..','sql','revoke_maintain.sql'),'utf8');
const pre=fs.readFileSync(path.join(__dirname,'..','sql','preflight.sql'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const code=sql.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');

check('revokes MAINTAIN only', /format\('revoke maintain on table public\.%I from anon, authenticated'/.test(code)
      && !/\brevoke\s[^;]*\b(select|insert|update|delete)\b/i.test(code));
check('...proving the app\'s grants did not move', /if v_after <> v_before then\s*raise exception 'ABORT/.test(code));
check('does nothing before Postgres 17, where MAINTAIN does not exist',
      /if current_setting\('server_version_num'\)::int < 170000 then[\s\S]*?return;/.test(code));
check('...and every MAINTAIN in a statement is built as text, so the file parses on 16',
      !/^\s*(revoke|grant|alter default privileges)[^;]*maintain/im.test(code));
check('new tables stop granting it', /alter default privileges for role postgres in schema public revoke maintain on tables from anon, authenticated/.test(code));
check('...in its own block, so a refusal there does not undo the revokes',
      /begin\s*execute 'alter default privileges[\s\S]*?exception when others then\s*raise notice/.test(code));
check('the verification re-checks TRUNCATE too', /'TRUNCATE'/.test(code) && /as still_truncatable/.test(code));
check('preflight flags any table anyone can MAINTAIN, on 17 only', /'tables_anyone_can_maintain'/.test(pre)
      && /current_setting\('server_version_num'\)::int >= 170000\s*and \(has_table_privilege\('anon', c\.oid, 'MAINTAIN'\)/.test(pre));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
