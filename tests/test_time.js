// Arizona time.
//
// JEX runs on Arizona time everywhere: the trading schedule, the session
// clock, and every timestamp the server writes. Arizona does not observe DST,
// so it is UTC-7 all year -- which removes one whole class of bug and leaves
// two others that this suite pins down.
//
// 1. Two different kinds of value get called "a time". A real instant
//    (Date.now(), created_at) is correct on its own and must be FORMATTED in
//    Phoenix. A wall-clock Date -- what getAZTime() returns, so the scheduler
//    can ask what hour it is in Phoenix -- has deliberately meaningless
//    absolute time. Handing the second to something expecting the first
//    converts twice; the admin session panel did exactly that and read seven
//    hours off for anyone whose device was not set to Arizona.
//
// 2. Timestamps are stored in two formats. `created_at` is a real timestamptz.
//    `ts` is a DISPLAY STRING the server builds with
//    to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI:SS AM')
//    -- "Aug 20, 9:15:00 AM". Anything comparing a ts has to speak that
//    format; three "today's trades" figures compared it against "8/20/2026"
//    and therefore matched nothing, ever.
//
// Every case below is run in four timezones, because the bugs above are
// invisible from Arizona and only appear elsewhere.
const fs=require('fs'),path=require('path');
const {execFileSync}=require('child_process');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

function extract(name){
  const m=new RegExp('^(?:const|function) '+name+'\\b','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  const start=m.index;
  // walk to the end of the declaration: for a function, brace-match; for a
  // const arrow, run to the terminating semicolon at depth 0.
  let i=src.indexOf('{',start), d=0;
  if(src.slice(start,start+9)==='function '){
    for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--; if(!d)return src.slice(start,i+1);} }
  }
  let depth=0;
  for(i=start;i<src.length;i++){
    const c=src[i];
    if('([{'.includes(c))depth++;
    else if(')]}'.includes(c))depth--;
    else if(c===';'&&depth===0)return src.slice(start,i+1);
  }
  throw new Error('unterminated: '+name);
}

// The helpers under test, pulled from the shipped source.
// _azFmt holds the two shared Intl.DateTimeFormat instances (built once, not
// per call) and _todayCache the once-a-second "today's prefix". Both are
// dependencies of the helpers below and have to come before them.
const HELPERS=['AZ_TZ','_azFmt','azParts','getAZTime','fmtAZTime','azDateStamp','azDateLabel',
               'azTsPrefix','_todayCache','todayPrefix','isTodayTs','ts','pad',
               'isNewTradingDay'].map(extract).join('\n');

// Run a body in a given TZ, in a fresh node so process.env.TZ actually takes.
function inTZ(tz, body){
  const script = HELPERS + '\nlet DB={session:{}};\n' + body;
  const out=execFileSync(process.execPath, ['-e', script],
    {env:Object.assign({}, process.env, {TZ:tz}), encoding:'utf8'});
  return JSON.parse(out.trim().split('\n').pop());
}

// UTC and Asia/Tokyo bracket Arizona on both sides of the date line; New_York
// is the realistic "student travelled / laptop set wrong" case; Phoenix is the
// classroom itself and must stay correct too.
const ZONES=['America/Phoenix','UTC','America/New_York','Asia/Tokyo'];

// A fixed instant with a known Arizona reading, chosen to fall on a different
// CALENDAR DAY in UTC than in Phoenix: 2026-08-21T02:30:00Z is
// Aug 20, 7:30:00 PM in Arizona.
const INSTANT='2026-08-21T02:30:00.000Z';

console.log('=== the Arizona clock is the same everywhere ===');
for(const tz of ZONES){
  const r=inTZ(tz, `
    const d=new Date(${JSON.stringify(INSTANT)});
    console.log(JSON.stringify({fmt:fmtAZTime(d), parts:azParts(d), stamp:azDateStamp(d),
                                label:azDateLabel(d), prefix:azTsPrefix(d)}));`);
  check(tz+': formats the instant as Arizona 7:30 PM',
    /Aug 20/.test(r.fmt)&&/07:30:00\s?PM/.test(r.fmt)&&/ MST$/.test(r.fmt), r.fmt);
  check(tz+': wall-clock fields are Arizona (Aug 20, hour 19)',
    r.parts.year===2026&&r.parts.month===8&&r.parts.day===20&&r.parts.hour===19&&r.parts.minute===30, JSON.stringify(r.parts));
  check(tz+': weekday is Thursday in Arizona', r.parts.weekday===4, String(r.parts.weekday));
  // In UTC and Tokyo this instant is already Aug 21. The stamp must not follow.
  check(tz+': date stamp is the Arizona day, not UTC\'s', r.stamp==='2026-08-20', r.stamp);
  check(tz+': date label is the Arizona day', r.label==='8/20/2026', r.label);
  check(tz+': ts prefix matches the server format', r.prefix==='Aug 20,', r.prefix);
}

