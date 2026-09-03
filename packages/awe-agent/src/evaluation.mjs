// ---------------------------------------------------------------------------
// evaluation.mjs — the evaluation record, and the promotion boundary.
//
// "The agent learns from its mistakes" is, in a governed system, two completely
// separate things, and this file is the wall between them:
//
//   MEASUREMENT   an Evaluation Record: what one run did, against deterministic
//                 checks, policy compliance, tool-use correctness, approval
//                 correctness, cost and a scored outcome. Immutable, digest-
//                 pinned, evidence-carrying. It CHANGES NOTHING.
//
//   CHANGE        an Improvement Candidate: a PROPOSAL to alter a prompt, an
//                 agent definition, a policy, a capability, a tool, a context
//                 strategy, a memory retrieval rule or a model configuration.
//                 It is created in status `proposed` and there is no path in
//                 this module that creates one in any other status.
//
// THE FOUR RULES THAT KEEP "SELF-IMPROVEMENT" FROM MEANING "SELF-MODIFICATION":
//
//   1. A candidate cannot be created without at least one evaluation record
//      digest as evidence. An opinion is not a candidate.
//   2. Review requires `actor: 'human'`. This is doctrine G4 — automation
//      approves nothing — applied to the improvement path, and it is checked
//      first, before anything else about the candidate is examined.
//   3. Promotion produces a NEW AGENT DEFINITION VERSION IN STATUS `draft`, and
//      the produced document is returned to the caller. It does not touch a
//      registry (registries are immutable once built), it does not touch the
//      definition it derived from, and it cannot produce an `active` document —
//      `defineAgentDefinition` is called with `status: 'draft'` unconditionally
//      and `status` is refused as a proposed change.
//   4. Activation is a separate, human, out-of-band act
//      (`activateAgentDefinition`) followed by a redeploy that builds a new
//      registry. Nothing in the harness imports either.
//
// So the full loop is: run → evaluate → propose → review → promote to draft →
// activate → deploy. Six steps, three of which require a named human, and none
// of which the agent can perform.
//
// ROLLBACK stays possible because nothing is ever replaced: the previous version
// is still registered, still resolvable, and still the one a pinned caller gets.
//
// PURE: no clock (instants are arguments), no randomness, no I/O.
// ---------------------------------------------------------------------------

import { deepFreeze, digest, invariant, isInstant } from './kernel.mjs';
import { AGENT_DEFINITION_KEYS, defineAgentDefinition } from './agent-definition.mjs';

export const EVALUATION_RECORD_SCHEMA = 'awe.evaluation_record/v1';
export const IMPROVEMENT_CANDIDATE_SCHEMA = 'awe.improvement_candidate/v1';

export const EVALUATION_RECORD_KEYS = [
  'schema', 'evaluation_id', 'run_id', 'org_id', 'agent_id', 'agent_version',
  'definition_digest', 'task_type', 'input_digest', 'rubric', 'expected_ref',
  'actual_ref', 'deterministic_checks', 'policy_compliance', 'tool_use_correct',
  'approval_correct', 'outcome_score', 'failure_class', 'latency_ms', 'turns',
  'steps', 'tool_calls', 'planner', 'evaluator', 'evaluator_version', 'evidence',
  'recommendation', 'evaluated_at', 'evaluation_digest',
];

/**
 * How a run failed, if it did. A closed vocabulary, because "what kind of thing
 * went wrong" is the axis an improvement is chosen along, and free text there
 * makes a hundred runs uncomparable.
 */
export const FAILURE_CLASSES = [
  'none',
  'policy_denied',
  'budget_exhausted',
  'planner_malformed',
  'planner_unavailable',
  'tool_failure',
  'approval_rejected',
  'contract_unmet',
  'cancelled',
  'timed_out',
  'infrastructure',
];

export const CANDIDATE_KINDS = [
  'prompt',
  'agent_definition',
  'policy',
  'capability',
  'tool',
  'context_strategy',
  'memory_retrieval',
  'model_configuration',
];

export const CANDIDATE_STATUSES = ['proposed', 'accepted', 'rejected', 'promoted'];

const CANDIDATE_KEYS = [
  'schema', 'candidate_id', 'kind', 'status', 'agent_id', 'base_version',
  'target_version', 'title', 'rationale', 'proposed_changes', 'evidence',
  'proposed_by', 'proposed_at', 'reviewed_by', 'reviewed_at', 'review_note',
  'candidate_digest',
];

