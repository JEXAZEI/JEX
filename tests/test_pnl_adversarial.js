const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','app.js'),'utf8');
function extractFn(name){
  const start=src.indexOf('function '+name+'(');
  let i=src.indexOf('{',start),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--; if(d===0)return src.slice(start,i+1);} }
}
eval(extractFn('calcPnLAttribution').replace('function calcPnLAttribution','calcPnLAttribution=function'));
eval('holdings=u=>u.holdings||{}; shorts=u=>u.shorts||{};');

let fails=0;
function scenario(label,{trades,user,prices,dividends,expected}){
  global.DB={trades,dividends:dividends||[],companies:Object.entries(prices||{}).map(([ticker,price])=>({ticker,price}))};
  global.getUser=id=>id===user.id?user:null;
  global.getCo=t=>DB.companies.find(c=>c.ticker===t);
  const got=calcPnLAttribution(user.id);
  const bad=Object.keys(expected).filter(k=>Math.abs((got?.[k]??NaN)-expected[k])>0.011);
  if(bad.length){fails++;console.log('FAIL: '+label);console.log('   expected',JSON.stringify(expected));console.log('   actual  ',JSON.stringify(got));}
  else console.log('PASS: '+label);
}

// newest-first ordering, as DB.trades is actually loaded
scenario('no trades at all',{trades:[],user:{id:'u1',holdings:{},shorts:{}},prices:{},expected:{trade:0,dividend:0,short:0,unrealised:0,total:0}});

scenario('dividends only',{trades:[],user:{id:'u1',holdings:{},shorts:{}},prices:{},
  dividends:[{payouts:[{userId:'u1',payout:42.5}]},{payouts:[{userId:'u2',payout:99}]}],
  expected:{trade:0,dividend:42.5,short:0,unrealised:0,total:42.5}});

scenario('multiple buys then one sell (average cost)',{
  trades:[
    {id:3,ticker:'ACME',qty:50,price:20,buyer_id:'exchange',seller_id:'u1',type:'market'},
    {id:2,ticker:'ACME',qty:100,price:14,buyer_id:'u1',seller_id:'exchange',type:'market'},
    {id:1,ticker:'ACME',qty:100,price:10,buyer_id:'u1',seller_id:'exchange',type:'market'},
  ],
  user:{id:'u1',holdings:{ACME:150},shorts:{}},prices:{ACME:20},
  // avg cost = (1000+1400)/200 = 12; sold 50@20 -> +400; hold 150 @12 -> 150*8 = +1200
  expected:{trade:400,short:0,unrealised:1200,total:1600}});

scenario('two tickers do not contaminate each other',{
  trades:[
    {id:4,ticker:'BETA',qty:10,price:50,buyer_id:'exchange',seller_id:'u1',type:'market'},
    {id:3,ticker:'BETA',qty:20,price:30,buyer_id:'u1',seller_id:'exchange',type:'market'},
    {id:2,ticker:'ACME',qty:10,price:15,buyer_id:'exchange',seller_id:'u1',type:'market'},
    {id:1,ticker:'ACME',qty:20,price:10,buyer_id:'u1',seller_id:'exchange',type:'market'},
  ],
  user:{id:'u1',holdings:{ACME:10,BETA:10},shorts:{}},prices:{ACME:15,BETA:50},
  // ACME: sold 10@15 vs cost 10 -> +50; hold 10 @10 now 15 -> +50
  // BETA: sold 10@50 vs cost 30 -> +200; hold 10 @30 now 50 -> +200
  expected:{trade:250,short:0,unrealised:250,total:500}});

scenario('partial cover leaves the rest open',{
  trades:[
    {id:2,ticker:'ACME',qty:30,price:8,buyer_id:'u1',seller_id:'cover',type:'cover'},
    {id:1,ticker:'ACME',qty:100,price:10,buyer_id:'short',seller_id:'u1',type:'short'},
  ],
  user:{id:'u1',holdings:{},shorts:{ACME:{qty:70,avgPrice:10,collateral:1500}}},prices:{ACME:8},
  // realised on 30 covered: (10-8)*30 = +60; still-open 70: (10-8)*70 = +140
  expected:{trade:0,short:200,unrealised:0,total:200}});

scenario('losing short (covered above entry)',{
  trades:[
    {id:2,ticker:'ACME',qty:50,price:14,buyer_id:'u1',seller_id:'cover',type:'cover'},
    {id:1,ticker:'ACME',qty:50,price:10,buyer_id:'short',seller_id:'u1',type:'short'},
  ],
  user:{id:'u1',holdings:{},shorts:{}},prices:{ACME:14},
  expected:{trade:0,short:-200,unrealised:0,total:-200}});

