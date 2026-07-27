// ---------------------------------------------------------------------------
// context.mjs — the Execution Context and the Run Metadata contract.
//
// Everything that executes in AWE — a runner, a web route, an MCP tool, a future
// unattended worker — needs the same small set of facts before it may do
// anything: which tenant, which run, which workflow, on whose authority, in
// which mode, and by when. Today each entry point invents its own bag of
// arguments, so nothing generic can be written against "a run".
//
// This is that bag, once, validated and frozen:
//
//   { run_id, workflow_id, org_id, actor, mode, is_fixture,
//     started_at, deadline_at, trace_id, attributes }
//
// What this module deliberately does NOT do (ADR-0002 is unresolved and this
// module must not pre-empt it): it grants nothing. There is no capability list,
// no tool permission, no role check, no tenant policy and no database handle
// here. A context says WHO and WHICH; it never says MAY. Authorization stays
// where it already lives (the approval matrix, the RPCs, the RLS policies) until
// the Tool Registry is unblocked.
//
// PURE: no clock, no randomness, no I/O. `started_at` is supplied by the caller
// — a fixture can pin it, which is what keeps a run replayable.
// ---------------------------------------------------------------------------

import { deepFreeze, digest } from './canonical.mjs';
import { invariant } from './errors.mjs';
import { isInstant, redact } from './events.mjs';

// The run metadata contract: the keys any consumer of a run may rely on.
export const RUN_METADATA_KEYS = [
  'run_id', 'workflow_id', 'org_id', 'actor', 'mode', 'is_fixture',
  'started_at', 'deadline_at', 'trace_id', 'attributes',
];

// 'service' = automation acting on its own; 'human' = a person's action carried
// by the machine. The distinction is doctrine (automation approves nothing), so
// it is recorded on every run rather than inferred later from a log line.
export const ACTORS = ['service', 'human'];

// TEST is the fail-closed default everywhere in this repo (resolveMode(),
// resolveQueueMode()); a context that does not say is a TEST context.
export const RUN_MODES = ['TEST', 'LIVE'];

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Deterministic run id. Two runs over the same workflow and the same inputs get
// the same id on purpose: an offline replay is the same run, and an artifact
// written twice lands on the same path instead of accumulating near-duplicates.
// A caller that wants a unique-per-attempt id passes one in — the kernel will
// not read a clock or a random source to make one up.
export function deriveRunId({ workflow_id, inputs = null, salt = null }) {
  invariant(
    typeof workflow_id === 'string' && ID_PATTERN.test(workflow_id),
    'invalid_input', `workflow_id '${workflow_id}' must be snake_case`, { workflow_id },
  );
  return `${workflow_id}-${digest({ workflow_id, inputs, salt }, { length: 16 })}`;
}

export function createExecutionContext({
  run_id,
  workflow_id,
  org_id = null,
  actor = 'service',
  mode = 'TEST',
  is_fixture = true,
  started_at = null,
  deadline_at = null,
  trace_id = null,
  attributes = {},
} = {}) {
  invariant(
    typeof run_id === 'string' && RUN_ID_PATTERN.test(run_id),
    'invalid_input', `run_id '${run_id}' must be a short opaque identifier`, { run_id },
  );
  invariant(
    typeof workflow_id === 'string' && ID_PATTERN.test(workflow_id),
    'invalid_input', `workflow_id '${workflow_id}' must be snake_case`, { workflow_id },
  );
  // org_id may be null ONLY for a fixture run. A LIVE run with no tenant is the
  // exact shape of the MCP "first org" defect (ADR-0002 condition 1); refuse it
  // here rather than discovering it in a report six months later.
  invariant(
    org_id === null || (typeof org_id === 'string' && org_id.length > 0),
    'invalid_input', 'org_id must be a non-empty string or null', { org_id },
  );
  invariant(ACTORS.includes(actor), 'invalid_input', `actor '${actor}' must be one of ${ACTORS.join('|')}`, { actor });
  invariant(RUN_MODES.includes(mode), 'invalid_input', `mode '${mode}' must be one of ${RUN_MODES.join('|')}`, { mode });
  invariant(typeof is_fixture === 'boolean', 'invalid_input', 'is_fixture must be a boolean', { is_fixture });
  invariant(
    !(mode === 'LIVE' && org_id === null),
    'invalid_input', 'a LIVE run must name its tenant — org_id is required outside fixture mode', { mode },
  );
  invariant(
    !(mode === 'LIVE' && is_fixture === true),
    'invalid_input', 'is_fixture=true contradicts mode=LIVE', { mode, is_fixture },
  );
  invariant(
    started_at === null || isInstant(started_at),
    'invalid_input', `started_at must be an ISO-8601 instant or null, got '${started_at}'`, { started_at },
  );
  invariant(
    deadline_at === null || isInstant(deadline_at),
    'invalid_input', `deadline_at must be an ISO-8601 instant or null, got '${deadline_at}'`, { deadline_at },
  );
  invariant(
    trace_id === null || (typeof trace_id === 'string' && trace_id.length > 0),
    'invalid_input', 'trace_id must be a non-empty string or null', { trace_id },
  );
  invariant(
    attributes !== null && typeof attributes === 'object' && !Array.isArray(attributes),
    'invalid_input', 'attributes must be a plain object', { attributes },
  );

  return deepFreeze({
    run_id,
    workflow_id,
    org_id,
    actor,
    mode,
    is_fixture,
    started_at,
    deadline_at,
    trace_id,
    // Free-form run labels. Redacted on the way in: an operator who passes a
    // token here must not be able to leak it into every artifact this run writes.
    attributes: redact({ ...attributes }),
  });
}

export function assertExecutionContext(context, where = {}) {
  invariant(
    context !== null && typeof context === 'object' && !Array.isArray(context),
    'contract_violation', 'execution context must be an object', { ...where },
  );
  for (const key of RUN_METADATA_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(context, key),
      'contract_violation', `execution context is missing '${key}'`, { ...where, key },
    );
  }
  // Re-running construction is the check: anything createExecutionContext would
  // have refused is refused here too, so a hand-built context cannot slip past.
  createExecutionContext(context);
  return context;
}

// The subset that belongs on an outcome envelope's `meta` and on every event —
// enough to correlate a run across an outcome, an audit trail and an artifact,
// and nothing else.
export function runMetadata(context) {
  return Object.freeze({
    run_id: context.run_id,
    workflow_id: context.workflow_id,
    org_id: context.org_id,
    actor: context.actor,
    mode: context.mode,
    is_fixture: context.is_fixture,
    trace_id: context.trace_id,
  });
}
