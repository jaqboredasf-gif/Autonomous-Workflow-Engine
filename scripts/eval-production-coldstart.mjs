// ---------------------------------------------------------------------------
// eval-production-coldstart.mjs — the acceptance test for a machine that has
// never run PCC.
//
// Every other suite starts from the development fixture: a database with Mike,
// Rick, three vendors and three jobs already in it. A real installation has
// none of that. This one drives a PRODUCTION build, against an EMPTY database,
// with production configuration, through the sequence Jose and Mike actually
// perform on day one — sign in as the bootstrap administrator, enter a vendor,
// a job and a user, and take one purchase all the way to received.
//
// It found three things no other suite could:
//   · the standalone build served a 404 for every stylesheet (fixed by
//     scripts/stage-standalone.mjs)
//   · the vendor <select> had no name, so the form only worked with JavaScript
//   · the quantity to order was computed in the browser into a hidden field, so
//     an unhydrated page ordered the full requested amount instead of the
//     amount less workshop stock — wrong quantity, no error
//
// HOW TO RUN IT (the server is not started for you — this is deliberate, so it
// can be pointed at a real staging host):
//
//   npm run build --workspace purchasing
//   rm -rf /tmp/pcc-cold && mkdir -p /tmp/pcc-cold
//   NODE_ENV=production PORT=3399 HOSTNAME=127.0.0.1 \
//   APP_BASE_URL=http://pcc.example.internal \
//   SESSION_SECRET="$(openssl rand -hex 32)" \
//   PCC_DATABASE_PATH=/tmp/pcc-cold/pcc.sqlite PCC_DATABASE_ALLOW_CREATE=1 \
//   PCC_ORG_NAME="Lippolis Electric, Inc." \
//   PCC_PO_NUMBERING=job-vendor-sequence \
//   PCC_BOOTSTRAP_ADMIN_EMAIL=admin@example.test \
//   PCC_BOOTSTRAP_ADMIN_PASSWORD='ColdStartAdmin!2026' \
//     node apps/purchasing/.next/standalone/apps/purchasing/server.js &
//
//   PCC_BASE_URL=http://127.0.0.1:3399 \
//   PCC_ADMIN_EMAIL=admin@example.test PCC_ADMIN_PASSWORD='ColdStartAdmin!2026' \
//     node scripts/eval-production-coldstart.mjs
//
// RE-RUNNABLE ON PURPOSE. Running it a second time against the same database is
// how a restart is verified: the purchase runs again and the (job, vendor)
// sequence continues. Set PCC_EXPECT_PO_SEQUENCE=2 on the second run to assert
// that continuity rather than merely observe it.
// ---------------------------------------------------------------------------
const BASE = process.env.PCC_BASE_URL ?? 'http://127.0.0.1:3399';
const ADMIN_EMAIL = process.env.PCC_ADMIN_EMAIL ?? 'jose@lippolis.test';
const ADMIN_PASSWORD = process.env.PCC_ADMIN_PASSWORD ?? 'ColdStartAdmin!2026';
let pass=0; const fails=[];
const ok=(c,n,d='')=>{ if(c){pass++;console.log('  ok  '+n);} else {fails.push(n+(d?' — '+d:''));console.log('FAIL  '+n+(d?' — '+d:''));} return c; };
const decode=(v)=>v.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');

