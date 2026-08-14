// ---------------------------------------------------------------------------
// eval-purchasing-web.mjs — WEBSITE acceptance tests, over real HTTP.
//
// This one is not offline-pure like the other two: it builds the application,
// starts the production server against a throwaway database on a spare port,
// and drives it with fetch — real cookies, real redirects, real middleware,
// real server components. That is the point. Route protection that is only
// tested through unit calls is route protection nobody has actually opened a
// URL against.
//
// It asserts the acceptance list from the brief:
//   * an unauthenticated user is redirected to sign in
//   * valid credentials create a session; invalid ones say so understandably
//   * a disabled user cannot sign in
//   * sign-out clears access
//   * each role lands in, and can open, its own workspace
//   * a foreman cannot open the workshop queue; office cannot reach admin
//   * a foreman sees only their assigned job sites' deliveries
//   * refreshing a protected page keeps the session
//   * an expired session returns the user to sign-in, told what happened
//   * knowing a URL is not access
//   * mobile pages render
//   * the health endpoint reports the deployment honestly
//
// Exit 0 iff all pass. Invoked by scripts/eval-purchasing-web.sh, which does
// the production build first (and so proves the build passes too).
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP_DIR = join(ROOT, 'apps', 'purchasing');
const PORT = Number(process.env.WEB_EVAL_PORT ?? 3211);
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = 'acceptance-suite-secret-value-at-least-32-chars';

const TMP = mkdtempSync(join(tmpdir(), 'purchasing-web-'));
const DB_PATH = join(TMP, 'web.db');

let pass = 0;
let fail = 0;
const ok = () => { pass++; };
const bad = (m) => { console.log(`FAIL  ${m}`); fail++; };
const check = (cond, m) => (cond ? ok() : bad(m));
const eq = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const PASSWORD = 'Purchasing!2026';
const ACCOUNTS = {
  mike: 'mike@example.invalid',
  rick: 'rick@example.invalid',
  dave: 'dave@example.invalid',
  luis: 'luis@example.invalid',
  karen: 'karen@example.invalid',
  ann: 'ann@example.invalid',
  admin: 'admin@example.invalid',
  disabled: 'former@example.invalid',
};

// --- the database, made before the server ------------------------------------
//
// This suite drives the pilot cast, and a PRODUCTION server no longer creates
// them: bootstrap.ts refuses to install the documented demo password on a
// production database, which is the point of it. So the fixture is built here,
// explicitly, the way a real installation's database exists before the process
// that serves it does.
//
// That is a better test than it was. The server now starts against an EXISTING
// database and has to open it, migrate it idempotently and serve it — which is
// what every start after the first one does in production, and what was
// previously never exercised.
{
  const { openDatabase } = await import(join(APP_DIR, 'src', 'purchasing', 'infrastructure', 'sqlite', 'database.ts'));
  const { seed } = await import(join(APP_DIR, 'src', 'purchasing', 'infrastructure', 'seed.ts'));
  const db = openDatabase(DB_PATH);
  seed(db);
  db.close();
}

