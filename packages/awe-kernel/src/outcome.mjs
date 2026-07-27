// ---------------------------------------------------------------------------
// outcome.mjs — the Workflow Outcome envelope.
//
// Every workflow in AWE already returns "did it work / what did it produce /
// why did it refuse / what did it emit / what did I verify" — but each one
// invents its own key names for it, so nothing generic can consume two
// workflows. This is that shape, once:
//
//   { ok, status, blocked_reason, error, data, events, audit, verify, meta }
//
// `audit` is the ordered trail of gate decisions. Each entry is either a plain
// non-empty string (a note) or a gate decision `{ step|gate, ok, detail }` — the
// shape `prepareOutbound()` already produces. Both are accepted because both are
// already in use, and the run report normalizes them into one table.
//
// Three statuses, and the difference matters operationally:
//   ok      — the workflow did what it was asked to do.
//   blocked — the workflow REFUSED, deliberately, with a registered reason.
//             This is the fail-closed path and it is a normal outcome, not an
//             error: a blocked run is a correct run.
//   failed  — something broke. Unexpected, and never a substitute for blocked.
//
// Envelopes come back deep-frozen: an audit trail that a later stage can edit
// is not an audit trail.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { deepFreeze } from './canonical.mjs';
import { ERROR_CODES, invariant } from './errors.mjs';
import { assertEvent } from './events.mjs';

export const OUTCOME_STATUSES = ['ok', 'blocked', 'failed'];
export const OUTCOME_KEYS = [
  'ok', 'status', 'blocked_reason', 'error', 'data', 'events', 'audit', 'verify', 'meta',
];

// An audit entry is a note (non-empty string) or a gate decision naming the gate
// it records. Anything else is a trail nobody can read back.
function isAuditEntry(entry) {
  if (typeof entry === 'string') return entry.length > 0;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const gate = entry.gate ?? entry.step;
  return typeof gate === 'string' && gate.length > 0;
}

function build({ status, blocked_reason = null, error = null, data = null, events = [], audit = [], verify = null, meta = {} }) {
  invariant(OUTCOME_STATUSES.includes(status), 'invalid_input', `unknown outcome status '${status}'`, { status });
  invariant(Array.isArray(events), 'invalid_input', 'events must be an array', { status });
  invariant(Array.isArray(audit), 'invalid_input', 'audit must be an array', { status });
  events.forEach((e, i) => assertEvent(e, { index: i, status }));
  audit.forEach((line, i) => invariant(
    isAuditEntry(line),
    'invalid_input', `audit[${i}] must be a non-empty string or a { step, ok, detail } gate decision`, { line },
  ));

  return deepFreeze({
    ok: status === 'ok',
    status,
    blocked_reason,
    error,
    data,
    events: [...events],
    audit: [...audit],
    verify,
    meta: { ...meta },
  });
}

// The workflow did its job.
export function succeeded(data, opts = {}) {
  return build({ ...opts, status: 'ok', data, blocked_reason: null, error: null });
}

// The workflow refused, on purpose, with a reason from a registered vocabulary.
// Pass the registry to have membership enforced here instead of three layers
// later in a SQL constraint.
export function blocked(reason, opts = {}) {
  const { reasons, ...rest } = opts;
  invariant(typeof reason === 'string' && reason.length > 0, 'invalid_input', 'blocked() requires a reason', { reason });
  if (reasons) reasons.assert(reason, { at: 'outcome.blocked' });
  return build({ ...rest, status: 'blocked', blocked_reason: reason, error: null });
}

// Something broke. Codes come from the kernel taxonomy so failures stay
// classifiable across workflows.
export function failed(code, message, opts = {}) {
  invariant(ERROR_CODES.includes(code), 'invalid_input', `unknown error code '${code}'`, { code, known: ERROR_CODES });
  invariant(typeof message === 'string' && message.length > 0, 'invalid_input', 'failed() requires a message', { code });
  return build({ ...opts, status: 'failed', blocked_reason: null, error: { code, message } });
}

// Turn a thrown value into an envelope, so a workflow boundary never leaks a
// raw exception into a caller that expects an outcome.
export function fromError(e, opts = {}) {
  const code = ERROR_CODES.includes(e?.code) ? e.code : 'contract_violation';
  return failed(code, String(e?.message ?? e), {
    ...opts,
    meta: { ...(opts.meta ?? {}), error_details: e?.details ?? null },
  });
}

export function createOutcome(spec) {
  return build(spec);
}

// Full contract check. Used by gate runs on every case, and cheap enough to use
// at a workflow boundary in production.
export function assertOutcome(outcome, { reasons, context = {} } = {}) {
  invariant(
    outcome !== null && typeof outcome === 'object' && !Array.isArray(outcome),
    'contract_violation', 'outcome must be an object', { ...context, outcome },
  );
  for (const key of OUTCOME_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(outcome, key),
      'contract_violation', `outcome is missing '${key}'`, { ...context, key },
    );
  }
  invariant(
    OUTCOME_STATUSES.includes(outcome.status),
    'contract_violation', `unknown outcome status '${outcome.status}'`, { ...context, status: outcome.status },
  );
  invariant(
    outcome.ok === (outcome.status === 'ok'),
    'contract_violation', `ok=${outcome.ok} contradicts status='${outcome.status}'`, { ...context },
  );
  invariant(
    (outcome.blocked_reason !== null) === (outcome.status === 'blocked'),
    'contract_violation',
    `blocked_reason must be set iff status is 'blocked' (status='${outcome.status}', reason=${JSON.stringify(outcome.blocked_reason)})`,
    { ...context },
  );
  invariant(
    (outcome.error !== null) === (outcome.status === 'failed'),
    'contract_violation', `error must be set iff status is 'failed' (status='${outcome.status}')`, { ...context },
  );
  if (outcome.status === 'failed') {
    invariant(
      ERROR_CODES.includes(outcome.error.code),
      'contract_violation', `unknown error code '${outcome.error.code}'`, { ...context },
    );
  }
  if (reasons && outcome.blocked_reason !== null) {
    reasons.assert(outcome.blocked_reason, { ...context, at: 'assertOutcome' });
  }
  invariant(Array.isArray(outcome.events), 'contract_violation', 'events must be an array', { ...context });
  outcome.events.forEach((e, i) => assertEvent(e, { ...context, index: i }));
  invariant(Array.isArray(outcome.audit), 'contract_violation', 'audit must be an array', { ...context });
  outcome.audit.forEach((line, i) => invariant(
    isAuditEntry(line),
    'contract_violation', `audit[${i}] is not a readable trail entry`, { ...context, index: i },
  ));
  return outcome;
}

// Reusable negative guard: prove an outcome did NOT emit an event type. This is
// how "no send path exists" is asserted mechanically rather than by reading the
// source and hoping.
export function assertNoEvents(outcome, forbiddenTypes, context = {}) {
  const forbidden = new Set(forbiddenTypes);
  const found = (outcome.events ?? []).map((e) => e.event_type).filter((t) => forbidden.has(t));
  invariant(
    found.length === 0,
    'contract_violation', `outcome emitted forbidden event type(s): ${found.join(', ')}`,
    { ...context, found },
  );
  return outcome;
}
