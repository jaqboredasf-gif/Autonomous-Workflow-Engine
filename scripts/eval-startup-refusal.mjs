// ---------------------------------------------------------------------------
// eval-startup-refusal.mjs — does a MISCONFIGURED production start refuse, and
// does it refuse without writing anything?
//
// Every other suite here starts PCC correctly and asks whether it works. This
// one starts it WRONG on purpose, because the failure that hurts a company is
// not the one where the application stops. It is the one where it carries on.
//
// THE FAILURE THIS EXISTS FOR, precisely:
//
//   Jose types the data path with a typo, or forgets PCC_PO_NUMBERING, and
//   starts PCC. It creates a database at the wrong path, runs every migration,
//   creates the bootstrap administrator with the password still sitting in the
//   environment file, and answers /api/health with 200. Nothing errors. Mike
//   raises purchase orders into it for a fortnight. Then somebody notices the
//   real volume was never mounted, and the fortnight is in a file nobody backs
//   up — beside an administrator account whose password was in a variable Jose
//   was told to remove.
//
// So the assertion is in two halves and the SECOND half is the point:
//
//   1. the process exits non-zero                  — supervision sees it
//   2. NO DATABASE FILE EXISTS afterwards          — nothing was written
//
// A start that refuses after creating the database has already done the damage;
// it is only quieter about it. This is why apps/purchasing/src/instrumentation.ts
// checks configuration BEFORE opening the store, and this file is what holds
// that ordering in place — it is one `await` away from silently regressing, and
// the regression is invisible to every other suite in this repository.
//
// It also asserts the WORDING, which is not fussiness. The two refusals lead an
// operator to different places: "nothing has been written" means look at a
// variable, "the database was opened" means look at permissions and the volume.
// A refusal that says the wrong one sends Jose to the wrong half of the problem
// at seven in the morning.
//
// Runs the real standalone build over a real process boundary — no mocking of
// process.exit, no importing the instrumentation hook. What is asserted is what
// systemd and Docker actually observe.
//
//   node scripts/eval-startup-refusal.mjs
//
// Requires the standalone build (scripts/eval-startup-refusal.sh builds first).
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'apps', 'purchasing', '.next', 'standalone', 'apps', 'purchasing', 'server.js');

let pass = 0;
const failures = [];
const check = (ok, name, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
};

if (!existsSync(SERVER)) {
  console.error(`no standalone server at ${SERVER}`);
  console.error('Run: npm run build -w purchasing   (or use scripts/eval-startup-refusal.sh)');
  process.exit(1);
}

// A real secret for the cases where the secret is not what is wrong. Generated
// rather than a constant, so a case that accidentally passes because of a
// hard-coded value cannot.
const GOOD_SECRET = Array.from({ length: 48 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

/**
 * Start the packaged server with `env`, wait for it to exit, and report what
 * happened — including whether a database file appeared.
 *
 * A PORT NOBODY ELSE HAS, per case. These starts are expected to die before
 * they listen, but "expected to" is what is under test: a case that regresses
 * into starting successfully would otherwise collide with the previous case's
 * port and fail as a port conflict, which reads like a broken test rather than
 * the serious regression it is.
 *
 * A TIMEOUT IS A FAILURE, NOT A HANG. A refusal that never arrives is exactly
 * the bug this suite is looking for — a start that carried on — so the process
 * is killed and the case reports what it saw.
 */
function startAndWait(env, port) {
  const dir = mkdtempSync(join(tmpdir(), 'pcc-refusal-'));
  const dbPath = join(dir, 'pcc.sqlite');
  const child = spawn(process.execPath, [SERVER], {
    cwd: join(ROOT, 'apps', 'purchasing', '.next', 'standalone', 'apps', 'purchasing'),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(port),
      APP_BASE_URL: `http://127.0.0.1:${port}`,
      PCC_DATABASE_PATH: dbPath,
      PCC_ORG_NAME: 'Lippolis Electric, Inc.',
      PCC_ORG_ADDRESS: 'Licensed Electrical Contractor · 25 Seventh Street, Pelham, NY 10803',
      PCC_ORG_PHONE: '(914) 738-3550',
      // These cases drive 127.0.0.1 with no TLS, and a production start over
      // plain HTTP refuses unless the decision is stated. Stated here in the
      // BASE environment so every case below tests the one thing it names
      // rather than incidentally re-testing this rule. Its own case is
      // explicit, further down, and overrides this.
      PCC_ALLOW_INSECURE_HTTP: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (b) => { output += b; });
  child.stderr.on('data', (b) => { output += b; });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 'TIMEOUT', output, dbPath, dir, started: true });
    }, 45_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Read the file's existence BEFORE the directory is cleaned up, and after
      // the process is gone, so a database created late still counts.
      resolve({ code, output, dbPath, dir, dbCreated: existsSync(dbPath), started: false });
    });
  });
}

