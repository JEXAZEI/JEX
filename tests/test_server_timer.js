// sql/server_timer.sql gives the exchange a clock of its own: pg_cron runs the
// session schedule and lifts circuit-breaker halts every 15 seconds, with no
// browser open. sql/manual_open_no_email.sql makes "Open now" in-app only.
//
// Verified on a copy of production's code with pg_cron 1.6 running: a
// one-off window opened 4s in, with after-hours orders live and their owners
// told; a timed session closed on its own with day orders expired; a 6-minute
// circuit-breaker halt lifted with its 20-minute cooldown while a 1-minute
// one and a manual one stayed; a weekly window opened, and an officer's
// manual close inside it was not undone; 8 simultaneous lifts, and a browser
// racing the timer either way, each logged the resume once (two browsers had
// logged it twice and sent 8 notices for 4 students); the web cannot call
// either timer function; a manual open sent 0 emails where it had sent 8,
// while a close and practice mode still emailed. This guards what the files
// can show.
const fs=require('fs'),path=require('path');
const sqlDir=path.join(__dirname,'..','sql');
const read=f=>fs.readFileSync(path.join(sqlDir,f),'utf8');
const strip=s=>s.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── the timer ──
const timer=strip(read('server_timer.sql'));
check('pinned to production\'s rpc_session_tick (batch 4 applied)', /v_fp <> '7dc13c328a85fe47644c2471e34a5843'/.test(timer));
check('pinned to production\'s rpc_admin_resume_stock', /v_fp <> '03197e9479ffb49d11fbb4399b2b510c'/.test(timer));
check('refuses to run before batch 4', /run server_events_batch4\.sql first/.test(timer));
check('every check comes before anything changes',
      timer.lastIndexOf('is not the version this was written against')<timer.indexOf('create extension pg_cron'));
check('each edit\'s text must occur exactly once', /exactly once in rpc_session_tick/.test(timer) && /exactly once in rpc_admin_resume_stock/.test(timer));
check('a function counts as done by text only the new version has',
      /position\('jex_session_tick_core' in v_src\) > 0/.test(timer) && /position\('where ticker = p_ticker for update;' in v_core\) > 0/.test(timer));
check('edits follow the function\'s own line endings', (timer.match(/chr\(13\) \|\| chr\(10\) else chr\(10\)/g)||[]).length===2);
check('rebuilt through pg_get_functiondef, so attributes come back as they were', (timer.match(/pg_get_functiondef\(p\.oid\)/g)||[]).length===2);
check('pg_cron is enabled if it can be, and the dashboard named if not',
      /create extension pg_cron;/.test(timer) && /Database > Extensions, search "pg_cron"/.test(timer));

check('the schedule runs without the sign-in check: the body, minus its first two lines',
      /replace\(v_src, replace\(v_auth, '\{nl\}', v_nl\), ''\)/.test(timer)
      && /'FUNCTION public\.rpc_session_tick\(\)', 'FUNCTION public\.jex_session_tick_core\(\)'/.test(timer));
check('...and a browser still has to be signed in to ask', /replace\(v_auth, '\{nl\}', v_nl\) \|\| v_nl\s*\|\| '  -- What the schedule decides/.test(timer)
      && /'  return jex_session_tick_core\(\);'/.test(timer));
check('a halt is locked while it is lifted', /'  select \* into v_halt from jex_halts where ticker = p_ticker for update;'/.test(timer));
const brk=timer.slice(timer.indexOf('function public.jex_resume_expired_breakers()'),timer.indexOf('$body$;',timer.indexOf('function public.jex_resume_expired_breakers()')));
check('the timer lifts only circuit-breaker halts 5 minutes old',
      /where halted_by = 'System \(Circuit Breaker\)' and created_at <= now\(\) - interval '5 minutes'/.test(brk));
check('...skipping one a browser is lifting right now', /for update skip locked/.test(brk));
check('...with the same 20-minute cooldown', /\+ 20\*60\*1000/.test(brk));
check('...and the same log entry and notices', /perform jex_ev_resume\(v_ticker, null, true\);/.test(brk));
check('the web cannot call either timer function',
      /revoke execute on function public\.jex_session_tick_core\(\), public\.jex_resume_expired_breakers\(\)\s*from public, anon, authenticated/.test(timer));
check('two jobs every 15 seconds, by name, so a second run replaces them',
      /cron\.schedule\('jex-session-schedule', v_every, 'select public\.jex_session_tick_core\(\)'\)/.test(timer)
      && /cron\.schedule\('jex-circuit-breakers', v_every, 'select public\.jex_resume_expired_breakers\(\)'\)/.test(timer)
      && /v_every text := '15 seconds'/.test(timer));
check('...every minute where pg_cron cannot do seconds', /v_every := '\* \* \* \* \*';/.test(timer));
check('the run history is kept to three days',
      /cron\.schedule\('jex-cron-cleanup', '17 10 \* \* \*',\s*\$job\$delete from cron\.job_run_details where end_time < now\(\) - interval '3 days'\$job\$\)/.test(timer));
check('the header says how to turn it off', /select cron\.unschedule\('jex-session-schedule'\);/.test(read('server_timer.sql')));

// ── a manual open, in-app only ──
const mo=strip(read('manual_open_no_email.sql'));
check('only the six-argument form changes: the one rpc_admin_save_session calls',
      /= 'p_by text, p_old text, p_new text, p_old_practice boolean, p_new_practice boolean, p_started bigint'/.test(mo));
check('no email when trading opens; a close and practice mode still email',
      /coalesce\(p_new, ''''\) <> ''open'' or p_old is not distinct from ''open''/.test(mo));
check('...replacing exactly batch 4\'s line', /v_anchor text := '  perform jex_ev_session\(p_by, p_old, p_new, p_old_practice, p_new_practice, p_started, true\);'/.test(mo)
      && /expected its one line once/.test(mo));
check('...and safe to run twice', /position\('manual open' in v_src\) > 0/.test(mo));

// Run the expression the way Postgres reads it.
const email=(o,n)=>(n??'')!=='open' || o==='open';
check('a manual open: no email', email('closed','open')===false && email('paused','open')===false && email(null,'open')===false);
check('a manual close or pause: email', email('open','closed')===true && email('open','paused')===true);
check('practice mode toggled while open: email', email('open','open')===true);

// ── preflight ──
const pre=read('preflight.sql');
check('preflight reads the server\'s clock', /'server_timer', case when to_regclass\('cron\.job'\) is null/.test(pre));
check('...and still runs where pg_cron is not installed', /then to_jsonb\('not set up -- run server_timer\.sql'::text\)/.test(pre) && /query_to_xml\(\$q\$/.test(pre));
check('...each job\'s last run and result, and failures with their error',
      /'last_run'/.test(pre) && /'last_result'/.test(pre) && /'failed_24h'/.test(pre) && /d\.status = 'failed'/.test(pre));
check('...through base64, so an error with < or & reads as written', /encode\(convert_to\(/.test(pre) && /decode\(\(xpath\(/.test(pre));
check('the schedule marker follows the code to where it now lives',
      /\('the schedule finishes opens and closes', 'jex_session_tick_core', 'perform jex_ev_session_tick\('\)/.test(pre));
check('a marker on a function with two forms reads true if either has it', /select bool_or\(position\(m\.marker in p\.prosrc\) > 0\)/.test(pre) && !/p\.proname = m\.fn limit 1/.test(pre));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
