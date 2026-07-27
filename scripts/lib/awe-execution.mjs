// ---------------------------------------------------------------------------
// awe-execution.mjs — the two real workflows, executed through the shared
// kernel scaffolding.
//
// `prepareOutbound()` (B3) and `classify()` (B2) each already do the right
// thing; what they did not do was SAY it the same way. One returned
// `{ok, status, blocked_reason, persist, draft, routing, draft_key, events,
// audit}`, the other returned a fifteen-key result object with `fail_closed`,
// `hallucinated_fields` and `verify` as flags a caller had to remember to read.
// Nothing generic could consume both, and "did this run refuse, and why?" had a
// different answer per workflow.
//
// These adapters do not reimplement either engine. They call it, and translate
// the result into the kernel outcome envelope, with:
//
//   * a machine-readable code on every path — `blocked_reason` from the
//     registered platform vocabulary, or `error.code` from the kernel taxonomy.
//     No caller ever branches on a human-readable message; those are carried as
//     `detail` and are for people.
//   * standardized events — kernel audit envelopes, redacted and
//     content-addressed, rather than bare event-type strings.
//   * correlation — `run_id`, `workflow_id`, `org_id`, `trace_id` on the
//     envelope's meta and on every event.
//   * no credentials, no raw message bodies and no extracted personal data in
//     anything an event or a report carries.
//
// Both engines keep their existing signatures and behaviour: Runner 4 still
// calls `prepareOutbound()` and Runner 2A still calls `classify()`, unchanged.
//
// OFFLINE by construction: this module reaches no network and opens no database.
// `classify()`'s database access is injected by the caller (`deps.db`), which is
// what lets the classification path be exercised without credentials.
// ---------------------------------------------------------------------------

import {
  assertExecutionContext, assertNoEvents, blocked, createEvent, createExecutionContext,
  deriveRunId, failed, fromError, runMetadata, succeeded,
} from '../../packages/awe-kernel/src/index.mjs';

import { BLOCKED_REASONS, MESSAGE_TYPES } from './approval-matrix.mjs';
import { classify, expectedEvent, normalizeEmail } from './classification.mjs';
import { prepareOutbound } from './outbound-draft.mjs';
import { reasons as platformReasons } from './awe-reasons.mjs';

export const OUTBOUND_WORKFLOW = 'outbound_draft';
export const CLASSIFY_WORKFLOW = 'classify_email';

// Events no drafting or classification run may ever produce. Asserted
// mechanically on every outcome rather than left to review.
export const FORBIDDEN_EVENTS = ['message.approved', 'message.sent'];

// --- shared helpers ----------------------------------------------------------

// Build an execution context for a workflow run. `run_id` is derived from the
// request when the caller does not supply one, so an offline replay of the same
// request is the same run and lands on the same artifact path.
export function contextFor(workflow_id, request, {
  run_id = null, org_id = null, mode = 'TEST', is_fixture = true,
  actor = 'service', started_at = null, trace_id = null, attributes = {},
} = {}) {
  return createExecutionContext({
    run_id: run_id ?? deriveRunId({ workflow_id, inputs: request }),
    workflow_id,
    org_id,
    actor,
    mode,
    is_fixture,
    started_at,
    trace_id,
    attributes,
  });
}

// Correlation is part of the outcome contract, not something only `runWorkflow`
// adds: an adapter called directly must still say which run it belongs to.
function metaFor(context, extra = {}) {
  return { ...extra, ...runMetadata(context) };
}

function invalid(context, message, detail) {
  return failed('invalid_input', message, {
    audit: [{ step: 'validate_request', ok: false, detail }],
    meta: metaFor(context),
  });
}

// A context that is not an execution context is a wiring bug in the caller. It
// is still reported as an envelope rather than thrown, so a worker driving these
// adapters has exactly one shape to handle on every path.
function badContext(e) {
  return failed('invalid_input', `execution context is invalid: ${e?.message ?? e}`, {
    audit: [{ step: 'validate_context', ok: false, detail: null }],
  });
}

// --- B3: outbound drafting ---------------------------------------------------

// Request-level validation, before the engine sees anything. These are caller
// mistakes, not workflow refusals, so they are `failed('invalid_input')` and not
// a blocked reason: a blocked run is a correct run, a malformed request is not.
function validateOutboundRequest(request) {
  if (request === null || typeof request !== 'object') return 'request must be an object';
  if (!Array.isArray(request.policies)) return 'policies must be an array of matrix rows';
  if (typeof request.messageType !== 'string' || request.messageType.length === 0) {
    return 'messageType is required';
  }
  if (!MESSAGE_TYPES.includes(request.messageType)) {
    return `messageType '${request.messageType}' is not a known outbound message type`;
  }
  const key = request.workRequestKey ?? request.context?.work_request_key;
  if (typeof key !== 'string' || key.length === 0) return 'workRequestKey is required';
  return null;
}

