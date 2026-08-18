// ---------------------------------------------------------------------------
// pcc-verify-deployment.mjs — is THIS INSTALLATION safe and operational?
//
// THE ONE COMMAND TO RUN ON THE SERVER, after installing and after every
// restart, reboot or update. It is the question none of the existing checks
// answers on its own, because each of them answers a different one:
//
//   pcc-preflight.mjs          is this MACHINE ready to run PCC?      (before)
//   check-deployable.mjs       is this BUILD safe to ship?            (build)
//   pcc-verify-production.mjs  is this DATABASE fit for a real pilot? (data)
//   pcc-storage-status.mjs     how much room is left?                 (disk)
//   pcc-backup.mjs --check     is the latest backup usable?           (backup)
//   /api/health                is the running app configured + migrated?
//   /api/health/live           is the process alive?
//
// SO THIS ORCHESTRATES THEM RATHER THAN REIMPLEMENTING THEM. Every check below
// is either a sub-run of one of the above — reported with its own verdict — or
// something genuinely new, which is only ever about the INSTALLATION: is the
// service running under supervision, is the timer armed, does the app answer at
// the address people type, is it a production build rather than a dev server.
// Duplicating a working check to make a nicer report is how two copies of a
// rule start disagreeing about production.
//
// STRICTLY NON-DESTRUCTIVE.
//   · it never writes to the database. The write-path check takes an immediate
//     transaction and rolls it back, which proves the file is writable and the
//     lock is obtainable without changing a row.
//   · it never restores a backup. Proving a restore works is
//     scripts/restore-rehearsal.sh, which builds its own throwaway instance.
//   · it never creates a user, a request or a purchase order.
//   · it never prints a secret. Configuration is reported as PRESENT or MISSING
//     and nothing else — not a value, not a length, not a prefix.
//
//   node scripts/pcc-verify-deployment.mjs
//   node scripts/pcc-verify-deployment.mjs --base-url https://pcc.lippolis.example
//   node scripts/pcc-verify-deployment.mjs --db /var/lib/pcc/pcc.sqlite --json
//
//   --base-url  where PCC answers. Default: $APP_BASE_URL, then localhost:$PORT
//   --db        the live database. Default: $PCC_DATABASE_PATH
//   --service   the service PCC runs as — systemd unit or Windows service. Default: pcc
//   --timer     the backup timer unit (Linux). Default: pcc-backup.timer
//   --task      the backup scheduled task (Windows). Default: PCC Nightly Backup
//   --json      machine-readable, for whatever monitoring already exists
//   --strict    treat every warning as a blocker
//
// Exit 0 = ready for acceptance testing. Exit 1 = a genuine production blocker.
// UNVERIFIED never fails the run on its own: "I could not check this from
// here" is not the same claim as "this is broken", and a check that fails for
// being run from the wrong machine teaches people to ignore the report.
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
}
const JSON_OUT = process.argv.includes('--json');
const STRICT = process.argv.includes('--strict');

const dbPath = arg('db') ?? process.env.PCC_DATABASE_PATH ?? process.env.PURCHASING_DB_PATH ?? '';
const port = process.env.PORT ?? '3000';
const baseUrl = (arg('base-url') ?? process.env.APP_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const serviceUnit = arg('service') ?? 'pcc';
const timerUnit = arg('timer') ?? 'pcc-backup.timer';
// The Windows equivalent of the timer unit: a Task Scheduler task name.
const taskName = arg('task') ?? 'PCC Nightly Backup';

// ---------------------------------------------------------------------------
// Results.
//
// Five verdicts, and the distinction between the last three is the whole point
// of this report:
//
//   PASS            checked, and correct
//   WARN            checked, imperfect, not a reason to stop
//   BLOCKED         checked, and wrong. A person cannot use PCC, or can lose data
//   UNVERIFIED      NOT CHECKED. No claim is made either way
//   NOT CONFIGURED  deliberately absent, and PCC works without it
//
// An integration is never reported as working because an environment variable
// exists. That is the single most common lie in a deployment report.
// ---------------------------------------------------------------------------
const sections = new Map();
const add = (section, id, status, detail, fix = null) => {
  if (!sections.has(section)) sections.set(section, []);
  sections.get(section).push({ id, status, detail, fix });
};

const runNode = (script, args = []) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8', timeout: 120000,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const systemctl = (...args) => {
  const r = spawnSync('systemctl', args, { encoding: 'utf8', timeout: 20000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), missing: r.error != null };
};
const haveSystemd = process.platform === 'linux' && !systemctl('--version').missing;

// --- Windows service supervision -------------------------------------------
// The same three questions systemd answers — is it running, does it come back
// at boot, is it a production build — asked of the Service Control Manager.
//
// `sc.exe` rather than Get-Service: no PowerShell process to spawn per query,
// and a stable output format that has not changed in twenty years.
const sc = (...args) => {
  const r = spawnSync('sc.exe', args, { encoding: 'utf8', timeout: 20000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), missing: r.error != null };
};
const haveWindowsServices = process.platform === 'win32' && !sc('query', 'Schedule').missing;

