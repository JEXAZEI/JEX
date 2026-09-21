// Every vote ends. The browser already believed that; the database did not.
//
// postVote() sets closes_at to 24 hours out, isVoteOpen() hides an expired
// vote everywhere in the UI, and rpc_auto_close_expired_votes sweeps expired
// rows to status='closed'. What was missing was the server-side half:
// rpc_cast_vote checked status and nothing else --
//
//     if v_vote.status <> 'open' then raise exception 'This vote is closed';
//
// -- so a ballot was accepted for as long as the status column still said
// 'open', which is until some browser happened to run the sweep.
//
// Measured against the live function bodies:
//
//   expired YESTERDAY, sweep not yet run        ballot ACCEPTED
//   same vote, after the sweep                  correctly refused
//   closes_at null                              ACCEPTED, forever
//   closes_at free text ("Friday 3pm")          ACCEPTED, forever
//
// The last two never closed at all: the sweep only matched an ISO timestamp,
// so a null or a sentence was invisible to it, and isVoteOpen() deliberately
// read an unparseable deadline as "no deadline" to avoid mistaking garbage for
// expiry. Both were right while the deadline was cosmetic. Neither is now.
//
// ── The rule, in one place ──
//
//   deadline = closes_at when it parses, else created_at + 24 hours
//
// Every vote has an end, including every row already in the table, with no
// data migration. Three server functions and this file all use it.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

function grabFn(name){
  const m=new RegExp('^function '+name+'\\(','m').exec(src);
  if(!m)throw new Error('not found: '+name);
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--;if(!d)return src.slice(m.index,i+1);} }
  throw new Error('unterminated: '+name);
}
eval((/^const VOTE_WINDOW_MS=.*$/m.exec(src))[0].replace(/^const /,'global.'));
eval(grabFn('voteDeadline').replace(/^function /,'global.voteDeadline=function '));
eval(grabFn('isVoteOpen').replace(/^function /,'global.isVoteOpen=function '));

const HOUR=3600e3, DAY=24*HOUR;
const iso=ms=>new Date(ms).toISOString();
const vote=(o={})=>Object.assign({status:'open',created_at:iso(Date.now()-HOUR),closes_at:iso(Date.now()+HOUR)},o);

// ── the four measured cases ──
check('a vote inside its window is open', isVoteOpen(vote()));
check('a vote past its closes_at is closed',
      !isVoteOpen(vote({closes_at:iso(Date.now()-DAY)})));
check('closes_at null falls back to created_at + 24h, and is closed when that passed',
      !isVoteOpen(vote({closes_at:null,created_at:iso(Date.now()-3*DAY)})));
check('...and is still OPEN inside that 24h',
      isVoteOpen(vote({closes_at:null,created_at:iso(Date.now()-HOUR)})));
check('free text "Friday 3pm" falls back the same way, and is closed',
      !isVoteOpen(vote({closes_at:'Friday 3pm',created_at:iso(Date.now()-3*DAY)})));
check('...and is open inside the 24h',
      isVoteOpen(vote({closes_at:'Friday 3pm',created_at:iso(Date.now()-HOUR)})));

// ── status still wins when it says closed ──
check('a manually closed vote is closed even well inside its window',
      !isVoteOpen(vote({status:'closed'})));
check('...and one the sweep closed stays closed', !isVoteOpen(vote({status:'closed',closes_at:iso(Date.now()+DAY)})));

// ── the boundary ──
const justPast=vote({closes_at:iso(Date.now()-1000)});
const justBefore=vote({closes_at:iso(Date.now()+60e3)});
check('a second past the deadline is closed', !isVoteOpen(justPast));
check('a minute before it is open', isVoteOpen(justBefore));

// ── degenerate rows ──
check('a row with nothing usable to date it from is treated as open, not voided',
      isVoteOpen(vote({closes_at:null,created_at:null})));
check('...and its deadline reads as Infinity rather than NaN',
      voteDeadline(vote({closes_at:null,created_at:null}))===Infinity);
check('the window really is 24 hours', VOTE_WINDOW_MS===86400000);
check('a parseable closes_at always wins over the fallback',
      voteDeadline(vote({closes_at:iso(5e12),created_at:iso(0)}))===5e12);

// ── the three server functions carry the same rule ──
//
// Pinned as text because the enforcement lives in SQL. If any of these stops
// matching, the browser and the database have drifted apart on when a vote
// ends -- which is the exact bug this fixed.
const sql=fs.readFileSync(path.join(__dirname,'..','sql','vote_deadline_enforced.sql'),'utf8');
check('rpc_cast_vote gets a deadline variable', /v_deadline timestamptz;/.test(sql));
check('...computes the created_at fallback', /coalesce\(v_deadline, v_vote\.created_at \+ interval ''24 hours''\)/.test(sql));
check('...and refuses once it has passed', /if now\(\) >= v_deadline then/.test(sql));
check('...naming the vote and the time, not just "closed"', /Voting on "%s" closed %s/.test(sql));
check('rpc_post_vote writes the deadline itself', /24 hours from posting, set here/.test(sql));
check('...parenthesised so AT TIME ZONE does not bind to the interval',
      /to_char\(\(now\(\) \+ interval ''24 hours''\) at time zone ''utc''/.test(sql));
check('...in the format the sweep matches', /YYYY-MM-DD"T"HH24:MI:SS"Z"/.test(sql));
check('the sweep uses the created_at fallback too', /v\.created_at \+ interval '24 hours'\)/.test(sql));

// ── the client half ──
check('isVoteOpen goes through the shared deadline', /return Date\.now\(\)<voteDeadline\(v\);/.test(src));
check('the vote card shows the enforced deadline, not the raw column',
      /\(d=>isFinite\(d\)\?' · '\+\(openNow\?'closes ':'closed '\)\+fmtAZTime\(new Date\(d\)\):''\)\(voteDeadline\(v\)\)/.test(src));
check('postVote still sends 24 hours, matching what the server will write',
      /const closesAt=new Date\(Date\.now\(\)\+24\*60\*60\*1000\)\.toISOString\(\);/.test(src));
check('the sweep is still kicked from the client poller',
      /safeRpc\('rpc_auto_close_expired_votes'\)/.test(src));

console.log(fails?('\n'+fails+' check(s) failed'):'\nall checks passed');
process.exit(fails?1:0);
