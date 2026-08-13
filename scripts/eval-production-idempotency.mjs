// ---------------------------------------------------------------------------
// eval-production-idempotency.mjs — what happens when somebody presses twice.
//
// A purchaser double-clicks. A browser retries a POST. Two tabs are open on the
// same request. None of those may produce two purchase orders, two order
// placements or two receipts, because each of those is a real-world commitment
// that cannot be taken back once a supplier has it.
//
// This fires genuinely CONCURRENT requests — Promise.all over two identical
// posts — at a running production server, then reads the database directly to
// count what was actually written.
//
// It found that `markOrderPlaced` evaluated the transition guard against a
// request loaded BEFORE the write queue was joined, so a second press was
// judged on a stale status. Fixed by re-reading inside the transaction.
//
// NOTE ON THE ACTIVITY LOG: two rows per transition is correct. The workflow
// engine writes a skeletal event proving the state changed and cannot be made
// to skip it; the use case writes the rich one carrying the notification
// payload. See application/context.ts. The assertion below pins TWO, and the
// point is that a second press adds none.
//
// Run it against the same server as eval-production-coldstart.mjs, after it:
//
//   PCC_BASE_URL=http://127.0.0.1:3399 PCC_DATABASE_PATH=/tmp/pcc-cold/pcc.sqlite \
//     node scripts/eval-production-idempotency.mjs
// ---------------------------------------------------------------------------
const BASE = process.env.PCC_BASE_URL ?? 'http://127.0.0.1:3399';
const DB_PATH = process.env.PCC_DATABASE_PATH ?? '/tmp/pcc-prod/data/pcc.sqlite';
let pass=0; const fails=[];
const ok=(c,n,d='')=>{c?(pass++,console.log('  ok  '+n)):(fails.push(n+(d?' — '+d:'')),console.log('FAIL  '+n+(d?' — '+d:'')));};
const decode=(v)=>v.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
const login=async(e,p)=>{const r=await fetch(`${BASE}/api/auth/sign-in`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p}),redirect:'manual'});return (r.headers.get('set-cookie')??'').split(';')[0];};
async function formOn(cookie,path,needle){
  const page=await (await fetch(`${BASE}${path}`,{headers:{cookie}})).text();
  const form=[...page.matchAll(/<form[\s\S]*?<\/form>/g)].map(m=>m[0]).find(f=>f.includes(needle));
  if(!form) return null;
  const parts=[];
  for(const m of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)){
    const n=/name="([^"]*)"/.exec(m[0])?.[1]; const v=/value="([^"]*)"/.exec(m[0])?.[1]??'';
    if(n) parts.push([decode(n),decode(v)]);
  }
  for(const m of form.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)){
    const n=decode(m[1]);
    const opts=[...m[2].matchAll(/<option[^>]*value="([^"]*)"[^>]*>/g)].filter(o=>!/disabled/.test(o[0])).map(o=>decode(o[1])).filter(v=>v!=='');
    if(opts.length) parts.push([n,opts[0]]);
  }
  return parts;
}
function bodyOf(parts){const b='----idem';let s='';for(const[n,v]of parts)s+=`--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;return{body:s+`--${b}--\r\n`,b};}
const post=(cookie,path,parts)=>{const{body,b}=bodyOf(parts);return fetch(`${BASE}${path}`,{method:'POST',headers:{cookie,'Content-Type':`multipart/form-data; boundary=${b}`},body,redirect:'manual'});};

const admin=await login(process.env.PCC_ADMIN_EMAIL ?? 'jose@lippolis.test', process.env.PCC_ADMIN_PASSWORD ?? 'ColdStartAdmin!2026');
const mike=await login('mike@lippolis.test','MikeTemp!2026x');

// Raise + approve a fresh request so we have one to hammer.
const newParts=await formOn(admin,'/requests/new','Submit to workshop');
const raise=[...newParts.filter(([n])=>!['jobNumber','itemDescription','itemQty','itemUnit','needByDate','needByTime','submit'].includes(n)),
  ['jobNumber','26-001'],['itemDescription','Idempotency probe'],['itemQty','6'],['itemUnit','ea'],
  ['needByDate','2026-08-25'],['needByTime','07:00'],['submit','now']];
const r1=await post(admin,'/requests/new',raise);
const id=/\/requests\/([\w-]+)/.exec(r1.headers.get('location')??'')?.[1];
ok(Boolean(id),'probe request raised');

// DOUBLE-SUBMIT THE APPROVAL — two identical presses, at once.
const revParts=await formOn(mike,`/requests/${id}/review`,'Approve and print PO');
const [a1,a2]=await Promise.all([post(mike,`/requests/${id}/review`,revParts),post(mike,`/requests/${id}/review`,revParts)]);
ok(true,`concurrent approvals returned ${a1.status}/${a2.status}`);

const { DatabaseSync } = await import('node:sqlite');
const db=new DatabaseSync(DB_PATH);
const pos=db.prepare('select po_number from purchase_orders where request_id = ?').all(id);
ok(pos.length===1,'exactly one purchase order exists for the request',`got ${pos.length}`);
const allPos=db.prepare('select po_number, count(*) n from purchase_orders group by po_number having n>1').all();
ok(allPos.length===0,'no PO number was issued twice anywhere',JSON.stringify(allPos));

// DOUBLE MARK-ORDERED.
for (const label of ['Mark reviewed','Approve to send','I sent it']) {
  const p=await formOn(mike,`/requests/${id}/email`,label); if(p) await post(mike,`/requests/${id}/email`,p);
}
const mo=await formOn(mike,`/requests/${id}/email`,'Mark ordered');
const [o1,o2]=await Promise.all([post(mike,`/requests/${id}/email`,mo),post(mike,`/requests/${id}/email`,mo)]);
ok(true,`concurrent Mark ordered returned ${o1.status}/${o2.status}`);
// TWO rows per transition is correct and deliberate: the workflow engine
// writes a skeletal event proving the state changed (it cannot be made to skip
// it), and the use case writes the rich one carrying the notification payload.
// See application/context.ts. What matters here is that a SECOND press adds
// nothing at all.
const orderedEvents=db.prepare("select count(*) n from purchase_activity_log where request_id=? and action='order.placed'").get(id).n;
ok(orderedEvents===2,'the order was placed exactly once — one engine event, one domain event',`got ${orderedEvents}`);
ok(db.prepare('select status from purchase_requests where id=?').get(id).status==='ORDERED','and the status moved exactly once');

// DOUBLE RECEIVE.
const rc=await formOn(mike,'/receiving','It arrived');
const rcFor=rc? rc.map(([n,v])=>n==='requestId'?[n,id]:[n,v]) : [['requestId',id]];
const [c1,c2]=await Promise.all([post(mike,'/receiving',rcFor),post(mike,'/receiving',rcFor)]);
ok(true,`concurrent receive returned ${c1.status}/${c2.status}`);
const receipts=db.prepare('select count(*) n from purchase_receipts where request_id=?').get(id).n;
ok(receipts===1,'exactly one receipt was written',`got ${receipts}`);
const recvQty=db.prepare(`select coalesce(sum(ri.received_qty),0) q from purchase_receipt_items ri
  join purchase_receipts rc on rc.id=ri.receipt_id where rc.request_id=?`).get(id).q;
ok(Number(recvQty)===6000,'and the quantity received is 6, not 12',`got ${Number(recvQty)/1000}`);
const hist=db.prepare('select count(*) n from purchase_history_lines where request_id=?').get(id).n;
ok(hist===1,'history has one line, not two',`got ${hist}`);

console.log('');
console.log(`idempotency checks: ${pass} passed, ${fails.length} failed`);
if(fails.length){console.log('\nFAILURES:');for(const f of fails)console.log('  - '+f);}
process.exit(fails.length?1:0);
