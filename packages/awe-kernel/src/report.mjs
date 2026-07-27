// ---------------------------------------------------------------------------
// report.mjs — the durable Run Report artifact.
//
// A run that leaves nothing behind cannot be reviewed, and "check the terminal
// scrollback" is not an audit trail. This is the one shape every AWE run
// serializes to: what ran, for whom, what it decided, which gates it passed,
// which audit events it produced, and how it ended.
//
// Three properties the schema is built around:
//
//   stable    — `schema: 'awe.run_report/v1'`. Consumers pin the version; a
//               breaking change is v2, never a silent reshape.
//   sanitized — every string in the report passes through the same redaction
//               the audit events use, and the workflow's own output is recorded
//               as a DIGEST, not a body. A run report is a control-plane record;
//               customer email bodies, drafts and extracted personal data stay
//               in the tables that already hold them under RLS.
//   determinstic — same inputs, byte-identical JSON, and a `report_digest` over
//               everything but itself. Two runs that agree produce one file.
//
// PURE: no clock, no randomness, no I/O. Times are supplied by the caller; the
// path is computed, not created.
// ---------------------------------------------------------------------------

import { canonicalClone, canonicalJson, deepFreeze, digest } from './canonical.mjs';
import { assertExecutionContext, runMetadata } from './context.mjs';
import { ERROR_CODES, invariant } from './errors.mjs';
import { instantDate, isInstant, redact } from './events.mjs';
import { OUTCOME_STATUSES, assertOutcome } from './outcome.mjs';

export const REPORT_SCHEMA = 'awe.run_report/v1';

export const REPORT_KEYS = [
  'schema', 'run_id', 'workflow_id', 'org_id', 'actor', 'mode', 'is_fixture',
  'trace_id', 'started_at', 'finished_at', 'status', 'ok', 'blocked_reason',
  'error', 'gate_decisions', 'audit_events', 'audit_log', 'data_digest',
  'summary', 'final_state', 'report_digest',
];

// How a run ended, in one word, for an operator scanning a directory.
// 'incomplete' is the honest answer when the workflow finished but its durable
// record did not: never report a run as completed on the strength of a write
// that failed.
export const FINAL_STATES = ['completed', 'blocked', 'failed', 'incomplete'];

export function finalStateFor(status, { persisted = true } = {}) {
  invariant(OUTCOME_STATUSES.includes(status), 'invalid_input', `unknown outcome status '${status}'`, { status });
  if (!persisted) return 'incomplete';
  return { ok: 'completed', blocked: 'blocked', failed: 'failed' }[status];
}

// A gate decision is one line of the fail-closed trail: which gate, did it pass,
// and the short detail a human needs to understand a refusal. The two shapes
// this repo already produces — `{step, ok, detail}` objects (prepareOutbound)
// and plain strings (the kernel's `audit` array) — both normalize to this.
function normalizeGateDecisions(audit) {
  if (!Array.isArray(audit)) return [];
  return audit.map((entry, i) => {
    if (typeof entry === 'string') {
      return { seq: i + 1, gate: entry, ok: true, detail: null };
    }
    invariant(
      entry !== null && typeof entry === 'object',
      'invalid_input', `gate decision ${i} must be a string or an object`, { index: i },
    );
    const gate = entry.gate ?? entry.step;
    invariant(
      typeof gate === 'string' && gate.length > 0,
      'invalid_input', `gate decision ${i} must name a gate`, { index: i, entry },
    );
    return {
      seq: i + 1,
      gate,
      ok: entry.ok !== false,
      detail: entry.detail === undefined || entry.detail === null ? null : String(entry.detail),
    };
  });
}

// Errors are recorded as a code plus a bounded message. The code is the machine
// contract; the message is for a human and is truncated so a stack trace or a
// dumped request body cannot ride into the artifact.
const MAX_ERROR_MESSAGE = 500;

