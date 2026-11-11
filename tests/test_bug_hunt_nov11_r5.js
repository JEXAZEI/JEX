// Regression checks for the fifth bug hunt: the exports an instructor hands on.
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
function extractFn(name){
  const m=new RegExp('^(?:async )?function '+name+'\\(','m').exec(src);
  if(!m)throw new Error('no function '+name);
  let i=src.indexOf('{',m.index),d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'){d--; if(d===0)return src.slice(m.index,i+1);} }
}
const load=name=>eval('('+extractFn(name)+')');
let fails=0;
const check=(l,c,e)=>{if(c)console.log('PASS: '+l);else{fails++;console.log('FAIL: '+l+(e?' -- '+e:''));}};

// ── the Balances CSV cannot carry a live formula ──
{
  global.neutralizeFormula=load('neutralizeFormula');
  global.pvMark=()=>0;global.divRec=()=>0;global.startFor=()=>10000;
  global.nwMark=u=>u.cash;
  global.byNwThenName=k=>(a,b)=>b[k]-a[k]||String(a.name).localeCompare(String(b.name));
  global.tieRanks=v=>v.map((x,i)=>i+1);
  global.fmt=n=>'$'+Number(n).toFixed(2);global.esc=s=>String(s);
  global.window={};
  const renderAdminBalances=load('renderAdminBalances');
  renderAdminBalances([{name:'=HYPERLINK("http://x","click")',cash:10000},{name:'Ann\r\nLee',cash:9000}]);
  const lines=window._jexCSV.split('\n');
  check('a name starting with = is written as text',lines[1].includes(`"'=HYPERLINK(""http://x"",""click"")"`),lines[1]);
  check('a carriage return in a name does not break the row',lines.length===3&&/Ann Lee/.test(lines[2]),JSON.stringify(lines));
  check('amounts stay plain numbers',/,10000\.00,/.test(lines[1]));
}

// ── downloads: the link is in the page, the URL outlives the click ──
{
  const body=extractFn('saveBlob');
  check('the link is attached before the click',/appendChild\(a\);a\.click\(\)/.test(body));
  check('the blob URL is revoked later, not in the same tick',/setTimeout\(\(\)=>URL\.revokeObjectURL\(url\)/.test(body));
  check('both CSV exports go through saveBlob',/saveBlob\(filename,/.test(extractFn('exportCSV'))&&/saveBlob\('jex_balances\.csv'/.test(extractFn('downloadCSV')));
}

// ── the PDF report matches the Balances tab ──
{
  const body=extractFn('generatePDFReport');
  check('hidden test students are left out',/status==='approved'&&!isHiddenTestEntity\(u\.id\)/.test(body));
  check('only listed, visible companies are counted and shown',/const listedCos=DB\.companies\.filter\(c=>c\.status==='listed'&&!isHiddenTestEntity\(c\.owner_id\)\)/.test(body)&&!/DB\.companies\.(length|map)/.test(body));
  check('trades, dividends and news skip hidden companies',!/DB\.(trades|dividends|news)\.(length|map|slice|reduce)/.test(body));
  check('the time is Arizona time',!/new Date\(\)\.toLocaleString\(\)/.test(body)&&/fmtAZTime\(new Date\(\)\)/.test(body));
  check('a blocked pop-up is explained, not a TypeError',/if\(!w\)return toast\(/.test(body));
  const mine=extractFn('exportStudentPDF');
  check('the student report: Arizona time and a blocked pop-up handled',/if\(!win\)return toast\(/.test(mine)&&!/toLocaleString\(\)/.test(mine));
}

// ── reassigning names the classroom ──
{
  global.isAdmin=()=>true;global.cu=()=>({});
  global.DB={classrooms:[{id:'c1',name:'Period 3'}],users:[{id:'u1',classroom_id:null}]};
  global.getUser=id=>DB.users.find(u=>u.id===id);
  global.getClassroomName=load('getClassroomName');
  const vals={'reassign-uid':'u1','reassign-cid-select':'c1'};
  global.get=id=>({value:vals[id]});
  global.sb={rpc:async()=>({})};global.render=()=>{};
  let said='';global.toast=m=>{said=m;};
  const reassignClassroom=load('reassignClassroom');
  reassignClassroom().then(()=>{
    check('the toast names the classroom, not its id',said==='Reassigned to classroom: Period 3',said);
    vals['reassign-cid-select']='';
    return reassignClassroom();
  }).then(()=>{
    check('unassigning says so',said==='Removed from their classroom',said);
    console.log(fails?fails+' FAILED':'all passed');process.exit(fails?1:0);
  });
}
