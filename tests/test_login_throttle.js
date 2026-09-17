// Guessing a legacy password, without limit.
//
// The forgot-password path has been throttled all along -- verify_legacy_-
// security_answer opens with `perform jex_recovery_throttle(p_user_id)`, 8 in
// 15 minutes. verify_legacy_password, which is what the sign-in form calls,
// had no limit at all.
//
// The whole attack is two calls, both reachable with the publishable key that
// ships in the page:
//
//   rpc_resolve_login_identity('<a name off the leaderboard>','student')
//       -> {id, name, username, email, role, sec_q, ...}
//   verify_legacy_password(that id, '<guess>')
//       -> true / false, as often as you like
//
// Measured against the real function on a copy of production, after the fix:
// 10 wrong guesses answered, the 11th locked out, 30 correct sign-ins in a row
// never locked out, and nine typos followed by the right password cleared the
// count completely.
//
// Migrated accounts were never exposed -- they go through Supabase Auth, which
// rate-limits itself. Legacy accounts are the ones that were, and an account
// whose password is under six characters can never migrate, so it stays there.
//
// This file pins the client half: a lockout has to read differently from a
// wrong password, or a student typing the right one is told "Invalid username
// or password" for fifteen minutes with nothing to act on.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── the helper covers both throttles ──
check('the throttle test matches the sign-in lockout too',
      /Too many password recovery attempts\|Too many sign-in attempts/.test(src));
check('...and still matches on the SQLSTATE itself',
      /\/JEX01\|/.test(src),
      'the code is what survives a message reword');

// ── the sign-in form ──
check('the login path catches a lockout separately from a wrong password',
      /catch\(e\)\{lockedOut=RECOVERY_THROTTLED\(e\);ok=false;\}/.test(src));
check('...and says what to do about it',
      /Too many sign-in attempts — wait 15 minutes, or ask your instructor to reset your password\./.test(src));
check('a wrong password still reads as a wrong password',
      /if\(!ok\)\{UI\.loginError='Invalid username or password';return render\(\);\}/.test(src));
check('the lockout is checked BEFORE the generic failure',
      src.indexOf("if(lockedOut){UI.loginError='Too many sign-in attempts")
        < src.indexOf("if(!ok){UI.loginError='Invalid username or password'"));

// ── the security-question change uses the same check ──
check('changing your security question distinguishes it too',
      /catch\(e\)\{if\(RECOVERY_THROTTLED\(e\)\)return toast\(THROTTLE_MSG\);okSq=false;\}/.test(src));

// ── the reasoning is written down ──
check('the why is recorded next to the helper',
      /guessable without end/.test(src));
check('...including that a correct password clears the count',
      /a correct one clears the count so\s*\n\/\/ ordinary signing in never locks anybody out/.test(src));

// ── the matcher itself ──
const THROTTLED=e=>/JEX01|Too many password recovery attempts|Too many sign-in attempts/i
  .test(String((e&&e.message)||e||''));
check('a sign-in lockout is recognised',
      THROTTLED({message:'Too many sign-in attempts for this account. Wait 15 minutes'})===true);
check('a recovery lockout still is',
      THROTTLED({message:'Too many password recovery attempts for this account.'})===true);
check('the bare SQLSTATE is enough on its own',
      THROTTLED({message:'JEX01'})===true);
check('a plain wrong password is NOT a lockout',
      THROTTLED({message:'Invalid username or password'})===false);
check('a network error is not a lockout',
      THROTTLED(new Error('Failed to fetch'))===false);
check('undefined does not throw', THROTTLED(undefined)===false);
check('a bare string is handled', THROTTLED('JEX01')===true);
check('an object with no message does not throw', THROTTLED({})===false);
check('the match is case-insensitive', THROTTLED({message:'too many SIGN-IN attempts'})===true);

// ── the budget, as the server applies it ──
//
// 10 failures in 15 minutes; a success clears the count. These are the numbers
// a student's class period runs into, so they are worth stating.
const LIMIT=10;
const attempt=(count,ok)=>ok?0:count+1;
const locked=count=>count>LIMIT;
let n=0;
for(let i=0;i<10;i++)n=attempt(n,false);
check('ten wrong passwords are still answered', locked(n)===false, String(n));
n=attempt(n,false);
check('the eleventh locks out', locked(n)===true, String(n));
n=0;
for(let i=0;i<30;i++)n=attempt(n,true);
check('thirty correct sign-ins never lock out', locked(n)===false, String(n));
n=0;
for(let i=0;i<9;i++)n=attempt(n,false);
n=attempt(n,true);
check('nine typos then the right password clears it', n===0);
for(let i=0;i<9;i++)n=attempt(n,false);
check('...so nine more typos are still answered', locked(n)===false, String(n));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
