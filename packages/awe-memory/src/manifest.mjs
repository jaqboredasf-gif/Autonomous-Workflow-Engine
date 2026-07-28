import {
  CONTEXT_ITEM_KINDS, CONTEXT_SENSITIVITIES, deepFreeze, digest, invariant,
  isPlainObject,
} from './kernel.mjs';

export const MEMORY_MANIFEST_SCHEMA = 'awe.memory_manifest/v1';
export const MEMORY_LIFECYCLES = ['draft', 'active', 'deprecated', 'retired'];
export const EXECUTABLE_MEMORY_LIFECYCLES = ['active', 'deprecated'];
export const MEMORY_WRITE_MODES = ['disabled', 'approval_required'];
export const MEMORY_RETENTION_CLASSES = ['ephemeral', 'standard', 'legal_hold'];
export const MEMORY_MANIFEST_KEYS = [
  'schema', 'memory_id', 'version', 'title', 'description', 'lifecycle',
  'tenant_scope', 'context', 'write_policy', 'retention', 'retrieval',
  'metadata', 'manifest_digest',
];

const ID = /^[a-z][a-z0-9_]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const TENANT_KEYS = ['mode', 'org_ids'];
const CONTEXT_KEYS = ['kind', 'source', 'trusted', 'priority', 'max_sensitivity'];
const WRITE_KEYS = ['mode', 'approver_roles'];
const RETENTION_KEYS = ['allowed_classes', 'max_ttl_days'];
const RETRIEVAL_KEYS = ['profile', 'max_results', 'min_score'];

function closed(value, allowed, label) {
  invariant(isPlainObject(value), 'invalid_input', `${label} must be a plain object`, { label });
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  invariant(unknown.length === 0, 'invalid_input', `${label} has unknown key(s) ${JSON.stringify(unknown)}`, {
    label, unknown, allowed,
  });
}

export function memoryTenantInScope(manifest, org_id) {
  if (typeof org_id !== 'string' || org_id.length === 0) return false;
  return manifest.tenant_scope.mode === 'any_tenant'
    || manifest.tenant_scope.org_ids.includes(org_id);
}