// What an outbound event may carry: routing and status, never the subject, the
// body, or the recipient. The draft itself lives in `outbound_messages` under
// RLS; an audit event is a control-plane record, not a second copy of the mail.
function outboundEventPayload(result) {
  return {
    message_type: result.draft?.message_type ?? null,
    draft_status: result.draft?.status ?? null,
    persist: result.persist,
    mode: result.mode,
    blocked_reason: result.blocked_reason,
    routing_path: result.routing?.routing_path ?? null,
    approver_role: result.routing?.approver_role ?? null,
    escalated: result.routing?.escalated ?? false,
    policy_mode: result.routing?.policy_mode ?? null,
    effective_mode: result.routing?.effective_mode ?? null,
    recipient_count: (result.draft?.to_addrs ?? []).length,
  };
}

// The draft's shape and routing, without its content. A report proves WHICH
// draft was produced and how it was routed; reading the draft is a database
// read against the row, under the policies that govern it.
function outboundSummary(result) {
  return {
    draft_key: result.draft_key,
    status: result.status,
    persist: result.persist,
    message_type: result.draft?.message_type ?? null,
    requires_human_approval: result.draft?.requires_human_approval ?? null,
    send_capability: result.draft?.send_capability ?? false,
    routing_path: result.routing?.routing_path ?? null,
    approver_role: result.routing?.approver_role ?? null,
    escalated: result.routing?.escalated ?? false,
    effective_mode: result.routing?.effective_mode ?? null,
    recipient_count: (result.draft?.to_addrs ?? []).length,
  };
}

/**
 * executeOutbound(request, context) -> outcome envelope
 *
 * Success   -> ok      + `message.draft_created` (+ `message.escalated`)
 * Refusal   -> blocked + the engine's registered reason (+ `message.blocked`)
 * Bad input -> failed('invalid_input')
 * Anything unexpected -> failed(<kernel code>) via fromError
 */
export function executeOutbound(request, context) {
  try { assertExecutionContext(context, { at: 'executeOutbound' }); } catch (e) { return badContext(e); }

  const problem = validateOutboundRequest(request);
  if (problem !== null) return invalid(context, `outbound request rejected: ${problem}`, problem);

  try {
    const result = prepareOutbound(request);

    const events = (result.events ?? []).map((type) => createEvent({
      event_type: type,
      entity_type: 'outbound_message',
      entity_id: result.draft_key,
      org_id: context.org_id,
      occurred_at: context.started_at,
      payload: outboundEventPayload(result),
    }));

    const common = {
      events,
      audit: result.audit ?? [],
      meta: metaFor(context, { engine: 'prepare_outbound' }),
    };

    const outcome = result.ok
      ? succeeded(outboundSummary(result), common)
      // The engine's vocabulary is checked against the platform union HERE, at
      // the boundary: a reason that is not registered can never leave this
      // module as a blocked outcome.
      : blocked(result.blocked_reason, { ...common, reasons: platformReasons });

    // Structural proof, on every single run, that drafting produced no approval
    // and no send. Automation has zero approval authority; this is where that
    // stops being a claim about the source.
    return assertNoEvents(outcome, FORBIDDEN_EVENTS, { workflow: OUTBOUND_WORKFLOW });
  } catch (e) {
    return fromError(e, {
      audit: [{ step: 'execute', ok: false, detail: 'prepare_outbound threw' }],
      meta: metaFor(context),
    });
  }
}

// --- B2: classification ------------------------------------------------------

function validateClassifyRequest(email, adapter) {
  if (email === null || typeof email !== 'object') return 'email must be a normalized email object';
  if (typeof email.fullText !== 'function') return 'email must be normalized with normalizeEmail()';
  if (typeof email.fixture_name !== 'string' || email.fixture_name.length === 0) {
    return 'email.fixture_name is required for correlation';
  }
  if (adapter === null || adapter === undefined || typeof adapter.classify !== 'function') {
    return 'a model adapter with classify() is required';
  }
  return null;
}

// Classification touches customer names, phone numbers and addresses. None of
// them belong in an audit event: the event records WHAT was decided and on what
// evidence, and the extracted values live on the work_request row. Only the
// field NAMES that were populated are recorded, which is what a groundedness
// review actually needs.
function classifyEventPayload(result) {
  const extracted = result.extracted ?? {};
  return {
    fixture: result.fixture,
    prompt_version: result.prompt_version,
    classification: result.classification,
    status: result.status,
    urgency: result.urgency,
    emergency: result.emergency,
    keyword_net: result.keyword_net,
    model_emergency: result.model_emergency,
    confidence: result.confidence,
    property_type: extracted.property_type ?? null,
    extracted_fields: Object.entries(extracted)
      .filter(([field, value]) => field !== 'property_type' && value !== null && value !== undefined && value !== '')
      .map(([field]) => field)
      .sort(),
    hallucinated_fields: [...(result.hallucinated_fields ?? [])].sort(),
    missing_info: result.missing_info,
    duplicate_of: result.duplicate_of ?? null,
    fail_closed: result.fail_closed,
    model_calls: result.telemetry?.calls ?? null,
    retries: result.telemetry?.retries ?? null,
  };
}

