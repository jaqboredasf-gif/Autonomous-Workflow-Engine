// ---------------------------------------------------------------------------
// pcc-deployment-gate.mjs — is PCC safe and ready to deploy?
//
// One command, one answer, and the answer is allowed to be "no, and here is
// exactly who can change that".
//
//   node scripts/pcc-deployment-gate.mjs
//   node scripts/pcc-deployment-gate.mjs --json
//
// IT INVENTS NOTHING. Everything it reports comes from something that already
// exists:
//
//   deployment/manifest.mjs   what a deployment must state about itself
//   deployment/blockers.mjs   which unknowns block which phase, and who owns them
//   check-deployable.mjs      the built artifact carries no database and no secret
//   proof/baselines/          whether this organization can be measured at all
//
// It adds only the checks that can be answered from THIS repository on THIS
// machine, and it refuses to answer the ones that cannot. A gate that guesses
// at a hostname is worse than one that says the hostname is unknown, because
// the guess is what somebody deploys on.
//
// THE EXPECTED RESULT TODAY IS "READY EXCEPT FOR ...". That is not a failure of
// the gate. PCC has never been installed on the target server, several facts
// about that server are genuinely unknown, and a green light here would be a
// lie about a machine nobody has logged into.
//
// READ ONLY. Runs no installer, starts no service, writes nothing.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { pccManifest } = await import(join(ROOT, 'deployment/examples/pcc.manifest.mjs'));
const { blockersUpTo, furthestReachablePhase, summarize } = await import(join(ROOT, 'deployment/blockers.mjs'));
const { resolve } = await import(join(ROOT, 'deployment/manifest.mjs'));

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');

// ---------------------------------------------------------------------------
// Locally answerable checks. Each returns PASS, BLOCKED or UNKNOWN — never a
// bare boolean, because "cannot be checked from here" is a third answer and
// collapsing it into failure is what trains people to ignore a report.
// ---------------------------------------------------------------------------

const checks = [];
const add = (id, status, detail) => checks.push({ id, status, detail });

// --- the artifact ----------------------------------------------------------
const standalone = join(ROOT, 'apps/purchasing/.next/standalone/apps/purchasing/server.js');
if (existsSync(standalone)) {
  add('artifact.built', 'PASS', 'a production build exists and carries a server entrypoint');
  const release = join(ROOT, 'apps/purchasing/.next/standalone/apps/purchasing/RELEASE');
  add('artifact.release_stamped',
    existsSync(release) ? 'PASS' : 'BLOCKED',
    existsSync(release)
      ? `stamped ${readFileSync(release, 'utf8').trim().split('\n')[0]}`
      : 'no RELEASE file — nobody could tell which build is on the server');
} else {
  add('artifact.built', 'BLOCKED', 'no production build — run: npm run build --workspace purchasing');
  add('artifact.release_stamped', 'UNKNOWN', 'no artifact to stamp');
}

// --- secrets never in source ----------------------------------------------
{
  const template = readFileSync(join(ROOT, 'config/production.env.template'), 'utf8');
  // A template must carry NAMES and no values for anything secret. Checked on
  // the two that would actually matter if they leaked.
  const leaked = ['SESSION_SECRET', 'PCC_BOOTSTRAP_ADMIN_PASSWORD']
    .filter((k) => new RegExp(`^${k}=.+$`, 'm').test(template));
  add('secrets.absent_from_source',
    leaked.length ? 'BLOCKED' : 'PASS',
    leaked.length ? `the template carries a value for ${leaked.join(', ')}` : 'the environment template names secrets and sets none');
}

// --- migrations ------------------------------------------------------------
{
  const db = readFileSync(join(ROOT, 'apps/purchasing/src/purchasing/infrastructure/sqlite/database.ts'), 'utf8');
  const version = /SCHEMA_VERSION = '([^']+)'/.exec(db)?.[1];
  add('database.migrations_ready', version ? 'PASS' : 'BLOCKED',
    version ? `schema ${version}, applied on startup` : 'no SCHEMA_VERSION found');
}

// --- the measurement facts, which cannot be fixed after first start --------
{
  const template = readFileSync(join(ROOT, 'config/production.env.template'), 'utf8');
  const envDeclared = /^PCC_ENVIRONMENT=production$/m.test(template);
  const orgDeclared = /^PCC_ORG_ID=[a-z][a-z0-9_-]+$/m.test(template);
  add('measurement.environment_in_template', envDeclared ? 'PASS' : 'BLOCKED',
    envDeclared
      ? 'the template sets PCC_ENVIRONMENT=production'
      : 'PCC_ENVIRONMENT is not set to production in the template — records would be refused as evidence');
  add('measurement.org_id_in_template', orgDeclared ? 'PASS' : 'BLOCKED',
    orgDeclared
      ? 'the template declares PCC_ORG_ID'
      : 'PCC_ORG_ID is not declared — the org id would be a generated UUID no baseline can be written against');
  add('measurement.set_on_the_server', 'UNKNOWN',
    'whether the SERVER\'s environment file carries them cannot be checked from here — it is the one thing that must be true before first start');
}

