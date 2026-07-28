// ---------------------------------------------------------------------------
// manifest.mjs — the Workflow Manifest.
//
// Until now "a workflow" in AWE was whatever a caller passed to `runWorkflow`:
// a `workflow_id` string and a body function. Nothing declared which tools that
// workflow is allowed to touch, which tenants may run it, what context it needs
// before it is safe to start, when a human has to approve, how long a step may
// take, what it depends on, how risky it is, or whether it has been promoted out
// of draft. Every one of those facts lived in someone's head or in a runner.
//
// A Workflow Manifest is that declaration, as versioned, runtime-validated data:
//
//   { schema, workflow_id, version, title, description, tenant_scope,
//     required_tools, required_context, approval_policy, limits, dependencies,
//     risk, promotion, steps, metadata, manifest_digest }
//
// FAIL-CLOSED BY CONSTRUCTION. Every rule below refuses rather than defaults:
//
//   * an unknown key is refused, so a typo'd `aproval_policy` cannot silently
//     turn a gated workflow into an ungated one;
//   * `tenant_scope` has no default — a manifest states which tenants may run
//     it, and `allow_list` with zero orgs is refused as a manifest that can
//     never run rather than accepted as one anything can run;
//   * a step naming a tool the manifest did not require is refused, so the
//     required-tools list is the complete authorization surface and not a hint;
//   * `high` and `critical` risk REQUIRE an approval threshold and at least one
//     approver role — a manifest cannot declare itself dangerous and ungated;
//   * `promoted` requires a promotion instant and a named promoter;
//   * a compensation step must name an EARLIER step, because you cannot undo
//     something that has not run yet.
//
// PURE: no clock, no randomness, no I/O. `promoted_at` is data supplied by
// whoever promoted it, which is what keeps a manifest replayable and diffable.
// ---------------------------------------------------------------------------

import { deepFreeze, digest, invariant, isInstant, SIDE_EFFECTS, SIDE_EFFECT_RANK, CONTEXT_ITEM_KINDS, CONTEXT_SENSITIVITIES, sensitivityRank } from './kernel.mjs';
import { definePredicate } from './predicate.mjs';

export const WORKFLOW_MANIFEST_SCHEMA = 'awe.workflow_manifest/v1';

export const MANIFEST_KEYS = [
  'schema', 'workflow_id', 'version', 'title', 'description', 'tenant_scope',
  'required_tools', 'required_context', 'approval_policy', 'limits',
  'dependencies', 'risk', 'promotion', 'steps', 'metadata', 'manifest_digest',
];

// Ordered least → most consequential; `high` and `critical` carry the extra
// obligations enforced below.
export const RISK_CLASSES = ['low', 'medium', 'high', 'critical'];

// Promotion status is the control plane's readiness gate. Only `promoted` is
// executable by default; `draft` and `review` need an explicit, recorded
// override, and `retired` is executable by nothing.
export const PROMOTION_STATES = ['draft', 'review', 'promoted', 'retired'];

// How a manifest states which tenants may run it. There is no third option and
// no default: an omitted scope is a refused manifest.
export const TENANT_SCOPE_MODES = ['allow_list', 'any_tenant'];

// What the engine does when a step has exhausted its attempts.
export const STEP_FAILURE_POLICIES = ['fail', 'compensate'];

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const REQUIREMENT_PATTERN = /^\^?\d+\.\d+\.\d+$/;

const TENANT_SCOPE_KEYS = ['mode', 'org_ids'];
const TOOL_REQUIREMENT_KEYS = ['name', 'version', 'max_side_effect'];
const CONTEXT_REQUIREMENT_KEYS = ['kind', 'source', 'min_items', 'max_sensitivity'];
const APPROVAL_POLICY_KEYS = ['requires_approval_at_or_above', 'approver_roles', 'quorum'];
const LIMIT_KEYS = ['step_timeout_ms', 'run_timeout_ms', 'max_attempts', 'retry_backoff_ms'];
const DEPENDENCY_KEYS = ['workflow_id', 'version'];
const PROMOTION_KEYS = ['status', 'promoted_at', 'promoted_by'];
const STEP_KEYS = ['id', 'tool', 'description', 'input', 'compensates', 'on_failure', 'idempotency_key', 'when'];

