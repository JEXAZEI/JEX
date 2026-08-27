// What a student is allowed to see when the server refuses.
//
// A real screenshot from the trade panel: a student tried to place a limit
// sell and got the toast
//
//     record "v_fund" is not assigned yet
//
// That is a plpgsql fault -- rpc_place_limit_order reads a record variable on
// a path where it was never assigned. It names an internal variable, tells the
// student nothing they can act on, and describes how the server is built.
//
// Deliberate refusals are the opposite: "You only hold 3 shares" and "Order
// rejected -- outside price band" are written FOR the student and must reach
// them exactly as the server phrased them. Swallowing those into a generic
// message would be worse than the leak.
//
// So rpcErrorMessage has to tell the two apart, and this suite is what pins
// which side of the line each message falls on. The internal ones are filed to
// the admin Errors tab instead of being dropped, so the raw text moves to
// where it is useful rather than disappearing.
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
// A const declared inside eval() never reaches global, so the function that
// references it fails at call time with "X is not defined". Bind it explicitly.
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

let reported=[];
global.reportClientError=(m,s,src2)=>{reported.push({m,s,src:src2});};
global.INTERNAL_DB_ERROR=eval('('+grabConst('INTERNAL_DB_ERROR')
  .replace(/^const INTERNAL_DB_ERROR=/,'').replace(/;$/,'')+')');
eval(grabFn('rpcErrorMessage'));

const GENERIC=/Something went wrong on the exchange/;
const run=msg=>{reported=[];return rpcErrorMessage(new Error(JSON.stringify({message:msg})));};

// ── faults: hidden from the student, filed for the instructor ──
[
  ['the one a student actually saw',        'record "v_fund" is not assigned yet'],
  ['a divide by zero',                      'division by zero'],
  ['a not-null violation',                  'null value in column "qty" violates not-null constraint'],
  ['a check violation',                     'new row for relation "jex_companies" violates check constraint "shares_avail_le_shares"'],
  ['a foreign key violation',               'insert or update on table "jex_trades" violates foreign key constraint "fk_ticker"'],
  ['a unique violation',                    'duplicate key value violates unique constraint "jex_companies_ticker_key"'],
  ['a bad cast',                            'invalid input syntax for type numeric: "abc"'],
  ['the coalesce type error from today',    'COALESCE types text and text[] cannot be matched'],
  ['a missing column',                      'column "weekly_actve" does not exist'],
  ['a missing function',                    'function index_live_value(unknown) does not exist'],
  ['a strict select that found nothing',    'query returned no rows'],
  ['a numeric overflow',                    'numeric field overflow -- value out of range'],
].forEach(([label,msg])=>{
  const out=run(msg);
  check('hidden: '+label, GENERIC.test(out), out);
  check('...and filed to the Errors tab', reported.length===1 && reported[0].m===msg,
        JSON.stringify(reported));
});

// ── deliberate refusals: shown word for word ──
[
  ['an oversized sell',        'You only hold 3 shares'],
  ['the price band',           'Order rejected — outside price band. Allowed range: 20.00 – 40.00 (±30% from session open 30.00)'],
  ['insufficient funds',       'Insufficient funds (need 412.50)'],
  ['collateral',              'Need 466.50 collateral'],
  ['a halt',                   'ACME trading is currently halted.'],
  ['a closed session',         'Trading is closed. Wait for the session to open.'],
  ['a restricted class',       'This share class is restricted — you are not on the whitelist.'],
  ['buying your own company',  "You can't buy your own company's stock — use Buyback instead."],
  ['the empty index',          'JXI has no listed companies right now, so there is nothing to price a unit against.'],
  ['the recovery throttle',    'Too many password recovery attempts. Try again later.'],
  ['not authenticated',        'Not authenticated'],
  ['a missing company',        'Company not found'],
  ['the fund manager check',   "Only this fund's manager can trade on its behalf"],
].forEach(([label,msg])=>{
  const out=run(msg);
  check('shown verbatim: '+label, out===msg, out);
  check('...and not filed as a fault', reported.length===0, JSON.stringify(reported));
});

// ── shape handling ──
check('a bare Error (not JSON) still comes through',
      rpcErrorMessage(new Error('You only hold 3 shares'))==='You only hold 3 shares');
check('a bare Error carrying a fault is still hidden',
      GENERIC.test(rpcErrorMessage(new Error('record "v_fund" is not assigned yet'))));
check('a non-Error value does not throw',
      typeof rpcErrorMessage('plain string')==='string');
check('null does not throw', typeof rpcErrorMessage(null)==='string');

// The generic message has a job beyond hiding the internals: a student whose
// order vanished needs to know whether they were charged.
const generic=run('record "v_fund" is not assigned yet');
check('the generic message says the order did not go through', /not placed/i.test(generic), generic);
check('...and that no money moved', /nothing was charged/i.test(generic), generic);
check('...and that someone was told', /instructor/i.test(generic), generic);
check('...and never names an internal variable', !/v_fund|plpgsql|record "/i.test(generic), generic);

console.log(fails?('\n'+fails+' FAILURE(S)'):('\nAll rpc error-message checks passed.'));
process.exit(fails?1:0);
