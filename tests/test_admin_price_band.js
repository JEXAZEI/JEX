// An admin price adjustment against the price band.
//
// The band, the daily % badge and the circuit breaker are all measured from
// jex_session.session_open_prices. rpc_adjust_stock_price moved the price and
// left that baseline alone, so a Boost or a Drop big enough to clear the band
// stranded the stock outside its own band -- and the band check only lets a
// trade through if it moves the price BACK toward the band.
//
// Measured against the real functions on a copy of production. ACME at
// $30.00, band +/-30%, allowed range 21.00 - 39.00. The Chairman applies
// "Boost +50%":
//
//   price               $30.00 -> $45.00
//   session open price  $30.00 -> $30.00   (unchanged -- this is the bug)
//
//   a student tries to BUY   -> "Order rejected - outside price band.
//                                Allowed range: 21.00 - 39.00"
//   a student tries to SELL  -> goes through
//
// Every buy refused, every sell fine, until the price drifts back under $39.
// A "Boost" was a one-way trip down; a "Drop" the same in reverse.
//
// The server now scales the baseline by the same factor the price moved --
// which is what rpc_review_dilution has always done for a dilution step -- and
// returns it so this client's band preview and % badges agree immediately.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── wiring ──
check('the adjustment takes the new baseline from the server',
      /if\(r\.session_open_prices\)DB\.session\.session_open_prices=r\.session_open_prices;/.test(src));
check('...in adjustStockPrice, next to the price it applies',
      /co\.price=r\.price;co\.price_history=r\.price_history;[\s\S]{0,900}?if\(r\.session_open_prices\)/.test(src));
check('the reason is written down where the next reader will find it',
      /the market went one-way/.test(src));
// The same pattern already guards the dilution path and the ex-dividend path.
// If either loses it, the band goes back to measuring against a stale number.
check('the dilution path still takes it too',
      (src.match(/if\(r\.session_open_prices\)DB\.session\.session_open_prices=r\.session_open_prices;/g)||[]).length>=3,
      'dividend, dilution and price adjustment all move the baseline');

// ── the arithmetic the server now does, and what it fixes ──
//
// This is jex_band_clamp's gate, both halves: a trade is refused when the new
// price is outside the band AND is moving further out. `stranded` is the state
// the bug left the stock in.
const band=(open,pct)=>({lo:Math.round(open*(1-pct/100)*100)/100,hi:Math.round(open*(1+pct/100)*100)/100});
const refused=(newP,cur,b)=>(newP>b.hi&&newP>cur)||(newP<b.lo&&newP<cur);

// Before: price 45, baseline still 30.
let b=band(30,30);
check('the band off a $30 baseline is 21.00 - 39.00', b.lo===21&&b.hi===39);
check('with the baseline left behind, a buy at 45 is refused',
      refused(45.68,45,b)===true, 'the impact price moves further above 39');
check('...while a sell at 45 goes straight through',
      refused(44.32,45,b)===false, 'it moves back toward the band, so it is allowed');

// After: the baseline moved with the price.
b=band(45,30);
check('the rescaled band is 31.50 - 58.50', b.lo===31.5&&b.hi===58.5);
check('now a buy is allowed again', refused(45.68,45,b)===false);
check('and a sell still is', refused(44.32,45,b)===false);

// A Drop is the same bug in the other direction.
b=band(30,30);
check('after a -60% cut the price is below the band', 12<b.lo);
check('...and every SELL was refused', refused(11.82,12,b)===true);
check('...while buys went through', refused(12.18,12,b)===false);
b=band(12,30);
check('rescaled, selling works again', refused(11.82,12,b)===false);

// The band still does its job on ordinary trading -- this must not become a
// licence to move the price anywhere.
b=band(30,30);
check('a buy that would push past 39 is still refused', refused(39.50,38,b)===true);
check('a sell that would push under 21 is still refused', refused(20.50,22,b)===true);
check('a trade inside the band is untouched', refused(33,32,b)===false);

// The scaling itself: baseline * (new price / old price), floored at a cent
// and rounded like money, exactly as the server does it.
const scale=(open,oldP,newP)=>Math.max(0.01,Math.round(open*(newP/oldP)*100)/100);
check('a +50% boost scales a $30 baseline to $45.00', scale(30,30,45)===45);
check('a -60% cut scales it to $12.00', scale(30,30,12)===12);
check('a baseline that is not the current price keeps its own ratio',
      scale(28,30,45)===42, String(scale(28,30,45)));
check('...so a day already up 7.1% is still up 7.1% afterwards',
      Math.round((30/28-1)*1000)===Math.round((45/42-1)*1000));
check('the floor holds a baseline above zero', scale(0.02,30,0.01)>=0.01);

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
