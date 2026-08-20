// The leaderboard renders a frozen snapshot when the session is closed.
// That snapshot is written at session close and stored on jex_session, so it
// goes stale the moment an account is removed -- a deleted student kept
// showing up, with their old net worth, until the next close overwrote it.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// Reproduce the selection logic exactly as renderLeaderboard applies it.
function rank(snapshot,users,sessionStatus,classroom){
  const getUser=id=>users.find(u=>u.id===id);
  const isHiddenTestEntity=id=>!!(getUser(id)||{}).is_test_account;
  const isFrozen=snapshot&&snapshot.length>0&&sessionStatus!=='open';
  let ranked=isFrozen?snapshot:users.filter(u=>u.role==='student'&&u.status==='approved')
    .map(u=>({...u,_nw:u.nw,name:u.name,id:u.id,classroom_id:u.classroom_id})).sort((a,b)=>b._nw-a._nw);
  ranked=ranked.filter(u=>!isHiddenTestEntity(u.id));
  if(isFrozen)ranked=ranked.filter(e=>{
    const live=getUser(e.id);
    return live&&live.role==='student'&&live.status==='approved';
  });
  if(classroom)ranked=ranked.filter(u=>u.classroom_id===classroom);
  return ranked.map(u=>u.name);
}

const snapshot=[
  {id:'u-ghost',name:'67KID',nw:10000,classroom_id:'A'},
  {id:'u-ariel',name:'Ariel Ramirez-Angulo',nw:8583.03,classroom_id:'A'},
  {id:'u-bea',name:'Bea',nw:7000,classroom_id:'B'},
];
// 67KID has since been removed; the others are still live.
const live=[
  {id:'u-ariel',name:'Ariel Ramirez-Angulo',role:'student',status:'approved',nw:8583.03,classroom_id:'A'},
  {id:'u-bea',name:'Bea',role:'student',status:'approved',nw:7000,classroom_id:'B'},
];

console.log('=== the reported bug ===');
const closed=rank(snapshot,live,'closed');
check('a removed account no longer appears on the frozen leaderboard', !closed.includes('67KID'), closed.join(', '));
check('remaining students still appear', closed.includes('Ariel Ramirez-Angulo')&&closed.includes('Bea'), closed.join(', '));
check('order preserved from the snapshot', JSON.stringify(closed)===JSON.stringify(['Ariel Ramirez-Angulo','Bea']), closed.join(', '));

console.log('\n=== the frozen values are still the frozen ones ===');
// Filtering must not silently switch the page to live figures -- the badge
// says "Frozen at close" and the numbers have to match that claim.
const stale=[{id:'u-ariel',name:'Ariel Ramirez-Angulo',nw:9999,classroom_id:'A'}];
const liveMoved=[{id:'u-ariel',name:'Ariel Ramirez-Angulo',role:'student',status:'approved',nw:1,classroom_id:'A'}];
const isFrozenPick=(snap,users)=>{
  const getUser=id=>users.find(u=>u.id===id);
  return snap.filter(e=>{const l=getUser(e.id);return l&&l.role==='student'&&l.status==='approved';});
};
check('a surviving entry keeps its snapshot net worth', isFrozenPick(stale,liveMoved)[0].nw===9999);

console.log('\n=== other removal shapes ===');
const unapproved=[{id:'u-ariel',name:'Ariel Ramirez-Angulo',role:'student',status:'pending',classroom_id:'A'}];
check('a no-longer-approved student drops out', rank([{id:'u-ariel',name:'Ariel Ramirez-Angulo',nw:5,classroom_id:'A'}],unapproved,'closed').length===0);
const roleChanged=[{id:'u-ariel',name:'Ariel Ramirez-Angulo',role:'company',status:'approved',classroom_id:'A'}];
check('an account converted to a company drops out', rank([{id:'u-ariel',name:'x',nw:5,classroom_id:'A'}],roleChanged,'closed').length===0);
const testAcct=[{id:'u-t',name:'T',role:'student',status:'approved',is_test_account:true,classroom_id:'A'}];
check('test accounts still hidden in frozen mode', rank([{id:'u-t',name:'T',nw:5,classroom_id:'A'}],testAcct,'closed').length===0);

console.log('\n=== live mode is untouched ===');
const open=rank(snapshot,live,'open');
check('an open session ignores the snapshot entirely', !open.includes('67KID')&&open.length===2, open.join(', '));
check('no snapshot at all falls back to live', rank(null,live,'closed').length===2);
// [] is truthy, so without a .length check an empty snapshot froze the
// leaderboard blank -- a pre-existing bug, found while testing this fix.
check('an empty snapshot falls back to live rather than blanking',
  rank([],live,'closed').length===2, 'empty snapshot blanked the board');
check('app.js guards the empty-snapshot case', /lbSnap&&lbSnap\.length>0&&/.test(src));

console.log('\n=== classroom filter still applies ===');
check('classroom filter works on frozen rows', JSON.stringify(rank(snapshot,live,'closed','B'))===JSON.stringify(['Bea']));

console.log('\n=== the guard is actually in app.js ===');
check('renderLeaderboard re-checks frozen entries against the live roster',
  /if\(isFrozen\)ranked=ranked\.filter\(e=>\{[\s\S]{0,200}?getUser\(e\.id\)/.test(src));

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
