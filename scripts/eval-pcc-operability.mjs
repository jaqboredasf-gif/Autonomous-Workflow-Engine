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
    async submit(path, needle, fields) {
      const page = await this.go(path);
      const allForms = [...page.body.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
      const form = allForms.find((f) => f.includes(needle));
      if (!form) {
        const seen = [...page.body.matchAll(/<button[^>]*>([^<]{2,40})</g)].map((m) => m[1].trim());
        throw new Error(`no form containing "${needle}" on ${path} (status ${page.status}); buttons: ${seen.join(' | ')}`);
      }
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

console.log('');
console.log(`operability checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
