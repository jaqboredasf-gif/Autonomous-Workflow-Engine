// ---------------------------------------------------------------------------
// awe-production-intake.mjs — the one route production records take into the
// evidence layer.
//
//   node scripts/awe-production-intake.mjs --from <copied backup> --org <id>
//        [--label <name>] [--from-date YYYY-MM-DD --to-date YYYY-MM-DD]
//
// WHAT IT IS FOR. RDS02 has no outbound network at runtime, so plan and the
// case study can never read the live database where it lives. What leaves the
// server is the nightly backup (scripts/pcc-backup.mjs), copied by a person —
// docs/proof/PRODUCTION_EVIDENCE_RETURN.md says who, how and where. This
// command is what that copy meets when it arrives: it decides whether the copy
// is production evidence about the declared organization, and only then runs
// the analyses against it.
//
// THE DECISION COMES FROM THE FILE, never from its name or where it sits:
//   · a path inside this repository is refused (resolved through symlinks):
//     production records never enter git, not even by accident of location;
//   · the same integrity check pcc-backup --check runs (pragma integrity_check,
//     plus the tables an operator recognizes) must pass;
//   · schema_meta.environment must say "production". A rehearsal is built to
//     look exactly like production, so the stamp is the only honest answer;
//     an unstamped database is refused, not given the benefit of the doubt;
//   · the declared organization must exist in its orgs table.
//
// READ-ONLY, AND THE SOURCE IS NEVER OPENED BY SQLITE. Opening even read-only
// can leave -wal/-shm sidecars beside a WAL-mode file. So the source is hashed,
// copied byte-for-byte into a private working file under .awe/production/,
// and the copy is what SQLite and the analyses open. The working copy is
// removed afterwards; the source is re-hashed to prove it was not touched.
//
// WRITES only .awe/production/<label>/ (gitignored): intake.json and each
// analysis's output. A refusal writes no intake record.
//
// Exit 0 only when the copy is accepted and the analyses have been run (their
// own exit codes are recorded, not fatal). Any refusal exits 2 and names the
// reason on stderr.
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  existsSync, statSync, readFileSync, realpathSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readdirSync,
} from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_BASE = join(ROOT, '.awe', 'production');
const SCHEMA = 'awe.production-intake/1';

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : null;
}

