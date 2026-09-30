// rpc_report_client_error took reports from anyone, signed in or not, with no
// limit on how many: 5,000 in one go became 5,000 rows, and one crash firing
// 300 times became 300. See sql/client_error_limits.sql -- every rule there was
// exercised on a local database against production's own function body. This
// pins the text so a later hand edit cannot quietly undo it.
const fs=require('fs'),path=require('path');
const sql=fs.readFileSync(path.join(__dirname,'..','sql','client_error_limits.sql'),'utf8');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const i=sql.indexOf('create or replace function public.rpc_report_client_error(');
const body=sql.slice(i,sql.indexOf('$body$;',i)).split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');

check('a repeat within 10 minutes is counted, not stored again',
      /coalesce\(last_seen_at, created_at\) > now\(\) - interval '10 minutes'/.test(body)
      && /set repeat_count = repeat_count \+ 1, last_seen_at = now\(\)/.test(body));
check('...matched on message and where it came from', /where message = v_msg and source = v_src/.test(body));
check('200 new reports per 10 minutes overall', /if v_n >= 200 then return; end if;/.test(body));
check('30 per signed-in user, 50 from signed-out callers together',
      /v_cap := case when v_uid is null then 50 else 30 end;/.test(body)
      && /user_id is not distinct from v_uid/.test(body));
check('only the newest 2,000 are kept', /order by created_at desc offset 2000/.test(body));
check('every field is still cut to length server-side',
      /left\(coalesce\(nullif\(btrim\(p_message\), ''\), '\(no message\)'\), 500\)/.test(body)
      && /left\(coalesce\(p_stack, ''\), 2000\)/.test(body)
      && /left\(coalesce\(p_source, ''\), 300\)/.test(body)
      && /left\(coalesce\(p_url, ''\), 500\)/.test(body));
check('a failed report never raises (a second error the page would try to report)',
      /exception when others then(\s*--[^\n]*)*\s*null;/.test(sql.slice(i,sql.indexOf('$body$;',i))));
check('past a limit it drops quietly rather than raising', !/raise exception/.test(body));
check('refuses unless the live body is the production version it was written against',
      /v_fp <> '8439f24c10d337c89a4f0c2ad0e8d788'/.test(sql));
check('"already applied" marker is text only the new body contains',
      /position\('repeat_count' in v_src\) > 0/.test(sql) && /repeat_count/.test(body));

check('the Errors tab shows a date in Arizona time, falling back to the old text',
      /esc\(azWhen\(e\.created_at,e\.ts\)\)/.test(src));
check('...and a repeat as ×N with when it was last seen',
      /×\$\{times\.toLocaleString\(\)\}/.test(src) && /azWhen\(e\.last_seen_at,''\)/.test(src));
check('snapshots and errors share one Arizona formatter', /function snapshotWhen\(s\)\{\s*return azWhen\(/.test(src));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
