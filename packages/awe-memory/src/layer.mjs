import {
  deepFreeze, invariant, isInstant, isPlainObject, instantEpochSeconds,
  sensitivityRank,
} from './kernel.mjs';
import { createMemoryRegistry } from './memory-registry.mjs';
import {
  assertMemoryWriteAuthorization, assertMemoryWriteProposal, defineMemoryRecord,
  defineMemoryWriteProposal,
} from './record.mjs';
import {
  createMemoryRetrievalSnapshot, defineMemoryQuery, memorySnapshotContextItems,
  verifyMemoryRetrievalSnapshot,
} from './retrieval.mjs';
import { createInMemoryRecordStore } from './store.mjs';

export const MEMORY_BLOCKED_REASONS = [
  'memory_not_registered',
  'memory_version_unknown',
  'memory_not_executable',
  'memory_tenant_mismatch',
  'memory_write_disabled',
  'memory_approval_required',
  'memory_approval_invalid',
  'memory_version_conflict',
  'memory_retrieval_profile_mismatch',
];

function refused(reason, detail) {
  invariant(MEMORY_BLOCKED_REASONS.includes(reason), 'unknown_reason', `unknown memory refusal '${reason}'`, {});
  return deepFreeze({ ok: false, reason, detail, proposal: null, record: null, snapshot: null, context_items: [] });
}

function resolutionRefusal(resolution) {
  return refused(resolution.reason, resolution.detail);
}

function validateRecordPolicy(manifest, value, at) {
  invariant(
    sensitivityRank(value.sensitivity) <= sensitivityRank(manifest.context.max_sensitivity),
    'invalid_input', `${at} sensitivity '${value.sensitivity}' exceeds memory ceiling '${manifest.context.max_sensitivity}'`, {},
  );
  invariant(
    manifest.retention.allowed_classes.includes(value.retention_class),
    'invalid_input', `${at} retention class '${value.retention_class}' is not allowed`, {},
  );
  if (value.expires_at !== null) {
    const from = value.proposed_at ?? value.created_at;
    invariant(isInstant(from), 'invalid_input', `${at} requires a valid start instant`, {});
    const ttlSeconds = instantEpochSeconds(value.expires_at) - instantEpochSeconds(from);
    invariant(ttlSeconds > 0, 'invalid_input', `${at} expires_at must be after creation`, {});
    invariant(
      ttlSeconds <= manifest.retention.max_ttl_days * 86400,
      'invalid_input', `${at} retention exceeds ${manifest.retention.max_ttl_days} days`, {},
    );
  }
}

