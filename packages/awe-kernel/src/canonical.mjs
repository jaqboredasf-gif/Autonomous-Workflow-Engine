// ---------------------------------------------------------------------------
// canonical.mjs — deterministic value handling. The bottom layer of the kernel;
// every other module compares, hashes or freezes values through this one.
//
// `JSON.stringify` is NOT a determinism primitive: key order follows insertion
// order, `undefined` disappears silently, NaN/Infinity become `null`, and a
// cycle throws a TypeError with no useful location. Every one of those turns a
// determinism gate into a coin flip. `canonicalJson` fixes the order and turns
// the rest into loud, typed failures instead of silent corruption.
//
// PURE: no clock, no randomness, no I/O, no network. `node:crypto` is used only
// as a pure hash function.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import { KernelError } from './errors.mjs';

export const DIGEST_ALGORITHM = 'sha256';
export const DEFAULT_DIGEST_LENGTH = 16; // hex chars — 64 bits, ample for keying

export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Serialize with object keys sorted at every depth. Same value => same bytes,
// in this process and in any other. Rejects everything whose serialization
// would be lossy or ambiguous, naming the exact path so the caller can fix it.
export function canonicalJson(value) {
  const seen = new Set();

  const walk = (v, path) => {
    if (v === null) return 'null';

    const t = typeof v;

    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return JSON.stringify(v);
    if (t === 'number') {
      if (!Number.isFinite(v)) {
        throw new KernelError('invalid_input', `non-finite number at ${path}: ${v}`, { path, value: String(v) });
      }
      // -0 and 0 are the same value to every consumer; collapse so they hash alike.
      return Object.is(v, -0) ? '0' : JSON.stringify(v);
    }
    if (t === 'bigint') {
      throw new KernelError('invalid_input', `bigint is not serializable at ${path}`, { path });
    }
    if (t === 'function' || t === 'symbol' || t === 'undefined') {
      throw new KernelError('invalid_input', `${t} is not serializable at ${path}`, { path });
    }

    // Objects from here down.
    if (seen.has(v)) {
      throw new KernelError('invalid_input', `circular reference at ${path}`, { path });
    }
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const parts = v.map((item, i) => (item === undefined ? 'null' : walk(item, `${path}[${i}]`)));
        return `[${parts.join(',')}]`;
      }
      if (!isPlainObject(v)) {
        // Date/Map/Set/class instances all serialize ambiguously or lossily.
        const name = v.constructor?.name || 'object';
        throw new KernelError('invalid_input', `${name} is not canonically serializable at ${path}`, { path, kind: name });
      }
      const keys = Object.keys(v).sort();
      const parts = [];
      for (const k of keys) {
        const child = v[k];
        if (child === undefined) continue; // matches JSON.stringify: absent, not null
        parts.push(`${JSON.stringify(k)}:${walk(child, path ? `${path}.${k}` : k)}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(v);
    }
  };

  return walk(value, '$');
}

// Stable content hash. Two structurally equal values always produce the same
// digest; used for idempotency keys, event keys and report fingerprints.
export function digest(value, { length = DEFAULT_DIGEST_LENGTH } = {}) {
  if (!Number.isInteger(length) || length < 8 || length > 64) {
    throw new KernelError('invalid_input', `digest length must be an integer in [8,64], got ${length}`, { length });
  }
  return createHash(DIGEST_ALGORITHM).update(canonicalJson(value), 'utf8').digest('hex').slice(0, length);
}

// Structural equality by canonical bytes. Key order and -0/0 do not matter;
// everything else does.
export function stableEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

// Recursively freeze. Kernel contracts hand frozen envelopes back to callers so
// a downstream mutation cannot rewrite an audit trail after the fact.
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

// Structured clone through the canonical form: strips prototypes, drops
// `undefined`, and fails on anything canonicalJson refuses.
export function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

// Dotted-path read used by verify checks and gate assertions.
// `get({a:[{b:1}]}, 'a.0.b') === 1`. Missing path yields `fallback`.
export function get(target, path, fallback = undefined) {
  if (path === '' || path === undefined || path === null) return target;
  const segments = String(path).split('.');
  let cur = target;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return fallback;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i)) return fallback;
      cur = i < 0 ? cur[cur.length + i] : cur[i];
      continue;
    }
    if (typeof cur !== 'object') return fallback;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return fallback;
    cur = cur[seg];
  }
  return cur === undefined ? fallback : cur;
}
