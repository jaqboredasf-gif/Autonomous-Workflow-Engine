// ---------------------------------------------------------------------------
// proposal.mjs — the Action Proposal contract.
//
// THE ONE SENTENCE THIS FILE EXISTS FOR: a planner proposes an action; it does
// not perform one. Everything a model produces enters the platform through this
// shape, is validated as untrusted input, and is then RE-DERIVED by the runtime
// — which is what makes "the model chose the tool" false as a description of
// what happens, rather than merely discouraged.
//
// A proposal carries three kinds of field, and keeping them apart is the whole
// design:
//
//   IDENTITY        proposal_id, turn, correlation_id, causation_id
//                   — what this is and what caused it.
//   REQUEST         capability, operation, tool, arguments, idempotency_key
//                   — what is being asked for. The runtime checks every one of
//                     these against the registries; none of them is trusted.
//   SELF-REPORT     reason, expected_outcome, evidence, risk, side_effect,
//                   confidence, requires_approval_claimed
//                   — what the planner BELIEVES. Recorded as evidence for the
//                     audit and for evaluation. NOTHING here is an input to an
//                     authorization decision. `requires_approval_claimed: false`
//                     has no effect whatsoever; the runtime decides, and a
//                     planner that understates the requirement is recorded as
//                     having done so (authorization.mjs).
//
// FAIL-CLOSED PARSING. `defineActionProposal` refuses:
//   * unknown keys — a typo'd field is a refused proposal, not an ignored one;
//   * an unversioned capability or tool reference — an unversioned dependency
//     cannot be replayed and cannot be re-bound to an approval;
//   * an argument key beginning with `_` — those are the engine's reserved
//     envelope keys (`_run_id`, `_org_id`, `_results`), and a planner that could
//     set them could rewrite the tenant the tool executes under. This is the
//     single most direct privilege-escalation path a proposal has, and it is
//     closed by the grammar rather than by a check somewhere downstream;
//   * a non-plain-object argument bag, a non-finite confidence, an unknown
//     evidence kind.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { SIDE_EFFECTS, canonicalClone, deepFreeze, digest, invariant, isKernelError } from './kernel.mjs';
import { CAPABILITY_RISKS } from './capability.mjs';

export const ACTION_PROPOSAL_SCHEMA = 'awe.action_proposal/v1';

export const ACTION_PROPOSAL_KEYS = [
  'schema', 'proposal_id', 'turn', 'capability', 'operation', 'tool', 'arguments',
  'reason', 'expected_outcome', 'evidence', 'risk', 'side_effect', 'idempotency_key',
  'confidence', 'requires_approval_claimed', 'correlation_id', 'causation_id',
  'proposal_digest',
];

// What a proposal may point at as its grounds. Both are references INTO the run:
// a context item that was actually assembled, or an observation this run
// actually recorded. A planner cannot cite anything else, which is what makes
// "fabricated evidence" a checkable refusal rather than a judgement call.
export const EVIDENCE_KINDS = ['context_item', 'observation'];

const REF_KEYS = ['key', 'version'];
const TOOL_REF_KEYS = ['name', 'version'];
const EVIDENCE_KEYS = ['kind', 'ref'];

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const CAPABILITY_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const REQUIREMENT_PATTERN = /^\^?\d+\.\d+\.\d+$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

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
    { label, unknown: unknown.sort() },
  );
}

