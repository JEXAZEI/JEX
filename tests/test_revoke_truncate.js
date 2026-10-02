// anon and authenticated held TRUNCATE, TRIGGER and REFERENCES on 38 public
// tables -- leftovers from the project's default "grant all". TRUNCATE empties
// a table past row-level security. See sql/revoke_truncate.sql, exercised on a
// local database laid out like a Supabase project: before, anon could truncate
// jex_trades and authenticated could truncate jex_users; after, both refused,
// with every SELECT/INSERT/UPDATE/DELETE still working and a table created
// afterwards not granting TRUNCATE.
const fs=require('fs'),path=require('path');
const sql=fs.readFileSync(path.join(__dirname,'..','sql','revoke_truncate.sql'),'utf8');
const pre=fs.readFileSync(path.join(__dirname,'..','sql','preflight.sql'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const code=sql.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');

check('revokes exactly the three unused privileges',
      /revoke truncate, trigger, references on table public\.%I from anon, authenticated/.test(code));
check('...never SELECT, INSERT, UPDATE or DELETE', !/\brevoke\s[^;]*\b(select|insert|update|delete)\b/i.test(code));
check('...and proves it: the app\'s grants are counted before and after, and it aborts if they move',
      /if v_after <> v_before then\s*raise exception 'ABORT/.test(code));
check('covers tables, partitions, views, materialized views and foreign tables',
      /c\.relkind in \('r', 'p', 'v', 'm', 'f'\)/.test(code));
check('only touches relations that still hold one of the three (so a second run is a no-op)',
      /has_table_privilege\('anon', c\.oid, 'TRUNCATE'\)/.test(code));
check('identifiers are quoted with %I, not concatenated', /format\('revoke [^']*%I/.test(code) && !/'\s*\|\|\s*v_rel\.relname/.test(code));
check('new tables made by postgres stop granting them too',
      /alter default privileges for role postgres in schema public\s*revoke truncate, trigger, references on tables from anon, authenticated;/.test(code));
check('...in its own block, so a refusal there does not undo the revokes',
      /begin\s*alter default privileges[\s\S]*?exception when others then\s*raise notice/.test(code));
check('preflight flags any table that can be truncated again', /'tables_anyone_can_truncate'/.test(pre)
      && /has_table_privilege\('anon', c\.oid, 'TRUNCATE'\)/.test(pre));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
