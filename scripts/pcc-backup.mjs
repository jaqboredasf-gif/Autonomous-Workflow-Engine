// ---------------------------------------------------------------------------
// pcc-backup.mjs — one consistent copy of the purchasing database.
//
// WHY NOT `cp`. The pilot store runs in WAL mode, so at any moment the records
// are spread across three files: the database, a write-ahead log holding
// committed transactions not yet folded in, and a shared-memory index. Copying
// the .db file alone gives you a database missing every transaction since the
// last checkpoint — which is to say, missing exactly the recent work somebody
// would want back. Copying all three while the application is writing gives
// you a torn set.
//
// So this uses SQLite's own online backup (`VACUUM INTO`), which takes a read
// lock, walks the pages, and writes ONE file that is a complete, consistent,
// already-checkpointed database. The application keeps serving throughout.
//
// THIS IS NOT A BACKUP SYSTEM. It makes one good file. Retention, offsite
// copies, encryption and scheduling belong to whatever Lippolis IT already
// runs — this is the thing they point that at.
//
//   node scripts/pcc-backup.mjs [--out DIR] [--db PATH] [--keep N]
//
//   --db    the live database. Default: $PCC_DATABASE_PATH, then
//           $PURCHASING_DB_PATH, then apps/purchasing/.data/purchasing.db
//   --out   where to write. Default: alongside the database, in ./backups
//   --keep  delete older backups beyond this many. Default: keep everything,
//           because deleting somebody's only copy is not a default.
//
// Exits 0 on success, printing the path it wrote. Exits 1 loudly otherwise —
// a backup script that fails quietly is worse than no backup script, because
// somebody stops checking.
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  // A following flag is not this flag's value: `--check --db /x` must not read
  // "--db" as the file to check.
  return value && !value.startsWith('--') ? value : fallback;
}

const dbPath =
  arg('db') ??
  process.env.PCC_DATABASE_PATH ??
  process.env.PURCHASING_DB_PATH ??
  join(ROOT, 'apps', 'purchasing', '.data', 'purchasing.db');

/**
 * Open a backup file and decide whether it is USABLE, rather than merely
 * present. Integrity check plus the row counts an operator can recognize.
 *
 * ONE DEFINITION, used twice: immediately after writing a backup, and by
 * `--check`, which is how somebody answers "is last night's backup good?"
 * without restoring it. A second implementation of this would be a second
 * opinion about what a good backup is.
 */
function verifyBackupFile(path) {
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = check.prepare('pragma integrity_check').get();
    const result = String(Object.values(integrity ?? {})[0] ?? '');
    if (result !== 'ok') throw new Error(`integrity check said: ${result}`);
    const orgs = check.prepare('select count(*) as n from orgs').get();
    const requests = check.prepare('select count(*) as n from purchase_requests').get();
    const orders = check.prepare('select count(*) as n from purchase_orders').get();
    const size = statSync(path).size;
    return {
      summary:
        `integrity ok, ${(size / 1024 / 1024).toFixed(1)} MB, ` +
        `${orgs.n} organization(s), ${requests.n} request(s), ${orders.n} purchase order(s)`,
    };
  } finally {
    try { check.close(); } catch { /* closing a failed open is not an error worth reporting */ }
  }
}

