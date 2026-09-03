// ---------------------------------------------------------------------------
// planner.mjs — the Planning View, the Planner port, and the model boundary.
//
// This is the ONLY place where something that may be a model touches the
// platform, and it is deliberately a narrow, symmetric pipe:
//
//        harness ──buildPlanningView──▶ planner ──proposal──▶ harness
//                    (redacted)                    (untrusted)
//
// WHAT GOES IN. A Planning View is a closed document with a fixed key set. It
// carries the agent's own identity, the capability surface as NAMES and
// constraints, the assembled context with its trust and sensitivity labels
// intact, the observations of this run, the remaining budget, and the refusals
// that have already been recorded. `assertPlanningView` refuses an unknown key,
// so nothing can be smuggled in by an over-helpful composition.
//
// It carries NO tenant grant, NO policy engine, NO approval state, NO credential,
// NO connection string, NO environment, and NO handle to any executable thing.
// A planner is given the facts and the vocabulary; it is not given the
// machinery. Runner G asserts this structurally by scanning this module for the
// forbidden identifiers rather than by trusting the paragraph you are reading.
//
// WHAT COMES OUT. An Action Proposal — parsed as untrusted input, refused as
// `planner_output_malformed` when it is not one. A planner that returns null is
// proposing nothing, which is how a run ends without a final action.
//
// PROVIDER NEUTRALITY. There is no vendor name in this file and no HTTP client
// anywhere in this package. A model arrives as a PORT: an object with an
// `id`, a `version`, a `provider` label, a `model` label and a `complete()`
// function the composition supplies. Swapping providers is swapping an argument;
// the harness records which port answered, so a replay knows what produced the
// plan even though it does not re-run it.
//
// PURE: no clock, no randomness, no I/O. Everything impure is the injected port.
// ---------------------------------------------------------------------------

import { deepFreeze, digest, invariant, isKernelError } from './kernel.mjs';
import { parseActionProposal } from './proposal.mjs';

export const PLANNING_VIEW_SCHEMA = 'awe.planning_view/v1';

export const PLANNING_VIEW_KEYS = [
  'schema', 'run_id', 'org_id', 'turn', 'agent', 'objective', 'capabilities',
  'context', 'observations', 'refusals', 'budget_remaining', 'output_contract',
  'view_digest',
];

export const PLANNER_KINDS = ['deterministic', 'model'];

const PLANNER_DESCRIPTOR_KEYS = ['id', 'version', 'kind', 'provider', 'model', 'descriptor_digest'];

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * buildPlanningView({ … }) -> frozen Planning View
 *
 * Note what each argument is ALLOWED to be. `capabilities` are the compiled
 * surface's bindings — names, versions, operations, ceilings — never capability
 * objects with their policy references. `context` items keep their trust and
 * sensitivity labels because a planner that cannot tell a supplier's email from
 * its own tenant's policy cannot reason safely about either.
 */