export function defineActionProposal(spec = {}) {
  const allowed = ACTION_PROPOSAL_KEYS.filter((k) => k !== 'proposal_digest');
  assertClosedKeys(spec, allowed, 'action proposal');

  const { proposal_id } = spec;
  invariant(
    typeof proposal_id === 'string' && OPAQUE_ID_PATTERN.test(proposal_id),
    'invalid_input', `proposal_id '${proposal_id}' must be a short opaque identifier`, { proposal_id },
  );
  invariant(
    spec.schema === undefined || spec.schema === ACTION_PROPOSAL_SCHEMA,
    'invalid_input', `proposal '${proposal_id}' declares schema '${spec.schema}', not '${ACTION_PROPOSAL_SCHEMA}'`, { proposal_id },
  );

  const turn = spec.turn ?? null;
  invariant(
    Number.isInteger(turn) && turn >= 1,
    'invalid_input', `proposal '${proposal_id}' must state which turn produced it`, { proposal_id, turn },
  );

  // --- the capability reference
  const capability = spec.capability ?? null;
  invariant(capability !== null, 'invalid_input', `proposal '${proposal_id}' must name a capability`, { proposal_id });
  assertClosedKeys(capability, REF_KEYS, `proposal '${proposal_id}' capability`);
  invariant(
    typeof capability.key === 'string' && CAPABILITY_KEY_PATTERN.test(capability.key),
    'invalid_input', `proposal '${proposal_id}' capability key '${capability.key}' must be dotted lower_snake`, { proposal_id },
  );
  invariant(
    typeof capability.version === 'string' && REQUIREMENT_PATTERN.test(capability.version),
    'invalid_input',
    `proposal '${proposal_id}' capability '${capability.key}' must state a version ('x.y.z' or '^x.y.z') — an unversioned dependency is refused`,
    { proposal_id, version: capability.version },
  );

  const operation = spec.operation ?? null;
  invariant(
    typeof operation === 'string' && ID_PATTERN.test(operation),
    'invalid_input', `proposal '${proposal_id}' operation '${operation}' must be snake_case`, { proposal_id, operation },
  );

  // --- the tool reference
  const tool = spec.tool ?? null;
  invariant(tool !== null, 'invalid_input', `proposal '${proposal_id}' must name a tool`, { proposal_id });
  assertClosedKeys(tool, TOOL_REF_KEYS, `proposal '${proposal_id}' tool`);
  invariant(
    typeof tool.name === 'string' && ID_PATTERN.test(tool.name),
    'invalid_input', `proposal '${proposal_id}' tool name '${tool.name}' must be snake_case`, { proposal_id },
  );
  invariant(
    typeof tool.version === 'string' && REQUIREMENT_PATTERN.test(tool.version),
    'invalid_input',
    `proposal '${proposal_id}' tool '${tool.name}' must state a version ('x.y.z' or '^x.y.z') — an unversioned dependency is refused`,
    { proposal_id, version: tool.version },
  );

  // --- arguments
  const args = spec.arguments ?? {};
  invariant(
    args !== null && typeof args === 'object' && !Array.isArray(args),
    'invalid_input', `proposal '${proposal_id}' arguments must be a plain object`, { proposal_id },
  );
  const reserved = Object.keys(args).filter((k) => k.startsWith('_'));
  invariant(
    reserved.length === 0,
    'invalid_input',
    `proposal '${proposal_id}' arguments use reserved key(s) ${JSON.stringify(reserved.sort())} — the engine's envelope (_run_id, _org_id, _results) is set by the runtime and a proposal may not supply it`,
    { proposal_id, reserved: reserved.sort() },
  );

  invariant(
    typeof spec.reason === 'string' && spec.reason.length > 0,
    'invalid_input', `proposal '${proposal_id}' must state why this action is being proposed`, { proposal_id },
  );
  const expected_outcome = spec.expected_outcome ?? null;
  invariant(
    expected_outcome === null || (typeof expected_outcome === 'string' && expected_outcome.length > 0),
    'invalid_input', `proposal '${proposal_id}' expected_outcome must be a non-empty string or null`, { proposal_id },
  );

  // --- evidence
  const evidence = spec.evidence ?? [];
  invariant(Array.isArray(evidence), 'invalid_input', `proposal '${proposal_id}' evidence must be an array`, { proposal_id });
  const builtEvidence = evidence.map((item) => {
    assertClosedKeys(item, EVIDENCE_KEYS, `proposal '${proposal_id}' evidence entry`);
    invariant(
      EVIDENCE_KINDS.includes(item.kind),
      'invalid_input', `proposal '${proposal_id}' evidence kind '${item.kind}' is unknown`,
      { proposal_id, kind: item.kind, known: EVIDENCE_KINDS },
    );
    invariant(
      typeof item.ref === 'string' && item.ref.length > 0,
      'invalid_input', `proposal '${proposal_id}' evidence must reference something`, { proposal_id },
    );
    return { kind: item.kind, ref: item.ref };
  }).sort((a, b) => (`${a.kind}:${a.ref}` < `${b.kind}:${b.ref}` ? -1 : 1));

  // --- the planner's self-report
  const risk = spec.risk ?? null;
  invariant(
    risk === null || CAPABILITY_RISKS.includes(risk),
    'invalid_input', `proposal '${proposal_id}' risk '${risk}' is not a risk class`, { proposal_id, known: CAPABILITY_RISKS },
  );
  const side_effect = spec.side_effect ?? null;
  invariant(
    side_effect === null || SIDE_EFFECTS.includes(side_effect),
    'invalid_input', `proposal '${proposal_id}' side_effect '${side_effect}' is not a side-effect class`,
    { proposal_id, known: SIDE_EFFECTS },
  );
  const idempotency_key = spec.idempotency_key ?? null;
  invariant(
    idempotency_key === null || (typeof idempotency_key === 'string' && OPAQUE_ID_PATTERN.test(idempotency_key)),
    'invalid_input', `proposal '${proposal_id}' idempotency_key must be a short opaque identifier or null`, { proposal_id },
  );
  const confidence = spec.confidence ?? null;
  invariant(
    confidence === null || (typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1),
    'invalid_input', `proposal '${proposal_id}' confidence must be a number in [0,1] or null`, { proposal_id, confidence },
  );
  const requires_approval_claimed = spec.requires_approval_claimed ?? null;
  invariant(
    requires_approval_claimed === null || typeof requires_approval_claimed === 'boolean',
    'invalid_input', `proposal '${proposal_id}' requires_approval_claimed must be a boolean or null`, { proposal_id },
  );

  const opaque = (value, label) => {
    const v = value ?? null;
    invariant(
      v === null || (typeof v === 'string' && OPAQUE_ID_PATTERN.test(v)),
      'invalid_input', `proposal '${proposal_id}' ${label} must be a short opaque identifier or null`, { proposal_id },
    );
    return v;
  };

  const body = {
    schema: ACTION_PROPOSAL_SCHEMA,
    proposal_id,
    turn,
    capability: { key: capability.key, version: capability.version },
    operation,
    tool: { name: tool.name, version: tool.version },
    arguments: canonicalClone(args),
    reason: spec.reason,
    expected_outcome,
    evidence: builtEvidence,
    risk,
    side_effect,
    idempotency_key,
    confidence,
    requires_approval_claimed,
    correlation_id: opaque(spec.correlation_id, 'correlation_id'),
    causation_id: opaque(spec.causation_id, 'causation_id'),
  };

  return deepFreeze({ ...body, proposal_digest: digest(body) });
}