/**
 * One refusal case.
 *
 * `expectDbCreated` is stated per case rather than assumed, because the two
 * kinds of refusal genuinely differ: a bad variable must not open anything,
 * while a database that exists and cannot be USED has necessarily been opened.
 */
async function refuses({ name, env, port, expects, expectDbCreated = false, seedDb = false }) {
  console.log(`\n--- ${name} `.padEnd(64, '-'));
  const run = await startAndWait(env, port);

  if (run.code === 'TIMEOUT') {
    check(false, `${name}: refuses to start`, 'the process was still running after 45s — it did not refuse');
    rmSync(run.dir, { recursive: true, force: true });
    return;
  }

  check(run.code === 1, `${name}: exits 1`, `exit code was ${run.code}`);

  // THE HALF THAT MATTERS. systemd's RestartPreventExitStatus=1 and Docker's
  // restart policy both handle the exit; nothing but this notices the write.
  check(
    Boolean(run.dbCreated) === expectDbCreated,
    expectDbCreated
      ? `${name}: the database it could not use is still there, untouched`
      : `${name}: no database was created`,
    run.dbCreated ? 'a database file exists — the refusal came too late' : 'no file',
  );

  for (const expected of expects) {
    check(
      run.output.includes(expected),
      `${name}: the log says "${expected.length > 56 ? `${expected.slice(0, 56)}…` : expected}"`,
      `not found in:\n${run.output.split('\n').filter((l) => l.includes('[pcc]')).join('\n')}`,
    );
  }

  // NEVER THE PASSWORD. A refusal prints configuration problems, and the
  // bootstrap password is configuration. Docker logs and the journal are read
  // by more people than the environment file is.
  if (env.PCC_BOOTSTRAP_ADMIN_PASSWORD) {
    check(
      !run.output.includes(env.PCC_BOOTSTRAP_ADMIN_PASSWORD),
      `${name}: the bootstrap password is not printed in the log`,
    );
  }

  rmSync(run.dir, { recursive: true, force: true });
}

console.log('Starting PCC wrong, on purpose. Every case must refuse, and refuse before writing.');

// --- the configuration refusals --------------------------------------------
// All of these are decidable from the environment alone, so all of them must
// happen with nothing opened.

await refuses({
  name: 'no session secret',
  port: 3591,
  env: { PCC_PO_NUMBERING: 'job-vendor-sequence', PCC_DATABASE_ALLOW_CREATE: '1' },
  expects: ['SESSION_SECRET', 'Nothing has been written'],
});

await refuses({
  name: 'no numbering rule',
  port: 3592,
  env: { SESSION_SECRET: GOOD_SECRET, PCC_DATABASE_ALLOW_CREATE: '1' },
  expects: ['PCC_PO_NUMBERING', 'must state how it numbers purchase orders', 'Nothing has been written'],
});

// THE LETTERHEAD, AND THE ONLY MOMENT IT CAN BE SET. The address and telephone
// number print on every purchase order that reaches a supplier, they are read
// only when the organization row is created, and no screen edits them
// afterwards. A first start without them produced a company whose paperwork
// carried no address for the life of the installation — PCC came up, logged
// ready, reported healthy, and wrote nulls.
//
// expectDbCreated: the file exists by this point and holds SCHEMA AND ONLY
// SCHEMA. The refusal happens before the transaction that creates the
// organization, so setting the variables and starting again is a correct first
// start rather than a repair.
await refuses({
  name: 'no company address',
  port: 3597,
  env: {
    SESSION_SECRET: GOOD_SECRET, PCC_PO_NUMBERING: 'job-vendor-sequence',
    PCC_DATABASE_ALLOW_CREATE: '1', PCC_ORG_ADDRESS: '',
  },
  expectDbCreated: true,
  expects: ['PCC_ORG_ADDRESS', 'print on every purchase order', 'NOTHING HAS BEEN CREATED'],
});