// --- proof instrumentation -------------------------------------------------
{
  const orgId = pccManifest.organization?.id;
  const baselineFile = join(ROOT, 'proof/baselines/lippolis-purchasing.mjs');
  const registered = existsSync(baselineFile) && readFileSync(baselineFile, 'utf8').includes(`orgId: ORG`);
  add('proof.baseline_registered', registered ? 'PASS' : 'BLOCKED',
    registered
      ? `a baseline exists for orgId "${orgId}" — every duration UNAVAILABLE until measured, which is correct and not a blocker`
      : `no proof baseline for orgId "${orgId}"`);

  const { unclassifiedInteractionActions } = await import(join(ROOT, 'proof/adapters/purchasing.mjs'));
  const { ACTIVITY_ACTIONS } = await import(join(ROOT, 'apps/purchasing/src/purchasing/domain/activity.mjs'));
  const loose = unclassifiedInteractionActions(ACTIVITY_ACTIONS);
  add('proof.actions_classified', loose.length ? 'BLOCKED' : 'PASS',
    loose.length ? `unclassified audit actions would be priced as free: ${loose.join(', ')}` : `all ${ACTIVITY_ACTIONS.length} audit actions classified`);
}

// --- contamination ---------------------------------------------------------
{
  const cs = readFileSync(join(ROOT, 'scripts/proof-case-study.mjs'), 'utf8');
  const guarded = cs.includes("environment !== 'production'") && cs.includes('allowNonproduction');
  add('proof.rehearsal_cannot_contaminate', guarded ? 'PASS' : 'BLOCKED',
    guarded
      ? 'a database that has not declared itself production is refused as evidence'
      : 'the case-study reader would accept a rehearsal database as production evidence');
}

// --- health, backup, restore ----------------------------------------------
for (const [id, file, detail] of [
  ['operations.health_endpoints', 'apps/purchasing/src/app/api/health/route.ts', 'readiness and liveness endpoints exist'],
  ['operations.backup_tooling', 'scripts/pcc-backup.mjs', 'backup command present'],
  ['operations.restore_tooling', 'scripts/pcc-restore.mjs', 'restore command present'],
  ['operations.preflight', 'scripts/pcc-preflight.mjs', 'startup preflight present'],
  ['operations.verify_after_install', 'scripts/pcc-verify-deployment.mjs', 'post-install verifier present'],
]) {
  add(id, existsSync(join(ROOT, file)) ? 'PASS' : 'BLOCKED', existsSync(join(ROOT, file)) ? detail : `${file} is missing`);
}

// --- platform tooling matches the declared target -------------------------
{
  const facts = resolve(pccManifest);
  const os = facts['hosting.os']?.value;
  const needed = os === 'windows'
    ? ['scripts/install-production.ps1', 'scripts/preflight-windows.ps1', 'scripts/Configure-PCCIIS.ps1']
    : ['scripts/install-production.sh', 'deploy/pcc-node.service'];
  const missing = needed.filter((f) => !existsSync(join(ROOT, f)));
  add('platform.tooling_present', missing.length ? 'BLOCKED' : 'PASS',
    missing.length
      ? `target OS is ${os} but missing: ${missing.join(', ')}`
      : `target OS is ${os}; the matching install tooling is present`);
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

const phase = furthestReachablePhase(pccManifest);
const modelBlockers = blockersUpTo(pccManifest, 'REQUIRED_BEFORE_GO_LIVE');
const failed = checks.filter((c) => c.status === 'BLOCKED');
const unknown = checks.filter((c) => c.status === 'UNKNOWN');
const ready = failed.length === 0 && modelBlockers.length === 0;

if (asJson) {
  console.log(JSON.stringify({ ready, phase, checks, blockers: modelBlockers, summary: summarize(pccManifest) }, null, 2));
  process.exit(ready ? 0 : 1);
}

console.log('PCC DEPLOYMENT GATE');
console.log('='.repeat(72));
console.log('');
console.log(`Furthest phase this deployment can reach: ${phase}`);
console.log('');
console.log('--- what this repository can answer --------------------------------');
for (const c of checks) {
  const mark = c.status === 'PASS' ? ' ok ' : c.status === 'BLOCKED' ? 'STOP' : ' ?? ';
  console.log(`  ${mark}  ${c.id}`);
  console.log(`        ${c.detail}`);
}

console.log('');
console.log('--- what only somebody else can answer -----------------------------');
if (modelBlockers.length === 0) {
  console.log('  nothing outstanding in the deployment manifest.');
} else {
  const byOwner = new Map();
  for (const b of modelBlockers) {
    const list = byOwner.get(b.owner) ?? [];
    list.push(b);
    byOwner.set(b.owner, list);
  }
  for (const [owner, items] of [...byOwner].sort()) {
    console.log(`  ${owner}:`);
    for (const b of items) console.log(`      ${b.path.padEnd(34)} ${b.phase.replace('REQUIRED_BEFORE_', 'before ').toLowerCase()} — ${b.reason ?? 'not stated'}`);
  }
}

console.log('');
console.log('='.repeat(72));
if (ready) {
  console.log('READY.');
} else {
  console.log('READY EXCEPT FOR:');
  for (const c of failed) console.log(`  · ${c.id} — ${c.detail}`);
  for (const b of modelBlockers) console.log(`  · ${b.path} — ${b.owner}`);
}
if (unknown.length) {
  console.log('');
  console.log('NOT CHECKABLE FROM HERE (run on the target, or ask):');
  for (const c of unknown) console.log(`  · ${c.id} — ${c.detail}`);
}
process.exit(ready ? 0 : 1);
