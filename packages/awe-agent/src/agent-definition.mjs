// ---------------------------------------------------------------------------
// agent-definition.mjs — the Agent Definition.
//
// A specialized agent in AWE is not a class, a prompt or a model configuration.
// It is a VERSIONED DOCUMENT that states, in advance and in public, the complete
// bounded action space of one kind of worker:
//
//   who it is           agent_id, version, title, purpose, business_responsibility
//   for whom            tenant_scope, status
//   what it may do      capabilities (pinned versions), denied_capabilities
//   through what        tools (pinned version requirements)
//   under which rules   policy_set, approval_profile
//   grounded in what    context_requirements, memory_profile
//   thinking with what  model_profile — a PREFERENCE, never a hard-coded vendor
//   for how long        budget (turns, tool calls, steps, wall clock)
//   producing what      output_contract
//   judged how          evaluation_profile
//   authorized by whom  provenance (created / approved / activated)
//
// THE RULES THAT MAKE IT A GOVERNANCE OBJECT RATHER THAN A CONFIG FILE:
//
//   * it is digest-pinned, so "the definition changed underneath a paused run"
//     is detectable rather than hypothetical;
//   * new behaviour requires a NEW VERSION. There is no mutate path in this
//     module or in the registry — `activate()` returns a new document and
//     refuses to touch the one it was given;
//   * `active` is an accountable state: it requires who approved it and when,
//     and who activated it and when. A definition cannot promote itself;
//   * a capability that is both declared and denied is REFUSED at build time
//     rather than resolved by precedence, because a permission set whose meaning
//     depends on which rule the reader remembers first is not a permission set;
//   * an agent declares its tools as well as its capabilities, and both must
//     admit a tool before it may be used. Two independent narrowings, so a
//     mistake in one is not a hole.
//
// NOTHING HERE GRANTS ANYTHING. A definition is a CEILING. The tenant grant
// (control plane) still has to exist, the policy engine still has to allow, and
// a human still has to approve where approval is obliged.
//
// PURE: no clock, no randomness, no I/O. Every instant is data supplied by
// whoever performed the act it records.
// ---------------------------------------------------------------------------

import {
  CONTEXT_ITEM_KINDS, CONTEXT_SENSITIVITIES, SIDE_EFFECTS, deepFreeze, digest, invariant,
  isInstant,
} from './kernel.mjs';

export const AGENT_DEFINITION_SCHEMA = 'awe.agent_definition/v1';

export const AGENT_DEFINITION_KEYS = [
  'schema', 'agent_id', 'version', 'title', 'purpose', 'business_responsibility',
  'tenant_scope', 'status', 'capabilities', 'denied_capabilities', 'tools',
  'policy_set', 'approval_profile', 'context_requirements', 'memory_profile',
  'model_profile', 'budget', 'output_contract', 'evaluation_profile', 'provenance',
  'metadata', 'definition_digest',
];

/**
 * The lifecycle, and what each state MEANS at runtime (enforced by
 * agent-registry.mjs, stated here because the vocabulary belongs with the
 * document it describes):
 *
 *   draft       never executable. Not "executable in test" — never.
 *   active      executable.
 *   deprecated  executable ONLY when the caller pinned this exact version and
 *               explicitly opted in. A caller asking for "whatever is current"
 *               never receives a deprecated agent.
 *   disabled    never executable, and not resolvable by any opt-in. This is the
 *               kill switch, and it must not be overridable by an argument.
 */
export const AGENT_STATUSES = ['draft', 'active', 'deprecated', 'disabled'];

// What an agent may do with memory. There is no `write` value, deliberately:
// an agent proposes a memory write and a reviewed promotion applies it, exactly
// as it proposes an action and the runtime executes it.
export const MEMORY_WRITE_MODES = ['none', 'propose_only'];

// How an approval binds to what was approved. One value today, spelled as a
// closed vocabulary so a second binding mode (an approved SCOPE, say
// "any refund under 500 for this customer this week") is an additive change with
// its own rules rather than a quiet reinterpretation of the existing one.
export const APPROVAL_BINDING_MODES = ['exact_arguments'];

