import {
  CONTEXT_ITEM_KINDS, CONTEXT_SENSITIVITIES, canonicalClone, createContextItem,
  deepFreeze, digest, invariant, isInstant, isPlainObject, instantEpochSeconds,
  redact,
} from './kernel.mjs';
import { assertMemoryRecord } from './record.mjs';

export const MEMORY_QUERY_SCHEMA = 'awe.memory_query/v1';
export const MEMORY_RETRIEVAL_SNAPSHOT_SCHEMA = 'awe.memory_retrieval_snapshot/v1';
export const MEMORY_RETRIEVAL_KINDS = ['lexical', 'vector'];
export const MEMORY_QUERY_KEYS = [
  'schema', 'query_id', 'memory_id', 'memory_version', 'org_id', 'text',
  'profile', 'limit', 'min_score', 'requested_at', 'query_digest',
];
export const MEMORY_RETRIEVAL_SNAPSHOT_KEYS = [
  'schema', 'query', 'manifest_digest', 'context', 'adapter', 'retrieved_at',
  'hits', 'snapshot_digest',
];

const ID = /^[a-z][a-z0-9_]*$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTEXT_KEYS = ['kind', 'source', 'trusted', 'priority', 'max_sensitivity'];
const ADAPTER_KEYS = ['profile', 'kind'];
const HIT_KEYS = ['rank', 'score', 'record'];

function closed(value, allowed, label, code = 'invalid_input') {
  invariant(isPlainObject(value), code, `${label} must be a plain object`, { label });
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  invariant(unknown.length === 0, code, `${label} has unknown key(s) ${JSON.stringify(unknown)}`, { label, unknown });
}

export function defineMemoryQuery(spec = {}) {
  closed(spec, MEMORY_QUERY_KEYS.filter((key) => key !== 'query_digest'), 'memory query');
  invariant(spec.schema === undefined || spec.schema === MEMORY_QUERY_SCHEMA, 'invalid_input', `memory query schema must be '${MEMORY_QUERY_SCHEMA}'`, {});
  invariant(typeof spec.query_id === 'string' && OPAQUE_ID.test(spec.query_id), 'invalid_input', 'memory query_id must be a short opaque identifier', {});
  invariant(typeof spec.memory_id === 'string' && ID.test(spec.memory_id), 'invalid_input', 'memory query memory_id must be snake_case', {});
  invariant(typeof spec.memory_version === 'string' && /^\d+\.\d+\.\d+$/.test(spec.memory_version), 'invalid_input', 'memory query version must be pinned semver', {});
  invariant(typeof spec.org_id === 'string' && spec.org_id.length > 0, 'invalid_input', 'memory query requires org_id', {});
  invariant(typeof spec.text === 'string' && spec.text.trim().length > 0 && spec.text.length <= 4000, 'invalid_input', 'memory query text must be 1..4000 characters', {});
  invariant(typeof spec.profile === 'string' && ID.test(spec.profile), 'invalid_input', 'memory query profile must be snake_case', {});
  invariant(Number.isInteger(spec.limit) && spec.limit >= 1 && spec.limit <= 100, 'invalid_input', 'memory query limit must be in [1,100]', {});
  invariant(typeof spec.min_score === 'number' && Number.isFinite(spec.min_score) && spec.min_score >= 0 && spec.min_score <= 1, 'invalid_input', 'memory query min_score must be in [0,1]', {});
  invariant(isInstant(spec.requested_at), 'invalid_input', 'memory query requested_at must be an ISO instant', {});
  const body = {
    schema: MEMORY_QUERY_SCHEMA,
    query_id: spec.query_id,
    memory_id: spec.memory_id,
    memory_version: spec.memory_version,
    org_id: spec.org_id,
    text: String(redact(spec.text)),
    profile: spec.profile,
    limit: spec.limit,
    min_score: spec.min_score,
    requested_at: spec.requested_at,
  };
  return deepFreeze({ ...body, query_digest: digest(body) });
}

export function assertMemoryQuery(query, where = {}) {
  closed(query, MEMORY_QUERY_KEYS, 'memory query', 'contract_violation');
  for (const key of MEMORY_QUERY_KEYS) invariant(Object.prototype.hasOwnProperty.call(query, key), 'contract_violation', `memory query is missing '${key}'`, { ...where, key });
  const { query_digest, ...input } = query;
  const rebuilt = defineMemoryQuery(input);
  invariant(rebuilt.query_digest === query_digest, 'contract_violation', 'memory query digest does not match its content', where);
  return query;
}

