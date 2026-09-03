// ---------------------------------------------------------------------------
// capability.mjs — the Capability, and the Capability Registry.
//
// THE DISTINCTION THIS FILE EXISTS FOR: a tool is a mechanism; a capability is
// a business permission. `record_invoice_draft` is a mechanism. "this agent may
// prepare an accounts-payable draft, at or below internal sensitivity, with an
// idempotency key, and it is a medium-risk act" is a permission. Collapsing the
// two is how a system ends up with an agent that "has the draft tool" and
// therefore, by accident, may draft anything for anyone.
//
// A capability sits BETWEEN an agent and a tool and narrows in both directions:
//
//   agent definition ──declares──▶ capability ──binds──▶ tool + operation
//                                      │
//                                      ├─ which operations exist at all
//                                      ├─ which tools may serve them, at which versions
//                                      ├─ the side-effect ceiling
//                                      ├─ the data-classification ceiling
//                                      ├─ risk, and whether approval is obliged
//                                      ├─ whether an idempotency key is obliged
//                                      ├─ whether cited evidence is obliged
//                                      └─ which tenants and actor roles may hold it
//
// Holding a capability is still not authorization to act. It is one of five
// independent conditions, all of which must hold (authorization.mjs):
//
//   1. the agent definition declares the capability (and does not deny it)
//   2. the capability binds the tool AND the operation, at a compatible version
//   3. the tenant grant exists and the control plane's policy engine allows it
//   4. approval is in force when required, bound to these exact arguments
//   5. the tenant and the actor are permitted to hold it
//
// DENY BY DEFAULT, everywhere. An unstated ceiling is the NARROWEST value, not
// the widest: a capability that forgets to say what it may do to the world may
// only read.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import {
  CONTEXT_SENSITIVITIES, SIDE_EFFECTS, SIDE_EFFECT_RANK, deepFreeze, digest, invariant,
  satisfiesVersion, sensitivityRank, compareVersionsDesc,
} from './kernel.mjs';

export const CAPABILITY_SCHEMA = 'awe.capability/v1';

export const CAPABILITY_KEYS = [
  'schema', 'key', 'version', 'title', 'purpose', 'operations', 'tool_bindings',
  'input_constraints', 'output_constraints', 'risk', 'requires_approval_at_or_above',
  'tenant_scope', 'actor_roles', 'max_data_classification', 'side_effect_ceiling',
  'idempotency', 'audit', 'policy_refs', 'metadata', 'capability_digest',
];

const BINDING_KEYS = ['tool', 'version', 'operations', 'max_side_effect'];
const TENANT_SCOPE_KEYS = ['mode', 'org_ids'];

// The same four-value ladder the manifest and the tool descriptor use. There is
// no second risk vocabulary in the platform.
export const CAPABILITY_RISKS = ['low', 'medium', 'high', 'critical'];

// Whether a proposal must carry an explicit idempotency key, or whether the
// dispatcher may derive one from (run, step, tool, version, input).
//
// `required` is for capabilities whose effect the CALLER must be able to name
// independently of the arguments — a payment, a message, anything where "the
// same effect, proposed twice with a formatting difference" must still collapse
// to one effect.
export const IDEMPOTENCY_MODES = ['derived', 'required'];

// `evidence_required` obliges a proposal to cite at least one context item or
// prior observation. It is the machine-checkable form of "do not act on a
// belief you cannot point at".
export const AUDIT_MODES = ['standard', 'evidence_required'];

export const CAPABILITY_RESOLUTION_REASONS = [
  'capability_not_registered',
  'capability_version_unknown',
  'capability_version_incompatible',
  'capability_tenant_out_of_scope',
  'capability_actor_not_permitted',
];

// `invoice.classify`, `memory.read_operational`, `workflow.start`. Dotted so a
// capability key reads as domain + act, and never collides with a tool name
// (which is flat snake_case) — you cannot mistake one for the other in a log.
const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const REQUIREMENT_PATTERN = /^\^?\d+\.\d+\.\d+$/;

function assertClosedKeys(value, allowed, label) {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input', `${label} must be a plain object`, { label },
  );
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  invariant(
    unknown.length === 0,
    'invalid_input',
    `${label} has unknown key(s) ${JSON.stringify(unknown.sort())} — an unrecognized key is refused, not ignored`,
    { label, unknown: unknown.sort(), allowed },
  );
}

