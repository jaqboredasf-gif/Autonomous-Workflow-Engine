// ---------------------------------------------------------------------------
// authorization.mjs — the governed authorizer, and the Policy Decision Record.
//
// This is where a proposal becomes (or fails to become) an authorized action.
// It is the single function that decides, and its output is not a boolean but a
// RECORD: an immutable, digest-pinned document naming the tenant, the actor, the
// agent version, the capability version, the tool version, the operation, the
// data classification it was decided on, the decision, the reason codes, the
// policies evaluated, and the binding an approval would attach to.
//
// THE FIVE INDEPENDENT NARROWINGS, all of which must hold. No layer may widen
// another; each can only refuse more:
//
//   1. THE AGENT      the definition declares the capability, does not deny it,
//                     is active, and is in this tenant's scope.
//   2. THE CAPABILITY it resolves at a version the agent pinned, admits this
//                     tenant and this actor's roles, binds this tool for this
//                     operation, at or above this tool's side-effect class, at
//                     or above this evidence's data classification, with the
//                     idempotency and evidence obligations satisfied.
//   3. THE TENANT     the control plane's policy engine — unchanged, reused —
//                     finds a grant and allows it. Deny by default.
//   4. THE APPROVAL   where one is obliged, an approval is in force, unexpired,
//                     and BOUND to these exact arguments.
//   5. THE BUDGET     the run has turns, steps, tool calls and time left.
//
// WHAT THE PLANNER CONTRIBUTES TO THE DECISION: nothing. Its claimed risk,
// claimed side effect and claimed approval requirement are recorded as evidence
// of what it believed, and are compared against the truth — a planner that
// UNDERSTATES an approval requirement earns a `planner_understated_approval`
// reason code on an authorization that requires approval anyway. A model cannot
// make this function return `allow`; it can only make it return `deny` sooner.
//
// ORDERING IS A SECURITY PROPERTY. Identity is checked before anything is read,
// so a refusal cannot be used as an existence oracle for another tenant's runs;
// the capability gates come before the tool gates, so a caller learns nothing
// about the tool catalog through a capability it does not hold.
//
// PURE: no clock (the deciding instant is an argument), no randomness, no I/O.
// ---------------------------------------------------------------------------

import {
  SIDE_EFFECT_RANK, canonicalClone, deepFreeze, digest, invariant, isInstant,
  maxSensitivity, satisfiesVersion, sensitivityRank,
} from './kernel.mjs';
import {
  capabilityAdmitsSensitivity, capabilityPermitsActor, capabilityRequiresApproval,
  capabilityTenantInScope,
} from './capability.mjs';
import { declaredCapability, deniedCapability, agentTenantInScope } from './agent-definition.mjs';
import { bindingDigest } from './proposal.mjs';

export const POLICY_DECISION_SCHEMA = 'awe.policy_decision/v1';

export const AGENT_POLICY_DECISIONS = ['allow', 'require_approval', 'deny'];

export const POLICY_DECISION_KEYS = [
  'schema', 'decision_id', 'decided_at', 'org_id', 'actor', 'actor_roles',
  'agent_id', 'agent_version', 'definition_digest', 'capability_key',
  'capability_version', 'operation', 'tool', 'tool_version', 'side_effect', 'risk',
  'input_classification', 'decision', 'reason_codes', 'detail', 'evaluated_policies',
  'binding_digest', 'proposal_id', 'proposal_digest', 'evidence', 'correlation_id',
  'causation_id', 'obligations', 'decision_digest',
];

// Argument keys that would, if a tool honoured them, let a run act on another
// tenant's data. The rule is deliberately about the KEY rather than the value:
// a tool is free to take a `supplier_org` string, but anything that names a
// TENANT must name this one.
const TENANT_ARGUMENT_KEYS = /(^|_)(org_id|tenant_id|organisation_id|organization_id)$/;