export function assertActionProposal(proposal, where = {}) {
  invariant(
    proposal !== null && typeof proposal === 'object' && !Array.isArray(proposal),
    'contract_violation', 'an action proposal must be an object', { ...where },
  );
  for (const key of ACTION_PROPOSAL_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(proposal, key),
      'contract_violation', `action proposal is missing '${key}'`, { ...where, key },
    );
  }
  const { proposal_digest, ...rest } = proposal;
  invariant(
    digest(rest) === proposal_digest,
    'contract_violation', `proposal '${proposal.proposal_id}' proposal_digest does not match its content`,
    { ...where, expected: digest(rest), actual: proposal_digest },
  );
  return proposal;
}

/**
 * parseActionProposal(value) -> { ok, proposal, reason, detail }
 *
 * The boundary a PLANNER's output crosses. Everything a model produces is
 * untrusted input, so a malformed proposal must be a normal, recorded outcome —
 * `planner_output_malformed` — and never an exception escaping into the harness
 * loop. Genuine wiring bugs (a non-KernelError thrown from inside) still
 * propagate.
 */
export function parseActionProposal(value) {
  if (value === null || value === undefined) {
    return deepFreeze({ ok: false, proposal: null, reason: 'planner_output_malformed', detail: 'the planner produced nothing' });
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return deepFreeze({
      ok: false, proposal: null, reason: 'planner_output_malformed',
      detail: `the planner produced ${Array.isArray(value) ? 'an array' : typeof value}, not a proposal object`,
    });
  }
  try {
    const proposal = value.proposal_digest === undefined
      ? defineActionProposal(value)
      : assertActionProposal(value, { at: 'parseActionProposal' });
    return deepFreeze({ ok: true, proposal, reason: null, detail: null });
  } catch (e) {
    if (!isKernelError(e)) throw e;
    return deepFreeze({
      ok: false, proposal: null, reason: 'planner_output_malformed', detail: String(e.message ?? e),
    });
  }
}

/**
 * bindingDigest({ proposal, org_id, agent_id, agent_version, capability_version,
 *                 tool_version })
 *   -> the AUTHORIZATION MATERIAL digest an approval binds to.
 *
 * Deliberately NOT `proposal_digest`. A proposal carries fields that are
 * commentary — the planner's reason, its confidence, its expected outcome — and
 * an approval that broke when the planner reworded its explanation would train
 * operators to re-approve reflexively. What an approver is agreeing to is:
 *
 *     this tenant, this agent version, this capability version, this operation,
 *     this tool version, and THESE arguments, exactly.
 *
 * Change any of those and the approval no longer covers what is about to happen
 * — which is what `approval_binding_mismatch` means. The RESOLVED versions are
 * used, not the requested ranges, so an approval granted while `^1.0.0` resolved
 * to 1.0.0 does not silently cover 1.1.0 after a redeploy.
 */
export function bindingDigest({
  proposal, org_id, agent_id, agent_version, capability_version, tool_version,
} = {}) {
  invariant(proposal !== null && proposal !== undefined, 'invalid_input', 'bindingDigest needs a proposal', {});
  return digest({
    schema: 'awe.approval_binding/v1',
    org_id: org_id ?? null,
    agent_id: agent_id ?? null,
    agent_version: agent_version ?? null,
    capability_key: proposal.capability.key,
    capability_version: capability_version ?? null,
    operation: proposal.operation,
    tool: proposal.tool.name,
    tool_version: tool_version ?? null,
    arguments: canonicalClone(proposal.arguments),
  });
}