await refuses({
  name: 'no company telephone number',
  port: 3598,
  env: {
    SESSION_SECRET: GOOD_SECRET, PCC_PO_NUMBERING: 'job-vendor-sequence',
    PCC_DATABASE_ALLOW_CREATE: '1', PCC_ORG_PHONE: '',
  },
  expectDbCreated: true,
  expects: ['PCC_ORG_PHONE', 'NOTHING HAS BEEN CREATED'],
});

// Both missing at once must name BOTH, not stop at the first. An operator who
// fixes one variable, restarts, and is refused again for the other has been
// sent round the loop by the report rather than by the configuration.
await refuses({
  name: 'neither address nor telephone number',
  port: 3599,
  env: {
    SESSION_SECRET: GOOD_SECRET, PCC_PO_NUMBERING: 'job-vendor-sequence',
    PCC_DATABASE_ALLOW_CREATE: '1', PCC_ORG_ADDRESS: '', PCC_ORG_PHONE: '',
  },
  expectDbCreated: true,
  expects: ['PCC_ORG_ADDRESS', 'PCC_ORG_PHONE', 'NOTHING HAS BEEN CREATED'],
});

// The rule is KNOWN and this build cannot perform it. Refused rather than
// approximated: a purchase order number cannot be withdrawn from a supplier.
await refuses({
  name: 'a numbering rule this build cannot perform',
  port: 3593,
  env: { SESSION_SECRET: GOOD_SECRET, PCC_PO_NUMBERING: 'vendor-sequence', PCC_DATABASE_ALLOW_CREATE: '1' },
  expects: ['vendor-sequence', 'not a numbering rule this build can perform', 'Nothing has been written'],
});

await refuses({
  name: 'demo identity selection in production',
  port: 3594,
  env: {
    SESSION_SECRET: GOOD_SECRET, PCC_PO_NUMBERING: 'job-vendor-sequence',
    PURCHASING_DEMO_MODE: '1', PCC_DATABASE_ALLOW_CREATE: '1',
  },
  expects: ['PURCHASING_DEMO_MODE', 'Nothing has been written'],
});

// AND THE ONE THAT PROVES THE ORDERING. A configuration error together with a
// perfectly valid first-install authorization: if configuration were checked
// after the database, this case would create the database, migrate it, create
// the administrator — and then refuse. It is the exact shape of the incident
// described at the top of this file.
await refuses({
  name: 'a bad variable on a FIRST install',
  port: 3595,
  env: {
    PCC_PO_NUMBERING: 'job-vendor-sequence',
    PCC_DATABASE_ALLOW_CREATE: '1',
    PCC_BOOTSTRAP_ADMIN_EMAIL: 'admin@example.test',
    PCC_BOOTSTRAP_ADMIN_PASSWORD: 'FirstInstallAdmin!2026',
    // SESSION_SECRET missing — everything else is exactly right.
  },
  expects: ['SESSION_SECRET', 'Nothing has been written', 'the database was not opened'],
});

// THE SILENT ONE. Production over plain HTTP without saying so.
//
// This case is not like the others: the old behaviour was not a bad refusal, it
// was no refusal at all. PCC started, reported healthy, and set a `Secure`
// session cookie the browser would never send back over HTTP — so every sign-in
// succeeded and landed on the sign-in page again, for everybody, permanently,
// with every check green. The only symptom was a phone call to the developer.
//
// Overrides the base environment deliberately: the absence of the flag IS the
// case.
await refuses({
  name: 'production over plain HTTP, unacknowledged',
  port: 3601,
  env: {
    SESSION_SECRET: GOOD_SECRET,
    PCC_PO_NUMBERING: 'job-vendor-sequence',
    PCC_DATABASE_ALLOW_CREATE: '1',
    PCC_ALLOW_INSECURE_HTTP: '',
  },
  expects: ['APP_BASE_URL', 'plain HTTP', 'PCC_ALLOW_INSECURE_HTTP', 'Nothing has been written'],
});

// --- the database-location refusal ------------------------------------------
// Configuration is correct; the store is not where it was said to be. Still
// nothing written, and the message sends the reader to the volume rather than
// to a variable.

await refuses({
  name: 'no database, and nobody said this was the first start',
  port: 3596,
  env: { SESSION_SECRET: GOOD_SECRET, PCC_PO_NUMBERING: 'job-vendor-sequence' },
  expects: [
    'PCC_DATABASE_ALLOW_CREATE',
    'the volume is not mounted where this application is looking',
    'no database was opened',
  ],
});