// Argument keys that name the governance machinery itself. An agent asking a
// tool to write any of these is asking to change what it is allowed to do,
// which is the one request no amount of approval makes safe — the answer is
// a new reviewed agent VERSION, not a runtime argument.
const GOVERNANCE_ARGUMENT_KEYS = [
  'capabilities', 'denied_capabilities', 'capability', 'grants', 'grant', 'tool_grant',
  'policy_set', 'policies', 'approval_profile', 'approver_roles', 'quorum',
  'agent_definition', 'definition_digest', 'status', 'tenant_scope', 'budget',
  'model_profile', 'memory_profile', 'evaluation_profile',
];

// Milliseconds between two instants. `Date.parse` is a pure string→number
// function that reads nothing from the system clock — the same exception, for
// the same reason, that `engine.mjs:instantDelta` documents. Formatting an
// instant would need `new Date(...)` and is deliberately not done anywhere in
// this package.
function ageMs(from, to) {
  if (!isInstant(from) || !isInstant(to)) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return b - a;
}

function flattenKeys(value, prefix = '', out = []) {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((entry, i) => flattenKeys(entry, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    out.push({ path: prefix === '' ? key : `${prefix}.${key}`, key, value: entry });
    flattenKeys(entry, prefix === '' ? key : `${prefix}.${key}`, out);
  }
  return out;
}

/**
 * createPolicyDecision(fields) -> frozen, digest-pinned Policy Decision Record
 *
 * The record is IMMUTABLE AUDIT EVIDENCE. It is created here, appended to the
 * journal by the harness, and never revised: a later decision is a later
 * record. Nothing in the plane can edit one, and a model never reaches this
 * constructor because it never reaches the harness.
 */
export function createPolicyDecision({
  decision_id, decided_at = null, org_id = null, actor = null, actor_roles = [],
  agent_id = null, agent_version = null, definition_digest = null,
  capability_key = null, capability_version = null, operation = null,
  tool = null, tool_version = null, side_effect = null, risk = null,
  input_classification = null, decision, reason_codes = [], detail = null,
  evaluated_policies = [], binding_digest = null, proposal_id = null,
  proposal_digest = null, evidence = [], correlation_id = null, causation_id = null,
  obligations = null,
} = {}) {
  invariant(
    AGENT_POLICY_DECISIONS.includes(decision),
    'invalid_input', `unknown policy decision '${decision}'`, { decision, known: AGENT_POLICY_DECISIONS },
  );
  invariant(
    typeof decision_id === 'string' && decision_id.length > 0,
    'invalid_input', 'a policy decision must have an identifier', {},
  );
  invariant(
    decided_at === null || isInstant(decided_at),
    'invalid_input', 'a policy decision instant must be an ISO-8601 instant or null', { decided_at },
  );
  invariant(
    Array.isArray(reason_codes) && reason_codes.length > 0,
    'invalid_input',
    'a policy decision must carry at least one reason code — an unexplained allow is as unauditable as an unexplained deny',
    { decision },
  );

  const body = {
    schema: POLICY_DECISION_SCHEMA,
    decision_id,
    decided_at,
    org_id,
    actor,
    actor_roles: [...actor_roles].sort(),
    agent_id,
    agent_version,
    definition_digest,
    capability_key,
    capability_version,
    operation,
    tool,
    tool_version,
    side_effect,
    risk,
    input_classification,
    decision,
    reason_codes: [...reason_codes],
    detail,
    evaluated_policies: [...evaluated_policies],
    binding_digest,
    proposal_id,
    proposal_digest,
    evidence: canonicalClone(evidence),
    correlation_id,
    causation_id,
    obligations: obligations === null ? null : canonicalClone(obligations),
  };
  return deepFreeze({ ...body, decision_digest: digest(body) });
}

export function assertPolicyDecision(record, where = {}) {
  invariant(
    record !== null && typeof record === 'object' && !Array.isArray(record),
    'contract_violation', 'a policy decision must be an object', { ...where },
  );
  for (const key of POLICY_DECISION_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(record, key),
      'contract_violation', `policy decision is missing '${key}'`, { ...where, key },
    );
  }
  const { decision_digest, ...rest } = record;
  invariant(
    digest(rest) === decision_digest,
    'contract_violation', 'policy decision digest does not match its content',
    { ...where, expected: digest(rest), actual: decision_digest },
  );
  return record;
}

