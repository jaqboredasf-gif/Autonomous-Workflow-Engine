// ---------------------------------------------------------------------------
// eval-deployment.mjs — is the PACKAGED application a company system?
//
// Every other suite here asks whether the software is correct. This one asks
// whether the thing you can actually deploy is safe to deploy, and it runs
// against a RUNNING CONTAINER over HTTP — no repository, no source, no
// database handle. What it cannot reach through the front door, it does not
// get to assume.
//
// It runs in two modes, because the interesting questions are on either side
// of a restart:
//
//   --write   sign in, prove the shipped image has no published accounts,
//             configure the PO sequence, and put real purchasing data in.
//             Prints a fingerprint of what it created.
//   --verify  sign in again and prove every one of those facts survived,
//             against the fingerprint from the write pass.
//
//   ACCEPTANCE_BASE_URL   default http://localhost:3399
//   PCC_ADMIN_EMAIL       the bootstrap administrator
//   PCC_ADMIN_PASSWORD    their password
//   PCC_FINGERPRINT       path to the file the two passes share
//
// Usage:
//   node scripts/eval-deployment.mjs --write
//   docker restart pcc-test
//   node scripts/eval-deployment.mjs --verify
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.ACCEPTANCE_BASE_URL ?? 'http://localhost:3399';
const EMAIL = process.env.PCC_ADMIN_EMAIL ?? '';
const PASSWORD = process.env.PCC_ADMIN_PASSWORD ?? '';
const FINGERPRINT = process.env.PCC_FINGERPRINT ?? '/tmp/pcc-deployment-fingerprint.json';
const MODE = process.argv.includes('--verify') ? 'verify' : 'write';

let pass = 0;
const failures = [];
const check = (ok, name, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
};

if (!EMAIL || !PASSWORD) {
  console.log('PCC_ADMIN_EMAIL and PCC_ADMIN_PASSWORD are required. Refusing to report a pass.');
  process.exit(1);
}

const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

function browser() {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (res) => {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(raw)) jar.delete(name);
      else jar.set(name, value);
    }
  };
  return {
    jar,
    async go(path) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie: cookie() }, redirect: 'manual' });
      absorb(res);
      const body = res.status >= 300 && res.status < 400 ? '' : await res.text();
      return { status: res.status, location: res.headers.get('location'), body };
    },
    async signIn(email, password) {
      const res = await fetch(`${BASE}/api/auth/sign-in`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }), redirect: 'manual',
      });
      absorb(res);
      return { status: res.status };
    },
    // Same no-JavaScript form posting the operability suite uses: a browser
    // with one bar in a basement is the environment this has to work in.
    async submit(path, needle, fields) {
      const page = await this.go(path);
      const forms = [...page.body.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
      const form = forms.find((f) => f.includes(needle));
      if (!form) {
        const seen = [...page.body.matchAll(/<button[^>]*>([^<]{2,40})</g)].map((m) => m[1].trim());
        throw new Error(`no form containing "${needle}" on ${path} (status ${page.status}); buttons: ${seen.join(' | ')}`);
      }
      const provided = new Set(fields.map(([n]) => n));
      const decode = (v) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const parts = [];
      for (const m of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
        const name = /name="([^"]*)"/.exec(m[0])?.[1];
        const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? '';
        if (name && !provided.has(decode(name))) parts.push([decode(name), decode(value)]);
      }
      for (const m of form.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
        const name = decode(m[1]);
        if (provided.has(name)) continue;
        const options = [...m[2].matchAll(/<option[^>]*value="([^"]*)"[^>]*>/g)]
          .filter((o) => !/disabled/.test(o[0])).map((o) => decode(o[1])).filter((v) => v !== '');
        if (options.length) parts.push([name, options[0]]);
      }
      const boundary = '----pccdeployment41';
      let body = '';
      for (const [name, value] of [...parts, ...fields]) {
        body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
      }
      body += `--${boundary}--\r\n`;
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { cookie: cookie(), 'content-type': `multipart/form-data; boundary=${boundary}` },
        body, redirect: 'manual',
      });
      absorb(res);
      const t = res.status >= 300 && res.status < 400 ? '' : await res.text();
      return { status: res.status, location: res.headers.get('location'), body: t };
    },
  };
}

