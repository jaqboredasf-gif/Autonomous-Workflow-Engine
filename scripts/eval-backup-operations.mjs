// ---------------------------------------------------------------------------
// eval-backup-operations.mjs — is the SCHEDULED backup a backup?
//
// `scripts/pcc-backup.mjs` was already proven: it writes a consistent online
// copy and reopens it to check. What was missing was everything around it —
// nothing ran it on a schedule, so "back it up nightly" was an instruction in a
// document rather than a thing the machine does.
//
// This suite covers the two halves of that, and it can only really finish one
// of them on a developer's machine:
//
//   BEHAVIOUR — proven here. Retention that cannot delete the copy it just
//   made, a verification that fails on a corrupt file instead of reporting the
//   file exists, and the `--check` an operator runs to answer "is last night's
//   backup good?" without restoring it.
//
//   THE UNITS — checked here as text, and NOT proven until they run under
//   systemd on the VM. What can be established without systemd is that they
//   agree with each other and with the documentation: the timer starts the
//   service that exists, the service runs the script at the path the handoff
//   says to install it at, neither service can be enabled in a way that runs
//   one backup at boot and never again, and the Docker variant runs as the uid
//   that owns the volume. Those are the mistakes that survive a review and
//   fail at 01:30.
//
// It also checks that the four operational scripts IT copies onto the server
// import nothing but Node builtins, because a backup command that needs the
// repository and its node_modules is a backup command that stops working the
// first time somebody tidies up the server.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = join(ROOT, 'apps', 'purchasing', 'src');

let pass = 0;
const fails = [];
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return cond;
};

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
// Directives only: the units are heavily commented, and a check that matched
// the commentary would pass on a unit whose actual configuration was wrong.
const directives = (text) =>
  text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join('\n');

// ---------------------------------------------------------------------------
console.log('--- the timer, and the service it starts -------------------------');

const timer = directives(read('deploy/pcc-backup.timer'));
const nodeService = directives(read('deploy/pcc-backup.service'));
const dockerService = directives(read('deploy/pcc-backup-docker.service'));

ok(/^\[Timer\]$/m.test(timer), 'the timer has a [Timer] section');
ok(/OnCalendar=\S/.test(timer), 'it says when it runs');
ok(/Persistent=true/.test(timer),
   'a backup missed because the machine was off is taken when it comes back');
ok(/Unit=pcc-backup\.service/.test(timer), 'and it starts pcc-backup.service by name');
ok(/WantedBy=timers\.target/.test(timer), 'the timer is installable into timers.target');

for (const [label, unit] of [['node', nodeService], ['docker', dockerService]]) {
  ok(/Type=oneshot/.test(unit), `${label}: the backup is a oneshot job, not a daemon`);
  ok(!/^Restart=/m.test(unit), `${label}: it does not retry in a loop when it fails`);
  // A [Install] WantedBy on the SERVICE is the classic way a scheduled job ends
  // up running once at boot and never again — the timer is what gets enabled.
  ok(!/WantedBy=multi-user\.target/.test(unit),
     `${label}: the service cannot be enabled instead of the timer`);
  ok(/SyslogIdentifier=pcc-backup/.test(unit), `${label}: its log lines are findable as pcc-backup`);
  ok(/--keep\s+\d+/.test(unit), `${label}: retention is stated as a number`);
  ok(/pcc-backup\.mjs/.test(unit), `${label}: it runs the proven backup script rather than its own copy`);
}

ok(/EnvironmentFile=\/etc\/pcc\.env/.test(nodeService),
   'node: the database path comes from the same file the application reads');
ok(/--db \$\{PCC_DATABASE_PATH\}/.test(nodeService),
   'node: so the backup cannot be pointed at a different database than the one served');
ok(/ReadWritePaths=\/var\/lib\/pcc/.test(nodeService),
   'node: it may write to the data directory and nowhere else');
ok(/User=pcc/.test(nodeService), 'node: it runs as the service account, not root');

ok(/--user 1000:1000/.test(dockerService),
   'docker: it runs as the uid that owns the volume, so backups are not root-owned');
ok(/\/scripts:ro/.test(dockerService), 'docker: the scripts are mounted read-only');
ok(/-v \$\{PCC_VOLUME\}:\/data/.test(dockerService), 'docker: it reads the volume PCC uses');

// The unit and the handoff must agree about where the script is installed. They
// were written at the same time and will drift at different times.
const EXEC_PATH = /ExecStart=\/usr\/bin\/node (\S+pcc-backup\.mjs)/.exec(nodeService)?.[1] ?? '';
const handoff = read('docs/deployment/PCC_IT_DEPLOYMENT_HANDOFF.md');
ok(EXEC_PATH !== '', 'node: the ExecStart names an absolute script path', EXEC_PATH);
ok(handoff.includes(EXEC_PATH.replace('/pcc-backup.mjs', '')),
   'and the handoff tells IT to install the scripts in that directory', EXEC_PATH);
for (const command of ['systemctl list-timers pcc-backup.timer', 'systemctl start pcc-backup.service',
                       'journalctl -u pcc-backup', '--check']) {
  ok(handoff.includes(command), `the handoff shows the operator how to: ${command}`);
}