/**
 * authorizeProposal({ … }) -> Policy Decision Record
 *
 *   proposal      — a parsed Action Proposal (untrusted)
 *   definition    — the resolved Agent Definition
 *   surface       — the compiled Agent Execution Surface
 *   capabilities  — the Capability Registry
 *   policy        — the control plane's policy engine (reused, not restated)
 *   catalog       — the kernel tool catalog
 *   context       — the execution context (tenant, actor, mode)
 *   principal     — the human or service identity on whose behalf the run acts
 *   actor_roles   — that identity's roles, as DATA supplied by the surface
 *   bundle        — the assembled context bundle (for evidence checking)
 *   observations  — this run's recorded observations (for evidence checking)
 *   budget        — a budget ledger view: { ok, reason, detail }
 *   approval      — the approval currently in force for this proposal, or null
 *   decided_at    — the instant, INJECTED
 *
 * Returns a decision record; it never throws for a refusal. It throws only for a
 * wiring bug (no proposal, no definition, no policy engine).
 */
export function authorizeProposal({
  proposal, definition, surface, capabilities, policy, catalog, context,
  principal = null, actor_roles = [], bundle = null, context_index = null,
  observations = [], budget = null, approval = null, decided_at = null, decision_seq = 1,
} = {}) {
  invariant(proposal !== null && proposal !== undefined, 'invalid_input', 'authorizeProposal needs a proposal', {});
  invariant(definition !== null && definition !== undefined, 'invalid_input', 'authorizeProposal needs an agent definition', {});
  invariant(surface !== null && surface !== undefined, 'invalid_input', 'authorizeProposal needs a compiled execution surface', {});
  invariant(policy !== null && policy !== undefined, 'invalid_input', 'authorizeProposal needs a policy engine', {});
  invariant(catalog !== null && catalog !== undefined, 'invalid_input', 'authorizeProposal needs a tool catalog', {});
  invariant(context !== null && context !== undefined, 'invalid_input', 'authorizeProposal needs an execution context', {});

  const org_id = context.org_id ?? null;
  const evaluated_policies = [
    ...definition.policy_set.map((p) => `${p.policy_id}@${p.version}`),
    `tenant_grants@${policy.policy_digest()}`,
    `agent_surface@${surface.surface_digest}`,
  ];

  const decision_id = `dec-${digest({
    run_id: context.run_id,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    seq: decision_seq,
  }, { length: 16 })}`;

  const base = {
    decision_id,
    decided_at,
    org_id,
    actor: principal,
    actor_roles,
    agent_id: definition.agent_id,
    agent_version: definition.version,
    definition_digest: definition.definition_digest,
    capability_key: proposal.capability.key,
    capability_version: null,
    operation: proposal.operation,
    tool: proposal.tool.name,
    tool_version: null,
    side_effect: null,
    risk: null,
    input_classification: null,
    evaluated_policies,
    binding_digest: null,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    evidence: proposal.evidence,
    correlation_id: proposal.correlation_id,
    causation_id: proposal.causation_id,
  };

  const deny = (reason, detail, extra = {}) => createPolicyDecision({
    ...base, ...extra, decision: 'deny', reason_codes: [reason], detail,
  });

  // --- 0. IDENTITY, before anything is read ---------------------------------
  //
  // Both of these are checked first and unconditionally. A refusal that
  // depended on looking a run or a tenant up would leak the existence of one.
  if (org_id === null || org_id === undefined || org_id === '') {
    return deny('tenant_identity_required', 'the run names no tenant; a governed agent action is never taken for "no tenant"');
  }
  if (typeof principal !== 'string' || principal.length === 0) {
    return deny('actor_identity_required', 'the run names no actor; every action is attributable to an identity');
  }

  // --- 1. THE AGENT ----------------------------------------------------------
  if (definition.status !== 'active' && definition.status !== 'deprecated') {
    return deny('agent_not_active', `agent '${definition.agent_id}' v${definition.version} is '${definition.status}' and may not act`);
  }
  if (!agentTenantInScope(definition, org_id)) {
    return deny('agent_tenant_out_of_scope', `tenant '${org_id}' is not in the scope of agent '${definition.agent_id}'`);
  }

  // Denial is checked BEFORE declaration. A definition that carries both is
  // refused at build time, so this ordering is belt and braces — but the belt
  // is the one that must not be the weaker rule.
  const denied = deniedCapability(definition, proposal.capability.key);
  if (denied !== null && (denied.version === null || satisfiesVersion(proposal.capability.version.replace('^', ''), denied.version))) {
    return deny('capability_denied', `agent '${definition.agent_id}' explicitly denies capability '${proposal.capability.key}'`);
  }
  const declared = declaredCapability(definition, proposal.capability.key);
  if (declared === null) {
    return deny(
      'capability_not_declared',
      `agent '${definition.agent_id}' v${definition.version} does not declare capability '${proposal.capability.key}'`,
    );
  }

  // --- 2. THE CAPABILITY -----------------------------------------------------
  const resolution = capabilities.resolve({
    key: proposal.capability.key,
    // The AGENT's pinned requirement decides which version resolves, not the
    // planner's. A proposal cannot reach a capability version its agent did not
    // pin, however it phrases its own requirement.
    version: declared.version,
    org_id,
    actor_roles,
  });
  if (!resolution.ok) {
    return deny(resolution.reason, resolution.detail);
  }
  const capability = resolution.capability;
  // The planner's own version requirement still has to be satisfiable by what
  // resolved, so a proposal written against `^2.0.0` is not silently served by
  // the 1.x the agent pinned.
  if (!satisfiesVersion(capability.version, proposal.capability.version)) {
    return deny(
      'capability_version_incompatible',
      `the proposal asks for capability '${capability.key}' '${proposal.capability.version}'; this agent pins '${declared.version}', which resolves to v${capability.version}`,
      { capability_version: capability.version },
    );
  }
  if (!capabilityTenantInScope(capability, org_id)) {
    return deny('capability_tenant_out_of_scope', `tenant '${org_id}' may not hold capability '${capability.key}'`, { capability_version: capability.version });
  }
  if (!capabilityPermitsActor(capability, actor_roles)) {
    return deny(
      'capability_actor_not_permitted',
      `capability '${capability.key}' is restricted to ${JSON.stringify(capability.actor_roles)}`,
      { capability_version: capability.version },
    );
  }
  if (!capability.operations.includes(proposal.operation)) {
    return deny(
      'capability_operation_not_permitted',
      `capability '${capability.key}' permits ${JSON.stringify(capability.operations)}, not '${proposal.operation}'`,
      { capability_version: capability.version },
    );
  }

  const binding = surface.bindingFor({
    capability_key: capability.key,
    operation: proposal.operation,
    tool: proposal.tool.name,
  });
  if (binding === null) {
    return deny(
      'capability_tool_not_bound',
      `capability '${capability.key}' does not bind tool '${proposal.tool.name}' for operation '${proposal.operation}' in this agent's surface`,
      { capability_version: capability.version, risk: capability.risk },
    );
  }

  // --- 3. THE TOOL -----------------------------------------------------------
  if (!catalog.has(proposal.tool.name)) {
    // Also the answer to "can a planner call a hidden infrastructure API?".
    // There is no name it can produce that the catalog does not already hold,
    // and an unknown name is a refusal rather than an attempt.
    return deny(
      'tool_not_registered',
      `no tool named '${proposal.tool.name}' is in the tool registry`,
      { capability_version: capability.version, risk: capability.risk },
    );
  }
  const descriptor = catalog.get(proposal.tool.name).descriptor;
  const versionChecks = [
    ['the proposal', proposal.tool.version],
    ['capability ' + capability.key, binding.capability_tool_version],
    [`agent ${definition.agent_id}`, binding.agent_tool_version],
  ];
  for (const [who, requirement] of versionChecks) {
    if (!satisfiesVersion(descriptor.version, requirement)) {
      return deny(
        'tool_version_incompatible',
        `tool '${descriptor.name}' is v${descriptor.version}; ${who} requires '${requirement}'`,
        { capability_version: capability.version, tool_version: descriptor.version, risk: capability.risk },
      );
    }
  }
  if (SIDE_EFFECT_RANK[descriptor.side_effect] > SIDE_EFFECT_RANK[binding.max_side_effect]) {
    return deny(
      'proposal_side_effect_not_permitted',
      `tool '${descriptor.name}' is '${descriptor.side_effect}'; capability '${capability.key}' binds it at or below '${binding.max_side_effect}'`,
      { capability_version: capability.version, tool_version: descriptor.version, side_effect: descriptor.side_effect, risk: capability.risk },
    );
  }

  const decided = {
    capability_version: capability.version,
    tool_version: descriptor.version,
    side_effect: descriptor.side_effect,
    risk: capability.risk,
  };
  const denyDecided = (reason, detail, extra = {}) => deny(reason, detail, { ...decided, ...extra });

  // --- 4. THE ARGUMENTS ------------------------------------------------------
  const flattened = flattenKeys(proposal.arguments);

  // Cross-tenant. Anything that NAMES a tenant must name this one — at any depth,
  // so a nested `{ filter: { org_id: 'org_other' } }` is caught too.
  const foreign = flattened.filter((entry) => TENANT_ARGUMENT_KEYS.test(entry.key)
    && typeof entry.value === 'string' && entry.value !== org_id);
  if (foreign.length > 0) {
    return denyDecided(
      'proposal_cross_tenant_reference',
      `argument(s) ${JSON.stringify(foreign.map((f) => f.path).sort())} name a tenant other than '${org_id}'`,
    );
  }

  // Privilege escalation. An agent may not ask a tool to rewrite the governance
  // documents that bound it. There is no approval level at which this becomes
  // acceptable, so it is a DENY and not a require_approval.
  const governance = flattened.filter((entry) => GOVERNANCE_ARGUMENT_KEYS.includes(entry.key));
  if (governance.length > 0) {
    return denyDecided(
      'proposal_privilege_escalation',
      `argument(s) ${JSON.stringify(governance.map((g) => g.path).sort())} name the governance machinery; an agent changes what it may do by being re-versioned and re-reviewed, never by an argument`,
    );
  }

  // --- 5. EVIDENCE AND DATA CLASSIFICATION -----------------------------------
  // What this run was ACTUALLY given, as { id, sensitivity } pairs. Either the
  // live bundle (a first pass) or the index the run recorded in its own journal
  // when the context was assembled (a resume, where the bundle is long gone and
  // re-assembling it could quietly hand the run different material).
  const index = context_index ?? (bundle?.items ?? []).map((item) => ({
    id: item.id, sensitivity: item.sensitivity,
  }));
  const bundleIds = new Set(index.map((item) => item.id));
  const observationRefs = new Set((observations ?? []).map((o) => o.ref));
  const unknownEvidence = proposal.evidence.filter((e) => (e.kind === 'context_item'
    ? !bundleIds.has(e.ref)
    : !observationRefs.has(e.ref)));
  if (unknownEvidence.length > 0) {
    // A planner citing something that is not in this run's context or history is
    // citing something it invented. Refusing here is what stops a fabricated
    // justification from being the thing that carries an action past a reviewer.
    return denyDecided(
      'proposal_evidence_unknown',
      `evidence ${JSON.stringify(unknownEvidence.map((e) => `${e.kind}:${e.ref}`).sort())} is not in this run's assembled context or recorded observations`,
    );
  }
  if (capability.audit === 'evidence_required' && proposal.evidence.length === 0) {
    return denyDecided(
      'proposal_evidence_required',
      `capability '${capability.key}' requires the proposal to cite the evidence it acted on`,
    );
  }

  const citedItems = index.filter((item) => proposal.evidence.some((e) => e.kind === 'context_item' && e.ref === item.id));
  const input_classification = citedItems.length === 0
    ? 'internal'
    : maxSensitivity(citedItems.map((item) => item.sensitivity));
  if (!capabilityAdmitsSensitivity(capability, input_classification)) {
    return denyDecided(
      'capability_data_classification_exceeded',
      `the cited evidence is '${input_classification}'; capability '${capability.key}' handles at most '${capability.max_data_classification}'`,
      { input_classification },
    );
  }
  const classified = { ...decided, input_classification };
  const denyClassified = (reason, detail, extra = {}) => deny(reason, detail, { ...classified, ...extra });

  // --- 6. IDEMPOTENCY --------------------------------------------------------
  if (capability.idempotency === 'required' && proposal.idempotency_key === null) {
    return denyClassified(
      'proposal_idempotency_required',
      `capability '${capability.key}' requires an explicit idempotency key so a repeated proposal cannot become a repeated effect`,
    );
  }

  // --- 7. THE BUDGET ---------------------------------------------------------
  if (budget !== null && budget.ok === false) {
    return denyClassified(budget.reason, budget.detail);
  }

  // --- 8. THE TENANT GRANT, through the control plane's own policy engine ----
  //
  // Reused verbatim, not reimplemented: LIVE refusal, tenant binding, the
  // manifest/grant/descriptor ceiling intersection and the approval threshold
  // are the control plane's rules and stay its rules. The agent surface is the
  // manifest it evaluates against.
  const verdict = policy.evaluate({
    manifest: surface.manifest,
    descriptor,
    context,
    step: { id: binding.step_id, tool: descriptor.name, idempotency_key: proposal.idempotency_key },
  });
  if (verdict.decision === 'deny') {
    return denyClassified(verdict.reason, verdict.detail);
  }

  const binding_digest = bindingDigest({
    proposal,
    org_id,
    agent_id: definition.agent_id,
    agent_version: definition.version,
    capability_version: capability.version,
    tool_version: descriptor.version,
  });

  // --- 9. APPROVAL -----------------------------------------------------------
  //
  // The STRICTEST of three independent statements decides, and the planner's
  // claim is not one of them:
  //   * the control plane's policy verdict (manifest ∧ grant thresholds)
  //   * the capability's own threshold
  //   * the agent definition's approval profile
  const policyGated = verdict.decision === 'require_approval';
  const capabilityGated = capabilityRequiresApproval(capability, descriptor.side_effect);
  const profileThreshold = definition.approval_profile.requires_approval_at_or_above;
  const profileGated = profileThreshold !== null
    && SIDE_EFFECT_RANK[descriptor.side_effect] >= SIDE_EFFECT_RANK[profileThreshold];
  const gated = policyGated || capabilityGated || profileGated;

  const reason_codes = [];
  if (policyGated) reason_codes.push('policy_threshold');
  if (capabilityGated) reason_codes.push('capability_threshold');
  if (profileGated) reason_codes.push('agent_profile_threshold');
  // Recorded, never acted on. A planner that says "no approval needed" for an
  // action that needs one is a fact worth having in the evaluation record.
  if (gated && proposal.requires_approval_claimed === false) reason_codes.push('planner_understated_approval');

  const approver_roles = [...new Set([
    ...(verdict.obligations?.approver_roles ?? []),
    ...definition.approval_profile.approver_roles,
    ...capability.actor_roles,
  ])].sort();

  const obligations = deepFreeze({
    approver_roles,
    quorum: Math.max(verdict.obligations?.quorum ?? 1, definition.approval_profile.quorum),
    binding: definition.approval_profile.binding,
    ttl_ms: definition.approval_profile.ttl_ms,
    step_id: binding.step_id,
  });

  if (gated) {
    if (approval === null || approval === undefined) {
      return createPolicyDecision({
        ...base, ...classified, binding_digest,
        decision: 'require_approval',
        reason_codes: [...reason_codes, 'approval_required'],
        detail: `a '${descriptor.side_effect}' action under capability '${capability.key}' requires a human approval bound to these arguments`,
        obligations,
      });
    }

    // An approval exists. Three ways it can fail to authorize THIS action, and
    // all three are denials rather than "ask again":
    if (approval.decision !== 'approve') {
      return createPolicyDecision({
        ...base, ...classified, binding_digest,
        decision: 'deny',
        reason_codes: ['approval_not_in_force'],
        detail: `the recorded decision on this action is '${approval.decision}'`,
        obligations,
      });
    }
    if (approval.binding_digest !== binding_digest) {
      // THE rule that makes an approval an approval OF SOMETHING. The arguments,
      // the capability version, the tool version or the tenant changed after a
      // human said yes; what was approved is not what is about to happen.
      return createPolicyDecision({
        ...base, ...classified, binding_digest,
        decision: 'deny',
        reason_codes: ['approval_binding_mismatch'],
        detail: 'the approval in force was granted for a materially different action (arguments, capability version, tool version or tenant)',
        obligations,
      });
    }
    // Expiry is measured, never formatted: this package may not construct an
    // instant (that would need `new Date(...)`, which the purity lint forbids
    // for the same reason the control plane bans it). The approval carries WHEN
    // it was granted and HOW LONG it is good for, and the age is compared here.
    const ttl_ms = approval.ttl_ms ?? definition.approval_profile.ttl_ms;
    const age = ageMs(approval.granted_at ?? null, decided_at);
    if (ttl_ms !== null && ttl_ms !== undefined && age !== null && age > ttl_ms) {
      return createPolicyDecision({
        ...base, ...classified, binding_digest,
        decision: 'deny',
        reason_codes: ['approval_expired'],
        detail: `the approval was granted ${age}ms ago and is good for ${ttl_ms}ms; a decision has a shelf life because the world it was made about moves`,
        obligations,
      });
    }
    reason_codes.push('approval_in_force');
  }

  return createPolicyDecision({
    ...base, ...classified, binding_digest,
    decision: 'allow',
    reason_codes: reason_codes.length > 0 ? reason_codes : ['authorized'],
    detail: null,
    obligations: gated ? obligations : null,
  });
}

/**
 * simulateProposal(args) -> decision record, with NO side effect possible.
 *
 * Policy dry-run: the same function, the same rules, the same record — the only
 * difference is that the caller does not then execute. It exists so an operator
 * can ask "what would this agent be allowed to do with this context?" without
 * the answer being obtained by finding out.
 *
 * It is a separate export rather than a flag on `authorizeProposal` because a
 * flag that turns execution off is a flag that can be forgotten; this function
 * has no path to the dispatcher at all.
 */
export function simulateProposal(args = {}) {
  const record = authorizeProposal(args);
  return deepFreeze({
    simulated: true,
    decision: record.decision,
    record,
    // Stated explicitly so a caller cannot read a simulation as an execution.
    executed: false,
  });
}

// Exported for the reason-vocabulary lint and for the planning view, which must
// never be handed anything from this module beyond these names.
export const ARGUMENT_GUARD_KEYS = Object.freeze([...GOVERNANCE_ARGUMENT_KEYS].sort());
export { sensitivityRank };
