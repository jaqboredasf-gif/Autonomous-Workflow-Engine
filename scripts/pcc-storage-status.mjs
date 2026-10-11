// ---------------------------------------------------------------------------
// pcc-storage-status.mjs — how much room is left, and what is using it.
//
// PCC keeps attachments INSIDE the database, and every backup is a FULL COPY of
// that database. So retention multiplies the database size rather than adding to
// it: thirty nightly backups of a 400 MB database is 12 GB, and the thing that
// fills the disk is the backup directory, not the records.
//
// That is not obvious from looking at `pcc.sqlite`, which is why this exists.
// It answers the five questions an operator actually has — how big is the
// database, how big is the backup directory, how much room is left, what is the
// oldest and newest backup, and how many are there — and says plainly when the
// growth triggers in PCC_PRODUCTION_ARCHITECTURE.md §4 have been reached.
//
// STRICTLY READ-ONLY. It stats files. It does not open the database, delete a
// backup, or write anything. Safe to run on a live production system at any
// time, and safe to hand to IT.
//
//   node scripts/pcc-storage-status.mjs
//   node scripts/pcc-storage-status.mjs --db /var/lib/pcc/pcc.sqlite
//   node scripts/pcc-storage-status.mjs --json      # for monitoring
//
//   --db      the database file. Default: $PCC_DATABASE_PATH, then $PURCHASING_DB_PATH
//   --backups the backup directory. Default: <database directory>/backups
//   --json    machine-readable, for whatever IT already runs
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const asJson = process.argv.includes('--json');

const dbPath = arg('db') ?? process.env.PCC_DATABASE_PATH ?? process.env.PURCHASING_DB_PATH ?? '';
if (!dbPath) {
  console.error('pcc-storage-status: no database path. Pass --db <path> or set PCC_DATABASE_PATH.');
  process.exit(1);
}
const backupDir = arg('backups') ?? join(dirname(dbPath), 'backups');

const mb = (bytes) => bytes / 1024 / 1024;
const human = (bytes) => (mb(bytes) >= 1024 ? `${(mb(bytes) / 1024).toFixed(1)} GB` : `${mb(bytes).toFixed(1)} MB`);
const sizeOf = (path) => { try { return statSync(path).size; } catch { return 0; } };

// --- the database, including its journal -----------------------------------
// The -wal file is part of the database: at any moment the most recent
// transactions live there rather than in the main file. Reporting only
// pcc.sqlite can understate the real footprint by a lot.
const dbBytes = sizeOf(dbPath);
const walBytes = sizeOf(`${dbPath}-wal`);
const shmBytes = sizeOf(`${dbPath}-shm`);
const databaseTotal = dbBytes + walBytes + shmBytes;

// --- the backups ------------------------------------------------------------
let backups = [];
if (existsSync(backupDir)) {
  backups = readdirSync(backupDir)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => {
      const full = join(backupDir, name);
      const stat = statSync(full);
      return { name, bytes: stat.size, modified: stat.mtime };
    })
    .sort((a, b) => a.modified - b.modified);
}
const backupBytes = backups.reduce((sum, b) => sum + b.bytes, 0);

// --- the volume -------------------------------------------------------------
let volume = null;
try {
  const fs = statfsSync(dirname(dbPath));
  volume = {
    freeBytes: fs.bavail * fs.bsize,
    totalBytes: fs.blocks * fs.bsize,
  };
} catch { /* not fatal — the sizes above are still worth printing */ }

// --- the triggers -----------------------------------------------------------
// From PCC_PRODUCTION_ARCHITECTURE.md §4. Reaching one is not an emergency; it
// is the signal to plan moving attachments out of the database.
const notes = [];
if (databaseTotal > 1024 ** 3) {
  notes.push('The database has passed 1 GB. This is the documented trigger to plan moving attachments out of it (PCC_PRODUCTION_ARCHITECTURE.md §4).');
}
if (volume && backupBytes > volume.totalBytes / 2) {
  notes.push('Retained backups use more than half the volume. Reduce --keep, or extract attachments.');
}
if (volume && volume.freeBytes < 5 * 1024 ** 3) {
  notes.push('Less than 5 GB free. Each backup is a FULL copy of the database — the next one needs that much room again.');
}
if (!backups.length) {
  notes.push('NO BACKUPS FOUND. If this is a live installation, that is the most important line on this page.');
}
if (backups.length) {
  const newest = backups[backups.length - 1].modified;
  const ageDays = (Date.now() - newest.getTime()) / 86_400_000;
  if (ageDays > 2) notes.push(`The newest backup is ${Math.floor(ageDays)} days old. Is the schedule still running?`);
}

// --- report -----------------------------------------------------------------
if (asJson) {
  console.log(JSON.stringify({
    database: { path: dbPath, bytes: dbBytes, walBytes, shmBytes, totalBytes: databaseTotal },
    backups: {
      directory: backupDir, count: backups.length, totalBytes: backupBytes,
      oldest: backups[0]?.modified ?? null,
      newest: backups[backups.length - 1]?.modified ?? null,
    },
    volume,
    notes,
  }, null, 2));
  process.exit(0);
}

console.log('');
console.log('pcc-storage-status');
console.log('');
console.log(`  database          ${dbPath}`);
console.log(`    main file       ${human(dbBytes)}`);
if (walBytes) console.log(`    write-ahead log ${human(walBytes)}  (part of the database — recent transactions live here)`);
if (shmBytes) console.log(`    shared index    ${human(shmBytes)}`);
console.log(`    TOTAL           ${human(databaseTotal)}`);
console.log('');
console.log(`  backups           ${backupDir}`);
console.log(`    count           ${backups.length}`);
console.log(`    total size      ${human(backupBytes)}`);
if (backups.length) {
  const oldest = backups[0];
  const newest = backups[backups.length - 1];
  console.log(`    oldest          ${oldest.name}  (${oldest.modified.toISOString().slice(0, 16).replace('T', ' ')})`);
  console.log(`    newest          ${newest.name}  (${newest.modified.toISOString().slice(0, 16).replace('T', ' ')})`);
  console.log(`    average         ${human(backupBytes / backups.length)} each — every backup is a FULL copy`);
}
console.log('');
if (volume) {
  const usedPct = (100 * (1 - volume.freeBytes / volume.totalBytes)).toFixed(0);
  console.log(`  volume            ${human(volume.freeBytes)} free of ${human(volume.totalBytes)} (${usedPct}% used)`);
  if (backups.length) {
    // The question an operator actually asks: how long can this carry on?
    const perBackup = backupBytes / backups.length;
    if (perBackup > 0) {
      console.log(`    room for        ~${Math.floor(volume.freeBytes / perBackup)} more backups at the current size`);
    }
  }
} else {
  console.log('  volume            could not be determined');
}

if (notes.length) {
  console.log('');
  console.log('  WORTH KNOWING');
  for (const note of notes) console.log(`    · ${note}`);
}
console.log('');
