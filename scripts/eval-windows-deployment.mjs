// ---------------------------------------------------------------------------
// eval-windows-deployment.mjs — the Windows deployment mechanics, tested from
// a machine that is not Windows.
//
// WHAT THIS CAN AND CANNOT PROVE. It cannot start a service, and it does not
// pretend to: no assertion here says PCC works on Windows. What it does prove
// is that the mechanics we ship are internally consistent and carry the
// guardrails the Linux path already has — that the installer refuses the things
// it must refuse, that the paths agree between the adapter, the installer and
// the verifier, and that nobody has quietly reintroduced SSH, a secret in the
// repository, or a second backup implementation.
//
// It is a lint with opinions, and the opinions are the ones that cost money if
// they are wrong. The first supervised installation on LIPELE-RDS02 is what
// proves the rest, and adapters/windows-service.mjs stays `proven: false` until
// it has happened.
//
//   node scripts/eval-windows-deployment.mjs
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
const failures = [];
const ok = () => { pass++; };
const bad = (m) => { failures.push(m); console.log(`FAIL  ${m}`); };
const check = (c, m) => (c ? ok() : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok() : bad(`${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

const INSTALLER = 'scripts/install-production.ps1';
const BACKUP_TASK = 'scripts/install-backup-task.ps1';
const ADAPTER = 'deployment/adapters/windows-service.mjs';
const VERIFIER = 'scripts/pcc-verify-deployment.mjs';

// ---------------------------------------------------------------------------
console.log('--- the artefacts exist ----------------------------------------');

for (const f of [INSTALLER, BACKUP_TASK, ADAPTER]) {
  check(existsSync(join(ROOT, f)), `${f} exists`);
}

const installer = read(INSTALLER);
const backupTask = read(BACKUP_TASK);
const adapter = read(ADAPTER);
const verifier = read(VERIFIER);

// ---------------------------------------------------------------------------
console.log('--- the installer refuses what it must refuse -------------------');

// THE FAILURE THAT MUST NOT HAPPEN. A typo in the data path becomes a new,
// empty, healthy-looking purchasing system while the real records sit
// elsewhere. The bash installer refuses to create the directory; so must this.
check(/will NOT create it/i.test(installer),
  'the installer refuses to create the data directory, and says so');
check(/Test-Path[^\n]*\$DataDir[^\n]*Container/.test(installer),
  'and it checks for the directory rather than assuming it');

// A re-clone or a release that replaces the application directory would delete
// the records and the backups beside them.
check(/inside the source checkout/i.test(installer),
  'the installer refuses a data directory inside the checkout');

// A secret a script invented is a secret nobody stored.
check(/will NOT generate it for you/i.test(installer),
  'the installer refuses to generate SESSION_SECRET');
check(/SESSION_SECRET[\s\S]{0,400}?32/.test(installer),
  'and it enforces a minimum length');

// A purchase order number cannot be withdrawn once a supplier has it.
check(/PCC_PO_NUMBERING is not set/.test(installer),
  'the installer refuses an installation with no purchase-order numbering rule');

// The one that locks everybody out quietly: a Secure cookie over plain HTTP is
// accepted by the browser and never sent back.
check(/PCC_ALLOW_INSECURE_HTTP/.test(installer),
  'plain-HTTP operation must be a stated decision, not a default');
check(/APP_BASE_URL must be an absolute/.test(installer),
  'and a malformed base URL is refused outright');

// Creating the company's purchasing database should happen once, ever.
check(/-FirstInstall was not given/.test(installer),
  'a missing database without -FirstInstall is fatal, not an invitation to create one');
check(/PCC_DATABASE_ALLOW_CREATE=1 must also be set/.test(installer),
  'and -FirstInstall alone is not enough — the env file must agree');

// Half-installed is worse than not installed.
check(/IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/.test(installer),
  'the installer requires elevation up front rather than failing halfway through');

// Node 20 fails at startup with an error naming nothing anybody can act on.
check(/nodeMajor\s*-lt\s*24/.test(installer),
  'the installer enforces the Node 24 floor');

// The env file holds SESSION_SECRET; the repository is not where it lives.
check(/environment file is inside the source checkout/i.test(installer),
  'the installer refuses an environment file kept in the repository');

// ---------------------------------------------------------------------------
console.log('--- secrets never reach source control --------------------------');

// The strongest version of this check: no file we added may contain something
// that looks like a real secret value.
for (const [name, text] of [[INSTALLER, installer], [BACKUP_TASK, backupTask], [ADAPTER, adapter]]) {
  check(!/SESSION_SECRET\s*=\s*["'][A-Za-z0-9+/=]{16,}/.test(text),
    `${name} assigns no literal SESSION_SECRET`);
  check(!/(password|secret|token)\s*=\s*["'][^"'$][^"']{7,}["']/i.test(text),
    `${name} carries no literal credential`);
}

// Values are never echoed: this output gets pasted into tickets.
check(/values are never printed/i.test(installer),
  'the installer states that it never prints configuration values');

// ---------------------------------------------------------------------------
console.log('--- the service carries the refusal semantics -------------------');

// The single most important translation from systemd. A configuration refusal
// exits 1, and a supervisor that restarts it loops forever and buries the one
// line that says what is wrong.
for (const [name, text] of [[ADAPTER, adapter], [INSTALLER, installer]]) {
  check(/AppExit\s+1\s+Exit/.test(text), `${name} stops on a deliberate refusal (AppExit 1 Exit)`);
  check(/AppExit\s+Default\s+Restart/.test(text), `${name} restarts on a crash (AppExit Default Restart)`);
}
check(/RestartPreventExitStatus/.test(adapter),
  'and the adapter names the systemd behaviour it is translating');

// It must come back from a reboot without anybody logging in.
check(/SERVICE_AUTO_START/.test(installer), 'the service is registered to start automatically');

// Windows has no journal: without redirection a failed start is silent.
check(/AppStdout/.test(installer) && /AppStderr/.test(installer),
  'stdout and stderr go to files, because Windows has no journal');
check(/AppRotateFiles/.test(installer),
  'and the logs rotate, because nothing else will do it');

// A rerun must converge, not accumulate.
check(/nssm set \$ServiceName Application/.test(installer),
  'every service setting is assigned on rerun rather than assumed');
check(/already exists — reconfiguring it in place/i.test(installer),
  'an existing service is reconfigured rather than duplicated');

// ---------------------------------------------------------------------------
console.log('--- the running version is knowable -----------------------------');

// "Exactly what version is running at Lippolis?" must be answerable months
// later by somebody who was not there. /api/health reports PCC_RELEASE; the
// build stamps it; the installer passes it to the service.
const stage = read('scripts/stage-standalone.mjs');
check(/RELEASE/.test(stage), 'the build writes a RELEASE file into the artifact');
check(/rev-parse/.test(stage), 'stamped from the commit, not from a file date');
check(/-dirty/.test(stage),
  'an artifact built from uncommitted changes says so — it cannot be reproduced from a commit');
check(/PCC_RELEASE=\$release/.test(installer),
  'the installer passes the release to the service');
check(/running release/.test(installer),
  'and reads it back from the running process, not from the disk it copied');
check(/no RELEASE file/.test(installer),
  'a hand-assembled artifact with no RELEASE is called out rather than installed silently');

// ---------------------------------------------------------------------------
console.log('--- least privilege ---------------------------------------------');

// The Windows equivalent of `install -d -o pcc -g pcc -m 750`.
check(/NT SERVICE\\\\?\$?\{?ServiceName/.test(installer) || /NT SERVICE\\/.test(installer),
  'the service runs as a virtual service account, not as SYSTEM or a named user');
check(/icacls/.test(installer), 'permissions are set explicitly with icacls');
check(/\/inheritance:r/.test(installer),
  'inherited permissions are dropped rather than added to');
// It must not be able to rewrite its own code.
check(/InstallPath[^\n]*RX/.test(installer),
  'the service account gets read+execute on the application, never write');
check(/DataAbs[^\n]*\(OI\)\(CI\)M/.test(installer),
  'and modify on its data directory');

// A virtual account has no password to rotate, store or leak.
check(/no password/i.test(adapter),
  'the adapter explains why a virtual account rather than a credential');

// ---------------------------------------------------------------------------
console.log('--- backup scheduling reuses the existing implementation --------');

// A second backup implementation would be a second thing to be wrong.
check(/pcc-backup\.mjs/.test(backupTask),
  'the Windows schedule runs the existing pcc-backup.mjs');
check(!/DatabaseSync|VACUUM INTO|sha256/i.test(backupTask),
  'and contains no backup logic of its own');
check(/does not replace it|not here/i.test(backupTask),
  'and says so, so nobody adds one later');

// The decisions carried over from pcc-backup.timer.
check(/-At '01:30'/.test(backupTask), 'nightly at 01:30 local, as the timer unit had it');
check(/RandomDelay/.test(backupTask), 'with jitter, for a hypervisor running several VMs');
check(/-StartWhenAvailable/.test(backupTask),
  'and it catches up if the machine was off — Persistent=true');
check(/--keep 30/.test(backupTask), 'keeping 30, as the service unit had it');

// Re-running must not schedule two backups an unknown distance apart.
check(/Register-ScheduledTask[\s\S]{0,600}-Force/.test(backupTask),
  'registering is idempotent — a rerun replaces rather than duplicates');
check(/no duplicate created/i.test(backupTask),
  'and it reports which of the two happened');

// Validation must be possible without changing anything.
check(/\$Verify/.test(backupTask), 'the task can be validated');
check(/report, change nothing/i.test(backupTask),
  'and validation is explicitly side-effect free');

// A backup of the wrong file is the failure the schedule exists to prevent.
check(/there is no database at/i.test(backupTask),
  'scheduling a backup of a non-existent database is refused');

// A backup that quietly stopped working is worse than none.
check(/LastTaskResult/.test(backupTask), 'the last result is reported');

// ---------------------------------------------------------------------------
console.log('--- the verifier checks Windows rather than shrugging -----------');

check(/haveWindowsServices/.test(verifier), 'the verifier knows about Windows services');
check(/sc\.exe/.test(verifier), 'and queries the Service Control Manager');
check(/schtasks\.exe/.test(verifier), 'and the Task Scheduler');

// NSSM points BINARY_PATH_NAME at nssm.exe for every service it manages, so
// reading it would say nothing about which application runs.
check(/nssmParam/.test(verifier),
  'the supervised command is read from the registry, not from BINARY_PATH_NAME');
check(/next\s+dev|npm\\s\+run\\s\+dev|next\\s\+dev/.test(verifier),
  'a development server in production is still detected on Windows');

// The three questions systemd answered must all still be answered.
for (const id of ['service.active', 'service.enabled', 'runtime.production_mode']) {
  check(verifier.includes(id), `${id} is still reported`);
}
check(/service\.refusal_policy/.test(verifier),
  'and the Windows path additionally verifies the exit-1 refusal policy');

// A missing service must be BLOCKED, not UNVERIFIED: PCC answering without
// supervision is an outage waiting for the next reboot.
check(/there is no Windows service named/.test(verifier),
  'an absent service is reported as a blocker rather than as unchecked');

// REBOOT SURVIVAL IS NEVER CLAIMED BY CONFIGURATION.
check(/auto-start is a setting/i.test(installer) || /not a proof/i.test(installer),
  'the installer refuses to claim reboot survival it has not observed');
check(!/reboot.{0,40}(verified|proven|confirmed)/i.test(installer),
  'and nothing in it asserts a reboot happened');

// ---------------------------------------------------------------------------
console.log('--- production and development stay separate --------------------');

// Everything that could collide is parameterised, so a staging instance on the
// same box cannot reach production's data.
check(/\$ServiceName\s*=\s*'pcc'/.test(installer), 'the service name is a parameter with a default');
check(/pcc-staging/.test(installer), 'and staging is named as the intended second value');
check(/C:\\\\Program Files\\\\\$ServiceName|Program Files\\\\\$\{?ServiceName/.test(installer)
   || /"C:\\Program Files\\\$ServiceName"/.test(installer),
  'the install path follows the service name rather than being fixed');
check(/-TaskName/.test(backupTask), 'the backup task name is a parameter');
check(/distinct name for staging/i.test(backupTask), 'and staging is told to use its own');

// The permission grants are what make the separation enforced rather than
// conventional: the staging account has no rights to production's data.
check(/\$ServiceAcct\s*=\s*"NT SERVICE\\\$ServiceName"/.test(installer),
  'the service account follows the service name, so staging cannot read production data');

// ---------------------------------------------------------------------------
console.log('--- no SSH, anywhere -------------------------------------------');

for (const [name, text] of [[INSTALLER, installer], [BACKUP_TASK, backupTask], [ADAPTER, adapter]]) {
  check(!/\bssh\b|\bscp\b|\bsftp\b|PuTTY|OpenSSH/i.test(text),
    `${name} requires no SSH`);
}

// ---------------------------------------------------------------------------
console.log('--- paths agree across the three files --------------------------');

// A path that differs between the adapter, the installer and the runbook is a
// deployment that half-works and is very hard to see.
check(/C:\\\\ProgramData\\\\\{app\}\\\\data/.test(adapter), 'the adapter puts data under ProgramData');
check(/ProgramData/.test(installer), 'and so does the installer');
check(/ProgramData/.test(backupTask), 'and the backup task');
// Program Files is read-only for non-administrators by design; a database there
// fails at the first write rather than at install time.
check(/Program Files is read-only/i.test(adapter),
  'and the adapter explains why runtime data is not in Program Files');

// ---------------------------------------------------------------------------
console.log('--- mechanics are still not a deployment ------------------------');

const { adapterFor, provenAdapters } = await import(join(ROOT, 'deployment/adapters/index.mjs'));
check(adapterFor('windows-service').ok, 'the windows adapter is selectable');
check(adapterFor('windows-service').adapter.proven === false,
  'and it still admits it is unproven');
eq(provenAdapters(), ['systemd'],
  'no Windows installation has happened, so no Windows adapter is proven');
check(/proven: false/.test(adapter) && /Flip it in the same change/.test(adapter),
  'and the adapter says what would justify flipping it');

// The installer must be reachable from the adapter's plan, or the two drift.
const plan = adapterFor('windows-service').adapter.installPlan({
  app: 'pcc',
  installPath: 'C:\\Program Files\\pcc',
  dataPath: 'C:\\ProgramData\\pcc\\data',
  secretsStore: 'C:\\ProgramData\\pcc\\pcc.env',
  user: 'NT SERVICE\\pcc',
});
check(Array.isArray(plan) && plan.length > 0, 'the adapter still produces an install plan');
check(plan.some((l) => /icacls/.test(l)), 'and the plan and the installer agree that icacls sets permissions');

const verification = adapterFor('windows-service').adapter.verificationCommands('pcc');
check(/Get-Service/.test(verification.SERVICE_RUNNING), 'the adapter names a way to see the service');
check(/Restart-Computer/.test(verification.REBOOT_RECOVERY_SUCCEEDED),
  'and reboot recovery is an actual reboot, not an inference');

// ---------------------------------------------------------------------------
console.log('--- PCC still does not send email ------------------------------');

// Microsoft 365 SMTP details arriving from IT is not a reason to grow a send
// path. If this ever fails, somebody added one — check it was deliberate.
for (const [name, text] of [[INSTALLER, installer], [BACKUP_TASK, backupTask], [ADAPTER, adapter]]) {
  check(!/nodemailer|smtp\.|createTransport|office365|graph\.microsoft/i.test(text),
    `${name} introduces no mail transport`);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`windows deployment checks: ${pass} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`windows deployment checks: ${pass} passed, 0 failed`);