// NSSM keeps the supervised command in the registry, not in BINARY_PATH_NAME —
// that points at nssm.exe for every service it manages, so reading it would
// tell us nothing about which application is being run.
const nssmParam = (service, name) => {
  const r = spawnSync('reg.exe', [
    'query', `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${service}\\Parameters`, '/v', name,
  ], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) return null;
  const m = new RegExp(`${name}\\s+REG_[A-Z_]+\\s+(.*)`).exec(r.stdout ?? '');
  return m ? m[1].trim() : null;
};

// ---------------------------------------------------------------------------
// APPLICATION — is it answering, and is it the production build?
// ---------------------------------------------------------------------------
{
  // TWO ADDRESSES, BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS.
  //
  // APP_BASE_URL is what people type, and checking it is the point. But on a
  // real server it very often does not resolve FROM the server — split-horizon
  // DNS, a name that only exists on the office network, a proxy in front. Found
  // on the deployment dry run: a correctly installed, healthy PCC reported
  // "nothing answered", which is the report crying wolf on its first outing.
  //
  // So: if the local address answers and the public one does not, PCC IS UP and
  // what is wrong is name resolution or the proxy — a warning naming exactly
  // that, checked from a workstation. Only both failing is a blocker.
  const localUrl = `http://127.0.0.1:${port}`;
  const probe = async (url) => {
    try {
      const r = await fetch(`${url}/api/health/live`, { redirect: 'manual' });
      return { status: r.status, body: await r.text() };
    } catch (err) {
      return { error: err.message };
    }
  };

  const configured = await probe(baseUrl);
  const localOnly = baseUrl === localUrl ? configured : await probe(localUrl);
  const answered = (p) => !p.error && p.status === 200 && /alive/.test(p.body);

  let live = configured;
  if (answered(configured)) {
    add('Application', 'process.answering', 'PASS', `${baseUrl} is serving`);
  } else if (answered(localOnly)) {
    live = localOnly;
    add('Application', 'process.answering', 'WARN',
        `PCC is serving on ${localUrl}, but ${baseUrl} did not answer from this machine`,
        'The application is up. This is DNS or the reverse proxy, not PCC — confirm the address from a workstation before letting people use it.');
  } else if (configured.error) {
    add('Application', 'process.answering', 'BLOCKED', `nothing answered at ${baseUrl} or ${localUrl} — ${configured.error}`,
        `Check the service: systemctl status ${serviceUnit}; journalctl -u ${serviceUnit} -n 50`);
  } else {
    add('Application', 'process.answering', 'BLOCKED', `${baseUrl}/api/health/live answered ${configured.status}`);
  }

  const healthBase = answered(configured) ? baseUrl : answered(localOnly) ? localUrl : null;
  if (healthBase) {
    let health = null;
    try {
      const r = await fetch(`${healthBase}/api/health`, { redirect: 'manual' });
      health = { status: r.status, body: await r.json() };
    } catch (err) {
      health = { error: err.message };
    }

    if (health?.error) {
      add('Application', 'health.readiness', 'BLOCKED', `/api/health did not answer — ${health.error}`);
    } else {
      const b = health.body ?? {};
      const failing = Object.entries(b.checks ?? {})
        .filter(([, c]) => !c.ok)
        .map(([k, c]) => `${k}${c.detail ? `: ${c.detail}` : ''}`);
      if (health.status === 200 && b.status === 'ok') {
        add('Application', 'health.readiness', 'PASS', 'configured, migrated and reading the database');
      } else {
        add('Application', 'health.readiness', 'BLOCKED', `/api/health is ${health.status} — ${failing.join('; ') || b.status}`,
            'The detail names the variable or the store, never its value. Fix it and restart.');
      }

      // WHICH BUILD IS THIS? An unstamped installation cannot be identified
      // later, which turns "did the fix go out?" into an argument.
      add('Application', 'release.stamped',
          b.release ? 'PASS' : 'WARN',
          b.release ? `release ${b.release}` : 'PCC_RELEASE is not set — /api/health reports release: null',
          b.release ? null : 'Set PCC_RELEASE to the deployed commit in the environment file. See SOURCE_OF_TRUTH.md.');

      add('Application', 'schema.reported', b.schema ? 'PASS' : 'WARN',
          b.schema ? `schema ${b.schema}` : 'no schema version reported');
      add('Application', 'provider.reported', 'PASS',
          `auth: ${b.authProvider ?? '?'}, persistence: ${b.persistence ?? '?'}, numbering: ${b.poNumbering ?? 'unset'}`);
    }
  }

  // PRODUCTION BUILD, NOT A DEVELOPMENT SERVER. `next dev` would serve every
  // page and pass every check above while recompiling on each request, keeping
  // the source tree on the machine and disabling the protections that only
  // exist in a production start.
  if (haveSystemd) {
    const cmd = systemctl('show', serviceUnit, '-p', 'ExecStart', '--value');
    const text = cmd.out;
    if (!cmd.ok || !text) {
      add('Application', 'runtime.production_mode', 'UNVERIFIED', `could not read ExecStart for ${serviceUnit}`);
    } else if (/next\s+dev|npm\s+run\s+dev/.test(text)) {
      add('Application', 'runtime.production_mode', 'BLOCKED',
          `${serviceUnit} starts a DEVELOPMENT server`,
          'Production runs the standalone build: node apps/purchasing/server.js, or the container image.');
    } else {
      add('Application', 'runtime.production_mode', 'PASS', 'the unit starts a production build');
    }
  } else if (haveWindowsServices) {
    const app = nssmParam(serviceUnit, 'Application');
    const params = nssmParam(serviceUnit, 'AppParameters');
    const text = `${app ?? ''} ${params ?? ''}`.trim();
    if (!text) {
      add('Application', 'runtime.production_mode', 'UNVERIFIED',
          `could not read the supervised command for ${serviceUnit}`,
          `sc.exe qc ${serviceUnit} — and check it was installed with nssm`);
    } else if (/next\s+dev|npm\s+run\s+dev/.test(text)) {
      add('Application', 'runtime.production_mode', 'BLOCKED',
          `${serviceUnit} starts a DEVELOPMENT server`,
          'Production runs the standalone build: node apps\\purchasing\\server.js');
    } else if (/server\.js/.test(text)) {
      add('Application', 'runtime.production_mode', 'PASS', 'the service starts a production build');
    } else {
      add('Application', 'runtime.production_mode', 'UNVERIFIED',
          `the service runs something unrecognised: ${text}`);
    }
  } else {
    add('Application', 'runtime.production_mode', 'UNVERIFIED',
        'no service manager here — run this on the server to check how PCC is started');
  }

  // SUPERVISION. A PCC that answers today but is not enabled comes back from a
  // reboot as an outage nobody chose.
  if (haveSystemd) {
    const active = systemctl('is-active', serviceUnit);
    const enabled = systemctl('is-enabled', serviceUnit);
    add('Application', 'service.active', active.ok ? 'PASS' : 'BLOCKED',
        `systemctl is-active ${serviceUnit} → ${active.out || 'unknown'}`,
        active.ok ? null : `systemctl status ${serviceUnit}`);
    add('Application', 'service.enabled', /enabled/.test(enabled.out) ? 'PASS' : 'BLOCKED',
        `systemctl is-enabled ${serviceUnit} → ${enabled.out || 'unknown'}`,
        /enabled/.test(enabled.out) ? null : `sudo systemctl enable ${serviceUnit} — otherwise PCC does not come back from a reboot`);
  } else if (haveWindowsServices) {
    const q = sc('query', serviceUnit);
    if (!q.ok && /1060/.test(q.out)) {
      add('Application', 'service.active', 'BLOCKED',
          `there is no Windows service named ${serviceUnit}`,
          'PCC is answering but nothing supervises it — it will not come back from a reboot. ' +
          'Install it: .\\scripts\\install-production.ps1');
      add('Application', 'service.enabled', 'BLOCKED', `no service named ${serviceUnit}`);
    } else {
      const running = /STATE\s+:\s+4\s+RUNNING/.test(q.out);
      add('Application', 'service.active', running ? 'PASS' : 'BLOCKED',
          `sc query ${serviceUnit} → ${running ? 'RUNNING' : (q.out.match(/STATE\s+:\s+\d+\s+(\w+)/)?.[1] ?? 'unknown')}`,
          running ? null : `sc query ${serviceUnit} — and read the refusal in the service's err.log`);

      const cfg = sc('qc', serviceUnit);
      const auto = /START_TYPE\s+:\s+2\s+AUTO_START/.test(cfg.out);
      add('Application', 'service.enabled', auto ? 'PASS' : 'BLOCKED',
          `sc qc ${serviceUnit} → ${cfg.out.match(/START_TYPE\s+:\s+\d+\s+(\w+)/)?.[1] ?? 'unknown'}`,
          auto ? null : `sc config ${serviceUnit} start= auto — otherwise PCC does not come back from a reboot`);

      // THE REFUSAL INVARIANT. A configuration refusal exits 1, and a supervisor
      // that restarts it loops forever and buries the one line saying what is
      // wrong. This is the Windows half of RestartPreventExitStatus=1, and it is
      // silently absent if somebody recreated the service by hand.
      const exit1 = nssmParam(serviceUnit, 'AppExit');
      if (exit1 === null) {
        add('Application', 'service.refusal_policy', 'UNVERIFIED',
            'could not read the exit policy — was the service created by install-production.ps1?');
      } else {
        add('Application', 'service.refusal_policy', /Exit/i.test(exit1) ? 'PASS' : 'BLOCKED',
            `exit policy: ${exit1}`,
            /Exit/i.test(exit1) ? null
              : `nssm set ${serviceUnit} AppExit 1 Exit — otherwise a configuration refusal restarts forever`);
      }
    }
  } else {
    add('Application', 'service.active', 'UNVERIFIED', 'no service manager here — check on the server');
    add('Application', 'service.enabled', 'UNVERIFIED', 'no service manager here — check on the server');
  }
}