function validateRawHits(hits, candidates) {
  invariant(Array.isArray(hits), 'contract_violation', 'memory retrieval adapter must return an array', {});
  const candidateMap = new Map(candidates.map((record) => [`${record.record_id}\u0000${record.version}`, record]));
  const seen = new Set();
  return hits.map((hit, index) => {
    closed(hit, ['record_id', 'version', 'score'], `memory retrieval hit ${index}`, 'contract_violation');
    invariant(typeof hit.record_id === 'string' && hit.record_id.length > 0, 'contract_violation', 'memory retrieval hit needs record_id', { index });
    invariant(Number.isInteger(hit.version) && hit.version >= 1, 'contract_violation', 'memory retrieval hit needs a valid version', { index });
    invariant(typeof hit.score === 'number' && Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1, 'contract_violation', 'memory retrieval score must be in [0,1]', { index });
    const key = `${hit.record_id}\u0000${hit.version}`;
    invariant(candidateMap.has(key), 'contract_violation', `retrieval adapter returned unknown record '${hit.record_id}' v${hit.version}`, { index });
    invariant(!seen.has(key), 'contract_violation', `retrieval adapter returned duplicate record '${hit.record_id}' v${hit.version}`, { index });
    seen.add(key);
    return { record: candidateMap.get(key), score: hit.score };
  });
}

export function defineMemoryRetrievalAdapter(impl = {}) {
  invariant(isPlainObject(impl), 'invalid_input', 'memory retrieval adapter must be a plain object', {});
  invariant(typeof impl.profile === 'string' && ID.test(impl.profile), 'invalid_input', 'memory retrieval adapter profile must be snake_case', {});
  invariant(MEMORY_RETRIEVAL_KINDS.includes(impl.kind), 'invalid_input', `memory retrieval kind '${impl.kind}' is unknown`, {});
  invariant(typeof impl.search === 'function', 'invalid_input', `memory retrieval adapter '${impl.profile}' needs search()`, {});
  return Object.freeze({
    kind: impl.kind,
    profile: impl.profile,
    async search({ query, candidates }) {
      assertMemoryQuery(query, { at: `memory_retrieval:${impl.profile}` });
      invariant(Array.isArray(candidates), 'invalid_input', 'memory retrieval candidates must be an array', {});
      candidates.forEach((record) => assertMemoryRecord(record, { at: `memory_retrieval:${impl.profile}` }));
      const raw = await impl.search({ query, candidates: canonicalClone(candidates) });
      return validateRawHits(raw, candidates);
    },
  });
}

