#!/usr/bin/env node
// Runner Y — tenant-bound, versioned and replayable Memory Layer.
// Pure offline: in-memory stores, fixture retrieval adapters and injected time.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson, createExecutionContext, createGateRun, defineTool,
} from '../packages/awe-kernel/src/index.mjs';
import {
  createPolicyEngine, createToolDispatcher, defineToolGrant,
  defineWorkflowManifest, evaluateApprovalDecision,
} from '../packages/awe-control-plane/src/index.mjs';
import {
  MEMORY_BLOCKED_REASONS, MEMORY_RETENTION_CLASSES,
  createInMemoryRecordStore, createLexicalMemoryAdapter, createMemoryRegistry,
  defineMemoryManifest, defineMemoryRecord, defineMemoryRetrievalAdapter,
  defineMemoryStore, defineMemoryWriteAuthorization, verifyMemoryRetrievalSnapshot,
} from '../packages/awe-memory/src/index.mjs';
import { createMemoryService } from '../packages/awe-runtime/src/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY_SRC = join(ROOT, 'packages', 'awe-memory', 'src');
const run = createGateRun({ name: 'eval-memory (Runner Y, offline, deterministic)' });
const { check, equal, section } = run;
let fixtures = 0;

function group(title, body) {
  section(title);
  try { body(); } catch (error) { check(false, `${title}: threw unexpectedly — ${error?.stack ?? error}`); }
}

async function groupAsync(title, body) {
  section(title);
  try { await body(); } catch (error) { check(false, `${title}: threw unexpectedly — ${error?.stack ?? error}`); }
}

function manifest(overrides = {}) {
  return defineMemoryManifest({
    memory_id: 'operations_memory',
    version: '1.0.0',
    title: 'Operations Memory',
    description: 'Synthetic cross-run operations facts.',
    lifecycle: 'active',
    tenant_scope: { mode: 'named_tenants', org_ids: ['org_memory_fixture'] },
    context: {
      kind: 'domain_facts',
      source: 'memory_layer',
      trusted: false,
      priority: 650,
      max_sensitivity: 'confidential',
    },
    write_policy: { mode: 'approval_required', approver_roles: ['memory_steward'] },
    retention: { allowed_classes: ['standard', 'legal_hold'], max_ttl_days: 30 },
    retrieval: { profile: 'lexical_default', max_results: 5, min_score: 0.1 },
    metadata: { fixture: true },
    ...overrides,
  });
}

function provenance(overrides = {}) {
  return {
    source_type: 'agent_run',
    source_ref: 'agent_run_001',
    run_id: 'agent_run_001',
    captured_at: '2026-07-28T14:00:00.000Z',
    actor: 'service',
    ...overrides,
  };
}

function record({ record_id = 'case_access', version = 1, content = 'Access cases require identity confirmation.', ...overrides } = {}) {
  return defineMemoryRecord({
    memory_id: 'operations_memory',
    record_id,
    version,
    org_id: 'org_memory_fixture',
    content,
    sensitivity: 'internal',
    retention_class: 'standard',
    created_at: '2026-07-28T14:00:00.000Z',
    expires_at: '2026-08-20T14:00:00.000Z',
    provenance: provenance(),
    metadata: { synthetic: true },
    supersedes_version: version === 1 ? null : version - 1,
    ...overrides,
  });
}

function service({
  memoryManifest = manifest(),
  store = createInMemoryRecordStore(),
  adapters = [createLexicalMemoryAdapter()],
  clock = () => '2026-07-28T15:00:00.000Z',
} = {}) {
  fixtures += 1;
  return {
    service: createMemoryService({ manifests: [memoryManifest], store, adapters, clock }),
    store,
    memoryManifest,
  };
}

function writeRequest(overrides = {}) {
  return {
    memory_id: 'operations_memory',
    memory_version: '1.0.0',
    record_id: 'case_access',
    org_id: 'org_memory_fixture',
    content: 'Access cases require identity confirmation.',
    sensitivity: 'internal',
    retention_class: 'standard',
    expires_at: '2026-08-20T14:00:00.000Z',
    provenance: provenance(),
    metadata: { synthetic: true },
    proposed_at: '2026-07-28T15:00:00.000Z',
    ...overrides,
  };
}

