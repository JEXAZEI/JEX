// sql/server_events_batch4.sql closes the doors: rpc_log_activity and
// rpc_push_notification can no longer be called from the web, the scheduler
// finishes what it starts (after-hours orders on open, day orders on close),
// a manual open tells after-hours owners, and a failed notification no
// longer loses its log entry. The page stops writing either at all.
//
// Verified on a copy of production's code: a timed close expired the day
// order production left open; a scheduled open activated the order
// production left queued; scheduled changes sent no email; 8 simultaneous
// ticks closed the session once; every notice failing still left the log
// entry; both writers refused to anon and authenticated.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'..','sql','server_events_batch4.sql'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const code=sql.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');
const body=name=>{const i=code.indexOf('function public.'+name+'(');return i<0?'':code.slice(i,code.indexOf('$body$;',i));};

// ── the migration's rails ──
check('pinned to production\'s rpc_admin_save_session (batch 2 applied)', /'rpc_admin_save_session', '051cfc4f13f920f07a5fe27e37f6b349'/.test(code));
check('pinned to production\'s rpc_session_tick', /'rpc_session_tick', 'dec464d75ad045c29d6f2893119c67b8'/.test(code));
check('a function counts as done by text only the new version has',
      /'rpc_admin_save_session', '[0-9a-f]{32}', 'v_activated'/.test(code) && /'rpc_session_tick', '[0-9a-f]{32}', 'jex_ev_session_tick'/.test(code));
check('refuses to run before batches 1-3', /run server_events_batch1\.sql, batch2 and batch3 first/.test(code));
check('a mismatch aborts before anything changes',
      code.indexOf('is not the version this was written against')<code.indexOf('create or replace function public.jex_notify('));
check('every anchor must occur exactly once', /anchor exactly once in %/.test(code));
check('the plan is held inside the block', /into v_plan/.test(code) && !/temp(orary)? table/i.test(code));
check('the doors close last, after everything else succeeded',
      code.lastIndexOf('revoke execute on function public.rpc_log_activity')>code.indexOf('-- ── 3. the edits ──'));
check('the two general writers are closed to the web',
      /revoke execute on function public\.rpc_log_activity\(text,text,text,text,text,numeric\),\s*public\.rpc_push_notification\(text,text,text,text\) from public, anon, authenticated/.test(code));
check('...but kept, so two grants undo it', !/drop function/i.test(code));
for(const h of ['jex_notify(text,text,text,text,boolean)','jex_notify_students(text,text,text,text,boolean)',
                'jex_ev_session(text,text,text,boolean,boolean,bigint,boolean)','jex_ev_session_tick(text,bigint)'])
  check('new helper '+h.split('(')[0]+' cannot be called from the web', code.includes('public.'+h));

// ── a failed notification keeps its event ──
const notify=code.slice(code.indexOf('function public.jex_notify(p_user_id text, p_type text, p_message text, p_ticker text, p_email boolean)'));
check('each notification is written on its own: a failure is a warning, not a lost event',
      /begin\s*insert into jex_notifications[\s\S]*?exception when others then\s*raise warning 'notification to % not written: %'/.test(notify));
check('email only when asked, and under the old rules', /if p_email and v_recipient\.email_notifications and p_type = any\(v_important\) then/.test(notify));
check('the old four-argument form still emails as before', /perform jex_notify\(p_user_id, p_type, p_message, p_ticker, true\);/.test(code));
check('...as does the old six-argument session event', /perform jex_ev_session\(p_by, p_old, p_new, p_old_practice, p_new_practice, p_started, true\);/.test(code));

// ── the scheduler ──
const tick=body('jex_ev_session_tick');
check('a scheduled open turns after-hours orders live', /update jex_limit_orders set status = 'open' where status = 'after_hours'/.test(tick));
check('...and tells their owners', /perform jex_ev_after_hours_active\(v_rows\);/.test(tick));
check('a scheduled close expires day orders', /update jex_limit_orders set status = 'expired' where status = 'open' and order_type = 'day'/.test(tick));
check('...and tells their owners', /perform jex_ev_day_orders_expired\(v_rows\);/.test(tick));
check('scheduled opens and closes are logged and noticed, without email',
      (tick.match(/perform jex_ev_session\(null, p_old, v_new, null, null, (null|p_started), false\);/g)||[]).length===2);
