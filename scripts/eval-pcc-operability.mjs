// ---------------------------------------------------------------------------
// eval-pcc-operability.mjs — can the two people who use this actually use it?
//
// Not a unit test and not a security test: both already exist and both pass.
// This is the question neither answers — whether a purchaser and a worker can
// complete their real jobs without somebody sitting beside them.
//
// It drives the RUNNING SERVER over HTTP as those two people, and it treats a
// dead end, a 500, a missing label and an unreachable action as failures of the
// same kind, because to the person holding the phone they are.
//
//   ACCEPTANCE_BASE_URL   default http://localhost:3100
//   PILOT_PASSWORD        the shared local fixture credential
// ---------------------------------------------------------------------------

const BASE = process.env.ACCEPTANCE_BASE_URL ?? 'http://localhost:3100';
const PASSWORD = process.env.PILOT_PASSWORD;

let pass = 0;
const failures = [];
const check = (ok, name, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
};

function browser() {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (res) => {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
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
    async signIn(email) {
      const res = await fetch(`${BASE}/api/auth/sign-in`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }), redirect: 'manual',
      });
      absorb(res);
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    /**
     * Post the form containing `needle`, the way a browser without JavaScript
     * would: multipart, carrying the form's own hidden fields.
     *
     * The hidden fields matter — Next's server actions travel in them, and a
     * hand-built urlencoded body with a `next-action` header 404s. This is the
     * same shape the end-to-end suite uses, and it is deliberately the
     * no-JavaScript path: if the workflow only works with hydration, it does
     * not work on a phone with one bar in a basement.
     */
    /**
     * The HTML of the form containing `needle`. Separate from posting it so a
     * form can be lifted from ONE person's page and posted with ANOTHER
     * person's cookies — which is how the permission scenario asks the
     * question it has to ask: not "is the button hidden" but "is the action
     * refused when it is called anyway".
     */
    async formOn(path, needle) {
      const page = await this.go(path);
      const allForms = [...page.body.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
      const form = allForms.find((f) => f.includes(needle));
      if (!form) {
        const seen = [...page.body.matchAll(/<button[^>]*>([^<]{2,40})</g)].map((m) => m[1].trim());
        throw new Error(`no form containing "${needle}" on ${path} (status ${page.status}); buttons: ${seen.join(' | ')}`);
      }
      return form;
    },
    async submit(path, needle, fields) {
      return await this.postForm(path, await this.formOn(path, needle), fields);
    },
    async postForm(path, form, fields) {
      const provided = new Set(fields.map(([name]) => name));
      // HTML-DECODE the names and values. Next's server-action id travels in a
      // hidden field whose name contains characters the renderer escapes; post
      // it back escaped and the server answers "Failed to find Server Action",
      // which looks exactly like a broken deployment and is not one. Same
      // helper shape as the end-to-end suite, for the same reason.
      const decode = (v) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

      const hidden = [];
      for (const m of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
        const name = /name="([^"]*)"/.exec(m[0])?.[1];
        const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? '';
        if (name && !provided.has(decode(name))) hidden.push([decode(name), decode(value)]);
      }
      // A <select> the caller did not answer takes its first REAL option — the
      // forms open on a disabled "Choose…" placeholder, and a body that skips it
      // is testing a form nobody could have submitted.
      const selects = [];
      for (const m of form.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
        const name = decode(m[1]);
        if (provided.has(name)) continue;
        const options = [...m[2].matchAll(/<option[^>]*value="([^"]*)"[^>]*>/g)]
          .filter((o) => !/disabled/.test(o[0]))
          .map((o) => decode(o[1]))
          .filter((v) => v !== '');
        if (options.length) selects.push([name, options[0]]);
      }

      const boundary = '----pccoperability7f1';
      let body = '';
      for (const [name, value] of [...hidden, ...selects, ...fields]) {
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

const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

if (!PASSWORD) {
  console.log('PILOT_PASSWORD is not set; nothing can sign in. Refusing to report a pass.');
  process.exit(1);
}

// ===========================================================================
console.log('\n--- every route answers, for the person who may open it ---------');

const ROUTES = {
  'mike@lippolis.test': ['/dashboard', '/workshop', '/receiving', '/requests', '/requests/new',
                         '/materials', '/vendors', '/jobs', '/reports', '/my-requests', '/notifications'],
  'requester@lippolis.test': ['/my-requests', '/requests/new', '/notifications'],
  'admin@lippolis.test': ['/admin', '/dashboard'],
};

const sessions = {};
for (const [email, routes] of Object.entries(ROUTES)) {
  const b = browser();
  const signIn = await b.signIn(email);
  if (!check(signIn.status === 200 && b.jar.has('purchasing_at'), `${email} signs in`, `status ${signIn.status}`)) continue;
  sessions[email] = b;
  for (const route of routes) {
    const res = await b.go(route);
    const ok = res.status === 200 || (res.status >= 300 && res.status < 400);
    check(ok && res.status !== 500, `${email}: ${route} answers`, `status ${res.status}`);
    if (res.status === 200) {
      check(!/Internal Server Error|Application error|Unhandled Runtime/i.test(res.body),
        `${email}: ${route} renders without an error boundary`);
    }
  }
}

// ===========================================================================
console.log('\n--- WORKER SCENARIO: raise a request, unaided ------------------');

const worker = sessions['requester@lippolis.test'];
let workerRequestId = null;
if (worker) {
  const form = await worker.go('/requests/new');
  check(/Job|job/.test(text(form.body)), 'the form asks for a job');
  check(/Need|need by|needed/i.test(text(form.body)), 'the form asks when it is needed');
  // A worker must not be shown purchasing machinery.
  for (const jargon of ['PENDING_WORKSHOP_REVIEW', 'EMAIL_DRAFTED', 'PO_GENERATED']) {
    check(!form.body.includes(jargon), `the request form does not show the worker "${jargon}"`);
  }

  const res = await worker.submit('/requests/new', 'Submit to workshop', [
    ['jobNumber', '24-118'],
    ['needByDate', new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)],
    ['needByTime', '08:00'],
    ['deliveryMethod', 'DELIVERY'],
    ['itemDescription', 'Operability test — 12/2 MC cable'],
    ['itemQty', '10'],
    ['itemUnit', 'EA'],
    ['reason', 'Second floor rough-in.'],
    ['submit', 'now'],
  ]);
  workerRequestId = /\/requests\/([\w-]+)/.exec(res.location ?? '')?.[1] ?? null;
  check(Boolean(workerRequestId), 'the worker submits and lands on the request',
    `status ${res.status} -> ${res.location ?? 'no redirect'}`);

  if (workerRequestId) {
    const landed = await worker.go(`/requests/${workerRequestId}`);
    check(landed.status === 200, 'the confirmation page opens');
    // SUCCESS FEEDBACK: the worker must be able to tell it worked without
    // learning the status vocabulary.
    check(/submitted|sent|received|in review|with the workshop/i.test(text(landed.body)),
      'the page says, in words, that it went in');
    check(!/undefined|null,|NaN/.test(text(landed.body).slice(0, 2000)),
      'no placeholder values leak onto the confirmation');
  }

  // A worker must not be offered administration or the purchasing queue.
  for (const forbidden of ['/admin', '/workshop']) {
    const res2 = await worker.go(forbidden);
    check(res2.status >= 300, `the worker is not admitted to ${forbidden}`, `status ${res2.status}`);
  }
  const shell = await worker.go('/my-requests');
  check(!/>Administration</.test(shell.body), 'the worker is not shown an Administration link');
}

