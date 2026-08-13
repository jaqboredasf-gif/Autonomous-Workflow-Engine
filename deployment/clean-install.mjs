// ---------------------------------------------------------------------------
// clean-install.mjs — the test PCC did not have.
//
// WHY THIS EXISTS. PCC's test suite is large and passes. It built every
// database from the development fixture, and so could not see any of these:
//
//   · a seed that created a published administrator password on any empty database
//   · a misconfigured data path producing a new empty database, migrated, healthy
//   · a schema version stamped at creation rather than at migration
//   · a standalone build answering 200 on health and 404 on every stylesheet
//   · an order quantity computed in the browser, so an unhydrated page ordered
//     the wrong amount with no error
//
// Every one lived in the gap between "fresh fixture" and "real installation".
// That gap is not PCC's; it belongs to any application whose tests seed
// themselves.
//
// THE INVARIANT: a capability is not deployment-ready because it passes tests
// against development fixtures.
//
// ---------------------------------------------------------------------------
// WHERE AWE ENDS AND THE APPLICATION BEGINS
//
// AWE owns the LIFECYCLE below — the order of the steps, the insistence that
// the database starts empty, the restart, and the persistence comparison. Those
// are the same at every organization.
//
// The application supplies four things, and nothing else:
//   build()      produce the artifact
//   start()      run it against the given data path, return a handle
//   bootstrap()  the MINIMUM production-required data — never a fixture
//   workflow()   one representative business transaction, and read it back
//
// An application that cannot express `bootstrap` without importing its
// development seed has found a real defect in itself, not an inconvenience.
// ---------------------------------------------------------------------------

export const CLEAN_INSTALL_STEPS = [
  'EMPTY_DATABASE',
  'MIGRATIONS',
  'PRODUCTION_BOOTSTRAP',
  'BUILD',
  'START',
  'HEALTH',
  'WORKFLOW',
  'RESTART',
  'PERSISTENCE',
];

/**
 * A step outcome. `evidence` names the evidence kind this step supports, so a
 * passing run feeds the readiness model directly instead of being read by a
 * person and retyped.
 */
const step = (name, ok, detail, evidence = null) => ({ name, ok, detail, evidence });

/**
 * Run the clean-install lifecycle.
 *
 * `app` is the adapter the application supplies. Everything is injected: this
 * module runs no commands and knows no paths, which is what lets it be tested
 * without a server and reused without modification.
 *
 * Stops at the first failure. A clean install is a sequence, and continuing
 * past a failed migration produces noise about a system that does not exist.
 */