// A directory nobody created. The distinction from the case above is what an
// operator does next, so it is asserted separately.
{
  console.log(`\n--- a data directory that does not exist `.padEnd(64, '-'));
  const parent = mkdtempSync(join(tmpdir(), 'pcc-refusal-'));
  const missing = join(parent, 'not-mounted', 'pcc.sqlite');
  const run = await startAndWait(
    {
      SESSION_SECRET: GOOD_SECRET,
      PCC_PO_NUMBERING: 'job-vendor-sequence',
      PCC_DATABASE_ALLOW_CREATE: '1',
      PCC_DATABASE_PATH: missing,
    },
    3597,
  );
  check(run.code === 1, 'a missing data directory: exits 1', `exit code was ${run.code}`);
  check(!existsSync(missing), 'a missing data directory: no database was created');
  check(
    run.output.includes('no database was opened') || run.output.includes('Nothing has been written'),
    'a missing data directory: the log says nothing was written',
  );
  rmSync(parent, { recursive: true, force: true });
}

// A relative path. Under systemd the working directory is not what whoever
// typed it was picturing, so "./pcc.sqlite" is a different file per deployment
// path — which is the same lost-fortnight failure wearing a different hat.
await refuses({
  name: 'a relative database path',
  port: 3598,
  env: {
    SESSION_SECRET: GOOD_SECRET,
    PCC_PO_NUMBERING: 'job-vendor-sequence',
    PCC_DATABASE_ALLOW_CREATE: '1',
    PCC_DATABASE_PATH: './pcc-relative.sqlite',
  },
  expects: ['[pcc]'],
});

// --- the other half of the message -----------------------------------------
// A database that EXISTS and cannot be used. Here the file was opened, so the
// refusal must say so — this is the case that sends an operator to permissions
// instead of to a variable, and the two messages are not interchangeable.
{
  console.log(`\n--- a database that exists but cannot be read `.padEnd(64, '-'));
  const dir = mkdtempSync(join(tmpdir(), 'pcc-refusal-'));
  const dbPath = join(dir, 'pcc.sqlite');
  // Not a database at all. Present, the right name, and unopenable — which is
  // what a truncated restore or a half-copied file looks like.
  writeFileSync(dbPath, 'this is not a SQLite database, it is a text file\n');

  const run = await startAndWait(
    { SESSION_SECRET: GOOD_SECRET, PCC_PO_NUMBERING: 'job-vendor-sequence', PCC_DATABASE_PATH: dbPath },
    3599,
  );
  check(run.code === 1, 'a corrupt database: exits 1', `exit code was ${run.code}`);
  check(
    run.output.includes('The database was opened but could not be used') ||
      run.output.includes('database was opened'),
    'a corrupt database: the log says the database WAS opened',
    `so the operator is sent to permissions and the volume, not to a variable. Got:\n${
      run.output.split('\n').filter((l) => l.includes('[pcc]')).join('\n')}`,
  );
  check(
    !run.output.includes('Nothing has been written'),
    'a corrupt database: it does NOT claim nothing was written',
    'that message means "look at a variable" and would send the operator to the wrong place',
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- and the control -------------------------------------------------------
// A suite of refusals proves nothing on its own: a build that refused
// EVERYTHING would pass every case above. The control is a start that is
// entirely correct, which must reach ready and create its database.
{
  console.log(`\n--- the control: a correct first start `.padEnd(64, '-'));
  const dir = mkdtempSync(join(tmpdir(), 'pcc-refusal-'));
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'pcc.sqlite');
  const port = 3600;
  const child = spawn(process.execPath, [SERVER], {
    cwd: join(ROOT, 'apps', 'purchasing', '.next', 'standalone', 'apps', 'purchasing'),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(port),
      APP_BASE_URL: `http://127.0.0.1:${port}`,
      PCC_DATABASE_PATH: dbPath,
      PCC_ORG_NAME: 'Lippolis Electric, Inc.',
      PCC_ORG_ADDRESS: 'Licensed Electrical Contractor · 25 Seventh Street, Pelham, NY 10803',
      PCC_ORG_PHONE: '(914) 738-3550',
      SESSION_SECRET: GOOD_SECRET,
      PCC_PO_NUMBERING: 'job-vendor-sequence',
      PCC_ALLOW_INSECURE_HTTP: '1',
      PCC_DATABASE_ALLOW_CREATE: '1',
      PCC_BOOTSTRAP_ADMIN_EMAIL: 'admin@example.test',
      PCC_BOOTSTRAP_ADMIN_PASSWORD: 'ControlAdmin!2026',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (b) => { output += b; });
  child.stderr.on('data', (b) => { output += b; });

  let healthy = false;
  for (let i = 0; i < 45; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) { healthy = true; break; }
    } catch { /* not up yet */ }
  }

  check(healthy, 'the control: a correct configuration DOES start and report healthy',
    `so the refusals above are refusals, not a build that cannot start at all. Log:\n${output}`);
  check(existsSync(dbPath), 'the control: and it created its database');
  check(
    !output.includes('ControlAdmin!2026'),
    'the control: the bootstrap password is never printed, even on a successful start',
  );

  // AND THE ACTUAL REGRESSION, driven the way a person meets it.
  //
  // Healthy is not the bar. The bug this whole change exists for produced a
  // perfectly healthy instance where signing in did nothing — the cookie came
  // back with `Secure`, the browser kept it and refused to send it over HTTP,
  // and the next page was the sign-in page again. So the control signs in over
  // plain HTTP and follows where it lands, which is the only assertion that
  // would have caught it.
  if (healthy) {
    const signIn = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.test', password: 'ControlAdmin!2026' }),
      redirect: 'manual',
    });

    const setCookies = signIn.headers.getSetCookie?.() ?? [];
    // Whichever cookie carries the session; the name is the server's business.
    const session = setCookies.find((c) => /session/i.test(c.split('=')[0])) ?? setCookies[0] ?? '';
    check(Boolean(session), 'the control: signing in over plain HTTP sets a session cookie',
      `status ${signIn.status}, set-cookie: ${JSON.stringify(setCookies)}`);
    check(
      Boolean(session) && !/;\s*Secure/i.test(session),
      'the control: and the cookie is NOT Secure, so the browser will send it back',
      `over plain HTTP a Secure cookie is never returned and nobody can sign in. Got: ${session}`,
    );

    // Carry it to a page that requires a session. A redirect back to /sign-in
    // is the failure wearing its everyday clothes.
    if (session) {
      const jar = session.split(';')[0];
      const after = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { cookie: jar },
        redirect: 'manual',
      });
      const location = after.headers.get('location') ?? '';
      check(
        !location.includes('/sign-in'),
        'the control: and the session sticks — the next page is not the sign-in page again',
        `redirected to ${location}`,
      );
    }
  }

  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// THE REFUSALS THAT PROTECT EVIDENCE RATHER THAN CONFIGURATION.