// Fields of an agent definition a candidate may NEVER propose to change.
// `status` and `provenance` are the governance record itself — a candidate that
// could set them could promote itself; `agent_id` because changing it makes the
// document a different agent wearing an old agent's history.
const IMMUTABLE_FIELDS = ['schema', 'agent_id', 'status', 'provenance', 'definition_digest', 'version'];

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function assertClosedKeys(value, allowed, label) {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input', `${label} must be a plain object`, { label },
  );
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  invariant(
    unknown.length === 0,
    'invalid_input', `${label} has unknown key(s) ${JSON.stringify(unknown.sort())}`, { label, unknown: unknown.sort() },
  );
}

// --- the evaluation record ---------------------------------------------------

export function createEvaluationRecord({
  evaluation_id, run_id, org_id = null, agent_id, agent_version, definition_digest = null,
  task_type = null, input_digest = null, rubric = null, expected_ref = null, actual_ref = null,
  deterministic_checks = [], policy_compliance = null, tool_use_correct = null,
  approval_correct = null, outcome_score = null, failure_class = 'none', latency_ms = null,
  turns = null, steps = null, tool_calls = null, planner = null, evaluator, evaluator_version,
  evidence = [], recommendation = null, evaluated_at = null,
} = {}) {
  invariant(
    typeof evaluation_id === 'string' && OPAQUE_ID_PATTERN.test(evaluation_id),
    'invalid_input', 'an evaluation record needs an identifier', { evaluation_id },
  );
  invariant(typeof run_id === 'string' && run_id.length > 0, 'invalid_input', 'an evaluation record names the run it evaluated', {});
  invariant(typeof agent_id === 'string' && ID_PATTERN.test(agent_id), 'invalid_input', 'an evaluation record names the agent', { agent_id });
  invariant(
    typeof agent_version === 'string' && SEMVER_PATTERN.test(agent_version),
    'invalid_input', 'an evaluation record names the exact agent VERSION it evaluated', { agent_version },
  );
  // An evaluator without a version produces scores nobody can compare across
  // time, and an incomparable score is not evidence.
  invariant(
    typeof evaluator === 'string' && ID_PATTERN.test(evaluator),
    'invalid_input', 'an evaluation record names its evaluator', { evaluator },
  );
  invariant(
    typeof evaluator_version === 'string' && SEMVER_PATTERN.test(evaluator_version),
    'invalid_input', `evaluator '${evaluator}' must state its version`, { evaluator_version },
  );
  invariant(
    FAILURE_CLASSES.includes(failure_class),
    'invalid_input', `failure_class '${failure_class}' is unknown`, { failure_class, known: FAILURE_CLASSES },
  );
  invariant(
    outcome_score === null || (typeof outcome_score === 'number' && Number.isFinite(outcome_score) && outcome_score >= 0 && outcome_score <= 1),
    'invalid_input', 'outcome_score must be a number in [0,1] or null', { outcome_score },
  );
  invariant(
    evaluated_at === null || isInstant(evaluated_at),
    'invalid_input', 'evaluated_at must be an ISO-8601 instant or null', { evaluated_at },
  );
  invariant(Array.isArray(deterministic_checks), 'invalid_input', 'deterministic_checks must be an array', {});
  invariant(Array.isArray(evidence), 'invalid_input', 'evaluation evidence must be an array', {});

  const body = {
    schema: EVALUATION_RECORD_SCHEMA,
    evaluation_id,
    run_id,
    org_id,
    agent_id,
    agent_version,
    definition_digest,
    task_type,
    input_digest,
    rubric,
    expected_ref,
    actual_ref,
    deterministic_checks: deterministic_checks.map((c) => ({
      id: c.id ?? null, ok: c.ok === true, detail: c.detail ?? null,
    })),
    policy_compliance,
    tool_use_correct,
    approval_correct,
    outcome_score,
    failure_class,
    latency_ms,
    turns,
    steps,
    tool_calls,
    planner,
    evaluator,
    evaluator_version,
    evidence: [...evidence],
    recommendation,
    evaluated_at,
  };
  return deepFreeze({ ...body, evaluation_digest: digest(body) });
}

export function assertEvaluationRecord(record, where = {}) {
  invariant(
    record !== null && typeof record === 'object' && !Array.isArray(record),
    'contract_violation', 'an evaluation record must be an object', { ...where },
  );
  for (const key of EVALUATION_RECORD_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(record, key),
      'contract_violation', `evaluation record is missing '${key}'`, { ...where, key },
    );
  }
  const { evaluation_digest, ...rest } = record;
  invariant(
    digest(rest) === evaluation_digest,
    'contract_violation', 'evaluation record digest does not match its content', { ...where },
  );
  return record;
}

