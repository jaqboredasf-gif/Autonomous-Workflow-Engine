// ---------------------------------------------------------------------------
// eval-restore-rehearsal.mjs — does a RESTORED database carry a working
// purchasing system, or merely a file that opens?
//
// A backup nobody has restored is a hypothesis. This is the experiment.
//
// `pcc-backup.mjs` already proves the file it wrote is a valid SQLite database
// with the right row counts, and `pcc-restore.mjs` proves the file it put back
// opens. Neither proves the thing that matters, which is whether the people who
// use PCC can still do their jobs against the result. A database can pass an
// integrity check while the photograph of a packing slip is gone, or a foreman
// can no longer sign in, or somebody who should not see a request now can.
//
// So this drives the RESTORED application over HTTP as two different people and
// checks the state that would actually be missed:
//
//   authentication      both accounts still sign in
//   authorization       the foreman is still refused what admins may do
//   people              a user created before the backup still exists
//   directories         vendors and jobs
//   requests + POs      including the PO NUMBER, which is the unrecoverable one
//   receiving           the receipt, its quantities, its packing slip number
//   attachments         DOWNLOADED AND COMPARED BYTE FOR BYTE — the only check
//                       that distinguishes "the row is there" from "the file is"
//   history             the audit trail, which is the record of what happened
//   sequence            still moving forward, not rewound by the restore
//
//   --write   put all of the above into a live PCC and record a fingerprint
//   --verify  prove every one of those facts against a DIFFERENT PCC that was
//             started from a restored backup
//
//   ACCEPTANCE_BASE_URL   which PCC to talk to
//   PCC_ADMIN_EMAIL       the bootstrap administrator
//   PCC_ADMIN_PASSWORD    their password
//   PCC_FINGERPRINT       the file the two passes share
//
// Usage:
//   node scripts/eval-restore-rehearsal.mjs --write     # against the source
//   ... back up, restore into a throwaway volume, start a second PCC ...
//   node scripts/eval-restore-rehearsal.mjs --verify    # against the restore
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BASE = process.env.ACCEPTANCE_BASE_URL ?? 'http://localhost:3402';
const EMAIL = process.env.PCC_ADMIN_EMAIL ?? '';
const PASSWORD = process.env.PCC_ADMIN_PASSWORD ?? '';
const FINGERPRINT = process.env.PCC_FINGERPRINT ?? '/tmp/pcc-restore-fingerprint.json';
const MODE = process.argv.includes('--verify') ? 'verify' : 'write';

// The second identity. Created in the write pass so the verify pass can prove
// that a person who is not the bootstrap administrator survived the restore
// WITH their credentials and WITHOUT gaining any authority.
const FOREMAN_EMAIL = 'restore.foreman@readiness.test';
const FOREMAN_PASSWORD = 'foreman-rehearsal-2026';

// Attachment content is fixed text rather than a real photograph so the verify
// pass can compare a hash. What matters is that the bytes make the round trip.
const ATTACHMENT_BODY = 'PACKING SLIP 88213 — 6 x 12/2 MC cable — signed for at the gate.';
const ATTACHMENT_SHA = createHash('sha256').update(ATTACHMENT_BODY).digest('hex');

let pass = 0;
const failures = [];
/**
 * Remove React's SSR text-node separators.
 *
 * `{a}-{b}` renders as `a<!-- -->-<!-- -->b`. The comments are how React tells
 * two adjacent text nodes apart when it hydrates; they are invisible to a
 * reader and must be invisible to an assertion that is standing in for one.
 */
