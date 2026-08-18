// ---------------------------------------------------------------------------
// eval-deployment-core.mjs — the AWE deployment substrate, tested.
//
// The substrate exists to answer, for any organization: what is known, what is
// guessed, what is verified, what is unresolved, who owns it, and what evidence
// supports the claim that it is ready.
//
// THE TEST THAT MATTERS MOST is that it describes PCC correctly — including
// surfacing the outstanding hostname as a go-live blocker through the model
// rather than through special-case code — and that it describes a synthetic
// organization shaped nothing like Lippolis without requiring a Jose.
//
//   node scripts/eval-deployment-core.mjs
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const D = join(HERE, '..', 'deployment');

const { declared, unknown, verified, toFact, isKnown, upgrade } = await import(join(D, 'facts.mjs'));
const { FIELDS, validateManifest, resolve, isSecretReference, looksLikeSecretValue, factAt } =
  await import(join(D, 'manifest.mjs'));
const { blockers, blockersForPhase, blockersUpTo, canPass, furthestReachablePhase } =
  await import(join(D, 'blockers.mjs'));
const { record, readiness, currentFor, EVIDENCE_KINDS } = await import(join(D, 'evidence.mjs'));
const { runPreflight, hostProbe, CHECKS } = await import(join(D, 'preflight.mjs'));
const { runCleanInstall } = await import(join(D, 'clean-install.mjs'));
const { resolveResponsibilities, unownedDomains, RESPONSIBILITY_DOMAINS } = await import(join(D, 'responsibilities.mjs'));
const { adapterFor, SUPPORTED_SERVICE_MANAGERS, provenAdapters } = await import(join(D, 'adapters/index.mjs'));
const { generateHandoff } = await import(join(D, 'handoff.mjs'));
const { pccManifest } = await import(join(D, 'examples/pcc.manifest.mjs'));
const { org002Manifest } = await import(join(D, 'examples/org-002-synthetic.manifest.mjs'));