// --- version requirements ----------------------------------------------------

/**
 * satisfiesVersion(actual, requirement) -> boolean
 *
 * Two forms only, both exact enough to reason about:
 *   '1.4.2'   pinned — the actual version must be that version
 *   '^1.4.2'  compatible — same MAJOR, and at least that minor.patch
 *
 * Deliberately not a full semver range grammar. A control plane that has to
 * evaluate `>=1.2 <2.0.0-beta || ~1.1` to decide whether a tool may run is a
 * control plane whose authorization surface nobody can read.
 */
export function satisfiesVersion(actual, requirement) {
  if (typeof actual !== 'string' || !SEMVER_PATTERN.test(actual)) return false;
  if (typeof requirement !== 'string' || !REQUIREMENT_PATTERN.test(requirement)) return false;
  if (requirement[0] !== '^') return actual === requirement;

  const [aMajor, aMinor, aPatch] = actual.split('.').map(Number);
  const [rMajor, rMinor, rPatch] = requirement.slice(1).split('.').map(Number);
  if (aMajor !== rMajor) return false;
  if (aMinor !== rMinor) return aMinor > rMinor;
  return aPatch >= rPatch;
}

// Descending order, so "the newest registered version" is `sorted[0]`.
export function compareVersionsDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

// --- validation helpers ------------------------------------------------------

function assertClosedKeys(value, allowed, label) {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input', `${label} must be a plain object`, { label },
  );
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  invariant(
    unknown.length === 0,
    'invalid_input',
    `${label} has unknown key(s) ${JSON.stringify(unknown.sort())} — a manifest key that is not understood is refused, not ignored`,
    { label, unknown: unknown.sort(), allowed },
  );
}

function assertPositiveInt(value, label, { min = 1 } = {}) {
  invariant(
    Number.isInteger(value) && value >= min,
    'invalid_input', `${label} must be an integer >= ${min}, got ${JSON.stringify(value)}`, { label, value },
  );
}

// --- sub-structures ----------------------------------------------------------

function buildTenantScope(scope, workflow_id) {
  invariant(scope !== undefined && scope !== null, 'invalid_input', `workflow '${workflow_id}' must declare a tenant_scope`, { workflow_id });
  assertClosedKeys(scope, TENANT_SCOPE_KEYS, `workflow '${workflow_id}' tenant_scope`);
  const mode = scope.mode;
  invariant(
    TENANT_SCOPE_MODES.includes(mode),
    'invalid_input', `workflow '${workflow_id}' tenant_scope.mode '${mode}' must be one of ${TENANT_SCOPE_MODES.join('|')}`,
    { workflow_id, mode },
  );
  const org_ids = scope.org_ids ?? [];
  invariant(Array.isArray(org_ids), 'invalid_input', `workflow '${workflow_id}' tenant_scope.org_ids must be an array`, { workflow_id });
  org_ids.forEach((id) => invariant(
    typeof id === 'string' && id.length > 0,
    'invalid_input', `workflow '${workflow_id}' tenant_scope.org_ids must hold non-empty strings`, { workflow_id, id },
  ));
  // An allow-list with nothing on it is refused rather than treated as "any":
  // the failure mode of the opposite reading is a workflow that silently runs
  // for every tenant on the platform.
  invariant(
    mode !== 'allow_list' || org_ids.length > 0,
    'invalid_input', `workflow '${workflow_id}' tenant_scope is an allow_list with no tenants on it`, { workflow_id },
  );
  invariant(
    mode !== 'any_tenant' || org_ids.length === 0,
    'invalid_input', `workflow '${workflow_id}' tenant_scope is any_tenant but also lists tenants — say one or the other`, { workflow_id },
  );
  return { mode, org_ids: [...org_ids].sort() };
}