export function buildPlanningView({
  run_id, org_id, turn, definition, surface, objective = {}, bundle = null,
  observations = [], refusals = [], budget_remaining = {},
} = {}) {
  invariant(typeof run_id === 'string' && run_id.length > 0, 'invalid_input', 'a planning view needs a run_id', {});
  invariant(typeof org_id === 'string' && org_id.length > 0, 'invalid_input', 'a planning view needs a tenant', {});
  invariant(Number.isInteger(turn) && turn >= 1, 'invalid_input', 'a planning view needs a turn number', { turn });
  invariant(definition !== null && definition !== undefined, 'invalid_input', 'a planning view needs an agent definition', {});
  invariant(surface !== null && surface !== undefined, 'invalid_input', 'a planning view needs a compiled surface', {});

  // One row per capability, with the tools it may reach. This IS the action
  // vocabulary: a planner cannot name anything that is not here and have it
  // authorized, so giving it anything less would only produce refusals.
  const byCapability = new Map();
  for (const binding of surface.bindings) {
    const row = byCapability.get(binding.capability_key) ?? {
      key: binding.capability_key,
      version: binding.capability_version,
      risk: binding.risk,
      requires_approval_at_or_above: binding.requires_approval_at_or_above,
      idempotency: binding.idempotency,
      audit: binding.audit,
      max_data_classification: binding.max_data_classification,
      operations: [],
      tools: [],
    };
    if (!row.operations.includes(binding.operation)) row.operations.push(binding.operation);
    if (!row.tools.some((t) => t.name === binding.tool && t.operation === binding.operation)) {
      row.tools.push({
        name: binding.tool,
        version: binding.capability_tool_version,
        operation: binding.operation,
        max_side_effect: binding.max_side_effect,
      });
    }
    byCapability.set(binding.capability_key, row);
  }
  const capabilities = [...byCapability.values()]
    .map((row) => ({
      ...row,
      operations: [...row.operations].sort(),
      tools: [...row.tools].sort((a, b) => (`${a.name}:${a.operation}` < `${b.name}:${b.operation}` ? -1 : 1)),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  // Context, with its labels. `trusted: false` is not decoration — it is the
  // statement that anything instruction-shaped inside `content` is DATA, and the
  // architecture behind that statement is that the planner has no way to act on
  // an instruction except by proposing an action the runtime re-authorizes.
  const context = (bundle?.items ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    source: item.source,
    trusted: item.trusted,
    sensitivity: item.sensitivity,
    priority: item.priority,
    occurred_at: item.occurred_at,
    content: item.content,
    metadata: item.metadata,
  }));

  const body = {
    schema: PLANNING_VIEW_SCHEMA,
    run_id,
    org_id,
    turn,
    agent: {
      agent_id: definition.agent_id,
      version: definition.version,
      title: definition.title,
      purpose: definition.purpose,
      business_responsibility: definition.business_responsibility,
    },
    objective: objective ?? {},
    capabilities,
    context,
    observations: (observations ?? []).map((o) => ({
      ref: o.ref,
      turn: o.turn ?? null,
      capability: o.capability ?? null,
      operation: o.operation ?? null,
      tool: o.tool ?? null,
      ok: o.ok === true,
      data: o.data ?? null,
      // Untrusted by construction: a tool result is an observation about the
      // world, and the world can contain text that would like to be an
      // instruction.
      trusted: false,
    })),
    refusals: (refusals ?? []).map((r) => ({
      proposal_id: r.proposal_id ?? null,
      reason: r.reason ?? null,
      detail: r.detail ?? null,
    })),
    budget_remaining: { ...budget_remaining },
    output_contract: definition.output_contract,
  };

  return deepFreeze({ ...body, view_digest: digest(body) });
}

export function assertPlanningView(view, where = {}) {
  invariant(
    view !== null && typeof view === 'object' && !Array.isArray(view),
    'contract_violation', 'a planning view must be an object', { ...where },
  );
  const unknown = Object.keys(view).filter((k) => !PLANNING_VIEW_KEYS.includes(k));
  invariant(
    unknown.length === 0,
    'contract_violation',
    `planning view has key(s) ${JSON.stringify(unknown.sort())} outside the closed set — a planner is handed facts, never machinery`,
    { ...where, unknown: unknown.sort() },
  );
  for (const key of PLANNING_VIEW_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(view, key),
      'contract_violation', `planning view is missing '${key}'`, { ...where, key },
    );
  }
  const { view_digest, ...rest } = view;
  invariant(
    digest(rest) === view_digest,
    'contract_violation', 'planning view digest does not match its content', { ...where },
  );
  return view;
}

// --- the planner port --------------------------------------------------------

/**
 * definePlanner({ id, version, kind, provider, model, plan })
 *
 * `plan(view) -> proposal spec | null`. The descriptor is data (and is recorded
 * in the journal); the function is held beside it, never inside it, so a
 * descriptor stays serializable and its digest stays stable across
 * implementations — the same split `defineTool` makes.
 */
