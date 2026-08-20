const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','app.js'),'utf8');
function extractFn(name){
  const start=src.indexOf('function '+name+'(');
  let i=src.indexOf('{',start),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--; if(d===0)return src.slice(start,i+1);} }
}
eval(extractFn('computeIndex').replace('function computeIndex','computeIndex=function'));

let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// Mirrors the SQL in index_live_value() so client and server can be compared.
const serverIndex=(cos,classroomId,users)=>{
  const rows=cos.filter(c=>c.status==='listed'&&!c.is_index_fund
    &&(classroomId==null||users.find(u=>u.id===c.owner_id)?.classroom_id===classroomId));
  if(!rows.length)return null;
  const avg=rows.reduce((s,c)=>{
    const base=(c.price_history?.[0]?.p??0)*(c.index_base_adjust??1);
    return s+(base>0?c.price/base:1);
  },0)/rows.length;
  return Math.round(avg*1000*100)/100;
};

const users=[{id:'o1',classroom_id:'A'},{id:'o2',classroom_id:'A'},{id:'o3',classroom_id:'A'}];
const mk=()=>['AAA','BBB','CCC'].map((t,i)=>({ticker:t,name:t,status:'listed',owner_id:'o'+(i+1),
  price:12,price_history:[{p:10,t:'2026-08-01T00:00:00Z'}],shares:1000,index_base_adjust:1}));

global.DB={companies:[],shareClasses:[],session:{}};
global.getClassMeta=()=>null;
global.isHiddenTestEntity=()=>false;
global.getUser=id=>users.find(u=>u.id===id);
const idx=(cos,cid)=>{DB.companies=cos;return computeIndex(cid??null).value;};

console.log('=== a dilution must not move the index ===');
const before=mk();
const v0=idx(before,'A');
check('baseline index is 1200', v0===1200, 'got '+v0);

// AAA dilutes 2:1 -- price halves, and rpc_review_dilution now scales the adjust
const after=mk();
const co=after[0], oldPrice=co.price;
co.shares=2000;
co.price=Math.max(0.01,Math.round(oldPrice*(1000/2000)*100)/100);
co.index_base_adjust=1*(co.price/oldPrice);
const v1=idx(after,'A');
check('index unchanged after a 2:1 dilution', v1===v0, `${v1} vs ${v0}`);

// without the adjustment (the old behaviour) it really did move
const unadjusted=mk(); unadjusted[0].price=6; unadjusted[0].index_base_adjust=1;
check('and without the adjustment it still would move', idx(unadjusted,'A')<v0, 'got '+idx(unadjusted,'A'));

console.log('\n=== real price moves still register ===');
const moved=mk(); moved[0].price=18;
check('a genuine price rise lifts the index', idx(moved,'A')>v0, 'got '+idx(moved,'A'));
const movedAfterDil=mk();
movedAfterDil[0].price=9; movedAfterDil[0].index_base_adjust=0.5;  // diluted, then rallied 6 -> 9
check('a rally AFTER a dilution lifts the index correctly', idx(movedAfterDil,'A')>v0, 'got '+idx(movedAfterDil,'A'));
const fellAfterDil=mk();
fellAfterDil[0].price=3; fellAfterDil[0].index_base_adjust=0.5;    // diluted, then fell 6 -> 3
check('a real fall AFTER a dilution lowers the index', idx(fellAfterDil,'A')<v0, 'got '+idx(fellAfterDil,'A'));

console.log('\n=== compounding and edge cases ===');
const twice=mk();
twice[0].price=3; twice[0].index_base_adjust=0.25;  // two successive 2:1 dilutions
check('two successive dilutions still leave the index flat', idx(twice,'A')===v0, `${idx(twice,'A')} vs ${v0}`);

const missing=mk(); delete missing[0].index_base_adjust;
check('a row with no index_base_adjust defaults to 1 (pre-migration rows)', idx(missing,'A')===v0, 'got '+idx(missing,'A'));
const nullAdj=mk(); nullAdj[0].index_base_adjust=null;
check('null index_base_adjust also defaults to 1', idx(nullAdj,'A')===v0, 'got '+idx(nullAdj,'A'));
const zeroAdj=mk(); zeroAdj[0].index_base_adjust=0;
check('zero adjust does not divide by zero', Number.isFinite(idx(zeroAdj,'A')), 'got '+idx(zeroAdj,'A'));

console.log('\n=== client and server agree ===');
for(const [label,cos] of [['baseline',mk()],['after dilution',after],['after two dilutions',twice],['rallied post-dilution',movedAfterDil]]){
  DB.companies=cos;
  const c=computeIndex('A').value, s=serverIndex(cos,'A',users);
  check(`${label}: client ${c} == server ${s}`, Math.abs(c-s)<0.01);
}

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