function buildToolRequirements(list, workflow_id) {
  invariant(Array.isArray(list), 'invalid_input', `workflow '${workflow_id}' required_tools must be an array`, { workflow_id });
  invariant(list.length > 0, 'invalid_input', `workflow '${workflow_id}' must require at least one tool`, { workflow_id });
  const seen = new Set();
  return list.map((requirement) => {
    assertClosedKeys(requirement, TOOL_REQUIREMENT_KEYS, `workflow '${workflow_id}' required_tools entry`);
    const { name, version } = requirement;
    invariant(
      typeof name === 'string' && ID_PATTERN.test(name),
      'invalid_input', `workflow '${workflow_id}' required tool name '${name}' must be snake_case`, { workflow_id, name },
    );
    invariant(!seen.has(name), 'invalid_input', `workflow '${workflow_id}' requires tool '${name}' twice`, { workflow_id, name });
    seen.add(name);
    invariant(
      typeof version === 'string' && REQUIREMENT_PATTERN.test(version),
      'invalid_input', `workflow '${workflow_id}' tool '${name}' version requirement '${version}' must be 'x.y.z' or '^x.y.z'`,
      { workflow_id, name, version },
    );
    // The manifest's own ceiling on what this tool may do inside this workflow.
    // It never GRANTS: the policy engine intersects it with the tenant's grant
    // and with the descriptor's own classification, and the lowest wins.
    const max_side_effect = requirement.max_side_effect ?? 'read';
    invariant(
      SIDE_EFFECTS.includes(max_side_effect),
      'invalid_input', `workflow '${workflow_id}' tool '${name}' max_side_effect '${max_side_effect}' is unknown`,
      { workflow_id, name, max_side_effect, known: SIDE_EFFECTS },
    );
    return { name, version, max_side_effect };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function buildContextRequirements(list, workflow_id) {
  invariant(Array.isArray(list), 'invalid_input', `workflow '${workflow_id}' required_context must be an array`, { workflow_id });
  return list.map((requirement) => {
    assertClosedKeys(requirement, CONTEXT_REQUIREMENT_KEYS, `workflow '${workflow_id}' required_context entry`);
    const { kind } = requirement;
    invariant(
      CONTEXT_ITEM_KINDS.includes(kind),
      'invalid_input', `workflow '${workflow_id}' required_context kind '${kind}' is unknown`,
      { workflow_id, kind, known: CONTEXT_ITEM_KINDS },
    );
    const source = requirement.source ?? null;
    invariant(
      source === null || (typeof source === 'string' && ID_PATTERN.test(source)),
      'invalid_input', `workflow '${workflow_id}' required_context source '${source}' must be snake_case or null`, { workflow_id, source },
    );
    const min_items = requirement.min_items ?? 1;
    assertPositiveInt(min_items, `workflow '${workflow_id}' required_context min_items`, { min: 0 });
    const max_sensitivity = requirement.max_sensitivity ?? 'restricted';
    invariant(
      CONTEXT_SENSITIVITIES.includes(max_sensitivity),
      'invalid_input', `workflow '${workflow_id}' required_context max_sensitivity '${max_sensitivity}' is unknown`,
      { workflow_id, max_sensitivity, known: CONTEXT_SENSITIVITIES },
    );
    return { kind, source, min_items, max_sensitivity };
  }).sort((a, b) => (`${a.kind}:${a.source}` < `${b.kind}:${b.source}` ? -1 : 1));
}

function buildApprovalPolicy(policy, workflow_id, risk) {
  const source = policy ?? {};
  assertClosedKeys(source, APPROVAL_POLICY_KEYS, `workflow '${workflow_id}' approval_policy`);
  const threshold = source.requires_approval_at_or_above ?? null;
  invariant(
    threshold === null || SIDE_EFFECTS.includes(threshold),
    'invalid_input', `workflow '${workflow_id}' approval threshold '${threshold}' is not a side-effect class`,
    { workflow_id, threshold, known: SIDE_EFFECTS },
  );
  const approver_roles = source.approver_roles ?? [];
  invariant(Array.isArray(approver_roles), 'invalid_input', `workflow '${workflow_id}' approver_roles must be an array`, { workflow_id });
  approver_roles.forEach((role) => invariant(
    typeof role === 'string' && ID_PATTERN.test(role),
    'invalid_input', `workflow '${workflow_id}' approver role '${role}' must be snake_case`, { workflow_id, role },
  ));
  const quorum = source.quorum ?? 1;
  assertPositiveInt(quorum, `workflow '${workflow_id}' approval quorum`);
  // A quorum counts distinct PEOPLE, not roles — "two owners must both sign
  // off" is the ordinary case, and an earlier rule requiring one named role per
  // unit of quorum made exactly that configuration unexpressible while
  // permitting `quorum: 1` with no role at all. What the rule must actually
  // prevent is an unattributable multi-party gate: if more than one person has
  // to agree, the manifest has to say who is eligible to be one of them.
  invariant(
    quorum === 1 || approver_roles.length > 0,
    'invalid_input', `workflow '${workflow_id}' requires a quorum of ${quorum} but names no approver role, so no principal is eligible to satisfy it`,
    { workflow_id, quorum, roles: approver_roles.length },
  );

  // A manifest may not declare itself dangerous and ungated. This is the single
  // rule that stops "risk: critical" being decoration.
  const dangerous = risk === 'high' || risk === 'critical';
  invariant(
    !dangerous || threshold !== null,
    'invalid_input', `workflow '${workflow_id}' is ${risk} risk and must declare requires_approval_at_or_above`,
    { workflow_id, risk },
  );
  invariant(
    !dangerous || approver_roles.length > 0,
    'invalid_input', `workflow '${workflow_id}' is ${risk} risk and must name at least one approver role`,
    { workflow_id, risk },
  );

  return { requires_approval_at_or_above: threshold, approver_roles: [...approver_roles].sort(), quorum };
}

function buildLimits(limits, workflow_id) {
  const source = limits ?? {};
  assertClosedKeys(source, LIMIT_KEYS, `workflow '${workflow_id}' limits`);
  const step_timeout_ms = source.step_timeout_ms ?? 30_000;
  const run_timeout_ms = source.run_timeout_ms ?? 300_000;
  const max_attempts = source.max_attempts ?? 1;
  const retry_backoff_ms = source.retry_backoff_ms ?? 0;
  assertPositiveInt(step_timeout_ms, `workflow '${workflow_id}' limits.step_timeout_ms`);
  assertPositiveInt(run_timeout_ms, `workflow '${workflow_id}' limits.run_timeout_ms`);
  assertPositiveInt(max_attempts, `workflow '${workflow_id}' limits.max_attempts`);
  assertPositiveInt(retry_backoff_ms, `workflow '${workflow_id}' limits.retry_backoff_ms`, { min: 0 });
  // A step budget larger than the run budget is a limit that can never bind.
  invariant(
    step_timeout_ms <= run_timeout_ms,
    'invalid_input', `workflow '${workflow_id}' step_timeout_ms ${step_timeout_ms} exceeds run_timeout_ms ${run_timeout_ms}`,
    { workflow_id, step_timeout_ms, run_timeout_ms },
  );
  return { step_timeout_ms, run_timeout_ms, max_attempts, retry_backoff_ms };
}

function buildDependencies(list, workflow_id) {
  invariant(Array.isArray(list), 'invalid_input', `workflow '${workflow_id}' dependencies must be an array`, { workflow_id });
  const seen = new Set();
  return list.map((dependency) => {
    assertClosedKeys(dependency, DEPENDENCY_KEYS, `workflow '${workflow_id}' dependency`);
    const { workflow_id: id, version } = dependency;
    invariant(
      typeof id === 'string' && ID_PATTERN.test(id),
      'invalid_input', `workflow '${workflow_id}' dependency id '${id}' must be snake_case`, { workflow_id, id },
    );
    invariant(
      id !== workflow_id,
      'invalid_input', `workflow '${workflow_id}' cannot depend on itself`, { workflow_id },
    );
    invariant(!seen.has(id), 'invalid_input', `workflow '${workflow_id}' declares dependency '${id}' twice`, { workflow_id, id });
    seen.add(id);
    invariant(
      typeof version === 'string' && REQUIREMENT_PATTERN.test(version),
      'invalid_input', `workflow '${workflow_id}' dependency '${id}' version '${version}' must be 'x.y.z' or '^x.y.z'`,
      { workflow_id, id, version },
    );
    return { workflow_id: id, version };
  }).sort((a, b) => (a.workflow_id < b.workflow_id ? -1 : 1));
}

function buildPromotion(promotion, workflow_id) {
  const source = promotion ?? {};
  assertClosedKeys(source, PROMOTION_KEYS, `workflow '${workflow_id}' promotion`);
  // Draft is the fail-closed default: a manifest that forgets to say is not
  // promotable, and the registry refuses to execute it.
  const status = source.status ?? 'draft';
  invariant(
    PROMOTION_STATES.includes(status),
    'invalid_input', `workflow '${workflow_id}' promotion.status '${status}' is unknown`,
    { workflow_id, status, known: PROMOTION_STATES },
  );
  const promoted_at = source.promoted_at ?? null;
  const promoted_by = source.promoted_by ?? null;
  invariant(
    promoted_at === null || isInstant(promoted_at),
    'invalid_input', `workflow '${workflow_id}' promoted_at must be an ISO-8601 instant or null`, { workflow_id, promoted_at },
  );
  invariant(
    promoted_by === null || (typeof promoted_by === 'string' && promoted_by.length > 0),
    'invalid_input', `workflow '${workflow_id}' promoted_by must be a non-empty string or null`, { workflow_id },
  );
  // Promotion is an accountable act. A promoted manifest that cannot say when
  // or by whom is a promotion nobody can audit.
  invariant(
    status !== 'promoted' || (promoted_at !== null && promoted_by !== null),
    'invalid_input', `workflow '${workflow_id}' is promoted but does not record promoted_at and promoted_by`,
    { workflow_id, promoted_at, promoted_by },
  );
  return { status, promoted_at, promoted_by };
}

function buildSteps(list, workflow_id, toolRequirements) {
  invariant(Array.isArray(list), 'invalid_input', `workflow '${workflow_id}' steps must be an array`, { workflow_id });
  invariant(list.length > 0, 'invalid_input', `workflow '${workflow_id}' must declare at least one step`, { workflow_id });
  const requiredNames = new Set(toolRequirements.map((t) => t.name));
  const seen = new Set();

  return list.map((step, index) => {
    assertClosedKeys(step, STEP_KEYS, `workflow '${workflow_id}' step ${index}`);
    const { id, tool } = step;
    invariant(
      typeof id === 'string' && ID_PATTERN.test(id),
      'invalid_input', `workflow '${workflow_id}' step ${index} id '${id}' must be snake_case`, { workflow_id, id },
    );
    invariant(!seen.has(id), 'invalid_input', `workflow '${workflow_id}' declares step '${id}' twice`, { workflow_id, id });
    invariant(
      typeof tool === 'string' && ID_PATTERN.test(tool),
      'invalid_input', `workflow '${workflow_id}' step '${id}' tool '${tool}' must be snake_case`, { workflow_id, id, tool },
    );
    // The whole point of required_tools: a step cannot reach a tool the manifest
    // did not declare, so the declared list IS the workflow's tool surface.
    invariant(
      requiredNames.has(tool),
      'invalid_input', `workflow '${workflow_id}' step '${id}' uses tool '${tool}', which is not in required_tools`,
      { workflow_id, id, tool, required: [...requiredNames].sort() },
    );

    const input = step.input ?? {};
    invariant(
      input !== null && typeof input === 'object' && !Array.isArray(input),
      'invalid_input', `workflow '${workflow_id}' step '${id}' input must be a plain object`, { workflow_id, id },
    );

    const compensates = step.compensates ?? null;
    if (compensates !== null) {
      invariant(
        typeof compensates === 'string' && seen.has(compensates),
        'invalid_input',
        `workflow '${workflow_id}' step '${id}' compensates '${compensates}', which is not an EARLIER step — a compensation cannot undo something that has not run`,
        { workflow_id, id, compensates, earlier: [...seen] },
      );
    }

    const on_failure = step.on_failure ?? 'fail';
    invariant(
      STEP_FAILURE_POLICIES.includes(on_failure),
      'invalid_input', `workflow '${workflow_id}' step '${id}' on_failure '${on_failure}' is unknown`,
      { workflow_id, id, on_failure, known: STEP_FAILURE_POLICIES },
    );

    // Optional explicit idempotency key. When absent the dispatcher derives one
    // from (run, step, tool, version, input) — see dispatch.mjs. Declaring one
    // is how two steps deliberately share an effect identity.
    const idempotency_key = step.idempotency_key ?? null;
    invariant(
      idempotency_key === null || (typeof idempotency_key === 'string' && idempotency_key.length > 0),
      'invalid_input', `workflow '${workflow_id}' step '${id}' idempotency_key must be a non-empty string or null`, { workflow_id, id },
    );

    // The conditional edge. `when` absent means unconditional, which is what
    // every manifest written before this existed means — so a sequential
    // manifest keeps behaving exactly as it did.
    //
    // `earlierSteps` is what makes this a graph check rather than a syntax
    // check: a condition reading the output of a step that runs LATER can never
    // be satisfied, so the step would be silently skipped on every run. That is
    // refused here, at build time.
    let when = null;
    if (step.when !== undefined && step.when !== null) {
      invariant(
        compensates === null,
        'invalid_input',
        `workflow '${workflow_id}' step '${id}' is a compensation and may not declare 'when' — a rollback that is conditional on the state it is rolling back is how a run ends up half-undone`,
        { workflow_id, id, compensates },
      );
      when = definePredicate(step.when, {
        label: `workflow '${workflow_id}' step '${id}' when`,
        earlierSteps: [...seen],
      });
    }

    seen.add(id);
    return {
      id,
      tool,
      description: typeof step.description === 'string' ? step.description : null,
      input,
      compensates,
      on_failure,
      idempotency_key,
      when,
    };
  });
}

// --- the manifest ------------------------------------------------------------

export function defineWorkflowManifest(spec = {}) {
  const allowed = MANIFEST_KEYS.filter((k) => k !== 'schema' && k !== 'manifest_digest');
  assertClosedKeys(spec, [...allowed, 'schema'], 'workflow manifest');

  const { workflow_id, version } = spec;
  invariant(
    typeof workflow_id === 'string' && ID_PATTERN.test(workflow_id),
    'invalid_input', `workflow_id '${workflow_id}' must be snake_case`, { workflow_id },
  );
  invariant(
    typeof version === 'string' && SEMVER_PATTERN.test(version),
    'invalid_input', `workflow '${workflow_id}' version '${version}' must be a pinned semver major.minor.patch`,
    { workflow_id, version },
  );
  invariant(
    spec.schema === undefined || spec.schema === WORKFLOW_MANIFEST_SCHEMA,
    'invalid_input', `workflow '${workflow_id}' declares schema '${spec.schema}', not '${WORKFLOW_MANIFEST_SCHEMA}'`,
    { workflow_id, schema: spec.schema },
  );
  invariant(
    typeof spec.description === 'string' && spec.description.length > 0,
    'invalid_input', `workflow '${workflow_id}' needs a description`, { workflow_id },
  );

  const risk = spec.risk ?? null;
  invariant(
    RISK_CLASSES.includes(risk),
    'invalid_input', `workflow '${workflow_id}' must declare a risk class (${RISK_CLASSES.join('|')}), got '${risk}'`,
    { workflow_id, risk, known: RISK_CLASSES },
  );

  const metadata = spec.metadata ?? {};
  invariant(
    metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata),
    'invalid_input', `workflow '${workflow_id}' metadata must be a plain object`, { workflow_id },
  );

  const required_tools = buildToolRequirements(spec.required_tools ?? [], workflow_id);
  const body = {
    schema: WORKFLOW_MANIFEST_SCHEMA,
    workflow_id,
    version,
    title: typeof spec.title === 'string' && spec.title.length > 0 ? spec.title : workflow_id,
    description: spec.description,
    tenant_scope: buildTenantScope(spec.tenant_scope, workflow_id),
    required_tools,
    required_context: buildContextRequirements(spec.required_context ?? [], workflow_id),
    approval_policy: buildApprovalPolicy(spec.approval_policy, workflow_id, risk),
    limits: buildLimits(spec.limits, workflow_id),
    dependencies: buildDependencies(spec.dependencies ?? [], workflow_id),
    risk,
    promotion: buildPromotion(spec.promotion, workflow_id),
    steps: buildSteps(spec.steps ?? [], workflow_id, required_tools),
    metadata: { ...metadata },
  };

  // Stable across key order: this is the value a promotion record, a drift
  // check and a run journal all pin against.
  return deepFreeze({ ...body, manifest_digest: digest(body) });
}

export function assertWorkflowManifest(manifest, where = {}) {
  invariant(
    manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest),
    'contract_violation', 'workflow manifest must be an object', { ...where },
  );
  for (const key of MANIFEST_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(manifest, key),
      'contract_violation', `workflow manifest is missing '${key}'`, { ...where, key, workflow_id: manifest.workflow_id },
    );
  }
  invariant(
    manifest.schema === WORKFLOW_MANIFEST_SCHEMA,
    'contract_violation', `workflow manifest schema '${manifest.schema}' is not '${WORKFLOW_MANIFEST_SCHEMA}'`, { ...where },
  );
  const { manifest_digest, ...rest } = manifest;
  invariant(
    digest(rest) === manifest_digest,
    'contract_violation', `workflow '${manifest.workflow_id}' manifest_digest does not match its content`,
    { ...where, expected: digest(rest), actual: manifest_digest },
  );
  return manifest;
}