// ---------------------------------------------------------------------------
// DATABASE — the intended file, readable, writable, migrated, and fit.
// ---------------------------------------------------------------------------
{
  if (!dbPath) {
    add('Database', 'database.path', 'BLOCKED', 'PCC_DATABASE_PATH is not set in this environment',
        'Run this with the same environment PCC runs with, or pass --db.');
  } else if (!isAbsolute(dbPath)) {
    add('Database', 'database.path', 'BLOCKED', 'the database path is relative, which depends on the working directory');
  } else if (!existsSync(dbPath)) {
    add('Database', 'database.path', 'BLOCKED', `no database at ${dbPath}`,
        'If PCC is running, it opened a DIFFERENT file — the volume is probably not mounted where you think.');
  } else {
    add('Database', 'database.path', 'PASS', `${dbPath}`);

    // IS THE RECORD OUTSIDE THE APPLICATION? A database inside the checkout is
    // deleted by the next deployment.
    const inSourceTree = dbPath.startsWith(join(ROOT, '')) && !dbPath.startsWith(join(ROOT, '..'));
    add('Database', 'database.outside_source_tree', inSourceTree ? 'BLOCKED' : 'PASS',
        inSourceTree ? `${dbPath} is inside the application directory — an update would delete it` : 'the records live outside the application directory',
        inSourceTree ? 'Move it to a persistent directory (e.g. /var/lib/pcc) and set PCC_DATABASE_PATH.' : null);

    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const version = db.prepare('select value from schema_meta where key = ?').get('version')?.value ?? 'none';
      const orgs = db.prepare('select count(*) as n from orgs').get().n;
      db.close();
      add('Database', 'database.readable', 'PASS', `read ok — schema ${version}, ${orgs} organization(s)`);
    } catch (err) {
      add('Database', 'database.readable', 'BLOCKED', `cannot read it — ${err.message}`);
    }

    // WRITABILITY, WITHOUT WRITING ANYTHING. An immediate transaction takes the
    // same lock a real write takes, on the same file, as this user — and the
    // rollback leaves the contents byte-identical.
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('begin immediate');
      db.exec('rollback');
      db.close();
      add('Database', 'database.writable', 'PASS', 'a write lock can be taken (transaction rolled back, nothing changed)');
    } catch (err) {
      add('Database', 'database.writable', 'BLOCKED', `cannot take a write lock — ${err.message}`,
          'Usually ownership: the database AND its directory must be writable by the service account.');
    }
  }

  // FITNESS OF THE CONTENTS — delegated, not reimplemented.
  //
  // WITH ONE DISTINCTION THIS REPORT HAS TO MAKE AND THAT ONE DOES NOT.
  // pcc-verify-production asks whether the database is ready to ISSUE PURCHASE
  // ORDERS, so on a freshly installed server it correctly says no: there are no
  // vendors yet, because entering them is a later step performed by the office
  // in Administration. Found on the deployment dry run — a perfectly installed
  // machine reported NOT READY at the moment the checklist says to verify it,
  // which would teach the operator that the gate is noise on day one.
  //
  // An EMPTY database is an installation waiting for its data. A database with
  // data in it that still fails fitness is a real problem — demo rows, a vendor
  // with no purchase order code, an unresolved paper sequence. So the fresh case
  // warns and points at the acceptance step that fills it in; every other case
  // blocks, exactly as before.
  const fitness = runNode('pcc-verify-production.mjs', dbPath ? ['--db', dbPath] : []);
  const problems = /NOT READY — (\d+) problem/.exec(fitness.out)?.[1] ?? null;
  let unprovisioned = false;
  if (fitness.code !== 0 && dbPath && existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const n = (t) => db.prepare(`select count(*) as n from ${t}`).get().n;
      unprovisioned = n('vendors') === 0 && n('jobs') === 0 && n('purchase_requests') === 0;
      db.close();
    } catch { unprovisioned = false; }
  }
  add('Database', 'database.fit_for_production',
      fitness.code === 0 ? (/warning\(s\)/.test(fitness.out) ? 'WARN' : 'PASS') : unprovisioned ? 'WARN' : 'BLOCKED',
      fitness.code === 0
        ? (/warning\(s\)/.test(fitness.out) ? 'no blocking problems, with warnings — run pcc-verify-production.mjs to read them' : 'no demonstration data; every pilot setting configured')
        : unprovisioned
          ? 'the database is installed and empty — the company\'s vendors, jobs and people have not been entered yet'
          : `pcc-verify-production reports ${problems ?? 'a'} problem(s)`,
      fitness.code === 0 ? null
        : unprovisioned
          ? 'Expected on a fresh installation. Enter them in Administration — PCC_PRODUCTION_ACCEPTANCE.md section B, then C.'
          : `node scripts/pcc-verify-production.mjs${dbPath ? ` --db ${dbPath}` : ''}`);
}

