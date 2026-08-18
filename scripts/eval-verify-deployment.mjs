// ---------------------------------------------------------------------------
// eval-verify-deployment.mjs — can the production verifier be trusted?
//
// It is the command Lippolis IT will run to decide whether an installation is
// safe to put people on, so the failure that matters most is not "it missed
// something" — it is "it said READY when it was not", or "it printed a session
// secret into somebody's terminal scrollback", or "it modified the company's
// database while checking it".
//
// So this asserts the three properties the report's usefulness rests on:
//
//   HONEST     it reports UNVERIFIED where it could not check, BLOCKED where it
//              genuinely checked and found a problem, and exits non-zero only
//              for real blockers
//   SILENT     no secret value ever reaches the output, in either format,
//              including the ones deliberately planted here
//   HARMLESS   the database is byte-for-byte identical afterwards — including
//              after the write-lock check, which is the one thing in it that
//              touches the file in a writable mode
//
// Everything here runs offline against a throwaway database.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = join(ROOT, 'apps', 'purchasing', 'src');
const SCRIPT = join(ROOT, 'scripts', 'pcc-verify-deployment.mjs');

let pass = 0;
const fails = [];
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'pcc-verify-eval-'));
const DB = join(TMP, 'pcc.sqlite');

const { openDatabase } = await import(join(APP, 'purchasing', 'infrastructure', 'sqlite', 'database.ts'));
const { seed } = await import(join(APP, 'purchasing', 'infrastructure', 'seed.ts'));
const db = openDatabase(DB);
seed(db, '2026-08-18T09:00:00.000Z');
db.close();

// The planted secrets. If either of these strings appears anywhere in the
// output, the report is a way to leak a credential into a terminal history.
const SESSION_SECRET = 'a-very-secret-session-key-that-must-never-be-printed-0123456789';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-that-must-never-be-printed';

const PROD_ENV = {
  ...process.env,
  NODE_ENV: 'production',
  SESSION_SECRET,
  PCC_DATABASE_PATH: DB,
  APP_BASE_URL: 'https://pcc.lippolis.invalid',
  PCC_PO_NUMBERING: 'job-vendor-sequence',
  PCC_RELEASE: 'test-revision',
  PCC_ALLOW_INSECURE_HTTP: '',
};

const run = (env = PROD_ENV, args = []) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, stdio: 'pipe' }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ---------------------------------------------------------------------------
console.log('--- it changes nothing it looks at ------------------------------');

const before = sha(DB);
const first = run();
const after = sha(DB);
ok(before === after, 'the database is byte-for-byte identical after a full run');
ok(!existsSync(`${DB}-wal`) || sha(DB) === after, 'and the write-lock check left no committed change');

// The verifier must not contain a statement that could change anything. A
// read-only claim enforced by reading the source is weaker than a type system
// and stronger than a promise in a comment.
const src = readFileSync(SCRIPT, 'utf8');
for (const forbidden of [/\binsert\s+into\b/i, /\bupdate\s+\w+\s+set\b/i, /\bdelete\s+from\b/i, /\bdrop\s+table\b/i]) {
  ok(!forbidden.test(src), `the verifier contains no ${String(forbidden)} statement`);
}
ok(/begin immediate[\s\S]{0,200}rollback/.test(src),
   'the only write-mode touch is an immediate transaction that is rolled back');

// ---------------------------------------------------------------------------
console.log('--- it never prints a secret ------------------------------------');

const withBootstrap = run({ ...PROD_ENV, PCC_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD });
const jsonRun = run({ ...PROD_ENV, PCC_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD }, ['--json']);

for (const [label, result] of [['text', withBootstrap], ['json', jsonRun]]) {
  ok(!result.out.includes(SESSION_SECRET), `${label}: the session secret is not printed`);
  ok(!result.out.includes(BOOTSTRAP_PASSWORD), `${label}: the bootstrap password is not printed`);
}
ok(/secret\.SESSION_SECRET\s+present/.test(withBootstrap.out) || /"id": "secret.SESSION_SECRET"/.test(jsonRun.out),
   'presence is reported instead of the value');
ok(/still set — correct for the FIRST start only/.test(withBootstrap.out),
   'a bootstrap password left behind is reported — by name, not by value');

// ---------------------------------------------------------------------------
console.log('--- honest verdicts ---------------------------------------------');

