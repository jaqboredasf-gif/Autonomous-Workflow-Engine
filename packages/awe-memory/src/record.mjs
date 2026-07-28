import {
  CONTEXT_SENSITIVITIES, canonicalClone, deepFreeze, digest, invariant,
  isInstant, isPlainObject, redact,
} from './kernel.mjs';
import { MEMORY_RETENTION_CLASSES } from './manifest.mjs';

export const MEMORY_RECORD_SCHEMA = 'awe.memory_record/v1';
export const MEMORY_WRITE_PROPOSAL_SCHEMA = 'awe.memory_write_proposal/v1';
export const MEMORY_WRITE_AUTHORIZATION_SCHEMA = 'awe.memory_write_authorization/v1';
export const MEMORY_RECORD_KEYS = [
  'schema', 'memory_id', 'record_id', 'version', 'org_id', 'content',
  'sensitivity', 'retention_class', 'created_at', 'expires_at', 'provenance',
  'metadata', 'supersedes_version', 'content_digest', 'record_digest',
];
export const MEMORY_WRITE_PROPOSAL_KEYS = [
  'schema', 'memory_id', 'memory_version', 'manifest_digest', 'record_id', 'org_id', 'content',
  'sensitivity', 'retention_class', 'expires_at', 'provenance', 'metadata',
  'expected_version', 'proposed_at', 'proposal_digest',
];
export const MEMORY_WRITE_AUTHORIZATION_KEYS = [
  'schema', 'proposal_digest', 'org_id', 'decision', 'actor', 'principal',
  'principal_roles', 'approved_at', 'authorization_digest',
];

const ID = /^[a-z][a-z0-9_]*$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVENANCE_KEYS = ['source_type', 'source_ref', 'run_id', 'captured_at', 'actor'];

function closed(value, allowed, label, code = 'invalid_input') {
  invariant(isPlainObject(value), code, `${label} must be a plain object`, { label });
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  invariant(unknown.length === 0, code, `${label} has unknown key(s) ${JSON.stringify(unknown)}`, { label, unknown });
}

function normalizeProvenance(value, code = 'invalid_input') {
  closed(value, PROVENANCE_KEYS, 'memory provenance', code);
  invariant(typeof value.source_type === 'string' && ID.test(value.source_type), code, 'memory provenance source_type must be snake_case', {});
  invariant(typeof value.source_ref === 'string' && value.source_ref.length > 0, code, 'memory provenance source_ref is required', {});
  invariant(value.run_id === null || (typeof value.run_id === 'string' && value.run_id.length > 0), code, 'memory provenance run_id must be a string or null', {});
  invariant(isInstant(value.captured_at), code, 'memory provenance captured_at must be an ISO instant', {});
  invariant(typeof value.actor === 'string' && value.actor.length > 0, code, 'memory provenance actor is required', {});
  return canonicalClone(redact(value));
}

function retention(retention_class, expires_at, code = 'invalid_input') {
  invariant(MEMORY_RETENTION_CLASSES.includes(retention_class), code, `memory retention class '${retention_class}' is unknown`, {});
  if (retention_class === 'legal_hold') {
    invariant(expires_at === null, code, 'legal_hold memory must not expire', {});
  } else {
    invariant(isInstant(expires_at), code, `${retention_class} memory requires expires_at`, {});
  }
}