// --- derived questions the rest of the control plane asks --------------------

export function toolRequirement(manifest, toolName) {
  return manifest.required_tools.find((t) => t.name === toolName) ?? null;
}

export function stepById(manifest, stepId) {
  return manifest.steps.find((s) => s.id === stepId) ?? null;
}

export function tenantInScope(manifest, org_id) {
  if (manifest.tenant_scope.mode === 'any_tenant') return true;
  return typeof org_id === 'string' && manifest.tenant_scope.org_ids.includes(org_id);
}

// Does this side effect cross the manifest's approval threshold?
export function requiresApproval(manifest, side_effect) {
  const threshold = manifest.approval_policy.requires_approval_at_or_above;
  if (threshold === null) return false;
  return SIDE_EFFECT_RANK[side_effect] >= SIDE_EFFECT_RANK[threshold];
}

/**
 * validateContextRequirements(manifest, bundle) -> { ok, unmet: [...] }
 *
 * Structural, not semantic: it checks that the assembled bundle actually
 * contains the KINDS of fact the workflow said it needs, in the quantity it
 * needs, at or below the sensitivity it is willing to handle. A run whose
 * context is missing the org's policy items is stopped here rather than
 * producing a confidently wrong result three steps later.
 *
 * Returns data rather than throwing so the engine can turn it into a `blocked`
 * outcome with a registered reason.
 */