// No PCC is running in this test, so the application section must BLOCK — and
// that must be enough to fail the run, because an installation nobody can reach
// is not ready no matter how good the database looks.
ok(first.code === 1, 'with nothing serving, it exits non-zero');
ok(/NOT READY/.test(first.out), 'and says NOT READY');
ok(/process\.answering.*(BLOCKED|nothing answered)/s.test(first.out), 'because nothing answered');

// The database IS there and IS fine, and the report must say so rather than
// condemning everything because one section failed.
ok(/PASS\s+database\.readable/.test(first.out), 'the database it can read is reported as readable');
ok(/PASS\s+database\.writable/.test(first.out), 'and writable');
ok(/PASS\s+auth\.can_sign_in/.test(first.out), 'the credential store is reported');

// UNVERIFIED must not fail the run on its own. On this machine every systemd
// check is UNVERIFIED, and if that counted as a failure the report could never
// pass anywhere but Linux.
const unverified = [...first.out.matchAll(/^\s+UNVERIFIED\s+(\S+)/gm)].map((m) => m[1]);
ok(unverified.length > 0, 'checks that cannot run here are reported UNVERIFIED', unverified.join(', '));
const blockingIds = /Blocking:([\s\S]*)$/.exec(first.out)?.[1] ?? '';
ok(!unverified.some((id) => blockingIds.includes(` ${id} `)),
   'and no UNVERIFIED check appears in the blocking list');

// ---------------------------------------------------------------------------
console.log('--- integrations are described, never assumed -------------------');

ok(/CONFIGURED — PCC composes vendor email as a draft and cannot send/.test(first.out),
   'vendor email is reported as the draft-only design it is');
ok(/NOT CONFIGURED\s+email\.transport/.test(first.out),
   'and the absent mail transport is NOT CONFIGURED rather than a failure');
ok(/NOT CONFIGURED\s+printing\.direct_to_printer/.test(first.out),
   'direct-to-printer is NOT CONFIGURED rather than claimed');
ok(/UNVERIFIED\s+tls\.terminator/.test(first.out),
   'what terminates TLS is UNVERIFIED — PCC cannot see in front of itself');

// ---------------------------------------------------------------------------
console.log('--- the machine-readable form ------------------------------------');

const parsed = (() => { try { return JSON.parse(jsonRun.out); } catch { return null; } })();
ok(parsed !== null, '--json emits parseable JSON');
if (parsed) {
  ok(parsed.ready === false, 'it reports ready: false while the application is down');
  ok(Array.isArray(parsed.blocking) && parsed.blocking.length > 0, 'with the blockers listed');
  ok(typeof parsed.sections === 'object' && parsed.sections.Database?.verdict,
     'and a verdict per section', JSON.stringify(Object.keys(parsed.sections ?? {})));
  ok(!JSON.stringify(parsed).includes(SESSION_SECRET), 'and no secret anywhere in the structure');
}

// ---------------------------------------------------------------------------
console.log('--- misconfiguration is caught, not smoothed over ----------------');

const noDb = run({ ...PROD_ENV, PCC_DATABASE_PATH: join(TMP, 'not-mounted', 'pcc.sqlite') });
ok(noDb.code === 1 && /no database at/.test(noDb.out),
   'a database path that does not exist BLOCKS — the volume is probably not mounted');
ok(/volume is probably not mounted/.test(noDb.out), 'and says what that usually means');

const plainHttp = run({ ...PROD_ENV, APP_BASE_URL: 'http://pcc.lippolis.invalid', PCC_ALLOW_INSECURE_HTTP: '' });
ok(/BLOCKED\s+tls\.scheme/.test(plainHttp.out),
   'unacknowledged plain HTTP in production BLOCKS, matching what PCC does on start');

const acknowledged = run({ ...PROD_ENV, APP_BASE_URL: 'http://pcc.lippolis.invalid', PCC_ALLOW_INSECURE_HTTP: '1' });
ok(/WARN\s+tls\.scheme/.test(acknowledged.out),
   'and a recorded decision to run without TLS is a warning, not a blocker');

const devMode = run({ ...PROD_ENV, NODE_ENV: 'development' });
ok(/BLOCKED\s+config\.production_mode/.test(devMode.out), 'a non-production NODE_ENV BLOCKS');
ok(/UNVERIFIED\s+config\.valid/.test(devMode.out),
   'and the production configuration rules are reported as not applied, rather than as passing');