function authorize(proposal, overrides = {}) {
  return defineMemoryWriteAuthorization({
    proposal_digest: proposal.proposal_digest,
    org_id: proposal.org_id,
    decision: 'approve',
    actor: 'human',
    principal: 'operator_alex',
    principal_roles: ['memory_steward'],
    approved_at: '2026-07-28T15:01:00.000Z',
    ...overrides,
  });
}

group('manifest — versioned, closed, tenant-scoped and fail-closed for writes', () => {
  const value = manifest();
  equal(value.schema, 'awe.memory_manifest/v1', 'manifest schema is pinned');
  equal(value.write_policy.mode, 'approval_required', 'writes require approval');
  equal(value.tenant_scope.org_ids, ['org_memory_fixture'], 'tenant scope is explicit');
  equal(value.retention.allowed_classes, ['legal_hold', 'standard'], 'retention classes are normalized');
  check(value.manifest_digest.length > 0, 'manifest is content-addressed');
  check(Object.isFrozen(value.context), 'manifest is deeply frozen');
  run.deterministic(() => manifest(), 'manifest construction is deterministic');
  const base = JSON.parse(canonicalJson(value));
  delete base.manifest_digest;
  run.throwsKernel(() => defineMemoryManifest({ ...base, unknown: true }), 'invalid_input', 'unknown manifest keys are refused');
  run.throwsKernel(
    () => defineMemoryManifest({ ...base, tenant_scope: { mode: 'any_tenant', org_ids: ['org_x'] } }),
    'invalid_input', 'any_tenant cannot conceal an allow-list',
  );
  run.throwsKernel(
    () => defineMemoryManifest({ ...base, write_policy: { mode: 'approval_required', approver_roles: [] } }),
    'invalid_input', 'approval-required writes need a named role',
  );
  run.throwsKernel(
    () => defineMemoryManifest({ ...base, write_policy: { mode: 'automatic', approver_roles: [] } }),
    'invalid_input', 'automatic memory writes do not exist',
  );
});

group('records — immutable versions, provenance, retention and digest integrity', () => {
  const value = record();
  equal(value.schema, 'awe.memory_record/v1', 'record schema is pinned');
  equal(value.version, 1, 'record version starts at one');
  equal(value.supersedes_version, null, 'first version supersedes nothing');
  check(value.content_digest.length > 0 && value.record_digest.length > 0, 'record has content and envelope digests');
  check(Object.isFrozen(value.provenance), 'record provenance is immutable');
  const redacted = record({ content: 'Use password=secret-value only for this test.' });
  check(!redacted.content.includes('secret-value'), 'credential-shaped content is redacted before persistence');
  run.throwsKernel(() => record({ version: 2, supersedes_version: null }), 'invalid_input', 'version chains cannot skip their predecessor');
  run.throwsKernel(() => record({ retention_class: 'legal_hold', expires_at: '2026-08-20T14:00:00.000Z' }), 'invalid_input', 'legal holds cannot carry expiry');
  run.throwsKernel(() => record({ provenance: { ...provenance(), evidence: 'undeclared' } }), 'invalid_input', 'provenance is a closed contract');
});

group('registry — lifecycle, version and tenant resolution are explicit', () => {
  const draft = manifest({ version: '1.1.0', lifecycle: 'draft' });
  const registry = createMemoryRegistry([manifest(), draft]);
  equal(registry.resolve({ memory_id: 'operations_memory', org_id: 'org_memory_fixture' }).manifest.version, '1.0.0', 'latest executable version resolves');
  equal(registry.resolve({ memory_id: 'missing_memory', org_id: 'org_memory_fixture' }).reason, 'memory_not_registered', 'unknown memory is refused');
  equal(registry.resolve({ memory_id: 'operations_memory', version: '9.0.0', org_id: 'org_memory_fixture' }).reason, 'memory_version_unknown', 'unknown version is refused');
  equal(registry.resolve({ memory_id: 'operations_memory', version: '1.1.0', org_id: 'org_memory_fixture' }).reason, 'memory_not_executable', 'draft memory is not executable');
  equal(registry.resolve({ memory_id: 'operations_memory', org_id: 'org_other' }).reason, 'memory_tenant_mismatch', 'foreign tenant is refused');
  check(registry.registry_digest().length > 0, 'registry is content-addressed');
  check(Object.isFrozen(registry.describe()), 'registry description cannot be mutated after digesting');
});