/**
 * defineEvaluator({ id, version, rubric, checks })
 *
 * The evaluation PORT. `checks` is a list of `{ id, run(view) -> { ok, detail } }`
 * deterministic assertions over a completed run's own record — its journal
 * projection, its decisions, its results. Deterministic checks are the primary
 * correctness gate; the score is a summary of them, never a substitute.
 *
 * A model-backed evaluator would be another implementation of this same port.
 * Nothing here calls one, and a score it produced would still be a measurement
 * with no power to change anything.
 */
export function defineEvaluator({ id, version = '1.0.0', rubric = null, checks = [] } = {}) {
  invariant(typeof id === 'string' && ID_PATTERN.test(id), 'invalid_input', `evaluator id '${id}' must be snake_case`, { id });
  invariant(
    typeof version === 'string' && SEMVER_PATTERN.test(version),
    'invalid_input', `evaluator '${id}' version '${version}' must be a pinned semver`, { id, version },
  );
  invariant(Array.isArray(checks), 'invalid_input', `evaluator '${id}' checks must be an array`, { id });
  checks.forEach((check) => invariant(
    typeof check?.id === 'string' && typeof check?.run === 'function',
    'invalid_input', `evaluator '${id}' checks must be { id, run }`, { id },
  ));

  /**
   * evaluate(view) -> Evaluation Record
   *
   * `view` is the harness's own account of the run. The evaluator receives it as
   * DATA and returns a record; it is handed no dispatcher, no registry and no
   * definition it could alter.
   */
  function evaluate(view = {}) {
    const results = checks.map((check) => {
      let verdict;
      try { verdict = check.run(view); } catch (e) {
        // An evaluator that throws marks its own check failed rather than
        // failing the run: measurement must never be able to change an outcome.
        verdict = { ok: false, detail: `check threw: ${String(e?.message ?? e)}` };
      }
      return { id: check.id, ok: verdict?.ok === true, detail: verdict?.detail ?? null };
    });
    const passed = results.filter((r) => r.ok).length;

    return createEvaluationRecord({
      evaluation_id: `eval-${digest({ run_id: view.run_id, evaluator: id, version }, { length: 16 })}`,
      run_id: view.run_id,
      org_id: view.org_id ?? null,
      agent_id: view.agent_id,
      agent_version: view.agent_version,
      definition_digest: view.definition_digest ?? null,
      task_type: view.task_type ?? null,
      input_digest: view.input_digest ?? null,
      rubric,
      expected_ref: view.expected_ref ?? null,
      actual_ref: view.actual_ref ?? null,
      deterministic_checks: results,
      policy_compliance: view.policy_compliance ?? null,
      tool_use_correct: view.tool_use_correct ?? null,
      approval_correct: view.approval_correct ?? null,
      // The score is derived from the deterministic checks, not asserted beside
      // them: a number that could disagree with the checks it summarizes is the
      // definition of a fake evaluation score.
      outcome_score: results.length === 0 ? null : passed / results.length,
      failure_class: view.failure_class ?? 'none',
      latency_ms: view.latency_ms ?? null,
      turns: view.turns ?? null,
      steps: view.steps ?? null,
      tool_calls: view.tool_calls ?? null,
      planner: view.planner ?? null,
      evaluator: id,
      evaluator_version: version,
      evidence: view.evidence ?? [],
      recommendation: view.recommendation ?? null,
      evaluated_at: view.evaluated_at ?? null,
    });
  }

  return Object.freeze({
    descriptor: deepFreeze({ id, version, rubric, checks: checks.map((c) => c.id).sort() }),
    evaluate,
  });
}

// --- improvement candidates --------------------------------------------------

/**
 * proposeImprovement({ … }) -> a candidate in status `proposed`
 *
 * There is no `status` parameter. A candidate is born proposed and gets to any
 * other status only through `reviewCandidate`, which requires a human.
 */