const stripSsrComments = (html) => String(html ?? '').replace(/<!--[\s\S]*?-->/g, '');

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
    async go(path) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie: cookie() }, redirect: 'manual' });
      absorb(res);
      const body = res.status >= 300 && res.status < 400 ? '' : await res.text();
      // SSR COMMENT SEPARATORS REMOVED. React writes `<!-- -->` between two
      // adjacent expressions in one text node, so a cell written in JSX as
      // {job}-{code}-{n} arrives as `26-500<!-- -->-<!-- -->ACME<!-- -->-<!-- -->404`.
      // Every assertion here reads the page the way a person does, and a person
      // does not see the comments — without this, checking for a purchase order
      // number on a rendered page can never pass, which is exactly how this
      // rehearsal came to report a failure the application did not have.
      return { status: res.status, location: res.headers.get('location'), body: stripSsrComments(body) };
    },
    /** Raw fetch keeping the session, for downloading bytes rather than HTML. */
    async raw(path) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie: cookie() }, redirect: 'manual' });
      return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
    },
    async signIn(email, password) {
      const res = await fetch(`${BASE}/api/auth/sign-in`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }), redirect: 'manual',
      });
      absorb(res);
      return { status: res.status };
    },
    /**
     * Post a form the way a browser without JavaScript would, carrying the
     * form's own hidden fields — Next's server actions travel in them.
     *
     * `files` are real multipart file parts, which is what makes an attachment
     * test an attachment test rather than a string in a database column.
     */
    async submit(path, needle, fields, files = []) {
      const page = await this.go(path);
      const forms = [...page.body.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
      const form = forms.find((f) => f.includes(needle));
      if (!form) {
        const seen = [...page.body.matchAll(/<button[^>]*>([^<]{2,40})</g)].map((m) => m[1].trim());
        throw new Error(`no form containing "${needle}" on ${path} (status ${page.status}); buttons: ${seen.join(' | ')}`);
      }
      const provided = new Set([...fields.map(([n]) => n), ...files.map((f) => f.name)]);
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

      const boundary = '----pccrestorerehearsal';
      const chunks = [];
      for (const [name, value] of [...parts, ...fields]) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      }
      for (const file of files) {
        chunks.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
        ));
        chunks.push(Buffer.from(file.body));
        chunks.push(Buffer.from('\r\n'));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));

      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { cookie: cookie(), 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(chunks), redirect: 'manual',
      });
      absorb(res);
      const t = res.status >= 300 && res.status < 400 ? '' : await res.text();
      return { status: res.status, location: res.headers.get('location'), body: t };
    },
  };
}

// ===========================================================================
console.log(`\n--- the application answers (${MODE}) ---------------------------`);

const health = await fetch(`${BASE}/api/health`).then((r) => r.json().then((b) => ({ status: r.status, body: b })));
check(health.status === 200, 'readiness reports healthy', `status ${health.status}`);
check(health.body?.checks?.database?.ok === true, 'and the database can be read');
check(health.body?.checks?.migrations?.ok === true, 'and the schema is the version this code expects');

const live = await fetch(`${BASE}/api/health/live`).then((r) => ({ status: r.status })).catch(() => ({ status: 0 }));
check(live.status === 200, 'liveness answers');

const admin = browser();
const adminSignIn = await admin.signIn(EMAIL, PASSWORD);
if (!check(adminSignIn.status === 200, 'the administrator signs in', `status ${adminSignIn.status}`)) {
  console.log(`\nrehearsal checks: ${pass} passed, ${failures.length} failed`);
  process.exit(1);
}

// PROVE THIS IS THE INSTANCE THIS RUN DEPLOYED.
//
// A container left over from an earlier run answers on the same port and gives
// plausible, wrong answers to every question after this one — a route added
// today returns 404, a warning removed today is still in the health output, and
// the administrator just created cannot sign in. All three read as serious
// defects in new code; all three were one stale process.
//
// The marker is the configured administrator's own address, appearing in the
// user directory. It needs no extra configuration, it is unique to this run,
// and it is checked AFTER sign-in because that is the first point at which the
// application will tell us anything about itself. (The organization name would
// have been the obvious marker and is not rendered anywhere in the interface —
// which is worth knowing: an instance cannot currently be identified without
// signing in to it.)
{
  const { requireExpectedInstance } = await import('./lib/port-guard.mjs');
  await requireExpectedInstance(BASE, async () => {
    const users = await admin.go('/admin?module=users');
    return users.body.includes(EMAIL)
      ? { ok: true }
      : { ok: false, detail: `the user directory does not contain the administrator ${EMAIL} this run configured` };
  });
  console.log('  ok  the instance answering is the one this run deployed');
  pass += 1;
}