// How the agent plans. `deterministic` is a first-class production value, not a
// test affordance: a rules-based planner that never calls a model is the
// cheapest correct implementation for many business tasks, and it is what makes
// the whole plane testable without a provider.
export const PLANNER_KINDS = ['deterministic', 'model'];

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const CAPABILITY_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const REQUIREMENT_PATTERN = /^\^?\d+\.\d+\.\d+$/;

const TENANT_SCOPE_KEYS = ['mode', 'org_ids'];
const APPROVAL_PROFILE_KEYS = ['requires_approval_at_or_above', 'approver_roles', 'quorum', 'binding', 'ttl_ms'];
const CONTEXT_REQUIREMENT_KEYS = ['kind', 'source', 'min_items', 'max_sensitivity'];
const MEMORY_PROFILE_KEYS = ['read_scopes', 'write'];
const MODEL_PROFILE_KEYS = ['planner', 'providers', 'allow_fallback', 'max_output_tokens'];
const PROVIDER_KEYS = ['provider', 'model'];
const BUDGET_KEYS = ['max_turns', 'max_tool_calls', 'max_steps', 'run_timeout_ms', 'step_timeout_ms', 'max_context_tokens'];
const OUTPUT_CONTRACT_KEYS = ['schema', 'required_keys'];
const EVALUATION_PROFILE_KEYS = ['evaluator', 'version', 'rubric', 'required'];
const PROVENANCE_KEYS = [
  'created_at', 'created_by', 'approved_at', 'approved_by', 'activated_at', 'activated_by',
  'source_ref', 'supersedes',
];
const CAPABILITY_REF_KEYS = ['key', 'version'];
const TOOL_REF_KEYS = ['name', 'version'];
const POLICY_REF_KEYS = ['policy_id', 'version'];

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

function assertPositiveInt(value, label, { min = 1 } = {}) {
  invariant(
    Number.isInteger(value) && value >= min,
    'invalid_input', `${label} must be an integer >= ${min}, got ${JSON.stringify(value)}`, { label, value },
  );
}

function buildTenantScope(scope, agent_id) {
  invariant(
    scope !== undefined && scope !== null,
    'invalid_input', `agent '${agent_id}' must declare a tenant_scope`, { agent_id },
  );
  assertClosedKeys(scope, TENANT_SCOPE_KEYS, `agent '${agent_id}' tenant_scope`);
  const mode = scope.mode;
  invariant(
    mode === 'allow_list' || mode === 'any_tenant',
    'invalid_input', `agent '${agent_id}' tenant_scope.mode '${mode}' must be allow_list|any_tenant`, { agent_id, mode },
  );
  const org_ids = scope.org_ids ?? [];
  invariant(Array.isArray(org_ids), 'invalid_input', `agent '${agent_id}' tenant_scope.org_ids must be an array`, { agent_id });
  invariant(
    mode !== 'allow_list' || org_ids.length > 0,
    'invalid_input', `agent '${agent_id}' tenant_scope is an allow_list with no tenants on it`, { agent_id },
  );
  invariant(
    mode !== 'any_tenant' || org_ids.length === 0,
    'invalid_input', `agent '${agent_id}' tenant_scope is any_tenant but also lists tenants — say one or the other`, { agent_id },
  );
  return { mode, org_ids: [...org_ids].sort() };
}

function buildCapabilityRefs(list, agent_id, { label, versionRequired }) {
  invariant(Array.isArray(list), 'invalid_input', `agent '${agent_id}' ${label} must be an array`, { agent_id });
  const seen = new Set();
  return list.map((ref) => {
    assertClosedKeys(ref, CAPABILITY_REF_KEYS, `agent '${agent_id}' ${label} entry`);
    const { key } = ref;
    invariant(
      typeof key === 'string' && CAPABILITY_KEY_PATTERN.test(key),
      'invalid_input', `agent '${agent_id}' ${label} key '${key}' must be dotted lower_snake`, { agent_id, key },
    );
    invariant(!seen.has(key), 'invalid_input', `agent '${agent_id}' ${label} names '${key}' twice`, { agent_id, key });
    seen.add(key);
    const version = ref.version ?? null;
    if (versionRequired) {
      // An allowed capability MUST be pinned. A denial may be version-wide,
      // because "never, at any version" is a coherent and stricter statement.
      invariant(
        typeof version === 'string' && REQUIREMENT_PATTERN.test(version),
        'invalid_input',
        `agent '${agent_id}' capability '${key}' must state a version requirement ('x.y.z' or '^x.y.z') — an unversioned capability cannot be replayed or re-bound to an approval`,
        { agent_id, key, version },
      );
    } else {
      invariant(
        version === null || REQUIREMENT_PATTERN.test(version),
        'invalid_input', `agent '${agent_id}' ${label} '${key}' version '${version}' must be 'x.y.z', '^x.y.z' or null`,
        { agent_id, key, version },
      );
    }
    return { key, version };
  }).sort((a, b) => (a.key < b.key ? -1 : 1));
}

