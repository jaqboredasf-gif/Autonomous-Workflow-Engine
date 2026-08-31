// ---------------------------------------------------------------------------
// pcc-deployment-gate.mjs — is PCC safe and ready to deploy?
//
// One command, one answer, and the answer is allowed to be "no, and here is
// exactly who can change that".
//
//   node scripts/pcc-deployment-gate.mjs
//   node scripts/pcc-deployment-gate.mjs --json
//   node scripts/pcc-deployment-gate.mjs --require build     # exit 0 if buildable
//
// IT INVENTS NOTHING, AND IT DUPLICATES NOTHING. Everything it reports comes
// from something that already exists:
//
//   deployment/manifest.mjs   what a deployment must state about itself
//   deployment/blockers.mjs   which unknowns block which phase, and who owns them
//   deployment/adapters/      what the target platform's tooling actually is
//   proof/baselines/          whether this organization can be measured at all
//
// The verdict is `furthestReachablePhase()`'s vocabulary, not a second one:
// BLOCKED_BEFORE_BUILD · BUILD_ONLY · DEPLOY_ONLY · GO_LIVE. A gate that
// invented its own words would be a second source of deployment truth, and the
// two would disagree on the day it mattered.
//
// WHAT THIS ADDS to the manifest model: the checks that can only be answered by
// looking at THIS repository on THIS machine — is there a build, does the
// environment template carry the settings that cannot be corrected later, does
// the manifest still describe the same paths the installer uses. Each one
// declares which phase it blocks and who owns it, so a local failure moves the
// verdict exactly the way a manifest unknown does. A check that could not move
// the verdict would be decoration.
//
// THREE KINDS OF BLOCKER, and conflating them is what makes a readiness report
// useless:
//
//   BUILD                 AWE cannot produce a correct artifact yet.
//   DEPLOYMENT_CONFIG     AWE can build it; something must be set correctly at
//                         install time, and some of it cannot be corrected
//                         afterwards.
//   EXTERNAL              A person or system outside AWE has to decide or do
//                         something. No amount of engineering clears it.
//
// THE EXPECTED RESULT TODAY IS NOT "READY". PCC has never been installed on the
// target server and several facts about that server are genuinely unknown. A
// green light here would be a claim about a machine nobody has logged into.
//
// READ ONLY. Runs no installer, starts no service, writes nothing.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);
const readIf = (p) => (existsSync(R(p)) ? readFileSync(R(p), 'utf8') : null);

/** The phases, in the order the deployment meets them. Imported vocabulary. */
const PHASE_ORDER = {
  REQUIRED_BEFORE_BUILD: 0,
  REQUIRED_BEFORE_DEPLOY: 1,
  REQUIRED_BEFORE_GO_LIVE: 2,
};
const VERDICT_FOR = {
  REQUIRED_BEFORE_BUILD: 'BLOCKED_BEFORE_BUILD',
  REQUIRED_BEFORE_DEPLOY: 'BUILD_ONLY',
  REQUIRED_BEFORE_GO_LIVE: 'DEPLOY_ONLY',
};

/**
 * Which of the three kinds a blocker is.
 *
 * Derived from the two things already recorded — who owns it and when it bites
 * — rather than hand-tagged, so a blocker cannot be filed under the wrong kind
 * by whoever added it. Anything AWE cannot clear on its own is EXTERNAL even
 * when it blocks the build, because that is what the reader has to act on.
 */
export function kindOf({ owner, phase }) {
  if (owner !== 'AWE') return 'EXTERNAL';
  return phase === 'REQUIRED_BEFORE_BUILD' ? 'BUILD' : 'DEPLOYMENT_CONFIG';
}

export const KIND_LABEL = {
  BUILD: 'BUILD BLOCKER — AWE cannot produce a correct artifact',
  DEPLOYMENT_CONFIG: 'DEPLOYMENT-TIME CONFIGURATION — set correctly at install, some permanently',
  EXTERNAL: 'EXTERNAL DEPENDENCY — a person or system outside AWE',
};

/**
 * The whole gate, as data. Exported so it can be tested without a subprocess
 * and without parsing printed output.
 */