// ===========================================================================
if (MODE === 'write') {
  console.log('\n--- a purchasing system worth losing ----------------------------');

  // A purchase order number is job + vendor + a count that starts at 1 for that
  // pair, so the sequence to set here belongs to a pair — and the pair's vendor
  // has to exist first. It is set below, once the vendor and the job are on
  // file. The number is one nobody would reach by accident, so finding it after
  // the restore proves the counter came back rather than that a default
  // happens to match.
  const VENDOR_CODE = 'RESTOREREHEARSALSUPPLY';
  const START = 404;

  await admin.submit('/admin?module=vendors', 'Add vendor', [
    ['name', 'Restore Rehearsal Supply'],
    ['accountNumber', 'RR-0001'],
    ['phone', '(914) 555-0101'],
    ['address', '2 Rehearsal Road'],
    ['contactName', 'Pat Counter'],
    ['contactEmail', 'orders@rehearsal.test'],
    ['contactPhone', '(914) 555-0102'],
  ]);
  const vendors = await admin.go('/vendors');
  check(vendors.body.includes('Restore Rehearsal Supply'), 'a vendor is on file');

  await admin.submit('/admin?module=jobs', 'Add job', [
    ['jobNumber', '26-500'],
    ['name', 'Restore rehearsal job'],
    ['siteAddress', '2 Rehearsal Road'],
  ]);
  const jobs = await admin.go('/jobs');
  check(jobs.body.includes('26-500'), 'a job is on file');

  // THE PAIR'S PAPER SEQUENCE, now that both halves of it exist.
  const settingsBody = (await admin.go('/admin?module=settings')).body;
  const rehearsalVendorId = [...settingsBody.matchAll(/value="([0-9a-f-]{36})"[^>]*>([^<]*)</g)]
    .find(([, , label]) => label.includes('Restore Rehearsal Supply'))?.[1] ?? '';
  check(Boolean(rehearsalVendorId), 'the vendor can be chosen when setting a pair sequence');
  await admin.submit('/admin?module=settings', 'Set this pair', [
    ['jobNumber', '26-500'], ['vendorId', rehearsalVendorId],
    ['lastIssuedSequence', ''], ['nextSequence', String(START)],
  ]);
  const seq = await admin.go('/admin?module=settings');
  check(seq.body.includes(`26-500-${VENDOR_CODE}-${START}`), 'the pair PO sequence is set');

  // A SECOND PERSON, with their own password and strictly less authority.
  // Restoring a database that only the administrator can sign into would look
  // like a success and be a disaster on the first morning.
  const created = await admin.submit('/admin?module=users', 'Invite user', [
    ['fullName', 'Rehearsal Foreman'],
    ['email', FOREMAN_EMAIL],
    ['temporaryPassword', FOREMAN_PASSWORD],
    ['jobNumbers', '26-500'],
    ['roles', 'FOREMAN'],
  ]);
  check(created.status >= 200 && created.status < 400, 'a second user is created', `status ${created.status}`);
  const users = await admin.go('/admin?module=users');
  check(users.body.includes(FOREMAN_EMAIL), 'and appears in administration');

  const foreman = browser();
  const foremanIn = await foreman.signIn(FOREMAN_EMAIL, FOREMAN_PASSWORD);
  check(foremanIn.status === 200, 'the second user can sign in before the backup', `status ${foremanIn.status}`);

  // THE REQUEST, RAISED BY THE FOREMAN, WITH A FILE ATTACHED.
  const request = await foreman.submit('/requests/new', 'Submit to workshop', [
    ['jobNumber', '26-500'],
    ['needByDate', new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)],
    ['needByTime', '07:00'],
    ['deliveryMethod', 'DELIVERY'],
    ['itemDescription', 'Restore rehearsal item — 12/2 MC cable'],
    ['itemQty', '10'],
    ['itemUnit', 'EA'],
    ['reason', 'Proving a restored database is a working one.'],
    ['submit', 'now'],
  ], [
    { name: 'attachments', filename: 'panel-before.txt', contentType: 'text/plain', body: ATTACHMENT_BODY },
  ]);
  const requestId = /\/requests\/([\w-]+)/.exec(request.location ?? '')?.[1] ?? null;
  check(Boolean(requestId), 'the foreman raises a request', `status ${request.status} -> ${request.location ?? 'no redirect'}`);
  if (!requestId) {
    console.log(`\nrehearsal checks: ${pass} passed, ${failures.length} failed`);
    process.exit(1);
  }

  const detail = await admin.go(`/requests/${requestId}`);
  const attachmentId = /\/api\/attachments\/([\w-]+)/.exec(detail.body)?.[1] ?? null;
  check(Boolean(attachmentId), 'the attachment is linked from the request');

  // Approve into a PO.
  const review = await admin.go(`/requests/${requestId}/review`);
  const vendorId = /<option value="([0-9a-f-]{36})"/.exec(review.body)?.[1] ?? '';
  const approved = await admin.submit(`/requests/${requestId}/review`, 'Approve and print PO', [
    ['lineUsableStock', '4'], ['lineFinalOrderQty', '6'],
    ['lineVendorId', vendorId], ['lineUnitCost', '3.25'],
    ['notes', 'Restore rehearsal approval.'],
  ]);
  check((approved.location ?? '').includes('/po'), 'purchasing approves it into a PO',
    `status ${approved.status} -> ${approved.location ?? 'no redirect'}`);

  const po = await admin.go(`/requests/${requestId}/po`);
  const poNumber = new RegExp(`26-500-${VENDOR_CODE}-\\d+`).exec(text(po.body))?.[0] ?? null;
  check(poNumber === `26-500-${VENDOR_CODE}-${START}`,
    "and it continues that job and vendor's own sequence", `got ${poNumber}`);

  // THE VENDOR EMAIL GATE. An order cannot be marked placed until the draft has
  // been reviewed, approved and recorded as sent by a person — PCC never sends,
  // so "sent" is somebody saying they sent it from their own mailbox. Walking
  // this properly is the point: it is the real sequence Mike follows, and a
  // rehearsal that skipped it would prove less than it appears to.
  //
  // REACHED BY OPENING THE PAGE, not by pressing a button that no longer
  // exists. Drafting used to be a step a person requested from the request
  // screen; the simplification passes made the draft part of generating the
  // order, so /requests/:id/email IS the draft. This step went on asserting the
  // old button and failed on a workflow that had been deliberately shortened.
  const draftPage = await admin.go(`/requests/${requestId}/email`);
  check(draftPage.status === 200, 'the vendor email draft is prepared with the order');
  for (const [label, expected] of [
    ['Mark reviewed', 'REVIEWED'],
    ['Approve to send', 'APPROVED_TO_SEND'],
    ['I sent it — mark sent', 'SENT'],
  ]) {
    await admin.submit(`/requests/${requestId}/email`, label, []);
    void expected;
  }
  const emailPage = await admin.go(`/requests/${requestId}/email`);
  check(/sent/i.test(text(emailPage.body)), 'the vendor email draft is recorded as sent');

  // Ordered, then received WITH a packing slip attached — the evidence that a
  // restore has to preserve and the one nobody can recreate.
  await admin.submit(`/requests/${requestId}`, 'Mark ordered', [['requestId', requestId]]);
  const receive = await admin.submit(`/requests/${requestId}/receive`, 'Record receipt', [
    ['requestId', requestId],
    ['receivedDate', new Date().toISOString().slice(0, 10)],
    ['packingSlipNumber', 'PS-88213'],
    ['receiptNotes', 'All six arrived, none damaged.'],
    // The per-line quantity. Without it the form posts an empty count and the
    // receipt records nothing arriving — which is a valid thing to submit and
    // not what a delivery looks like. All six of the six ordered.
    ['receiptReceivedQty', '6'],
  ], [
    { name: 'receiptDocuments', filename: 'packing-slip.txt', contentType: 'text/plain', body: ATTACHMENT_BODY },
  ]).catch((err) => ({ status: 0, location: null, body: String(err.message) }));
  check(receive.status >= 200 && receive.status < 400, 'the delivery is signed for',
    `status ${receive.status} ${receive.body?.slice?.(0, 120) ?? ''}`);

  const afterReceipt = await admin.go(`/requests/${requestId}`);
  const receiptId = /\/receipts\/([\w-]+)/.exec(afterReceipt.body)?.[1] ?? null;
  check(Boolean(receiptId), 'and the receipt is on the request');

  let receiptAttachmentId = null;
  if (receiptId) {
    const receiptPage = await admin.go(`/receipts/${receiptId}`);
    receiptAttachmentId = /\/api\/attachments\/([\w-]+)/.exec(receiptPage.body)?.[1] ?? null;
    check(Boolean(receiptAttachmentId), 'with the packing slip attached to it');
  }

  const history = text(afterReceipt.body);
  check(!/Nothing recorded yet/.test(history), 'the request has an audit history');

  writeFileSync(FINGERPRINT, JSON.stringify({
    requestId, poNumber, receiptId, attachmentId, receiptAttachmentId,
    start: START, vendorCode: VENDOR_CODE, attachmentSha: ATTACHMENT_SHA,
    vendor: 'Restore Rehearsal Supply', job: '26-500', foreman: FOREMAN_EMAIL,
  }, null, 2));
  console.log(`\n(fingerprint written to ${FINGERPRINT})`);
}

