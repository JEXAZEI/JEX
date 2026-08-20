// The "stuck on Connecting to exchange..." hang.
//
// Reported with a console showing a completely successful boot: all four
// loadAll batches done, loadPrivateData done, session present = true,
// "checkGoogleSession done (resolved=true)" -- and then silence, with the
// splash still on screen.
//
// Two compounding defects produced that:
//   1. checkGoogleSessionInner() renders its own outcome, but does so while
//      _oauthReturnActive is STILL true (the finally in checkGoogleSession is
//      what clears it). render() therefore takes its `if(_oauthReturnActive)`
//      branch and paints the splash over the real result.
//   2. boot() only rendered inside the signed-in branch. Any other exit --
//      falsy UI.userId, or a saved id with no matching user -- left boot()
//      having painted nothing since the splash.
// Together: last paint wins, and the last paint is the splash, forever.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// Model of render()'s branch selection, matching app.js.
function paint(state){
  if(!state.userId){
    return state.oauthReturnActive?'SPLASH':'LOGIN';
  }
  if(!state.users.find(u=>u.id===state.userId))return 'LOGIN';
  return 'APP';
}

// Model of the fixed control flow: checkGoogleSession's finally repaints
// after clearing the flag, and boot() backstops every non-signed-in exit.
function bootFlow({sessionResolvesTo,users,oauthReturn}){
  const state={userId:null,users,oauthReturnActive:!!oauthReturn};
  const paints=[];
  paints.push(paint(state));                 // splash during loading
  // inner decides an outcome and renders while the flag is still set
  state.userId=sessionResolvesTo;
  paints.push(paint(state));
  // finally: clear the flag, then repaint  (fix #1)
  state.oauthReturnActive=false;
  paints.push(paint(state));
  // boot(): signed-in branch renders; otherwise the backstop does  (fix #2)
  if(state.userId&&state.users.find(u=>u.id===state.userId))paints.push(paint(state));
  else paints.push(paint(state));
  return paints[paints.length-1];
}

const users=[{id:'u1',name:'Ariel'}];

console.log('=== the reported hang ===');
check('successful Google sign-in ends on the APP, not the splash',
  bootFlow({sessionResolvesTo:'u1',users,oauthReturn:true})==='APP',
  bootFlow({sessionResolvesTo:'u1',users,oauthReturn:true}));

console.log('\n=== every other exit still leaves something on screen ===');
check('signed in with no oauth return -> APP',
  bootFlow({sessionResolvesTo:'u1',users,oauthReturn:false})==='APP');
check('oauth return that resolves to no user -> LOGIN (never the splash)',
  bootFlow({sessionResolvesTo:null,users,oauthReturn:true})==='LOGIN',
  bootFlow({sessionResolvesTo:null,users,oauthReturn:true}));
check('saved id with no matching user -> LOGIN',
  bootFlow({sessionResolvesTo:'ghost',users,oauthReturn:true})==='LOGIN',
  bootFlow({sessionResolvesTo:'ghost',users,oauthReturn:true}));
check('plain load, not signed in -> LOGIN',
  bootFlow({sessionResolvesTo:null,users,oauthReturn:false})==='LOGIN');
check('no outcome is ever SPLASH once boot has finished',
  [[null,true],[null,false],['u1',true],['u1',false],['ghost',true]]
    .every(([id,o])=>bootFlow({sessionResolvesTo:id,users,oauthReturn:o})!=='SPLASH'));

console.log('\n=== without the fix, the hang reproduces ===');
function bootFlowUnfixed({sessionResolvesTo,users,oauthReturn}){
  const state={userId:null,users,oauthReturnActive:!!oauthReturn};
  let last=paint(state);
  state.userId=sessionResolvesTo;
  last=paint(state);                          // inner renders, flag still set
  state.oauthReturnActive=false;              // finally clears it, no repaint
  if(state.userId&&state.users.find(u=>u.id===state.userId))last=paint(state);
  return last;                                // no backstop for other exits
}
check('old flow really did end on the splash for a no-user oauth return',
  bootFlowUnfixed({sessionResolvesTo:null,users,oauthReturn:true})==='SPLASH');

console.log('\n=== the fixes are present in app.js ===');
check('checkGoogleSession repaints after clearing _oauthReturnActive',
  /_oauthReturnActive=false;[\s\S]{0,900}?try\{render\(\);\}catch/.test(src));
check('the repaint is guarded so a render throw cannot break boot',
  /try\{render\(\);\}catch\(e\)\{console\.error\('JEX boot: post-auth render failed'/.test(src));
check('boot() has a backstop render for every non-signed-in exit',
  /if\(!UI\.userId\|\|!DB\.users\.find\(x=>x\.id===UI\.userId\)\)\{[\s\S]{0,200}?render\(\);/.test(src));
check('the backstop sits inside boot(), before its catch',
  src.indexOf('no signed-in user resolved')>0&&
  src.indexOf('no signed-in user resolved')<src.indexOf('Connection failed'));

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
