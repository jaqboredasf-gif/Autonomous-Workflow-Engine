// ---------------------------------------------------------------------------
// evidence.ts — the audit trail.
//
// Every attempted side effect writes one immutable EvidenceRecord, including the
// refused ones. The record answers, without needing the provider: who asked,
// under which tenant and objective, with what authority, against which Microsoft
// resource, what the policy and approval said, what came back, and when.
//
// Determinism: no clock and no randomness live here. Time arrives through an
// injected Clock, and ids are derived by hashing the request identity, so the
// same slice replayed produces byte-identical evidence — which is what makes the
// deterministic tests able to assert on it at all.
//
// Tamper-evidence: records chain by hash within a tenant. Deleting or editing a
// row breaks the chain of every record after it.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import type {
  ActingPrincipal,
  CapabilityName,
  CapabilityOutcome,
  DenialReason,
  EvidenceRecord,
  FailureReason,
  GateOutcome,
  PolicyEffect,
  ApprovalState,
  ProviderFidelity,
  TargetResource,
} from './contracts.ts';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Stable JSON: object keys sorted recursively, so a hash is a function of the
 * VALUE and not of the order some adapter happened to build it in.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function hashValue(value: unknown): string {
  return sha256(stableStringify(value));
}

/** Time as an injected dependency, never `Date.now()` inside the engine. */
export interface Clock {
  now(): string;
}

/**
 * Deterministic clock: starts at a fixed instant and advances a fixed step per
 * call, so timestamps are ordered and reproducible across runs.
 */
export function createFixedClock(startIso: string, stepMs = 1000): Clock {
  let t = Date.parse(startIso);
  if (Number.isNaN(t)) throw new Error(`createFixedClock: invalid start '${startIso}'`);
  return {
    now(): string {
      const iso = new Date(t).toISOString();
      t += stepMs;
      return iso;
    },
  };
}

export interface EvidenceInput {
  readonly aweTenantId: string;
  readonly microsoftTenantId: string;
  readonly objectiveId: string;
  readonly workPackageId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly capability: CapabilityName;
  readonly capabilityVersion: number;
  readonly actingPrincipal: ActingPrincipal;
  readonly targetResource: TargetResource;
  readonly requiredScopes: readonly string[];
  readonly policyDecisionId: string;
  readonly policyEffect: PolicyEffect;
  readonly approvalId: string | null;
  readonly approvalState: ApprovalState | null;
  readonly outcome: CapabilityOutcome;
  readonly denialReason: DenialReason | null;
  readonly failureReason: FailureReason | null;
  readonly fidelity: ProviderFidelity;
  readonly microsoftResourceIds: Readonly<Record<string, string>>;
  readonly inputHash: string;
  readonly outputHash: string | null;
  readonly attempts: number;
  readonly gates: readonly GateOutcome[];
}

/**
 * Append-only evidence log. The store interface is intentionally tiny — the
 * SQL-backed implementation (m365_capability_invocations, migration 0016) has
 * the same three operations and no others. There is no update and no delete.
 */
export interface EvidenceLog {
  append(record: EvidenceRecord): void;
  /** Most recent record for a tenant, for hash chaining. */
  head(aweTenantId: string): EvidenceRecord | null;
  all(): readonly EvidenceRecord[];
  byExecution(executionId: string): readonly EvidenceRecord[];
}

export function createInMemoryEvidenceLog(): EvidenceLog {
  const records: EvidenceRecord[] = [];
  const heads = new Map<string, EvidenceRecord>();
  return {
    append(record) {
      records.push(record);
      heads.set(record.aweTenantId, record);
    },
    head: (aweTenantId) => heads.get(aweTenantId) ?? null,
    all: () => records,
    byExecution: (executionId) => records.filter((r) => r.executionId === executionId),
  };
}

export interface EvidenceWriter {
  record(input: EvidenceInput): EvidenceRecord;
  log: EvidenceLog;
}

export function createEvidenceWriter(log: EvidenceLog, clock: Clock): EvidenceWriter {
  return {
    log,
    record(input: EvidenceInput): EvidenceRecord {
      const recordedAt = clock.now();
      const previous = log.head(input.aweTenantId);
      const previousEvidenceHash = previous ? previous.evidenceHash : null;

      // The id is derived, not random: same execution + capability + attempt
      // count + outcome yields the same id, so a replayed slice is comparable.
      const evidenceId = `ev_${hashValue({
        e: input.executionId,
        c: input.capability,
        v: input.capabilityVersion,
        k: input.idempotencyKey,
        o: input.outcome,
        a: input.attempts,
        t: recordedAt,
      }).slice(0, 32)}`;

      const body = { ...input, evidenceId, recordedAt, previousEvidenceHash };
      const evidenceHash = hashValue(body);
      const record: EvidenceRecord = { ...body, evidenceHash };
      log.append(record);
      return record;
    },
  };
}

/**
 * Verify the chain for one tenant: every record must name its predecessor's hash
 * and its own hash must still match its content.
 */
export function verifyEvidenceChain(
  log: EvidenceLog,
  aweTenantId: string,
): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];
  let expectedPrevious: string | null = null;
  for (const r of log.all().filter((x) => x.aweTenantId === aweTenantId)) {
    const { evidenceHash, ...body } = r;
    if (hashValue(body) !== evidenceHash) problems.push(`${r.evidenceId}: content hash mismatch`);
    if (r.previousEvidenceHash !== expectedPrevious) {
      problems.push(`${r.evidenceId}: broken chain (expected previous ${expectedPrevious ?? 'null'})`);
    }
    expectedPrevious = evidenceHash;
  }
  return { ok: problems.length === 0, problems };
}
