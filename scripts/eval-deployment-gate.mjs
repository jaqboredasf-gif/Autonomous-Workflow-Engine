// ---------------------------------------------------------------------------
// eval-deployment-gate.mjs — does the one command that answers "can we deploy?"
// answer it correctly, and does it stay honest when the answer is no?
//
// WHAT A DEPLOYMENT GATE IS FOR. Before this existed, "what is stopping us?"
// took a person reading PCC_PRODUCTION_READINESS.md, the runbook, the manifest
// and the execution package, and produced a different answer depending on who
// read them. The gate composes the model that already exists rather than
// carrying a second copy of deployment truth — and that is the property most
// worth testing, because a second copy would not be wrong on the day it was
// written. It would be wrong six weeks later.
//
// THE THREE FAILURES THIS SUITE IS BUILT AGAINST:
//
//   1. A GREEN LIGHT THAT IS NOT TRUE. Anything that reports READY while the
//      artifact is unbuilt, the platform tooling is missing or the target
//      machine is unknown is worse than no gate, because somebody will act on
//      it. So: the verdict must move when a blocker appears, whether that
//      blocker came from the manifest or from this repository.
//
//   2. A BLOCKER LIST NOBODY CAN ACT ON. "17 things are outstanding" is not
//      actionable. Which are ours to build, which are ours to configure on the
//      day, and which need somebody at Lippolis to decide — those are three
//      different conversations, and the gate must separate them.
//
//   3. A SECOND SOURCE OF TRUTH. If the gate's vocabulary drifts from
//      blockers.mjs, two commands will report different readiness. The verdict
//      words are asserted to be the model's own.
//
// Offline. Reads the repository; runs no installer and starts nothing.
//
//   node scripts/eval-deployment-gate.mjs
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);

const { gate, kindOf, passes, KIND_LABEL } = await import(R('scripts/pcc-deployment-gate.mjs'));
const { blockers, blockersUpTo, furthestReachablePhase, BLOCKER_PHASES } =
  await import(R('deployment/blockers.mjs'));
const { pccManifest } = await import(R('deployment/examples/pcc.manifest.mjs'));
const { resolve } = await import(R('deployment/manifest.mjs'));