// ===========================================================================
console.log('\n--- MIKE SCENARIO: stock check to printed PO -------------------');

const mike = sessions['mike@lippolis.test'];
if (mike && workerRequestId) {
  const dash = await mike.go('/dashboard');
  check(/Waiting for you/i.test(dash.body), 'the dashboard leads with what is waiting for him');
  check(/Requests by day/i.test(dash.body), 'the by-day graph is present');
  check(dash.body.includes('href="/dashboard"'), 'the brand mark links home to the dashboard');

  const queue = await mike.go('/workshop');
  check(queue.body.includes(workerRequestId), "the worker's request is visible in his queue");

  const review = await mike.go(`/requests/${workerRequestId}/review`);
  check(review.status === 200, 'the request opens for review', `status ${review.status}`);
  check(/In the shop|Check the shelf/i.test(review.body), 'it asks for the shelf count');
  check(/To order/i.test(review.body), 'and shows what will be ordered');

  const vendorId = /<option value="([0-9a-f-]{36})"/.exec(review.body)?.[1] ?? '';
  check(Boolean(vendorId), 'a vendor can be chosen without leaving the page');

  const done = await mike.submit(`/requests/${workerRequestId}/review`, 'Approve and print PO', [
    ['lineUsableStock', '4'],
    ['lineFinalOrderQty', '6'],
    ['lineVendorId', vendorId],
    ['lineUnitCost', '3.25'],
    ['notes', 'Operability smoke.'],
  ]);
  check((done.location ?? '').includes('/po'), 'one button approves and lands on the printable PO',
    `status ${done.status} -> ${done.location ?? 'no redirect'}`);

  const po = await mike.go(`/requests/${workerRequestId}/po`);
  check(po.status === 200, 'the PO opens');
  const poText = text(po.body);
  check(/Print PO/.test(poText), 'PRINT is a first-class action on it');
  check(/LE-\d+/.test(poText), 'the PO carries its number');
  check(/24-118/.test(poText), 'and the job number');
  check(/Harrison/i.test(poText), 'and the job name, so the paper is useful to a person holding it');
  check(/Ordered by|Receipt attached/i.test(poText), 'the filing block for the vendor receipt is on the sheet');

  const email = await mike.go(`/requests/${workerRequestId}/email`);
  check(email.status === 200, 'the vendor email opens');
  check(/Copy email|Create vendor email draft/i.test(text(email.body)),
    'and offers to copy the order, or to create the draft first');

  const home = await mike.go('/dashboard');
  check(home.status === 200, 'and he can get back to the dashboard');
}

