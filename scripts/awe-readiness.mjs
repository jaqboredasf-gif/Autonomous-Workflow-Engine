// ---------------------------------------------------------------------------
// awe-readiness.mjs — deployment confidence, as a file.
//
//   node scripts/awe-verify.mjs --profile deploy --out .awe-deploy
//   node scripts/awe-readiness.mjs --verify .awe-deploy/verify.json --out .awe-deploy
//
// Writes <out>/deployment-readiness.json: for each deployment question, the
// suites that answer it and how they did; what only LIPELE-RDS02 can prove; the
// human facts and their state; what would currently prevent deployment; and two
// verdicts, one for the installation and one for the first real transaction.
// Rules: autonomy/lib/readiness.mjs. Questions: autonomy/deployment-readiness.json.
//
// While the baseline is unattested, it prints, and the file carries:
//     BASELINE REQUIRED BEFORE FIRST REAL PCC TRANSACTION
//
// EXIT: 0 every machine question VERIFIED · 1 any FAILED · 3 any UNVERIFIED
// (blocked or not run). Readiness never moves the exit code on human facts:
// "nobody has been to Lippolis yet" is not a test failure, and making it one
// would teach people to ignore red.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveReadiness } from '../autonomy/lib/readiness.mjs';
import { loadHumanEvidence } from '../autonomy/lib/human-evidence.mjs';
import { readApprovalRecord } from '../deployment/approval-record.mjs';
import { git } from '../autonomy/lib/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d = null) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const outDir = resolve(arg('out', join(ROOT, '.awe-deploy')));
const verifyPath = resolve(arg('verify', join(outDir, 'verify.json')));

const spec = JSON.parse(readFileSync(join(ROOT, 'autonomy/deployment-readiness.json'), 'utf8'));
const { blockers } = JSON.parse(readFileSync(join(ROOT, 'autonomy/blockers.json'), 'utf8'));
const verify = existsSync(verifyPath) ? JSON.parse(readFileSync(verifyPath, 'utf8')) : null;

// The deployment gate is the existing authority on deployment blockers and
// their owners. It is read, not re-implemented.
let gate = null;
const g = spawnSync(process.execPath, [join(ROOT, 'scripts/pcc-deployment-gate.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8' });
try { gate = JSON.parse(g.stdout); } catch { gate = null; }

// What ships is the SIGNED commit. Compare the application it carries with the
// code the evidence ran on. The paths are what the release package installs and
// the data tools the runbook runs; tooling outside them may differ by design
// (APPROVED_RELEASE.md records that choice).
const APPLICATION_PATHS = ['apps/purchasing', 'packages', 'capability', 'config',
  'scripts/pcc-backup.mjs', 'scripts/pcc-restore.mjs'];
const TOOLING_PATHS = ['scripts/pcc-verify-deployment.mjs', 'scripts/pcc-verify-production.mjs',
  'deployment/approval-record.mjs', 'scripts/package-release.mjs', 'scripts/Deploy-PCCProduction.ps1',
  'scripts/install-backup-task.ps1', 'scripts/Configure-PCCIIS.ps1', 'scripts/preflight-windows.ps1'];
const approved = readApprovalRecord(join(ROOT, 'deployment/APPROVED_RELEASE.md'));
const evidenceCommit = verify?.tree?.commit ?? null;
const changed = (paths) => approved && evidenceCommit
  ? (git(ROOT, ['diff', '--name-only', approved.commit, evidenceCommit, '--', ...paths]) ?? '').split('\n').filter(Boolean)
  : null;
const appDiffs = changed(APPLICATION_PATHS);
const release = approved ? {
  approved_commit: approved.commit,
  signed_by: approved.signedBy,
  evidence_commit: evidenceCommit,
  application_identical: appDiffs === null ? null : appDiffs.length === 0,
  application_differs: appDiffs ?? [],
  tooling_differs: changed(TOOLING_PATHS) ?? [],
  compared_paths: APPLICATION_PATHS,
} : null;

const human = await loadHumanEvidence(ROOT);
const r = deriveReadiness({ spec, verify, gate, facts: human.facts, baseline: human.baseline, blockers, release, now: new Date().toISOString() });

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'deployment-readiness.json'), JSON.stringify(r, null, 2) + '\n');

const bar = '='.repeat(72);
if (r.banner) console.log(`${bar}\n  ${r.banner}\n  ${r.baseline.how_to_clear}\n${bar}`);
console.log(`\nPCC DEPLOYMENT READINESS — ${r.commit?.slice(0, 12) ?? 'no verification'} — target ${spec.target.host} (${spec.target.platform})`);
if (release) console.log(`\nSIGNED RELEASE     ${release.approved_commit} (${release.signed_by ?? 'UNSIGNED'}) — application ${release.application_identical === true ? 'IDENTICAL to' : release.application_identical === false ? 'DIFFERS from' : 'not compared with'} the verified commit${release.tooling_differs.length ? `; tooling differs: ${release.tooling_differs.length} file(s)` : ''}`);
console.log(`\nINSTALL            ${r.install.verdict}\n                   ${r.install.means}`);
console.log(`FIRST TRANSACTION  ${r.first_transaction.verdict}${r.first_transaction.open.length ? ` — open: ${r.first_transaction.open.join(', ')}` : ''}`);
console.log('\nQUESTION                               MACHINE     LIPPOLIS');
for (const q of r.questions) {
  console.log(`  ${q.question.padEnd(37)} ${q.machine.padEnd(11)} ${q.lippolis}`);
  for (const e of q.evidence.filter((x) => x.status !== 'PASS')) console.log(`      ${e.status} ${e.suite}: ${e.reason}`);
}
console.log('\nWOULD CURRENTLY PREVENT DEPLOYMENT');
for (const p of r.preventing_deployment) console.log(`  [${p.owner}] ${p.what}  (${p.source})`);
for (const w of r.baseline.warnings) console.log(`\nBASELINE NOTE: ${w}`);
console.log(`\nwrote ${relative(process.cwd(), join(outDir, 'deployment-readiness.json')) || join(outDir, 'deployment-readiness.json')}`);

const machine = r.questions.map((q) => q.machine);
process.exit(machine.includes('FAILED') ? 1 : machine.includes('UNVERIFIED') ? 3 : 0);