// ---------------------------------------------------------------------------
// CONFIGURATION — presence and validity. NEVER values.
// ---------------------------------------------------------------------------
{
  // The shared, already-tested environment rules. Running the real validator
  // means this report cannot disagree with what PCC does on start.
  const { validateEnvironment } = await import(
    join(ROOT, 'apps/purchasing/src/purchasing/infrastructure/env.ts')
  );
  const { ok, problems } = validateEnvironment(process.env);
  const errors = problems.filter((p) => p.level === 'error');
  const warnings = problems.filter((p) => p.level === 'warning');

  // MOST OF THOSE RULES ONLY BITE IN PRODUCTION, which is correct — and would
  // otherwise let this line report "complete and consistent" on a machine where
  // nothing is set, directly above five BLOCKED rows saying it is not.
  if (process.env.NODE_ENV !== 'production') {
    add('Configuration', 'config.valid', 'UNVERIFIED',
        `NODE_ENV is ${process.env.NODE_ENV ?? 'unset'}, so the production configuration rules were not applied`,
        'Run this with the environment PCC runs with — the same file the service loads.');
  } else {
    add('Configuration', 'config.valid', ok ? 'PASS' : 'BLOCKED',
        ok ? 'the configuration PCC validates on start is complete and consistent'
           : errors.map((p) => `${p.variable}: ${p.message}`).join(' | '),
        ok ? null : 'PCC refuses to start in this state. Fix the named variables.');
  }
  for (const w of warnings) add('Configuration', `config.${w.variable}`, 'WARN', w.message);

  // PRESENCE ONLY. Never the value, never the length, never a prefix.
  for (const [name, required] of [
    ['NODE_ENV', true], ['SESSION_SECRET', true], ['PCC_DATABASE_PATH', true],
    ['APP_BASE_URL', true], ['PCC_PO_NUMBERING', true], ['PCC_RELEASE', false],
  ]) {
    const present = Boolean((process.env[name] ?? '').trim());
    add('Configuration', `secret.${name}`,
        present ? 'PASS' : required ? 'BLOCKED' : 'WARN',
        present ? 'present' : 'not set');
  }

  // These two must NOT survive the first start.
  for (const name of ['PCC_BOOTSTRAP_ADMIN_PASSWORD', 'PCC_DATABASE_ALLOW_CREATE']) {
    const present = Boolean((process.env[name] ?? '').trim());
    add('Configuration', `firstrun.${name}`, present ? 'WARN' : 'PASS',
        present ? 'still set — correct for the FIRST start only' : 'removed after first start',
        present ? `Remove ${name} from the environment file and restart.` : null);
  }
  add('Configuration', 'config.production_mode',
      process.env.NODE_ENV === 'production' ? 'PASS' : 'BLOCKED',
      `NODE_ENV=${process.env.NODE_ENV ?? 'unset'}`);
}