export async function gate() {
  const { pccManifest } = await import(R('deployment/examples/pcc.manifest.mjs'));
  const { blockersUpTo, furthestReachablePhase, summarize } = await import(R('deployment/blockers.mjs'));
  const { resolve } = await import(R('deployment/manifest.mjs'));

  const facts = resolve(pccManifest);
  const checks = [];
  /**
   * @param id      what is being checked
   * @param status  PASS | BLOCKED | UNKNOWN
   * @param blocks  the earliest phase this stops, when BLOCKED
   * @param owner   who can clear it
   * @param detail  what a reader does next
   */
  const add = (id, status, blocks, owner, detail) =>
    checks.push({ id, status, blocks, owner, kind: kindOf({ owner, phase: blocks }), detail });

  // --- the artifact ---------------------------------------------------------
  const standalone = 'apps/purchasing/.next/standalone/apps/purchasing/server.js';
  if (existsSync(R(standalone))) {
    add('artifact.built', 'PASS', 'REQUIRED_BEFORE_BUILD', 'AWE',
      'a production build exists and carries a server entrypoint');
    const release = readIf('apps/purchasing/.next/standalone/apps/purchasing/RELEASE');
    add('artifact.release_stamped', release ? 'PASS' : 'BLOCKED', 'REQUIRED_BEFORE_DEPLOY', 'AWE',
      release
        ? `stamped ${release.trim().split('\n')[0]}`
        : 'no RELEASE file — nobody could tell which build is on the server');
  } else {
    add('artifact.built', 'BLOCKED', 'REQUIRED_BEFORE_BUILD', 'AWE',
      'no production build — run: npm run build --workspace purchasing');
    add('artifact.release_stamped', 'UNKNOWN', 'REQUIRED_BEFORE_DEPLOY', 'AWE', 'no artifact to stamp');
  }

  // --- secrets never in source ----------------------------------------------
  {
    const template = readIf('config/production.env.template') ?? '';
    // A template must carry NAMES and no values for anything secret.
    const leaked = ['SESSION_SECRET', 'PCC_BOOTSTRAP_ADMIN_PASSWORD']
      .filter((k) => new RegExp(`^${k}=.+$`, 'm').test(template));
    add('secrets.absent_from_source', leaked.length ? 'BLOCKED' : 'PASS', 'REQUIRED_BEFORE_BUILD', 'AWE',
      leaked.length
        ? `the template carries a value for ${leaked.join(', ')}`
        : 'the environment template names secrets and sets none');
  }

  // --- migrations -----------------------------------------------------------
  {
    const db = readIf('apps/purchasing/src/purchasing/infrastructure/sqlite/database.ts') ?? '';
    const version = /SCHEMA_VERSION = '([^']+)'/.exec(db)?.[1];
    add('database.migrations_ready', version ? 'PASS' : 'BLOCKED', 'REQUIRED_BEFORE_BUILD', 'AWE',
      version ? `schema ${version}, applied on startup` : 'no SCHEMA_VERSION found');
  }

  // --- the measurement facts, which cannot be fixed after first start -------
  {
    const template = readIf('config/production.env.template') ?? '';
    const envDeclared = /^PCC_ENVIRONMENT=production$/m.test(template);
    const orgDeclared = /^PCC_ORG_ID=[a-z][a-z0-9_-]+$/m.test(template);
    add('measurement.environment_in_template', envDeclared ? 'PASS' : 'BLOCKED', 'REQUIRED_BEFORE_DEPLOY', 'AWE',
      envDeclared
        ? 'the template sets PCC_ENVIRONMENT=production'
        : 'PCC_ENVIRONMENT is not set to production in the template — records would be refused as evidence');
    add('measurement.org_id_in_template', orgDeclared ? 'PASS' : 'BLOCKED', 'REQUIRED_BEFORE_DEPLOY', 'AWE',
      orgDeclared
        ? 'the template declares PCC_ORG_ID'
        : 'PCC_ORG_ID is not declared — the org id would be a generated UUID no baseline can be written against');

    // The database refuses to start when these disagree with what it already
    // holds. That is the mechanism; this check is that the mechanism exists.
    const bootstrap = readIf('apps/purchasing/src/purchasing/infrastructure/bootstrap.ts') ?? '';
    const enforced = /assertDatabaseIdentity/.test(bootstrap);
    add('measurement.identity_enforced_at_startup', enforced ? 'PASS' : 'BLOCKED', 'REQUIRED_BEFORE_DEPLOY', 'AWE',
      enforced
        ? 'a start whose declared environment or org id disagrees with the database refuses and writes nothing'
        : 'nothing checks the declared environment against the database — a restored production copy could be seeded with demo data');

    add('measurement.set_on_the_server', 'UNKNOWN', 'REQUIRED_BEFORE_DEPLOY', 'CUSTOMER_IT',
      "whether the SERVER's environment file carries them cannot be checked from here — it is the one thing that must be true before first start");
  }

  // --- proof instrumentation ------------------------------------------------
  {
    const orgId = pccManifest.organization?.id;
    const baseline = readIf('proof/baselines/lippolis-purchasing.mjs');
    const registered = baseline !== null && baseline.includes('orgId: ORG');
    add('proof.baseline_registered', registered ? 'PASS' : 'BLOCKED', 'REQUIRED_BEFORE_GO_LIVE', 'AWE',
      registered
        ? `a baseline exists for orgId "${orgId}" — every duration UNAVAILABLE until measured, which is correct and not a blocker`
        : `no proof baseline for orgId "${orgId}"`);

    const { unclassifiedInteractionActions } = await import(R('proof/adapters/purchasing.mjs'));
    const { ACTIVITY_ACTIONS } = await import(R('apps/purchasing/src/purchasing/domain/activity.mjs'));
    const loose = unclassifiedInteractionActions(ACTIVITY_ACTIONS);
    add('proof.actions_classified', loose.length ? 'BLOCKED' : 'PASS', 'REQUIRED_BEFORE_GO_LIVE', 'AWE',
      loose.length
        ? `unclassified audit actions would be priced as free: ${loose.join(', ')}`
        : `all ${ACTIVITY_ACTIONS.length} audit actions classified`);
  }

  // --- contamination --------------------------------------------------------
  {
    const cs = readIf('scripts/proof-case-study.mjs') ?? '';
    const guarded = cs.includes("environment !== 'production'") && cs.includes('allowNonproduction');
    add('proof.rehearsal_cannot_contaminate', guarded ? 'PASS' : 'BLOCKED', 'REQUIRED_BEFORE_DEPLOY', 'AWE',
      guarded
        ? 'a database that has not declared itself production is refused as evidence'
        : 'the case-study reader would accept a rehearsal database as production evidence');
  }

  // --- health, backup, restore ---------------------------------------------
  for (const [id, file, phase, detail] of [
    ['operations.health_endpoints', 'apps/purchasing/src/app/api/health/route.ts', 'REQUIRED_BEFORE_DEPLOY', 'readiness and liveness endpoints exist'],
    ['operations.backup_tooling', 'scripts/pcc-backup.mjs', 'REQUIRED_BEFORE_GO_LIVE', 'backup command present'],
    ['operations.restore_tooling', 'scripts/pcc-restore.mjs', 'REQUIRED_BEFORE_GO_LIVE', 'restore command present'],
    ['operations.preflight', 'scripts/pcc-preflight.mjs', 'REQUIRED_BEFORE_DEPLOY', 'startup preflight present'],
    ['operations.verify_after_install', 'scripts/pcc-verify-deployment.mjs', 'REQUIRED_BEFORE_DEPLOY', 'post-install verifier present'],
  ]) {
    const there = existsSync(R(file));
    add(id, there ? 'PASS' : 'BLOCKED', phase, 'AWE', there ? detail : `${file} is missing`);
  }

  // --- the target platform, and whether we ship anything for it -------------
  const os = facts['hosting.os']?.value;
  {
    const needed = os === 'windows'
      ? ['scripts/install-production.ps1', 'scripts/preflight-windows.ps1', 'scripts/Configure-PCCIIS.ps1',
         'scripts/install-backup-task.ps1', 'docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md']
      : ['scripts/install-production.sh', 'deploy/pcc-node.service'];
    const missing = needed.filter((f) => !existsSync(R(f)));
    add('platform.tooling_present', missing.length ? 'BLOCKED' : 'PASS', 'REQUIRED_BEFORE_DEPLOY', 'AWE',
      missing.length
        ? `target OS is ${os} but missing: ${missing.join(', ')}`
        : `target OS is ${os}; the matching install tooling is present`);

    // THE MANIFEST AND THE INSTALLER MUST DESCRIBE THE SAME MACHINE. They did
    // not: the manifest said the application lived at C:\pcc and the installer
    // put it in C:\Program Files\pcc. Neither file was wrong on its own, which
    // is precisely why nothing caught it.
    if (os === 'windows') {
      const installer = readIf('scripts/install-production.ps1') ?? '';
      const installPath = facts['hosting.install_path']?.value;
      const dataPath = facts['storage.data_path']?.value;
      const installerDefault = /\$InstallPath = "([^"]+)"/.exec(installer)?.[1]?.replace('$ServiceName', 'pcc');
      const agrees = installerDefault && installPath === installerDefault;
      add('platform.paths_agree', agrees ? 'PASS' : 'BLOCKED', 'REQUIRED_BEFORE_DEPLOY', 'AWE',
        agrees
          ? `the manifest and the installer both put the application at ${installPath}`
          : `the manifest says ${installPath} and the installer defaults to ${installerDefault ?? 'something this check could not read'}`);

      const pkg = readIf('docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md') ?? '';
      const dataAgrees = typeof dataPath === 'string' && pkg.includes(dataPath);
      add('platform.data_path_agrees', dataAgrees ? 'PASS' : 'BLOCKED', 'REQUIRED_BEFORE_DEPLOY', 'AWE',
        dataAgrees
          ? `the execution package installs the data directory at ${dataPath}, as the manifest says`
          : `the manifest's data path ${dataPath} appears nowhere in the execution package`);
    }

    // The service manager is DERIVED from the OS. An adapter that has never
    // been used on a real machine is not a build problem and not a lie — it is
    // the single thing the first installation proves.
    const { adapterFor, provenAdapters } = await import(R('deployment/adapters/index.mjs'));
    const manager = facts['service.manager']?.value;
    const chosen = manager ? adapterFor(manager) : { ok: false };
    add('platform.adapter_selectable', chosen.ok ? 'PASS' : 'BLOCKED', 'REQUIRED_BEFORE_DEPLOY', 'AWE',
      chosen.ok
        ? `${manager} is derived from hosting.os=${os} and an adapter exists for it`
        : `no adapter for service manager ${JSON.stringify(manager)}`);
    const proven = provenAdapters().includes(manager);
    add('platform.adapter_proven', proven ? 'PASS' : 'UNKNOWN', 'REQUIRED_BEFORE_GO_LIVE', 'SHARED',
      proven
        ? `${manager} has been proven on a real machine`
        : `${manager} has never been run on a real machine — the first supervised install on the target is what proves it, and nothing in this repository can`);
  }

  // --- the documents an installer would actually follow ---------------------
  {
    const runbook = readIf('PCC_VM_INSTALLATION_RUNBOOK.md') ?? '';
    // Branch C only — NOT to the end of the file. Everything after it is the
    // installation record and the Linux pilot phases, and slicing to EOF made
    // this check read `systemctl` from a section Branch C never sends anybody
    // to. A gate that reports a blocker that is not there gets ignored exactly
    // as fast as one that misses a real one.
    const from = runbook.indexOf('## Branch C');
    const next = runbook.indexOf('\n# ', from);
    const branchC = from < 0 ? '' : runbook.slice(from, next < 0 ? undefined : next);
    const routed = os !== 'windows'
      || (branchC.length > 500 && !/systemctl|useradd|\/opt\/pcc/.test(branchC));
    add('documentation.platform_path_correct', routed ? 'PASS' : 'BLOCKED', 'REQUIRED_BEFORE_DEPLOY', 'AWE',
      routed
        ? `the authoritative runbook carries a ${os} path that does not send the installer to another platform's tooling`
        : `the runbook's ${os} branch is missing or routes to Linux tooling`);
  }

  // --- the model's own unresolved facts ------------------------------------
  const modelBlockers = blockersUpTo(pccManifest, 'REQUIRED_BEFORE_GO_LIVE').map((b) => ({
    ...b,
    kind: kindOf({ owner: b.owner, phase: b.phase }),
    source: 'manifest',
  }));

  const localBlockers = checks.filter((c) => c.status === 'BLOCKED').map((c) => ({
    path: c.id,
    phase: c.blocks,
    owner: c.owner,
    kind: c.kind,
    reason: c.detail,
    source: 'repository',
  }));

  const all = [...localBlockers, ...modelBlockers]
    .sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || a.path.localeCompare(b.path));

  // THE VERDICT. The earliest phase anything blocks decides it, whether that
  // thing came from the manifest or from this repository — otherwise a missing
  // build would be reported beside a green BUILD_ONLY.
  const earliest = all.reduce(
    (worst, b) => Math.min(worst, PHASE_ORDER[b.phase]), Number.POSITIVE_INFINITY);
  const verdict = Number.isFinite(earliest)
    ? VERDICT_FOR[Object.keys(PHASE_ORDER).find((k) => PHASE_ORDER[k] === earliest)]
    : 'GO_LIVE';

  return {
    verdict,
    manifestPhase: furthestReachablePhase(pccManifest),
    checks,
    blockers: all,
    unknown: checks.filter((c) => c.status === 'UNKNOWN'),
    summary: summarize(pccManifest),
  };
}

