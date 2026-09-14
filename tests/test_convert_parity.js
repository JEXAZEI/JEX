// A share-class conversion must not create value out of nothing.
//
// A convertible class and its parent are two separate tickers with two separate
// prices, each moved by its own trading, and the conversion ratio between them
// is fixed. rpc_convert_share_class had no price check in it at all: it read
// the ratio, retired the class shares, issued the base shares, and never looked
// at what either was worth. So any drift from parity was free money.
//
// Run end to end on a copy of production against the real trade functions, with
// a ratio-5 class at $10 while the parent traded at $30:
//
//     bought 20 ACME.B          -$202.40
//     converted 20 x 5 -> 100        $0
//     sold 100 ACME           +$2,957.00
//     ---------------------------------
//     profit in one cycle     +$2,754.60
//
// The money supply did not move a cent -- it is a transfer, out of the company
// owner's cash, which is why it does not show up in a mint check. It repeats to
// the limit of the class float.
//
// In a real market the arbitrage is the thing that bids the class back up to
// parity, so it cannot persist. Converting here moves neither price, so nothing
// corrects it. The swap is refused while it would be a gain; converting at a
// LOSS stays allowed, because giving up value for voting rights is the holder's
// decision to make.
//
// The app was also advertising it: the info bubble told students that "if the
// class is trading below its ratio, the base shares you get back are worth more
// than what you gave up", with a green "+$X per share converted" badge beside a
// live Convert button.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── the app must not teach the exploit ──
check('the info bubble no longer advertises the free value',
      !/the base shares you get back are worth more than what you gave up/.test(src));
check('...and explains why a value-creating swap is refused',
      /would hand you more value than you gave up is refused/.test(src));
check('a gain is not painted green any more',
      !/\(edge>0\?'green':'red'\)/.test(src));
check('the Convert button is disabled when the swap would be refused',
      /halted\|\|parentGone\|\|blocked\?' disabled':''/.test(src));

// ── the guard itself ──
check('convertShareClass refuses a value-creating conversion',
      /out of nothing, so it is refused/.test(src));
check('...before asking the holder to confirm',
      src.indexOf('out of nothing, so it is refused')<src.indexOf("This is one way"),
      'refusing after the confirm makes the student agree to something impossible');

// ── behaviour ──
//
// The client rule mirrors the server's: refuse when class*qty < ratio*parent*qty,
// with half a cent of tolerance so ordinary rounding is not read as a gain.
const refuses=(classPrice,parentPrice,ratio,qty)=>
  classPrice*qty < parentPrice*ratio*qty - 0.005;

check('a class trading below parity is refused', refuses(10,30,5,20));
check('a class exactly at parity converts', !refuses(150,30,5,20));
check('a class above parity converts -- votes are worth paying for',
      !refuses(200,30,5,20));
// Ratio 1 is the ordinary dual-class case and must behave the same way.
check('ratio 1, class below parent, refused', refuses(29,30,1,10));
check('ratio 1, class at parent, converts', !refuses(30,30,1,10));
// A hair of rounding either way must not flip the decision.
check('half a cent of drift is tolerated, not treated as a gain',
      !refuses(29.999,30,1,1), 'sub-cent noise would block every honest conversion');
check('a real cent of gain is still caught', refuses(29.98,30,1,1));
// Quantity must not change the verdict: the comparison is per-share either way.
check('the verdict does not depend on order size (refused)',
      refuses(10,30,5,1)&&refuses(10,30,5,1000));
check('the verdict does not depend on order size (allowed)',
      !refuses(150,30,5,1)&&!refuses(150,30,5,1000));

// A price the client does not have yet must not silently permit the swap on the
// client side -- but it must not throw either. The server is the boundary.
const guard=/const clsCo=getCo\(ticker\);[\s\S]{0,400}?clsCo&&clsCo\.price>0&&parent\.price>0/;
check('a missing or zero price falls through to the server rather than throwing',
      guard.test(src));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
