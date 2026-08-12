// ---------------------------------------------------------------------------
// pcc-restore.mjs — put a backup back, deliberately.
//
// RESTORING IS DESTRUCTIVE. It replaces the company's live purchasing records
// with an older copy, and everything entered since that copy was taken is
// gone. So this script is built to be hard to run by accident and easy to run
// correctly:
//
//   * it refuses to overwrite an existing database unless --force is given
//   * with --force it FIRST takes a safety copy of what it is about to
//     replace, and prints where that copy is
//   * it verifies the backup opens and passes an integrity check BEFORE
//     touching anything
//   * it refuses to run while the application can be reached, because SQLite
//     will happily let two processes disagree about what the file contains
//
// STOP THE APPLICATION FIRST. That is not a formality: the running server
// holds the database open in WAL mode, and swapping the file underneath it
// produces a process serving pages from a database that no longer exists.
//
//   docker compose stop pcc
//   node scripts/pcc-restore.mjs --from /data/backups/pcc-20260812T1400Z.sqlite --force
//   docker compose start pcc
//
//   --from   the backup to restore. Required.
//   --db     the live database to replace. Default: $PCC_DATABASE_PATH, then
//            $PURCHASING_DB_PATH.
//   --force  required when the live database already exists.
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const from = arg('from');
const dbPath =
  arg('db') ??
  process.env.PCC_DATABASE_PATH ??
  process.env.PURCHASING_DB_PATH ??
  join(ROOT, 'apps', 'purchasing', '.data', 'purchasing.db');

if (!from) {
  console.error('pcc-restore: --from <backup.sqlite> is required.');
  console.error('Usage: node scripts/pcc-restore.mjs --from <backup> [--db <live>] [--force]');
  process.exit(1);
}
if (!existsSync(from)) {
  console.error(`pcc-restore: no backup at ${from}`);
  process.exit(1);
}

// --- 1. is the backup any good? ---------------------------------------------
// Checked BEFORE anything is moved. Discovering a corrupt backup after
// replacing the live database is the worst order to discover it in.
let summary;
try {
  const check = new DatabaseSync(from, { readOnly: true });
  const integrity = check.prepare('pragma integrity_check').get();
  const result = String(Object.values(integrity ?? {})[0] ?? '');
  if (result !== 'ok') throw new Error(`integrity check said: ${result}`);
  const orgs = check.prepare('select count(*) as n from orgs').get();
  const requests = check.prepare('select count(*) as n from purchase_requests').get();
  const orders = check.prepare('select count(*) as n from purchase_orders').get();
  const version = check.prepare('select value from schema_meta where key = ?').get('version');
  check.close();
  summary = `${orgs.n} organization(s), ${requests.n} request(s), ${orders.n} purchase order(s), schema ${version?.value ?? 'unknown'}`;
  console.log(`pcc-restore: backup verified — ${summary}`);
} catch (err) {
  console.error(`pcc-restore: the backup at ${from} is NOT usable — ${err.message}`);
  console.error('pcc-restore: nothing has been changed.');
  process.exit(1);
}

// --- 2. is anybody still using the live database? ---------------------------
// A running server is the common mistake and the expensive one. This checks
// the health endpoint rather than the file, because a lock is not held
// continuously and its absence proves nothing.
const baseUrl = process.env.APP_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
try {
  const res = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(2000) });
  if (res.status) {
    console.error(`pcc-restore: something is answering at ${baseUrl} (status ${res.status}).`);
    console.error('pcc-restore: STOP THE APPLICATION FIRST — restoring under a running server');
    console.error('             leaves it serving a database that no longer exists.');
    console.error('             docker compose stop pcc');
    process.exit(1);
  }
} catch {
  // Nothing answering. That is what we want.
}

// --- 3. replace, keeping what is being replaced -----------------------------
const live = existsSync(dbPath);
if (live && !flag('force')) {
  const size = (statSync(dbPath).size / 1024 / 1024).toFixed(1);
  console.error(`pcc-restore: ${dbPath} already exists (${size} MB).`);
  console.error('pcc-restore: restoring would REPLACE the live purchasing records with the backup,');
  console.error('             and everything entered since the backup was taken would be lost.');
  console.error('             Add --force if that is genuinely what you intend.');
  process.exit(1);
}

mkdirSync(dirname(dbPath), { recursive: true });

let safety = null;
let owner = null;
if (live) {
  // WHO OWNS THE FILE MATTERS, and this is where it is lost. copyFileSync
  // creates a file owned by whoever runs this script, and a restore is
  // typically run as root (a throwaway container, a sudo shell) while the
  // application runs as an unprivileged user. Restoring then leaves a database
  // the application cannot write, and the next start fails with "attempt to
  // write a readonly database" — a restore that looks like it worked and an
  // application that will not come up. Observed exactly once, here, which is
  // why it is recorded before the rename rather than reasoned about after.
  const before = statSync(dbPath);
  owner = { uid: before.uid, gid: before.gid, mode: before.mode };

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  safety = join(dirname(dbPath), `${basename(dbPath)}.replaced-${stamp}`);
  renameSync(dbPath, safety);
  // The journal belongs to the database that was just moved aside. Leaving it
  // next to the restored file would have SQLite try to replay one database's
  // transactions into another.
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, safety + suffix);
  }
  console.log(`pcc-restore: the database being replaced was kept at ${safety}`);
}

try {
  copyFileSync(from, dbPath);
  if (owner) {
    // Give it back to the user the application runs as. Best-effort: a restore
    // run as that same user cannot chown and does not need to.
    try {
      chownSync(dbPath, owner.uid, owner.gid);
      chmodSync(dbPath, owner.mode & 0o777);
    } catch (err) {
      console.warn(
        `pcc-restore: could not restore ownership (uid ${owner.uid}, gid ${owner.gid}) — ${err.message}`,
      );
      console.warn('pcc-restore: if the application will not start, chown the file to the user it runs as.');
    }
  }
} catch (err) {
  console.error(`pcc-restore: the copy FAILED — ${err.message}`);
  if (safety) {
    renameSync(safety, dbPath);
    console.error('pcc-restore: the original database has been put back. Nothing was lost.');
  }
  process.exit(1);
}

// --- 4. prove it ------------------------------------------------------------
try {
  const check = new DatabaseSync(dbPath, { readOnly: true });
  const requests = check.prepare('select count(*) as n from purchase_requests').get();
  check.close();
  console.log(`pcc-restore: restored ${dbPath} — ${requests.n} request(s) readable`);
} catch (err) {
  console.error(`pcc-restore: the restored file does not open — ${err.message}`);
  if (safety) {
    unlinkSync(dbPath);
    renameSync(safety, dbPath);
    console.error('pcc-restore: the original database has been put back.');
  }
  process.exit(1);
}

console.log('pcc-restore: done. Start the application and check /api/health.');
if (safety) {
  console.log(`pcc-restore: delete ${safety} once you are satisfied — it is the only copy of what was replaced.`);
}