/** True when nothing blocks at or before `phase`. */
export function passes(result, phase) {
  const limit = PHASE_ORDER[phase];
  return !result.blockers.some((b) => PHASE_ORDER[b.phase] <= limit);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const requireArg = argv[argv.indexOf('--require') + 1];
  const REQUIRE = { build: 'REQUIRED_BEFORE_BUILD', deploy: 'REQUIRED_BEFORE_DEPLOY', 'go-live': 'REQUIRED_BEFORE_GO_LIVE' };
  const required = REQUIRE[argv.includes('--require') ? requireArg : 'go-live'];
  if (!required) {
    console.error(`--require must be one of ${Object.keys(REQUIRE).join(', ')}`);
    process.exit(2);
  }

  const result = await gate();
  const ok = passes(result, required);

  if (asJson) {
    console.log(JSON.stringify({ ...result, required, ok }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  const line = '='.repeat(72);
  console.log('PCC DEPLOYMENT GATE');
  console.log(line);
  console.log('');
  console.log(`VERDICT: ${result.verdict}`);
  console.log(`  the furthest phase this deployment can reach on what is known and built today`);
  console.log('');

  console.log('--- what this repository can answer --------------------------------');
  for (const c of result.checks) {
    const mark = c.status === 'PASS' ? ' ok ' : c.status === 'BLOCKED' ? 'STOP' : ' ?? ';
    console.log(`  ${mark}  ${c.id}`);
    console.log(`        ${c.detail}`);
  }

  console.log('');
  console.log('--- every blocker, by what would clear it ---------------------------');
  if (result.blockers.length === 0) {
    console.log('  nothing outstanding.');
  }
  for (const kind of ['BUILD', 'DEPLOYMENT_CONFIG', 'EXTERNAL']) {
    const items = result.blockers.filter((b) => b.kind === kind);
    if (!items.length) continue;
    console.log('');
    console.log(`  ${KIND_LABEL[kind]}`);
    for (const b of items) {
      console.log(`    · ${b.path}`);
      console.log(`        ${b.phase.replace('REQUIRED_BEFORE_', 'blocks ').toLowerCase().replace(/_/g, '-')} · ${b.owner} · from the ${b.source}`);
      console.log(`        ${b.reason ?? 'not stated'}`);
    }
  }

  if (result.unknown.length) {
    console.log('');
    console.log('--- not checkable from here (run on the target, or ask) ------------');
    for (const c of result.unknown) console.log(`  · ${c.id} — ${c.detail}`);
  }

  console.log('');
  console.log(line);
  const name = required.replace('REQUIRED_BEFORE_', '').toLowerCase().replace(/_/g, '-');
  console.log(ok
    ? `PASSES the ${name} gate.`
    : `DOES NOT PASS the ${name} gate — ${result.blockers.filter((b) => PHASE_ORDER[b.phase] <= PHASE_ORDER[required]).length} blocker(s) at or before it.`);
  process.exit(ok ? 0 : 1);
}