function sanitizeError(error) {
  if (error === null || error === undefined) return null;
  invariant(
    ERROR_CODES.includes(error.code),
    'invalid_input', `report error code '${error.code}' is not in the kernel taxonomy`, { code: error.code },
  );
  const message = String(error.message ?? '');
  return {
    code: error.code,
    message: message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}…` : message,
  };
}

/**
 * buildReport({ context, outcome, finished_at, summary, persisted })
 *
 * `outcome` is a kernel outcome envelope; `context` an execution context. The
 * workflow's `data` is never copied in — only its digest, which is enough to
 * prove two runs produced the same result without republishing the result.
 * `summary` is the caller's optional, deliberately-chosen, redacted detail.
 */
export function buildReport({
  context,
  outcome,
  finished_at = null,
  summary = null,
  persisted = true,
} = {}) {
  assertExecutionContext(context, { at: 'buildReport' });
  assertOutcome(outcome, { context: { at: 'buildReport' } });
  invariant(
    finished_at === null || isInstant(finished_at),
    'invalid_input', `finished_at must be an ISO-8601 instant or null, got '${finished_at}'`, { finished_at },
  );

  const meta = runMetadata(context);
  const body = {
    schema: REPORT_SCHEMA,
    ...meta,
    started_at: context.started_at,
    finished_at,
    status: outcome.status,
    ok: outcome.ok,
    blocked_reason: outcome.blocked_reason,
    error: sanitizeError(outcome.error),
    gate_decisions: normalizeGateDecisions(outcome.audit),
    // Events arrive already redacted and content-addressed from events.mjs.
    audit_events: canonicalClone(outcome.events ?? []),
    audit_log: (outcome.audit ?? []).filter((a) => typeof a === 'string'),
    // The result, provably, without the result itself.
    data_digest: outcome.data === null || outcome.data === undefined ? null : digest(outcome.data),
    summary: summary === null ? null : canonicalClone(redact(summary)),
    final_state: finalStateFor(outcome.status, { persisted }),
  };

  // Belt and braces: nothing credential-shaped survives, wherever it came from.
  const sanitized = redact(body);
  return deepFreeze({
    ...sanitized,
    report_digest: digest(sanitized),
  });
}

export function assertReport(report, where = {}) {
  invariant(
    report !== null && typeof report === 'object' && !Array.isArray(report),
    'contract_violation', 'run report must be an object', { ...where },
  );
  for (const key of REPORT_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(report, key),
      'contract_violation', `run report is missing '${key}'`, { ...where, key },
    );
  }
  invariant(
    report.schema === REPORT_SCHEMA,
    'contract_violation', `run report schema '${report.schema}' is not '${REPORT_SCHEMA}'`, { ...where },
  );
  invariant(
    FINAL_STATES.includes(report.final_state),
    'contract_violation', `unknown final state '${report.final_state}'`, { ...where },
  );
  const { report_digest, ...rest } = report;
  invariant(
    digest(rest) === report_digest,
    'contract_violation', 'report_digest does not match the report content',
    { ...where, expected: digest(rest), actual: report_digest },
  );
  return report;
}

// Predictable location: <workflow>/<date>/<run_id>.json. Partitioned by day so a
// directory listing stays readable, and keyed by run_id so a replay of the same
// run overwrites its own artifact instead of accumulating near-duplicates.
// Runs with no `started_at` land under 'undated' rather than being given a date
// the kernel would have had to invent.
export function reportPath(report, { extension = '.json' } = {}) {
  assertReport(report, { at: 'reportPath' });
  const date = report.started_at === null ? 'undated' : instantDate(report.started_at);
  return `${report.workflow_id}/${date}/${report.run_id}${extension}`;
}

// The bytes a sink stores. Canonical JSON with a trailing newline: stable across
// runs and machines, and diffable.
export function serializeReport(report) {
  assertReport(report, { at: 'serializeReport' });
  return `${canonicalJson(report)}\n`;
}