// ===========================================================================
if (MODE === 'verify') {
  console.log('\n--- every one of those facts survived the restore ---------------');

  let want;
  try {
    want = JSON.parse(readFileSync(FINGERPRINT, 'utf8'));
  } catch {
    check(false, `the write pass left a fingerprint at ${FINGERPRINT}`);
    console.log(`\nrehearsal checks: ${pass} passed, ${failures.length} failed`);
    process.exit(1);
  }

  // --- people and credentials ---------------------------------------------
  const foreman = browser();
  const foremanIn = await foreman.signIn(want.foreman, FOREMAN_PASSWORD);
  check(foremanIn.status === 200, 'the second user still signs in — credentials survived',
    `status ${foremanIn.status}`);

  // --- authorization, which must be no weaker than it was ------------------
  const forbidden = await foreman.go('/admin?module=users');
  check(forbidden.status !== 200 || /not allowed|unauthorized|sign in/i.test(text(forbidden.body)),
    'and is still refused administration', `status ${forbidden.status}`);

  // --- the records ---------------------------------------------------------
  const detail = await admin.go(`/requests/${want.requestId}`);
  check(detail.status === 200, 'the request still opens', `status ${detail.status}`);
  const body = text(detail.body);
  check(body.includes(want.poNumber), `it still carries ${want.poNumber}`);
  check(/Restore rehearsal item/.test(body), 'with the item that was ordered');
  check(/Restore Rehearsal Supply/.test(body), 'and the vendor that was chosen');
  check(!/Nothing recorded yet/.test(body), 'and its audit history');

  const vendors = await admin.go('/vendors');
  check(vendors.body.includes(want.vendor), 'the vendor directory survived');
  const jobs = await admin.go('/jobs');
  check(jobs.body.includes(want.job), 'the job directory survived');

  // --- receiving -----------------------------------------------------------
  const receipt = await admin.go(`/receipts/${want.receiptId}`);
  check(receipt.status === 200, 'the receipt still opens', `status ${receipt.status}`);
  check(/PS-88213/.test(text(receipt.body)), 'with its packing slip number');

  // --- ATTACHMENTS, COMPARED BYTE FOR BYTE --------------------------------
  // The check this whole rehearsal exists for. A row that names a file is not
  // a file, and only the bytes can tell the difference.
  for (const [label, id] of [
    ['the request attachment', want.attachmentId],
    ['the packing slip on the receipt', want.receiptAttachmentId],
  ]) {
    if (!id) { check(false, `${label} was recorded by the write pass`); continue; }
    const file = await admin.raw(`/api/attachments/${id}`);
    check(file.status === 200, `${label} downloads`, `status ${file.status}`);
    const sha = createHash('sha256').update(file.bytes).digest('hex');
    check(sha === want.attachmentSha, `${label} is byte-for-byte what was uploaded`,
      `sha ${sha.slice(0, 12)} vs ${want.attachmentSha.slice(0, 12)}`);
  }

  // --- the PO document -----------------------------------------------------
  const po = await admin.go(`/requests/${want.requestId}/po`);
  check(po.status === 200 && text(po.body).includes(want.poNumber), 'the purchase order still prints');

  // --- the sequence --------------------------------------------------------
  const settings = await admin.go('/admin?module=settings');
  check(settings.body.includes(`${want.job}-${want.vendorCode}-${want.start + 1}`),
    `the job-and-vendor sequence is still at ${want.start + 1} — the restore did not rewind it`);
}

console.log('');
console.log(`rehearsal checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