group('store — optimistic versioning, tenant binding and expiry', () => {
  const store = createInMemoryRecordStore();
  equal(store.write(record()).ok, true, 'first record version writes');
  equal(store.write(record()).reason, 'memory_version_conflict', 'duplicate version is a typed conflict');
  const second = record({
    version: 2,
    content: 'Access cases require manager-confirmed identity.',
    created_at: '2026-07-29T14:00:00.000Z',
    expires_at: '2026-08-21T14:00:00.000Z',
  });
  equal(store.write(second, { expected_version: 1 }).current_version, 2, 'next version commits with compare-and-swap');
  equal(store.write(record({
    memory_id: 'other_memory',
    record_id: 'other_case',
  })).ok, true, 'a second collection can share the tenant store');
  equal(store.latest({ org_id: 'org_memory_fixture', memory_id: 'operations_memory', record_id: 'case_access' }).version, 2, 'latest returns newest immutable version');
  equal(store.read({ org_id: 'org_memory_fixture', memory_id: 'operations_memory', record_id: 'case_access', version: 1 }).version, 1, 'historical versions remain addressable');
  equal(store.read({ org_id: 'org_other', memory_id: 'operations_memory', record_id: 'case_access', version: 1 }), null, 'another tenant cannot read a record');
  equal(store.list({ org_id: 'org_memory_fixture', memory_id: 'operations_memory', as_of: '2026-08-22T00:00:00.000Z' }), [], 'expired records do not appear in retrieval candidates');
  equal(store.expire({ org_id: 'org_memory_fixture', memory_id: 'operations_memory', as_of: '2026-08-22T00:00:00.000Z' }).length, 1, 'expiry returns the retired identity');
  equal(store.latest({ org_id: 'org_memory_fixture', memory_id: 'operations_memory', record_id: 'case_access' }), null, 'expired identity no longer reads');
  equal(store.latest({ org_id: 'org_memory_fixture', memory_id: 'other_memory', record_id: 'other_case' }).record_id, 'other_case', 'expiry cannot cross a memory collection boundary');
  run.throwsKernel(() => defineMemoryStore({ name: 'broken', write() {} }), 'invalid_input', 'storage adapters must implement the complete contract');
  const leaky = defineMemoryStore({
    name: 'leaky',
    write: () => ({ ok: false, reason: 'unused' }),
    read: () => null,
    latest: () => null,
    list: () => [record({ org_id: 'org_other' })],
    expire: () => [],
  });
  run.throwsKernel(
    () => leaky.list({ org_id: 'org_memory_fixture', memory_id: 'operations_memory' }),
    'contract_violation', 'storage adapter cannot return another tenant record',
  );
});

await groupAsync('retrieval — storage-neutral scoring becomes standard Context Items', async () => {
  const store = createInMemoryRecordStore([
    record(),
    record({ record_id: 'case_billing', content: 'Billing cases require an invoice reference.' }),
  ]);
  const { service: memory } = service({ store });
  const result = await memory.retrieve({
    query_id: 'query:access:1',
    memory_id: 'operations_memory',
    memory_version: '1.0.0',
    org_id: 'org_memory_fixture',
    text: 'identity confirmation token=secret-value',
    requested_at: '2026-07-30T12:00:00.000Z',
    retrieved_at: '2026-07-30T12:00:01.000Z',
  });
  equal(result.ok, true, 'retrieval succeeds');
  equal(result.snapshot.schema, 'awe.memory_retrieval_snapshot/v1', 'snapshot schema is pinned');
  check(!result.snapshot.query.text.includes('secret-value'), 'secret-shaped query text is redacted before snapshot persistence');
  equal(result.snapshot.hits.map((hit) => hit.record.record_id), ['case_access'], 'minimum score excludes unrelated memory');
  equal(result.context_items.length, 1, 'one retrieval hit becomes one Context Item');
  equal(result.context_items[0].kind, 'domain_facts', 'memory uses the standard Context Item vocabulary');
  equal(result.context_items[0].org_id, 'org_memory_fixture', 'memory context is tenant-bound');
  equal(result.context_items[0].trusted, false, 'memory does not gain trust through retrieval');
  equal(result.context_items[0].provenance.snapshot_digest, result.snapshot.snapshot_digest, 'context provenance pins the replay snapshot');
  check(!Object.hasOwn(result.context_items[0], 'authorization'), 'memory context carries no authority');
  verifyMemoryRetrievalSnapshot(result.snapshot);
});