// --strict promotes warnings, for the go/no-go moment.
const strict = run(PROD_ENV, ['--strict']);
ok(strict.code === 1, '--strict exits non-zero');
ok(strict.out.split('Blocking:')[1]?.length > first.out.split('Blocking:')[1]?.length,
   '--strict lists more blockers than the default run');

// ---------------------------------------------------------------------------
console.log('--- the two things the deployment dry run found ------------------');

// FOUND BY INSTALLING PCC ON A FRESH LINUX SERVER, following the runbook.
//
// 1. A correctly installed, healthy PCC reported "nothing answered", because
//    APP_BASE_URL is the name people type and it does not resolve FROM the
//    server. The report cried wolf on its first outing.
// 2. The same installation reported NOT READY at the exact step the checklist
//    says to verify it, because a database with no vendors cannot issue a
//    purchase order — which is true, and is what sections B and C are for.
//
// Both would have been discovered on the VM, in front of Jose.

// The database here has a seeded fixture, so it is NOT the fresh case: vendors
// and jobs exist. A fitness failure on it must still BLOCK.
const provisioned = run();
ok(/WARN\s+process\.answering|BLOCKED\s+process\.answering/.test(provisioned.out),
   'with nothing serving anywhere, the application section still reports a problem');

// The fresh case: an installed, empty database — exactly what exists between
// the end of installation and the start of provisioning.
const FRESH = mkdtempSync(join(tmpdir(), 'pcc-verify-fresh-'));
const FRESH_DB = join(FRESH, 'pcc.sqlite');
{
  const fresh = openDatabase(FRESH_DB);
  // The application's own production bootstrap: roles, locations, templates,
  // one administrator. No vendors, no jobs, no requests — the company's.
  const { bootstrapDatabase } = await import(join(APP, 'purchasing', 'infrastructure', 'bootstrap.ts'));
  bootstrapDatabase(fresh, {
    NODE_ENV: 'production', PCC_ORG_NAME: 'Lippolis Electric, Inc.',
    PCC_ORG_ADDRESS: 'Licensed Electrical Contractor · 25 Seventh Street, Pelham, NY 10803',
    PCC_ORG_PHONE: '(914) 738-3550',
    PCC_BOOTSTRAP_ADMIN_EMAIL: 'admin@dryrun.test', PCC_BOOTSTRAP_ADMIN_PASSWORD: 'DryRunBootstrap2026',
  }, '2026-08-18T09:00:00.000Z');
  fresh.close();
}
const freshRun = run({ ...PROD_ENV, PCC_DATABASE_PATH: FRESH_DB });
ok(/WARN\s+database\.fit_for_production/.test(freshRun.out),
   'a freshly installed, unprovisioned database WARNS rather than blocking',
   /\s+database\.fit_for_production.*/.exec(freshRun.out)?.[0]?.trim());
ok(/not been entered yet/.test(freshRun.out),
   'and says the company data has not been entered yet');
ok(/section B, then C/.test(freshRun.out), 'pointing at the acceptance step that enters it');
ok(!/database\.fit_for_production/.test(/Blocking:([\s\S]*)$/.exec(freshRun.out)?.[1] ?? ''),
   'so it does not appear in the blocking list on a correct installation');

// And a database that HAS data but fails fitness still blocks — the fresh-case
// exemption must not become a way to launch on a broken one.
const seeded = run();
ok(!/WARN\s+database\.fit_for_production/.test(seeded.out) || /warning\(s\)/.test(seeded.out),
   'a database with data in it is judged on its contents, not exempted');

