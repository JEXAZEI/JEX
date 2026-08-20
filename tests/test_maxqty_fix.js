const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','app.js'),'utf8');
function extractConst(name){
  const start=src.indexOf('const '+name+'=');
  if(start<0)throw new Error('not found: '+name);
  // walk to the terminating ';' at brace/paren depth 0
  let i=start,d=0;
  for(;i<src.length;i++){
    const ch=src[i];
    if(ch==='{'||ch==='('||ch==='[')d++;
    else if(ch==='}'||ch===')'||ch===']')d--;
    else if(ch===';'&&d===0)return src.slice(start,i+1);
  }
  throw new Error('unterminated: '+name);
}
eval(extractConst('impactPrice').replace('const ','var '));
eval(extractConst('maxAffordableQty').replace('const ','var '));

let fails=0;
const check=(label,cond,extra)=>{ if(cond)console.log('PASS: '+label); else {console.log('FAIL: '+label+(extra?' -- '+extra:''));fails++;} };
const costOf=(co,q)=>Math.round(impactPrice(co,q,'buy')*q*100)/100;

const cases=[
  {label:'typical: $10k / $100 / 10k float', co:{price:100,shares:10000,shares_avail:1e9}, cash:10000},
  {label:'thin float: $10k / $100 / 1k float', co:{price:100,shares:1000,shares_avail:1e9}, cash:10000},
  {label:'penny stock: $10k / $1 / 100k float', co:{price:1,shares:100000,shares_avail:1e9}, cash:10000},
  {label:'impact-capped: $50k / $10 / 500 float', co:{price:10,shares:500,shares_avail:1e9}, cash:50000},
  {label:'exact divisor: $1000 / $10 / 1M float', co:{price:10,shares:1000000,shares_avail:1e9}, cash:1000},
  {label:'cash just under 1 share', co:{price:100,shares:10000,shares_avail:1e9}, cash:99.99},
  {label:'cash exactly 1 share (impact pushes over)', co:{price:100,shares:1000,shares_avail:1e9}, cash:100},
  {label:'huge cash vs tiny float', co:{price:5,shares:200,shares_avail:1e9}, cash:1000000},
];

console.log('=== affordability (never over cash) ===');
for(const c of cases){
  const q=maxAffordableQty(c.co,c.cash);
  const cost=costOf(c.co,q);
  check(c.label+`  -> qty=${q} cost=$${cost} (cash $${c.cash})`, cost<=c.cash, `cost $${cost} exceeds cash $${c.cash}`);
}

console.log('\n=== maximality (qty+1 must NOT be affordable) ===');
for(const c of cases){
  const q=maxAffordableQty(c.co,c.cash);
  const nextCost=costOf(c.co,q+1);
  check(c.label+`  -> qty+1=${q+1} costs $${nextCost}`, nextCost>c.cash, `qty+1 costs $${nextCost}, still <= cash $${c.cash} -- not maximal`);
}

console.log('\n=== brute-force cross-check vs linear scan ===');
for(const c of cases.slice(0,4)){
  const q=maxAffordableQty(c.co,c.cash);
  let brute=0;
  const cap=Math.floor(c.cash/c.co.price);
  for(let i=0;i<=cap;i++){ if(costOf(c.co,i)<=c.cash)brute=i; }
  check(c.label+`  binary=${q} brute=${brute}`, q===brute);
}

console.log('\n=== edge cases ===');
check('index fund uses naive division (no impact)', maxAffordableQty({price:100,shares:5,shares_avail:1e9,is_index_fund:true},10000)===100);
check('zero cash -> 0', maxAffordableQty({price:100,shares:1000},0)===0);
check('negative cash -> 0', maxAffordableQty({price:100,shares:1000},-50)===0);
check('zero price -> 0', maxAffordableQty({price:0,shares:1000},10000)===0);
check('null co -> 0', maxAffordableQty(null,10000)===0);
check('undefined price -> 0', maxAffordableQty({shares:1000},10000)===0);
check('cash below one share -> 0', maxAffordableQty({price:100,shares:1000},50)===0);
check('result is always an integer', Number.isInteger(maxAffordableQty({price:37.13,shares:8123},9999.99)));

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
