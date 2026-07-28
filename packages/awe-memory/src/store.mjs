import {
  canonicalClone, invariant, isInstant, isPlainObject, instantEpochSeconds,
} from './kernel.mjs';
import { assertMemoryRecord } from './record.mjs';

export const MEMORY_STORE_METHODS = ['write', 'read', 'latest', 'list', 'expire'];

function recordKey({ org_id, memory_id, record_id }) {
  return `${org_id}\u0000${memory_id}\u0000${record_id}`;
}

function validateRequest(request, { record = false, version = false, as_of = false } = {}) {
  invariant(isPlainObject(request), 'invalid_input', 'memory store request must be a plain object', {});
  for (const key of ['org_id', 'memory_id']) invariant(typeof request[key] === 'string' && request[key].length > 0, 'invalid_input', `memory store request needs ${key}`, {});
  if (record) invariant(typeof request.record_id === 'string' && request.record_id.length > 0, 'invalid_input', 'memory store request needs record_id', {});
  if (version) invariant(Number.isInteger(request.version) && request.version >= 1, 'invalid_input', 'memory store version must be >= 1', {});
  if (as_of) invariant(isInstant(request.as_of), 'invalid_input', 'memory store as_of must be an ISO instant', {});
}

function isExpired(record, as_of) {
  return record.expires_at !== null
    && instantEpochSeconds(record.expires_at) <= instantEpochSeconds(as_of);
}

export function createInMemoryRecordStore(seed = []) {
  const records = new Map();
  const tombstones = new Set();

  function write(record, { expected_version = record.version - 1 } = {}) {
    assertMemoryRecord(record, { at: 'memory_store.write' });
    invariant(Number.isInteger(expected_version) && expected_version >= 0, 'invalid_input', 'expected_version must be >= 0', {});
    const key = recordKey(record);
    const versions = records.get(key) ?? new Map();
    const current = versions.size === 0 ? 0 : Math.max(...versions.keys());
    if (current !== expected_version || record.version !== expected_version + 1) {
      return { ok: false, reason: 'memory_version_conflict', current_version: current, record: null };
    }
    versions.set(record.version, canonicalClone(record));
    records.set(key, versions);
    tombstones.delete(key);
    return { ok: true, reason: null, current_version: record.version, record: canonicalClone(record) };
  }

  for (const record of seed) {
    const result = write(record);
    invariant(result.ok, 'invalid_input', `seed memory record '${record.record_id}' has a version gap`, {});
  }

  function read(request = {}) {
    validateRequest(request, { record: true, version: true });
    const key = recordKey(request);
    if (tombstones.has(key)) return null;
    const found = records.get(key)?.get(request.version);
    return found === undefined ? null : canonicalClone(found);
  }

  function latest(request = {}) {
    validateRequest(request, { record: true });
    const key = recordKey(request);
    if (tombstones.has(key)) return null;
    const versions = records.get(key);
    if (versions === undefined) return null;
    const version = Math.max(...versions.keys());
    return canonicalClone(versions.get(version));
  }

  function list(request = {}) {
    validateRequest(request, { as_of: request.as_of !== undefined });
    const found = [];
    for (const [key, versions] of records) {
      if (tombstones.has(key)) continue;
      const record = versions.get(Math.max(...versions.keys()));
      if (record.org_id !== request.org_id || record.memory_id !== request.memory_id) continue;
      if (request.as_of !== undefined && isExpired(record, request.as_of)) continue;
      found.push(canonicalClone(record));
    }
    return found.sort((a, b) => a.record_id.localeCompare(b.record_id));
  }

  function expire(request = {}) {
    validateRequest(request, { as_of: true });
    const expired = [];
    for (const [key, versions] of records) {
      const record = versions.get(Math.max(...versions.keys()));
      if (
        record.org_id !== request.org_id
        || record.memory_id !== request.memory_id
        || isExpired(record, request.as_of) === false
      ) continue;
      tombstones.add(key);
      expired.push({ memory_id: record.memory_id, record_id: record.record_id, version: record.version });
    }
    return expired.sort((a, b) => `${a.memory_id}:${a.record_id}`.localeCompare(`${b.memory_id}:${b.record_id}`));
  }

  return Object.freeze({ kind: 'memory_store', name: 'memory', write, read, latest, list, expire });
}

export function defineMemoryStore(impl) {
  invariant(isPlainObject(impl), 'invalid_input', 'memory store must be a plain object', {});
  invariant(typeof impl.name === 'string' && /^[a-z][a-z0-9_]*$/.test(impl.name), 'invalid_input', 'memory store needs a snake_case name', {});
  for (const method of MEMORY_STORE_METHODS) invariant(typeof impl[method] === 'function', 'invalid_input', `memory store '${impl.name}' needs ${method}()`, {});
  return Object.freeze({
    kind: 'memory_store',
    name: impl.name,
    write(record, options = {}) {
      assertMemoryRecord(record, { at: `memory_store:${impl.name}` });
      const result = impl.write(record, options);
      invariant(isPlainObject(result) && typeof result.ok === 'boolean', 'contract_violation', `memory store '${impl.name}' write result is invalid`, {});
      if (result.ok === true) {
        assertMemoryRecord(result.record, { at: `memory_store:${impl.name}.write` });
        invariant(
          result.record.org_id === record.org_id
          && result.record.memory_id === record.memory_id
          && result.record.record_id === record.record_id
          && result.record.version === record.version,
          'contract_violation', `memory store '${impl.name}' write returned a different record`, {},
        );
      }
      return result;
    },
    read(request) {
      validateRequest(request, { record: true, version: true });
      const result = impl.read(request);
      if (result === null) return null;
      assertMemoryRecord(result, { at: `memory_store:${impl.name}.read` });
      invariant(
        result.org_id === request.org_id
        && result.memory_id === request.memory_id
        && result.record_id === request.record_id
        && result.version === request.version,
        'contract_violation', `memory store '${impl.name}' read crossed an identity boundary`, {},
      );
      return result;
    },
    latest(request) {
      validateRequest(request, { record: true });
      const result = impl.latest(request);
      if (result === null) return null;
      assertMemoryRecord(result, { at: `memory_store:${impl.name}.latest` });
      invariant(
        result.org_id === request.org_id
        && result.memory_id === request.memory_id
        && result.record_id === request.record_id,
        'contract_violation', `memory store '${impl.name}' latest crossed an identity boundary`, {},
      );
      return result;
    },
    list(request) {
      validateRequest(request, { as_of: request?.as_of !== undefined });
      const result = impl.list(request);
      invariant(Array.isArray(result), 'contract_violation', `memory store '${impl.name}' list must return an array`, {});
      for (const record of result) {
        assertMemoryRecord(record, { at: `memory_store:${impl.name}.list` });
        invariant(
          record.org_id === request.org_id && record.memory_id === request.memory_id,
          'contract_violation', `memory store '${impl.name}' list crossed a tenant or memory boundary`, {},
        );
        if (request.as_of !== undefined) {
          invariant(!isExpired(record, request.as_of), 'contract_violation', `memory store '${impl.name}' returned an expired record`, {});
        }
      }
      return result;
    },
    expire(request) {
      validateRequest(request, { as_of: true });
      const result = impl.expire(request);
      invariant(Array.isArray(result), 'contract_violation', `memory store '${impl.name}' expire must return an array`, {});
      return result;
    },
  });
}