console.log('\n=== getAZTime() reads as Arizona wall clock in any timezone ===');
for(const tz of ZONES){
  const r=inTZ(tz, `
    const w=getAZTime(new Date(${JSON.stringify(INSTANT)}));
    console.log(JSON.stringify({h:w.getHours(), mi:w.getMinutes(), day:w.getDay(), date:w.getDate(), month:w.getMonth()}));`);
  check(tz+': getHours() is the Arizona hour', r.h===19, String(r.h));
  check(tz+': getDay() is the Arizona weekday', r.day===4, String(r.day));
  check(tz+': getDate() is the Arizona day of month', r.date===20&&r.month===7, r.date+'/'+r.month);
}

console.log('\n=== the double-conversion that broke the admin clock ===');
// fmtAZTime(getAZTime()) is the old call. It is only correct from Arizona.
for(const tz of ZONES){
  const r=inTZ(tz, `
    const d=new Date(${JSON.stringify(INSTANT)});
    console.log(JSON.stringify({right:fmtAZTime(d), doubled:fmtAZTime(getAZTime(d))}));`);
  check(tz+': the shipped call is right', /07:30:00\s?PM/.test(r.right), r.right);
  if(tz==='America/Phoenix')
    check(tz+': double conversion happens to agree here (which is why it hid)',
      r.doubled===r.right, r.doubled);
  else
    check(tz+': double conversion would have been WRONG here',
      r.doubled!==r.right, 'doubled='+r.doubled);
}
check('the admin panel no longer double-converts',
  /Arizona time \(MST, UTC−7\): <strong[^>]*>\$\{fmtAZTime\(\)\}/.test(src));

console.log('\n=== ts() matches what the server writes ===');
// Server: to_char(now() at time zone 'America/Phoenix', 'Mon FMDD, FMHH12:MI:SS AM')
const SERVER_TS=/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}:\d{2} (AM|PM)$/;
for(const tz of ZONES){
  const r=inTZ(tz, `console.log(JSON.stringify({ts:ts()}));`);
  check(tz+': ts() has the server\'s shape', SERVER_TS.test(r.ts), r.ts);
  check(tz+': ts() carries a date, not just a clock time', /\d,/.test(r.ts), r.ts);
}
// Same instant, every zone -> the same string. That is the whole point.
{
  const seen=new Set();
  for(const tz of ZONES){
    const r=inTZ(tz, `
      const p=new Intl.DateTimeFormat('en-US',{timeZone:AZ_TZ,month:'short',day:'numeric',
        hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true}).formatToParts(new Date(${JSON.stringify(INSTANT)}));
      const g=t=>(p.find(x=>x.type===t)||{}).value||'';
      console.log(JSON.stringify({s:g('month')+' '+g('day')+', '+g('hour')+':'+g('minute')+':'+g('second')+' '+g('dayPeriod').toUpperCase()}));`);
    seen.add(r.s);
  }
  check('every timezone produces one identical ts string', seen.size===1, [...seen].join(' | '));
  check('and it is the Arizona reading', [...seen][0]==='Aug 20, 7:30:00 PM', [...seen][0]);
}
check('ts() no longer uses toLocaleTimeString', !/const ts=\(\)=>new Date\(\)\.toLocaleTimeString\(\)/.test(src));