function buildTenantScope(scope, key) {
  const source = scope ?? { mode: 'any_tenant', org_ids: [] };
  assertClosedKeys(source, TENANT_SCOPE_KEYS, `capability '${key}' tenant_scope`);
  const mode = source.mode ?? 'any_tenant';
  invariant(
    mode === 'allow_list' || mode === 'any_tenant',
    'invalid_input', `capability '${key}' tenant_scope.mode '${mode}' must be allow_list|any_tenant`, { key, mode },
  );
  const org_ids = source.org_ids ?? [];
  invariant(Array.isArray(org_ids), 'invalid_input', `capability '${key}' tenant_scope.org_ids must be an array`, { key });
  // Same rule as the workflow manifest: an allow-list with nothing on it is a
  // refused capability, never a capability everything may hold.
  invariant(
    mode !== 'allow_list' || org_ids.length > 0,
    'invalid_input', `capability '${key}' tenant_scope is an allow_list with no tenants on it`, { key },
  );
  invariant(
    mode !== 'any_tenant' || org_ids.length === 0,
    'invalid_input', `capability '${key}' tenant_scope is any_tenant but also lists tenants — say one or the other`, { key },
  );
  return { mode, org_ids: [...org_ids].sort() };
}

function buildBindings(list, key, { operations, side_effect_ceiling }) {
  invariant(Array.isArray(list), 'invalid_input', `capability '${key}' tool_bindings must be an array`, { key });
  // A capability that binds no tool authorizes nothing and would be a permission
  // nobody can exercise — which is a drafting mistake, not a safe default.
  invariant(list.length > 0, 'invalid_input', `capability '${key}' must bind at least one tool`, { key });

  const seen = new Set();
  return list.map((binding) => {
    assertClosedKeys(binding, BINDING_KEYS, `capability '${key}' tool_binding`);
    const { tool, version } = binding;
    invariant(
      typeof tool === 'string' && ID_PATTERN.test(tool),
      'invalid_input', `capability '${key}' binds tool '${tool}', which must be snake_case`, { key, tool },
    );
    invariant(!seen.has(tool), 'invalid_input', `capability '${key}' binds tool '${tool}' twice`, { key, tool });
    seen.add(tool);
    // A binding with no version requirement is an unversioned dependency, and an
    // unversioned dependency is how a re-published tool silently changes what a
    // capability means.
    invariant(
      typeof version === 'string' && REQUIREMENT_PATTERN.test(version),
      'invalid_input', `capability '${key}' tool '${tool}' version '${version}' must be 'x.y.z' or '^x.y.z'`,
      { key, tool, version },
    );

    const bound = binding.operations ?? [];
    invariant(
      Array.isArray(bound) && bound.length > 0,
      'invalid_input', `capability '${key}' tool '${tool}' must name the operation(s) it serves`, { key, tool },
    );
    const stray = bound.filter((op) => !operations.includes(op));
    invariant(
      stray.length === 0,
      'invalid_input',
      `capability '${key}' tool '${tool}' serves operation(s) ${JSON.stringify(stray.sort())} the capability does not declare`,
      { key, tool, stray: stray.sort(), operations },
    );

    // Unstated is the narrowest. A binding that forgets to say may only read.
    const max_side_effect = binding.max_side_effect ?? 'read';
    invariant(
      SIDE_EFFECTS.includes(max_side_effect),
      'invalid_input', `capability '${key}' tool '${tool}' max_side_effect '${max_side_effect}' is unknown`,
      { key, tool, max_side_effect, known: SIDE_EFFECTS },
    );
    // A binding may narrow the capability's ceiling; it may never widen it.
    invariant(
      SIDE_EFFECT_RANK[max_side_effect] <= SIDE_EFFECT_RANK[side_effect_ceiling],
      'invalid_input',
      `capability '${key}' tool '${tool}' allows '${max_side_effect}', above the capability's own ceiling '${side_effect_ceiling}'`,
      { key, tool, max_side_effect, side_effect_ceiling },
    );

    return { tool, version, operations: [...bound].sort(), max_side_effect };
  }).sort((a, b) => (a.tool < b.tool ? -1 : 1));
}

