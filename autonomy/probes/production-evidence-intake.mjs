// ---------------------------------------------------------------------------
// production-evidence-intake.mjs — the evaluator's probes for that package.
//
// These hold a Builder's intake command to the package's interface from the
// outside. They live on the orchestrator's checkout, not the Builder's branch,
// and the Builder's own tests count for nothing here: a Builder that wrote
// weak tests still meets these.
//
// Every fixture is a real purchasing database (the application's own schema,
// openDatabase()), stamped the way an installation stamps itself. The
// adversarial ones are the mistakes that would actually happen: a rehearsal
// copy, an old unstamped file, the wrong company, a torn copy, and a
// production copy dropped into the repository, directly or through a symlink.
//
//   run({ root, worktree }) → [{ id, pass, detail }]
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCapability } from '../lib/observe.mjs';

// Every name a probe uses is random, so an intake cannot pass by recognizing
// a fixture's file name, label or organization instead of reading the file.
const rnd = () => randomBytes(4).toString('hex');
const fileSha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const SIDECARS = ['-wal', '-shm', '-journal'];

async function makeFixture(root, path, environment, org) {
  const { openDatabase } = await import(join(root, 'apps/purchasing/src/purchasing/infrastructure/sqlite/database.ts'));
  const db = openDatabase(path);
  if (environment !== 'unstamped') {
    db.prepare(`insert into schema_meta (key, value) values ('environment', ?) on conflict(key) do nothing`).run(environment);
  }
  const now = '2026-11-02T09:00:00.000Z';
  db.prepare('insert into orgs (id, name, created_at, updated_at) values (?, ?, ?, ?)').run(org, 'Probe Fixture Co', now, now);
  // A real backup is a single checkpointed file (pcc-backup uses VACUUM INTO).
  db.exec('pragma wal_checkpoint(truncate)');
  db.exec('pragma journal_mode = delete');
  db.close();
  for (const s of SIDECARS) rmSync(path + s, { force: true });
}