export async function runCleanInstall(app, { environment, version, at }) {
  const steps = [];
  const fail = (name, detail) => {
    steps.push(step(name, false, detail));
    return { ok: false, steps, evidence: toEvidence(steps, { environment, version, at }) };
  };

  // 1. EMPTY. Asserted, not assumed — the point of the whole exercise.
  const empty = await app.emptyDatabase();
  if (!empty?.ok) return fail('EMPTY_DATABASE', empty?.detail ?? 'could not establish an empty database');
  if (empty.rowCount && empty.rowCount > 0) {
    return fail('EMPTY_DATABASE', `expected an empty database, found ${empty.rowCount} row(s) — this harness must not start from a fixture`);
  }
  steps.push(step('EMPTY_DATABASE', true, 'a database with nothing in it'));

  // 2. MIGRATIONS.
  const migrated = await app.migrate();
  if (!migrated?.ok) return fail('MIGRATIONS', migrated?.detail ?? 'migrations failed');
  steps.push(step('MIGRATIONS', true, migrated.detail ?? 'schema created', 'MIGRATIONS_SUCCEEDED'));

  // 3. PRODUCTION BOOTSTRAP ONLY. If this needs the development seed, the
  //    application cannot be installed at a customer, and that is the finding.
  const bootstrapped = await app.bootstrap();
  if (!bootstrapped?.ok) return fail('PRODUCTION_BOOTSTRAP', bootstrapped?.detail ?? 'bootstrap failed');
  if (bootstrapped.usedDevelopmentFixture) {
    return fail('PRODUCTION_BOOTSTRAP', 'bootstrap used a development fixture — a clean install must not depend on one');
  }
  steps.push(step('PRODUCTION_BOOTSTRAP', true, bootstrapped.detail ?? 'minimum production data only'));

  // 4. BUILD.
  const built = await app.build();
  if (!built?.ok) return fail('BUILD', built?.detail ?? 'build failed');
  steps.push(step('BUILD', true, built.detail ?? 'artifact produced', 'BUILD_SUCCEEDED'));

  // 5. START.
  const started = await app.start();
  if (!started?.ok) return fail('START', started?.detail ?? 'the application did not start');
  steps.push(step('START', true, started.detail ?? 'running'));

  try {
    // 6. HEALTH — and a RENDERED PAGE. PCC answered 200 while serving no
    //    stylesheets at all: the process was healthy and the product was
    //    unusable. Health alone is not evidence that anything works.
    const health = await app.health();
    if (!health?.ok) return fail('HEALTH', health?.detail ?? 'health check failed');
    steps.push(step('HEALTH', true, health.detail ?? 'healthy', 'HEALTHCHECK_SUCCEEDED'));

    if (app.renderedPage) {
      const page = await app.renderedPage();
      if (!page?.ok) return fail('HEALTH', `health passed but a real page did not render: ${page?.detail ?? 'unknown'}`);
      steps.push(step('HEALTH', true, page.detail ?? 'a real page rendered with its assets', 'RENDERED_PAGE_VERIFIED'));
    }

    // 7. WORKFLOW — the application's own, injected.
    const flow = await app.workflow();
    if (!flow?.ok) return fail('WORKFLOW', flow?.detail ?? 'the representative workflow failed');
    steps.push(step('WORKFLOW', true, flow.detail ?? 'a representative transaction completed', 'WORKFLOW_VALIDATED'));

    // 8. RESTART — what a reboot is, minus the machine.
    const restarted = await app.restart();
    if (!restarted?.ok) return fail('RESTART', restarted?.detail ?? 'the application did not come back');
    if (restarted.createdNewDatabase) {
      return fail('RESTART', 'the restart created a NEW database — the data path is not persistent');
    }
    steps.push(step('RESTART', true, restarted.detail ?? 'came back on the same data'));

    // 9. PERSISTENCE — the transaction from step 7, still there and unchanged.
    const persisted = await app.verifyPersistence(flow.reference);
    if (!persisted?.ok) return fail('PERSISTENCE', persisted?.detail ?? 'the record did not survive the restart');
    steps.push(step('PERSISTENCE', true, persisted.detail ?? 'the record survived intact', 'DATABASE_PERSISTED_AFTER_RESTART'));
  } finally {
    // Always tidy up, including after a failure — a harness that leaves a
    // process listening makes the next run lie about which build answered.
    if (app.stop) await app.stop().catch(() => {});
  }

  return { ok: true, steps, evidence: toEvidence(steps, { environment, version, at }) };
}

/** Turn passing steps into evidence records the readiness model consumes. */
function toEvidence(steps, { environment, version, at }) {
  return steps
    .filter((s) => s.evidence && s.ok)
    .map((s) => ({
      kind: s.evidence,
      result: 'PASS',
      environment,
      version,
      at,
      producedBy: 'deployment/clean-install.mjs',
      detail: s.detail,
    }));
}

/** One clean-install run is also the strongest single piece of evidence. */
export function cleanInstallEvidence(run, { environment, version, at }) {
  return {
    kind: 'CLEAN_INSTALL_VALIDATED',
    result: run.ok ? 'PASS' : 'FAIL',
    environment,
    version,
    at,
    producedBy: 'deployment/clean-install.mjs',
    detail: run.ok
      ? `${run.steps.length} steps from an empty database`
      : `stopped at ${run.steps[run.steps.length - 1]?.name}: ${run.steps[run.steps.length - 1]?.detail}`,
  };
}