/**
 * defineCapability(spec) -> frozen, digest-pinned Capability
 */
export function defineCapability(spec = {}) {
  const allowed = CAPABILITY_KEYS.filter((k) => k !== 'capability_digest');
  assertClosedKeys(spec, allowed, 'capability');

  const { key, version } = spec;
  invariant(
    typeof key === 'string' && KEY_PATTERN.test(key),
    'invalid_input', `capability key '${key}' must be dotted lower_snake (e.g. 'invoice.classify')`, { key },
  );
  invariant(
    typeof version === 'string' && SEMVER_PATTERN.test(version),
    'invalid_input', `capability '${key}' version '${version}' must be a pinned semver major.minor.patch`, { key, version },
  );
  invariant(
    spec.schema === undefined || spec.schema === CAPABILITY_SCHEMA,
    'invalid_input', `capability '${key}' declares schema '${spec.schema}', not '${CAPABILITY_SCHEMA}'`, { key },
  );
  invariant(
    typeof spec.purpose === 'string' && spec.purpose.length > 0,
    'invalid_input', `capability '${key}' needs a human-readable purpose`, { key },
  );

  const operations = spec.operations ?? [];
  invariant(
    Array.isArray(operations) && operations.length > 0,
    'invalid_input', `capability '${key}' must declare at least one permitted operation`, { key },
  );
  operations.forEach((op) => invariant(
    typeof op === 'string' && ID_PATTERN.test(op),
    'invalid_input', `capability '${key}' operation '${op}' must be snake_case`, { key, op },
  ));

  const risk = spec.risk ?? null;
  invariant(
    CAPABILITY_RISKS.includes(risk),
    'invalid_input', `capability '${key}' must declare a risk class (${CAPABILITY_RISKS.join('|')}), got '${risk}'`,
    { key, risk, known: CAPABILITY_RISKS },
  );

  const side_effect_ceiling = spec.side_effect_ceiling ?? 'read';
  invariant(
    SIDE_EFFECTS.includes(side_effect_ceiling),
    'invalid_input', `capability '${key}' side_effect_ceiling '${side_effect_ceiling}' is unknown`,
    { key, side_effect_ceiling, known: SIDE_EFFECTS },
  );

  const threshold = spec.requires_approval_at_or_above ?? null;
  invariant(
    threshold === null || SIDE_EFFECTS.includes(threshold),
    'invalid_input', `capability '${key}' approval threshold '${threshold}' is not a side-effect class`,
    { key, threshold, known: SIDE_EFFECTS },
  );

  const actor_roles = spec.actor_roles ?? [];
  invariant(Array.isArray(actor_roles), 'invalid_input', `capability '${key}' actor_roles must be an array`, { key });
  actor_roles.forEach((role) => invariant(
    typeof role === 'string' && ID_PATTERN.test(role),
    'invalid_input', `capability '${key}' actor role '${role}' must be snake_case`, { key, role },
  ));

  // A capability cannot declare itself dangerous and ungated, and cannot declare
  // itself dangerous and holdable by anyone. Same rule the manifest applies to a
  // high-risk workflow, applied one layer down where the permission lives.
  const dangerous = risk === 'high' || risk === 'critical';
  invariant(
    !dangerous || threshold !== null,
    'invalid_input', `capability '${key}' is ${risk} risk and must declare requires_approval_at_or_above`, { key, risk },
  );
  invariant(
    !dangerous || actor_roles.length > 0,
    'invalid_input', `capability '${key}' is ${risk} risk and must restrict which actor roles may hold it`, { key, risk },
  );

  const max_data_classification = spec.max_data_classification ?? 'internal';
  invariant(
    CONTEXT_SENSITIVITIES.includes(max_data_classification),
    'invalid_input', `capability '${key}' max_data_classification '${max_data_classification}' is unknown`,
    { key, max_data_classification, known: CONTEXT_SENSITIVITIES },
  );

  const idempotency = spec.idempotency ?? 'derived';
  invariant(
    IDEMPOTENCY_MODES.includes(idempotency),
    'invalid_input', `capability '${key}' idempotency '${idempotency}' must be one of ${IDEMPOTENCY_MODES.join('|')}`,
    { key, idempotency },
  );
  // A capability that reaches outside the platform must be able to say "this is
  // the same effect I already committed" without depending on argument
  // formatting. Deriving the key from the arguments cannot do that.
  invariant(
    side_effect_ceiling !== 'external' || idempotency === 'required',
    'invalid_input',
    `capability '${key}' may reach 'external' and must therefore declare idempotency: 'required'`,
    { key, side_effect_ceiling, idempotency },
  );

  const audit = spec.audit ?? 'standard';
  invariant(
    AUDIT_MODES.includes(audit),
    'invalid_input', `capability '${key}' audit '${audit}' must be one of ${AUDIT_MODES.join('|')}`, { key, audit },
  );

  const policy_refs = spec.policy_refs ?? [];
  invariant(Array.isArray(policy_refs), 'invalid_input', `capability '${key}' policy_refs must be an array`, { key });

  const constraints = (value, label) => {
    const source = value ?? null;
    invariant(
      source === null || typeof source === 'string',
      'invalid_input', `capability '${key}' ${label} must be a schema REFERENCE string or null`, { key },
    );
    return source;
  };

  const metadata = spec.metadata ?? {};
  invariant(
    metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata),
    'invalid_input', `capability '${key}' metadata must be a plain object`, { key },
  );

  const body = {
    schema: CAPABILITY_SCHEMA,
    key,
    version,
    title: typeof spec.title === 'string' && spec.title.length > 0 ? spec.title : key,
    purpose: spec.purpose,
    operations: [...operations].sort(),
    tool_bindings: buildBindings(spec.tool_bindings ?? [], key, {
      operations: [...operations].sort(),
      side_effect_ceiling,
    }),
    input_constraints: constraints(spec.input_constraints, 'input_constraints'),
    output_constraints: constraints(spec.output_constraints, 'output_constraints'),
    risk,
    requires_approval_at_or_above: threshold,
    tenant_scope: buildTenantScope(spec.tenant_scope, key),
    actor_roles: [...actor_roles].sort(),
    max_data_classification,
    side_effect_ceiling,
    idempotency,
    audit,
    policy_refs: [...policy_refs].sort(),
    metadata: { ...metadata },
  };

  return deepFreeze({ ...body, capability_digest: digest(body) });
}