await groupAsync('adapter seam — vector retrieval is injected and output-validated', async () => {
  let calls = 0;
  const vector = defineMemoryRetrievalAdapter({
    profile: 'vector_fixture',
    kind: 'vector',
    search({ candidates }) {
      calls += 1;
      return candidates.map((candidate) => ({ record_id: candidate.record_id, version: candidate.version, score: 0.75 }));
    },
  });
  const vectorManifest = manifest({ retrieval: { profile: 'vector_fixture', max_results: 3, min_score: 0.5 } });
  const { service: memory } = service({
    memoryManifest: vectorManifest,
    store: createInMemoryRecordStore([record()]),
    adapters: [vector],
  });
  const result = await memory.retrieve({
    query_id: 'query:vector:1',
    memory_id: 'operations_memory',
    org_id: 'org_memory_fixture',
    text: 'semantic access policy',
    requested_at: '2026-07-30T12:00:00.000Z',
    retrieved_at: '2026-07-30T12:00:01.000Z',
  });
  equal(calls, 1, 'injected vector adapter is called once');
  equal(result.snapshot.adapter.kind, 'vector', 'snapshot records retrieval kind without a provider');
  const wrongProfile = await memory.retrieve({
    query_id: 'query:wrong:1',
    memory_id: 'operations_memory',
    org_id: 'org_memory_fixture',
    text: 'x',
    profile: 'lexical_default',
  });
  equal(wrongProfile.reason, 'memory_retrieval_profile_mismatch', 'caller cannot swap the manifest-pinned profile');

  const corrupt = defineMemoryRetrievalAdapter({
    profile: 'vector_fixture',
    kind: 'vector',
    search: () => [{ record_id: 'foreign_record', version: 1, score: 1 }],
  });
  const corruptService = service({
    memoryManifest: vectorManifest,
    store: createInMemoryRecordStore([record()]),
    adapters: [corrupt],
  }).service;
  let rejected = null;
  try {
    await corruptService.retrieve({
      query_id: 'query:bad:1', memory_id: 'operations_memory', org_id: 'org_memory_fixture', text: 'x',
    });
  } catch (error) {
    rejected = error;
  }
  equal(rejected?.code, 'contract_violation', 'adapter cannot invent a record reference');
  check(rejected?.message.includes('unknown record'), 'unknown adapter references are rejected at the adapter boundary');
});

await groupAsync('snapshot replay — exact context without storage or retrieval calls', async () => {
  let calls = 0;
  const adapter = defineMemoryRetrievalAdapter({
    profile: 'lexical_default',
    kind: 'lexical',
    search({ candidates }) {
      calls += 1;
      return candidates.map((candidate) => ({ record_id: candidate.record_id, version: candidate.version, score: 1 }));
    },
  });
  const first = service({ store: createInMemoryRecordStore([record()]), adapters: [adapter] }).service;
  const retrieved = await first.retrieve({
    query_id: 'query:replay:1',
    memory_id: 'operations_memory',
    org_id: 'org_memory_fixture',
    text: 'identity',
    requested_at: '2026-07-30T12:00:00.000Z',
    retrieved_at: '2026-07-30T12:00:01.000Z',
  });
  equal(calls, 1, 'initial retrieval calls adapter');
  const empty = service({ store: createInMemoryRecordStore(), adapters: [adapter] }).service;
  const replayed = empty.replay(retrieved.snapshot, { org_id: 'org_memory_fixture' });
  equal(calls, 1, 'snapshot replay calls neither adapter nor store');
  equal(replayed.context_items, retrieved.context_items, 'snapshot replay reproduces exact Context Items');
  equal(empty.replay(retrieved.snapshot, { org_id: 'org_other' }).reason, 'memory_tenant_mismatch', 'snapshot replay is tenant-checked');
  const tampered = JSON.parse(canonicalJson(retrieved.snapshot));
  tampered.retrieved_at = '2026-07-30T12:00:02.000Z';
  run.throwsKernel(() => empty.replay(tampered, { org_id: 'org_memory_fixture' }), 'contract_violation', 'snapshot tampering is detected');
});

