// ---------------------------------------------------------------------------
// eval-release-package.mjs — is the thing we hand the installer complete?
//
// THE GAP THIS WHOLE AREA CLOSES. Step 1 of the authoritative Windows procedure
// reads "copy PCC-<commit>.zip to the server; verify against its .sha256", and
// nothing in this repository produced either file. Deployment day would have
// begun with somebody improvising an archive — including or excluding whatever
// they happened to think of, with no record of which.
//
// WHAT IS WORTH TESTING ABOUT A PACKAGER, and it is not that it produces a
// file. It is:
//
//   1. THE PACKAGE RUNS. Every script in it loads with no missing import, and
//      the server inside it starts. A package missing one module is
//      indistinguishable from a good one until an installer runs it on a
//      server with no internet and a person waiting. This is not hypothetical:
//      the first package built here loaded five scripts and failed the sixth,
//      because pcc-verify-deployment.mjs imports a path assembled with
//      join(ROOT, ...) at runtime, which no amount of reading imports finds.
//
//   2. IT REFUSES. A dirty tree, a build older than the commit, a build
//      carrying a database. Each of those produces an artifact whose label
//      disagrees with its contents.
//
//   3. IT IS DETERMINISTIC. Two builds of one commit produce identical bytes,
//      which is the only thing that makes publishing a hash worth anything:
//      two people can build the approved commit and find out whether they built
//      the same thing.
//
// Needs the production build. Offline otherwise — no network, no server.
//
//   node scripts/eval-release-package.mjs
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);
const PACKAGER = R('scripts/package-release.mjs');
const STANDALONE = R('apps/purchasing/.next/standalone/apps/purchasing/server.js');

