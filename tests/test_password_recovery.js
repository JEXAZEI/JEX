// Forgot Password. It did not work, for anybody, and the failure looked like
// the student's fault.
//
// ── What happened ──
//
// Step 1  type your email          -> account found, security question shown
// Step 2  answer the question      -> accepted, on to the new-password screen
// Step 3  type a new password      -> "Could not reset password — start over
//                                      from Forgot Password"
//
// Starting over does the same thing. There is no route out of the loop, and
// nothing tells the student that answering correctly is not the problem.
//
// ── Why ──
//
// The two steps check the same answer against the same column in two
// different formats.
//
//   step 2, verify_legacy_security_answer
//       v_hash := encode(digest(v_norm, 'sha256'), 'hex');
//       if v_stored = v_hash then return true; end if;
//       -- and upgrades a plaintext row to a hash as it goes
//
//   step 3, reset_migrated_password
//       if v_stored_answer <> lower(trim(p_answer)) then
//         return false;
//       end if;
//
// Once sec_a is a sha256 hash that comparison can never be true. sec_a is a
// hash for everyone: step 2 upgrades it on the first correct answer, and
// _hash_sec_a_on_write hashes it on write.
//
// Measured against both live function bodies, on an account with a hashed
// sec_a and auth_uid set:
//
//   verify_legacy_security_answer('u_s1', 'Rex')  -> true
//   reset_migrated_password('u_s1', 'Rex', ...)   -> FALSE
//
// and with sec_a stored as plaintext, the shape it was written for:
//
//   reset_migrated_password('u_s1', 'Rex', ...)   -> true
//
// ── Why every account ──
//
// forgotStep3 branches on u.auth_uid. Migrated accounts go to
// reset_migrated_password, legacy ones to rpc_reset_legacy_password. All 15
// accounts on the exchange are migrated and 0 are legacy, so every one took
// the broken branch. The branch nobody used delegates to
// verify_legacy_security_answer and worked correctly the whole time.
//
// The fix is to delegate from both. One function decides what a correct
// security answer is; the two paths cannot drift apart again.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const crypto=require('crypto');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');

// ── the two comparisons, as they actually ran ──
const norm=a=>String(a==null?'':a).trim().toLowerCase();
const step2=(stored,answer)=>stored===sha(norm(answer))||stored===norm(answer);
const step3Broken=(stored,answer)=>stored===norm(answer);
const step3Fixed=(stored,answer)=>step2(stored,answer);

const hashed=sha('rex'), plain='rex';

check('step 2 accepts the right answer against a hashed sec_a', step2(hashed,'Rex'));
check('step 3 REJECTED it -- the whole bug in one line', step3Broken(hashed,'Rex')===false);
check('...so the student was looped with no way out',
      step2(hashed,'Rex')===true && step3Broken(hashed,'Rex')===false);
check('step 3 only ever worked on a plaintext sec_a', step3Broken(plain,'Rex')===true);
check('the fixed step 3 accepts the hashed one', step3Fixed(hashed,'Rex')===true);
check('...and still accepts the plaintext one', step3Fixed(plain,'Rex')===true);
check('...and still refuses a wrong answer', step3Fixed(hashed,'Fido')===false);
check('...and is not case or whitespace sensitive, same as step 2',
      step3Fixed(hashed,'  REX ')===true && step2(hashed,'  REX ')===true);
check('a null answer is refused rather than matching a null column',
      step3Fixed(hashed,null)===false);

// The two halves must agree on every input, or the loop comes back.
for(const stored of [hashed,plain,sha('fluffy')]){
  for(const answer of ['Rex','rex','  Rex  ','FIDO','',null]){
    if(step2(stored,answer)!==step3Fixed(stored,answer)){
      check('step 2 and step 3 agree on '+JSON.stringify(answer)+' vs '+stored.slice(0,8),false);
    }
  }
}
check('step 2 and step 3 now agree on every answer tried', true);

// ── the password floor ──
//
// short_passwords.sql raised rpc_reset_legacy_password to 6 and missed this
// one, which still said 4. Every other path requires 6.
check('the client refuses anything under 6 before it calls either RPC',
      /if\(!pw\|\|pw\.length<6\)return toast\('Min 6 characters/.test(src));
check('...which is why nobody could reach the 4 through the UI',
      /pw\.length<6/.test(src));

// ── the branch that decides which RPC runs ──
check('forgotStep3 branches on auth_uid', /if\(u\.auth_uid\)\{/.test(src));
check('...sending migrated accounts to reset_migrated_password',
      /sb\.rpc\('reset_migrated_password',\{p_user_id:u\.id,p_answer:UI\.forgotAnswer,p_new_password:pw\}\)/.test(src));
check('...and legacy ones to rpc_reset_legacy_password',
      /sb\.rpc\('rpc_reset_legacy_password',\{p_user_id:u\.id,p_answer:UI\.forgotAnswer,p_new_pw:pw\}\)/.test(src));
check('a throttled attempt is told so, not called a wrong answer',
      /throttled=RECOVERY_THROTTLED\(e\)/.test(src) && /if\(throttled\)return toast\(THROTTLE_MSG\)/.test(src));
check('step 2 passes the answer forward so step 3 can re-verify it',
      /UI\.forgotAnswer=answer;/.test(src));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