export function assertCapability(capability, where = {}) {
  invariant(
    capability !== null && typeof capability === 'object' && !Array.isArray(capability),
    'contract_violation', 'a capability must be an object', { ...where },
  );
  for (const key of CAPABILITY_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(capability, key),
      'contract_violation', `capability is missing '${key}'`, { ...where, key, capability: capability.key },
    );
  }
  invariant(
    capability.schema === CAPABILITY_SCHEMA,
    'contract_violation', `capability schema '${capability.schema}' is not '${CAPABILITY_SCHEMA}'`, { ...where },
  );
  const { capability_digest, ...rest } = capability;
  invariant(
    digest(rest) === capability_digest,
    'contract_violation', `capability '${capability.key}' capability_digest does not match its content`,
    { ...where, expected: digest(rest), actual: capability_digest },
  );
  return capability;
}

// --- derived questions -------------------------------------------------------

export function bindingFor(capability, tool) {
  return capability.tool_bindings.find((b) => b.tool === tool) ?? null;
}

export function capabilityTenantInScope(capability, org_id) {
  if (capability.tenant_scope.mode === 'any_tenant') return true;
  return typeof org_id === 'string' && capability.tenant_scope.org_ids.includes(org_id);
}

export function capabilityPermitsActor(capability, roles = []) {
  if (capability.actor_roles.length === 0) return true;
  return (roles ?? []).some((role) => capability.actor_roles.includes(role));
}

export function capabilityRequiresApproval(capability, side_effect) {
  const threshold = capability.requires_approval_at_or_above;
  if (threshold === null) return false;
  return SIDE_EFFECT_RANK[side_effect] >= SIDE_EFFECT_RANK[threshold];
}

export function capabilityAdmitsSensitivity(capability, sensitivity) {
  return sensitivityRank(sensitivity) <= sensitivityRank(capability.max_data_classification);
}

// --- the registry ------------------------------------------------------------

function refuse(reason, detail, extra = {}) {
  return deepFreeze({ ok: false, reason, detail, capability: null, ...extra });
}