console.log('\n=== "today\'s trades" actually matches a real ts ===');
{
  const r=inTZ('UTC', `
    const rows=[{ts:'Aug 20, 9:15:00 AM'},{ts:'Aug 20, 7:30:00 PM'},{ts:'Aug 19, 3:00:00 PM'},
                {ts:'Aug 2, 9:00:00 AM'},{ts:null},{ts:'8/20/2026'}];
    const today='Aug 20,';
    const match=rows.filter(t=>!!t.ts&&String(t.ts).startsWith(today)).length;
    const oldWay=rows.filter(t=>t.ts&&t.ts.includes('8/20/2026')).length;
    console.log(JSON.stringify({match, oldWay}));`);
  check('two of the six seeded rows are from today', r.match===2, String(r.match));
  check('the old toLocaleDateString comparison matched only the bogus row', r.oldWay===1, String(r.oldWay));
}
// "Aug 2," must not swallow "Aug 20,"
{
  const r=inTZ('UTC', `
    console.log(JSON.stringify({
      wrong:'Aug 20, 9:15:00 AM'.startsWith('Aug 2,'),
      right:'Aug 20, 9:15:00 AM'.startsWith('Aug 20,'),
      single:'Aug 2, 9:15:00 AM'.startsWith('Aug 2,')}));`);
  check('a single-digit day does not match a two-digit one', r.wrong===false);
  check('and still matches itself', r.single===true&&r.right===true);
}
for(const n of ['renderAdminDashboard','renderExchangeStats'])
  check(n+' uses isTodayTs', new RegExp('function '+n+'[\\s\\S]{0,900}isTodayTs\\(t\\.ts\\)').test(src));