// ===========================================================================
console.log(`\n--- the deployed application answers (${MODE}) --------------------`);

const health = await fetch(`${BASE}/api/health`).then((r) => r.json().then((b) => ({ status: r.status, body: b })));
check(health.status === 200, 'the health endpoint reports healthy', `status ${health.status}`);
check(health.body?.checks?.database?.ok === true, 'and says the database can be read');
check(health.body?.checks?.environment?.ok === true, 'and that the configuration loaded');
// A health endpoint is public. It must describe state, never contents.
const healthText = JSON.stringify(health.body);
check(!/\/data\/|sqlite|password|secret|key"/i.test(healthText.replace(/"authProvider"|"persistence"/g, '')),
  'and leaks no path, credential or key', healthText.slice(0, 200));

// ===========================================================================
console.log('\n--- the shipped image contains no accounts anybody else knows ---');

// THE DEFECT THIS GUARDS. The pilot seed creates ten users, including an
// administrator, all with a password written in this repository. Running it in
// production meant anyone who could reach the URL was an administrator.
for (const demo of ['admin@example.invalid', 'mike@example.invalid', 'rick@example.invalid']) {
  const attempt = browser();
  const res = await attempt.signIn(demo, 'Purchasing!2026');
  check(res.status !== 200, `the published demo account ${demo} cannot sign in`, `status ${res.status}`);
}

const admin = browser();
const signedIn = await admin.signIn(EMAIL, PASSWORD);
if (!check(signedIn.status === 200, 'the configured administrator signs in', `status ${signedIn.status}`)) {
  console.log(`\ndeployment checks: ${pass} passed, ${failures.length} failed`);
  process.exit(1);
}