export function createMemoryLayer({
  manifests = [],
  store = createInMemoryRecordStore(),
  adapters = [],
  clock = null,
} = {}) {
  invariant(typeof clock === 'function', 'invalid_input', 'memory layer requires an injected clock', {});
  invariant(store !== null && typeof store === 'object', 'invalid_input', 'memory layer requires a store', {});
  for (const method of ['write', 'read', 'latest', 'list', 'expire']) {
    invariant(typeof store[method] === 'function', 'invalid_input', `memory layer store needs ${method}()`, {});
  }
  const registry = createMemoryRegistry(manifests);
  const adapterMap = new Map();
  for (const adapter of adapters) {
    invariant(adapter !== null && typeof adapter === 'object' && typeof adapter.search === 'function', 'invalid_input', 'memory adapter is invalid', {});
    invariant(!adapterMap.has(adapter.profile), 'invalid_input', `duplicate memory retrieval profile '${adapter.profile}'`, {});
    adapterMap.set(adapter.profile, adapter);
  }

  function proposeWrite(raw = {}) {
    invariant(isPlainObject(raw), 'invalid_input', 'memory write request must be a plain object', {});
    const resolution = registry.resolve({
      memory_id: raw.memory_id,
      version: raw.memory_version ?? null,
      org_id: raw.org_id,
    });
    if (!resolution.ok) return resolutionRefusal(resolution);
    const manifest = resolution.manifest;
    if (manifest.write_policy.mode === 'disabled') {
      return refused('memory_write_disabled', `memory '${manifest.memory_id}' does not accept writes`);
    }
    const existing = store.latest({
      org_id: raw.org_id,
      memory_id: raw.memory_id,
      record_id: raw.record_id,
    });
    const expected_version = raw.expected_version ?? existing?.version ?? 0;
    const proposal = defineMemoryWriteProposal({
      memory_id: manifest.memory_id,
      memory_version: manifest.version,
      manifest_digest: manifest.manifest_digest,
      record_id: raw.record_id,
      org_id: raw.org_id,
      content: raw.content,
      sensitivity: raw.sensitivity,
      retention_class: raw.retention_class,
      expires_at: raw.expires_at,
      provenance: raw.provenance,
      metadata: raw.metadata ?? {},
      expected_version,
      proposed_at: raw.proposed_at ?? clock(),
    });
    validateRecordPolicy(manifest, proposal, 'memory proposal');
    return deepFreeze({
      ok: true,
      reason: null,
      detail: null,
      decision: 'require_approval',
      proposal,
      record: null,
      snapshot: null,
      context_items: [],
    });
  }

  function commitWrite({ proposal, authorization = null } = {}) {
    assertMemoryWriteProposal(proposal, { at: 'memory_layer.commitWrite' });
    const resolution = registry.resolve({
      memory_id: proposal.memory_id,
      version: proposal.memory_version,
      org_id: proposal.org_id,
    });
    if (!resolution.ok) return resolutionRefusal(resolution);
    const manifest = resolution.manifest;
    if (manifest.manifest_digest !== proposal.manifest_digest) {
      return refused('memory_approval_invalid', 'memory proposal is bound to a different manifest digest');
    }
    if (manifest.write_policy.mode === 'disabled') {
      return refused('memory_write_disabled', `memory '${manifest.memory_id}' does not accept writes`);
    }
    if (authorization === null) {
      return refused('memory_approval_required', 'memory write requires a human authorization bound to the proposal digest');
    }
    try {
      assertMemoryWriteAuthorization(authorization, { at: 'memory_layer.commitWrite' });
    } catch {
      return refused('memory_approval_invalid', 'memory write authorization is malformed');
    }
    const roleAllowed = authorization.principal_roles.some((role) => manifest.write_policy.approver_roles.includes(role));
    if (
      authorization.proposal_digest !== proposal.proposal_digest
      || authorization.org_id !== proposal.org_id
      || authorization.actor !== 'human'
      || authorization.decision !== 'approve'
      || !roleAllowed
    ) {
      return refused('memory_approval_invalid', 'memory authorization does not satisfy proposal, tenant, actor, decision and role bindings');
    }
    validateRecordPolicy(manifest, proposal, 'memory proposal');
    const record = defineMemoryRecord({
      memory_id: proposal.memory_id,
      record_id: proposal.record_id,
      version: proposal.expected_version + 1,
      org_id: proposal.org_id,
      content: proposal.content,
      sensitivity: proposal.sensitivity,
      retention_class: proposal.retention_class,
      created_at: proposal.proposed_at,
      expires_at: proposal.expires_at,
      provenance: proposal.provenance,
      metadata: {
        ...proposal.metadata,
        memory_manifest_digest: manifest.manifest_digest,
        approval_evidence_digest: authorization.authorization_digest,
      },
      supersedes_version: proposal.expected_version === 0 ? null : proposal.expected_version,
    });
    const written = store.write(record, { expected_version: proposal.expected_version });
    if (written?.ok !== true) {
      return refused('memory_version_conflict', `memory '${record.record_id}' changed after proposal (current v${written?.current_version ?? 'unknown'})`);
    }
    return deepFreeze({
      ok: true,
      reason: null,
      detail: null,
      decision: 'committed',
      proposal,
      record: written.record,
      snapshot: null,
      context_items: [],
    });
  }

  async function retrieve(raw = {}) {
    invariant(isPlainObject(raw), 'invalid_input', 'memory retrieval request must be a plain object', {});
    const resolution = registry.resolve({
      memory_id: raw.memory_id,
      version: raw.memory_version ?? null,
      org_id: raw.org_id,
    });
    if (!resolution.ok) return resolutionRefusal(resolution);
    const manifest = resolution.manifest;
    const profile = raw.profile ?? manifest.retrieval.profile;
    if (profile !== manifest.retrieval.profile || !adapterMap.has(profile)) {
      return refused('memory_retrieval_profile_mismatch', `memory '${manifest.memory_id}' requires registered profile '${manifest.retrieval.profile}'`);
    }
    const query = defineMemoryQuery({
      query_id: raw.query_id,
      memory_id: manifest.memory_id,
      memory_version: manifest.version,
      org_id: raw.org_id,
      text: raw.text,
      profile,
      limit: Math.min(raw.limit ?? manifest.retrieval.max_results, manifest.retrieval.max_results),
      min_score: Math.max(raw.min_score ?? manifest.retrieval.min_score, manifest.retrieval.min_score),
      requested_at: raw.requested_at ?? clock(),
    });
    const candidates = store.list({
      org_id: query.org_id,
      memory_id: query.memory_id,
      as_of: query.requested_at,
    });
    for (const record of candidates) {
      invariant(record.org_id === query.org_id && record.memory_id === query.memory_id, 'contract_violation', 'memory store returned a cross-tenant or cross-memory candidate', {});
      validateRecordPolicy(manifest, record, 'stored memory');
    }
    const adapter = adapterMap.get(profile);
    const searched = await adapter.search({ query, candidates });
    const selected = searched
      .filter((hit) => hit.score >= query.min_score)
      .sort((a, b) => b.score - a.score || a.record.record_id.localeCompare(b.record.record_id) || a.record.version - b.record.version)
      .slice(0, query.limit)
      .map((hit, index) => ({ rank: index + 1, score: hit.score, record: hit.record }));
    const snapshot = createMemoryRetrievalSnapshot({
      query,
      manifest_digest: manifest.manifest_digest,
      context: manifest.context,
      adapter: { profile: adapter.profile, kind: adapter.kind },
      retrieved_at: raw.retrieved_at ?? clock(),
      hits: selected,
    });
    return deepFreeze({
      ok: true,
      reason: null,
      detail: null,
      decision: 'retrieved',
      proposal: null,
      record: null,
      snapshot,
      context_items: memorySnapshotContextItems(snapshot),
    });
  }

  function replay(snapshot, { org_id } = {}) {
    verifyMemoryRetrievalSnapshot(snapshot, { at: 'memory_layer.replay' });
    if (snapshot.query.org_id !== org_id) {
      return refused('memory_tenant_mismatch', `snapshot tenant '${snapshot.query.org_id}' does not match '${org_id}'`);
    }
    return deepFreeze({
      ok: true,
      reason: null,
      detail: null,
      decision: 'replayed',
      proposal: null,
      record: null,
      snapshot,
      context_items: memorySnapshotContextItems(snapshot, { org_id }),
    });
  }

  return Object.freeze({
    proposeWrite,
    commitWrite,
    retrieve,
    replay,
    expire: (request) => store.expire(request),
    describe: () => deepFreeze({
      schema: 'awe.memory_layer_description/v1',
      manifests: registry.describe(),
      retrieval_profiles: [...adapterMap.values()].map((adapter) => ({ profile: adapter.profile, kind: adapter.kind }))
        .sort((a, b) => a.profile.localeCompare(b.profile)),
      store: { name: store.name, kind: store.kind },
      digests: { registry: registry.registry_digest() },
    }),
  });
}