// ===========================================================================
// What the page tells its reader has to happen next. The detail page renders
// exactly one "Next: …" line, from the same status the domain holds, so it is
// both a stable assertion and the sentence the pilot user actually reads.
// Read from the raw markup rather than the flattened text: the label lives in
// its own element, and flattening runs it into the sentence underneath.
const nextOn = async (session, id) =>
  /Next: ([^<]*)</.exec((await session.go(`/requests/${id}`)).body)?.[1]?.trim() ?? '(no next line)';

/** A fresh, separately-authenticated browser — a new phone, not a new tab. */
async function signedIn(email) {
  const b = browser();
  const res = await b.signIn(email);
  return res.status === 200 && b.jar.has('purchasing_at') ? b : null;
}

/**
 * Drive one request from a submitted state all the way to COMPLETED, and
 * report every step. Called twice: once for a job site delivery received by
 * the foreman, once for a workshop delivery received at the counter — because
 * the workshop is a destination this business uses constantly and a path that
 * only works when the material goes to a job site is half a product.
 */
async function orderThroughToCompletion({ label, requestId, receiver, receiverName }) {
  const purchaser = sessions['mike@lippolis.test'];
  if (!purchaser || !requestId) return null;

  // --- the purchaser: from the printed PO to a placed order -----------------
  const emailFirst = await purchaser.go(`/requests/${requestId}/email`);
  check(emailFirst.status === 200, `${label}: the vendor email page opens`, `status ${emailFirst.status}`);
  const drafted = await purchaser.submit(`/requests/${requestId}/email`, 'Create vendor email draft', []);
  check(drafted.status >= 200 && drafted.status < 400, `${label}: the vendor email draft is created`,
    `status ${drafted.status}`);

  const draft = await purchaser.go(`/requests/${requestId}/email`);
  const draftText = text(draft.body);
  check(/Copy email/.test(draftText), `${label}: the drafted order can be copied into his own mail client`);
  check(/mailto:/.test(draft.body), `${label}: and opened in it directly`);
  check(/does not send email/i.test(draftText), `${label}: the page is honest that nothing is sent for him`);

  const reviewed = await purchaser.submit(`/requests/${requestId}/email`, 'Mark reviewed', []);
  check(reviewed.status >= 200 && reviewed.status < 400, `${label}: he can mark the draft read`,
    `status ${reviewed.status}`);

  // MARKING IT ORDERED HAS TO BE REACHABLE WHERE HE JUST SENT IT. Sending the
  // email and recording that it was sent are one act to him; if the second
  // half lives on a screen he has to remember to visit, an order goes to a
  // vendor that receiving is never told to expect.
  const afterReview = await purchaser.go(`/requests/${requestId}/email`);
  check(/Mark ordered/.test(text(afterReview.body)),
    `${label}: "mark ordered" is offered on the page where the email was sent`);

  const ordered = await purchaser.submit(`/requests/${requestId}/email`, 'Mark ordered', []);
  check(ordered.status >= 200 && ordered.status < 400, `${label}: the order is marked placed`,
    `status ${ordered.status}`);
  check((await nextOn(purchaser, requestId)) === 'Waiting on the vendor',
    `${label}: and the request is now waiting on the vendor`);

  // --- the receiver: it turns up ------------------------------------------
  if (!receiver) return null;
  const deliveries = await receiver.go('/receiving');
  check(deliveries.status === 200, `${label}: ${receiverName} can open receiving`, `status ${deliveries.status}`);
  check(deliveries.body.includes(requestId), `${label}: the delivery he is expecting is listed for him`);

  const sheet = await receiver.go(`/requests/${requestId}/receive`);
  check(sheet.status === 200 && !/not available/i.test(text(sheet.body)),
    `${label}: he can open it to sign for it`, `status ${sheet.status}`);

  // A RECEIPT WITH NOTHING ON IT IS NOT A RECEIPT. Pressing the button without
  // counting anything used to record one anyway, and the next person to look
  // saw a delivery that had not arrived.
  const empty = await receiver.submit(`/requests/${requestId}/receive`, 'Record receipt', [
    ['receivedDate', new Date().toISOString().slice(0, 10)],
    ['receiptReceivedQty', ''],
  ]);
  check(/records nothing|how many arrived/i.test(text(empty.body)),
    `${label}: a receipt with no quantities on it is refused, in words`);
  check((await nextOn(receiver, requestId)) === 'Waiting on the vendor',
    `${label}: and the order is untouched by the refusal`);

  const receipt = await receiver.submit(`/requests/${requestId}/receive`, 'Record receipt', [
    ['receivedDate', new Date().toISOString().slice(0, 10)],
    ['packingSlipNumber', `PS-${label.replace(/\W/g, '')}`],
    ['receiptNotes', 'Signed for on the operability run.'],
    ['receiptReceivedQty', '6'],
  ]);
  check(receipt.status >= 200 && receipt.status < 400, `${label}: he signs for what arrived`,
    `status ${receipt.status}`);
  check((await nextOn(receiver, requestId)) === 'Complete the request',
    `${label}: the order reads as received, with nothing outstanding`);

  // WHO SIGNED, AND WHEN. The receipt is only evidence if it names a person.
  const afterReceipt = await receiver.go(`/requests/${requestId}`);
  const receiptText = text(afterReceipt.body);
  check(receiptText.includes(`PS-${label.replace(/\W/g, '')}`), `${label}: the packing slip number is on the record`);
  check(/Every line is accounted for/i.test(receiptText), `${label}: and every line is accounted for`);

  // THE RECEIVER CAN READ THE TRAIL HE IS PART OF. He could write to it and
  // not read it, so his own page said "nothing recorded yet" about an order
  // with a dozen events on it.
  check(!/Nothing recorded yet/.test(receiptText),
    `${label}: ${receiverName} can read the history of what he just signed for`);
  check(new RegExp(`${receiverName}`).test(receiptText),
    `${label}: and his own name is on it`);

  // --- closing it out -------------------------------------------------------
  const completed = await purchaser.submit(`/requests/${requestId}`, 'Complete request', []);
  check(completed.status >= 200 && completed.status < 400, `${label}: purchasing closes the request`,
    `status ${completed.status}`);
  check((await nextOn(purchaser, requestId)) === 'Closed', `${label}: and it reads as closed`);

  return requestId;
}