// ---------------------------------------------------------------------------
// PERSISTENT STORAGE
// ---------------------------------------------------------------------------
{
  const dataDir = dbPath ? dirname(dbPath) : null;
  if (!dataDir) {
    add('Persistent storage', 'storage.data_dir', 'UNVERIFIED', 'no database path to derive it from');
  } else {
    add('Persistent storage', 'storage.data_dir', existsSync(dataDir) ? 'PASS' : 'BLOCKED', `${dataDir}`);
    let writable = false;
    try {
      const probe = join(dataDir, `.pcc-verify-${process.pid}`);
      writeFileSync(probe, '');
      unlinkSync(probe);
      writable = true;
    } catch { /* reported below */ }
    add('Persistent storage', 'storage.writable', writable ? 'PASS' : 'BLOCKED',
        writable ? 'writable by this account' : `not writable by this account (uid ${typeof process.getuid === 'function' ? process.getuid() : '?'})`,
        writable ? null : 'SQLite writes -wal and -shm beside the database. chown the directory to the service account.');

    const backupDir = join(dataDir, 'backups');
    add('Persistent storage', 'storage.backup_dir', existsSync(backupDir) ? 'PASS' : 'WARN',
        existsSync(backupDir) ? `${backupDir}` : `${backupDir} does not exist yet — the first backup creates it`);
  }
}