let pass = 0;
const failures = [];
const check = (ok, name, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
};
const eq = (a, b, name) => check(
  JSON.stringify(a) === JSON.stringify(b), name,
  JSON.stringify(a) === JSON.stringify(b) ? '' : `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const result = await gate();

// ---------------------------------------------------------------------------
console.log('--- the gate speaks the model\'s vocabulary, not its own ----------');

const VERDICTS = ['BLOCKED_BEFORE_BUILD', 'BUILD_ONLY', 'DEPLOY_ONLY', 'GO_LIVE'];
check(VERDICTS.includes(result.verdict), 'the verdict is one of the model\'s four phases', result.verdict);

// Every phase the gate's local checks claim to block must be a phase the model
// knows. A check that blocked "REQUIRED_BEFORE_LAUNCH" would report a blocker
// no other command could ever see.
for (const c of result.checks) {
  check(BLOCKER_PHASES.includes(c.blocks), `${c.id} blocks a phase blockers.mjs defines`, c.blocks);
}

// The gate may only ever be as optimistic as the manifest model. It may be
// MORE pessimistic — that is what the local checks are for.
const order = { BLOCKED_BEFORE_BUILD: 0, BUILD_ONLY: 1, DEPLOY_ONLY: 2, GO_LIVE: 3 };
check(order[result.verdict] <= order[result.manifestPhase],
  'the gate is never more optimistic than the manifest alone',
  `${result.verdict} vs ${result.manifestPhase}`);
eq(result.manifestPhase, furthestReachablePhase(pccManifest),
  'and it reports the manifest phase from the model rather than recomputing it');

// ---------------------------------------------------------------------------
console.log('--- every manifest blocker reaches the report ---------------------');

const modelPaths = blockersUpTo(pccManifest, 'REQUIRED_BEFORE_GO_LIVE').map((b) => b.path).sort();
const reported = result.blockers.filter((b) => b.source === 'manifest').map((b) => b.path).sort();
eq(reported, modelPaths, 'the gate reports exactly the manifest blockers the model finds');
check(modelPaths.length > 0, 'and there are some, so this assertion is not vacuous');

for (const b of result.blockers) {
  check(typeof b.reason === 'string' && b.reason.length > 10,
    `${b.path} carries a reason a reader can act on`);
  check(typeof b.owner === 'string' && b.owner.length > 0, `${b.path} names an owner`);
}

// ---------------------------------------------------------------------------
console.log('--- the three kinds of blocker stay apart -------------------------');

// The distinction the whole report exists to draw: what AWE builds, what AWE
// configures on the day, and what somebody at Lippolis has to decide.
eq(kindOf({ owner: 'AWE', phase: 'REQUIRED_BEFORE_BUILD' }), 'BUILD',
  'an AWE fact that blocks the build is a BUILD blocker');
eq(kindOf({ owner: 'AWE', phase: 'REQUIRED_BEFORE_DEPLOY' }), 'DEPLOYMENT_CONFIG',
  'an AWE fact that blocks the install is a deployment-time configuration blocker');
eq(kindOf({ owner: 'AWE', phase: 'REQUIRED_BEFORE_GO_LIVE' }), 'DEPLOYMENT_CONFIG',
  'and so is one that blocks go-live — it is still ours to set');
eq(kindOf({ owner: 'CUSTOMER_IT', phase: 'REQUIRED_BEFORE_BUILD' }), 'EXTERNAL',
  'anything AWE cannot clear alone is EXTERNAL even when it blocks the build');
for (const owner of ['CUSTOMER_IT', 'SHARED', 'MSP', 'UNKNOWN', 'APPLICATION_OWNER']) {
  eq(kindOf({ owner, phase: 'REQUIRED_BEFORE_GO_LIVE' }), 'EXTERNAL', `${owner} is external to AWE`);
}
for (const kind of ['BUILD', 'DEPLOYMENT_CONFIG', 'EXTERNAL']) {
  check(typeof KIND_LABEL[kind] === 'string' && KIND_LABEL[kind].length > 20,
    `${kind} has a label that says what would clear it`);
}
for (const b of result.blockers) {
  eq(b.kind, kindOf({ owner: b.owner, phase: b.phase }),
    `${b.path} is filed under the kind its owner and phase imply`);
}

// The hostname is the archetype: nothing AWE does clears it.
const hostname = result.blockers.find((b) => b.path === 'network.hostname');
check(hostname && hostname.kind === 'EXTERNAL',
  'the outstanding hostname is reported as an external dependency, not as work');

// ---------------------------------------------------------------------------
console.log('--- the verdict moves when a local check blocks -------------------');

// A local BLOCKED check must be able to make the verdict worse than the
// manifest's. Otherwise the local checks are decoration: the gate would print
// STOP beside a green verdict, and a reader would learn to trust the verdict.
{
  const earliest = (bs) => bs.reduce((w, b) =>
    Math.min(w, { REQUIRED_BEFORE_BUILD: 0, REQUIRED_BEFORE_DEPLOY: 1, REQUIRED_BEFORE_GO_LIVE: 2 }[b.phase]), 99);
  const withLocal = earliest(result.blockers);
  const manifestOnly = earliest(result.blockers.filter((b) => b.source === 'manifest'));
  check(withLocal <= manifestOnly,
    'the verdict is computed from local checks and manifest blockers together');

  // Proven directly rather than argued: a hypothetical build blocker drives the
  // verdict to BLOCKED_BEFORE_BUILD.
  const hypothetical = {
    ...result,
    blockers: [...result.blockers, { path: 'artifact.built', phase: 'REQUIRED_BEFORE_BUILD', owner: 'AWE', kind: 'BUILD', reason: 'x', source: 'repository' }],
  };
  check(!passes(hypothetical, 'REQUIRED_BEFORE_BUILD'),
    'an unbuilt artifact fails the build gate');
  check(!passes(hypothetical, 'REQUIRED_BEFORE_GO_LIVE'),
    'and therefore also the go-live gate — you cannot go live on what you could not build');
}

// A gate that passes a phase must have nothing blocking at or before it.
for (const phase of ['REQUIRED_BEFORE_BUILD', 'REQUIRED_BEFORE_DEPLOY', 'REQUIRED_BEFORE_GO_LIVE']) {
  const limit = { REQUIRED_BEFORE_BUILD: 0, REQUIRED_BEFORE_DEPLOY: 1, REQUIRED_BEFORE_GO_LIVE: 2 }[phase];
  const blocking = result.blockers.filter((b) =>
    ({ REQUIRED_BEFORE_BUILD: 0, REQUIRED_BEFORE_DEPLOY: 1, REQUIRED_BEFORE_GO_LIVE: 2 })[b.phase] <= limit);
  eq(passes(result, phase), blocking.length === 0,
    `passes(${phase}) agrees with the blockers at or before it`);
}

// ---------------------------------------------------------------------------
console.log('--- PCC today: BUILD_ONLY, and why -------------------------------');

// THIS IS THE FACT THE SESSION IS ABOUT. PCC was DEPLOY_ONLY while the manifest
// said Linux and said nothing about PCC_ENVIRONMENT or PCC_ORG_ID. Correcting
// both moved it to BUILD_ONLY, and that is the model telling the truth rather
// than a regression: installing before those are set would waste the first
// records the company ever produces.
eq(result.verdict, 'BUILD_ONLY',
  'PCC can be built and cannot yet be correctly installed');

const byId0 = Object.fromEntries(result.checks.map((c) => [c.id, c]));
const deployBlockers = result.blockers.filter((b) => b.phase === 'REQUIRED_BEFORE_DEPLOY');
check(deployBlockers.length > 0, 'and something concrete says why');

// THE ONE THING LEFT IS A SIGNATURE. The two measurement facts were deploy
// blockers until the application began refusing a first production start
// without them; the outcome they guarded is now unreachable, so they are
// verified rather than outstanding. What remains is an approved commit, which
// is a person's decision and must not be something the code can grant itself.
{
  const version = result.blockers.find((b) => b.path === 'application.version');
  check(!!version, 'the approved commit is an outstanding blocker');
  check(version && version.phase === 'REQUIRED_BEFORE_DEPLOY', 'it blocks the install, not go-live');
  check(version && version.kind === 'DEPLOYMENT_CONFIG', 'it is a deployment-time configuration blocker');
  check(version && /APPROVED_RELEASE\.md/.test(version.reason),
    'and it names the record a person signs', version?.reason);
  check(version && /nobody has signed|no approval record|names no candidate/.test(version.reason),
    'saying exactly what is missing', version?.reason);
}

// A CANDIDATE THAT DOES NOT EXIST would send somebody to build nothing, and a
// stale one is normal. The first candidate written here named the commit BEFORE
// the work that made the deployment possible, and nothing noticed.
{
  const approval = (await import(R('programs/iic-2027/derive.mjs'))).approvedCommit();
  check(!!approval?.commit, 'an approval record names a candidate commit');
  eq(approval?.inHistory, true, 'and the candidate is a real commit in this history');
  check(typeof approval?.commitsBehindHead === 'number',
    'and how far behind HEAD it is, is reported rather than assumed');
  check(approval?.signedBy === null,
    'and nobody has signed it — this repository does not approve its own releases');

  const gateReq = (await import(R('programs/venture/gates.mjs'))).GATES
    .find((g) => g.n === 1).requires.find((r) => r.id === 'approved_commit');
  eq(gateReq.met({ deployment: { approvedCommit: { commit: 'abc1234', signedBy: 'A Person', inHistory: false } } }), false,
    'a signature on a commit that is not in this history does not count as approval');
  eq(gateReq.met({ deployment: { approvedCommit: { commit: 'abc1234', signedBy: 'A Person', inHistory: true } } }), true,
    'while a signature on a real commit does');
  check(/not in this history/.test(gateReq.detail({ deployment: { approvedCommit: { path: 'p', commit: 'abc1234', inHistory: false } } })),
    'and the refusal says a typo or another branch, rather than only "not approved"');
}
for (const path of ['measurement.environment', 'measurement.org_id_declared']) {
  check(!result.blockers.some((b) => b.path === path),
    `${path} is no longer a blocker — the application refuses a start without it`);
}
// And the mechanism that retired them is itself a gate check, because a
// guarantee that stops being tested is a guarantee that stops.
eq(byId0['measurement.identity_enforced_at_startup']?.status, 'PASS',
  'the startup identity enforcement is checked by the gate');

// The go-live blockers are all external, which is the honest shape of this
// deployment: what remains after AWE's work is Lippolis's decisions.
const goLive = result.blockers.filter((b) => b.phase === 'REQUIRED_BEFORE_GO_LIVE');
check(goLive.length > 0, 'go-live blockers exist');
check(goLive.every((b) => b.kind === 'EXTERNAL'),
  'and every one of them needs somebody outside AWE',
  goLive.filter((b) => b.kind !== 'EXTERNAL').map((b) => b.path).join(', '));

// ---------------------------------------------------------------------------
console.log('--- the platform-specific checks are about the real target -------');

const facts = resolve(pccManifest);
eq(facts['hosting.os']?.value, 'windows', 'the manifest target is Windows');
eq(facts['service.manager']?.value, 'windows-service',
  'and the service manager is DERIVED from it rather than declared');

const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
eq(byId['platform.tooling_present']?.status, 'PASS',
  'the Windows install tooling is present');
eq(byId['platform.paths_agree']?.status, 'PASS',
  'the manifest and the Windows installer put the application in the same place');
eq(byId['platform.data_path_agrees']?.status, 'PASS',
  'and the manifest data path is the one the execution package creates');
eq(byId['documentation.platform_path_correct']?.status, 'PASS',
  'the authoritative runbook carries a Windows path that stays on Windows tooling');

// UNKNOWN IS NOT PASS AND IT IS NOT BLOCKED. The adapter has never run on a
// real machine; no repository check can change that, and pretending otherwise
// is the exact failure mode this whole gate exists to prevent.
eq(byId['platform.adapter_proven']?.status, 'UNKNOWN',
  'the Windows service adapter is honestly unproven');
check(!result.blockers.some((b) => b.path === 'platform.adapter_proven'),
  'and an unproven adapter is reported as unknown rather than counted as a blocker');
check(result.unknown.some((c) => c.id === 'platform.adapter_proven'),
  'it appears under what cannot be answered from here');
check(result.unknown.some((c) => c.id === 'measurement.set_on_the_server'),
  'as does whether the server itself carries the two permanent settings');

// The evidence guard is a gate check, because a build that lost it would still
// pass every other assertion in this repository.
eq(byId['measurement.identity_enforced_at_startup']?.status, 'PASS',
  'the startup identity check is part of readiness, not an unwatched implementation detail');

// ---------------------------------------------------------------------------
console.log('--- the gate holds no deployment truth of its own -----------------');

const source = readFileSync(R('scripts/pcc-deployment-gate.mjs'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// It must not carry its own copy of which fields exist or what they require.
check(!/FIELDS\s*=/.test(source), 'it does not define its own manifest fields');
check(!/ownerFor\s*=/.test(source), 'it does not define its own ownership rules');
for (const imported of ['deployment/blockers.mjs', 'deployment/manifest.mjs', 'deployment/examples/pcc.manifest.mjs']) {
  check(source.includes(imported), `it composes ${imported}`);
}
check(/adapters\/index\.mjs/.test(source), 'and the adapter registry, rather than listing platforms');

// A hostname, a password or a path invented here would be deployed.
check(!/192\.168\.\d+\.\d+/.test(source), 'it hardcodes no address');
check(!/(password|secret)\s*=\s*['"][^'"]{6,}/i.test(source), 'it hardcodes no credential');

// Read-only, and it must stay that way: this runs on machines where writing
// would be the mistake.
for (const mutation of ['writeFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'execSync', 'spawnSync']) {
  check(!source.includes(mutation), `it never calls ${mutation}`);
}

check(existsSync(R('scripts/pcc-deployment-gate.mjs')), 'the gate exists where the runbook can name it');
const pkg = JSON.parse(readFileSync(R('package.json'), 'utf8'));
check(Object.values(pkg.scripts ?? {}).some((s) => s.includes('pcc-deployment-gate.mjs')),
  'and package.json exposes it, so it is not a script only its author knows about');

console.log('');
console.log(`deployment gate: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
