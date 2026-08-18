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
//   --service   the systemd unit PCC runs as. Default: pcc
//   --timer     the backup timer unit. Default: pcc-backup.timer
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

// ---------------------------------------------------------------------------
// APPLICATION — is it answering, and is it the production build?
// ---------------------------------------------------------------------------
{
  let live = null;
  try {
    const r = await fetch(`${baseUrl}/api/health/live`, { redirect: 'manual' });
    live = { status: r.status, body: await r.text() };
  } catch (err) {
    live = { error: err.message };
  }

  if (live?.error) {
    add('Application', 'process.answering', 'BLOCKED', `nothing answered at ${baseUrl} — ${live.error}`,
        `Check the service: systemctl status ${serviceUnit}; journalctl -u ${serviceUnit} -n 50`);
  } else if (live.status === 200 && /alive/.test(live.body)) {
    add('Application', 'process.answering', 'PASS', `${baseUrl} is serving`);
  } else {
    add('Application', 'process.answering', 'BLOCKED', `${baseUrl}/api/health/live answered ${live.status}`);
  }

  if (!live?.error) {
    let health = null;
    try {
      const r = await fetch(`${baseUrl}/api/health`, { redirect: 'manual' });
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
  } else {
    add('Application', 'runtime.production_mode', 'UNVERIFIED',
        'no systemd here — run this on the server to check how PCC is started');
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
  } else {
    add('Application', 'service.active', 'UNVERIFIED', 'no systemd here — check on the server');
    add('Application', 'service.enabled', 'UNVERIFIED', 'no systemd here — check on the server');
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
  const fitness = runNode('pcc-verify-production.mjs', dbPath ? ['--db', dbPath] : []);
  const problems = /NOT READY — (\d+) problem/.exec(fitness.out)?.[1] ?? null;
  add('Database', 'database.fit_for_production',
      fitness.code === 0 ? (/warning\(s\)/.test(fitness.out) ? 'WARN' : 'PASS') : 'BLOCKED',
      fitness.code === 0
        ? (/warning\(s\)/.test(fitness.out) ? 'no blocking problems, with warnings — run pcc-verify-production.mjs to read them' : 'no demonstration data; every pilot setting configured')
        : `pcc-verify-production reports ${problems ?? 'a'} problem(s)`,
      fitness.code === 0 ? null : `node scripts/pcc-verify-production.mjs${dbPath ? ` --db ${dbPath}` : ''}`);
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
  } else {
    add('Backup schedule', 'timer.active', 'UNVERIFIED', 'no systemd here — check on the server');
    add('Backup schedule', 'timer.enabled', 'UNVERIFIED', 'no systemd here — check on the server');
    add('Backup schedule', 'timer.last_result', 'UNVERIFIED', 'no systemd here — check on the server');
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