export function defineMemoryRecord(spec = {}) {
  closed(spec, MEMORY_RECORD_KEYS.filter((key) => !['content_digest', 'record_digest'].includes(key)), 'memory record');
  invariant(spec.schema === undefined || spec.schema === MEMORY_RECORD_SCHEMA, 'invalid_input', `memory record schema must be '${MEMORY_RECORD_SCHEMA}'`, {});
  invariant(typeof spec.memory_id === 'string' && ID.test(spec.memory_id), 'invalid_input', 'memory record memory_id must be snake_case', {});
  invariant(typeof spec.record_id === 'string' && RECORD_ID.test(spec.record_id), 'invalid_input', 'memory record_id must be a short opaque identifier', {});
  invariant(Number.isInteger(spec.version) && spec.version >= 1, 'invalid_input', 'memory record version must be an integer >= 1', {});
  invariant(typeof spec.org_id === 'string' && spec.org_id.length > 0, 'invalid_input', 'memory record requires org_id', {});
  invariant(typeof spec.content === 'string' && spec.content.length > 0, 'invalid_input', 'memory record content is required', {});
  invariant(CONTEXT_SENSITIVITIES.includes(spec.sensitivity), 'invalid_input', 'memory record sensitivity is unknown', {});
  invariant(isInstant(spec.created_at), 'invalid_input', 'memory record created_at must be an ISO instant', {});
  retention(spec.retention_class, spec.expires_at);
  const expectedSupersedes = spec.version === 1 ? null : spec.version - 1;
  invariant(spec.supersedes_version === expectedSupersedes, 'invalid_input', `memory record v${spec.version} must supersede ${expectedSupersedes}`, {});
  const safeContent = String(redact(spec.content));
  const provenance = normalizeProvenance(spec.provenance);
  const metadata = canonicalClone(redact(spec.metadata ?? {}));
  invariant(isPlainObject(metadata), 'invalid_input', 'memory record metadata must be a plain object', {});
  const body = {
    schema: MEMORY_RECORD_SCHEMA,
    memory_id: spec.memory_id,
    record_id: spec.record_id,
    version: spec.version,
    org_id: spec.org_id,
    content: safeContent,
    sensitivity: spec.sensitivity,
    retention_class: spec.retention_class,
    created_at: spec.created_at,
    expires_at: spec.expires_at,
    provenance,
    metadata,
    supersedes_version: spec.supersedes_version,
    content_digest: digest(safeContent),
  };
  return deepFreeze({ ...body, record_digest: digest(body) });
}

export function assertMemoryRecord(record, where = {}) {
  closed(record, MEMORY_RECORD_KEYS, 'memory record', 'contract_violation');
  for (const key of MEMORY_RECORD_KEYS) invariant(Object.prototype.hasOwnProperty.call(record, key), 'contract_violation', `memory record is missing '${key}'`, { ...where, key });
  const { content_digest, record_digest, ...input } = record;
  const rebuilt = defineMemoryRecord(input);
  invariant(rebuilt.content_digest === content_digest && rebuilt.record_digest === record_digest, 'contract_violation', 'memory record digest does not match its content', where);
  return record;
}

export function defineMemoryWriteProposal(spec = {}) {
  closed(spec, MEMORY_WRITE_PROPOSAL_KEYS.filter((key) => key !== 'proposal_digest'), 'memory write proposal');
  invariant(spec.schema === undefined || spec.schema === MEMORY_WRITE_PROPOSAL_SCHEMA, 'invalid_input', `memory proposal schema must be '${MEMORY_WRITE_PROPOSAL_SCHEMA}'`, {});
  invariant(typeof spec.memory_id === 'string' && ID.test(spec.memory_id), 'invalid_input', 'memory proposal memory_id must be snake_case', {});
  invariant(typeof spec.memory_version === 'string' && /^\d+\.\d+\.\d+$/.test(spec.memory_version), 'invalid_input', 'memory proposal version must be pinned semver', {});
  invariant(typeof spec.manifest_digest === 'string' && spec.manifest_digest.length > 0, 'invalid_input', 'memory proposal requires manifest_digest', {});
  invariant(typeof spec.record_id === 'string' && RECORD_ID.test(spec.record_id), 'invalid_input', 'memory proposal record_id is invalid', {});
  invariant(typeof spec.org_id === 'string' && spec.org_id.length > 0, 'invalid_input', 'memory proposal requires org_id', {});
  invariant(typeof spec.content === 'string' && spec.content.length > 0, 'invalid_input', 'memory proposal content is required', {});
  invariant(CONTEXT_SENSITIVITIES.includes(spec.sensitivity), 'invalid_input', 'memory proposal sensitivity is unknown', {});
  retention(spec.retention_class, spec.expires_at);
  invariant(Number.isInteger(spec.expected_version) && spec.expected_version >= 0, 'invalid_input', 'memory proposal expected_version must be an integer >= 0', {});
  invariant(isInstant(spec.proposed_at), 'invalid_input', 'memory proposal proposed_at must be an ISO instant', {});
  const body = {
    schema: MEMORY_WRITE_PROPOSAL_SCHEMA,
    memory_id: spec.memory_id,
    memory_version: spec.memory_version,
    manifest_digest: spec.manifest_digest,
    record_id: spec.record_id,
    org_id: spec.org_id,
    content: String(redact(spec.content)),
    sensitivity: spec.sensitivity,
    retention_class: spec.retention_class,
    expires_at: spec.expires_at,
    provenance: normalizeProvenance(spec.provenance),
    metadata: canonicalClone(redact(spec.metadata ?? {})),
    expected_version: spec.expected_version,
    proposed_at: spec.proposed_at,
  };
  invariant(isPlainObject(body.metadata), 'invalid_input', 'memory proposal metadata must be a plain object', {});
  return deepFreeze({ ...body, proposal_digest: digest(body) });
}