// ---------------------------------------------------------------------------
// AUTHENTICATION — is there enough here to provision and admit real people?
// ---------------------------------------------------------------------------
{
  if (!dbPath || !existsSync(dbPath)) {
    add('Authentication', 'auth.credentials', 'UNVERIFIED', 'no database to read');
  } else {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const enabled = db.prepare('select count(*) as n from auth_identities where disabled = 0').get().n;
      const admins = db.prepare(
        `select count(*) as n from users u
           join user_roles r on r.user_id = u.id and r.role_key = 'ADMIN'
           join auth_identities i on i.user_id = u.id
          where i.disabled = 0 and u.is_active = 1`,
      ).get().n;
      const columns = db.prepare('pragma table_info(auth_identities)').all().map((c) => c.name);
      const hasFlag = columns.includes('must_change_password');
      const temporary = hasFlag
        ? db.prepare('select count(*) as n from auth_identities where must_change_password = 1 and disabled = 0').get().n
        : null;
      db.close();

      add('Authentication', 'auth.can_sign_in', enabled > 0 ? 'PASS' : 'BLOCKED',
          `${enabled} enabled credential(s)`,
          enabled > 0 ? null
            : 'Nobody can sign in. Set PCC_BOOTSTRAP_ADMIN_EMAIL/_PASSWORD and restart once, or run scripts/pcc-reset-admin.mjs.');
      add('Authentication', 'auth.administrator_exists', admins > 0 ? 'PASS' : 'BLOCKED',
          `${admins} active administrator(s) with a credential`,
          admins > 0 ? null : 'Nobody can provision users. See scripts/pcc-reset-admin.mjs --list.');
      add('Authentication', 'auth.forced_change_available', hasFlag ? 'PASS' : 'WARN',
          hasFlag ? 'temporary passwords must be replaced before an account can be used'
                  : 'this database predates the forced password change — migrations may not have run');
      if (temporary !== null) {
        add('Authentication', 'auth.temporary_outstanding', temporary === 0 ? 'PASS' : 'WARN',
            temporary === 0
              ? 'no account is still on a password somebody else chose'
              : `${temporary} account(s) still hold a temporary password`,
            temporary === 0 ? null : 'Expected right after provisioning. Each person clears it by signing in and choosing their own.');
      }
    } catch (err) {
      add('Authentication', 'auth.credentials', 'BLOCKED', `could not read the credential store — ${err.message}`);
    }
  }

  const recovery = join(ROOT, 'scripts', 'pcc-reset-admin.mjs');
  add('Authentication', 'auth.recovery_available', existsSync(recovery) ? 'PASS' : 'WARN',
      existsSync(recovery) ? 'break-glass recovery is present (scripts/pcc-reset-admin.mjs)'
                           : 'scripts/pcc-reset-admin.mjs is not on this machine — an admin lockout would need one');
}