export function proposeImprovement({
  candidate_id, kind, agent_id, base_version, target_version = null, title,
  rationale, proposed_changes = {}, evidence = [], proposed_by = null, proposed_at = null,
} = {}) {
  invariant(
    typeof candidate_id === 'string' && OPAQUE_ID_PATTERN.test(candidate_id),
    'invalid_input', 'an improvement candidate needs an identifier', { candidate_id },
  );
  invariant(
    CANDIDATE_KINDS.includes(kind),
    'invalid_input', `improvement kind '${kind}' is unknown`, { kind, known: CANDIDATE_KINDS },
  );
  invariant(typeof agent_id === 'string' && ID_PATTERN.test(agent_id), 'invalid_input', 'a candidate names the agent it is about', { agent_id });
  invariant(
    typeof base_version === 'string' && SEMVER_PATTERN.test(base_version),
    'invalid_input', 'a candidate names the exact agent version it is derived from', { base_version },
  );
  invariant(
    target_version === null || SEMVER_PATTERN.test(target_version),
    'invalid_input', 'a candidate target_version must be a pinned semver or null', { target_version },
  );
  invariant(typeof title === 'string' && title.length > 0, 'invalid_input', 'a candidate needs a title', {});
  invariant(typeof rationale === 'string' && rationale.length > 0, 'invalid_input', 'a candidate needs a rationale', {});
  invariant(
    proposed_changes !== null && typeof proposed_changes === 'object' && !Array.isArray(proposed_changes),
    'invalid_input', 'proposed_changes must be a plain object', {},
  );

  // RULE 1: evidence or nothing. A candidate with no evaluation behind it is an
  // opinion, and an opinion that can enter a promotion pipeline is how an
  // unmeasured change reaches production wearing the clothes of a measured one.
  invariant(
    Array.isArray(evidence) && evidence.length > 0,
    'invalid_input',
    'an improvement candidate must cite at least one evaluation record — evaluation_evidence_missing',
    { candidate_id },
  );

  // A candidate may not propose to change the governance record itself.
  const forbidden = Object.keys(proposed_changes).filter((k) => IMMUTABLE_FIELDS.includes(k));
  invariant(
    forbidden.length === 0,
    'invalid_input',
    `a candidate may not propose changes to ${JSON.stringify(forbidden.sort())} — status, provenance and identity are set by the review that promotes it, never by the thing being reviewed`,
    { candidate_id, forbidden: forbidden.sort() },
  );
  const unknownFields = Object.keys(proposed_changes)
    .filter((k) => !AGENT_DEFINITION_KEYS.includes(k) && kind === 'agent_definition');
  invariant(
    unknownFields.length === 0,
    'invalid_input',
    `an agent_definition candidate proposes unknown field(s) ${JSON.stringify(unknownFields.sort())}`,
    { candidate_id },
  );
  invariant(
    proposed_at === null || isInstant(proposed_at),
    'invalid_input', 'proposed_at must be an ISO-8601 instant or null', { proposed_at },
  );

  const body = {
    schema: IMPROVEMENT_CANDIDATE_SCHEMA,
    candidate_id,
    kind,
    status: 'proposed',
    agent_id,
    base_version,
    target_version,
    title,
    rationale,
    proposed_changes: { ...proposed_changes },
    evidence: [...evidence],
    proposed_by,
    proposed_at,
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
  };
  return deepFreeze({ ...body, candidate_digest: digest(body) });
}

export function assertImprovementCandidate(candidate, where = {}) {
  invariant(
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate),
    'contract_violation', 'an improvement candidate must be an object', { ...where },
  );
  assertClosedKeys(candidate, CANDIDATE_KEYS, 'improvement candidate');
  const { candidate_digest, ...rest } = candidate;
  invariant(
    digest(rest) === candidate_digest,
    'contract_violation', 'improvement candidate digest does not match its content', { ...where },
  );
  invariant(
    CANDIDATE_STATUSES.includes(candidate.status),
    'contract_violation', `improvement candidate status '${candidate.status}' is unknown`, { ...where },
  );
  return candidate;
}

/**
 * reviewCandidate({ candidate, decision, actor, reviewer, reviewed_at, note })
 *   -> { ok, reason, detail, candidate }
 *
 * RULE 2. `actor !== 'human'` is refused FIRST, before the candidate is even
 * examined — the same ordering `policy.mjs` gives doctrine G4 and the same
 * ordering `control-plane-service.decideApproval` gives it, so an automated
 * caller learns nothing about the candidate by asking.
 */
