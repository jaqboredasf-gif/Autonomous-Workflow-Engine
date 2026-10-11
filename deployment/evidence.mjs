// ---------------------------------------------------------------------------
// evidence.mjs — why anybody should believe a deployment is ready.
//
// THE RULE: readiness is DERIVED from evidence and blockers. Nothing anywhere
// sets `ready = true`. The PCC readiness scorecard already worked this way and
// the effect was immediate — several rows changed colour the moment the
// evidence column had to be filled in honestly, because "we think that works"
// and "here is the transcript" are different claims.
//
// An evidence record answers, without anybody having to remember:
//   what was checked · when · against which environment · what happened ·
//   what produced the result · which version it applied to
//
// The last one matters more than it looks. Evidence is about a VERSION in an
// ENVIRONMENT. A health check that passed against last week's build in staging
// is not evidence about today's build in production, and an evidence store that
// cannot express that will happily accumulate reassurance about software nobody
// is running.
// ---------------------------------------------------------------------------

/**
 * The kinds of evidence PCC actually produced or plainly needs. Each one is
 * something an artifact can demonstrate — a transcript, an exit code, a
 * response — rather than something a person can assert.
 */
export const EVIDENCE_KINDS = [
  'BUILD_SUCCEEDED',
  'MIGRATIONS_SUCCEEDED',
  'HEALTHCHECK_SUCCEEDED',
  'RENDERED_PAGE_VERIFIED',      // health can be green while the product is unusable
  'SERVICE_RUNNING',
  'SERVICE_ENABLED_AT_BOOT',
  'DATABASE_PERSISTED_AFTER_RESTART',
  'REBOOT_RECOVERY_SUCCEEDED',
  'CLEAN_INSTALL_VALIDATED',     // from an empty database, no development fixtures
  'WORKFLOW_VALIDATED',          // the application's own acceptance
  'IDEMPOTENCY_VALIDATED',       // pressing twice does not double anything
  'DNS_RESOLVED',
  'TLS_VALID',
  'BACKUP_CREATED',
  'RESTORE_SUCCEEDED',
  'OPERATOR_ACCEPTED',
];

export const EVIDENCE_RESULTS = ['PASS', 'FAIL', 'INCONCLUSIVE'];

/**
 * Record one observation.
 *
 * `at` is injected rather than read from the clock so results are reproducible
 * and so evidence can be recorded from a transcript after the fact — which is
 * how most of PCC's evidence actually arrived.
 */
export function record({ kind, result, environment, producedBy, version, at, detail = null }) {
  if (!EVIDENCE_KINDS.includes(kind)) throw new Error(`unknown evidence kind: ${kind}`);
  if (!EVIDENCE_RESULTS.includes(result)) throw new Error(`unknown evidence result: ${result}`);
  for (const [name, value] of [['environment', environment], ['producedBy', producedBy], ['version', version], ['at', at]]) {
    if (!value) throw new Error(`evidence needs ${name} — evidence that cannot say ${name} is an opinion`);
  }
  return Object.freeze({ kind, result, environment, producedBy, version, at, detail });
}

/**
 * The evidence that currently counts for a given environment and version.
 *
 * Evidence for a different version or environment is not discarded — it stays
 * in the log as history — but it does not support a readiness claim about this
 * one. Latest wins for a given kind, so re-running a check after a fix replaces
 * the earlier failure.
 */
export function currentFor(log, { environment, version }) {
  const relevant = log
    .filter((e) => e.environment === environment && e.version === version)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const byKind = new Map();
  for (const e of relevant) byKind.set(e.kind, e);
  return byKind;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * What a deployment must be able to demonstrate before it is handed over.
 *
 * Policy, not law — an internal pilot and a customer-facing system genuinely
 * differ, and that variation belongs in configuration rather than in somebody's
 * judgement on the day.
 *
 * `PILOT` is the honest bar for a first internal deployment: it demands the
 * things PCC's own experience proved were load-bearing, and does not demand
 * DNS or TLS, which a pilot on an IP address can legitimately do without.
 */
export const READINESS_POLICIES = {
  PILOT: {
    phase: 'REQUIRED_BEFORE_GO_LIVE',
    required: [
      'BUILD_SUCCEEDED',
      'MIGRATIONS_SUCCEEDED',
      'CLEAN_INSTALL_VALIDATED',
      'HEALTHCHECK_SUCCEEDED',
      'RENDERED_PAGE_VERIFIED',
      'DATABASE_PERSISTED_AFTER_RESTART',
      'SERVICE_ENABLED_AT_BOOT',
      'REBOOT_RECOVERY_SUCCEEDED',
      'BACKUP_CREATED',
      'RESTORE_SUCCEEDED',
      'WORKFLOW_VALIDATED',
      'OPERATOR_ACCEPTED',
    ],
  },
  PRODUCTION: {
    phase: 'REQUIRED_BEFORE_GO_LIVE',
    required: [
      'BUILD_SUCCEEDED', 'MIGRATIONS_SUCCEEDED', 'CLEAN_INSTALL_VALIDATED',
      'HEALTHCHECK_SUCCEEDED', 'RENDERED_PAGE_VERIFIED', 'SERVICE_RUNNING',
      'SERVICE_ENABLED_AT_BOOT', 'DATABASE_PERSISTED_AFTER_RESTART',
      'REBOOT_RECOVERY_SUCCEEDED', 'IDEMPOTENCY_VALIDATED',
      'DNS_RESOLVED', 'TLS_VALID',
      'BACKUP_CREATED', 'RESTORE_SUCCEEDED',
      'WORKFLOW_VALIDATED', 'OPERATOR_ACCEPTED',
    ],
  },
};

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Is this deployment ready — and if not, exactly why not.
 *
 * Three independent ways to fail, reported separately because they are cleared
 * by different people:
 *   · unresolved blockers        → usually the customer
 *   · missing evidence           → usually us, by running something
 *   · failed evidence            → a real defect
 *
 * There is deliberately no override. A deployment that is ready-except-for is
 * not ready, and the value of the whole model is that the sentence "we are
 * ready" has to be earned by artifacts.
 */
export function readiness(manifest, log, { environment, version, policy = 'PILOT', blockersFn }) {
  const spec = READINESS_POLICIES[policy];
  if (!spec) throw new Error(`unknown readiness policy: ${policy}`);

  const outstanding = blockersFn ? blockersFn(manifest, spec.phase) : [];
  const current = currentFor(log, { environment, version });

  const missing = [];
  const failed = [];
  for (const kind of spec.required) {
    const e = current.get(kind);
    if (!e) missing.push(kind);
    else if (e.result !== 'PASS') failed.push({ kind, result: e.result, detail: e.detail });
  }

  const ready = outstanding.length === 0 && missing.length === 0 && failed.length === 0;
  return {
    ready,
    policy,
    environment,
    version,
    blockers: outstanding,
    missingEvidence: missing,
    failedEvidence: failed,
    satisfied: spec.required.filter((k) => current.get(k)?.result === 'PASS'),
    summary: ready
      ? `Ready for handoff under the ${policy} policy.`
      : [
          outstanding.length ? `${outstanding.length} unresolved blocker(s)` : null,
          missing.length ? `${missing.length} piece(s) of evidence not yet produced` : null,
          failed.length ? `${failed.length} check(s) failing` : null,
        ].filter(Boolean).join('; '),
  };
}