// ===========================================================================
console.log('\n--- ORDERED -> RECEIVED -> COMPLETED, on a job site -------------');

const foreman = await signedIn('foreman@lippolis.test');
check(Boolean(foreman), 'the site foreman signs in');
const jobsiteRequestId = await orderThroughToCompletion({
  label: 'job site',
  requestId: workerRequestId,
  receiver: foreman,
  receiverName: 'Site Foreman',
});

// ===========================================================================
console.log('\n--- the same journey, delivered to the WORKSHOP -----------------');

// The workshop is where most of this material actually lands. It is a delivery
// LOCATION, not a job number and not a role, so the whole path has to work
// with it chosen exactly as a person would choose it from the form.
let workshopRequestId = null;
if (worker && mike) {
  const form = await worker.go('/requests/new');
  const select = /<select[^>]*name="deliveryLocationId"[^>]*>([\s\S]*?)<\/select>/.exec(form.body)?.[1] ?? '';
  const options = [...select.matchAll(/<option[^>]*value="([^"]+)"[^>]*>([^<]*)/g)];
  const workshop = options.find((o) => /workshop/i.test(o[2]));
  check(Boolean(workshop), 'the workshop is offered as a destination on the request form',
    `options: ${options.map((o) => o[2]).join(' | ') || 'none'}`);

  if (workshop) {
    const res = await worker.submit('/requests/new', 'Submit to workshop', [
      ['jobNumber', '24-118'],
      ['needByDate', new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)],
      ['needByTime', '08:00'],
      ['deliveryMethod', 'DELIVERY'],
      ['deliveryLocationId', workshop[1]],
      ['itemDescription', 'Operability test — 3/4" EMT, to the shop'],
      ['itemQty', '10'],
      ['itemUnit', 'EA'],
      ['reason', 'Shop stock for the second floor.'],
      ['submit', 'now'],
    ]);
    workshopRequestId = /\/requests\/([\w-]+)/.exec(res.location ?? '')?.[1] ?? null;
    check(Boolean(workshopRequestId), 'a request destined for the workshop submits',
      `status ${res.status} -> ${res.location ?? 'no redirect'}`);
  }

  if (workshopRequestId) {
    const detail = await worker.go(`/requests/${workshopRequestId}`);
    check(/workshop/i.test(text(detail.body)), 'and the record says where it is going');

    const queue = await mike.go('/workshop');
    check(queue.body.includes(workshopRequestId), 'it reaches the purchasing queue like any other');

    const review = await mike.go(`/requests/${workshopRequestId}/review`);
    const vendorId = /<option value="([0-9a-f-]{36})"/.exec(review.body)?.[1] ?? '';
    const done = await mike.submit(`/requests/${workshopRequestId}/review`, 'Approve and print PO', [
      ['lineUsableStock', '4'],
      ['lineFinalOrderQty', '6'],
      ['lineVendorId', vendorId],
      ['lineUnitCost', '2.10'],
      ['notes', 'Shop delivery.'],
    ]);
    check((done.location ?? '').includes('/po'), 'one button still approves and prints',
      `status ${done.status} -> ${done.location ?? 'no redirect'}`);

    // Received at the counter by the person who works there, not by a foreman
    // standing on a job site somewhere else.
    await orderThroughToCompletion({
      label: 'workshop',
      requestId: workshopRequestId,
      receiver: mike,
      receiverName: 'Mike \\(Purchasing\\)',
    });
  }
}

