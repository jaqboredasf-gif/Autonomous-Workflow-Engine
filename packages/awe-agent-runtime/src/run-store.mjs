import {
  assertOutcome, canonicalClone, invariant, isPlainObject,
} from '../../awe-kernel/src/index.mjs';
import { assertModelResponse } from './model.mjs';
import { verifyAgentTranscript } from './transcript.mjs';

export const AGENT_RUN_DOCUMENT_SCHEMA = 'awe.agent_run/v1';
export const AGENT_RUN_DOCUMENT_KEYS = [
  'schema', 'run_id', 'org_id', 'agent_id', 'transcript', 'model_records', 'outcome',
];

export function assertAgentRunDocument(document, where = {}) {
  invariant(isPlainObject(document), 'contract_violation', 'agent run document must be a plain object', where);
  for (const key of AGENT_RUN_DOCUMENT_KEYS) {
    invariant(Object.prototype.hasOwnProperty.call(document, key), 'contract_violation', `agent run document missing '${key}'`, where);
  }
  invariant(
    Object.keys(document).every((key) => AGENT_RUN_DOCUMENT_KEYS.includes(key)),
    'contract_violation', 'agent run document has unknown keys', where,
  );
  invariant(document.schema === AGENT_RUN_DOCUMENT_SCHEMA, 'contract_violation', 'agent run document schema is invalid', where);
  invariant(typeof document.run_id === 'string' && document.run_id.length > 0, 'contract_violation', 'agent run document needs run_id', where);
  invariant(document.org_id === null || typeof document.org_id === 'string', 'contract_violation', 'agent run document org_id is invalid', where);
  invariant(Array.isArray(document.model_records), 'contract_violation', 'agent run model_records must be an array', where);
  document.model_records.forEach((record, index) => {
    invariant(isPlainObject(record), 'contract_violation', `model record ${index} must be an object`, where);
    invariant(Object.keys(record).length === 2 && typeof record.request_digest === 'string', 'contract_violation', `model record ${index} shape is invalid`, where);
    assertModelResponse(record.response, { ...where, request_digest: record.request_digest, index });
  });
  assertOutcome(document.outcome, { context: where });
  verifyAgentTranscript(document.transcript, where);
  invariant(document.transcript.run_id === document.run_id && document.transcript.org_id === document.org_id, 'contract_violation', 'agent run/transcript identity mismatch', where);
  return document;
}

export function createMemoryAgentRunStore() {
  const records = new Map();
  return Object.freeze({
    kind: 'agent_run_store',
    name: 'memory',
    write(document) {
      assertAgentRunDocument(document, { at: 'agent_run_store.write' });
      records.set(document.run_id, canonicalClone(document));
      return { ok: true, ref: document.run_id, error: null };
    },
    read({ run_id, org_id } = {}) {
      invariant(typeof run_id === 'string' && run_id.length > 0, 'invalid_input', 'agent run store read needs run_id', {});
      const found = records.get(run_id);
      if (found === undefined || found.org_id !== org_id) return null;
      return canonicalClone(found);
    },
    list({ org_id } = {}) {
      invariant(typeof org_id === 'string' && org_id.length > 0, 'invalid_input', 'agent run store list needs org_id', {});
      return [...records.values()].filter((record) => record.org_id === org_id).map((record) => record.run_id).sort();
    },
  });
}

export function defineAgentRunStore(impl) {
  invariant(isPlainObject(impl), 'invalid_input', 'agent run store must be a plain object', {});
  invariant(typeof impl.name === 'string' && /^[a-z][a-z0-9_]*$/.test(impl.name), 'invalid_input', 'agent run store needs a snake_case name', {});
  for (const method of ['write', 'read', 'list']) invariant(typeof impl[method] === 'function', 'invalid_input', `agent run store '${impl.name}' needs ${method}()`, {});
  return Object.freeze({
    kind: 'agent_run_store',
    name: impl.name,
    write(document) {
      assertAgentRunDocument(document, { at: `agent_run_store:${impl.name}` });
      return impl.write(document);
    },
    read(request = {}) {
      invariant(isPlainObject(request), 'invalid_input', 'agent run store read request must be an object', {});
      invariant(typeof request.run_id === 'string' && request.run_id.length > 0, 'invalid_input', 'agent run store read needs run_id', {});
      invariant(typeof request.org_id === 'string' && request.org_id.length > 0, 'invalid_input', 'agent run store read needs org_id', {});
      return impl.read(request);
    },
    list(request = {}) {
      invariant(isPlainObject(request), 'invalid_input', 'agent run store list request must be an object', {});
      invariant(typeof request.org_id === 'string' && request.org_id.length > 0, 'invalid_input', 'agent run store list needs org_id', {});
      return impl.list(request);
    },
  });
}