//
// Everything above starts an EMPTY installation wrong. These start an EXISTING
// one wrong, which is the harder case and the more expensive one: the database
// already holds records, so a start that carries on does not fail — it writes.
//
// The failure they exist for: a production backup restored onto a laptop and
// started with the ordinary development command runs `seed()`, which inserts
// ten demo accounts — one of them ADMIN, all on a password printed in this
// repository — into a file that still stamps itself production. Afterwards
// nothing can tell which rows were the company's.
//
// Run against the real packaged server over a real process boundary, because
// the unit-level suite (eval-evidence-provenance.mjs) proves the rule and this
// proves the BUILD still carries it. Both halves are asserted every time: the
// process exits non-zero, AND the database on disk is byte-for-byte what it was.
// ---------------------------------------------------------------------------

const { copyFileSync, readFileSync: readBytes } = await import('node:fs');
const { createHash } = await import('node:crypto');
const { DatabaseSync } = await import('node:sqlite');

const LETTERHEAD = {
  PCC_ORG_NAME: 'Lippolis Electric, Inc.',
  PCC_ORG_ADDRESS: 'Licensed Electrical Contractor · 25 Seventh Street, Pelham, NY 10803',
  PCC_ORG_PHONE: '(914) 738-3550',
  PCC_PO_NUMBERING: 'job-vendor-sequence',
};