export function definePlanner({
  id, version = '1.0.0', kind = 'deterministic', provider = null, model = null, plan,
} = {}) {
  invariant(
    typeof id === 'string' && ID_PATTERN.test(id),
    'invalid_input', `planner id '${id}' must be snake_case`, { id },
  );
  invariant(
    typeof version === 'string' && SEMVER_PATTERN.test(version),
    'invalid_input', `planner '${id}' version '${version}' must be a pinned semver`, { id, version },
  );
  invariant(
    PLANNER_KINDS.includes(kind),
    'invalid_input', `planner '${id}' kind '${kind}' must be one of ${PLANNER_KINDS.join('|')}`, { id, kind },
  );
  invariant(typeof plan === 'function', 'invalid_input', `planner '${id}' needs a plan() function`, { id });
  invariant(
    provider === null || (typeof provider === 'string' && ID_PATTERN.test(provider)),
    'invalid_input', `planner '${id}' provider must be snake_case or null`, { id },
  );
  invariant(
    kind !== 'model' || provider !== null,
    'invalid_input', `planner '${id}' is a model planner and must name its provider`, { id },
  );

  const body = { id, version, kind, provider, model: model ?? null };
  const descriptor = deepFreeze({ ...body, descriptor_digest: digest(body) });
  return Object.freeze({ descriptor, plan });
}

export function assertPlanner(planner, where = {}) {
  invariant(
    planner !== null && typeof planner === 'object',
    'contract_violation', 'a planner must be an object', { ...where },
  );
  invariant(typeof planner.plan === 'function', 'contract_violation', 'a planner must expose plan()', { ...where });
  const descriptor = planner.descriptor ?? null;
  invariant(descriptor !== null, 'contract_violation', 'a planner must carry a descriptor', { ...where });
  for (const key of PLANNER_DESCRIPTOR_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(descriptor, key),
      'contract_violation', `planner descriptor is missing '${key}'`, { ...where, key },
    );
  }
  return planner;
}

/**
 * runPlanner({ planner, view, proposal_id }) -> { ok, proposal, reason, detail, planner }
 *
 * The one call that crosses the model boundary. It never throws for a planner's
 * own misbehaviour, because a planner IS an untrusted component:
 *
 *   returns null                  -> ok: true, proposal: null  ("nothing to do")
 *   returns junk                  -> planner_output_malformed
 *   throws                        -> planner_unavailable  (an infrastructure
 *                                    failure, distinct from a domain refusal —
 *                                    the same distinction StoreUnavailableError
 *                                    draws one layer down)
 *
 * `proposal_id` is supplied by the HARNESS, derived from the run and the turn.
 * A planner that could choose its own proposal ids could collide two proposals
 * onto one approval.
 */
export async function runPlanner({ planner, view, proposal_id = null } = {}) {
  assertPlanner(planner, { at: 'runPlanner' });
  assertPlanningView(view, { at: 'runPlanner' });

  const descriptor = planner.descriptor;
  const answer = (fields) => deepFreeze({
    ok: false, proposal: null, reason: null, detail: null, planner: descriptor, ...fields,
  });

  let produced;
  try {
    produced = await planner.plan(view);
  } catch (e) {
    if (isKernelError(e)) {
      return answer({ reason: 'planner_output_malformed', detail: String(e.message ?? e) });
    }
    return answer({
      reason: 'planner_unavailable',
      detail: `planner '${descriptor.id}' failed: ${String(e?.message ?? e)}`,
    });
  }

  if (produced === null || produced === undefined) {
    return deepFreeze({ ok: true, proposal: null, reason: null, detail: null, planner: descriptor });
  }

  // The id is stamped by the caller, over whatever the planner said, so two
  // planners cannot produce the same id and one planner cannot reuse another
  // turn's.
  const stamped = proposal_id === null || typeof produced !== 'object' || Array.isArray(produced)
    ? produced
    : { ...produced, proposal_id, turn: view.turn };
  const parsed = parseActionProposal(stamped);
  if (!parsed.ok) return answer({ reason: parsed.reason, detail: parsed.detail });

  return deepFreeze({ ok: true, proposal: parsed.proposal, reason: null, detail: null, planner: descriptor });
}