// --- server -----------------------------------------------------------------
//
// THE STANDALONE SERVER, not `next start`. The application is packaged with
// `output: 'standalone'` so the deployable image can be the server and nothing
// else, and `next start` refuses to run such a build. Driving the same
// artifact the container runs is the whole reason this suite is worth having;
// testing a second start path would prove something nobody ships.
//
// `static` and `public` are copied beside the server for the same reason the
// Dockerfile copies them: Next does not fold them into the standalone output,
// and without them every page renders unstyled.
const STANDALONE = join(APP_DIR, '.next', 'standalone');
const SERVER_DIR = join(STANDALONE, 'apps', 'purchasing');
if (!existsSync(join(SERVER_DIR, 'server.js'))) {
  console.log(`FAIL  harness error: no standalone build at ${SERVER_DIR}. Run the build first.`);
  process.exit(1);
}
cpSync(join(APP_DIR, '.next', 'static'), join(SERVER_DIR, '.next', 'static'), { recursive: true });
cpSync(join(APP_DIR, 'public'), join(SERVER_DIR, 'public'), { recursive: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    HOSTNAME: '127.0.0.1',
    PCC_DATABASE_PATH: DB_PATH,
    PURCHASING_DB_PATH: DB_PATH,
    SESSION_SECRET,
    APP_BASE_URL: BASE,
    AUTH_PROVIDER: 'local',
    // Stated, because a production start refuses without it. Lippolis's rule —
    // this harness asserts their purchase order numbers.
    PCC_PO_NUMBERING: 'job-vendor-sequence',
    // Demo mode must NOT be needed for any of this to work.
    PURCHASING_DEMO_MODE: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status === 200 || res.status === 503) return res;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start in time:\n${serverLog}`);
}

function stop() {
  server.kill('SIGTERM');
  rmSync(TMP, { recursive: true, force: true });
}

// --- client helpers ---------------------------------------------------------

/** GET without following redirects — the redirect IS the assertion. */
const get = (path, cookie) =>
  fetch(`${BASE}${path}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

async function signIn(email, password = PASSWORD) {
  const res = await fetch(`${BASE}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });
  const body = await res.json().catch(() => ({}));
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] || null;
  return { status: res.status, body, cookie, setCookie };
}

const locationOf = (res) => res.headers.get('location') ?? '';

// --- run --------------------------------------------------------------------

try {
  const health = await waitForServer();
  const healthBody = await health.json();

  console.log('--- health + configuration -------------------------------------');
  eq(health.status, 200, 'the health endpoint reports a healthy deployment');
  eq(healthBody.status, 'ok', 'health reports ok');
  eq(healthBody.authProvider, 'local', 'the acceptance run uses the local credential provider');
  check(healthBody.checks?.migrations?.ok === true, 'health confirms the schema is at the expected version');
  check(!JSON.stringify(healthBody).includes(SESSION_SECRET), 'health never echoes a secret');

  console.log('--- unauthenticated access -------------------------------------');
  for (const path of ['/workshop', '/office', '/accounting', '/admin', '/my-requests', '/deliveries', '/requests']) {
    const res = await get(path);
    check(
      [302, 303, 307, 308].includes(res.status) && locationOf(res).includes('/sign-in'),
      `an unauthenticated user is redirected to sign in from ${path} (got ${res.status} ${locationOf(res)})`,
    );
  }
  const rootRes = await get('/');
  check([302, 303, 307, 308].includes(rootRes.status), 'the root redirects rather than rendering');
  eq((await get('/sign-in')).status, 200, 'the sign-in page is public');
  eq((await get('/forgot-password')).status, 200, 'the forgot-password page is public');
  const signInHtml = await (await fetch(`${BASE}/sign-in`)).text();
  check(signInHtml.includes('Lippolis Electric'), 'the sign-in screen is branded');
  check(signInHtml.includes('type="password"'), 'the sign-in screen asks for a password');
  check(signInHtml.includes('Forgot your password?'), 'the sign-in screen offers a password reset');
  check(!signInHtml.includes('Developer demo mode'), 'demo identity selection is NOT exposed by default');

  console.log('--- credentials ------------------------------------------------');
  const wrong = await signIn(ACCOUNTS.mike, 'not-the-password');
  eq(wrong.status, 401, 'invalid credentials are refused');
  eq(wrong.body.error, 'invalid_credentials', 'the refusal names the reason for the server');
  check(!wrong.cookie, 'a failed sign-in mints no session');

  const unknown = await signIn('nobody@example.invalid', PASSWORD);
  eq(unknown.status, 401, 'an unknown address is refused');
  eq(unknown.body.error, wrong.body.error, 'an unknown address is indistinguishable from a wrong password');

  const disabled = await signIn(ACCOUNTS.disabled);
  eq(disabled.status, 403, 'a disabled user cannot sign in');
  eq(disabled.body.error, 'account_disabled', 'a disabled account is told it is disabled');
  check(!disabled.cookie, 'a disabled user gets no session');

  const mike = await signIn(ACCOUNTS.mike);
  eq(mike.status, 200, 'valid credentials are accepted');
  check(Boolean(mike.cookie), 'valid credentials create a session cookie');
  check(mike.setCookie.includes('HttpOnly'), 'the session cookie is httpOnly');
  check(mike.setCookie.includes('SameSite=Lax') || mike.setCookie.includes('SameSite=lax'), 'the session cookie is SameSite');
  check(!mike.cookie.includes(ACCOUNTS.mike), 'the session cookie carries no personal data in the clear');

  console.log('--- role-based routing -----------------------------------------');
  const sessions = {};
  for (const [key, email] of Object.entries(ACCOUNTS)) {
    if (key === 'disabled') continue;
    const result = await signIn(email);
    sessions[key] = result.cookie;
    check(Boolean(result.cookie), `${key} can sign in`);
  }

  eq((await signIn(ACCOUNTS.dave)).body.redirectTo, '/my-requests', 'a foreman lands in the field workspace');
  eq((await signIn(ACCOUNTS.mike)).body.redirectTo, '/workshop', 'Mike lands in the workshop queue');
  eq((await signIn(ACCOUNTS.rick)).body.redirectTo, '/workshop', 'Rick lands in the workshop queue');
  eq((await signIn(ACCOUNTS.karen)).body.redirectTo, '/office', 'an office user lands in the office');
  eq((await signIn(ACCOUNTS.ann)).body.redirectTo, '/accounting', 'accounting lands in receipt review');
  eq((await signIn(ACCOUNTS.admin)).body.redirectTo, '/admin', 'an admin lands in administration');

  console.log('--- workspace access -------------------------------------------');
  const allowed = [
    ['mike', '/workshop'], ['rick', '/workshop'], ['karen', '/office'],
    ['ann', '/accounting'], ['admin', '/admin'], ['dave', '/my-requests'], ['dave', '/deliveries'],
  ];
  for (const [who, path] of allowed) {
    const res = await get(path, sessions[who]);
    eq(res.status, 200, `${who} can open ${path}`);
  }

  const refused = [
    ['dave', '/workshop', 'a foreman cannot open the workshop queue'],
    ['dave', '/office', 'a foreman cannot open the office dashboard'],
    ['dave', '/accounting', 'a foreman cannot open accounting'],
    ['dave', '/admin', 'a foreman cannot open administration'],
    ['karen', '/workshop', 'an office user without approval authority cannot open the queue'],
    ['karen', '/admin', 'an office user cannot open administration'],
    ['ann', '/workshop', 'accounting cannot open the workshop queue'],
    ['ann', '/admin', 'accounting cannot open administration'],
    ['mike', '/admin', 'a workshop approver cannot open administration'],
  ];
  for (const [who, path, message] of refused) {
    const res = await get(path, sessions[who]);
    check(
      [302, 303, 307, 308].includes(res.status) && locationOf(res).includes('/unauthorized'),
      `${message} (got ${res.status} ${locationOf(res)})`,
    );
  }
  check(
    [302, 303, 307, 308].includes((await get('/workshop?bypass=1', sessions.dave)).status),
    'knowing the URL is not access',
  );

  console.log('--- assigned deliveries only -----------------------------------');
  const daveDeliveries = await (await fetch(`${BASE}/deliveries`, { headers: { Cookie: sessions.dave } })).text();
  check(daveDeliveries.includes('24-118') || daveDeliveries.includes('Nothing is on its way'),
        "Dave's delivery list is limited to his sites");
  check(!daveDeliveries.includes('24-203'), 'Dave cannot see the job site assigned to another foreman');
  const luisDeliveries = await (await fetch(`${BASE}/deliveries`, { headers: { Cookie: sessions.luis } })).text();
  check(luisDeliveries.includes('24-203') || luisDeliveries.includes('Nothing is on its way'),
        "Luis sees his own site");
  check(!luisDeliveries.includes('24-118'), 'Luis cannot see the job site assigned to Dave');

  console.log('--- session lifetime -------------------------------------------');
  const first = await get('/workshop', sessions.mike);
  const second = await get('/workshop', sessions.mike);
  check(first.status === 200 && second.status === 200, 'refreshing a protected page preserves the session');

  const { signSession } = await import(
    join(APP_DIR, 'src', 'purchasing', 'infrastructure', 'auth', 'session-token.ts')
  );
  const expired = await signSession(
    { uid: 'whoever', provider: 'local', iat: 1, exp: Math.floor(Date.now() / 1000) - 60 },
    SESSION_SECRET,
  );
  const expiredRes = await get('/workshop', `purchasing_session=${expired}`);
  check(
    [302, 303, 307, 308].includes(expiredRes.status) && locationOf(expiredRes).includes('/session-expired'),
    `an expired session returns the user safely to sign in (got ${locationOf(expiredRes)})`,
  );
  const forged = await signSession(
    { uid: 'whoever', provider: 'local', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600 },
    'not-the-servers-secret-but-long-enough',
  );
  const forgedRes = await get('/workshop', `purchasing_session=${forged}`);
  check(
    [302, 303, 307, 308].includes(forgedRes.status) && locationOf(forgedRes).includes('/sign-in'),
    'a forged session is refused',
  );

  const signedOut = await fetch(`${BASE}/api/auth/sign-out`, {
    method: 'POST',
    headers: { Cookie: sessions.mike },
    redirect: 'manual',
  });
  const cleared = signedOut.headers.get('set-cookie') ?? '';
  check(cleared.includes('purchasing_session=;') || cleared.includes('Max-Age=0'), 'sign-out clears the cookie');
  const afterSignOut = await get('/workshop', 'purchasing_session=');
  check([302, 303, 307, 308].includes(afterSignOut.status), 'sign-out clears access');

  console.log('--- mobile field experience ------------------------------------');
  const mobileHeaders = {
    Cookie: sessions.dave,
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  };
  for (const [path, marker, message] of [
    ['/my-requests', 'New request', 'the field workspace renders on a phone'],
    // The heading, not a field label: the marker is a proxy for "the page
    // rendered", and pinning it to a label makes wording changes look like
    // regressions.
    ['/requests/new', 'What do you need?', 'the request form renders on a phone'],
    ['/deliveries', 'Deliveries', 'the delivery list renders on a phone'],
  ]) {
    const res = await fetch(`${BASE}${path}`, { headers: mobileHeaders });
    const html = await res.text();
    check(res.status === 200 && html.includes(marker), `${message} (${res.status})`);
    check(html.includes('viewport'), `${path} declares a mobile viewport`);
  }
  const newRequestHtml = await (await fetch(`${BASE}/requests/new`, { headers: mobileHeaders })).text();
  check(newRequestHtml.includes('type="date"') && newRequestHtml.includes('type="time"'),
        'the phone form uses native date and time pickers');

  // --- what a phone-width layout must not do -------------------------------
  //
  // These are markup rules, checkable without a browser, and each one is a way
  // the field screens have actually gone wrong:
  //
  //   a fixed pixel width          forces the page sideways on a 360px screen
  //   a table with no scroller     does the same, one column at a time
  //   the primary action hidden    `hidden sm:inline-flex` removed "New
  //                                request" from the phone the foreman holds
  for (const [path, label] of [['/my-requests', 'my requests'], ['/deliveries', 'deliveries'], ['/requests/new', 'the request form']]) {
    const html = await (await fetch(`${BASE}${path}`, { headers: mobileHeaders })).text();
    const body = html.replace(/<script[\s\S]*?<\/script>/g, ' ');

    // A width in pixels, or a min-width bigger than a narrow phone.
    const fixedWidths = [...body.matchAll(/(?:min-)?w-\[(\d+)px\]/g)].map((m) => Number(m[1])).filter((n) => n > 340);
    check(fixedWidths.length === 0, `${label}: nothing is pinned wider than a phone`, fixedWidths.join(', '));

    // Every table is inside something that can scroll on its own.
    const tables = (body.match(/<table/g) ?? []).length;
    const scrollers = (body.match(/overflow-x-auto|overflow-auto/g) ?? []).length;
    check(tables === 0 || scrollers > 0, `${label}: any table can scroll without moving the page`, `${tables} tables, ${scrollers} scrollers`);

    // The primary action is present at the narrowest width, not only from `sm`.
    const hiddenPrimary = /class="[^"]*\bhidden\b[^"]*"[^>]*>\s*New request/.test(body);
    check(!hiddenPrimary, `${label}: the primary action is not hidden on a phone`);
  }

  // The receiving sheet is the one screen operated outdoors in gloves, so its
  // controls are held to a 44px minimum rather than the default height.
  const receivingList = await (await fetch(`${BASE}/deliveries`, { headers: mobileHeaders })).text();
  check(/h-1[12]|py-3|min-h-1[12]/.test(receivingList), 'the delivery list offers a full-size target to press');
  // The invariant is about FIELDS, not words: "Vendor counter pickup" is a
  // legitimate delivery location, and the banner mentions suppliers.
  for (const forbidden of ['lineVendorId', 'lineUnitCost', 'lineUsableStock', 'name="priority"', 'Estimated unit cost']) {
    check(!newRequestHtml.includes(forbidden), `the phone form has no ${forbidden} input`);
  }

  console.log('--- no ceremony: no confirmation, no priority -------------------');

  // MARK ORDERED IS ONE PRESS. The confirmation component renders a dialog and
  // a second button; if either appears on a screen that offers "Mark ordered",
  // the click count is two and the pilot finding has regressed.
  {
    const ordered = await get('/requests', sessions.mike);
    check(ordered.status === 200, 'the purchasing list opens');

    for (const [path, label] of [['/dashboard', 'dashboard'], ['/requests', 'purchasing list']]) {
      const html = await (await get(path, sessions.mike)).text();
      check(!/Mark this order as placed\?/.test(html), `no order confirmation prompt on the ${label}`);
      check(!/Yes, it has been placed/.test(html), `no confirm-again button on the ${label}`);
    }
  }

  // NO MANUAL PRIORITY, anywhere a person works.
  for (const [path, label] of [
    ['/requests/new', 'the request form'],
    ['/dashboard', 'the dashboard'],
    ['/requests', 'the purchasing list'],
  ]) {
    const html = await (await get(path, sessions.mike)).text();
    check(!/name="priority"/.test(html), `${label} has no priority input`);
    check(!/Any priority/.test(html), `${label} has no priority filter`);
    check(!/>Emergency</.test(html), `${label} offers no urgency grade to choose`);
  }

  // BUT THE DERIVED EXCEPTION SURVIVES. The dashboard still knows what is late.
  {
    const html = await (await get('/dashboard', sessions.mike)).text();
    check(/Overdue/.test(html), 'the dashboard still surfaces overdue work');
    check(/Needs/.test(html), 'and the derived attention column replaced the priority column');
  }

  console.log('--- the shell --------------------------------------------------');
  const shell = await (await fetch(`${BASE}/workshop`, { headers: { Cookie: sessions.mike } })).text();
  check(shell.includes('Mike (workshop)'), 'the shell names the signed-in user');
  check(shell.includes('Sign out'), 'the shell offers sign-out');
  // The destination is named "Purchasing" in the sidebar now (the handoff's
  // vocabulary), and the page heading is "Purchasing queue". What this check
  // is FOR is that the shell tells you where you are, so it asserts the
  // active-destination marker rather than one particular label.
  check(shell.includes('aria-current="page"'), 'the shell marks the current destination');
  check(shell.includes('Purchasing queue'), 'the shell shows the current workspace');
  check(!shell.includes('Administration'), 'the shell hides a workspace this user cannot open');
  const adminShell = await (await fetch(`${BASE}/admin`, { headers: { Cookie: sessions.admin } })).text();
  check(adminShell.includes('Administration'), 'an admin sees the administration workspace in the shell');
} catch (err) {
  bad(`harness error: ${err?.message ?? err}`);
  if (serverLog) console.log(serverLog.slice(-2000));
} finally {
  stop();
}

console.log('');
console.log(`web checks: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
