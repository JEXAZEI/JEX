// The scheduler: the two functions that WRITE a schedule.
//
// If the market does not open, there is no class. Every other bug in JEX
// degrades into a confusing message; this one degrades into thirty students
// looking at "Session closed" while the lesson is supposed to be running.
//
// The DECISION -- has a window opened, has a timer expired -- is made
// server-side by rpc_session_tick and cannot be tested from here. What CAN be
// tested is everything that decides what gets STORED for it to act on, and
// that half had no coverage at all:
//
//   scheduleSession      a one-off "open from X to Y today"
//   saveWeeklySchedule   the recurring per-weekday windows
//
// Both do clock arithmetic against Arizona time, and both write fields the
// server then trusts. A schedule stored wrong is indistinguishable, from the
// front of a classroom, from a server that ignored it.
//
// Every case runs under four host timezones. Arizona is UTC-7 year round, so
// a laptop in Tokyo is 16 hours ahead and a laptop in London is 7 or 8 --
// getAZTime() exists precisely so the answer does not depend on which.
const fs=require('fs'),path=require('path');
const {execFileSync}=require('child_process');

// ── run the real cases under one fixed timezone ──
if(process.env.JEX_TZ_CHILD){
  const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
  let fails=0;
  const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

  function grabFn(name){
    const m=new RegExp('^(?:async )?function '+name+'\\(','m').exec(src);
    if(!m)throw new Error('not found: '+name);
    let i=src.indexOf('{',m.index),d=0;
    for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(m.index,i+1);} }
    throw new Error('unterminated: '+name);
  }
  function grabConst(name){
    const m=new RegExp('(?:^|;)const '+name+'=','m').exec(src);
    if(!m)throw new Error('not found: '+name);
    const start=m.index+(m[0].startsWith(';')?1:0);
    let depth=0;
    for(let i=start;i<src.length;i++){
      const c=src[i];
      if('([{'.includes(c))depth++;
      else if(')]}'.includes(c))depth--;
      else if(c===';'&&depth===0)return src.slice(start,i+1);
    }
    throw new Error('unterminated: '+name);
  }

  // ── environment ──
  let fields=null, toasts=[], saved=null;
  global.get=id=>fields&&fields[id]!==undefined
    ? (typeof fields[id]==='boolean'?{checked:fields[id]}:{value:String(fields[id])})
    : null;
  global.toast=m=>{toasts.push(m);};
  global.render=()=>{};
  global.saveSession=async o=>{saved=o;return o;};
  global.startSessionTimer=()=>{};
  global.clearInterval=()=>{};
  global.setInterval=()=>1;
  global.sessionTimer=null;
  global.pad=n=>String(n).padStart(2,'0');
  global.DB={session:{}};

  // A const declared inside eval() stays in the eval's own scope and never
  // reaches global, so the functions that reference it fail at call time with
  // "X is not defined". Function DECLARATIONS do leak, which is why the
  // mixture looks inconsistent. Binding explicitly rather than relying on it.
  const bindConst=name=>{
    const src2=grabConst(name);
    global[name]=eval('('+src2.replace(new RegExp('^const '+name+'='),'').replace(/;$/,'')+')');
  };
  bindConst('AZ_TZ');
  bindConst('WEEKDAY_KEYS');
  bindConst('WEEKDAY_LABELS');
  eval(grabFn('azParts'));
  eval(grabFn('getAZTime'));
  eval(grabFn('saveWeeklySchedule'));
  eval(grabFn('scheduleSession'));

  const TZ=process.env.TZ||'?';
  const reset=f=>{fields=f;toasts=[];saved=null;};
  const azNowMin=()=>{const a=getAZTime();return a.getHours()*60+a.getMinutes();};

  // ── saveWeeklySchedule ──
  const wk=(day,on,o,c)=>{
    const f={};
    for(const d of WEEKDAY_KEYS){
      f['wk-'+d+'-on']=(d===day)&&on;
      f['wk-'+d+'-open']=(d===day)?o:'';
      f['wk-'+d+'-close']=(d===day)?c:'';
    }
    return f;
  };

  reset(wk('mon',true,'16:00','18:30'));
  saveWeeklySchedule();
  check('['+TZ+'] a valid Monday window is saved',
        !!saved && saved.weekly_schedule && saved.weekly_schedule.mon.enabled===true,
        JSON.stringify(toasts));
  check('['+TZ+'] ...with the exact hours typed, not a default',
        !!saved && saved.weekly_schedule.mon.open.h===16 && saved.weekly_schedule.mon.open.m===0
              && saved.weekly_schedule.mon.close.h===18 && saved.weekly_schedule.mon.close.m===30,
        saved && JSON.stringify(saved.weekly_schedule.mon));
  check('['+TZ+'] every other day is present and disabled',
        !!saved && WEEKDAY_KEYS.filter(d=>d!=='mon').every(d=>saved.weekly_schedule[d]
          && saved.weekly_schedule[d].enabled===false));

  reset(wk('tue',true,'18:00','16:00'));
  saveWeeklySchedule();
  check('['+TZ+'] a close BEFORE the open is refused',
        saved===null && toasts.some(t=>/after the open|after open/i.test(t)),
        JSON.stringify(toasts));

  reset(wk('wed',true,'16:00','16:00'));
  saveWeeklySchedule();
  check('['+TZ+'] a zero-length window is refused', saved===null, JSON.stringify(toasts));

  reset(wk('thu',true,'','18:30'));
  saveWeeklySchedule();
  check('['+TZ+'] an enabled day with a blank time is refused',
        saved===null && toasts.some(t=>/valid times/i.test(t)), JSON.stringify(toasts));

  // A DISABLED day with blank inputs must not block the save -- the admin
  // panel starts every unused day blank, so this is the ordinary case.
  reset(wk('fri',false,'',''));
  saveWeeklySchedule();
  check('['+TZ+'] a disabled day with blank times does NOT block the save', !!saved,
        JSON.stringify(toasts));

  // Midnight is a real time. isNaN(0) is false, so 00:00 must survive as 0
  // rather than being swapped for the 16:00 default.
  reset(wk('sat',true,'00:00','01:00'));
  saveWeeklySchedule();
  check('['+TZ+'] midnight opens are kept as 0, not defaulted to 16',
        !!saved && saved.weekly_schedule.sat.open.h===0 && saved.weekly_schedule.sat.open.m===0,
        saved && JSON.stringify(saved.weekly_schedule.sat));

  // ── scheduleSession ──
  // Times are chosen RELATIVE to the current Arizona clock, so the cases mean
  // the same thing whatever time of day the suite runs.
  const nowMin=azNowMin();
  const hm=m=>({h:Math.floor(((m%1440)+1440)%1440/60), m:((m%1440)+1440)%1440%60});

  if(nowMin < 22*60){                       // leave room for a future window
    const a=hm(nowMin+60), b=hm(nowMin+120);
    reset({'sched-start-h':a.h,'sched-start-m':a.m,'sched-end-h':b.h,'sched-end-m':b.m});
    scheduleSession();
    check('['+TZ+'] a window starting LATER today is stored as scheduled, not opened',
          !!saved && saved.status==='closed' && saved.scheduled_open
            && saved.scheduled_open.h===a.h && saved.scheduled_open.m===a.m,
          saved && JSON.stringify(saved));
  }

  if(nowMin > 90 && nowMin < 22*60){        // a window already underway
    const a=hm(nowMin-60), b=hm(nowMin+60);
    reset({'sched-start-h':a.h,'sched-start-m':a.m,'sched-end-h':b.h,'sched-end-m':b.m});
    scheduleSession();
    check('['+TZ+'] a window already underway opens immediately',
          !!saved && saved.status==='open' && saved.ends_at>Date.now(),
          saved && JSON.stringify(saved));
    check('['+TZ+'] ...and its ends_at lands within a minute of the close time',
          !!saved && Math.abs((saved.ends_at-Date.now())-60*60*1000) < 60*1000,
          saved && String((saved.ends_at-Date.now())/1000|0)+'s away, expected ~3600s');
  }

  if(nowMin > 120){                          // a window that already finished
    const a=hm(nowMin-120), b=hm(nowMin-60);
    reset({'sched-start-h':a.h,'sched-start-m':a.m,'sched-end-h':b.h,'sched-end-m':b.m});
    scheduleSession();
    check('['+TZ+'] a window that already ended today is refused',
          saved===null && toasts.some(t=>/already passed/i.test(t)),
          JSON.stringify(toasts));
  }

  reset({'sched-start-h':15,'sched-start-m':0,'sched-end-h':9,'sched-end-m':0});
  scheduleSession();
  check('['+TZ+'] an end before the start is refused',
        saved===null && toasts.some(t=>/after the start|after start/i.test(t)),
        JSON.stringify(toasts));

  reset({'sched-start-h':'x','sched-start-m':0,'sched-end-h':9,'sched-end-m':0});
  scheduleSession();
  check('['+TZ+'] a non-numeric time is refused',
        saved===null && toasts.some(t=>/valid times/i.test(t)), JSON.stringify(toasts));

  console.log(fails?('\n'+fails+' FAILURE(S) in '+TZ):('\nAll scheduler checks passed in '+TZ));
  process.exit(fails?1:0);
}

// ── parent: run the whole thing under four timezones ──
//
// Arizona never observes DST, so a Phoenix window is a fixed wall-clock time
// while the host's own clock is not. Tokyo is +16 from Arizona and crosses the
// date line relative to it; UTC is +7. If any of these disagree, the schedule
// an instructor stores depends on the laptop they stored it from.
const ZONES=['America/Phoenix','UTC','America/New_York','Asia/Tokyo'];
let bad=0, total=0;
for(const tz of ZONES){
  let out='';
  try{
    out=execFileSync(process.execPath,[__filename],
      {encoding:'utf8', env:Object.assign({}, process.env, {TZ:tz, JEX_TZ_CHILD:'1'})});
  }catch(e){ bad++; out=(e.stdout||'')+(e.stderr||''); }
  process.stdout.write(out);
  total+=(out.match(/^PASS: /gm)||[]).length+(out.match(/^FAIL: /gm)||[]).length;
}
console.log(bad?('\n'+bad+' TIMEZONE(S) FAILED'):('\nAll scheduler checks passed in all '+ZONES.length+' timezones ('+total+' checks).'));
process.exit(bad?1:0);
