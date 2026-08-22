// The price band, client side.
//
// The band is enforced server-side; this is the preview half. It exists
// because the server now CLAMPS sell-side fills, and a preview that kept
// showing the unclamped impact price would quote a student one number and
// fill them at another.
//
// The two sides are deliberately different, and that asymmetry is the thing
// most worth pinning down:
//
//   sell / short / cover   CLAMPED at the band edge. The order executes; the
//                          price simply stops. Rejecting instead would trap
//                          anyone holding a stock already at the floor, since
//                          every sell pushes it lower and so every sell, at
//                          every size, would be refused.
//   buy                    REJECTED. Refusing a buy costs a student an
//                          opportunity; refusing a sell costs them the exit.
//
// bandClamp mirrors jex_band_clamp() in price_band_migration.sql. If the two
// ever disagree the preview lies, which is the exact failure this replaces.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const near=(a,b)=>Math.abs(a-b)<0.005;

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

global.DB={session:{price_band_pct:30, session_open_prices:{ACME:10}}};
eval(grabFn('bandLimits'));
eval(grabFn('bandClamp'));
// An eval'd `const` stays in the eval's own scope, so this binds the arrow
// function explicitly rather than relying on it leaking out.
global.impactPrice=eval('('+grabConst('impactPrice')
  .replace(/^const impactPrice=/,'').replace(/;$/,'')+')');

// ACME: open 10, band 30% -> floor 7.00, ceiling 13.00
check('the floor is derived from the session open', near(bandLimits('ACME').lower, 7));
check('the ceiling is derived from the session open', near(bandLimits('ACME').upper, 13));

check('a price inside the band passes through untouched',
      near(bandClamp('ACME', 9.50, 10), 9.50));
check('a price below the floor is lifted to the floor',
      near(bandClamp('ACME', 4.00, 10), 7));
check('a price above the ceiling is cut to the ceiling',
      near(bandClamp('ACME', 20.00, 10), 13));

// A stock can sit outside the band already -- anything driven there while the
// sell side was unbanded, or moved by an admin price adjustment. For those the
// effective floor is the CURRENT price, not the band floor: the price is held
// where it is. It is neither snapped back up into the band (a sell order that
// RAISED a price would be a stranger bug than the one being fixed) nor allowed
// to fall further.
//
// My first version of these assertions expected 5.50 -- the proposed price --
// and was simply wrong about the rule it was testing.
check('a stock below the floor is HELD at its current price, not pushed lower',
      near(bandClamp('ACME', 5.50, 6.00), 6.00),
      'got '+bandClamp('ACME', 5.50, 6.00));
check('  ...and is not snapped back up to the floor either',
      bandClamp('ACME', 5.50, 6.00) < 7,
      'snapped up to the 7.00 floor, which would make a sell RAISE the price');
check('a stock above the ceiling is HELD at its current price, not pushed higher',
      near(bandClamp('ACME', 15.50, 15.00), 15.00));

// The consequence, recorded deliberately rather than discovered later: a stock
// outside the band is FROZEN for the rest of the session. Sells cannot move it
// (above) and buys are refused server-side, because the deployed reject reads
// `v_new_price < v_lower` with no check that the order actually made things
// worse. It unfreezes at the next session open, when recordSessionOpenPrices
// recentres the baseline on the current price.
//
// Reachable only via an admin price adjustment or a pre-existing out-of-band
// price now that both trading sides are covered -- but real, and this is the
// test that will fail first if the reject condition is ever tightened.
check('a frozen stock stays frozen within the session (documented, not desired)',
      near(bandClamp('ACME', 5.00, 6.00), 6.00) && near(bandClamp('ACME', 5.99, 6.00), 6.00));

// Disable must mean disabled. The SQL used to coalesce a null band back to
// 30%, which is the bug this mirrors -- reproducing it here would hide it.
DB.session.price_band_pct=null;
check('a disabled band clamps nothing', near(bandClamp('ACME', 0.01, 10), 0.01));
check('a disabled band reports no limits', bandLimits('ACME')===null);
DB.session.price_band_pct=30;

// A ticker with no session-open price has no baseline to measure against.
check('a ticker with no session-open price is unbanded',
      near(bandClamp('NOPE', 0.01, 10), 0.01));

// ── impactPrice: clamped one way, raw the other ──
const co={ticker:'ACME', price:7.20, shares:1000};
// A big sell from just above the floor would land well below it.
const sellPrice=impactPrice(co, 800, 'sell');
check('a sell preview is clamped at the floor', near(sellPrice, 7),
      'got '+sellPrice);
check('  ...and never below it', sellPrice>=7-0.005);

// A buy preview stays RAW: that is genuinely what the order would attempt,
// and the server would refuse it. Showing a clamped price here would tell the
// student the order succeeds at the ceiling, which is the opposite of true.
const hi={ticker:'ACME', price:12.80, shares:1000};
const buyPrice=impactPrice(hi, 800, 'buy');
check('a buy preview is NOT clamped -- it shows what would be attempted',
      buyPrice>13, 'got '+buyPrice+', which has been clamped to the ceiling');

// Small orders are unaffected in both directions. 10 shares of a 1000-share
// company is (10/50)*0.015 = 0.3% impact, so 10.00 -> 9.97 / 10.03. Both sit
// well inside the 7.00-13.00 band, so the band must not touch them -- the
// expected values are the plain impact curve, computed rather than eyeballed.
const mid={ticker:'ACME', price:10.00, shares:1000};
check('an ordinary sell is untouched by the band',
      near(impactPrice(mid, 10, 'sell'), 9.97), 'got '+impactPrice(mid,10,'sell'));
check('an ordinary buy is untouched by the band',
      near(impactPrice(mid, 10, 'buy'), 10.03), 'got '+impactPrice(mid,10,'buy'));

// ── the preview text ──
global.fmt=n=>'$'+(Math.round(n*100)/100).toFixed(2);
eval(grabFn('impactPreview'));
const sellHtml=impactPreview({ticker:'ACME', price:7.20, shares:1000, is_index_fund:false}, 800, 'sell');
check('a clamped sell explains itself as limit down', /Limit down/.test(sellHtml), sellHtml.slice(0,200));
check('  ...and says the sale still goes through', /still goes through/.test(sellHtml));

const buyHtml=impactPreview({ticker:'ACME', price:12.80, shares:1000, is_index_fund:false}, 800, 'buy');
check('a buy past the ceiling warns it will be refused', /will be refused/.test(buyHtml), buyHtml.slice(0,200));

const okHtml=impactPreview({ticker:'ACME', price:10.00, shares:1000, is_index_fund:false}, 10, 'buy');
check('an ordinary order carries no band note',
      !/Limit down|will be refused/.test(okHtml));

console.log(fails?('\n'+fails+' FAILURE(S)'):'\nAll price-band checks passed.');
process.exit(fails?1:0);
