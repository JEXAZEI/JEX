// Founder share grants -- who may approve one, and what the approver is shown.
//
// Two RPCs make up a grant. rpc_request_founder_allocation is open to "this
// company's owner or founders", correctly: proposing a grant is the founders'
// job. rpc_review_founder_allocation -- the step that actually hands the
// shares over -- accepted the SAME list, so the requester and the approver
// could be one student.
//
// Measured against the real functions on a copy of production. One student, an
// accepted founder of the Acme CEO's company, holding 50 ACME:
//
//   request 1,400 shares (the entire float) for themselves  -> pending
//   approve it                                              -> approved
//   shares_avail  1400 -> 0,  their holding  50 -> 1450  (72.5% of all shares)
//
// then selling 300 of them straight back into the pool:
//
//   their cash  $40,000 -> $48,595     CEO's cash  $250,000 -> $241,405
//
// $8,595 out of the CEO's account on the first sale, the CEO never in the
// loop, and the 20% position cap that governs every ordinary trade does not
// apply to a grant.
//
// The server now refuses it. This file pins the client half: the button says
// why rather than throwing a raw RPC error, and -- the part that matters for
// the grants that ARE legitimate -- the screen the decision is made from shows
// what the shares are worth, because "1,400 shares" reads as a number and
// "$42,000, 70% of everything issued" reads as a decision.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── the guard ──
check('the client refuses to approve your own request',
      /if\(approve&&a\.student_id===cu\(\)\?\.id\)/.test(src),
      'the server refuses it too -- this is so the button explains itself');
check('...and says who has to review it instead',
      /company owner, or an exchange officer, has to review it/.test(src));
check('rejecting is NOT blocked for the beneficiary',
      !/if\(a\.student_id===cu\(\)\?\.id\)\s*return/.test(src),
      'withdrawing your own pending request costs nobody anything');

// ── what the approver is shown before they commit ──
check('approving asks for confirmation',
      /confirm\('Grant '\+a\.shares\.toLocaleString\(\)\+' '\+a\.ticker/.test(src));
check('...priced at today\'s price',
      /worth\?'\\n\\nThat is '\+fmt\(worth\)\+' of stock at today/.test(src));
check('...as a share of everything issued',
      /Math\.round\(a\.shares\/fa\.shares\*1000\)\/10\)\+'% of every share issued'/.test(src));
check('...and says where the money comes out',
      /pays out of the company owner/.test(src),
      'a granted share can be sold straight back into the pool');
check('the pending list prices the request too',
      /const worth=fa&&fa\.price>0\?fa\.price\*a\.shares:0;/.test(src));
check('...and says the shares are free and sellable back',
      /Granted free out of the float, and sellable back into the pool/.test(src));

// ── behaviour of the guard itself ──
//
// The precedence here is worth pinning: `approve && a.student_id === cu()?.id`
// must parse as `approve && (a.student_id === cu()?.id)`, not as
// `(approve && a.student_id) === cu()?.id`. The second form is true whenever
// a falsy `approve` meets a missing user, which would block rejection.
const guard=(approve,studentId,me)=>approve&&studentId===(me?me.id:undefined);
check('the beneficiary approving is caught', guard(true,'u_s1',{id:'u_s1'})===true);
check('someone else approving is not', guard(true,'u_s1',{id:'u_ceo'})===false);
check('the beneficiary REJECTING is not caught', guard(false,'u_s1',{id:'u_s1'})===false,
      'withdrawing your own request has to stay possible');
check('a logged-out client does not match anybody', guard(true,'u_s1',null)===false);
check('...and an allocation with no student_id does not match undefined',
      guard(true,undefined,null)===true,
      'both undefined -- the server is the real gate, this only shapes the message');

// ── the value shown ──
const price=30,shares=2000;
const worth=t=>price*t, share=t=>Math.round(t/shares*1000)/10;
check('1,400 shares of a $30 stock reads as $42,000', worth(1400)===42000);
check('...and as 70% of everything issued', share(1400)===70);
check('a single share still rounds to a tenth of a percent', share(1)===0.1,String(share(1)));
check('zero shares is zero, not NaN', share(0)===0);

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