// ---------------------------------------------------------------------------
console.log('--- the scripts IT copies onto the server ------------------------');

// The four the units and the runbook rely on. Anything importing outside
// node: needs the repository, its node_modules, or a build — none of which are
// on the server.
for (const script of ['pcc-backup.mjs', 'pcc-restore.mjs', 'pcc-reset-admin.mjs', 'pcc-storage-status.mjs']) {
  const src = read(join('scripts', script));
  const imports = [...src.matchAll(/^import .*?from '([^']+)';/gm)].map((m) => m[1]);
  const foreign = imports.filter((i) => !i.startsWith('node:'));
  ok(foreign.length === 0, `${script} runs on a bare Node install`, foreign.join(', '));
}

// ---------------------------------------------------------------------------
console.log('--- what the backup actually does -------------------------------');

const TMP = mkdtempSync(join(tmpdir(), 'pcc-backup-ops-'));
const DB = join(TMP, 'pcc.sqlite');
const OUT = join(TMP, 'backups');

const { openDatabase } = await import(join(APP, 'purchasing', 'infrastructure', 'sqlite', 'database.ts'));
const { seed } = await import(join(APP, 'purchasing', 'infrastructure', 'seed.ts'));
const db = openDatabase(DB);
seed(db, '2026-08-18T09:00:00.000Z');
db.close();

const SCRIPT = join(ROOT, 'scripts', 'pcc-backup.mjs');
const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};
const backups = () => readdirSync(OUT).filter((f) => f.endsWith('.sqlite'))
  .sort((a, b) => statSync(join(OUT, b)).mtimeMs - statSync(join(OUT, a)).mtimeMs);

const first = run(['--db', DB, '--out', OUT]);
ok(first.code === 0 && /verified — integrity ok/.test(first.out),
   'a backup is written and then reopened and verified', first.out.trim().split('\n').pop());
ok(/organization\(s\)/.test(first.out) && /purchase order\(s\)/.test(first.out),
   'and it reports what is in it, not just that a file appeared');
ok(/retention not requested/.test(first.out),
   'with no --keep it says so, because "no retention" and "forgot to set retention" look alike');

// --check is what somebody runs the morning after the timer fired.
const check = run(['--db', DB, '--out', OUT, '--check']);
ok(check.code === 0 && /verified — integrity ok/.test(check.out), 'the latest backup verifies on demand');
ok(/taken .* ago/.test(check.out), 'and it says how old it is — a stale backup is a failed backup');

const before = backups().length;
const checkedAgain = run(['--db', DB, '--out', OUT, '--check']);
ok(checkedAgain.code === 0 && backups().length === before,
   '--check writes nothing: it is safe on a live production system');

// Retention. The dangerous version of this deletes the copy it just made.
//
// A backup file carries the SECOND in its name and the script refuses to
// overwrite one, so every write in this section waits for the clock to move.
// That refusal is correct — two backups in one second would silently become
// one — and it is why this suite takes a few seconds.
const pause = () => execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 1100)']);

for (let i = 0; i < 3; i++) {
  pause();
  run(['--db', DB, '--out', OUT]);
}
ok(backups().length >= 4, 'several backups accumulate', String(backups().length));

const newestBefore = backups()[0];
pause();
const kept = run(['--db', DB, '--out', OUT, '--keep', '2']);
ok(kept.code === 0, 'a backup with retention succeeds');
ok(backups().length === 2, 'retention leaves exactly the requested number', String(backups().length));
ok(backups().includes(kept.out.match(/wrote \S+\/(\S+\.sqlite)/)?.[1] ?? ''),
   'and the copy this run just wrote and verified is one of the survivors');
ok(newestBefore !== backups()[0], 'the newest is the new one, not a leftover');
ok(/backup\(s\) retained/.test(kept.out), 'it reports how many remain, so a filling disk is visible');

pause();
const one = run(['--db', DB, '--out', OUT, '--keep', '1']);
ok(one.code === 0 && backups().length === 1,
   '--keep 1 leaves exactly one, and it is the one just verified', String(backups().length));

// A file that is present but not a database. This is the case that makes the
// difference between "a backup exists" and "a backup can be restored".
const corrupt = join(OUT, 'pcc-99999999T999999Z.sqlite');
copyFileSync(join(OUT, backups()[0]), corrupt);
writeFileSync(corrupt, Buffer.concat([Buffer.from('not a database at all'), readFileSync(corrupt).subarray(21)]));
const bad = run(['--db', DB, '--out', OUT, '--check', corrupt]);
ok(bad.code === 1, 'a corrupt backup FAILS verification rather than being reported as present');
ok(/unusable/.test(bad.out), 'and the operator is told to take a new one', bad.out.trim().split('\n').pop());

const missing = run(['--db', DB, '--out', join(TMP, 'no-such-dir'), '--check']);
ok(missing.code === 1 && /no backup found/.test(missing.out),
   'an empty backup directory is a failure, not a silent pass');

rmSync(TMP, { recursive: true, force: true });

console.log('');
for (const f of fails) console.log(`FAILED: ${f}`);
console.log(`backup operations checks: ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