const newestBackupIn = (dir) => {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => ({ path: join(dir, f), at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return files[0]?.path ?? null;
};

// --- --check: verify an existing backup, and write nothing ------------------
//
// STRICTLY READ-ONLY, and it is the answer to the question the timer cannot
// answer on its own. `systemctl list-timers` says the backup RAN; this says the
// file it produced can be opened, passes an integrity check, and contains the
// company's records. Those are different claims.
if (process.argv.includes('--check')) {
  const requested = arg('check');
  const checkDir = arg('out') ?? join(dirname(dbPath), 'backups');
  const path = !requested || requested === 'latest' ? newestBackupIn(checkDir) : requested;

  if (!path) {
    console.error(`pcc-backup: no backup found in ${checkDir}`);
    console.error('Nothing has been verified, because there is nothing there.');
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`pcc-backup: no such backup: ${path}`);
    process.exit(1);
  }
  try {
    const { summary } = verifyBackupFile(path);
    const age = (Date.now() - statSync(path).mtimeMs) / 3600000;
    console.log(`pcc-backup: ${path}`);
    console.log(`pcc-backup: verified — ${summary}`);
    console.log(`pcc-backup: taken ${age < 1 ? 'less than an hour' : `${Math.floor(age)} hour(s)`} ago`);
    process.exit(0);
  } catch (err) {
    console.error(`pcc-backup: ${path} FAILED verification — ${err.message}`);
    console.error('pcc-backup: treat this backup as unusable and take a new one.');
    process.exit(1);
  }
}

if (!existsSync(dbPath)) {
  console.error(`pcc-backup: no database at ${dbPath}`);
  console.error('Set --db or PCC_DATABASE_PATH to the live database file.');
  process.exit(1);
}

const outDir = arg('out') ?? join(dirname(dbPath), 'backups');
mkdirSync(outDir, { recursive: true });

// TIMESTAMPED, and sortable as text, so `ls` is chronological and two backups
// in the same minute do not collide. UTC, because a server that moves clocks
// twice a year should not produce two files with the same name in October.
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const name = `${basename(dbPath).replace(/\.[^.]+$/, '')}-${stamp}.sqlite`;
const target = join(outDir, name);

if (existsSync(target)) {
  console.error(`pcc-backup: ${target} already exists; refusing to overwrite a backup.`);
  process.exit(1);
}

let db;
try {
  // Read-only: a backup must not be able to modify what it is backing up, and
  // opening read-write would create the file if the path were wrong.
  db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('pragma busy_timeout = 30000');

  // The whole point. One statement, one consistent file, no application
  // downtime, and the result is already checkpointed — there is no companion
  // -wal to remember to copy alongside it.
  db.exec(`vacuum into '${target.replace(/'/g, "''")}'`);
} catch (err) {
  console.error(`pcc-backup: FAILED — ${(err instanceof Error ? err.message : String(err))}`);
  process.exit(1);
} finally {
  try { db?.close(); } catch { /* closing a failed open is not an error worth reporting */ }
}

// Verify what was written rather than trusting that it was. A backup nobody
// has opened is a hypothesis.
try {
  const { summary } = verifyBackupFile(target);
  console.log(`pcc-backup: wrote ${target}`);
  console.log(`pcc-backup: verified — ${summary}`);
} catch (err) {
  console.error(`pcc-backup: the file was written but FAILED verification — ${(err).message}`);
  console.error(`pcc-backup: treat ${target} as unusable.`);
  process.exit(1);
}

// --- retention --------------------------------------------------------------
const keep = Number(arg('keep') ?? 0);
if (Number.isInteger(keep) && keep > 0) {
  const mine = readdirSync(outDir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => ({ f, at: statSync(join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  // THE BACKUP THIS RUN JUST WROTE AND VERIFIED IS NEVER A CANDIDATE.
  //
  // It is already excluded by being the newest, so this is belt and braces —
  // and the brace is worth having, because the failure it guards against is
  // retention deleting the only good copy on a machine whose clock moved, and
  // nothing about that failure is recoverable or noisy.
  for (const old of mine.slice(keep).filter((x) => join(outDir, x.f) !== target)) {
    unlinkSync(join(outDir, old.f));
    console.log(`pcc-backup: removed ${old.f} (keeping ${keep})`);
  }
  const remaining = readdirSync(outDir).filter((f) => f.endsWith('.sqlite')).length;
  console.log(`pcc-backup: ${remaining} backup(s) retained in ${outDir}`);
} else {
  // Said out loud, because "no retention" and "retention I forgot to set" look
  // identical on a disk that is filling up.
  console.log(`pcc-backup: retention not requested (--keep) — every backup in ${outDir} is kept`);
}