scenario('sell with no visible buy (outside 200-trade window) contributes 0, not a fake gain',{
  trades:[{id:1,ticker:'ACME',qty:10,price:15,buyer_id:'exchange',seller_id:'u1',type:'market'}],
  user:{id:'u1',holdings:{},shorts:{}},prices:{ACME:15},
  expected:{trade:0,short:0,unrealised:0,total:0}});

scenario('cover with no visible open leg contributes 0',{
  trades:[{id:1,ticker:'ACME',qty:10,price:9,buyer_id:'u1',seller_id:'cover',type:'cover'}],
  user:{id:'u1',holdings:{},shorts:{}},prices:{ACME:9},
  expected:{trade:0,short:0,unrealised:0,total:0}});

scenario('holdings with no visible buy contribute 0 unrealised (no fabricated basis)',{
  trades:[],user:{id:'u1',holdings:{ACME:100},shorts:{}},prices:{ACME:25},
  expected:{trade:0,short:0,unrealised:0,total:0}});

scenario('legacy rows with no type field, classified by pool id shape',{
  trades:[
    {id:3,ticker:'ACME',qty:50,price:11,buyer_id:'u1',seller_id:'cover'},
    {id:2,ticker:'ACME',qty:50,price:12,buyer_id:'short',seller_id:'u1'},
    {id:1,ticker:'ACME',qty:100,price:10,buyer_id:'u1',seller_id:'exchange'},
  ],
  user:{id:'u1',holdings:{ACME:100},shorts:{}},prices:{ACME:11},
  expected:{trade:0,short:50,unrealised:100,total:150}});

scenario('peer-to-peer limit fill (counterparty is a real user id, not a pool)',{
  trades:[
    {id:2,ticker:'ACME',qty:40,price:18,buyer_id:'u2',seller_id:'u1',type:'limit'},
    {id:1,ticker:'ACME',qty:100,price:10,buyer_id:'u1',seller_id:'u3',type:'limit'},
  ],
  user:{id:'u1',holdings:{ACME:60},shorts:{}},prices:{ACME:18},
  expected:{trade:320,short:0,unrealised:480,total:800}});

scenario('non-numeric ids: stable sort preserves order, no crash',{
  trades:[
    {id:'b',ticker:'ACME',qty:100,price:10,buyer_id:'u1',seller_id:'exchange',type:'market'},
    {id:'a',ticker:'ACME',qty:40,price:15,buyer_id:'exchange',seller_id:'u1',type:'market'},
  ],
  user:{id:'u1',holdings:{ACME:60},shorts:{}},prices:{ACME:15},
  // buy comes first in array order here, so basis is known: +200 realised, +300 unrealised
  expected:{trade:200,short:0,unrealised:300,total:500}});

scenario('unknown user returns null',{trades:[],user:{id:'u1',holdings:{},shorts:{}},prices:{},expected:{}});
(()=>{global.DB={trades:[],dividends:[],companies:[]};global.getUser=()=>null;
  const r=calcPnLAttribution('nobody');
  if(r===null)console.log('PASS: unknown user returns null');else{fails++;console.log('FAIL: unknown user returned '+JSON.stringify(r));}})();

// total must always equal the sum of its parts
(()=>{
  global.DB={trades:[
    {id:3,ticker:'ACME',qty:50,price:11,buyer_id:'u1',seller_id:'cover',type:'cover'},
    {id:2,ticker:'ACME',qty:50,price:12,buyer_id:'short',seller_id:'u1',type:'short'},
    {id:1,ticker:'ACME',qty:100,price:10,buyer_id:'u1',seller_id:'exchange',type:'market'},
  ],dividends:[{payouts:[{userId:'u1',payout:12.34}]}],companies:[{ticker:'ACME',price:11}]};
  global.getUser=()=>({id:'u1',holdings:{ACME:100},shorts:{}});
  global.getCo=t=>DB.companies.find(c=>c.ticker===t);
  const r=calcPnLAttribution('u1');
  const sum=Math.round((r.trade+r.dividend+r.short+r.unrealised)*100)/100;
  if(Math.abs(sum-r.total)<0.011)console.log('PASS: total equals sum of parts ('+r.total+')');
  else{fails++;console.log('FAIL: total '+r.total+' != sum '+sum);}
})();

console.log(fails?('\n'+fails+' FAILURES'):'\nAll passed');
process.exit(fails?1:0);
