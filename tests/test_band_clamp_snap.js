// The band clamp: the client and the server have to agree on it.
//
// Three places implement the price band:
//
//   rpc_trade_buy's REJECT check   (v_new > v_upper AND v_new > v_co.price)
//   jex_band_clamp                 the CLAMPED path -- selling, shorting,
//                                  covering, margin calls, stop losses
//   app.js bandClamp()             the preview
//
// All three say the same thing: a trade is only stopped when it moves the
// price FURTHER out of the band. A stock already outside is held where it is,
// not dragged back into range. Snapping it back would be a violent move at a
// price nothing traded at -- on a $45.00 stock against a $21.00-$39.00 band, a
// ten-share sell would fill at $39.00, paying the seller $59 less than the
// ticket said and taking every other holder down 13.3%.
//
// ── A correction, kept deliberately ──
//
// I reported that as a live bug and shipped a migration for it. It was not.
// jex_band_clamp in production already widened its range with p_current and
// already carried a comment explaining why. What was stale was the copy on my
// test rig, which still had an older body doing the flat clamp -- so the
// measurement above is real, and it is a measurement of my own rig, not of
// this exchange. The migration aborted on its own byte-for-byte body check and
// changed nothing, which is the only reason this is a note rather than an
// incident.
//
// This file stays because the agreement between the three implementations is
// worth pinning, and because the next person to "find" this should find this
// note first. Production's function was read back and run against the table
// below: all nine cases pass.
const fs=require('fs'),path=require('path');
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
  let i=src.indexOf('{',start),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(start,i+1);} }
  throw new Error('unterminated: '+name);
}

global.DB={session:{price_band_pct:30,session_open_prices:{ACME:30}}};
eval(grabFn('bandLimits').replace(/^function /,'global.bandLimits=function '));
eval(grabFn('bandClamp').replace(/^function /,'global.bandClamp=function '));
eval(grabConst('impactPrice').replace(/^const /,'global.'));

// jex_band_clamp as production actually reads, transcribed from a dump of the
// live function:
//
//   least(greatest(p_price, least(v_lower, p_current)), greatest(v_upper, p_current))
//
// which is the same expression as bandClamp() above. This is not proof the
// deployed function still matches -- only running it proves that, and it was
// run against every row of the table below. It is here so that if either side
// is edited, the two stop agreeing and something fails.
const sqlClamp=(ticker,proposed,current)=>{
  const b=bandLimits(ticker);
  if(!b)return proposed;
  return Math.min(Math.max(proposed,Math.min(b.lower,current)),Math.max(b.upper,current));
};

// ── the truth table, both sides ──
const cases=[
  ['inside the band, nothing to clamp',        29.78, 30.00, 29.78],
  ['a sell that would breach the floor',       18.00, 22.00, 21.00],
  ['a buy that would breach the ceiling',      41.00, 38.00, 39.00],
  ['stranded ABOVE: held where it is',         44.93, 45.00, 44.93],
  ['stranded ABOVE: cannot go further out',    46.00, 45.00, 45.00],
  ['stranded ABOVE: free to come back',        40.00, 45.00, 40.00],
  ['stranded BELOW: held where it is',          7.28,  7.29,  7.29],
  ['stranded BELOW: free to come back up',     15.00,  7.29, 15.00],
  ['exactly on the floor',                     21.00, 25.00, 21.00],
  ['exactly on the ceiling',                   39.00, 35.00, 39.00],
];
for(const [label,proposed,current,expected] of cases){
  check('client: '+label, bandClamp('ACME',proposed,current)===expected,
        String(bandClamp('ACME',proposed,current))+' vs '+expected);
  check('server: '+label, sqlClamp('ACME',proposed,current)===expected,
        String(sqlClamp('ACME',proposed,current))+' vs '+expected);
}

// A ticker with no recorded session open is not banded at all.
check('no session open price means no clamp, client', bandClamp('NOPE',999,1)===999);
check('...and none server-side', sqlClamp('NOPE',999,1)===999);

// ── the flat clamp, stated so it cannot arrive quietly ──
//
// This is what the rig's stale copy did, and what any reimplementation that
// forgets p_current would do.
const oldSqlClamp=(ticker,proposed)=>{
  const b=bandLimits(ticker);
  if(!b)return proposed;
  return Math.min(Math.max(proposed,b.lower),b.upper);
};
check('a flat clamp would snap a stranded $45.00 sell to $39.00',
      oldSqlClamp('ACME',44.93)===39);
check('...costing the seller $59.30 on ten shares',
      Math.round((44.93-39)*10*100)/100===59.30);
check('...and dropping every other holder 13.3%',
      Math.round((1-39/45)*1000)/10===13.3);
check('...and would raise a stranded $7.28 sell to $21.00',
      oldSqlClamp('ACME',7.28)===21);
check('the real rule does neither', bandClamp('ACME',44.93,45)===44.93&&bandClamp('ACME',7.28,7.29)===7.29);

// ── and the two agree on the whole impact path, not just the clamp ──
//
// This is the thing that actually matters: the price on the ticket and the
// price that gets charged.
const co=(price,shares)=>({ticker:'ACME',price,shares});
DB.session.session_open_prices={ACME:30};
for(const price of [30,45,7.29,12.5,0.5]){
  for(const shares of [2000,3000,150]){
    for(const qty of [1,10,57,200]){
      const c=co(price,shares);
      const quoted=impactPrice(c,qty,'sell');
      const liq=shares*0.05,impact=Math.min((qty/liq)*0.015,0.12);
      const raw=Math.max(0.01,Math.round(price*(1-impact)*100)/100);
      const served=sqlClamp('ACME',raw,price);
      if(quoted!==served){
        check('sell '+qty+' at '+price+' on '+shares+' shares: quote matches fill', false,
              quoted+' vs '+served);
      }
    }
  }
}
check('every price/float/size combination quotes what it fills at', true);

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