// ---------------------------------------------------------------------------
// BACKUP — the tooling, the schedule, and the latest artifact.
// ---------------------------------------------------------------------------
{
  for (const script of ['pcc-backup.mjs', 'pcc-restore.mjs']) {
    const there = existsSync(join(ROOT, 'scripts', script));
    add('Backup tooling', `backup.${script}`, there ? 'PASS' : 'BLOCKED',
        there ? 'installed' : 'missing');
  }

  if (dbPath && existsSync(dbPath)) {
    const check = runNode('pcc-backup.mjs', ['--db', dbPath, '--check']);
    if (check.code === 0) {
      const age = /taken (.+) ago/.exec(check.out)?.[1] ?? 'unknown age';
      const summary = /verified — (.+)/.exec(check.out)?.[1] ?? 'verified';
      const hours = /(\d+) hour/.exec(age);
      const stale = hours && Number(hours[1]) > 48;
      add('Backup tooling', 'backup.latest_usable', stale ? 'WARN' : 'PASS',
          `latest backup verified — ${summary}; taken ${age} ago`,
          stale ? 'Older than two days. Check the timer, and read journalctl -u pcc-backup.' : null);
    } else {
      const none = /no backup found/.test(check.out);
      add('Backup tooling', 'backup.latest_usable', none ? 'WARN' : 'BLOCKED',
          none ? 'no backup has been taken yet' : 'the latest backup FAILED verification',
          none ? `sudo systemctl start pcc-backup.service — or node scripts/pcc-backup.mjs --db ${dbPath}`
               : 'Treat it as unusable and take a new one immediately.');
    }
  } else {
    add('Backup tooling', 'backup.latest_usable', 'UNVERIFIED', 'no database to look beside');
  }

  if (haveSystemd) {
    const active = systemctl('is-active', timerUnit);
    const enabled = systemctl('is-enabled', timerUnit);
    add('Backup schedule', 'timer.active', active.ok ? 'PASS' : 'BLOCKED',
        `systemctl is-active ${timerUnit} → ${active.out || 'unknown'}`,
        active.ok ? null : `sudo systemctl enable --now ${timerUnit} — see PCC_IT_DEPLOYMENT_HANDOFF.md §8a`);
    add('Backup schedule', 'timer.enabled', /enabled/.test(enabled.out) ? 'PASS' : 'BLOCKED',
        `systemctl is-enabled ${timerUnit} → ${enabled.out || 'unknown'}`,
        /enabled/.test(enabled.out) ? null : `sudo systemctl enable ${timerUnit}`);
    const last = systemctl('show', 'pcc-backup.service', '-p', 'Result', '--value');
    add('Backup schedule', 'timer.last_result',
        !last.out ? 'UNVERIFIED' : last.out === 'success' ? 'PASS' : 'BLOCKED',
        last.out ? `last run: ${last.out}` : 'the backup service has not run yet',
        last.out === 'success' || !last.out ? null : 'journalctl -u pcc-backup -n 30');
    const timers = systemctl('list-timers', timerUnit, '--all', '--no-pager');
    add('Backup schedule', 'timer.next_run', timers.ok && /pcc-backup/.test(timers.out) ? 'PASS' : 'UNVERIFIED',
        timers.ok && /pcc-backup/.test(timers.out) ? 'the timer is listed and reports a next run' : 'not listed');
  } else if (haveWindowsServices) {
    // schtasks rather than Get-ScheduledTask, for the same reason as sc.exe:
    // no PowerShell to spawn, and a format that parses.
    const q = spawnSync('schtasks.exe', ['/query', '/tn', taskName, '/fo', 'LIST', '/v'],
      { encoding: 'utf8', timeout: 20000 });
    const out = `${q.stdout ?? ''}${q.stderr ?? ''}`;
    if (q.status !== 0) {
      add('Backup schedule', 'timer.active', 'BLOCKED',
          `there is no scheduled task named "${taskName}"`,
          'Nothing is backing PCC up. Create it: .\\scripts\\install-backup-task.ps1 -DataDir <data> -Repo <install path>');
      add('Backup schedule', 'timer.enabled', 'BLOCKED', 'no scheduled task');
      add('Backup schedule', 'timer.last_result', 'BLOCKED', 'no scheduled task');
    } else {
      const enabled = /Scheduled Task State:\s*Enabled/i.test(out) || /Status:\s*Ready/i.test(out);
      add('Backup schedule', 'timer.active', enabled ? 'PASS' : 'BLOCKED',
          `the task "${taskName}" is ${enabled ? 'enabled' : 'DISABLED'}`,
          enabled ? null : `schtasks /change /tn "${taskName}" /enable`);
      add('Backup schedule', 'timer.enabled', enabled ? 'PASS' : 'BLOCKED',
          enabled ? 'it will run on its schedule' : 'it will not run');

      const result = /Last Result:\s*(-?\d+)/i.exec(out)?.[1];
      const ran = /Last Run Time:\s*(.+)/i.exec(out)?.[1]?.trim();
      const neverRan = !ran || /^N\/A|11\/30\/1999/i.test(ran);
      add('Backup schedule', 'timer.last_result',
          neverRan ? 'UNVERIFIED' : result === '0' ? 'PASS' : 'BLOCKED',
          neverRan ? 'the backup task has not run yet' : `last run: ${ran}, result ${result}`,
          neverRan || result === '0' ? null
            : 'Read the log: Get-Content C:\\ProgramData\\pcc\\logs\\pcc-backup.log -Tail 40');

      const next = /Next Run Time:\s*(.+)/i.exec(out)?.[1]?.trim();
      add('Backup schedule', 'timer.next_run', next && !/N\/A/i.test(next) ? 'PASS' : 'UNVERIFIED',
          next ? `next run: ${next}` : 'no next run reported');
    }
  } else {
    add('Backup schedule', 'timer.active', 'UNVERIFIED', 'no service manager here — check on the server');
    add('Backup schedule', 'timer.enabled', 'UNVERIFIED', 'no service manager here — check on the server');
    add('Backup schedule', 'timer.last_result', 'UNVERIFIED', 'no service manager here — check on the server');
  }
}