check('the orders move with the change; only telling people is best-effort',
      /\)\s*select coalesce[\s\S]*?into v_rows from done;\s*begin\s*perform jex_ev_after_hours_active/.test(tick)
      && !/^exception/m.test(tick.split('\n').slice(-3).join('\n')));
check('the schedule is named as the schedule in the log',
      /then 'Session ' \|\| case p_new when 'open' then 'opened' else p_new end \|\| ' on schedule'/.test(body('jex_ev_session')));
check('a manual open tells after-hours owners too',
      /'    update jex_limit_orders set status = ''open'' where status = ''after_hours'';',/.test(code)
      && /into v_activated from done;\{nl\}'/.test(code)
      && /'    perform jex_ev_after_hours_active\(v_activated\);', 'replace'\)/.test(code));

// ── the page writes nothing ──
for(const [what,re] of [['logActivity',/logActivity\(/],['pushNotification',/pushNotification\w*\(/],
                        ['rpc_log_activity',/rpc_log_activity/],['rpc_push_notification',/rpc_push_notification\b/],
                        ['the server-events switch',/serverRecords|SERVER_EVENTS|rpc_server_events/]])
  check('the page has no '+what, !re.test(src), (src.match(re)||[''])[0]);
// Everything that used to write now fetches what the server wrote.
const fnBody=name=>{
  const m=new RegExp('^(?:async )?function '+name+'\\(','m').exec(src);
  if(!m)return null;
  let i=src.indexOf('{',m.index),d=0;
  for(let j=i;j<src.length;j++){if(src[j]==='{')d++;else if(src[j]==='}'&&--d===0)return src.slice(m.index,j+1);}
};
for(const fn of ['adjustCash','adjustCompanyCash','depositToFund','withdrawFromFund','issueDividend','reviewDivApproval',
  'checkLimitOrders','checkStopLossOrders','checkMarginCalls','convertShareClass','adjustStockPrice','setSession',
  'togglePracticeMode','haltStock','resumeStock','delistCompany','relistCompany','reviewDelisting','reviewIPO',
  'reviewClassApp','removeShareClass','approveReg','doRestoreSnapshot','postMinutes','postAnnouncement','resolveFlag',
  'postVote','closeVote','postNews','postFinancials','sendFounderInvite','respondToInvite','removeFounder',
  'requestFounderAllocation','reviewFounderAllocation','submitClassApplication','submitDelisting','flagAccount',
  'submitBugReport','createFund','placeLimitOrder','checkPriceAlerts','activateAfterHoursOrders','checkShortSqueezes']){
  const b=fnBody(fn);
  check(fn+' fetches what the server wrote', !!b && /afterServerEvent\(\)/.test(b), b?'':'missing');
}
check('the officers\' refresh still feeds the Sheets activity tab',
      /DB\.activity=act;\s*\n\s*\/\/[^\n]*\n\s*pushToSheets\('activity',\{items:act\.slice\(0,10\)\}\);/.test(fnBody('afterServerEvent')||''));

// ── the live smoke test changes nothing ──
const smoke=fs.readFileSync(path.join(__dirname,'..','sql','smoke_server_events.sql'),'utf8');
check('the smoke test is one block that ends by raising, so it all rolls back',
      (smoke.match(/^do \$smoke\$/gm)||[]).length===1 && /raise exception 'SMOKE TEST RESULT \(rolled back -- nothing was kept\):%', v_out;\s*end\s*\$smoke\$;\s*$/.test(smoke));
check('...acts as real accounts only for its own transaction', (smoke.match(/set_config\('request\.jwt\.claims?(\.sub)?', [^)]*, true\)/g)||[]).length===4);
check('...and compares against the transaction start, which notifications are stamped with', /v_t0 timestamptz := now\(\);/.test(smoke));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