function buildToolRefs(list, agent_id) {
  invariant(Array.isArray(list), 'invalid_input', `agent '${agent_id}' tools must be an array`, { agent_id });
  invariant(
    list.length > 0,
    'invalid_input', `agent '${agent_id}' must declare at least one tool — an agent with no tool surface cannot act`, { agent_id },
  );
  const seen = new Set();
  return list.map((ref) => {
    assertClosedKeys(ref, TOOL_REF_KEYS, `agent '${agent_id}' tools entry`);
    const { name, version } = ref;
    invariant(
      typeof name === 'string' && ID_PATTERN.test(name),
      'invalid_input', `agent '${agent_id}' tool name '${name}' must be snake_case`, { agent_id, name },
    );
    invariant(!seen.has(name), 'invalid_input', `agent '${agent_id}' declares tool '${name}' twice`, { agent_id, name });
    seen.add(name);
    invariant(
      typeof version === 'string' && REQUIREMENT_PATTERN.test(version),
      'invalid_input', `agent '${agent_id}' tool '${name}' version '${version}' must be 'x.y.z' or '^x.y.z'`,
      { agent_id, name, version },
    );
    return { name, version };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function buildPolicySet(list, agent_id) {
  invariant(Array.isArray(list), 'invalid_input', `agent '${agent_id}' policy_set must be an array`, { agent_id });
  const seen = new Set();
  return list.map((ref) => {
    assertClosedKeys(ref, POLICY_REF_KEYS, `agent '${agent_id}' policy_set entry`);
    const { policy_id, version } = ref;
    invariant(
      typeof policy_id === 'string' && ID_PATTERN.test(policy_id),
      'invalid_input', `agent '${agent_id}' policy id '${policy_id}' must be snake_case`, { agent_id, policy_id },
    );
    invariant(!seen.has(policy_id), 'invalid_input', `agent '${agent_id}' declares policy '${policy_id}' twice`, { agent_id, policy_id });
    seen.add(policy_id);
    invariant(
      typeof version === 'string' && SEMVER_PATTERN.test(version),
      'invalid_input', `agent '${agent_id}' policy '${policy_id}' version '${version}' must be a pinned semver`,
      { agent_id, policy_id, version },
    );
    return { policy_id, version };
  }).sort((a, b) => (a.policy_id < b.policy_id ? -1 : 1));
}

function buildApprovalProfile(profile, agent_id) {
  const source = profile ?? {};
  assertClosedKeys(source, APPROVAL_PROFILE_KEYS, `agent '${agent_id}' approval_profile`);
  const threshold = source.requires_approval_at_or_above ?? null;
  invariant(
    threshold === null || SIDE_EFFECTS.includes(threshold),
    'invalid_input', `agent '${agent_id}' approval threshold '${threshold}' is not a side-effect class`,
    { agent_id, threshold, known: SIDE_EFFECTS },
  );
  const approver_roles = source.approver_roles ?? [];
  invariant(Array.isArray(approver_roles), 'invalid_input', `agent '${agent_id}' approver_roles must be an array`, { agent_id });
  approver_roles.forEach((role) => invariant(
    typeof role === 'string' && ID_PATTERN.test(role),
    'invalid_input', `agent '${agent_id}' approver role '${role}' must be snake_case`, { agent_id, role },
  ));
  const quorum = source.quorum ?? 1;
  assertPositiveInt(quorum, `agent '${agent_id}' approval quorum`);
  invariant(
    quorum === 1 || approver_roles.length > 0,
    'invalid_input',
    `agent '${agent_id}' requires a quorum of ${quorum} but names no approver role, so no principal is eligible to satisfy it`,
    { agent_id, quorum },
  );
  const binding = source.binding ?? 'exact_arguments';
  invariant(
    APPROVAL_BINDING_MODES.includes(binding),
    'invalid_input', `agent '${agent_id}' approval binding '${binding}' must be one of ${APPROVAL_BINDING_MODES.join('|')}`,
    { agent_id, binding },
  );
  // A decision has a shelf life. Not because approvers are unreliable, but
  // because the world the decision was made about moves: an approval to pay an
  // invoice, resumed three months later, is a decision nobody made.
  const ttl_ms = source.ttl_ms ?? null;
  invariant(
    ttl_ms === null || (Number.isInteger(ttl_ms) && ttl_ms > 0),
    'invalid_input', `agent '${agent_id}' approval ttl_ms must be a positive integer or null`, { agent_id, ttl_ms },
  );
  invariant(
    threshold === null || approver_roles.length > 0,
    'invalid_input',
    `agent '${agent_id}' gates actions at '${threshold}' but names no approver role — a gate nobody is eligible to open is a stuck run, not a control`,
    { agent_id, threshold },
  );
  return { requires_approval_at_or_above: threshold, approver_roles: [...approver_roles].sort(), quorum, binding, ttl_ms };
}

function buildContextRequirements(list, agent_id) {
  invariant(Array.isArray(list), 'invalid_input', `agent '${agent_id}' context_requirements must be an array`, { agent_id });
  return list.map((requirement) => {
    assertClosedKeys(requirement, CONTEXT_REQUIREMENT_KEYS, `agent '${agent_id}' context_requirements entry`);
    const { kind } = requirement;
    invariant(
      CONTEXT_ITEM_KINDS.includes(kind),
      'invalid_input', `agent '${agent_id}' context requirement kind '${kind}' is unknown`,
      { agent_id, kind, known: CONTEXT_ITEM_KINDS },
    );
    const source = requirement.source ?? null;
    invariant(
      source === null || (typeof source === 'string' && ID_PATTERN.test(source)),
      'invalid_input', `agent '${agent_id}' context requirement source '${source}' must be snake_case or null`, { agent_id, source },
    );
    const min_items = requirement.min_items ?? 1;
    assertPositiveInt(min_items, `agent '${agent_id}' context requirement min_items`, { min: 0 });
    const max_sensitivity = requirement.max_sensitivity ?? 'internal';
    invariant(
      CONTEXT_SENSITIVITIES.includes(max_sensitivity),
      'invalid_input', `agent '${agent_id}' context requirement max_sensitivity '${max_sensitivity}' is unknown`,
      { agent_id, max_sensitivity, known: CONTEXT_SENSITIVITIES },
    );
    return { kind, source, min_items, max_sensitivity };
  }).sort((a, b) => (`${a.kind}:${a.source}` < `${b.kind}:${b.source}` ? -1 : 1));
}

function buildMemoryProfile(profile, agent_id) {
  const source = profile ?? {};
  assertClosedKeys(source, MEMORY_PROFILE_KEYS, `agent '${agent_id}' memory_profile`);
  const read_scopes = source.read_scopes ?? [];
  invariant(Array.isArray(read_scopes), 'invalid_input', `agent '${agent_id}' memory read_scopes must be an array`, { agent_id });
  read_scopes.forEach((scope) => invariant(
    typeof scope === 'string' && ID_PATTERN.test(scope),
    'invalid_input', `agent '${agent_id}' memory read scope '${scope}' must be snake_case`, { agent_id, scope },
  ));
  const write = source.write ?? 'none';
  invariant(
    MEMORY_WRITE_MODES.includes(write),
    'invalid_input',
    `agent '${agent_id}' memory write mode '${write}' must be one of ${MEMORY_WRITE_MODES.join('|')} — an agent never writes memory directly`,
    { agent_id, write, known: MEMORY_WRITE_MODES },
  );
  return { read_scopes: [...read_scopes].sort(), write };
}

function buildModelProfile(profile, agent_id) {
  const source = profile ?? {};
  assertClosedKeys(source, MODEL_PROFILE_KEYS, `agent '${agent_id}' model_profile`);
  const planner = source.planner ?? 'deterministic';
  invariant(
    PLANNER_KINDS.includes(planner),
    'invalid_input', `agent '${agent_id}' planner '${planner}' must be one of ${PLANNER_KINDS.join('|')}`,
    { agent_id, planner, known: PLANNER_KINDS },
  );
  const providers = source.providers ?? [];
  invariant(Array.isArray(providers), 'invalid_input', `agent '${agent_id}' model providers must be an array`, { agent_id });
  const built = providers.map((entry) => {
    assertClosedKeys(entry, PROVIDER_KEYS, `agent '${agent_id}' model provider entry`);
    invariant(
      typeof entry.provider === 'string' && ID_PATTERN.test(entry.provider),
      'invalid_input', `agent '${agent_id}' model provider '${entry.provider}' must be snake_case`, { agent_id },
    );
    invariant(
      typeof entry.model === 'string' && entry.model.length > 0,
      'invalid_input', `agent '${agent_id}' model provider '${entry.provider}' must name a model`, { agent_id },
    );
    return { provider: entry.provider, model: entry.model };
  });
  // An ORDERED preference, deliberately not sorted: "prefer A, fall back to B"
  // is the statement, and sorting it would silently reorder the preference.
  const allow_fallback = source.allow_fallback ?? false;
  invariant(
    typeof allow_fallback === 'boolean',
    'invalid_input', `agent '${agent_id}' model allow_fallback must be a boolean`, { agent_id },
  );
  const max_output_tokens = source.max_output_tokens ?? null;
  invariant(
    max_output_tokens === null || (Number.isInteger(max_output_tokens) && max_output_tokens > 0),
    'invalid_input', `agent '${agent_id}' max_output_tokens must be a positive integer or null`, { agent_id },
  );
  // A model-planning agent that names no provider preference would be resolved
  // by whatever the composition happened to inject, which is the opposite of a
  // definition that states its own dependencies.
  invariant(
    planner !== 'model' || built.length > 0,
    'invalid_input', `agent '${agent_id}' plans with a model but states no provider preference`, { agent_id },
  );
  return { planner, providers: built, allow_fallback, max_output_tokens };
}

function buildBudget(budget, agent_id) {
  const source = budget ?? {};
  assertClosedKeys(source, BUDGET_KEYS, `agent '${agent_id}' budget`);
  // Every budget has a fail-closed default and none of them may be absent,
  // infinite or zero. An unbounded agent cannot be configured — the same rule
  // AGENT_HARNESS_DESIGN states for session types, enforced here in code.
  const max_turns = source.max_turns ?? 8;
  const max_tool_calls = source.max_tool_calls ?? 16;
  const max_steps = source.max_steps ?? 16;
  const run_timeout_ms = source.run_timeout_ms ?? 300_000;
  const step_timeout_ms = source.step_timeout_ms ?? 30_000;
  const max_context_tokens = source.max_context_tokens ?? 8_000;
  assertPositiveInt(max_turns, `agent '${agent_id}' budget.max_turns`);
  assertPositiveInt(max_tool_calls, `agent '${agent_id}' budget.max_tool_calls`);
  assertPositiveInt(max_steps, `agent '${agent_id}' budget.max_steps`);
  assertPositiveInt(run_timeout_ms, `agent '${agent_id}' budget.run_timeout_ms`);
  assertPositiveInt(step_timeout_ms, `agent '${agent_id}' budget.step_timeout_ms`);
  assertPositiveInt(max_context_tokens, `agent '${agent_id}' budget.max_context_tokens`);
  invariant(
    step_timeout_ms <= run_timeout_ms,
    'invalid_input', `agent '${agent_id}' step_timeout_ms ${step_timeout_ms} exceeds run_timeout_ms ${run_timeout_ms}`,
    { agent_id },
  );
  return { max_turns, max_tool_calls, max_steps, run_timeout_ms, step_timeout_ms, max_context_tokens };
}

function buildOutputContract(contract, agent_id) {
  const source = contract ?? {};
  assertClosedKeys(source, OUTPUT_CONTRACT_KEYS, `agent '${agent_id}' output_contract`);
  const schema = source.schema ?? null;
  invariant(
    schema === null || typeof schema === 'string',
    'invalid_input', `agent '${agent_id}' output_contract.schema must be a schema REFERENCE string or null`, { agent_id },
  );
  const required_keys = source.required_keys ?? [];
  invariant(Array.isArray(required_keys), 'invalid_input', `agent '${agent_id}' output_contract.required_keys must be an array`, { agent_id });
  required_keys.forEach((k) => invariant(
    typeof k === 'string' && k.length > 0,
    'invalid_input', `agent '${agent_id}' output_contract.required_keys must hold non-empty strings`, { agent_id },
  ));
  return { schema, required_keys: [...required_keys].sort() };
}

function buildEvaluationProfile(profile, agent_id) {
  const source = profile ?? {};
  assertClosedKeys(source, EVALUATION_PROFILE_KEYS, `agent '${agent_id}' evaluation_profile`);
  const evaluator = source.evaluator ?? null;
  invariant(
    evaluator === null || (typeof evaluator === 'string' && ID_PATTERN.test(evaluator)),
    'invalid_input', `agent '${agent_id}' evaluator '${evaluator}' must be snake_case or null`, { agent_id },
  );
  const version = source.version ?? null;
  invariant(
    version === null || SEMVER_PATTERN.test(version),
    'invalid_input', `agent '${agent_id}' evaluator version '${version}' must be a pinned semver or null`, { agent_id },
  );
  const rubric = source.rubric ?? null;
  invariant(
    rubric === null || typeof rubric === 'string',
    'invalid_input', `agent '${agent_id}' evaluation rubric must be a REFERENCE string or null`, { agent_id },
  );
  const required = source.required ?? false;
  invariant(typeof required === 'boolean', 'invalid_input', `agent '${agent_id}' evaluation required must be a boolean`, { agent_id });
  // An evaluator named without its version cannot be compared across runs, and
  // a comparison that cannot be reproduced is not evidence.
  invariant(
    evaluator === null || version !== null,
    'invalid_input', `agent '${agent_id}' names evaluator '${evaluator}' without a version`, { agent_id },
  );
  invariant(
    !required || evaluator !== null,
    'invalid_input', `agent '${agent_id}' requires evaluation but names no evaluator`, { agent_id },
  );
  return { evaluator, version, rubric, required };
}

function buildProvenance(provenance, agent_id, status) {
  const source = provenance ?? {};
  assertClosedKeys(source, PROVENANCE_KEYS, `agent '${agent_id}' provenance`);

  const instant = (value, label) => {
    const v = value ?? null;
    invariant(
      v === null || isInstant(v),
      'invalid_input', `agent '${agent_id}' ${label} must be an ISO-8601 instant or null`, { agent_id, [label]: v },
    );
    return v;
  };
  const person = (value, label) => {
    const v = value ?? null;
    invariant(
      v === null || (typeof v === 'string' && v.length > 0),
      'invalid_input', `agent '${agent_id}' ${label} must be a non-empty string or null`, { agent_id },
    );
    return v;
  };

  const built = {
    created_at: instant(source.created_at, 'created_at'),
    created_by: person(source.created_by, 'created_by'),
    approved_at: instant(source.approved_at, 'approved_at'),
    approved_by: person(source.approved_by, 'approved_by'),
    activated_at: instant(source.activated_at, 'activated_at'),
    activated_by: person(source.activated_by, 'activated_by'),
    source_ref: person(source.source_ref, 'source_ref'),
    supersedes: source.supersedes ?? null,
  };
  invariant(
    built.supersedes === null || SEMVER_PATTERN.test(built.supersedes),
    'invalid_input', `agent '${agent_id}' provenance.supersedes must be a pinned semver or null`, { agent_id },
  );
  invariant(
    built.created_at !== null && built.created_by !== null,
    'invalid_input', `agent '${agent_id}' must record who created this version and when`, { agent_id },
  );

  // Activation is an accountable act. A definition that claims to be active but
  // cannot say who approved it, who activated it, or when, is a definition that
  // no audit can attribute — and the whole point of a versioned registry is that
  // "why was this agent allowed to do that?" has an answer.
  const live = status === 'active' || status === 'deprecated';
  invariant(
    !live || (built.approved_at !== null && built.approved_by !== null),
    'invalid_input', `agent '${agent_id}' is '${status}' but does not record approved_at and approved_by`, { agent_id, status },
  );
  invariant(
    !live || (built.activated_at !== null && built.activated_by !== null),
    'invalid_input', `agent '${agent_id}' is '${status}' but does not record activated_at and activated_by`, { agent_id, status },
  );
  return built;
}

/**
 * defineAgentDefinition(spec) -> frozen, digest-pinned Agent Definition
 */
export function defineAgentDefinition(spec = {}) {
  const allowed = AGENT_DEFINITION_KEYS.filter((k) => k !== 'definition_digest');
  assertClosedKeys(spec, allowed, 'agent definition');

  const { agent_id, version } = spec;
  invariant(
    typeof agent_id === 'string' && ID_PATTERN.test(agent_id),
    'invalid_input', `agent_id '${agent_id}' must be snake_case`, { agent_id },
  );
  invariant(
    typeof version === 'string' && SEMVER_PATTERN.test(version),
    'invalid_input', `agent '${agent_id}' version '${version}' must be a pinned semver major.minor.patch`, { agent_id, version },
  );
  invariant(
    spec.schema === undefined || spec.schema === AGENT_DEFINITION_SCHEMA,
    'invalid_input', `agent '${agent_id}' declares schema '${spec.schema}', not '${AGENT_DEFINITION_SCHEMA}'`, { agent_id },
  );
  invariant(
    typeof spec.purpose === 'string' && spec.purpose.length > 0,
    'invalid_input', `agent '${agent_id}' needs a purpose`, { agent_id },
  );
  invariant(
    typeof spec.business_responsibility === 'string' && spec.business_responsibility.length > 0,
    'invalid_input',
    `agent '${agent_id}' needs a business_responsibility — the sentence an operator would read to decide whether this agent should exist`,
    { agent_id },
  );

  const status = spec.status ?? 'draft';
  invariant(
    AGENT_STATUSES.includes(status),
    'invalid_input', `agent '${agent_id}' status '${status}' is unknown`, { agent_id, status, known: AGENT_STATUSES },
  );

  const capabilities = buildCapabilityRefs(spec.capabilities ?? [], agent_id, {
    label: 'capabilities', versionRequired: true,
  });
  invariant(
    capabilities.length > 0,
    'invalid_input',
    `agent '${agent_id}' declares no capability — an agent with no business permission cannot do work, and an empty list reads as "unrestricted" to exactly the reader it must not`,
    { agent_id },
  );
  const denied_capabilities = buildCapabilityRefs(spec.denied_capabilities ?? [], agent_id, {
    label: 'denied_capabilities', versionRequired: false,
  });

  // Refused rather than resolved by precedence. Deny does win at runtime (see
  // authorization.mjs), but a definition whose meaning depends on the reader
  // remembering that is a definition nobody can review.
  const both = capabilities.map((c) => c.key).filter((key) => denied_capabilities.some((d) => d.key === key));
  invariant(
    both.length === 0,
    'invalid_input',
    `agent '${agent_id}' both declares and denies capability(ies) ${JSON.stringify(both.sort())}`,
    { agent_id, both: both.sort() },
  );

  const metadata = spec.metadata ?? {};
  invariant(
    metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata),
    'invalid_input', `agent '${agent_id}' metadata must be a plain object`, { agent_id },
  );

  const body = {
    schema: AGENT_DEFINITION_SCHEMA,
    agent_id,
    version,
    title: typeof spec.title === 'string' && spec.title.length > 0 ? spec.title : agent_id,
    purpose: spec.purpose,
    business_responsibility: spec.business_responsibility,
    tenant_scope: buildTenantScope(spec.tenant_scope, agent_id),
    status,
    capabilities,
    denied_capabilities,
    tools: buildToolRefs(spec.tools ?? [], agent_id),
    policy_set: buildPolicySet(spec.policy_set ?? [], agent_id),
    approval_profile: buildApprovalProfile(spec.approval_profile, agent_id),
    context_requirements: buildContextRequirements(spec.context_requirements ?? [], agent_id),
    memory_profile: buildMemoryProfile(spec.memory_profile, agent_id),
    model_profile: buildModelProfile(spec.model_profile, agent_id),
    budget: buildBudget(spec.budget, agent_id),
    output_contract: buildOutputContract(spec.output_contract, agent_id),
    evaluation_profile: buildEvaluationProfile(spec.evaluation_profile, agent_id),
    provenance: buildProvenance(spec.provenance, agent_id, status),
    metadata: { ...metadata },
  };

  // Stable across key order: this is the value a run pins, a resume compares
  // against, and a drift check reports on.
  return deepFreeze({ ...body, definition_digest: digest(body) });
}

export function assertAgentDefinition(definition, where = {}) {
  invariant(
    definition !== null && typeof definition === 'object' && !Array.isArray(definition),
    'contract_violation', 'an agent definition must be an object', { ...where },
  );
  for (const key of AGENT_DEFINITION_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(definition, key),
      'contract_violation', `agent definition is missing '${key}'`, { ...where, key, agent_id: definition.agent_id },
    );
  }
  invariant(
    definition.schema === AGENT_DEFINITION_SCHEMA,
    'contract_violation', `agent definition schema '${definition.schema}' is not '${AGENT_DEFINITION_SCHEMA}'`, { ...where },
  );
  const { definition_digest, ...rest } = definition;
  invariant(
    digest(rest) === definition_digest,
    'contract_violation', `agent '${definition.agent_id}' definition_digest does not match its content`,
    { ...where, expected: digest(rest), actual: definition_digest },
  );
  return definition;
}

// --- derived questions -------------------------------------------------------

export function agentTenantInScope(definition, org_id) {
  if (definition.tenant_scope.mode === 'any_tenant') return true;
  return typeof org_id === 'string' && definition.tenant_scope.org_ids.includes(org_id);
}

export function declaredCapability(definition, key) {
  return definition.capabilities.find((c) => c.key === key) ?? null;
}

export function deniedCapability(definition, key) {
  return definition.denied_capabilities.find((c) => c.key === key) ?? null;
}

export function declaredTool(definition, name) {
  return definition.tools.find((t) => t.name === name) ?? null;
}

/**
 * activateAgentDefinition({ definition, approved_by, approved_at, activated_by,
 *                           activated_at })
 *   -> a NEW frozen definition with status 'active'
 *
 * The only way a definition becomes executable, and note what it is NOT: it does
 * not mutate its argument, it does not accept `status` as a parameter, and it
 * refuses an already-active definition rather than re-stamping it. A definition
 * that is already live is changed by publishing a new VERSION, which is the
 * whole point of versioning it.
 *
 * There is no way to call this from inside the harness — the harness never
 * imports this module's activation path, and Runner G asserts that structurally.
 */
export function activateAgentDefinition({
  definition, approved_by = null, approved_at = null, activated_by = null, activated_at = null,
} = {}) {
  assertAgentDefinition(definition, { at: 'activateAgentDefinition' });
  invariant(
    definition.status === 'draft',
    'invalid_input',
    `agent '${definition.agent_id}' v${definition.version} is '${definition.status}'; only a draft may be activated, and a live definition is changed by publishing a new version`,
    { agent_id: definition.agent_id, version: definition.version, status: definition.status },
  );
  invariant(
    typeof approved_by === 'string' && approved_by.length > 0,
    'invalid_input', 'activation must name the person who approved this version', {},
  );
  invariant(
    typeof activated_by === 'string' && activated_by.length > 0,
    'invalid_input', 'activation must name the person who activated it', {},
  );
  invariant(isInstant(approved_at), 'invalid_input', 'activation needs an approved_at instant', { approved_at });
  invariant(isInstant(activated_at), 'invalid_input', 'activation needs an activated_at instant', { activated_at });

  const { schema, definition_digest, ...rest } = definition;
  return defineAgentDefinition({
    ...rest,
    status: 'active',
    provenance: { ...definition.provenance, approved_by, approved_at, activated_by, activated_at },
  });
}