function terms(text) {
  return new Set(String(text).toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

export function createLexicalMemoryAdapter({ profile = 'lexical_default' } = {}) {
  return defineMemoryRetrievalAdapter({
    profile,
    kind: 'lexical',
    search({ query, candidates }) {
      const queryTerms = terms(query.text);
      return candidates.map((record) => {
        const recordTerms = terms(record.content);
        const overlap = [...queryTerms].filter((term) => recordTerms.has(term)).length;
        const score = queryTerms.size === 0 ? 0 : Number((overlap / queryTerms.size).toFixed(6));
        return { record_id: record.record_id, version: record.version, score };
      });
    },
  });
}

export function createMemoryRetrievalSnapshot({
  query, manifest_digest, context, adapter, retrieved_at, hits,
} = {}) {
  assertMemoryQuery(query, { at: 'createMemoryRetrievalSnapshot' });
  invariant(typeof manifest_digest === 'string' && manifest_digest.length > 0, 'invalid_input', 'memory snapshot requires manifest_digest', {});
  closed(context, CONTEXT_KEYS, 'memory snapshot context');
  invariant(CONTEXT_ITEM_KINDS.includes(context.kind), 'invalid_input', 'memory snapshot context kind is unknown', {});
  invariant(typeof context.source === 'string' && ID.test(context.source), 'invalid_input', 'memory snapshot context source is invalid', {});
  invariant(typeof context.trusted === 'boolean', 'invalid_input', 'memory snapshot context trusted must be boolean', {});
  invariant(Number.isInteger(context.priority) && context.priority >= 0 && context.priority <= 1000, 'invalid_input', 'memory snapshot context priority must be in [0,1000]', {});
  invariant(CONTEXT_SENSITIVITIES.includes(context.max_sensitivity), 'invalid_input', 'memory snapshot context sensitivity is unknown', {});
  closed(adapter, ADAPTER_KEYS, 'memory snapshot adapter');
  invariant(typeof adapter.profile === 'string' && ID.test(adapter.profile), 'invalid_input', 'memory snapshot adapter profile is invalid', {});
  invariant(MEMORY_RETRIEVAL_KINDS.includes(adapter.kind), 'invalid_input', 'memory snapshot adapter kind is invalid', {});
  invariant(isInstant(retrieved_at), 'invalid_input', 'memory snapshot retrieved_at must be an ISO instant', {});
  invariant(Array.isArray(hits), 'invalid_input', 'memory snapshot hits must be an array', {});
  const normalizedHits = hits.map((hit, index) => {
    const record = assertMemoryRecord(hit.record, { at: 'createMemoryRetrievalSnapshot', index });
    invariant(record.org_id === query.org_id && record.memory_id === query.memory_id, 'invalid_input', 'memory snapshot hit identity does not match query', { index });
    invariant(
      record.expires_at === null || instantEpochSeconds(record.expires_at) > instantEpochSeconds(query.requested_at),
      'invalid_input', 'memory snapshot cannot include a record expired at query time', { index },
    );
    invariant(Number.isInteger(hit.rank) && hit.rank === index + 1, 'invalid_input', 'memory snapshot ranks must be dense and ordered', { index });
    invariant(typeof hit.score === 'number' && Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1, 'invalid_input', 'memory snapshot score must be in [0,1]', { index });
    return { rank: hit.rank, score: hit.score, record: canonicalClone(record) };
  });
  const body = {
    schema: MEMORY_RETRIEVAL_SNAPSHOT_SCHEMA,
    query: canonicalClone(query),
    manifest_digest,
    context: canonicalClone(context),
    adapter: canonicalClone(adapter),
    retrieved_at,
    hits: normalizedHits,
  };
  return deepFreeze({ ...body, snapshot_digest: digest(body) });
}

export function verifyMemoryRetrievalSnapshot(snapshot, where = {}) {
  closed(snapshot, MEMORY_RETRIEVAL_SNAPSHOT_KEYS, 'memory retrieval snapshot', 'contract_violation');
  for (const key of MEMORY_RETRIEVAL_SNAPSHOT_KEYS) invariant(Object.prototype.hasOwnProperty.call(snapshot, key), 'contract_violation', `memory snapshot is missing '${key}'`, { ...where, key });
  const { snapshot_digest, ...input } = snapshot;
  let rebuilt;
  try {
    rebuilt = createMemoryRetrievalSnapshot(input);
  } catch (error) {
    invariant(false, 'contract_violation', `memory snapshot is invalid: ${error.message}`, where);
  }
  invariant(rebuilt.snapshot_digest === snapshot_digest, 'contract_violation', 'memory snapshot digest does not match its content', where);
  return snapshot;
}

export function memorySnapshotContextItems(snapshot, { org_id = snapshot?.query?.org_id } = {}) {
  verifyMemoryRetrievalSnapshot(snapshot, { at: 'memorySnapshotContextItems' });
  invariant(org_id === snapshot.query.org_id, 'contract_violation', 'memory snapshot tenant does not match requested tenant', {
    expected: snapshot.query.org_id, actual: org_id,
  });
  return snapshot.hits.map((hit) => createContextItem({
    id: `memory:${hit.record.memory_id}:${hit.record.record_id}:v${hit.record.version}`,
    kind: snapshot.context.kind,
    source: snapshot.context.source,
    org_id: hit.record.org_id,
    sensitivity: hit.record.sensitivity,
    trusted: snapshot.context.trusted,
    priority: snapshot.context.priority,
    occurred_at: hit.record.created_at,
    content: hit.record.content,
    provenance: {
      memory_id: hit.record.memory_id,
      record_id: hit.record.record_id,
      version: hit.record.version,
      record_digest: hit.record.record_digest,
      snapshot_digest: snapshot.snapshot_digest,
      query_digest: snapshot.query.query_digest,
    },
    metadata: {
      retrieval_profile: snapshot.adapter.profile,
      retrieval_kind: snapshot.adapter.kind,
      rank: hit.rank,
      score: hit.score,
      retention_class: hit.record.retention_class,
      expires_at: hit.record.expires_at,
    },
  }));
}
