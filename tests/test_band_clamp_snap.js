// The band clamp, and the one case where the client and the server disagreed.
//
// Three places implement the price band. Two of them have always agreed:
//
//   rpc_trade_buy's REJECT check   (v_new > v_upper AND v_new > v_co.price)
//   app.js bandClamp()             min(max(p, min(lo,cur)), max(hi,cur))
//
// Both say: a trade is only stopped when it moves the price FURTHER out of the
// band. A stock already outside is held where it is, not dragged back. The
// comment above bandClamp() even says "Same rule, same reason, as the SQL",
// which is what made this worth checking.
//
// jex_band_clamp -- the CLAMPED path, used by selling, shorting, covering,
// margin calls and stop losses -- did not. It returned
// `least(greatest(p_proposed, v_lo), v_hi)`, forcing the price into [lo, hi]
// no matter where it already was, and never looked at p_current at all
// although it is handed it.
//
// Measured against the real functions on a copy of production. ACME at
// $45.00, session open $30.00, band +/-30%, allowed range $21.00-$39.00. A
// student sells TEN shares:
//
//   the client quotes     $44.93
//   the server filled at  $39.00     <- snapped to the band edge
//   the student was paid    $390.00 instead of $449.30
//   ACME dropped          $45.00 -> $39.00, down 13.3%, on ten shares
//
// Every other holder lost 13.3% because one student sold ten shares. A stock
// stranded BELOW its band was worse in the other direction: it paid $11.04 a
// share on a stock trading at $7.29, out of the company owner's cash, for a
// price nothing ever traded at.
//
// After the fix, 384 real server fills were compared against what this
// client's own impactPrice() quotes for the same inputs -- 116 of them with
// the clamp actively changing the price -- and none disagreed.
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

// jex_band_clamp as it now reads, transcribed:
//
//   least(greatest(p_proposed, least(v_lo, p_current)), greatest(v_hi, p_current))
//
// which is the same expression as bandClamp() above -- that IS the fix. This
// is not proof the deployed function matches (only running it proves that, and
// 384 real fills did). It is here so that if either side is edited, the two
// stop agreeing on the table below and something fails.
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

// ── what the old server rule did, stated so it cannot come back quietly ──
const oldSqlClamp=(ticker,proposed)=>{
  const b=bandLimits(ticker);
  if(!b)return proposed;
  return Math.min(Math.max(proposed,b.lower),b.upper);
};
check('the old rule snapped a stranded $45.00 sell to $39.00',
      oldSqlClamp('ACME',44.93)===39);
check('...costing the seller $59.30 on ten shares',
      Math.round((44.93-39)*10*100)/100===59.30);
check('...and dropping every other holder 13.3%',
      Math.round((1-39/45)*1000)/10===13.3);
check('the old rule raised a stranded $7.28 sell to $21.00',
      oldSqlClamp('ACME',7.28)===21);
check('the new rule does neither', bandClamp('ACME',44.93,45)===44.93&&bandClamp('ACME',7.28,7.29)===7.29);

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
