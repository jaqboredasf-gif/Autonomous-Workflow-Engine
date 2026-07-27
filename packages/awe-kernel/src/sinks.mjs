// ---------------------------------------------------------------------------
// sinks.mjs — the neutral extension boundaries a run may plug into.
//
// Three interfaces, and nothing behind them:
//
//   ArtifactSink   — where a durable run report goes. First implementation is
//                    the local filesystem (scripts/lib/artifact-store.mjs);
//                    a Supabase table or an object store is the same interface.
//   AuditSink      — where sanitized audit events go. Today: memory, or a file
//                    alongside the report. Later: `integration_events`.
//   ContextProvider— where context items come from. Declares a name, a kind and
//                    a `load(context)`; it returns DATA and nothing else.
//
// Why interfaces and not implementations: the local filesystem is the first
// answer, not the permanent one, and the choice of database client is ADR-0002,
// which is unresolved. A sink is the seam that lets that decision be made later
// without rewriting every workflow.
//
// What is deliberately NOT here (ADR-0002 / Tool Registry are blocked): no
// capability grants, no tool permissions, no tenant policy, no registry
// behaviour. A sink accepts data and reports whether it landed. It authorizes
// nothing, and a ContextProvider grants no access it did not already have.
//
// Every sink reports its result as data (`{ ok, ... , error }`) and never throws
// on a failed write: a workflow that produced a correct outcome must not be
// turned into a crash by a full disk, but it must not be reported as durably
// recorded either. `runWorkflow` downgrades the run's final state instead.
//
// PURE: no clock, no randomness, no I/O. The memory implementations here are
// in-process only; every real sink lives outside the kernel.
// ---------------------------------------------------------------------------

import { canonicalClone } from './canonical.mjs';
import { invariant } from './errors.mjs';
import { assertEvent } from './events.mjs';

export const ARTIFACT_SINK_METHODS = ['write'];
export const AUDIT_SINK_METHODS = ['emit'];
export const CONTEXT_PROVIDER_METHODS = ['load'];

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

function validateNamed(impl, kindLabel) {
  invariant(
    impl !== null && typeof impl === 'object',
    'invalid_input', `${kindLabel} must be an object`, { impl: typeof impl },
  );
  invariant(
    typeof impl.name === 'string' && NAME_PATTERN.test(impl.name),
    'invalid_input', `${kindLabel} name '${impl?.name}' must be snake_case`, { name: impl?.name },
  );
}

function requireMethods(impl, methods, kindLabel) {
  for (const method of methods) {
    invariant(
      typeof impl[method] === 'function',
      'invalid_input', `${kindLabel} '${impl.name}' must implement ${method}()`, { name: impl.name, method },
    );
  }
}

// --- Artifact sink -----------------------------------------------------------
//
//   write(report, { path }) -> { ok, ref, error }   (may be async)
//
// `report` is a run report from report.mjs; `path` is the relative location the
// report asks for. `ref` is whatever identifies the stored artifact in that
// backend — a file path, a row id, an object key.

export function createArtifactSink(impl) {
  validateNamed(impl, 'artifact sink');
  requireMethods(impl, ARTIFACT_SINK_METHODS, 'artifact sink');
  return Object.freeze({
    kind: 'artifact_sink',
    name: impl.name,
    write: (report, options = {}) => impl.write(report, options),
  });
}

// In-process sink. The reference implementation the tests assert against, and
// the sink an unattended dry-run uses when it must produce a report without
// touching a disk.
export function memoryArtifactSink({ name = 'memory' } = {}) {
  const written = new Map();
  return Object.freeze({
    ...createArtifactSink({
      name,
      write(report, { path } = {}) {
        const ref = path ?? report.run_id;
        // Cloned through the canonical form: a caller cannot mutate a stored
        // artifact through the object it handed in.
        written.set(ref, canonicalClone(report));
        return { ok: true, ref, error: null };
      },
    }),
    list() { return [...written.keys()].sort(); },
    read(ref) { return written.get(ref) ?? null; },
    get size() { return written.size; },
  });
}

// Accepts everything, keeps nothing. For a run that is explicitly not to be
// recorded — never as a silent default.
export function nullArtifactSink({ name = 'discard' } = {}) {
  return createArtifactSink({
    name,
    write(report) { return { ok: true, ref: null, error: null, discarded: report.run_id }; },
  });
}

// --- Audit sink --------------------------------------------------------------
//
//   emit(events, context) -> { ok, written, error }   (may be async)
//
// `events` are kernel event envelopes — already redacted and content-addressed,
// so a sink never has to know how to sanitize.

export function createAuditSink(impl) {
  validateNamed(impl, 'audit sink');
  requireMethods(impl, AUDIT_SINK_METHODS, 'audit sink');
  return Object.freeze({
    kind: 'audit_sink',
    name: impl.name,
    emit: (events, context) => {
      invariant(Array.isArray(events), 'invalid_input', `audit sink '${impl.name}' takes an array of events`, {});
      events.forEach((e, i) => assertEvent(e, { sink: impl.name, index: i }));
      return impl.emit(events, context);
    },
  });
}

export function memoryAuditSink({ name = 'memory' } = {}) {
  const seen = [];
  const keys = new Set();
  return Object.freeze({
    ...createAuditSink({
      name,
      emit(events) {
        let written = 0;
        let deduped = 0;
        for (const event of events) {
          // Content-addressed idempotency, applied at the sink: re-emitting the
          // same logical event is detected here rather than in the database.
          if (keys.has(event.event_key)) { deduped += 1; continue; }
          keys.add(event.event_key);
          seen.push(event);
          written += 1;
        }
        return { ok: true, written, deduped, error: null };
      },
    }),
    events() { return Object.freeze([...seen]); },
    eventKeys() { return [...keys].sort(); },
  });
}

// --- Context provider --------------------------------------------------------
//
//   load(context) -> ContextItem[]   (may be async)
//
// A provider supplies FACTS for a run. It is introduced here only as a shape:
// it names itself, declares the kind of item it produces, and returns data.
// It carries no authority and decides no policy, so introducing it settles
// nothing that ADR-0002 or the Tool Registry still has to decide.

export const CONTEXT_ITEM_KINDS = [
  'domain_facts', 'workflow_state', 'tool_result', 'policy',
  'human_decision', 'untrusted_content', 'derived_summary',
];

export function defineContextProvider(impl) {
  validateNamed(impl, 'context provider');
  requireMethods(impl, CONTEXT_PROVIDER_METHODS, 'context provider');
  invariant(
    CONTEXT_ITEM_KINDS.includes(impl.kind),
    'invalid_input', `context provider '${impl.name}' has unknown kind '${impl.kind}'`,
    { name: impl.name, kind: impl.kind, known: CONTEXT_ITEM_KINDS },
  );
  // Trust is a property of the SOURCE, declared once here, so a later consumer
  // never has to guess whether a body came from a customer email or a policy row.
  invariant(
    typeof impl.trusted === 'boolean',
    'invalid_input', `context provider '${impl.name}' must declare trusted: true|false`, { name: impl.name },
  );
  return Object.freeze({
    kind: 'context_provider',
    name: impl.name,
    item_kind: impl.kind,
    trusted: impl.trusted,
    load: (context) => impl.load(context),
  });
}