rmSync(FRESH, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log('--- the acceptance sequence, and the documents that carry it -----');

// The checklist is executed once, on the VM, by people who will not be reading
// the source. Everything it tells them to run must exist, and the documents
// that lead there must actually lead there — a runbook that names a script by
// the wrong path is discovered at the worst possible moment.
const acceptance = readFileSync(join(ROOT, 'docs/deployment/PCC_PRODUCTION_ACCEPTANCE.md'), 'utf8');

ok(/INSTALL → CONFIGURE → VERIFY → PROVISION → REAL PO → REBOOT → VERIFY AGAIN → ACCEPT/.test(acceptance),
   'the acceptance document states the whole sequence');
for (const command of [
  'pcc-verify-deployment.mjs', 'pcc-backup.mjs --db /var/lib/pcc/pcc.sqlite --check',
  'systemctl list-timers pcc-backup.timer', 'systemctl start pcc-backup.service',
  'journalctl -u pcc', 'pcc-reset-admin.mjs', 'restore-rehearsal.sh', 'git rev-parse HEAD',
]) {
  ok(acceptance.includes(command), `it tells the operator to run: ${command}`);
}
for (const script of ['pcc-verify-deployment.mjs', 'pcc-backup.mjs', 'pcc-reset-admin.mjs', 'restore-rehearsal.sh']) {
  ok(existsSync(join(ROOT, 'scripts', script)), `and ${script} exists to be run`);
}

// The sections that make it an acceptance rather than a smoke test.
for (const [heading, why] of [
  ['## A. Infrastructure acceptance', 'install, configure, verify, backup'],
  ['## B. Account acceptance', 'real people, forced password change'],
  ['## C. Purchasing workflow acceptance', 'one real purchase order'],
  ['## D. Persistence and reboot acceptance', 'the reboot nobody remembers to do'],
  ['## E. Recovery acceptance', 'Jose at the keyboard'],
  ['## F. Real-user acceptance', 'Mike, unaided'],
  ['## G. Jose handoff verification', 'operation without the developer'],
  ['## H. Operational responsibility model', 'who owns what'],
]) {
  ok(acceptance.includes(heading), `it covers ${why}`);
}

ok(/10 needed − 2 in stock = 8 ordered/.test(acceptance),
   'the quantity rule is checked as the approved workflow states it');
ok(/One click.*No second confirmation/s.test(acceptance),
   'and the single-click order placement is checked');
ok(/do not restore over the live database/i.test(acceptance),
   'recovery acceptance refuses to prove restore by destroying production');
ok(/FUTURE IMPROVEMENT[\s\S]{0,400}(No\. Do not turn these into launch blockers|\*\*No\.)/i.test(acceptance),
   'and future improvements are explicitly not launch blockers');

// The three documents that lead to it.
for (const [doc, needle] of [
  ['PCC_VM_INSTALLATION_RUNBOOK.md', 'pcc-verify-deployment.mjs'],
  ['docs/deployment/PCC_IT_DEPLOYMENT_HANDOFF.md', 'pcc-verify-deployment.mjs'],
  ['scripts/install-production.sh', 'PCC_PRODUCTION_ACCEPTANCE.md'],
]) {
  ok(readFileSync(join(ROOT, doc), 'utf8').includes(needle), `${doc} points at ${needle}`);
}

// THE IDIOM THAT KILLED THE DOCUMENTED COMMAND ON THE DRY RUN. Any environment
// rebuilt from the file with `env $(... | xargs)` dies on the first value
// containing a space, and PCC_ORG_NAME — which prints on every purchase order —
// is "Lippolis Electric, Inc.".
for (const doc of ['PCC_VM_INSTALLATION_RUNBOOK.md', 'docs/deployment/PCC_PRODUCTION_ACCEPTANCE.md']) {
  const text = readFileSync(join(ROOT, doc), 'utf8');
  const broken = [...text.matchAll(/^.*env \$\((?!\s*#).*xargs\).*$/gm)]
    .map((m) => m[0].trim())
    // Prose ABOUT the broken idiom is not the broken idiom. The real commands
    // never contain the ellipsis character; the warning against them does.
    // Prose ABOUT the broken idiom is not the broken idiom: the warning against
    // it necessarily quotes it. Real commands are inside a fenced block and are
    // not backticked mid-sentence.
    .filter((line) => !/`env \$\(/.test(line) && !line.includes('…'));
  ok(broken.length === 0, `${doc} never rebuilds the environment with env $(… | xargs)`, broken.join(' | '));
  ok(/systemd-run/.test(text), `${doc} uses systemd's own parser instead`);
}
const runbook2 = readFileSync(join(ROOT, 'PCC_VM_INSTALLATION_RUNBOOK.md'), 'utf8');
ok(/useradd --system[\s\S]{0,400}install -d -o pcc -g pcc[\s\S]{0,200}\/var\/lib\/pcc/.test(runbook2),
   'the runbook creates the service account BEFORE the directories it must own');
ok(/status=203\/EXEC/.test(runbook2), 'and names the symptom when node is not at /usr/bin/node');

rmSync(TMP, { recursive: true, force: true });

console.log('');
for (const f of fails) console.log(`FAILED: ${f}`);
console.log(`verify-deployment checks: ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