export function defineMemoryManifest(spec = {}) {
  closed(spec, MEMORY_MANIFEST_KEYS.filter((key) => key !== 'manifest_digest'), 'memory manifest');
  invariant(
    spec.schema === undefined || spec.schema === MEMORY_MANIFEST_SCHEMA,
    'invalid_input', `memory manifest schema must be '${MEMORY_MANIFEST_SCHEMA}'`, { schema: spec.schema },
  );
  invariant(typeof spec.memory_id === 'string' && ID.test(spec.memory_id), 'invalid_input', `memory_id '${spec.memory_id}' must be snake_case`, {});
  invariant(typeof spec.version === 'string' && SEMVER.test(spec.version), 'invalid_input', `memory '${spec.memory_id}' version must be pinned semver`, {});
  invariant(typeof spec.description === 'string' && spec.description.length > 0, 'invalid_input', `memory '${spec.memory_id}' needs a description`, {});
  invariant(MEMORY_LIFECYCLES.includes(spec.lifecycle), 'invalid_input', `memory '${spec.memory_id}' lifecycle '${spec.lifecycle}' is unknown`, {});

  closed(spec.tenant_scope, TENANT_KEYS, `memory '${spec.memory_id}' tenant_scope`);
  invariant(['any_tenant', 'named_tenants'].includes(spec.tenant_scope.mode), 'invalid_input', 'memory tenant_scope mode is invalid', {});
  invariant(Array.isArray(spec.tenant_scope.org_ids), 'invalid_input', 'memory tenant_scope org_ids must be an array', {});
  const org_ids = [...spec.tenant_scope.org_ids].sort();
  invariant(org_ids.every((id) => typeof id === 'string' && id.length > 0), 'invalid_input', 'memory tenant ids must be non-empty strings', {});
  invariant(new Set(org_ids).size === org_ids.length, 'invalid_input', 'memory tenant_scope contains duplicate org_ids', {});
  invariant(
    spec.tenant_scope.mode === 'any_tenant' ? org_ids.length === 0 : org_ids.length > 0,
    'invalid_input', 'any_tenant requires an empty org_ids list and named_tenants requires at least one tenant', {},
  );

  const contextSource = spec.context ?? {};
  closed(contextSource, CONTEXT_KEYS, `memory '${spec.memory_id}' context`);
  const context = {
    kind: contextSource.kind ?? 'domain_facts',
    source: contextSource.source ?? 'memory_layer',
    trusted: contextSource.trusted ?? false,
    priority: contextSource.priority ?? 500,
    max_sensitivity: contextSource.max_sensitivity ?? 'confidential',
  };
  invariant(CONTEXT_ITEM_KINDS.includes(context.kind), 'invalid_input', `memory context kind '${context.kind}' is unknown`, {});
  invariant(typeof context.source === 'string' && ID.test(context.source), 'invalid_input', 'memory context source must be snake_case', {});
  invariant(typeof context.trusted === 'boolean', 'invalid_input', 'memory context trusted must be boolean', {});
  invariant(Number.isInteger(context.priority) && context.priority >= 0 && context.priority <= 1000, 'invalid_input', 'memory context priority must be in [0,1000]', {});
  invariant(CONTEXT_SENSITIVITIES.includes(context.max_sensitivity), 'invalid_input', 'memory context max_sensitivity is unknown', {});

  const writeSource = spec.write_policy ?? {};
  closed(writeSource, WRITE_KEYS, `memory '${spec.memory_id}' write_policy`);
  const write_policy = {
    mode: writeSource.mode ?? 'disabled',
    approver_roles: [...(writeSource.approver_roles ?? [])].sort(),
  };
  invariant(MEMORY_WRITE_MODES.includes(write_policy.mode), 'invalid_input', `memory write mode '${write_policy.mode}' is unknown`, {});
  invariant(write_policy.approver_roles.every((role) => typeof role === 'string' && ID.test(role)), 'invalid_input', 'memory approver roles must be snake_case', {});
  invariant(new Set(write_policy.approver_roles).size === write_policy.approver_roles.length, 'invalid_input', 'memory approver roles contain a duplicate', {});
  invariant(
    write_policy.mode === 'disabled'
      ? write_policy.approver_roles.length === 0
      : write_policy.approver_roles.length > 0,
    'invalid_input', 'disabled memory writes take no roles; approval_required writes require at least one role', {},
  );

  const retentionSource = spec.retention ?? {};
  closed(retentionSource, RETENTION_KEYS, `memory '${spec.memory_id}' retention`);
  const allowed_classes = [...(retentionSource.allowed_classes ?? ['standard'])].sort();
  invariant(allowed_classes.length > 0, 'invalid_input', 'memory retention must allow at least one class', {});
  invariant(allowed_classes.every((value) => MEMORY_RETENTION_CLASSES.includes(value)), 'invalid_input', 'memory retention class is unknown', {});
  invariant(new Set(allowed_classes).size === allowed_classes.length, 'invalid_input', 'memory retention classes contain a duplicate', {});
  const max_ttl_days = retentionSource.max_ttl_days ?? 365;
  invariant(Number.isInteger(max_ttl_days) && max_ttl_days >= 1, 'invalid_input', 'memory retention max_ttl_days must be a positive integer', {});

  const retrievalSource = spec.retrieval ?? {};
  closed(retrievalSource, RETRIEVAL_KEYS, `memory '${spec.memory_id}' retrieval`);
  const retrieval = {
    profile: retrievalSource.profile ?? 'lexical_default',
    max_results: retrievalSource.max_results ?? 10,
    min_score: retrievalSource.min_score ?? 0,
  };
  invariant(typeof retrieval.profile === 'string' && ID.test(retrieval.profile), 'invalid_input', 'memory retrieval profile must be snake_case', {});
  invariant(Number.isInteger(retrieval.max_results) && retrieval.max_results >= 1 && retrieval.max_results <= 100, 'invalid_input', 'memory retrieval max_results must be in [1,100]', {});
  invariant(typeof retrieval.min_score === 'number' && Number.isFinite(retrieval.min_score) && retrieval.min_score >= 0 && retrieval.min_score <= 1, 'invalid_input', 'memory retrieval min_score must be in [0,1]', {});

  const metadata = spec.metadata ?? {};
  invariant(isPlainObject(metadata), 'invalid_input', 'memory metadata must be a plain object', {});
  const body = {
    schema: MEMORY_MANIFEST_SCHEMA,
    memory_id: spec.memory_id,
    version: spec.version,
    title: typeof spec.title === 'string' && spec.title.length > 0 ? spec.title : spec.memory_id,
    description: spec.description,
    lifecycle: spec.lifecycle,
    tenant_scope: { mode: spec.tenant_scope.mode, org_ids },
    context,
    write_policy,
    retention: { allowed_classes, max_ttl_days },
    retrieval,
    metadata: { ...metadata },
  };
  return deepFreeze({ ...body, manifest_digest: digest(body) });
}

export function assertMemoryManifest(manifest, where = {}) {
  invariant(isPlainObject(manifest), 'contract_violation', 'memory manifest must be a plain object', where);
  for (const key of MEMORY_MANIFEST_KEYS) {
    invariant(Object.prototype.hasOwnProperty.call(manifest, key), 'contract_violation', `memory manifest is missing '${key}'`, { ...where, key });
  }
  closed(manifest, MEMORY_MANIFEST_KEYS, 'memory manifest');
  const { manifest_digest, ...body } = manifest;
  const rebuilt = defineMemoryManifest(body);
  invariant(rebuilt.manifest_digest === manifest_digest, 'contract_violation', `memory '${manifest.memory_id}' manifest digest does not match`, {
    ...where, expected: rebuilt.manifest_digest, actual: manifest_digest,
  });
  return manifest;
}