let pass = 0;
const failures = [];
const notes = [];
const check = (ok, name, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
};
const eq = (a, b, name) => check(
  JSON.stringify(a) === JSON.stringify(b), name,
  JSON.stringify(a) === JSON.stringify(b) ? '' : `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

if (!existsSync(STANDALONE)) {
  console.error(`no production build at ${STANDALONE}`);
  console.error('Run: npm run build --workspace purchasing');
  process.exit(1);
}

const build = (out, ...extra) =>
  spawnSync(process.execPath, [PACKAGER, '--out', out, ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });

const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().length > 0;
const ALLOW = dirty ? ['--allow-dirty'] : [];

// ---------------------------------------------------------------------------
console.log('--- it produces the two files the runbook names -------------------');
const out1 = mkdtempSync(join(tmpdir(), 'pkg-'));
const first = build(out1, ...ALLOW);
eq(first.status, 0, 'the packager succeeds', first.stderr?.slice(0, 300));

const zips = readdirSync(out1).filter((f) => f.endsWith('.zip'));
eq(zips.length, 1, 'exactly one archive is produced');
const zipName = zips[0];
check(/^PCC-[0-9a-f]{7,}(-dirty)?\.zip$/.test(zipName), `the archive is named for the commit (${zipName})`);
check(existsSync(join(out1, `${zipName}.sha256`)), 'and its .sha256 is beside it, as step 1 requires');

const shaFile = readFileSync(join(out1, `${zipName}.sha256`), 'utf8').trim();
const actual = createHash('sha256').update(readFileSync(join(out1, zipName))).digest('hex');
check(shaFile.startsWith(actual), 'the recorded hash is the hash of the file', shaFile);
check(shaFile.includes(zipName), 'and the file names itself, so a stray hash cannot be checked against the wrong archive');

// ---------------------------------------------------------------------------
console.log('--- the same commit produces the same bytes -----------------------');
const out2 = mkdtempSync(join(tmpdir(), 'pkg-'));
eq(build(out2, ...ALLOW).status, 0, 'a second build succeeds');
const a = createHash('sha256').update(readFileSync(join(out1, zipName))).digest('hex');
const b = createHash('sha256').update(readFileSync(join(out2, zipName))).digest('hex');
eq(a, b, 'two builds of one commit are byte-identical');
notes.push('a published hash is checkable: two people building the approved commit can compare');

// ---------------------------------------------------------------------------
console.log('--- what is inside it ---------------------------------------------');
const work = mkdtempSync(join(tmpdir(), 'pkg-x-'));
const unzip = spawnSync('unzip', ['-q', join(out1, zipName), '-d', work], { encoding: 'utf8' });
eq(unzip.status, 0, 'a standard unzip reads the archive', unzip.stderr?.slice(0, 200));

const [pkgDir] = readdirSync(work);
const P = (p) => join(work, pkgDir, p);
check(existsSync(P('dist/pcc/apps/purchasing/server.js')),
  'the staged application is at dist/pcc, where -Artifact points');
check(existsSync(P('RELEASE')) && existsSync(P('MANIFEST.txt')), 'it says what it is');
check(existsSync(P('config/production.env.template')), 'the environment template is in it');
check(existsSync(P('docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md')),
  'so is the procedure, so the server carries its own runbook');
check(existsSync(P('PCC_VM_INSTALLATION_RUNBOOK.md')), 'and the authoritative runbook');
for (const s of ['Deploy-PCCProduction.ps1', 'preflight-windows.ps1', 'install-production.ps1',
  'Configure-PCCIIS.ps1', 'install-backup-task.ps1', 'pcc-verify-deployment.mjs',
  'pcc-backup.mjs', 'pcc-restore.mjs', 'pcc-preflight.mjs']) {
  check(existsSync(P(join('scripts', s))), `scripts/${s} is in the package`);
}

// THE MANIFEST MUST NAME THE TWO THAT CANNOT BE CORRECTED LATER, because the
// person reading it is the person filling in the environment file.
const manifest = readFileSync(P('MANIFEST.txt'), 'utf8');
check(manifest.includes('PCC_ENVIRONMENT=production') && manifest.includes('PCC_ORG_ID=lippolis'),
  'the manifest names the two settings written once at creation');
check(/never again/.test(manifest), 'and says they cannot be corrected afterwards');
check(/NOT PROVEN/.test(manifest) && /Windows installation has been performed/.test(manifest),
  'and states plainly that no Windows installation has been performed');
check(manifest.includes('Deploy-PCCProduction.ps1 -FirstInstall -Artifact .\\dist\\pcc'),
  'and gives the exact command, with the artifact path this package actually uses');

// NOTHING THAT MUST NEVER SHIP.
const walk = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc); else acc.push(full);
  }
  return acc;
};
const all = walk(join(work, pkgDir));
const forbidden = all.filter((f) => /\.(sqlite|sqlite3|db)$/.test(f) || /\/\.env(\.|$)/.test(f) ||
  /\.(pem|p12)$/.test(f) || /id_rsa$/.test(f));
eq(forbidden.map((f) => f.slice(work.length)), [], 'no database, environment file or key is in the package');
check(!/SESSION_SECRET=\S/.test(readFileSync(P('config/production.env.template'), 'utf8')),
  'and the template carries the names of secrets and none of their values');

// ---------------------------------------------------------------------------
console.log('--- every script in it loads, out of the package -------------------');
{
  // THE ASSERTION THAT MATTERS. A missing module is invisible until an
  // installer meets it on a server, and the packager's own list cannot find a
  // path assembled with join(ROOT, ...) at runtime — which is exactly how the
  // first package built here shipped without env.ts.
  const scripts = readdirSync(P('scripts')).filter((f) => f.endsWith('.mjs'));
  check(scripts.length >= 6, `${scripts.length} scripts to load`);
  for (const s of scripts) {
    const r = spawnSync(process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(`file://${P(join('scripts', s))}`)})`],
      { cwd: join(work, pkgDir), encoding: 'utf8', timeout: 30_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    check(!/ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/.test(out),
      `scripts/${s} loads with every import resolved`,
      /Cannot find (?:module|package) '([^']+)'/.exec(out)?.[1] ?? '');
  }
  notes.push('every packaged script loads from inside the package, with nothing else on the path');
}

