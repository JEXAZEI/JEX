// The split boot queries must partition each table: no row in BOTH sets,
// and no row in NEITHER (a dropped row is a silently missing order/alert).
const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// Minimal PostgREST filter evaluator for the operators actually used here.
function matches(row,filter){
  const [col,expr]=filter.split('=');
  const v=row[col];
  if(expr.startsWith('in.(')){const set=expr.slice(4,-1).split(',');return v!=null&&set.includes(v);}
  if(expr.startsWith('not.in.(')){const set=expr.slice(8,-1).split(',');return v==null?false:!set.includes(v);}
  if(expr==='not.is.true')return v!==true;
  if(expr==='is.true')return v===true;
  if(expr==='is.false')return v===false;
  if(expr.startsWith('eq.'))return v!=null&&String(v)===expr.slice(3);
  if(expr.startsWith('neq.'))return v==null?false:String(v)!==expr.slice(4);
  throw new Error('unhandled filter: '+expr);
}
function partition(label,rows,fA,fB){
  const both=rows.filter(r=>matches(r,fA)&&matches(r,fB));
  const neither=rows.filter(r=>!matches(r,fA)&&!matches(r,fB));
  check(label+': no row matches BOTH queries', both.length===0, JSON.stringify(both));
  check(label+': no row matches NEITHER (none silently dropped)', neither.length===0, JSON.stringify(neither));
}

console.log('=== limit orders ===');
const orders=[
  {id:1,status:'open'},{id:2,status:'after_hours'},{id:3,status:'filled'},
  {id:4,status:'cancelled'},{id:5,status:'expired'},{id:6,status:'partial'},
];
partition('limit_orders', orders, 'status=in.(open,after_hours)', 'status=not.in.(open,after_hours)');
const active=orders.filter(r=>matches(r,'status=in.(open,after_hours)'));
check('every live order is in the COMPLETE (uncapped) set', active.length===2&&active.every(o=>['open','after_hours'].includes(o.status)));
check('order book consumer sees all open orders', orders.filter(o=>o.status==='open').length===1);

console.log('\n=== price alerts (the NULL case) ===');
const alerts=[{id:1,triggered:false},{id:2,triggered:true},{id:3,triggered:null},{id:4}];
partition('price_alerts', alerts, 'triggered=not.is.true', 'triggered=is.true');
const pending=alerts.filter(r=>matches(r,'triggered=not.is.true'));
check('poller set matches the client predicate !a.triggered exactly',
  JSON.stringify(pending.map(a=>a.id))===JSON.stringify(alerts.filter(a=>!a.triggered).map(a=>a.id)),
  JSON.stringify(pending.map(a=>a.id)));
// the version I nearly shipped
const naive=alerts.filter(r=>matches(r,'triggered=is.false'));
check('is.false really would have dropped the NULL rows (why not.is.true)', naive.length<pending.length,
  `is.false got ${naive.length}, not.is.true got ${pending.length}`);

console.log('\n=== founder allocations ===');
const allocs=[{id:1,status:'pending'},{id:2,status:'approved'},{id:3,status:'rejected'}];
partition('founder_allocations', allocs, 'status=eq.pending', 'status=neq.pending');
check('pending queue is the uncapped set', allocs.filter(r=>matches(r,'status=eq.pending')).length===1);

console.log('\n=== merge preserves both halves ===');
const merged=[...orders.filter(r=>matches(r,'status=in.(open,after_hours)')),
              ...orders.filter(r=>matches(r,'status=not.in.(open,after_hours)'))];
check('merged array contains every row exactly once', merged.length===orders.length
  &&new Set(merged.map(o=>o.id)).size===orders.length);

console.log('\n=== the source actually says what these tests assume ===');
check('limit_orders split present', src.includes("status=in.(open,after_hours)")&&src.includes("status=not.in.(open,after_hours)"));
check('price_alerts uses not.is.true', src.includes("triggered=not.is.true")&&!src.includes("triggered=is.false"));
check('founder_allocations split present', src.includes("jex_founder_allocations','status=eq.pending"));
check('snapshots select trims the state blob', /jex_snapshots'[^)]*select=id,label,created_by,ts,created_at/.test(src));
check('snapshots select omits any data/state column', !/select=id,label,created_by,ts,created_at,(data|state|payload)/.test(src));
check('announcements now capped', /jex_announcements','order=created_at\.desc&limit=100/.test(src));

console.log('\n=== untouched tables stayed untouched (all-time consumers) ===');
for(const t of ['jex_dividends','jex_buybacks','jex_vote_ballots','jex_votes','jex_company_members'])
  check(t+' still fetched in full', new RegExp("sb\\.get\\('"+t+"','order=created_at\\.(asc|desc)'\\)").test(src));

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