// ---------------------------------------------------------------------------
// INTEGRATIONS — reported as what they ARE, not as what a variable implies.
// ---------------------------------------------------------------------------
{
  // VENDOR EMAIL. PCC composes drafts and CANNOT send: a database constraint
  // pins external sending off. That is the designed state, so it is reported as
  // configured-and-working rather than as something missing.
  let sendEnabled = null;
  if (dbPath && existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare('select external_send_enabled from system_settings limit 1').get();
      sendEnabled = row ? Boolean(row.external_send_enabled) : null;
      db.close();
    } catch { sendEnabled = null; }
  }
  if (sendEnabled === false) {
    add('Email', 'email.mode', 'PASS',
        'CONFIGURED — PCC composes vendor email as a draft and cannot send it. A person sends from their own mailbox.');
  } else if (sendEnabled === true) {
    add('Email', 'email.mode', 'WARN', 'external sending is enabled in this database — UNVERIFIED, no transport is tested here');
  } else {
    add('Email', 'email.mode', 'UNVERIFIED', 'could not read the email setting from the database');
  }
  add('Email', 'email.transport', 'NOT CONFIGURED',
      'no SMTP is configured, and none is required — there is nothing to configure because PCC does not send');

  // PRINTING. The browser prints. There is no driver, queue or credential, so
  // there is nothing here that could be "configured" — and claiming a printer
  // works because a variable exists is exactly the lie this section avoids.
  add('Printing', 'printing.mode', 'PASS',
      'CONFIGURED — approving lands on the purchase order with the print dialogue open; the same document downloads as a stored PDF');
  add('Printing', 'printing.direct_to_printer', 'NOT CONFIGURED',
      'PCC does not drive a named printer. UNVERIFIED by design: it prints to whatever that PC already prints to');

  // TLS / HOSTNAME.
  const base = process.env.APP_BASE_URL ?? '';
  const acknowledged = (process.env.PCC_ALLOW_INSECURE_HTTP ?? '').trim() === '1';
  if (/^https:\/\//i.test(base)) {
    add('TLS/hostname', 'tls.scheme', 'PASS', `${base} — session cookies are Secure`);
  } else if (/^http:\/\//i.test(base) && acknowledged) {
    add('TLS/hostname', 'tls.scheme', 'WARN',
        `${base} — plain HTTP, accepted deliberately (PCC_ALLOW_INSECURE_HTTP=1). Session cookies cross the network in clear text.`,
        'Correct only on a trusted internal network. Revisit when TLS is available.');
  } else if (/^http:\/\//i.test(base)) {
    add('TLS/hostname', 'tls.scheme', 'BLOCKED', `${base} is plain HTTP and nothing records that as a decision — PCC will refuse to start`);
  } else {
    add('TLS/hostname', 'tls.scheme', 'BLOCKED', 'APP_BASE_URL is not an absolute URL');
  }
  add('TLS/hostname', 'tls.terminator', 'UNVERIFIED',
      'PCC does not terminate TLS and cannot see what is in front of it — confirm the proxy and certificate with whoever owns them');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const ORDER = ['Application', 'Database', 'Configuration', 'Persistent storage', 'Authentication',
               'Backup tooling', 'Backup schedule', 'Email', 'Printing', 'TLS/hostname'];
// NOT CONFIGURED ranks WITH pass, not below it. It means "deliberately absent,
// and PCC works without it" — printing drives no named printer and there is no
// mail transport because PCC cannot send. Ranking it as a lesser outcome would
// print `Printing: NOT CONFIGURED` for a printing setup that works.
const rank = { BLOCKED: 0, WARN: 1, UNVERIFIED: 2, PASS: 3, 'NOT CONFIGURED': 3 };
const verdictOf = (rows) => rows.reduce((worst, r) => (rank[r.status] < rank[worst] ? r.status : worst), 'PASS');

const blockers = [];
for (const [, rows] of sections) for (const r of rows) {
  if (r.status === 'BLOCKED' || (STRICT && r.status === 'WARN')) blockers.push(r);
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    baseUrl, database: dbPath || null,
    sections: Object.fromEntries([...sections].map(([k, v]) => [k, { verdict: verdictOf(v), checks: v }])),
    ready: blockers.length === 0,
    blocking: blockers.map((b) => ({ id: b.id, detail: b.detail, fix: b.fix })),
  }, null, 2));
  process.exit(blockers.length ? 1 : 0);
}

console.log('');
console.log('PCC PRODUCTION VERIFICATION');
console.log(`  address:  ${baseUrl}`);
console.log(`  database: ${dbPath || '(not set)'}`);
console.log('');

const width = Math.max(...ORDER.map((s) => s.length)) + 1;
for (const name of ORDER) {
  const rows = sections.get(name);
  if (!rows) continue;
  console.log(`${(name + ':').padEnd(width)} ${verdictOf(rows)}`);
  for (const r of rows) {
    console.log(`    ${r.status.padEnd(14)} ${r.id.padEnd(32)} ${r.detail}`);
    if (r.fix && (r.status === 'BLOCKED' || r.status === 'WARN')) console.log(`                   → ${r.fix}`);
  }
  console.log('');
}

console.log('OVERALL:');
if (!blockers.length) {
  console.log('  READY FOR ACCEPTANCE TESTING');
  console.log('');
  console.log('  Next: docs/deployment/PCC_PRODUCTION_ACCEPTANCE.md — provision the real users,');
  console.log('  run one real purchase order, reboot, and verify again.');
} else {
  console.log('  NOT READY');
  console.log('');
  console.log('  Blocking:');
  for (const b of blockers) {
    console.log(`   * ${b.id} — ${b.detail}`);
    if (b.fix) console.log(`     → ${b.fix}`);
  }
}
console.log('');
process.exit(blockers.length ? 1 : 0);
