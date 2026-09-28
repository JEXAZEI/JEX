// Email verification proved nothing: rpc_request_verification_code handed the
// code back to whoever asked, rpc_register_pending stored whatever the browser
// claimed about verification, and guesses were unlimited. See
// sql/email_verification_guard.sql. Every rule there was exercised against
// production's own function bodies on a local database; this pins the text so
// a later hand edit cannot quietly undo it.
const fs=require('fs'),path=require('path');
const dir=path.join(__dirname,'..','sql');
const sql=fs.readFileSync(path.join(dir,'email_verification_guard.sql'),'utf8');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};
const code=s=>s.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');
const body=name=>{
  const i=sql.indexOf('create or replace function public.'+name+'(');
  if(i<0)return'';
  return code(sql.slice(i,sql.indexOf('$body$;',i)));
};

const req=body('rpc_request_verification_code'),conf=body('rpc_confirm_verification_code');

// ── request ──
check('the reply carries no code', /return jsonb_build_object\('email', v_email, 'sent', true\);/.test(req) && !/'code', v_code/.test(req));
check('the server emails the code itself', /perform net\.http_post\(/.test(req) && /'message', 'Your JEX email verification code is ' \|\| v_code/.test(req));
check('...and a failed send is not swallowed (no exception handler around it)', !/exception when others/.test(req));
check('one request per address per 30 seconds', /created_at > now\(\) - interval '30 seconds'/.test(req));
check('five per address per hour', /interval '1 hour'\) >= 5/.test(req));
check('100 across the exchange per 10 minutes', /interval '10 minutes'\) >= 100/.test(req));
check('refused for an address that already has an account', /An account with that email already exists/.test(req));
check('codes come from a cryptographic source, not random()', /gen_random_bytes\(4\)/.test(req) && !/random\(\)/.test(req));
check('...which is on the search path', /set search_path to 'public', 'extensions'/.test(req));

// ── confirm ──
check('confirm checks the latest live code, not the typed one', /where email = v_email and used = false\s*order by created_at desc limit 1/.test(conf) && !/and code = p_code/.test(conf));
check('five wrong guesses kill the code', /set attempts = attempts \+ 1, used = \(attempts \+ 1 >= 5\)/.test(conf));
check('a right code records when it was confirmed', /set used = true, confirmed_at = now\(\)/.test(conf));
check('uses FOUND, not "record IS NULL" (which means every field is null)', /if not found then return false; end if;/.test(conf));

// ── register ──
check('registration decides verified itself', /'p_sec_q, p_sec_a, v_verified,'/.test(sql));
check('...from a code confirmed in the last two hours', /confirmed_at > now\(\) - interval ''2 hours''/.test(sql));
check('...or a Google token carrying this address', /auth\.jwt\(\) -> ''app_metadata'' ->> ''provider'', ''''\) = ''google''/.test(sql)
      && /lower\(coalesce\(auth\.jwt\(\) ->> ''email'', ''''\)\) = v_email/.test(sql));

// ── safety ──
for(const [fn,fp] of [['rpc_request_verification_code','ab6aef0f56460ec96da65d5d4c9e902c'],
                      ['rpc_confirm_verification_code','e1dce68091ee6873efb6274b2961743f'],
                      ['rpc_register_pending','57d84c3ccc0aaa01840d9277a01b9e4a']])
  check('refuses unless '+fn+' is the production version it was written against', new RegExp("'"+fn+"'\\s+then\\s+'"+fp+"'").test(sql));
check('"already applied" markers are text only the NEW bodies contain',
      /position\('net\.http_post' in prosrc\) > 0 into v_have_req/.test(sql)
      && /position\('confirmed_at' in prosrc\) > 0 into v_have_conf/.test(sql)
      && /position\('v_verified' in prosrc\) > 0 into v_have_reg/.test(sql));

// PL/pgSQL reads the THEN of a CASE inside an IF condition as the IF's own,
// and the function does not parse. It has now been written twice in this
// directory and caught on the rig both times; checked everywhere from here on.
for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql'))){
  const hit=/\bif\b[^;\n]*\bcase\s+when\b[^;\n]*\bend\s+then\b/i.exec(code(fs.readFileSync(path.join(dir,f),'utf8')))
         ||/\bif\b[^;]*<>\s*case\s[\s\S]{0,400}?\bend\s+then\b/i.exec(code(fs.readFileSync(path.join(dir,f),'utf8')));
  check(f+': no CASE inside an IF condition', !hit, hit&&hit[0].slice(0,80));
}

// ── the page ──
check('the page only emails the code itself when an old server hands one back',
      /if\(r&&r\.code\)\{\s*emailjs\.init/.test(src));
check('a refusal from the server is shown in its own words', /toast\('Could not send a verification code: '\+rpcErrorMessage\(e\)\)/.test(src));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