/**
 * createCapabilityRegistry(capabilities) -> frozen registry
 *
 * Same shape and the same promise as the Workflow Registry: a caller states a
 * key, a version requirement, a tenant and the actor's roles, and gets back a
 * RESOLUTION. There is no path that turns an arbitrary object into a resolvable
 * capability, because `resolve()` only ever returns capabilities this registry
 * already validated.
 */
export function createCapabilityRegistry(capabilities = []) {
  // key -> Map(version -> capability)
  const byKey = new Map();

  for (const candidate of capabilities) {
    const capability = candidate?.capability_digest === undefined
      ? defineCapability(candidate)
      : assertCapability(candidate, { at: 'createCapabilityRegistry' });

    const versions = byKey.get(capability.key) ?? new Map();
    invariant(
      !versions.has(capability.version),
      'invalid_input',
      `capability '${capability.key}' version '${capability.version}' is registered twice`,
      { key: capability.key, version: capability.version },
    );
    versions.set(capability.version, capability);
    byKey.set(capability.key, versions);
  }

  function versionsOf(key) {
    return [...(byKey.get(key)?.keys() ?? [])].sort(compareVersionsDesc);
  }

  function get(key, version) {
    return byKey.get(key)?.get(version) ?? null;
  }

  /**
   * resolve({ key, version, org_id, actor_roles })
   *   -> { ok, reason, detail, capability, resolved_version }
   *
   * The gates in order, because each is only meaningful if the ones before it
   * passed: the capability exists, a version satisfying the requirement exists,
   * the tenant may hold it, the actor may hold it.
   */
  function resolve({ key, version = null, org_id = null, actor_roles = [] } = {}) {
    invariant(typeof key === 'string' && key.length > 0, 'invalid_input', 'resolve() needs a capability key', { key });
    invariant(
      version === null || (typeof version === 'string' && REQUIREMENT_PATTERN.test(version)),
      'invalid_input', `capability version requirement '${version}' must be 'x.y.z', '^x.y.z' or null`, { version },
    );

    if (!byKey.has(key)) {
      return refuse('capability_not_registered', `no capability '${key}' is registered`, { key });
    }
    const available = versionsOf(key);
    if (version === null) {
      // Deliberately refused. A run that resolves "whatever version of
      // invoice.route is current" cannot be replayed, and an approval recorded
      // against it cannot be re-bound. Agents pin capability versions.
      return refuse(
        'capability_version_unknown',
        `capability '${key}' must be requested at an explicit version; available: ${JSON.stringify(available)}`,
        { key, available },
      );
    }
    const match = available.map((v) => get(key, v)).find((c) => satisfiesVersion(c.version, version));
    if (match === undefined) {
      return refuse(
        'capability_version_incompatible',
        `no version of capability '${key}' satisfies '${version}'; available: ${JSON.stringify(available)}`,
        { key, available },
      );
    }
    if (!capabilityTenantInScope(match, org_id)) {
      return refuse(
        'capability_tenant_out_of_scope',
        `tenant '${org_id}' is not in the scope of capability '${key}'`,
        { key },
      );
    }
    if (!capabilityPermitsActor(match, actor_roles)) {
      return refuse(
        'capability_actor_not_permitted',
        `capability '${key}' is restricted to ${JSON.stringify(match.actor_roles)}; the actor holds ${JSON.stringify([...(actor_roles ?? [])].sort())}`,
        { key },
      );
    }
    return deepFreeze({
      ok: true, reason: null, detail: null, capability: match, resolved_version: match.version,
    });
  }

  const all = () => [...byKey.values()]
    .flatMap((versions) => [...versions.values()])
    .sort((a, b) => (`${a.key}@${a.version}` < `${b.key}@${b.version}` ? -1 : 1));

  return Object.freeze({
    resolve,
    get,
    has(key) { return byKey.has(key); },
    keys() { return [...byKey.keys()].sort(); },
    versionsOf,
    describe() {
      return all().map(({ key, version, title, purpose, operations, risk, side_effect_ceiling, requires_approval_at_or_above, tool_bindings, capability_digest }) => ({
        key, version, title, purpose, operations, risk, side_effect_ceiling,
        requires_approval_at_or_above,
        tools: tool_bindings.map((b) => `${b.tool}@${b.version}`),
        capability_digest,
      }));
    },
    registry_digest() { return digest(all()); },
  });
}