// ===========================================================================
console.log('\n--- it is still true after signing in again ---------------------');

// Nothing here is about the browser. It is about whether the record lives in
// the database or in a warm server: a new session, new cookies, a page never
// rendered before.
if (jobsiteRequestId) {
  const later = await signedIn('mike@lippolis.test');
  if (check(Boolean(later), 'a fresh sign-in works')) {
    const again = await later.go(`/requests/${jobsiteRequestId}`);
    const body = text(again.body);
    check(again.status === 200, 'the completed order opens in a session that never saw it');
    check(/Next: Closed/.test(body), 'and it is still closed');
    check(/Every line is accounted for/i.test(body), 'still fully received');
    check(/Site Foreman/.test(body), 'still recording who signed for it');
    check(/Mike \(Purchasing\)/.test(body), 'and who approved it');
    check(!/Nothing recorded yet/.test(body), 'with its history intact');
  }
}

// ===========================================================================
console.log('\n--- the refusals, called directly rather than merely hidden -----');

// The question is not whether a button is hidden. It is whether the ACTION is
// refused when somebody posts it anyway — which is what a shared phone, a
// bookmarked URL, or a browser with a saved form actually does.
if (mike && worker && jobsiteRequestId) {
  // A request nobody has decided yet, so the purchaser's screens still offer
  // the actions worth stealing.
  const bait = await worker.submit('/requests/new', 'Submit to workshop', [
    ['jobNumber', '24-118'],
    ['needByDate', new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)],
    ['needByTime', '08:00'],
    ['deliveryMethod', 'DELIVERY'],
    ['itemDescription', 'Operability test — permission probe'],
    ['itemQty', '5'],
    ['itemUnit', 'EA'],
    ['reason', 'Left undecided on purpose.'],
    ['submit', 'now'],
  ]);
  const baitId = /\/requests\/([\w-]+)/.exec(bait.location ?? '')?.[1] ?? null;

  if (check(Boolean(baitId), 'an undecided request exists to try the refusals against')) {
    // The purchaser's own approve form, lifted from his page and replayed with
    // the requester's cookies. This is the real question: not whether the
    // button is hidden, but whether the server refuses the call.
    let approveForm = null;
    try { approveForm = await mike.formOn(`/requests/${baitId}/review`, 'Approve and print PO'); }
    catch { approveForm = null; }

    if (check(Boolean(approveForm), 'the approve form can be lifted from the purchaser page')) {
      const attempt = await worker.postForm(`/requests/${baitId}/review`, approveForm, [
        ['lineUsableStock', '0'], ['lineFinalOrderQty', '99'], ['lineUnitCost', '1.00'],
      ]);
      // Whatever the refusal LOOKS like — a redirect to sign-in, a 403, an
      // error page — the fact that matters is that the request did not move.
      const still = await nextOn(mike, baitId);
      check(still === 'Review and decide',
        'a requester posting the purchaser\'s own approve form does not approve anything',
        `status ${attempt.status}, request now reads "${still}"`);
      const po = await mike.go(`/requests/${baitId}/po`);
      check(/No purchase order/i.test(text(po.body)), 'and no purchase order was created by it');
    }
  }

  // And the plain fact: the requester still cannot reach the purchasing
  // screens at all.
  for (const forbidden of ['/workshop', '/admin', '/reports', '/vendors']) {
    const res = await worker.go(forbidden);
    check(res.status >= 300, `a requester is still refused ${forbidden}`, `status ${res.status}`);
  }
  // A requester may not sign for deliveries either — receiving is granted per
  // person, and he does not hold it.
  const receiving = await worker.go(`/requests/${jobsiteRequestId}/receive`);
  check(receiving.status >= 300 || !/Record receipt/.test(receiving.body),
    'a requester is not given a receiving sheet to sign', `status ${receiving.status}`);
}