group('write flow — proposal-first, approval-bound, tenant-safe and optimistic', () => {
  const { service: memory, store } = service();
  const proposed = memory.proposeWrite(writeRequest());
  equal(proposed.ok, true, 'valid write becomes a proposal');
  equal(proposed.decision, 'require_approval', 'proposal does not persist itself');
  equal(store.list({ org_id: 'org_memory_fixture', memory_id: 'operations_memory' }), [], 'proposal leaves store unchanged');
  equal(memory.commitWrite({ proposal: proposed.proposal }).reason, 'memory_approval_required', 'commit without authorization is refused');
  equal(store.list({ org_id: 'org_memory_fixture', memory_id: 'operations_memory' }), [], 'refused commit leaves store unchanged');
  const wrongRole = authorize(proposed.proposal, { principal_roles: ['observer'] });
  equal(memory.commitWrite({ proposal: proposed.proposal, authorization: wrongRole }).reason, 'memory_approval_invalid', 'unauthorized role is refused');
  const committed = memory.commitWrite({ proposal: proposed.proposal, authorization: authorize(proposed.proposal) });
  equal(committed.ok, true, 'bound human authorization commits');
  equal(committed.record.version, 1, 'first approved write creates v1');
  equal(committed.record.metadata.approval_evidence_digest, authorize(proposed.proposal).authorization_digest, 'record retains approval evidence digest');
  const stale = memory.proposeWrite(writeRequest({ expected_version: 0, content: 'stale update' }));
  equal(memory.commitWrite({ proposal: stale.proposal, authorization: authorize(stale.proposal) }).reason, 'memory_version_conflict', 'stale proposal cannot overwrite newer memory');
  equal(memory.proposeWrite(writeRequest({ org_id: 'org_other' })).reason, 'memory_tenant_mismatch', 'foreign tenant cannot propose a write');
  const disabled = service({ memoryManifest: manifest({ write_policy: { mode: 'disabled', approver_roles: [] } }) }).service;
  equal(disabled.proposeWrite(writeRequest()).reason, 'memory_write_disabled', 'disabled write policy refuses before proposal');
  run.throwsKernel(
    () => defineMemoryWriteAuthorization({
      proposal_digest: proposed.proposal.proposal_digest,
      org_id: 'org_memory_fixture',
      decision: 'approve',
      actor: 'service',
      principal: 'automation',
      principal_roles: ['memory_steward'],
      approved_at: '2026-07-28T15:01:00.000Z',
    }),
    'invalid_input', 'automation cannot authorize a memory write',
  );
});

await groupAsync('controlled boundary — write adapter is unreachable before approval', async () => {
  const { service: memory, store } = service();
  const proposed = memory.proposeWrite(writeRequest({ record_id: 'controlled_write' }));
  const authorization = authorize(proposed.proposal);
  let adapterCalls = 0;
  const descriptor = defineTool({
    name: 'write_memory',
    version: '1.0.0',
    description: 'Commit one approved memory proposal.',
    workflow_id: 'memory_maintenance',
    side_effect: 'write_internal',
    requires_tenant: true,
    lifecycle: 'active',
  });
  const tool = {
    descriptor,
    adapter(input) {
      adapterCalls += 1;
      return memory.commitWrite(input);
    },
  };
  const workflow = defineWorkflowManifest({
    workflow_id: 'memory_maintenance',
    version: '1.0.0',
    title: 'Memory Maintenance',
    description: 'Commit explicitly approved long-lived memory.',
    tenant_scope: { mode: 'allow_list', org_ids: ['org_memory_fixture'] },
    required_tools: [{ name: 'write_memory', version: '1.0.0', max_side_effect: 'write_internal' }],
    required_context: [],
    approval_policy: {
      requires_approval_at_or_above: 'write_internal',
      approver_roles: ['memory_steward'],
      quorum: 1,
    },
    limits: { step_timeout_ms: 1000, run_timeout_ms: 5000, max_attempts: 1, retry_backoff_ms: 0 },
    dependencies: [],
    risk: 'high',
    promotion: {
      status: 'promoted',
      promoted_at: '2026-07-28T12:00:00.000Z',
      promoted_by: 'platform_architect',
    },
    steps: [{ id: 'commit_memory', tool: 'write_memory', input: {} }],
    metadata: { synthetic: true },
  });
  const grant = defineToolGrant({
    org_id: 'org_memory_fixture',
    workflow_id: 'memory_maintenance',
    tool: 'write_memory',
    version: '1.0.0',
    max_side_effect: 'write_internal',
    requires_approval_at_or_above: 'write_internal',
    approver_roles: ['memory_steward'],
  });
  const dispatcher = createToolDispatcher({
    catalog: {
      has: (name) => name === 'write_memory',
      get: () => tool,
    },
    policy: createPolicyEngine({ grants: [grant] }),
    clock: () => '2026-07-28T15:00:00.000Z',
  });
  const context = createExecutionContext({
    run_id: 'memory_controlled_001',
    workflow_id: 'memory_maintenance',
    org_id: 'org_memory_fixture',
    actor: 'service',
    mode: 'TEST',
    is_fixture: true,
    started_at: '2026-07-28T15:00:00.000Z',
  });
  const step = { id: 'commit_memory', tool: 'write_memory', idempotency_key: 'memory:controlled:1' };
  const input = { proposal: proposed.proposal, authorization };
  const blocked = await dispatcher.invoke({ manifest: workflow, step, tool: 'write_memory', input, context, approved: false });
  equal(blocked.reason, 'approval_required', 'controlled dispatcher blocks the write');
  equal(adapterCalls, 0, 'write adapter is not reached before approval');
  equal(store.list({ org_id: 'org_memory_fixture', memory_id: 'operations_memory' }), [], 'blocked dispatch leaves memory unchanged');
  const approval = evaluateApprovalDecision({
    manifest: workflow,
    pending: { org_id: 'org_memory_fixture', step_id: 'commit_memory' },
    decision: 'approve',
    actor: 'human',
    principal: 'operator_alex',
    principal_roles: ['memory_steward'],
    org_id: 'org_memory_fixture',
  });
  equal(approval.ok, true, 'existing approval engine validates the human decision');
  const allowed = await dispatcher.invoke({ manifest: workflow, step, tool: 'write_memory', input, context, approved: approval.ok });
  equal(allowed.ok, true, 'approved dispatch completes');
  equal(adapterCalls, 1, 'write adapter runs exactly once after approval');
  equal(allowed.data.record.record_id, 'controlled_write', 'approved action committed the proposed record');
});