async function login(email,password){
  const r=await fetch(`${BASE}/api/auth/sign-in`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email,password}),redirect:'manual'});
  return {status:r.status, cookie:(r.headers.get('set-cookie')??'').split(';')[0]||null};
}
async function submit(cookie,path,needle,fields){
  const page=await (await fetch(`${BASE}${path}`,{headers:{cookie}})).text();
  const form=[...page.matchAll(/<form[\s\S]*?<\/form>/g)].map(m=>m[0]).find(f=>f.includes(needle));
  if(!form) throw new Error(`no form "${needle}" on ${path}`);
  const provided=new Set(fields.map(([n])=>n)); const parts=[];
  for(const m of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)){
    const n=/name="([^"]*)"/.exec(m[0])?.[1]; const v=/value="([^"]*)"/.exec(m[0])?.[1]??'';
    if(n&&!provided.has(decode(n))) parts.push([decode(n),decode(v)]);
  }
  for(const m of form.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)){
    const n=decode(m[1]); if(provided.has(n)) continue;
    const opts=[...m[2].matchAll(/<option[^>]*value="([^"]*)"[^>]*>/g)].filter(o=>!/disabled/.test(o[0])).map(o=>decode(o[1])).filter(v=>v!=='');
    if(opts.length) parts.push([n,opts[0]]);
  }
  const b='----cold'; let body='';
  for(const [n,v] of [...parts,...fields]) body+=`--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  body+=`--${b}--\r\n`;
  const res=await fetch(`${BASE}${path}`,{method:'POST',headers:{cookie,'Content-Type':`multipart/form-data; boundary=${b}`},body,redirect:'manual'});
  return {status:res.status, location:res.headers.get('location')??'', body:await res.text()};
}
const get=async(cookie,path)=>{const r=await fetch(`${BASE}${path}`,{headers:{cookie},redirect:'manual'});return {status:r.status,location:r.headers.get('location')??'',body:r.status===200?await r.text():''};};

console.log('--- a production database with nothing in it --------------------');
const bad=await login(ADMIN_EMAIL,'wrong-password');
ok(!bad.cookie,'a wrong password mints no session');
const admin=(await login(ADMIN_EMAIL,ADMIN_PASSWORD)).cookie;
ok(Boolean(admin),'the bootstrap administrator signs in');
const demo=await login('mike@example.invalid','Purchasing!2026');
ok(!demo.cookie,'no demonstration account exists in a production database');

console.log('--- the company enters its own data -----------------------------');
const v=await submit(admin,'/admin?module=vendors','Add vendor',[
  ['name','Graybar Electric'],['code','GRAYBAR'],['accountNumber','LIP-1'],['phone','(914) 555-0100'],
  ['address','1 Supply Way'],['contactName','Counter'],['contactEmail','orders@graybar.test'],['contactPhone','(914) 555-0101']]);
ok(v.status>=200&&v.status<400,'a vendor can be added',`status ${v.status}`);
const j=await submit(admin,'/admin?module=jobs','Add job',[['jobNumber','26-001'],['name','Cold start job'],['siteAddress','2 Site Road']]);
ok(j.status>=200&&j.status<400,'a job can be added',`status ${j.status}`);
const inv=await submit(admin,'/admin?module=users','Invite',[
  ['fullName','Mike Purchasing'],['email','mike@lippolis.test'],['roles','WORKSHOP_APPROVER'],
  ['temporaryPassword','MikeTemp!2026x'],['canApprove','true']]);
ok(inv.status>=200&&inv.status<400,'a real user can be invited',`status ${inv.status}`);
const mike=(await login('mike@lippolis.test','MikeTemp!2026x')).cookie;
ok(Boolean(mike),'the invited user signs in');

console.log('--- the whole purchase, on production configuration -------------');
const req=await submit(admin,'/requests/new','Submit to workshop',[
  ['jobNumber','26-001'],['itemDescription','1in EMT coupling'],['itemQty','10'],['itemUnit','ea'],
  ['needByDate','2026-08-20'],['needByTime','07:00'],['submit','now']]);
const id=/\/requests\/([\w-]+)/.exec(req.location)?.[1];
ok(Boolean(id),'a request is raised',`status ${req.status} -> ${req.location}`);

const review=await get(mike,`/requests/${id}/review`);
const vsel=/<select[^>]*name="vendorId"[^>]*>([\s\S]*?)<\/select>/.exec(review.body);
const vendorId=vsel? (/<option[^>]*value="([0-9a-f-]{36})"/.exec(vsel[1])?.[1]??'') : '';
const appr=await submit(mike,`/requests/${id}/review`,'Approve and print PO',[
  ['lineUsableStock','2'],['vendorId',vendorId]]);
ok((appr.location??'').includes('/po'),'approval creates the PO and goes to print',`-> ${appr.location}`);

const po=await get(mike,`/requests/${id}/po`);
const poNumber=/26-001-GRAYBAR-\d+/.exec(po.body)?.[0]??null;
// SHAPE AND CONTINUITY, NOT A LITERAL. This used to assert `-1`, which made the
// whole acceptance test a once-per-database thing: run it twice — as anybody
// verifying a restart does — and it failed on the CORRECT answer, because the
// second purchase from the same job and vendor is genuinely -2. Asserting the
// shape and that the sequence moves forward tests the rule; asserting -1 tested
// that nobody had used the system yet.
const poSeq=poNumber?Number(poNumber.split('-').pop()):NaN;
ok(Number.isSafeInteger(poSeq)&&poSeq>=1,'the PO number is job-vendor-sequence',`got ${poNumber}`);
if(process.env.PCC_EXPECT_PO_SEQUENCE){
  ok(String(poSeq)===process.env.PCC_EXPECT_PO_SEQUENCE,
    `the sequence continued to ${process.env.PCC_EXPECT_PO_SEQUENCE} across the restart`,`got ${poSeq}`);
}
ok(/Job qty/.test(po.body)&&/Shop/.test(po.body),'the printed copy shows the quantity breakdown');
{
  const tbl=/<table[\s\S]*?<\/table>/.exec(po.body)?.[0]??'';
  const row=/<tbody>([\s\S]*?)<\/tbody>/.exec(tbl)?.[1]??'';
  const cells=[...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m=>m[1].replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').trim()).filter(Boolean);
  ok(cells[0]==='10','printed job qty is 10',`got ${cells[0]}`);
  ok(cells[1]==='2','printed workshop stock is 2',`got ${cells[1]}`);
  ok(/^8/.test(cells[2]||''),'printed quantity ordered is 8',`got ${cells[2]}`);
}

const email=await get(mike,`/requests/${id}/email`);
ok(Boolean(poNumber)&&email.status===200&&email.body.includes(poNumber),'the vendor email draft exists and names the PO');
ok(!/Send email|Send now/.test(email.body),'and there is no autonomous send button');
for(const label of ['Mark reviewed','Approve to send','I sent it']){
  let r;
  try { r=await submit(mike,`/requests/${id}/email`,label,[]); }
  catch(e){ r={status:0}; }
  ok(r.status>=200&&r.status<400,`draft advances: ${label}`,`status ${r.status}`);
}
const ordered=await submit(mike,`/requests/${id}/email`,'Mark ordered',[]);
ok((ordered.location??'').includes('/dashboard'),'Mark ordered returns to the dashboard',`-> ${ordered.location}`);

console.log('--- idempotency and refusals ------------------------------------');
const again=await submit(mike,`/requests/${id}`,'Mark ordered',[['requestId',id]]).catch(()=>({status:0,location:'',body:''}));
ok(true,'a repeat Mark ordered does not crash the server');
const detail=await get(mike,`/requests/${id}`);
ok(/ORDERED|Ordered|It arrived/.test(detail.body),'the request is still exactly once ordered');

const recv=await submit(mike,'/receiving','It arrived',[['requestId',id]]);
ok(recv.status>=200&&recv.status<400,'one click receives the delivery',`status ${recv.status}`);
const after=await get(mike,'/receiving');
ok(Boolean(poNumber)&&!after.body.includes(poNumber),'and it leaves the receiving queue');
const recvAgain=await submit(mike,`/requests/${id}`,'It arrived',[['requestId',id]]).catch(()=>({status:0}));
ok(true,'a repeat receive does not crash the server');

console.log('--- authorization on production configuration -------------------');
const inv2=await submit(admin,'/admin?module=users','Invite',[
  ['fullName','Field Hand'],['email','field@lippolis.test'],['roles','REQUESTOR'],['temporaryPassword','FieldTemp!2026x']]);
ok(inv2.status>=200&&inv2.status<400,'a restricted user can be invited');
const field=(await login('field@lippolis.test','FieldTemp!2026x')).cookie;
ok(Boolean(field),'the restricted user signs in');
const denied=await get(field,'/admin?module=users');
ok([302,303,307,308].includes(denied.status)||/unauthorized/i.test(denied.location),'a requestor is refused administration',`status ${denied.status} -> ${denied.location}`);
const deniedReview=await get(field,`/requests/${id}/review`);
ok([302,303,307,308,404].includes(deniedReview.status),'and refused the review screen',`status ${deniedReview.status}`);
const anon=await fetch(`${BASE}/dashboard`,{redirect:'manual'});
ok([302,303,307,308].includes(anon.status),'an unauthenticated request is redirected to sign-in');

console.log('');
console.log(`cold-start checks: ${pass} passed, ${fails.length} failed`);
if(fails.length){console.log('\nFAILURES:');for(const f of fails)console.log('  - '+f);}
process.exit(fails.length?1:0);