/** Start the packaged server until it is ready, then stop it. Returns the db path. */
async function install(environment, extra = {}, port = 3610) {
  const dir = mkdtempSync(join(tmpdir(), 'pcc-evidence-'));
  const dbPath = join(dir, 'pcc.sqlite');
  const child = spawn(process.execPath, [SERVER], {
    cwd: join(ROOT, 'apps', 'purchasing', '.next', 'standalone', 'apps', 'purchasing'),
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(port),
      APP_BASE_URL: `http://127.0.0.1:${port}`, PCC_ALLOW_INSECURE_HTTP: '1',
      SESSION_SECRET: GOOD_SECRET, PCC_DATABASE_PATH: dbPath, PCC_DATABASE_ALLOW_CREATE: '1',
      PCC_ENVIRONMENT: environment, PCC_ORG_ID: 'lippolis', ...LETTERHEAD, ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const ready = await new Promise((resolve) => {
    const t = setInterval(() => { if (/\[pcc\] ready/.test(out)) { clearInterval(t); clearTimeout(k); resolve(true); } }, 200);
    const k = setTimeout(() => { clearInterval(t); resolve(false); }, 60_000);
    child.on('exit', () => { clearInterval(t); clearTimeout(k); resolve(false); });
  });
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1200));
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  check(ready, `a ${environment} installation was created to attack`, out.split('\n').slice(-4).join(' '));
  // FOLD THE WRITE-AHEAD LOG IN. Everything so far lives in pcc.sqlite-wal, and
  // a copy of the main file alone is an empty database — which would make every
  // attack below pass for the wrong reason.
  const db = new DatabaseSync(dbPath);
  db.exec('pragma wal_checkpoint(TRUNCATE)');
  db.close();
  return { dir, dbPath };
}

const digest = (p) => createHash('sha256').update(readBytes(p)).digest('hex');

/**
 * What the database CONTAINS, after any write-ahead log has been folded in.
 *
 * Comparing the main file's bytes is not enough on its own: opening a SQLite
 * database in WAL mode writes a journal beside it, so a refusal that had
 * committed rows would leave the main file untouched and the rows in the `-wal`
 * — and a byte comparison of the main file alone would call that unchanged.
 * Checkpointing first is what makes "nothing was written" mean it.
 */
function contentOf(p) {
  const db = new DatabaseSync(p);
  db.exec('pragma wal_checkpoint(TRUNCATE)');
  const stamp = db.prepare("select value from schema_meta where key = 'environment'").get()?.value ?? 'unstamped';
  const counts = ['orgs', 'users', 'auth_identities', 'purchase_requests', 'purchase_activity_log']
    .map((t) => `${t}=${db.prepare(`select count(*) as n from ${t}`).get().n}`);
  const org = db.prepare('select id, name from orgs limit 1').get();
  db.close();
  return JSON.stringify({ stamp, counts, org: org ? { id: org.id, name: org.name } : null });
}

/**
 * Copy an installed database, start the packaged server against the copy with
 * `env`, and assert it refused without changing a byte.
 */