function classifySummary(result) {
  const payload = classifyEventPayload(result);
  return {
    ...payload,
    persisted: result.persisted !== null && result.persisted !== undefined,
    work_request_id: result.persisted?.work_request_id ?? null,
    verify_ok: result.verify?.ok ?? null,
    verify_checks: result.verify?.checks ?? null,
  };
}

// The audit trail of the decisions classify() made, as gate decisions, so the
// run report shows the same fail-closed ladder for classification that it shows
// for drafting.
function classifyGateTrail(result, { persist }) {
  const trail = [
    { step: 'keyword_net', ok: true, detail: result.keyword_net ? 'emergency keyword matched' : 'no match' },
    { step: 'model_call', ok: !result.fail_closed, detail: `calls=${result.telemetry?.calls ?? '?'}` },
    { step: 'emergency_union', ok: true, detail: result.emergency ? 'emergency' : 'standard' },
    {
      step: 'groundedness',
      ok: (result.hallucinated_fields ?? []).length === 0,
      detail: (result.hallucinated_fields ?? []).join(', ') || null,
    },
    { step: 'derive_status', ok: true, detail: result.status },
  ];
  if (persist) {
    trail.push({ step: 'persist', ok: result.persisted !== null, detail: result.persisted?.work_request_id ?? null });
    trail.push({
      step: 'verify_write_back',
      ok: result.verify?.ok === true,
      detail: result.verify?.failures?.map((f) => f.id).join(', ') || null,
    });
  }
  return trail;
}

/**
 * executeClassification(email, { adapter, persist, db }, context) -> outcome
 *
 * Success       -> ok      + the event the Verify Step expects
 * Fail-closed   -> blocked('classification_fail_closed')
 * Ungrounded    -> blocked('ungrounded_extraction')
 * Unverified    -> failed('verify_failed')      — a claimed write that did not land
 * Bad input     -> failed('invalid_input')
 * Anything else -> failed(<kernel code>) via fromError
 *
 * Refusal order is by severity, not by convenience: an unverified write is the
 * loudest signal there is, so it outranks a fail-closed model result even though
 * both are true of the same run.
 */
export async function executeClassification(email, { adapter, persist = false, db = undefined } = {}, context) {
  try { assertExecutionContext(context, { at: 'executeClassification' }); } catch (e) { return badContext(e); }

  const problem = validateClassifyRequest(email, adapter);
  if (problem !== null) return invalid(context, `classification request rejected: ${problem}`, problem);

  let result;
  try {
    result = await classify(email, { adapter, persist, ...(db === undefined ? {} : { db }) });
  } catch (e) {
    return fromError(e, {
      audit: [{ step: 'execute', ok: false, detail: 'classify threw' }],
      meta: metaFor(context),
    });
  }

  try {
    const event = createEvent({
      event_type: expectedEvent(result.emergency, result.duplicate_of, result.status, result.classification),
      entity_type: 'work_request',
      entity_id: result.persisted?.work_request_id ?? null,
      org_id: context.org_id ?? result.persisted?.org_id ?? null,
      occurred_at: context.started_at,
      payload: classifyEventPayload(result),
    });

    const common = {
      events: [event],
      audit: classifyGateTrail(result, { persist }),
      verify: result.verify ?? null,
      meta: metaFor(context, {
        engine: 'classify',
        prompt_version: result.prompt_version,
        adapter: result.telemetry?.adapter ?? null,
      }),
    };

    if (persist && result.verify?.ok !== true) {
      const failedChecks = Object.entries(result.verify?.checks ?? {})
        .filter(([, passed]) => passed !== true).map(([id]) => id);
      return failed(
        'verify_failed',
        `classification write-back could not be verified (${failedChecks.join(', ') || 'no verify result'})`,
        common,
      );
    }
    if (result.fail_closed) {
      return blocked('classification_fail_closed', { ...common, reasons: platformReasons });
    }
    if ((result.hallucinated_fields ?? []).length > 0) {
      return blocked('ungrounded_extraction', { ...common, reasons: platformReasons });
    }
    return assertNoEvents(succeeded(classifySummary(result), common), FORBIDDEN_EVENTS, { workflow: CLASSIFY_WORKFLOW });
  } catch (e) {
    return fromError(e, {
      audit: [{ step: 'envelope', ok: false, detail: 'outcome could not be built' }],
      meta: metaFor(context),
    });
  }
}

export { BLOCKED_REASONS, normalizeEmail };