export function reviewCandidate({
  candidate, decision = null, actor = 'human', reviewer = null, reviewed_at = null, note = null,
} = {}) {
  const no = (reason, detail) => deepFreeze({ ok: false, reason, detail, candidate: null });

  if (actor !== 'human') {
    return no(
      'promotion_reviewer_invalid',
      `reviewing an improvement candidate requires actor 'human'; automation may never review its own proposed changes (got '${actor}')`,
    );
  }
  if (typeof reviewer !== 'string' || reviewer.length === 0) {
    return no('promotion_reviewer_invalid', 'a review must name the person making it');
  }
  if (decision !== 'accept' && decision !== 'reject') {
    return no('candidate_activation_refused', `review decision '${decision}' must be 'accept' or 'reject'`);
  }
  assertImprovementCandidate(candidate, { at: 'reviewCandidate' });
  if (candidate.status !== 'proposed') {
    return no('candidate_activation_refused', `candidate '${candidate.candidate_id}' is '${candidate.status}' and has already been reviewed`);
  }

  const { candidate_digest, ...rest } = candidate;
  const body = {
    ...rest,
    status: decision === 'accept' ? 'accepted' : 'rejected',
    reviewed_by: reviewer,
    reviewed_at,
    review_note: note,
  };
  return deepFreeze({
    ok: true, reason: null, detail: null,
    candidate: deepFreeze({ ...body, candidate_digest: digest(body) }),
  });
}

/**
 * promoteCandidate({ candidate, definition, actor, reviewer, next_version,
 *                    created_at })
 *   -> { ok, reason, detail, definition }
 *
 * RULE 3. The output is a NEW agent definition version in status `draft`. Read
 * the `defineAgentDefinition` call below: `status: 'draft'` is a literal, not a
 * parameter, so there is no argument anyone can pass to this function that
 * produces an executable agent. Activating the draft is
 * `activateAgentDefinition` — a different function, in a different module,
 * requiring two named humans and two instants — followed by a redeploy that
 * constructs a new registry.
 *
 * The base definition is not modified, and no registry is touched. Rollback is
 * therefore automatic: the previous version is still registered and still what a
 * pinned caller resolves.
 */
export function promoteCandidate({
  candidate, definition, actor = 'human', reviewer = null, next_version = null, created_at = null,
} = {}) {
  const no = (reason, detail) => deepFreeze({ ok: false, reason, detail, definition: null });

  if (actor !== 'human') {
    return no(
      'promotion_reviewer_invalid',
      `promotion requires actor 'human'; automation may never promote a change to itself (got '${actor}')`,
    );
  }
  if (typeof reviewer !== 'string' || reviewer.length === 0) {
    return no('promotion_reviewer_invalid', 'a promotion must name the person performing it');
  }
  assertImprovementCandidate(candidate, { at: 'promoteCandidate' });
  if (candidate.status !== 'accepted') {
    return no(
      'candidate_activation_refused',
      `candidate '${candidate.candidate_id}' is '${candidate.status}'; only a candidate a human has ACCEPTED may be promoted`,
    );
  }
  if (definition === null || definition === undefined) {
    return no('candidate_activation_refused', 'promotion needs the base agent definition');
  }
  if (definition.agent_id !== candidate.agent_id || definition.version !== candidate.base_version) {
    return no(
      'candidate_activation_refused',
      `candidate '${candidate.candidate_id}' is derived from '${candidate.agent_id}' v${candidate.base_version}, not '${definition.agent_id}' v${definition.version}`,
    );
  }

  const version = next_version ?? candidate.target_version;
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    return no('candidate_activation_refused', 'promotion needs the new pinned version the change will be published as');
  }
  if (version === definition.version) {
    return no(
      'candidate_activation_refused',
      `promotion must publish a NEW version; v${version} is the version being changed, and editing a published version in place is what versioning exists to prevent`,
    );
  }

  const { schema, definition_digest, ...base } = definition;
  let drafted;
  try {
    drafted = defineAgentDefinition({
      ...base,
      ...candidate.proposed_changes,
      version,
      // Literal, not a parameter. This is the promotion boundary.
      status: 'draft',
      provenance: {
        created_at,
        created_by: reviewer,
        approved_at: null,
        approved_by: null,
        activated_at: null,
        activated_by: null,
        source_ref: candidate.candidate_id,
        supersedes: definition.version,
      },
    });
  } catch (e) {
    return no('candidate_activation_refused', `the promoted definition is not valid: ${String(e?.message ?? e)}`);
  }

  return deepFreeze({
    ok: true,
    reason: null,
    detail: null,
    definition: drafted,
    // Stated in the return value so a caller cannot mistake a draft for a
    // deployment. The next two acts are human and are not performed here.
    requires: ['activateAgentDefinition (a named human)', 'redeploy with a registry that includes this version'],
  });
}