async function refusesToOpen({ name, from, env, port, expects }) {
  const dir = mkdtempSync(join(tmpdir(), 'pcc-attack-'));
  const dbPath = join(dir, 'pcc.sqlite');
  copyFileSync(from, dbPath);
  const before = contentOf(dbPath);
  const beforeBytes = digest(dbPath);

  const child = spawn(process.execPath, [SERVER], {
    cwd: join(ROOT, 'apps', 'purchasing', '.next', 'standalone', 'apps', 'purchasing'),
    env: {
      PATH: process.env.PATH, PORT: String(port), APP_BASE_URL: `http://127.0.0.1:${port}`,
      PCC_ALLOW_INSECURE_HTTP: '1', SESSION_SECRET: GOOD_SECRET,
      PCC_DATABASE_PATH: dbPath, ...LETTERHEAD, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const code = await new Promise((resolve) => {
    const k = setTimeout(() => { child.kill('SIGKILL'); resolve('TIMEOUT'); }, 45_000);
    child.on('exit', (c) => { clearTimeout(k); resolve(c); });
  });

  console.log(`\n--- ${name} `.padEnd(64, '-'));
  check(code === 1, `${name}: exits 1`, `exit code was ${code}`);
  for (const e of expects) {
    check(out.includes(e), `${name}: says "${e.length > 48 ? `${e.slice(0, 48)}…` : e}"`,
      `not found in: ${out.split('\n').filter((l) => l.includes('[pcc]')).join(' | ').slice(0, 300)}`);
  }
  // THE HALF THAT MATTERS. Not "it printed an error" — "it wrote nothing".
  // The main file's bytes first, then the CONTENT with any write-ahead log
  // folded in, because a refusal that had committed rows would leave the main
  // file untouched and the rows in the journal.
  check(digest(dbPath) === beforeBytes, `${name}: the main database file is byte-for-byte unchanged`);
  const after = contentOf(dbPath);
  check(after === before, `${name}: and nothing was written to the write-ahead log either`,
    `before ${before}\nafter  ${after}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nStarting an EXISTING installation wrong, on purpose.');

const PROD = await install('production', {}, 3611);
const REHEARSAL = await install('rehearsal', {}, 3612);

// A production database, met by a process that will not say it is production.
await refusesToOpen({
  name: 'restored production, ordinary development start',
  from: PROD.dbPath, port: 3613,
  env: { NODE_ENV: 'development' },
  expects: ['did not declare PCC_ENVIRONMENT', 'seeding the published demo accounts'],
});
await refusesToOpen({
  name: 'restored production, no environment declared',
  from: PROD.dbPath, port: 3614,
  env: { NODE_ENV: 'production' },
  expects: ['did not declare PCC_ENVIRONMENT'],
});
for (const [declared, port] of [['development', 3615], ['rehearsal', 3616]]) {
  await refusesToOpen({
    name: `production database declared ${declared}`,
    from: PROD.dbPath, port,
    env: { NODE_ENV: 'production', PCC_ENVIRONMENT: declared },
    expects: ['created as "production"', 'still evidence'],
  });
}

// A rehearsal database cannot be promoted, and cannot be quietly downgraded.
await refusesToOpen({
  name: 'rehearsal promoted to production',
  from: REHEARSAL.dbPath, port: 3617,
  env: { NODE_ENV: 'production', PCC_ENVIRONMENT: 'production' },
  expects: ['created as "rehearsal"', 'cannot be promoted', 'NEW database'],
});
await refusesToOpen({
  name: 'rehearsal declared development',
  from: REHEARSAL.dbPath, port: 3618,
  env: { NODE_ENV: 'production', PCC_ENVIRONMENT: 'development' },
  expects: ['created as "rehearsal"'],
});

// The organization id is permanent, and a spoofed one is caught before a row
// moves. This is the failure that makes every baseline match nothing.
await refusesToOpen({
  name: 'production with a spoofed organization id',
  from: PROD.dbPath, port: 3619,
  env: { NODE_ENV: 'production', PCC_ENVIRONMENT: 'production', PCC_ORG_ID: 'lippolis_electric' },
  expects: ['is permanent', 'wrong organization', 'lippolis'],
});

// A word this system has no meaning for is refused rather than interpreted.
await refusesToOpen({
  name: 'an environment word nobody defined',
  from: PROD.dbPath, port: 3620,
  env: { NODE_ENV: 'production', PCC_ENVIRONMENT: 'staging' },
  expects: ['must be one of'],
});

// THE CONTROL. If the honest start were also refused, every assertion above
// would pass for the wrong reason.
{
  const dir = mkdtempSync(join(tmpdir(), 'pcc-control-'));
  const dbPath = join(dir, 'pcc.sqlite');
  copyFileSync(PROD.dbPath, dbPath);
  const child = spawn(process.execPath, [SERVER], {
    cwd: join(ROOT, 'apps', 'purchasing', '.next', 'standalone', 'apps', 'purchasing'),
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production', PORT: '3621',
      APP_BASE_URL: 'http://127.0.0.1:3621', PCC_ALLOW_INSECURE_HTTP: '1',
      SESSION_SECRET: GOOD_SECRET, PCC_DATABASE_PATH: dbPath,
      PCC_ENVIRONMENT: 'production', PCC_ORG_ID: 'lippolis', ...LETTERHEAD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const ready = await new Promise((resolve) => {
    const t = setInterval(() => { if (/\[pcc\] ready/.test(out)) { clearInterval(t); clearTimeout(k); resolve(true); } }, 200);
    const k = setTimeout(() => { clearInterval(t); resolve(false); }, 45_000);
    child.on('exit', () => { clearInterval(t); clearTimeout(k); resolve(false); });
  });
  console.log('\n--- the control: the honest start ' + '-'.repeat(29));
  check(ready, 'a production database opened by a production process starts');
  check(/opening the existing purchasing database/.test(out),
    'and opens the existing database rather than creating one');
  check(!/creating a NEW/.test(out), 'nothing was created on an established installation');
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1200));
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

rmSync(PROD.dir, { recursive: true, force: true });
rmSync(REHEARSAL.dir, { recursive: true, force: true });

console.log(`\nstartup refusal checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
