// Freeze semantics — canonical hashing and tamper detection for a baseline.
//
// A frozen baseline is the load-bearing claim of Case Study #001: "these are the
// facts we wrote down BEFORE we knew what AWE would do to them." That claim is
// only worth anything if drift is detectable, so:
//
//   * the hash is over a canonical serialization (key-sorted, no formatting) so
//     re-indenting a file does not change the hash but changing a value does;
//   * every record is hashed individually as well as collectively, so `verify`
//     names the exact file that moved;
//   * a frozen baseline cannot be re-frozen. Corrections go in as amendments
//     that reference the prior hash, so the original is never overwritten and
//     the correction is part of the permanent record.
//
// Pure except for the hash primitive. No I/O here — callers pass records in.

import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively, arrays order-preserved. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function hashRecord(record) {
  return sha256(canonicalize(record));
}

/**
 * Build a freeze receipt over a manifest + its records.
 * Records are hashed in record_id order so file-system ordering cannot change
 * the result.
 */
export function buildFreeze({ baselineId, manifest, records, frozenBy, attestation, frozenAt, priorHash = null, amendmentReason = null }) {
  const sorted = [...records].sort((a, b) => (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));
  const entries = sorted.map((r) => ({
    record_id: r.record_id,
    record_type: r.record_type,
    record_class: r.record_class,
    hash: hashRecord(r),
  }));
  const manifest_hash = hashRecord(manifest);
  const content = canonicalize({ manifest_hash, entries });
  const baseline_hash = sha256(content);

  return {
    schema: 'awe.evidence.freeze/1',
    baseline_id: baselineId,
    frozen_at: frozenAt,
    frozen_by: frozenBy,
    attestation,
    prior_hash: priorHash,
    amendment_reason: amendmentReason,
    record_count: entries.length,
    manifest_hash,
    baseline_hash,
    entries,
  };
}

/** Recompute and compare. Returns { ok, drift[] } naming exactly what moved. */
export function verifyFreeze(freeze, { manifest, records }) {
  const drift = [];
  const byId = new Map(records.map((r) => [r.record_id, r]));

  const manifestHash = hashRecord(manifest);
  if (manifestHash !== freeze.manifest_hash) {
    drift.push({ kind: 'manifest_modified', record_id: manifest.baseline_id, expected: freeze.manifest_hash, actual: manifestHash });
  }

  for (const e of freeze.entries) {
    const r = byId.get(e.record_id);
    if (!r) {
      drift.push({ kind: 'record_missing', record_id: e.record_id, expected: e.hash, actual: null });
      continue;
    }
    const h = hashRecord(r);
    if (h !== e.hash) {
      drift.push({ kind: 'record_modified', record_id: e.record_id, expected: e.hash, actual: h });
    }
    byId.delete(e.record_id);
  }
  for (const id of byId.keys()) {
    drift.push({ kind: 'record_added_after_freeze', record_id: id, expected: null, actual: hashRecord(byId.get(id)) });
  }

  const recomputed = buildFreeze({
    baselineId: freeze.baseline_id,
    manifest,
    records,
    frozenBy: freeze.frozen_by,
    attestation: freeze.attestation,
    frozenAt: freeze.frozen_at,
  });

  return {
    ok: drift.length === 0 && recomputed.baseline_hash === freeze.baseline_hash,
    drift,
    expected_hash: freeze.baseline_hash,
    actual_hash: recomputed.baseline_hash,
  };
}