export function assertMemoryWriteProposal(proposal, where = {}) {
  closed(proposal, MEMORY_WRITE_PROPOSAL_KEYS, 'memory write proposal', 'contract_violation');
  for (const key of MEMORY_WRITE_PROPOSAL_KEYS) invariant(Object.prototype.hasOwnProperty.call(proposal, key), 'contract_violation', `memory proposal is missing '${key}'`, { ...where, key });
  const { proposal_digest, ...input } = proposal;
  const rebuilt = defineMemoryWriteProposal(input);
  invariant(rebuilt.proposal_digest === proposal_digest, 'contract_violation', 'memory proposal digest does not match its content', where);
  return proposal;
}

export function defineMemoryWriteAuthorization(spec = {}) {
  closed(spec, MEMORY_WRITE_AUTHORIZATION_KEYS.filter((key) => key !== 'authorization_digest'), 'memory write authorization');
  invariant(spec.schema === undefined || spec.schema === MEMORY_WRITE_AUTHORIZATION_SCHEMA, 'invalid_input', `memory authorization schema must be '${MEMORY_WRITE_AUTHORIZATION_SCHEMA}'`, {});
  invariant(typeof spec.proposal_digest === 'string' && spec.proposal_digest.length > 0, 'invalid_input', 'memory authorization requires proposal_digest', {});
  invariant(typeof spec.org_id === 'string' && spec.org_id.length > 0, 'invalid_input', 'memory authorization requires org_id', {});
  invariant(spec.decision === 'approve', 'invalid_input', 'memory writes require an approve decision', {});
  invariant(spec.actor === 'human', 'invalid_input', 'memory writes may only be approved by a human', {});
  invariant(typeof spec.principal === 'string' && spec.principal.length > 0, 'invalid_input', 'memory authorization requires a named principal', {});
  invariant(Array.isArray(spec.principal_roles) && spec.principal_roles.length > 0, 'invalid_input', 'memory authorization requires principal_roles', {});
  const principal_roles = [...spec.principal_roles].sort();
  invariant(principal_roles.every((role) => typeof role === 'string' && ID.test(role)), 'invalid_input', 'memory authorization roles must be snake_case', {});
  invariant(new Set(principal_roles).size === principal_roles.length, 'invalid_input', 'memory authorization roles contain a duplicate', {});
  invariant(isInstant(spec.approved_at), 'invalid_input', 'memory authorization approved_at must be an ISO instant', {});
  const body = {
    schema: MEMORY_WRITE_AUTHORIZATION_SCHEMA,
    proposal_digest: spec.proposal_digest,
    org_id: spec.org_id,
    decision: 'approve',
    actor: 'human',
    principal: spec.principal,
    principal_roles,
    approved_at: spec.approved_at,
  };
  return deepFreeze({ ...body, authorization_digest: digest(body) });
}

export function assertMemoryWriteAuthorization(authorization, where = {}) {
  closed(authorization, MEMORY_WRITE_AUTHORIZATION_KEYS, 'memory write authorization', 'contract_violation');
  for (const key of MEMORY_WRITE_AUTHORIZATION_KEYS) invariant(Object.prototype.hasOwnProperty.call(authorization, key), 'contract_violation', `memory authorization is missing '${key}'`, { ...where, key });
  const { authorization_digest, ...input } = authorization;
  const rebuilt = defineMemoryWriteAuthorization(input);
  invariant(rebuilt.authorization_digest === authorization_digest, 'contract_violation', 'memory authorization digest does not match its content', where);
  return authorization;
}