// --- the deterministic planner ----------------------------------------------

/**
 * defineDeterministicPlanner({ id, version, decide })
 *
 * A first-class production planner, not a test double. Many business decisions
 * are rules, and a rules planner is cheaper, faster, replayable and auditable in
 * a way no model is. It is also what lets the entire governed plane be tested
 * without a provider, a key or a network — which is why the reference agent
 * ships with one.
 *
 * `decide(view) -> proposal spec | null` must be a pure function of the view.
 */
export function defineDeterministicPlanner({ id, version = '1.0.0', decide } = {}) {
  invariant(typeof decide === 'function', 'invalid_input', `deterministic planner '${id}' needs a decide() function`, { id });
  return definePlanner({ id, version, kind: 'deterministic', plan: (view) => decide(view) });
}

// --- the model boundary ------------------------------------------------------

/**
 * defineModelPort({ id, version, provider, model, complete })
 *
 * The provider seam. `complete({ view, max_output_tokens }) -> { content }`.
 *
 * Note what is NOT here: no base URL, no key, no retry policy, no token
 * accounting, no vendor. A composition supplies an object with this shape and
 * this package neither knows nor can discover what is behind it.
 */
export function defineModelPort({ id, version = '1.0.0', provider, model, complete } = {}) {
  invariant(
    typeof id === 'string' && ID_PATTERN.test(id),
    'invalid_input', `model port id '${id}' must be snake_case`, { id },
  );
  invariant(
    typeof provider === 'string' && ID_PATTERN.test(provider),
    'invalid_input', `model port '${id}' must name its provider in snake_case`, { id, provider },
  );
  invariant(
    typeof model === 'string' && model.length > 0,
    'invalid_input', `model port '${id}' must name the model it reaches`, { id },
  );
  invariant(typeof complete === 'function', 'invalid_input', `model port '${id}' needs a complete() function`, { id });
  const body = { id, version, provider, model };
  return Object.freeze({
    descriptor: deepFreeze({ ...body, descriptor_digest: digest(body) }),
    complete,
  });
}

/**
 * createModelPlanner({ id, version, port, parse, max_output_tokens })
 *
 * Wraps a model port as a planner. `parse` turns the port's answer into a
 * proposal spec and defaults to strict JSON: a model that produces prose where a
 * proposal was asked for is `planner_output_malformed`, which is a recorded
 * refusal and not a crash.
 *
 * The wrapper adds NOTHING to the model's authority. Whatever comes back walks
 * the identical path a deterministic planner's output walks — parsed as
 * untrusted, authorized from scratch, and refused by the same five narrowings.
 */
export function createModelPlanner({
  id, version = '1.0.0', port, parse = null, max_output_tokens = null,
} = {}) {
  invariant(port !== null && port !== undefined, 'invalid_input', `model planner '${id}' needs a model port`, { id });
  const descriptor = port.descriptor;
  const parseAnswer = parse ?? ((content) => {
    if (typeof content !== 'string') return content;
    try { return JSON.parse(content); } catch { return { malformed: content.slice(0, 200) }; }
  });

  return definePlanner({
    id,
    version,
    kind: 'model',
    provider: descriptor.provider,
    model: descriptor.model,
    async plan(view) {
      const answer = await port.complete({ view, max_output_tokens });
      const content = answer?.content ?? null;
      if (content === null) return null;
      return parseAnswer(content);
    },
  });
}