check('no date filter compares a ts to toLocaleDateString any more',
  !/\.ts\.includes\(/.test(src));

console.log('\n=== the day rolls over on the Arizona boundary ===');
// Midnight Arizona is 07:00 UTC. An instant just before and just after must
// land on different Arizona days regardless of where the browser is.
for(const tz of ['UTC','Asia/Tokyo']){
  const r=inTZ(tz, `
    const before=new Date('2026-08-20T06:59:00.000Z');   // 11:59 PM Aug 19 AZ
    const after =new Date('2026-08-20T07:01:00.000Z');   // 12:01 AM Aug 20 AZ
    console.log(JSON.stringify({b:azDateStamp(before), a:azDateStamp(after),
                                bh:azParts(before).hour, ah:azParts(after).hour}));`);
  check(tz+': 11:59 PM Arizona is still the 19th', r.b==='2026-08-19', r.b);
  check(tz+': 12:01 AM Arizona is the 20th', r.a==='2026-08-20', r.a);
  check(tz+': midnight reads as hour 0, not 24', r.ah===0, String(r.ah));
}

console.log('\n=== the export filename uses the Arizona date ===');
check('exportTableCSV stamps the Arizona day', /const now=azDateStamp\(\)/.test(src));
check('and no longer slices a UTC ISO string',
  !/const now=new Date\(\)\.toISOString\(\)\.slice\(0,10\)/.test(src));
{
  // 5pm Arizona is already tomorrow in UTC -- the case that made this wrong.
  const r=inTZ('America/Phoenix', `
    const d=new Date('2026-08-21T00:30:00.000Z');   // 5:30 PM Aug 20 in Arizona
    console.log(JSON.stringify({az:azDateStamp(d), utc:d.toISOString().slice(0,10)}));`);
  check('an evening export is stamped with the Arizona day', r.az==='2026-08-20', r.az);
  check('which is not what the UTC slice gave', r.utc==='2026-08-21', r.utc);
}

console.log('\n=== no string-parsing round trip on the scheduler path ===');
// new Date(new Date().toLocaleString(...)) relied on the engine re-parsing a
// localized string. That format is not specified, and recent ICU emits a
// narrow no-break space before AM/PM that some parsers reject -- on the code
// path that decides when the market opens.
// Comments stripped first: the replacement helper's own comment quotes the
// old expression to explain why it went, and matching that is not a finding.
const codeOnly=src.replace(/^\s*\/\/.*$/gm,'');
check('getAZTime no longer parses a localized string',
  !/new Date\(new Date\(\)\.toLocaleString\('en-US',\{timeZone/.test(codeOnly));
check('getAZTime builds from numeric parts', /function getAZTime\([\s\S]{0,200}azParts\(/.test(src));
check('isNewTradingDay compares fields, not re-parsed strings',
  /function isNewTradingDay\(\)\{[\s\S]{0,300}azParts\(/.test(src)&&
  !/lastAz\.toDateString\(\)/.test(src));

console.log('\n=== MST all year: Arizona has no DST ===');
for(const label of ['2026-01-15T20:00:00.000Z','2026-07-15T20:00:00.000Z']){
  const r=inTZ('UTC', `
    const d=new Date(${JSON.stringify(label)});
    console.log(JSON.stringify({h:azParts(d).hour, f:fmtAZTime(d)}));`);
  check('20:00Z reads as 1 PM Arizona in '+label.slice(5,7)+' (no DST shift)', r.h===13, String(r.h));
  check('and is labelled MST, never MDT ('+label.slice(5,7)+')', / MST$/.test(r.f)&&!/MDT/.test(r.f), r.f);
}

console.log('\n=== session scheduling arithmetic ===');
{
  // scheduleSession mixes a wall-clock Date (for the hour) with Date.now()
  // (for the deadline). The deadline must be a real duration from now.
  const r=inTZ('Asia/Tokyo', `
    const az=getAZTime(new Date('2026-08-20T21:00:00.000Z'));   // 2:00 PM AZ
    const nowMin=az.getHours()*60+az.getMinutes();
    const endMin=15*60;                                          // 3:00 PM AZ
    const msUntilEnd=(endMin-nowMin)*60*1000-az.getSeconds()*1000;
    console.log(JSON.stringify({nowMin, msUntilEnd}));`);
  check('2:00 PM Arizona is minute 840 even from Tokyo', r.nowMin===840, String(r.nowMin));
  check('an hour remains until the 3:00 PM close', r.msUntilEnd===3600000, String(r.msUntilEnd));
}
check('ends_at is built from Date.now(), not a wall-clock Date',
  /ends_at:Date\.now\(\)\+msUntilEnd/.test(src));
check('the countdown measures against Date.now()',
  /function tickTimer\(\)\{[\s\S]{0,120}DB\.session\.ends_at-Date\.now\(\)/.test(src));

console.log('\n=== timestamps that are real instants stay real instants ===');
check('isoNow() is UTC ISO', /const isoNow=\(\)=>new Date\(\)\.toISOString\(\);/.test(src));
check('vote expiry is stored as UTC ISO', /new Date\(Date\.now\(\)\+24\*60\*60\*1000\)\.toISOString\(\)/.test(src));
check('the circuit-breaker cooldown measures created_at against Date.now()',
  /const haltedAt=new Date\(h\.created_at\|\|h\.ts\)\.getTime\(\);[\s\S]{0,120}now-haltedAt<5\*60\*1000/.test(src));
check('daysAgo divides by a whole day in ms', /\/86400000\)/.test(src));

console.log('\n=== every displayed time is Arizona, not the device ===');
// The chart axis, the "Open" anchor and the vote-close line all used to render
// in the device's timezone, so the same chart read differently in the
// classroom and at a student's house.
check('chart labels pin the timezone', /function fmtChartLabel[\s\S]{0,600}timeZone:AZ_TZ/.test(src));
check('chart labels no longer use the device locale/zone',
  !/function fmtChartLabel[\s\S]{0,600}toLocale(Time|Date)String\(\[\]/.test(src));
check('the Open anchor compares Arizona calendar days',
  /function anchorPointLabel[\s\S]{0,400}azParts\(d\)/.test(src));
check('and not the device\'s toDateString',
  !/function anchorPointLabel[\s\S]{0,400}d\.toDateString\(\)===new Date\(\)\.toDateString\(\)/.test(src));
check('vote close time is formatted in Arizona', /fmtAZTime\(new Date\(v\.closes_at\)\)/.test(src));
check('no display path calls toLocaleString with no timezone',
  !/toLocale(Date|Time)?String\(\[\]/.test(codeOnly));
{
  // Same instant, four zones, one label.
  const seen=new Set(), anchors=new Set();
  for(const tz of ZONES){
    const r=inTZ(tz, `
      const d=new Date(${JSON.stringify(INSTANT)});
      console.log(JSON.stringify({
        lab:d.toLocaleTimeString('en-US',{timeZone:AZ_TZ,hour:'2-digit',minute:'2-digit'}),
        day:d.toLocaleDateString('en-US',{timeZone:AZ_TZ,month:'short',day:'numeric'})}));`);
    seen.add(r.lab); anchors.add(r.day);
  }
  check('a 1D chart label is identical in every timezone', seen.size===1, [...seen].join(' | '));
  check('and reads as the Arizona hour', /07:30/.test([...seen][0]), [...seen][0]);
  check('a dated label is identical in every timezone', anchors.size===1&&[...anchors][0]==='Aug 20',
    [...anchors].join(' | '));
}

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