export async function run({ root, worktree }) {
  const ORG = `org-${rnd()}`;
  const results = [];
  const probe = (id, pass, detail) => results.push({ id, pass: !!pass, detail });
  const tmp = mkdtempSync(join(tmpdir(), 'awe-intake-probe-'));
  const intake = join(worktree, 'scripts/awe-production-intake.mjs');
  const labels = {};
  const call = (from, id, org = ORG) => {
    labels[id] = `l-${rnd()}`;
    return spawnSync(process.execPath, [intake, '--from', from, '--org', org, '--label', labels[id]], { cwd: worktree, encoding: 'utf8', timeout: 120_000 });
  };
  const recordOf = (id) => join(worktree, '.awe/production', labels[id] ?? '-', 'intake.json');
  const status = () => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8' }).stdout.trim();

  try {
    if (!existsSync(intake)) { probe('exists', false, 'scripts/awe-production-intake.mjs does not exist'); return results; }
    probe('exists', true, 'scripts/awe-production-intake.mjs exists');
    const before = status();

    // 1. A production copy outside the repository is accepted and analysed.
    // Named like a rehearsal on purpose: the stamp inside decides, not the name.
    const prod = join(tmp, `rehearsal-${rnd()}.sqlite`);
    await makeFixture(root, prod, 'production', ORG);
    const sha = fileSha(prod);
    const mtime = statSync(prod).mtimeMs;
    const ok = call(prod, 'probe-accept');
    probe('accepts-production', ok.status === 0, `exit ${ok.status}${ok.status ? `: ${(ok.stderr || ok.stdout).trim().slice(0, 300)}` : ''}`);
    const recPath = recordOf('probe-accept');
    let rec = null;
    try { rec = JSON.parse(readFileSync(recPath, 'utf8')); } catch { /* checked below */ }
    probe('intake-record', rec?.schema === 'awe.production-intake/1' && rec?.source?.sha256 === sha && rec?.environment === 'production' && rec?.org === ORG
      && Array.isArray(rec?.analyses) && rec.analyses.length > 0 && Number.isInteger(rec?.counts?.requests) && Number.isInteger(rec?.counts?.purchase_orders),
    rec ? `schema ${rec.schema}, sha ${rec.source?.sha256 === sha ? 'matches' : 'MISMATCH'}, env ${rec.environment}, org ${rec.org}, analyses ${rec.analyses?.length ?? 0}, counts ${JSON.stringify(rec.counts)}`
      : `${recPath} missing or unreadable`);
    probe('source-unchanged', fileSha(prod) === sha && statSync(prod).mtimeMs === mtime && SIDECARS.every((s) => !existsSync(prod + s)),
      fileSha(prod) === sha ? 'byte-identical, no sidecar' : 'the source database CHANGED');

    // 2. The mistakes that would actually happen are refused, by name.
    const refusals = [
      ['refuses-rehearsal', 'rehearsal', /rehearsal/i],
      ['refuses-unstamped', 'unstamped', /unstamped/i],
      ['refuses-development', 'development', /development|production/i],
    ];
    for (const [id, env, re] of refusals) {
      const f = join(tmp, `pcc-production-${rnd()}.sqlite`);
      await makeFixture(root, f, env, ORG);
      const r = call(f, id);
      probe(id, r.status !== 0 && re.test(r.stderr + r.stdout), `exit ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    }
    {
      const r = call(prod, 'refuses-wrong-org', `org-${rnd()}`);
      probe('refuses-wrong-org', r.status !== 0 && /organi[sz]ation|org\b/i.test(r.stderr + r.stdout), `exit ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    }
    {
      const torn = join(tmp, `pcc-production-${rnd()}.sqlite`);
      const bytes = readFileSync(prod);
      writeFileSync(torn, bytes.subarray(0, Math.floor(bytes.length / 2)));
      const r = call(torn, 'refuses-torn');
      probe('refuses-torn-copy', r.status !== 0 && /integrity|malformed|not a database|corrupt/i.test(r.stderr + r.stdout), `exit ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    }
    {
      const inside = join(worktree, `copy-${rnd()}.sqlite`);
      copyFileSync(prod, inside);
      const r = call(inside, 'refuses-in-repo');
      rmSync(inside, { force: true });
      for (const s of SIDECARS) rmSync(inside + s, { force: true });
      probe('refuses-in-repository', r.status !== 0 && /repositor/i.test(r.stderr + r.stdout), `exit ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    }
    {
      const inside = join(worktree, `copy-${rnd()}.sqlite`);
      copyFileSync(prod, inside);
      const link = join(tmp, `pcc-production-${rnd()}.sqlite`);
      symlinkSync(inside, link);
      const r = call(link, 'refuses-symlink');
      rmSync(inside, { force: true });
      for (const s of SIDECARS) rmSync(inside + s, { force: true });
      probe('refuses-symlink-into-repository', r.status !== 0 && /repositor/i.test(r.stderr + r.stdout), `exit ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    }
    for (const id of Object.keys(labels).filter((x) => x !== 'probe-accept')) {
      if (existsSync(recordOf(id))) probe(`no-record-on-refusal:${id}`, false, 'a refused copy still produced an intake record');
    }

    // 3. Nothing outside .awe/production/ was written into the repository.
    const after = status();
    probe('repository-untouched', after === before, after === before ? 'git status unchanged; outputs are ignored' : `git status changed:\n${after}`);

    // 4. The engine's own probe now finds the route it reported missing.
    const caps = JSON.parse(readFileSync(join(root, 'autonomy/capabilities.json'), 'utf8')).capabilities;
    const cap = probeCapability(worktree, caps.find((c) => c.id === 'production-evidence-return'));
    probe('capability-gap-closed', cap.present === true, cap.evidence?.join(' | ') ?? cap.reason);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return results;
}