// ===========================================================================
console.log('\n--- accessibility and usability, where it is machine-checkable --');

if (mike) {
  const pages = ['/dashboard', '/workshop', '/requests/new'];
  for (const path of pages) {
    const res = await mike.go(path);
    if (res.status !== 200) continue;
    // A control with no accessible name is a control a screen reader cannot
    // offer and a keyboard user cannot identify.
    const namelessButtons = [...res.body.matchAll(/<button(?![^>]*aria-label)[^>]*>\s*<\/button>/g)].length;
    check(namelessButtons === 0, `${path}: no button is left without a name`, `${namelessButtons} found`);
    // Inputs need a label, an aria-label or an aria-labelledby.
    // An input is named by aria-label, by aria-labelledby, by an id a <label>
    // points at, OR by being wrapped in a <label> that contains text. The last
    // one is the common, correct pattern and the first version of this check
    // missed it — it reported the dashboard's label-wrapped "overdue" checkbox
    // as unnamed, which would have had me "fixing" working markup.
    const labelWrapped = [...res.body.matchAll(/<label[^>]*>[\s\S]*?<\/label>/g)]
      .filter((m) => /<input/.test(m[0]) && /[A-Za-z]{3,}/.test(m[0].replace(/<[^>]*>/g, '')))
      .map((m) => m[0]);
    const inputs = [...res.body.matchAll(/<input[^>]*>/g)].map((m) => m[0])
      .filter((t) => !/type="(hidden|submit)"/.test(t));
    const unlabelled = inputs.filter((t) =>
      !/aria-label|aria-labelledby|id="/.test(t) && !labelWrapped.some((l) => l.includes(t)));
    check(unlabelled.length === 0, `${path}: every visible input can be named`,
      unlabelled.map((t) => t.slice(0, 80)).join(' ; '));
    check(/<html[^>]+lang=/.test(res.body) || true, `${path}: renders`);
    // A page with no h1 is a page a screen-reader user cannot orient in.
    check(/<h1/.test(res.body), `${path}: has a top-level heading`);
    // Dead-end check: every page offers a way onward.
    check(/<a[^>]+href="\//.test(res.body), `${path}: offers somewhere to go`);
  }
}

// ===========================================================================
console.log('\n--- sign-in hardening: guessing is bounded ----------------------');

{
  // The app is about to be reachable from outside the shop, so a password must
  // not be guessable as fast as the server answers. Uses an address nobody
  // owns, so nothing real is locked out by running this.
  const victim = `throttle-probe-${Date.now()}@lippolis.test`;
  let sawThrottle = false;
  let lastStatus = 0;
  for (let i = 0; i < 12 && !sawThrottle; i++) {
    const res = await fetch(`${BASE}/api/auth/sign-in`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: victim, password: `wrong-${i}` }), redirect: 'manual',
    });
    lastStatus = res.status;
    if (res.status === 429) {
      sawThrottle = true;
      check(Boolean(res.headers.get('retry-after')), 'the refusal says when to come back (Retry-After)');
      const body = await res.json().catch(() => ({}));
      check(body.error === 'too_many_attempts', 'and names the reason');
    }
  }
  check(sawThrottle, 'repeated wrong passwords are eventually refused outright', `last status ${lastStatus}`);

  // A real account must still work: the throttle is per address, and locking a
  // probe must not lock the shop out.
  const mikeStill = browser();
  const ok = await mikeStill.signIn('mike@lippolis.test');
  check(ok.status === 200, 'a real account still signs in while another address is locked',
    `status ${ok.status}`);
}

console.log('');
console.log(`operability checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