// ===========================================================================
if (MODE === 'write') {
  console.log('\n--- the office sets its own PO sequence -------------------------');

  const adminPage = await admin.go('/admin?module=settings');
  check(adminPage.status === 200, 'administration opens');
  check(/affects every purchase order|cannot be undone|only move forward/i.test(text(adminPage.body)),
    'the PO numbering panel warns what changing the sequence does');

  // A number nobody would reach by accident, so finding it after a restart
  // proves the setting persisted rather than that a default happens to match.
  const START = 60250;
  const saved = await admin.submit('/admin?module=settings', 'Save PO numbering', [
    ['prefix', 'LE-'], ['padding', '5'], ['suffix', ''], ['nextValue', String(START)],
  ]);
  check(saved.status >= 200 && saved.status < 400, 'the next number can be set', `status ${saved.status}`);

  const confirmed = await admin.go('/admin?module=settings');
  check(confirmed.body.includes(String(START)), 'and the administration screen shows it');

  // WINDING IT BACK MUST BE REFUSED. Re-issuing a number a vendor already has
  // on an invoice is the failure this rule exists for.
  const backwards = await admin.submit('/admin?module=settings', 'Save PO numbering', [
    ['prefix', 'LE-'], ['padding', '5'], ['suffix', ''], ['nextValue', String(START - 100)],
  ]);
  const afterBackwards = await admin.go('/admin?module=settings');
  check(afterBackwards.body.includes(String(START)),
    'winding the sequence backwards is refused — issued numbers are permanent',
    `status ${backwards.status}`);

  console.log('\n--- and real purchasing data goes in ----------------------------');

  const vendorRes = await admin.submit('/admin?module=vendors', 'Add vendor', [
    ['name', 'Deployment Test Supply Co'],
    ['accountNumber', 'DEP-0001'],
    ['phone', '(914) 555-0199'],
    ['address', '1 Test Way'],
    ['contactName', 'A Contact'],
    ['contactEmail', 'orders@example.invalid'],
    ['contactPhone', '(914) 555-0198'],
  ]);
  check(vendorRes.status >= 200 && vendorRes.status < 400, 'a vendor can be added', `status ${vendorRes.status}`);

  const jobRes = await admin.submit('/admin?module=jobs', 'Add job', [
    ['jobNumber', '26-001'],
    ['name', 'Deployment proving job'],
    ['siteAddress', '1 Test Way'],
  ]);
  check(jobRes.status >= 200 && jobRes.status < 400, 'a job can be added', `status ${jobRes.status}`);

  const request = await admin.submit('/requests/new', 'Submit to workshop', [
    ['jobNumber', '26-001'],
    ['needByDate', new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)],
    ['needByTime', '08:00'],
    ['deliveryMethod', 'DELIVERY'],
    ['itemDescription', 'Deployment proving item — 12/2 MC cable'],
    ['itemQty', '10'],
    ['itemUnit', 'EA'],
    ['reason', 'Proving the deployed application.'],
    ['submit', 'now'],
  ]);
  const requestId = /\/requests\/([\w-]+)/.exec(request.location ?? '')?.[1] ?? null;
  check(Boolean(requestId), 'a request can be raised', `status ${request.status} -> ${request.location ?? 'no redirect'}`);

  let poNumber = null;
  if (requestId) {
    const review = await admin.go(`/requests/${requestId}/review`);
    const vendorId = /<option value="([0-9a-f-]{36})"/.exec(review.body)?.[1] ?? '';
    const approved = await admin.submit(`/requests/${requestId}/review`, 'Approve and print PO', [
      ['lineUsableStock', '4'], ['lineFinalOrderQty', '6'],
      ['lineVendorId', vendorId], ['lineUnitCost', '3.25'],
      ['notes', 'Deployment proving run.'],
    ]);
    check((approved.location ?? '').includes('/po'), 'and approved into a printable PO',
      `status ${approved.status} -> ${approved.location ?? 'no redirect'}`);

    const po = await admin.go(`/requests/${requestId}/po`);
    poNumber = /LE-\d+/.exec(text(po.body))?.[0] ?? null;
    check(poNumber === `LE-${START}`, 'the PO number comes from the sequence the office set',
      `got ${poNumber}, expected LE-${START}`);
  }

  writeFileSync(FINGERPRINT, JSON.stringify({ requestId, poNumber, start: START, vendor: 'Deployment Test Supply Co', job: '26-001' }, null, 2));
  console.log(`\n(fingerprint written to ${FINGERPRINT})`);
}

// ===========================================================================
if (MODE === 'verify') {
  console.log('\n--- and every one of those facts survived -----------------------');

  let expected;
  try {
    expected = JSON.parse(readFileSync(FINGERPRINT, 'utf8'));
  } catch {
    check(false, `the write pass left a fingerprint at ${FINGERPRINT}`);
    console.log(`\ndeployment checks: ${pass} passed, ${failures.length} failed`);
    process.exit(1);
  }

  const detail = await admin.go(`/requests/${expected.requestId}`);
  check(detail.status === 200, 'the purchase order raised before the restart still opens', `status ${detail.status}`);
  const body = text(detail.body);
  check(body.includes(expected.poNumber), `it still carries ${expected.poNumber}`);
  check(/Deployment proving item/.test(body), 'with the item that was ordered');
  check(/Deployment Test Supply Co/.test(body), 'and the vendor that was chosen');
  check(!/Nothing recorded yet/.test(body), 'and its history');

  const vendors = await admin.go('/vendors');
  check(vendors.body.includes(expected.vendor), 'the vendor added before the restart is still there');

  const jobs = await admin.go('/jobs');
  check(jobs.body.includes(expected.job), 'and the job');

  // THE SEQUENCE MUST HAVE MOVED ON, not reset. A restart that rewound it
  // would re-issue a number that is already on a vendor's desk.
  const adminPage = await admin.go('/admin?module=settings');
  check(adminPage.body.includes(String(expected.start + 1)),
    `the PO sequence continued at ${expected.start + 1} rather than resetting`);
}

console.log('');
console.log(`deployment checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