let pass = 0;
const failures = [];
const ok = () => { pass++; };
const bad = (m) => { failures.push(m); console.log(`FAIL  ${m}`); };
const check = (c, m) => (c ? ok() : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok() : bad(`${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

// ---------------------------------------------------------------------------
console.log('--- facts: knowing HOW you know -------------------------------');

eq(unknown('x').state, 'UNKNOWN', 'an unestablished fact is UNKNOWN, not absent');
check(unknown('nobody asked').reason === 'nobody asked', 'and it carries why');
check(!isKnown(unknown()), 'an unknown fact is not known');
check(isKnown(declared('linux', 'it')), 'a declared fact is known');
eq(toFact('bare').state, 'DECLARED', 'a bare value in a manifest counts as declared by whoever wrote it');
eq(toFact(null).state, 'UNKNOWN', 'a null is unknown rather than a value');

// The distinction the whole model rests on.
check(declared('linux', 'it').state !== verified('linux', 'uname').state,
  'declared and verified are different kinds of true');

// A derivation must never overwrite what a human declared about their own machine.
const declaredMgr = declared('docker-compose', 'customer');
eq(upgrade(declaredMgr, { value: 'systemd', state: 'DERIVED', source: 'os' }).value, 'docker-compose',
  'a derivation does not overwrite a declared value');
eq(upgrade(declaredMgr, verified('systemd', 'systemctl')).value, 'systemd',
  'but verification does');

// ---------------------------------------------------------------------------
console.log('--- manifest: secrets never live here --------------------------');

check(isSecretReference('secret-ref:vault/x'), 'secret-ref: form is a reference');
check(isSecretReference('env:SESSION_SECRET'), 'env: form is a reference');
check(isSecretReference('/etc/pcc.env'), 'an absolute path is a reference');
check(!isSecretReference('hunter2'), 'a bare word is not a reference');
check(looksLikeSecretValue('sk_live_abcdefghijklmnop'), 'a key-shaped string looks like a secret');
check(looksLikeSecretValue('Zx8kQ2mPl4nB7vC1aS9dF3gH'), 'a long high-entropy string looks like a secret');
check(!looksLikeSecretValue('/var/lib/pcc'), 'a path does not');
check(!looksLikeSecretValue('linux'), 'nor does an ordinary value');

{
  const leaked = { ...pccManifest, secrets: { store: '/etc/pcc.env', session_secret: 'Zx8kQ2mPl4nB7vC1aS9dF3gH' } };
  const v = validateManifest(leaked);
  check(!v.ok, 'a manifest carrying a secret VALUE is invalid');
  check(v.problems.some((p) => p.path === 'secrets.session_secret'), 'and the offending field is named');
}
check(validateManifest(pccManifest).ok, 'the real PCC manifest is valid');
check(validateManifest(org002Manifest).ok, 'and so is the synthetic one');

{
  const typo = { ...pccManifest, network: { ...pccManifest.network, hostnmae: 'x.y' } };
  check(validateManifest(typo).problems.some((p) => /hostnmae/.test(p.path)),
    'a misspelled field is reported rather than silently ignored');
}

// ---------------------------------------------------------------------------
console.log('--- derivation: inferred, and labelled as inferred --------------');

{
  const facts = resolve(pccManifest);
  eq(facts['service.manager'].value, 'systemd', 'linux derives systemd');
  eq(facts['service.manager'].state, 'DERIVED', 'and it is labelled DERIVED, not declared');
  check(/hosting.os/.test(facts['service.manager'].source), 'and it says what it was derived from');
}
{
  // The synthetic organization is the test: a managed platform must NOT derive
  // systemd from being Linux underneath.
  const facts = resolve(org002Manifest);
  eq(facts['service.manager'].value, 'platform-managed',
    'a managed platform does not derive systemd merely because the OS is linux');
}
{
  const noOs = { ...pccManifest, hosting: { ...pccManifest.hosting, os: unknown('not asked') } };
  eq(resolve(noOs)['service.manager'].state, 'UNKNOWN',
    'with no OS, the service manager stays UNKNOWN rather than defaulting');
}

// ---------------------------------------------------------------------------
console.log('--- blockers: not every unknown stops everything ----------------');

{
  const b = blockers(pccManifest);
  const paths = b.map((x) => x.path);
  check(paths.includes('network.hostname'), "PCC's outstanding hostname appears as a blocker");
  eq(b.find((x) => x.path === 'network.hostname').phase, 'REQUIRED_BEFORE_GO_LIVE',
    'and it blocks go-live, not the build');
  eq(b.find((x) => x.path === 'network.hostname').owner, 'CUSTOMER_IT',
    'and it is addressed to whoever owns DNS');

  check(canPass(pccManifest, 'REQUIRED_BEFORE_BUILD'), 'PCC can still be built');
  check(!canPass(pccManifest, 'REQUIRED_BEFORE_GO_LIVE'), 'PCC cannot go live');
  eq(furthestReachablePhase(pccManifest), 'DEPLOY_ONLY',
    'PCC can be deployed but not gone live on — which is exactly where it is');
}
{
  // A missing runtime floor stops the build; a missing monitoring tool does not.
  const noRuntime = { ...pccManifest, runtime: { name: declared('node', 'awe'), min_version: unknown('not stated') } };
  eq(blockersForPhase(noRuntime, 'REQUIRED_BEFORE_BUILD').map((b) => b.path), ['runtime.min_version'],
    'a missing runtime floor blocks the build');
  check(!canPass(noRuntime, 'REQUIRED_BEFORE_BUILD'), 'and the build phase cannot pass');

  check(!blockers(pccManifest).some((b) => b.path === 'operations.monitoring'),
    'a missing monitoring tool is non-blocking');
}
check(blockersUpTo(pccManifest, 'REQUIRED_BEFORE_GO_LIVE').length >= blockersUpTo(pccManifest, 'REQUIRED_BEFORE_DEPLOY').length,
  'later phases inherit the earlier phases blockers');

// ---------------------------------------------------------------------------
console.log('--- preflight: observational, and honest about what it cannot see');

{
  // THE SAFETY RULE, enforced structurally rather than by discipline.
  const mutating = [{ id: 'evil.fix', phase: 'REQUIRED_BEFORE_DEPLOY', mutates: true, run: () => { throw new Error('should never run'); } }];
  const r = await runPreflight(pccManifest, { checks: mutating });
  eq(r.results[0].status, 'BLOCKED', 'a check declaring mutation is refused, not run');
  check(/observational/.test(r.results[0].detail), 'and the refusal says why');
}
{
  // A probe that can see nothing must produce UNKNOWN, never PASS.
  const blind = await runPreflight(pccManifest, { probe: hostProbe({ env: {} }) });
  check(blind.counts.UNKNOWN > 0, 'a blind probe yields UNKNOWNs');
  check(!blind.results.some((r) => r.status === 'PASS' && /cannot/i.test(r.detail)),
    'nothing that could not be checked is reported as passing');
}
{
  // The real defect this would have caught: records inside the application dir.
  const bad = {
    ...pccManifest,
    hosting: { ...pccManifest.hosting, install_path: declared('/srv/pcc', 'runbook') },
    storage: { ...pccManifest.storage, data_path: declared('/srv/pcc/data', 'runbook') },
  };
  const r = await runPreflight(bad, { probe: hostProbe() });
  const inTree = r.results.find((x) => x.id === 'storage.not_in_source_tree');
  eq(inTree.status, 'BLOCKED', 'data inside the application directory is blocked');
  check(/delete/.test(inTree.detail), 'and it explains what would be lost');
}
{
  // An embedded store on a network filesystem — the org-002 shape.
  const r = await runPreflight({ ...org002Manifest, database: { ...org002Manifest.database, engine: declared('sqlite', 'x') } },
    { probe: hostProbe() });
  eq(r.results.find((x) => x.id === 'storage.local_filesystem').status, 'BLOCKED',
    'an embedded store on a network filesystem is blocked');
}
{
  // Runtime floor, checked against the process actually running.
  const r = await runPreflight(pccManifest, { probe: hostProbe() });
  eq(r.results.find((x) => x.id === 'runtime.version').status, 'PASS', 'this runtime satisfies the declared floor');

  const tooNew = { ...pccManifest, runtime: { name: declared('node', 'x'), min_version: declared('999', 'x') } };
  eq((await runPreflight(tooNew, { probe: hostProbe() })).results.find((x) => x.id === 'runtime.version').status, 'BLOCKED',
    'an unreachable runtime floor is blocked');
}
{
  // Required environment variables.
  const withEnv = hostProbe({ env: { NODE_ENV: 'production', SESSION_SECRET: 'x', PCC_DATABASE_PATH: '/d', APP_BASE_URL: 'https://h' } });
  eq((await runPreflight(pccManifest, { probe: withEnv })).results.find((x) => x.id === 'config.required_present').status, 'PASS',
    'all required variables present passes');
  const missing = hostProbe({ env: { NODE_ENV: 'production' } });
  const r = (await runPreflight(pccManifest, { probe: missing })).results.find((x) => x.id === 'config.required_present');
  eq(r.status, 'BLOCKED', 'missing required variables blocks');
  check(!/SESSION_SECRET=/.test(r.detail), 'and the report names variables without printing values');
}
{
  // Development defaults leaking into production.
  const devish = hostProbe({ env: { APP_BASE_URL: 'http://localhost:3000', SESSION_SECRET: 'development-secret' } });
  eq((await runPreflight(pccManifest, { probe: devish })).results.find((x) => x.id === 'config.no_dev_defaults').status, 'WARNING',
    'development-looking values are warned about');
}
check(CHECKS.every((c) => c.mutates === false), 'every shipped check declares itself non-mutating');

// ---------------------------------------------------------------------------
console.log('--- verification must not condemn correct customer data ---------');

// Deployment Invariant 4, learned the hard way: PCC's verifier flagged real
// suppliers as demo data because their NAMES matched the fixture, and would
// have told an operator to delete the real vendor directory.
//
// The substrate encodes this as a rule about what a check may conclude: a check
// may not report BLOCKED on customer content it cannot distinguish from
// legitimate data.
{
  const nameBased = {
    id: 'bad.name_match', phase: 'REQUIRED_BEFORE_GO_LIVE', mutates: false,
    run() { return { id: 'bad.name_match', status: 'BLOCKED', detail: 'vendor named Graybar Electric looks like demo data' }; },
  };
  const r = await runPreflight(pccManifest, { checks: [nameBased] });
  // The runner cannot know this is wrong — which is the point. The invariant is
  // enforced by review, and the test pins the SHAPE we refuse to ship: no check
  // in CHECKS inspects customer records at all.
  check(r.results[0].status === 'BLOCKED', 'a name-matching check would block (this is the shape we reject)');
  check(!CHECKS.some((c) => /vendor|customer|record|demo/i.test(c.id)),
    'no shipped preflight check inspects customer records — environment only');
}

// ---------------------------------------------------------------------------
console.log('--- validators verify the property, not a resemblance -----------');

// The class of bug this whole section pins: a validator that infers danger from
// weak resemblance to something bad. It has now happened twice — PCC's verifier
// condemned real suppliers because their NAMES matched the fixture, and this
// module's own secret detector condemned a legitimate version string.

// The exact version string that was wrongly flagged.
check(!looksLikeSecretValue('main@0038-po-number-per-job-vendor'),
  'a version string with structure is not mistaken for a secret');
for (const ordinary of [
  'v1.2.3-rc.1+build.456',
  '/var/lib/pcc/pcc.sqlite',
  'https://pcc.lippolis.local',
  'pcc.lippolis.local',
  'Lippolis Electric, Inc.',
  'postgres://user@host:5432/db',
  '24-118-GRAYBARELECTRIC-1',
  'WORKSHOP_APPROVER',
]) check(!looksLikeSecretValue(ordinary), `an ordinary value is not flagged: ${ordinary}`);

// And it still catches the shapes that are actually secrets.
for (const secret of ['sk_live_51H8xKlAbCdEfGhIjKlMn', 'ghp_AbCdEfGhIjKlMnOpQrStUv1234', 'AKIAIOSFODNN7EXAMPLE']) {
  check(looksLikeSecretValue(secret), `a real token shape is still caught: ${secret.slice(0, 8)}…`);
}

// Not being on the target machine is UNKNOWN, never BLOCKED — a check that
// fails on a correct setup teaches operators to ignore the report.
{
  const onMac = hostProbe({ platform: 'darwin', commandAvailable: () => false });
  const r = (await runPreflight(pccManifest, { probe: onMac })).results.find((x) => x.id === 'service.manager_available');
  eq(r.status, 'UNKNOWN', 'a linux service manager checked from macOS is UNKNOWN, not a failure');
  check(/target machine/.test(r.detail), 'and it says to run it on the target');

  const onLinux = hostProbe({ platform: 'linux', commandAvailable: () => false });
  const r2 = (await runPreflight(pccManifest, { probe: onLinux })).results.find((x) => x.id === 'service.manager_available');
  eq(r2.status, 'BLOCKED', 'but on the target itself a missing service manager IS a failure');
}

// No shipped check reads customer content. Environment only.
check(!CHECKS.some((c) => /vendor|customer|record|demo|supplier/i.test(c.id + (c.describe ?? ''))),
  'no shipped check inspects customer records');

// ---------------------------------------------------------------------------
console.log('--- clean install: never from a development fixture -------------');

const okStep = (extra = {}) => ({ ok: true, ...extra });
const goodApp = {
  emptyDatabase: async () => okStep({ rowCount: 0 }),
  migrate: async () => okStep({ detail: 'schema created' }),
  bootstrap: async () => okStep({ usedDevelopmentFixture: false }),
  build: async () => okStep(),
  start: async () => okStep(),
  health: async () => okStep(),
  renderedPage: async () => okStep({ detail: 'sign-in rendered with stylesheet' }),
  workflow: async () => okStep({ reference: 'PO-1' }),
  restart: async () => okStep({ createdNewDatabase: false }),
  verifyPersistence: async (ref) => okStep({ detail: `${ref} survived` }),
  stop: async () => {},
};
const runCtx = { environment: 'test', version: 'v1', at: '2026-08-13T00:00:00Z' };

{
  const run = await runCleanInstall(goodApp, runCtx);
  check(run.ok, 'a clean install passes end to end');
  eq(run.steps.map((s) => s.name).filter((n, i, a) => a.indexOf(n) === i),
    ['EMPTY_DATABASE', 'MIGRATIONS', 'PRODUCTION_BOOTSTRAP', 'BUILD', 'START', 'HEALTH', 'WORKFLOW', 'RESTART', 'PERSISTENCE'],
    'and runs the lifecycle in order');
  check(run.evidence.some((e) => e.kind === 'RENDERED_PAGE_VERIFIED'),
    'a rendered page is separate evidence from a health check');
}
{
  const fixtureApp = { ...goodApp, bootstrap: async () => okStep({ usedDevelopmentFixture: true }) };
  const run = await runCleanInstall(fixtureApp, runCtx);
  check(!run.ok, 'a bootstrap that uses a development fixture fails the harness');
  check(/fixture/.test(run.steps.at(-1).detail), 'and says so');
}
{
  const seeded = { ...goodApp, emptyDatabase: async () => okStep({ rowCount: 42 }) };
  const run = await runCleanInstall(seeded, runCtx);
  check(!run.ok, 'a database that is not empty fails the harness');
}
{
  // The exact PCC defect: healthy process, unusable product.
  const unstyled = { ...goodApp, renderedPage: async () => ({ ok: false, detail: 'stylesheet 404' }) };
  const run = await runCleanInstall(unstyled, runCtx);
  check(!run.ok, 'health passing while the page does not render is a failure');
  check(/health passed but a real page did not render/.test(run.steps.at(-1).detail), 'and is described precisely');
}
{
  const ephemeral = { ...goodApp, restart: async () => okStep({ createdNewDatabase: true }) };
  const run = await runCleanInstall(ephemeral, runCtx);
  check(!run.ok, 'a restart that creates a new database fails — the data path is not persistent');
}

// ---------------------------------------------------------------------------
console.log('--- readiness is derived, never asserted -----------------------');

const fullLog = [
  'BUILD_SUCCEEDED', 'MIGRATIONS_SUCCEEDED', 'CLEAN_INSTALL_VALIDATED', 'HEALTHCHECK_SUCCEEDED',
  'RENDERED_PAGE_VERIFIED', 'DATABASE_PERSISTED_AFTER_RESTART', 'SERVICE_ENABLED_AT_BOOT',
  'REBOOT_RECOVERY_SUCCEEDED', 'BACKUP_CREATED', 'RESTORE_SUCCEEDED', 'WORKFLOW_VALIDATED', 'OPERATOR_ACCEPTED',
].map((kind) => record({ kind, result: 'PASS', environment: 'lippolis-vm', version: 'v1', at: '2026-08-13T00:00:00Z', producedBy: 'test' }));

const noBlockers = () => [];
{
  const r = readiness(pccManifest, fullLog, { environment: 'lippolis-vm', version: 'v1', policy: 'PILOT', blockersFn: noBlockers });
  check(r.ready, 'complete evidence and no blockers is ready');
}
{
  const short = fullLog.filter((e) => e.kind !== 'RESTORE_SUCCEEDED');
  const r = readiness(pccManifest, short, { environment: 'lippolis-vm', version: 'v1', policy: 'PILOT', blockersFn: noBlockers });
  check(!r.ready, 'missing evidence is not ready');
  check(r.missingEvidence.includes('RESTORE_SUCCEEDED'), 'and the missing piece is named');
}
{
  const failing = [...fullLog.filter((e) => e.kind !== 'BACKUP_CREATED'),
    record({ kind: 'BACKUP_CREATED', result: 'FAIL', environment: 'lippolis-vm', version: 'v1', at: '2026-08-13T01:00:00Z', producedBy: 'test' })];
  const r = readiness(pccManifest, failing, { environment: 'lippolis-vm', version: 'v1', policy: 'PILOT', blockersFn: noBlockers });
  check(!r.ready, 'failing evidence is not ready');
  check(r.failedEvidence.some((f) => f.kind === 'BACKUP_CREATED'), 'and the failure is named');
}
{
  // Evidence about a different version does not support this one.
  const r = readiness(pccManifest, fullLog, { environment: 'lippolis-vm', version: 'v2', policy: 'PILOT', blockersFn: noBlockers });
  check(!r.ready, "evidence from another version does not make this version ready");
}
{
  // And blockers alone are enough to withhold readiness.
  const r = readiness(pccManifest, fullLog, {
    environment: 'lippolis-vm', version: 'v1', policy: 'PILOT',
    blockersFn: (m, phase) => blockersForPhase(m, phase),
  });
  check(!r.ready, "PCC's outstanding blockers prevent readiness even with full evidence");
  check(r.blockers.some((b) => b.path === 'network.hostname'), 'and the hostname is one of them');
}
check(EVIDENCE_KINDS.includes('RENDERED_PAGE_VERIFIED'), 'the model has evidence for "the page actually rendered"');

// Evidence must be able to say what it is about.
{
  let threw = false;
  try { record({ kind: 'BUILD_SUCCEEDED', result: 'PASS', environment: 'e', producedBy: 'p', at: 't' }); } catch { threw = true; }
  check(threw, 'evidence without a version is refused');
}

// ---------------------------------------------------------------------------
console.log('--- responsibilities: no Jose required -------------------------');

{
  const r = resolveResponsibilities(pccManifest);
  eq(r.INFRASTRUCTURE, 'CUSTOMER_IT', 'Lippolis infrastructure is customer IT');
  check(unownedDomains(pccManifest).includes('MONITORING'), 'and PCC has no monitoring owner, stated');
}
{
  const r = resolveResponsibilities(org002Manifest);
  check(!Object.values(r).includes('CUSTOMER_IT'),
    'the synthetic organization needs no internal IT department anywhere');
  eq(r.INFRASTRUCTURE, 'HOSTING_PROVIDER', 'infrastructure belongs to the hosting provider');
  eq(r.DATABASE, 'MSP', 'the database belongs to an MSP');
}
{
  const empty = resolveResponsibilities({});
  check(RESPONSIBILITY_DOMAINS.every((d) => empty[d] === 'UNKNOWN'),
    'an organization nobody has been asked about is UNKNOWN everywhere, not assumed');
}
{
  // Every blocker must be addressable to somebody, or say that it is not.
  const b = blockers(org002Manifest);
  check(b.every((x) => typeof x.owner === 'string' && x.owner.length > 0), 'every blocker names an owner');
  check(!b.some((x) => x.owner === 'CUSTOMER_IT'), 'and none of org-002 blockers assume an internal IT department');
}

// ---------------------------------------------------------------------------
console.log('--- adapters: the core has no OS opinions ----------------------');

check(adapterFor('systemd').ok, 'systemd has an adapter');
check(adapterFor('windows-service').ok, 'so does windows-service, now that there is a named target');
check(!adapterFor('platform-managed').ok, 'a managed platform does not — and says so rather than pretending');
check(/no adapter for/.test(adapterFor('platform-managed').reason), 'the gap is explained');
check(!adapterFor(null).ok, 'an unknown service manager yields no adapter');
eq(SUPPORTED_SERVICE_MANAGERS, ['systemd', 'windows-service'], 'two adapters have written mechanics');
// The invariant this file has always defended is NOT "one adapter exists" — it
// is that having mechanics is never mistaken for having deployed. Windows has
// an adapter and no completed installation, and that has to stay legible.
eq(provenAdapters(), ['systemd'], 'exactly one adapter has a real deployment behind it');
check(adapterFor('windows-service').adapter.proven === false,
  'the windows adapter admits it is unproven until an installation says otherwise');
{
  const unit = adapterFor('systemd').adapter.unit({
    app: 'pcc', description: 'PCC', installPath: '/opt/pcc', dataPath: '/var/lib/pcc',
    secretsStore: '/etc/pcc.env', user: 'pcc', start: '/usr/bin/node server.js',
  });
  check(/RestartPreventExitStatus=1/.test(unit), 'the unit restarts on crash but not on refusal');
  check(/ReadWritePaths=\/var\/lib\/pcc/.test(unit), 'and can write exactly one directory');
}

// ---------------------------------------------------------------------------
console.log('--- handoff generated from state -------------------------------');

{
  const doc = generateHandoff(pccManifest, { evidenceLog: fullLog, environment: 'lippolis-vm', version: 'v1' });
  check(/network\.hostname/.test(doc), 'the generated handoff lists the outstanding hostname');
  check(/_not established_/.test(doc), 'and marks unestablished facts as such');
  check(/systemctl enable/.test(doc), 'and carries an install plan from the adapter');
  check(!/hunter2|BEGIN PRIVATE KEY/.test(doc), 'and leaks no secret');
  check(/env:SESSION_SECRET/.test(doc), 'a secret REFERENCE is printed, which is safe and useful');
}
{
  const doc = generateHandoff(org002Manifest, { evidenceLog: [], environment: 'x', version: 'v1' });
  check(/Cannot generate an install plan/.test(doc),
    'no install plan is invented for a platform with no adapter');
  check(/_No evidence has been recorded/.test(doc), 'and an empty evidence log says so');
}

// ---------------------------------------------------------------------------
console.log('--- the model describes PCC correctly --------------------------');

{
  // The critical test: if the substrate cannot describe deployment #1, it is wrong.
  const facts = resolve(pccManifest);
  eq(facts['runtime.name'].state, 'VERIFIED', 'the runtime is verified because this process is it');
  eq(facts['hosting.os'].state, 'DECLARED', 'the OS is declared — nobody has run uname on the VM');
  eq(facts['service.manager'].state, 'DERIVED', 'the service manager is derived from the OS');
  eq(facts['network.hostname'].state, 'UNKNOWN', 'the hostname is genuinely unknown');

  const b = blockersForPhase(pccManifest, 'REQUIRED_BEFORE_GO_LIVE').map((x) => x.path);
  check(b.includes('network.hostname'), 'and it is the go-live blocker it actually is');
  eq(furthestReachablePhase(pccManifest), 'DEPLOY_ONLY', 'PCC is deployable, not live — which is true today');
}

console.log('');
console.log(`deployment core checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);