group('retention — TTL ceilings and legal holds are explicit', () => {
  const { service: memory } = service();
  run.throwsKernel(
    () => memory.proposeWrite(writeRequest({ expires_at: '2027-07-28T15:00:00.000Z' })),
    'invalid_input', 'proposal cannot exceed manifest TTL ceiling',
  );
  const legal = memory.proposeWrite(writeRequest({
    record_id: 'legal_hold_case',
    retention_class: 'legal_hold',
    expires_at: null,
  }));
  equal(legal.ok, true, 'allowed legal hold can be proposed');
  check(MEMORY_RETENTION_CLASSES.includes(legal.proposal.retention_class), 'proposal uses closed retention vocabulary');
});

group('layering and source purity — no provider, network, storage or ambient time coupling', () => {
  const files = readdirSync(MEMORY_SRC).filter((name) => name.endsWith('.mjs')).sort();
  const source = files.map((name) => readFileSync(join(MEMORY_SRC, name), 'utf8')).join('\n');
  equal(files, ['index.mjs', 'kernel.mjs', 'layer.mjs', 'manifest.mjs', 'memory-registry.mjs', 'record.mjs', 'retrieval.mjs', 'store.mjs'], 'memory package has the expected bounded module surface');
  check(!/from ['"](?:@supabase|pg|postgres|openai|anthropic|pinecone|weaviate|qdrant|redis)/.test(source), 'memory core imports no storage, vector or model SDK');
  check(!/\bfetch\s*\(|node:(?:http|https|net|tls)|\bWebSocket\b/.test(source), 'memory core contains no network primitive');
  check(!/node:fs|readFile|writeFile|mkdir|process\.env/.test(source), 'memory core contains no filesystem or ambient configuration');
  check(!/Date\.now|new Date\s*\(|Math\.random|randomUUID/.test(source), 'memory core contains no ambient clock or randomness');
  check(!source.includes('../awe-agent-runtime'), 'memory core does not depend on the agent loop');
  check(!source.includes('../awe-control-plane'), 'memory core does not duplicate control-plane policy');
});

group('vocabulary coverage', () => {
  const observed = new Set([
    'memory_not_registered',
    'memory_version_unknown',
    'memory_not_executable',
    'memory_tenant_mismatch',
    'memory_write_disabled',
    'memory_approval_required',
    'memory_approval_invalid',
    'memory_version_conflict',
    'memory_retrieval_profile_mismatch',
  ]);
  equal([...observed].sort(), [...MEMORY_BLOCKED_REASONS].sort(), 'all memory refusal reasons have a fixture');
});

console.log(`memory fixtures=${fixtures}`);
const report = run.summary({ fixtures });
process.exit(report.fail === 0 ? 0 : 1);
