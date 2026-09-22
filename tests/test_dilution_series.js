// A dilution must not draw a crash on the index chart.
//
// JXI's history is rebuilt in the browser from its constituents' histories
// (indexSeries). Each point is price / (first price * index_base_adjust). A 2:1
// dilution halves the price and halves index_base_adjust, so the LIVE level
// does not move -- as designed. But indexSeries divided every historical point
// by the CURRENT adjust, so every point from before the dilution was divided by
// half the base it was really priced against, and doubled. The chart read
// 20 -> 23.94 -> 11.98 across a dilution on an index whose value never changed:
// "-50.00% today" beside its only constituent at +0.00%.
//
// rpc_review_dilution now marks the point it appends with `a`, the step it
// applied (see sql/dilution_and_restore_opens.sql). indexSeries walks back from
// the current adjust and undoes each marked step as it passes it.
//
// The same file fixes two server bugs that sat behind the same screen, pinned
// at the bottom: a snapshot restore left the day's opening prices behind, and
// the session-open capture could reach the index row before its constituents.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'..','sql','dilution_and_restore_opens.sql'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

function grabFn(name){
  const m=new RegExp('^function '+name+'\\(','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(m.index,i+1);} }
  throw new Error('unterminated: '+name);
}

global.getUser=()=>({id:'u'});
global.getCo=t=>DB.companies.find(c=>c.ticker===t)||null;
global.getClassMeta=()=>null;
global.isHiddenTestEntity=()=>false;
global.indexUnitDivisor=()=>100;
eval(grabFn('computeIndex').replace(/^function /,'global.computeIndex=function '));
eval(grabFn('indexSeries').replace(/^function /,'global.indexSeries=function '));

const T=h=>'2026-09-21T'+String(h).padStart(2,'0')+':00:00.000Z';
const co=(ticker,hist,adjust)=>({ticker,status:'listed',owner_id:'u',is_index_fund:false,
  index_base_adjust:adjust,price:hist[hist.length-1].p,price_history:hist});
const load=(...cos)=>{global.DB={session:{},users:[],shareClasses:[],
  companies:[...cos,{ticker:'JXI',is_index_fund:true,status:'listed',price_history:[]}]};};
const series=()=>indexSeries(getCo('JXI')).map(p=>p.p);
const live=()=>Math.round(computeIndex(null).value/100*100)/100;
const worstStep=s=>Math.min(...s.slice(1).map((v,i)=>v/s[i]-1))*100;

// What rpc_review_dilution does: price * shares/new_shares, the step derived
// from the actual rounded prices, the adjust scaled by the same step.
function dilute(c,ratio,hour,mark){
  const newPrice=Math.max(0.01,Math.round(c.price*ratio*100)/100);
  const step=newPrice/c.price;
  c.price_history=c.price_history.concat([mark?{p:newPrice,t:T(hour),a:step}:{p:newPrice,t:T(hour)}]);
  c.price=newPrice;
  c.index_base_adjust=(c.index_base_adjust??1)*step;
}

// ── the bug, reproduced ──
{
  const a=co('AZEI',[{p:22.73,t:T(10)},{p:27.21,t:T(12)}],1);
  load(a);
  const before=series();
  dilute(a,0.5,14,false);
  const s=series();
  check('before any dilution the series is 10 -> 11.97', before.join(',')==='10,11.97', before.join(','));
  check('an UNMARKED dilution draws a ~50% crash', worstStep(s)<-49, worstStep(s).toFixed(2)+'%');
  check('...while the live level did not move', Math.abs(live()-11.97)<=0.01, String(live()));
}

// ── fixed ──
{
  const a=co('AZEI',[{p:22.73,t:T(10)},{p:27.21,t:T(12)}],1);
  load(a);
  dilute(a,0.5,14,true);
  const s=series();
  check('a MARKED dilution leaves the history where it was: 10 -> 11.97 -> 11.97',
        s.join(',')==='10,11.97,11.97', s.join(','));
  check('...no step anywhere worse than cent rounding', Math.abs(worstStep(s))<0.2, worstStep(s).toFixed(2)+'%');
  check('...and the chart ends at the live level', Math.abs(s[s.length-1]-live())<=0.01, s[s.length-1]+' vs '+live());
}

// Two dilutions, both marked, with real trading between and after.
{
  const a=co('AZEI',[{p:20,t:T(8)},{p:22,t:T(9)}],1);
  load(a);
  dilute(a,0.5,10,true);                           // 22 -> 11
  a.price_history.push({p:12.1,t:T(11)});a.price=12.1;   // a real +10%
  dilute(a,2/3,12,true);                           // 12.10 -> 8.07
  a.price_history.push({p:7.26,t:T(13)});a.price=7.26;   // a real -10%
  const s=series();
  check('two marked dilutions: the chart shows only the two real moves',
        s.join(',')==='10,11,11,12.1,12.1,10.89', s.join(','));
  check('...and ends at the live level', Math.abs(s[s.length-1]-live())<=0.01, s[s.length-1]+' vs '+live());
}

// Two constituents, one diluted: the other's history is untouched.
{
  const a=co('AZEI',[{p:20,t:T(8)},{p:20,t:T(9)}],1);
  const b=co('BETA',[{p:50,t:T(8)},{p:55,t:T(9)}],1);
  load(a,b);
  const before=series();
  dilute(a,0.5,10,true);
  const s=series();
  check('with a second constituent the history before the dilution is unchanged',
        s.slice(0,before.length).join(',')===before.join(','), before.join(',')+' vs '+s.join(','));
  check('...and the dilution point adds no move', s[s.length-1]===s[s.length-2], s.join(','));
}

// A history with no marks is read exactly as before -- nothing already stored
// changes meaning.
{
  const a=co('AZEI',[{p:10,t:T(8)},{p:12,t:T(9)}],1);
  load(a);
  check('an undiluted history is unaffected', series().join(',')==='10,12', series().join(','));
}

// ── the server half ──
check('rpc_review_dilution writes the step onto the point it appends',
      /''a'', case when v_co\.price > 0 then v_new_price \/ v_co\.price else 1 end/.test(sql));
check('a restore re-records the opening prices',
      /set session_open_prices = jex_open_prices_now\(\),/.test(sql) && /rpc_admin_restore_snapshot/.test(sql));
check('the open capture reaches companies before the index',
      /order by coalesce\(is_index_fund, false\) loop/.test(sql));
check('...and so does the helper the restore uses',
      /order by coalesce\(is_index_fund, false\), ticker loop/.test(sql));

// ── dilutions approved before the mark existed ──
//
// mark_past_dilution.sql marks AZEI's Sep 3 dilution after the fact. It must
// refuse to guess: exactly one matching step after the application, or skip.
const mark=fs.readFileSync(path.join(__dirname,'..','sql','mark_past_dilution.sql'),'utf8');
check('a past dilution is marked only when exactly one point matches',
      /\(select count\(\*\) from hits\) <> 1/.test(mark));
check('...and only at or after the moment it was applied for',
      /\(e->>'t'\)::timestamptz >= p_since/.test(mark));
check('...never twice', /when exists \(select 1 from jsonb_array_elements\(p_hist\) e where e \? 'a'\)/.test(mark));
check('...and the same point is marked inside saved snapshots, or a restore brings the drop back',
      /update jex_snapshots set data = v_data/.test(mark));
{
  // The production shape, marked the way that file marks it: the step is the
  // whole adjust, since only one dilution produced it.
  const hist=[{p:22.73,t:'2026-08-20T16:00:00.000Z'},{p:27.50,t:'2026-08-24T16:00:00.000Z'},
              {p:25.00,t:'2026-08-25T16:00:00.000Z'},{p:29.93,t:'2026-09-02T16:00:00.000Z'},
              {p:27.21,t:'2026-09-04T01:00:00.000Z'},{p:27.40,t:'2026-09-10T16:00:00.000Z'}];
  load(co('AZEI',hist.map(p=>({...p})),10/11));
  const before=series();
  hist[4].a=10/11;
  load(co('AZEI',hist,10/11));
  const after=series();
  check('unmarked, the Sep 3 dilution draws a 9% drop',
        Math.round((before[4]/before[3]-1)*10000)/100===-9.05, (before[4]/before[3]-1)*100+'%');
  check('marked, it is flat', after[4]===after[3], after.join(','));
  check('...a real move of the same size before it still shows',
        Math.round((after[2]/after[1]-1)*10000)/100===-9.09, after.join(','));
  check('...and the live end of the chart does not change', after[after.length-1]===before[before.length-1]);
}

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