function refuse(reason, detail = '') {
  console.error(`awe-production-intake: REFUSED (${reason}) — ${detail}`);
  console.error('awe-production-intake: no intake record was written.');
  process.exit(2);
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const SIDECARS = ['-wal', '-shm', '-journal'];
const sidecarsOf = (path) => SIDECARS.filter((s) => existsSync(path + s));

/** Is `child` (a real path) the same as or below `parent` (a real path)? */
function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// --- arguments ---------------------------------------------------------------
const fromArg = arg('from');
const org = arg('org');
const fromDate = arg('from-date');
const toDate = arg('to-date');
if (!fromArg) refuse('usage', 'set --from <copied backup file>');
if (!org) refuse('organization', 'set --org <organization id>: evidence is organization-bound');
if (!!fromDate !== !!toDate) refuse('usage', '--from-date and --to-date go together');
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
if (fromDate && (!isoDate.test(fromDate) || !isoDate.test(toDate))) refuse('usage', 'dates are YYYY-MM-DD');

const label = arg('label') ?? `${org}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(label) || label.includes('..')) {
  refuse('usage', `--label must be a plain name ([A-Za-z0-9._-]), got ${JSON.stringify(label)}`);
}

// --- where the file is --------------------------------------------------------
const source = resolve(fromArg);
if (!existsSync(source)) refuse('missing', `no such file: ${source}`);
let realSource;
try { realSource = realpathSync(source); } catch (e) { refuse('missing', `cannot resolve ${source}: ${e.message}`); }
const roots = new Set([realpathSync(ROOT)]);
// The worktree may live inside another checkout; the outer repository counts too.
const top = spawnSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8' });
if (top.status === 0) {
  const [toplevel, common] = top.stdout.trim().split('\n');
  if (toplevel) try { roots.add(realpathSync(toplevel)); } catch { /* not resolvable: ignore */ }
  if (common && basename(common) === '.git') try { roots.add(realpathSync(dirname(common))); } catch { /* ignore */ }
}
for (const r of roots) {
  if (inside(realSource, r) || inside(source, r)) {
    refuse('repository', `${source} is inside the repository (${r}). Production records never enter the repository — ` +
      'copy the backup somewhere outside it (see docs/proof/PRODUCTION_EVIDENCE_RETURN.md).');
  }
}
if (!statSync(realSource).isFile()) refuse('integrity', `${source} is not a regular file`);

// --- private working copy ------------------------------------------------------
const before = { sha256: sha256(realSource), bytes: statSync(realSource).size };
const sidecarsBefore = sidecarsOf(realSource);
if (sidecarsBefore.length) {
  refuse('integrity', `${source} has ${sidecarsBefore.join(', ')} beside it: that is a live database or a torn copy, not a ` +
    'pcc-backup file (which is one self-contained file). Copy the nightly backup, not the live store.');
}
const outDir = join(OUT_BASE, label);
const workDir = join(OUT_BASE, `.work-${process.pid}-${Date.now()}`);
mkdirSync(workDir, { recursive: true });
const work = join(workDir, 'copy.sqlite');
copyFileSync(realSource, work);
const cleanup = () => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { if (readdirSync(OUT_BASE).length === 0) rmSync(OUT_BASE, { recursive: true }); } catch { /* ignore */ }
};
const refuseClean = (reason, detail) => { cleanup(); refuse(reason, detail); };
if (sha256(work) !== before.sha256) refuseClean('integrity', 'the working copy does not match the source byte-for-byte');
// A WAL-mode header (bytes 18/19 = 2) cannot be opened read-only without a
// writable log beside it. A pcc-backup file is already checkpointed, so the
// WORKING COPY is switched to rollback mode; the source keeps its bytes.
{
  const buf = readFileSync(work);
  if (buf.length >= 100 && buf.subarray(0, 16).toString('latin1') === 'SQLite format 3\0' && (buf[18] === 2 || buf[19] === 2)) {
    buf[18] = 1; buf[19] = 1;
    writeFileSync(work, buf);
  }
}

// --- what the file says about itself -------------------------------------------
let facts;
let db;
try {
  db = new DatabaseSync(work, { readOnly: true });
  // Same check as pcc-backup --check (verifyBackupFile): integrity, then the
  // tables an operator recognizes.
  const integrity = String(Object.values(db.prepare('pragma integrity_check').get() ?? {})[0] ?? '');
  if (integrity !== 'ok') throw new Error(`integrity check said: ${integrity}`);
  const orgsTotal = db.prepare('select count(*) as n from orgs').get().n;
  db.prepare('select count(*) as n from purchase_requests').get();
  db.prepare('select count(*) as n from purchase_orders').get();
  facts = { orgsTotal };
} catch (e) {
  try { db?.close(); } catch { /* ignore */ }
  refuseClean('integrity', `${source} failed the integrity check — ${e.message}. Treat this copy as unusable.`);
}

let environment = 'unstamped';
try {
  environment = db.prepare(`select value from schema_meta where key = 'environment'`).get()?.value ?? 'unstamped';
} catch { environment = 'unstamped'; }
const meta = (key) => { try { return db.prepare('select value from schema_meta where key = ?').get(key)?.value ?? null; } catch { return null; } };

if (environment !== 'production') {
  db.close();
  if (environment === 'unstamped') {
    refuseClean('unstamped', `${source} carries no schema_meta environment stamp. It cannot be shown to be production, ` +
      'and an unstamped database is not given the benefit of the doubt.');
  }
  if (environment === 'rehearsal') {
    refuseClean('rehearsal', `${source} declares itself a rehearsal database. Its records describe no real organization.`);
  }
  refuseClean('environment', `${source} declares itself "${environment}", not "production".`);
}

const orgRow = db.prepare('select id, name from orgs where id = ?').get(org);
if (!orgRow) {
  db.close();
  refuseClean('organization', `${source} contains no organization with id ${JSON.stringify(org)} ` +
    `(${facts.orgsTotal} organization(s) present). The declared organization must be the one the records belong to.`);
}

const counts = {
  requests: Number(db.prepare('select count(*) as n from purchase_requests where org_id = ?').get(org).n),
  purchase_orders: Number(db.prepare('select count(*) as n from purchase_orders where org_id = ?').get(org).n),
};
let range = { first: null, last: null };
try {
  const r = db.prepare('select min(created_at) as first, max(created_at) as last from purchase_requests where org_id = ?').get(org);
  range = { first: r?.first ?? null, last: r?.last ?? null };
} catch { /* column absent in an old schema: leave the range unknown */ }
const release = { schema_version: meta('version'), environment_declared_at: meta('environment_declared_at') };
db.close();

console.log(`awe-production-intake: ${source}`);
console.log(`awe-production-intake: accepted — integrity ok, environment production, organization ${org}` +
  (orgRow.name ? ` (${orgRow.name})` : ''));
console.log(`awe-production-intake: ${counts.requests} request(s), ${counts.purchase_orders} purchase order(s), ` +
  `raised ${range.first ?? '—'} to ${range.last ?? '—'}, schema ${release.schema_version ?? 'unknown'}`);

// --- the analyses, against the working copy --------------------------------------
mkdirSync(outDir, { recursive: true });
const node = process.execPath;
const runs = [
  { name: 'plan', file: 'plan.json', args: [join(ROOT, 'scripts/awe-plan.mjs'), '--db', work, '--org', org, '--json'] },
  { name: 'case-study', file: 'case-study.json',
    args: [join(ROOT, 'scripts/proof-case-study.mjs'), '--db', work, '--org', org,
      ...(fromDate ? ['--from', fromDate, '--to', toDate] : []), '--json'] },
];
const analyses = [];
for (const r of runs) {
  const res = spawnSync(node, r.args, {
    cwd: ROOT, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PCC_DATABASE_PATH: work },
  });
  const output = `${res.stdout ?? ''}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}${res.error ? `\n[error] ${res.error.message}` : ''}`;
  const exit_code = res.status ?? (res.signal ? 128 : 1);
  writeFileSync(join(outDir, r.file), res.stdout ?? '');
  analyses.push({ name: r.name, exit_code, output });
  console.log(`awe-production-intake: ${r.name} exited ${exit_code} → .awe/production/${label}/${r.file}`);
}

cleanup();

// --- the source is unchanged ----------------------------------------------------
const after = { sha256: sha256(realSource), bytes: statSync(realSource).size };
const newSidecars = sidecarsOf(realSource).filter((s) => !sidecarsBefore.includes(s));
if (after.sha256 !== before.sha256 || newSidecars.length) {
  // Should be impossible: the source was only ever read. Say so loudly.
  rmSync(outDir, { recursive: true, force: true });
  refuse('integrity', `the source changed during intake (${newSidecars.join(', ') || 'contents'}); nothing is recorded`);
}

const record = {
  schema: SCHEMA,
  label,
  taken_at: new Date().toISOString(),
  source: { sha256: before.sha256, bytes: before.bytes },
  environment,
  org,
  counts,
  period: { first_request: range.first, last_request: range.last, from_date: fromDate, to_date: toDate },
  release,
  analyses,
};
writeFileSync(join(outDir, 'intake.json'), JSON.stringify(record, null, 2) + '\n');
console.log(`awe-production-intake: wrote .awe/production/${label}/intake.json`);
process.exit(0);