export function validateContextRequirements(manifest, bundle) {
  const unmet = [];
  const items = bundle?.items ?? [];

  for (const requirement of manifest.required_context) {
    const matching = items.filter((item) => item.kind === requirement.kind
      && (requirement.source === null || item.source === requirement.source));

    if (matching.length < requirement.min_items) {
      unmet.push({
        kind: requirement.kind,
        source: requirement.source,
        reason: 'insufficient_items',
        detail: `needs ${requirement.min_items} item(s) of kind '${requirement.kind}'${requirement.source ? ` from '${requirement.source}'` : ''}, bundle has ${matching.length}`,
      });
      continue;
    }
    const overClassified = matching.filter(
      (item) => sensitivityRank(item.sensitivity) > sensitivityRank(requirement.max_sensitivity),
    );
    if (overClassified.length > 0) {
      unmet.push({
        kind: requirement.kind,
        source: requirement.source,
        reason: 'sensitivity_exceeded',
        detail: `${overClassified.length} item(s) exceed max_sensitivity '${requirement.max_sensitivity}'`,
      });
    }
  }

  // A bundle belonging to another tenant is never "context we happen to be
  // missing" — it is a tenant leak, and it is reported as its own failure.
  const foreign = items.filter((item) => item.org_id !== null && item.org_id !== bundle.org_id);
  if (foreign.length > 0) {
    unmet.push({
      kind: null,
      source: null,
      reason: 'tenant_mismatch',
      detail: `${foreign.length} context item(s) belong to another tenant`,
    });
  }

  return { ok: unmet.length === 0, unmet };
}