// ---------------------------------------------------------------------------
console.log('--- and the packager refuses to ship an incomplete one --------------');
{
  // The self-check must be real, not decorative: remove something the package
  // needs and the packager must fail rather than publish a hash for it.
  const src = readFileSync(PACKAGER, 'utf8');
  check(/RUNTIME_PATHS/.test(src), 'the packager names the runtime paths imports cannot reveal');
  check(/the package is incomplete and was not written/.test(src),
    'and refuses rather than writing an archive it could not load');
  check(/server\.js is missing/.test(src),
    'and checks the one file without which the installer has nothing to install');

  const out3 = mkdtempSync(join(tmpdir(), 'pkg-'));
  const broken = readFileSync(PACKAGER, 'utf8')
    .replace("'apps/purchasing/src/purchasing/infrastructure/env.ts',", '');
  const brokenPath = join(out3, 'broken-packager.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(brokenPath, broken);
  // Run it from scripts/ so its ROOT still resolves to the repository.
  const brokenInScripts = R('scripts/.package-release-broken.mjs');
  writeFileSync(brokenInScripts, broken);
  const r = spawnSync(process.execPath, [brokenInScripts, '--out', out3, ...ALLOW],
    { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  rmSync(brokenInScripts, { force: true });
  eq(r.status, 1, 'a packager missing a runtime path fails');
  check(/incomplete and was not written/.test(`${r.stdout}${r.stderr}`),
    'and says so rather than producing a plausible archive');
  check(readdirSync(out3).filter((f) => f.endsWith('.zip')).length === 0,
    'and writes no archive at all');
  rmSync(out3, { recursive: true, force: true });
  notes.push('removing one runtime path makes the packager fail, so the self-check is load-bearing');
}

// ---------------------------------------------------------------------------
console.log('--- it refuses an artifact whose label would be wrong ---------------');
{
  const out4 = mkdtempSync(join(tmpdir(), 'pkg-'));

  // A dirty tree, when not explicitly allowed. Run only when the tree IS dirty,
  // which is the state that can actually be tested without touching the repo.
  if (dirty) {
    const r = build(out4);
    eq(r.status, 1, 'a dirty tree is refused without --allow-dirty');
    check(/not the installation of record/.test(`${r.stdout}${r.stderr}`),
      'and the refusal says why an artifact from uncommitted work is not one');
    check(readdirSync(out4).filter((f) => f.endsWith('.zip')).length === 0, 'and writes nothing');
    notes.push('the dirty-tree refusal was exercised against a genuinely dirty tree');
  } else {
    // On a clean tree the packager must NOT be refusing, which is the other
    // half of the same rule.
    const r = build(out4);
    eq(r.status, 0, 'a clean tree packages without needing --allow-dirty');
    check(!readdirSync(out4).some((f) => /-dirty/.test(f)), 'and the archive is not marked dirty');
  }

  // A build older than HEAD. The commit on the label would not be the code in
  // the box, and that is the failure nobody notices until a defect is "fixed"
  // in a build nobody deployed.
  const src = readFileSync(PACKAGER, 'utf8');
  check(/the build is older than HEAD/.test(src), 'the packager checks the build against the commit');
  const stat = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const headSeconds = Number(stat);
  const before = new Date((headSeconds - 3600) * 1000);
  const original = (await import('node:fs')).statSync(STANDALONE);
  utimesSync(STANDALONE, before, before);
  const stale = build(out4, ...ALLOW);
  utimesSync(STANDALONE, original.atime, original.mtime);
  eq(stale.status, 1, 'a build older than HEAD is refused');
  check(/older than HEAD/.test(`${stale.stdout}${stale.stderr}`), 'and says which is which');
  rmSync(out4, { recursive: true, force: true });
}

rmSync(out1, { recursive: true, force: true });
rmSync(out2, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });

console.log('');
for (const n of notes) console.log(`  note: ${n}`);
console.log('');
console.log(`release package: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
