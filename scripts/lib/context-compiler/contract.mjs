// ---------------------------------------------------------------------------
// contract.mjs — the versioned Execution Packet contract.
//
// A packet is what an agent is handed instead of a conversation. Everything an
// agent needs to start productive work, and nothing it does not: the objective,
// the verified state, the files that matter, the policies it may not break, and
// — the part that makes it trustworthy rather than merely convenient — a source
// reference for every claim inside it.
//
// The contract is versioned because packets outlive the session that produced
// them. A packet written today may be read by a runtime worker, an n8n job, or a
// service in six months; SCHEMA_VERSION is how that reader knows whether it
// understands the shape it was given.
//
// The design rule that matters most here: a packet may never flatten an
// unsupported claim into a fact. Every context record carries an evidence
// status from the same vocabulary the cognition layer uses, and a record whose
// status is REPORTED_NOT_VERIFIED reaches the agent still wearing that label.
// Silently dropping such a record would be worse than including it — the agent
// would not know the question had been asked.
//
// PURE: no clock, no filesystem, no randomness. Callers supply `generated_at`.
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = '1.0.0';

// The evidence vocabulary. Identical to the one enforced by
// scripts/lib/context-validator.mjs — one vocabulary, two enforcement points.
export const EVIDENCE_STATUSES = [
  'VERIFIED',
  'PARTIALLY_VERIFIED',
  'REPORTED_NOT_VERIFIED',
  'GENERATED_NOT_APPLIED',
  'MOCK_ONLY',
  'LIVE_BLOCKED',
  'FAILED',
  'SUPERSEDED',
  'UNKNOWN',
];

// Statuses that may be relied on without a caveat. Everything else is included
// but must be flagged — see select.mjs.
export const TRUSTED_STATUSES = new Set(['VERIFIED', 'PARTIALLY_VERIFIED']);

// What KIND of source a normalized record came from. Kept small on purpose: a
// long enum is a taxonomy nobody maintains.
export const RECORD_TYPES = [
  'cognition',   // context/*.md
  'evidence',    // docs/integration/*.md ledgers and registers
  'decision',    // docs/architecture/decisions/*.md
  'git',         // branch, commit, dirty state
  'package',     // workspace package metadata
  'migration',   // supabase/migrations/*.sql
  'test',        // runners and evaluators
  'dispatch',    // dispatch queue entries
  'objective',   // the human-supplied objective text
];

// Warning classes the compiler can emit. The CLI writes these to warnings.json;
// they are the packet's own account of what it could not stand behind.
export const WARNING_KINDS = [
  'missing_source',
  'stale_source',
  'conflicting_claim',
  'unverified_claim',
  'dirty_git_state',
  'branch_mismatch',
  'missing_test',
  'invalid_evidence_status',
  'missing_capability',
];

export function isValidStatus(s) {
  return EVIDENCE_STATUSES.includes(s);
}

export function isValidRecordType(t) {
  return RECORD_TYPES.includes(t);
}

export function isValidWarningKind(k) {
  return WARNING_KINDS.includes(k);
}

/**
 * Build a warning. Throws on an unknown kind rather than emitting a warning
 * nobody downstream can branch on — an unrecognized warning class is a bug in
 * the compiler, not a finding about the repository.
 */
export function warning(kind, message, { source = null, detail = null } = {}) {
  if (!isValidWarningKind(kind)) {
    throw new Error(`unknown warning kind: ${kind} (expected one of ${WARNING_KINDS.join(', ')})`);
  }
  return { kind, message, source, detail };
}

// The fields every packet carries. Exported so the renderer, the tests and any
// future consumer agree on one list instead of three drifting ones.
export const PACKET_FIELDS = [
  'schema_version', 'packet_id', 'generated_at',
  'repository', 'branch', 'commit',
  'objective', 'task_id', 'capability',
  'current_state', 'relevant_files', 'relevant_packages',
  'applicable_decisions', 'applicable_policies',
  'required_evidence', 'allowed_actions', 'forbidden_actions',
  'known_blockers', 'required_tests', 'definition_of_done',
  'required_handoff_format', 'sources', 'evidence_summary',
  'warnings', 'staleness',
];

/**
 * Structural validation of an assembled packet. This is not a schema library —
 * it is the smallest check that catches the failures we actually care about:
 * a missing field, an invented evidence status, or a claim with no source.
 */
export function validatePacket(packet) {
  const errors = [];
  for (const f of PACKET_FIELDS) {
    if (!(f in packet)) errors.push(`missing field: ${f}`);
  }
  if (packet.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEMA_VERSION}, got ${packet.schema_version}`);
  }
  for (const s of packet.sources || []) {
    if (!isValidStatus(s.evidence_status)) {
      errors.push(`source ${s.source_path}: invalid evidence status "${s.evidence_status}"`);
    }
    if (!s.source_path) errors.push('a source has no source_path — every claim must be traceable');
  }
  for (const w of packet.warnings || []) {
    if (!isValidWarningKind(w.kind)) errors.push(`invalid warning kind: ${w.kind}`);
  }
  // A packet with no policies is a packet that forgot the point. Policies are
  // mandatory regardless of what the objective says (see select.mjs).
  if (!packet.applicable_policies || packet.applicable_policies.length === 0) {
    errors.push('applicable_policies is empty — operating policies are mandatory in every packet');
  }
  if (!packet.forbidden_actions || packet.forbidden_actions.length === 0) {
    errors.push('forbidden_actions is empty — prohibitions are mandatory in every packet');
  }
  return errors;
}
