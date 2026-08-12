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
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dbPath =
  arg('db') ??
  process.env.PCC_DATABASE_PATH ??
  process.env.PURCHASING_DB_PATH ??
  join(ROOT, 'apps', 'purchasing', '.data', 'purchasing.db');

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
  const check = new DatabaseSync(target, { readOnly: true });
  const integrity = check.prepare('pragma integrity_check').get();
  const result = String(Object.values(integrity ?? {})[0] ?? '');
  if (result !== 'ok') throw new Error(`integrity check said: ${result}`);
  const orgs = check.prepare('select count(*) as n from orgs').get();
  const requests = check.prepare('select count(*) as n from purchase_requests').get();
  const orders = check.prepare('select count(*) as n from purchase_orders').get();
  check.close();
  const size = statSync(target).size;
  console.log(`pcc-backup: wrote ${target}`);
  console.log(
    `pcc-backup: verified — integrity ok, ${(size / 1024 / 1024).toFixed(1)} MB, ` +
      `${orgs.n} organization(s), ${requests.n} request(s), ${orders.n} purchase order(s)`,
  );
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
  for (const old of mine.slice(keep)) {
    unlinkSync(join(outDir, old.f));
    console.log(`pcc-backup: removed ${old.f} (keeping ${keep})`);
  }
}
