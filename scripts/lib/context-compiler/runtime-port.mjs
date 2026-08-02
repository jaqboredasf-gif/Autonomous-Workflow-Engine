// ---------------------------------------------------------------------------
// runtime-port.mjs — the interface by which an Agent Runtime requests context.
//
// The Agent Runtime should be able to ask for an execution packet without
// knowing that packets come from Markdown files in a git working tree. So this
// module defines a PORT — a typed request/response contract plus the refusal
// rules — and takes the thing that actually produces a packet as an injected
// adapter.
//
// That shape follows packages/awe-runtime/src/service.mjs deliberately:
// "everything impure is INJECTED ... the service reads no ambient state". The
// port is pure; the filesystem adapter lives outside it. When context assembly
// eventually moves behind a real service boundary, the adapter is what changes
// and this contract does not.
//
// The important half of this module is not compilation — it is REFUSAL. A
// runtime that is handed stale or untrustworthy context and proceeds anyway is
// worse than one that gets nothing, because it produces confident work on a
// false premise. So the port refuses, with a reason, when the repository is not
// in the state the caller required.
//
// PURE: no I/O, no clock. `compile` and `now` are supplied.
// ---------------------------------------------------------------------------

import { EVIDENCE_STATUSES, TRUSTED_STATUSES } from './contract.mjs';

export const PORT_SCHEMA_VERSION = '1.0.0';

export const EVIDENCE_LEVELS = ['any', 'trusted_only', 'verified_only'];

export const REFUSAL_REASONS = [
  'DIRTY_WORKTREE',
  'BRANCH_MISMATCH',
  'COMMIT_NOT_FOUND',
  'COMMIT_MISMATCH',
  'STALE_EVIDENCE',
  'MANDATORY_SOURCE_MISSING',
  'CAPABILITY_ABSENT',
  'DISALLOWED_EVIDENCE_STATUS',
  'EXTERNAL_ARTIFACT_UNAVAILABLE',
  'COMPILATION_FAILED',
];

/** A request an Agent Runtime can make. Every field is optional except objective. */
export function newContextRequest(fields = {}) {
  return {
    schema_version: PORT_SCHEMA_VERSION,
    objective: null,
    task_id: null,
    capability: null,
    required_branch: null,
    required_commit: null,
    require_clean_worktree: false,
    max_records: 40,
    evidence_level: 'any',
    allowed_evidence_statuses: null, // null = all
    required_policies: ['AGENT_OPERATING_POLICIES'],
    output_format: 'both', // 'markdown' | 'json' | 'both'
    ...fields,
  };
}

function refusal(reason, message, detail = null) {
  return { reason, message, detail };
}

/**
 * Decide whether the repository is in a state this request can be served from.
 * Returns an array of refusals — empty means proceed.
 *
 * @param req the context request
 * @param repo { branch, commit, dirty_files, commitExists(sha), capabilities: string[] }
 */
export function evaluateRefusals(req, repo) {
  const out = [];

  if (req.require_clean_worktree && (repo.dirty_files || []).length > 0) {
    out.push(refusal('DIRTY_WORKTREE',
      `the request requires a clean worktree but ${repo.dirty_files.length} file(s) are uncommitted`,
      { dirty_files: repo.dirty_files.slice(0, 20) }));
  }

  if (req.required_branch && req.required_branch !== repo.branch) {
    out.push(refusal('BRANCH_MISMATCH',
      `the request requires branch "${req.required_branch}" but the repository is on "${repo.branch}"`,
      { required: req.required_branch, actual: repo.branch }));
  }

  if (req.required_commit) {
    if (!repo.commitExists(req.required_commit)) {
      out.push(refusal('COMMIT_NOT_FOUND',
        `the requested commit ${req.required_commit} does not exist in this repository`,
        { required: req.required_commit }));
    } else if (!String(repo.commit).startsWith(req.required_commit)) {
      out.push(refusal('COMMIT_MISMATCH',
        `the request pins commit ${req.required_commit} but HEAD is ${String(repo.commit).slice(0, 7)}`,
        { required: req.required_commit, actual: repo.commit }));
    }
  }

  // A capability the objective names but the repository does not implement. The
  // runtime must not be handed a packet that reads as if the thing exists.
  if (req.capability && Array.isArray(repo.capabilities) && !repo.capabilities.includes(req.capability)) {
    out.push(refusal('CAPABILITY_ABSENT',
      `capability "${req.capability}" has no implementation in this repository`,
      { requested: req.capability, available: repo.capabilities }));
  }

  if (req.allowed_evidence_statuses) {
    const bad = req.allowed_evidence_statuses.filter((s) => !EVIDENCE_STATUSES.includes(s));
    if (bad.length) {
      out.push(refusal('DISALLOWED_EVIDENCE_STATUS',
        `the request names evidence statuses that do not exist: ${bad.join(', ')}`,
        { invalid: bad }));
    }
  }

  if (!EVIDENCE_LEVELS.includes(req.evidence_level)) {
    out.push(refusal('DISALLOWED_EVIDENCE_STATUS',
      `evidence_level must be one of ${EVIDENCE_LEVELS.join(', ')}`,
      { given: req.evidence_level }));
  }

  return out;
}

/** Which statuses satisfy the requested evidence level? */
export function allowedStatusesFor(req) {
  if (req.allowed_evidence_statuses) return new Set(req.allowed_evidence_statuses);
  if (req.evidence_level === 'verified_only') return new Set(['VERIFIED']);
  if (req.evidence_level === 'trusted_only') return new Set(TRUSTED_STATUSES);
  return new Set(EVIDENCE_STATUSES);
}

/**
 * Serve a context request.
 *
 * @param req      the request
 * @param repo     repository observation (see evaluateRefusals)
 * @param adapter  { compile(req) -> { packet, manifest, warnings, errors } }
 * @param opts.now ISO instant, supplied by the caller
 */
export function requestContext(req, repo, adapter, { now } = {}) {
  if (!req || !req.objective) throw new Error('a context request needs an objective');
  if (!now) throw new Error('requestContext requires an explicit instant — the port owns no clock');

  const refusals = evaluateRefusals(req, repo);
  if (refusals.length) {
    return {
      schema_version: PORT_SCHEMA_VERSION,
      served_at: now,
      granted: false,
      packet: null,
      packet_id: null,
      source_manifest: null,
      warnings: [],
      refusal_reasons: refusals,
      repository_state: { branch: repo.branch, commit: repo.commit, dirty: (repo.dirty_files || []).length > 0 },
      freshness_state: null,
      conflict_state: null,
    };
  }

  let compiled;
  try {
    compiled = adapter.compile(req);
  } catch (e) {
    return {
      schema_version: PORT_SCHEMA_VERSION,
      served_at: now,
      granted: false,
      packet: null,
      packet_id: null,
      source_manifest: null,
      warnings: [],
      refusal_reasons: [refusal('COMPILATION_FAILED', `context compilation threw: ${e.message}`)],
      repository_state: { branch: repo.branch, commit: repo.commit, dirty: (repo.dirty_files || []).length > 0 },
      freshness_state: null,
      conflict_state: null,
    };
  }

  const { packet, manifest, warnings = [], errors = [] } = compiled;

  const postRefusals = [];
  if (errors.length) {
    postRefusals.push(refusal('COMPILATION_FAILED', `the compiled packet is structurally invalid`, { errors }));
  }

  // A packet must carry the policies the caller demanded. A runtime that never
  // receives its prohibitions is the most dangerous object this system can
  // produce, so a missing mandatory source is a refusal, not a warning.
  for (const p of req.required_policies || []) {
    const present = (packet?.sources || []).some((s) => String(s.source_path).includes(p));
    if (!present) {
      postRefusals.push(refusal('MANDATORY_SOURCE_MISSING',
        `the packet does not include the required source "${p}"`, { required: p }));
    }
  }

  const allowed = allowedStatusesFor(req);
  const disallowed = (packet?.sources || []).filter((s) => !allowed.has(s.evidence_status));
  if (disallowed.length && (req.allowed_evidence_statuses || req.evidence_level !== 'any')) {
    postRefusals.push(refusal('DISALLOWED_EVIDENCE_STATUS',
      `${disallowed.length} selected source(s) carry an evidence status the request excluded`,
      { statuses: [...new Set(disallowed.map((s) => s.evidence_status))] }));
  }

  const stale = warnings.filter((w) => w.kind === 'stale_source');
  if (req.evidence_level === 'verified_only' && stale.length) {
    postRefusals.push(refusal('STALE_EVIDENCE',
      `${stale.length} source(s) are stale and the request asked for verified evidence only`,
      { count: stale.length }));
  }

  const absent = warnings.filter((w) => w.kind === 'missing_capability');
  const missingArtifacts = warnings.filter((w) => w.kind === 'missing_source');

  if (postRefusals.length) {
    return {
      schema_version: PORT_SCHEMA_VERSION,
      served_at: now,
      granted: false,
      packet: null,
      packet_id: packet?.packet_id || null,
      source_manifest: manifest || null,
      warnings,
      refusal_reasons: postRefusals,
      repository_state: { branch: repo.branch, commit: repo.commit, dirty: (repo.dirty_files || []).length > 0 },
      freshness_state: { stale_sources: stale.length, absent_topics: packet?.staleness?.absent_topics || [] },
      conflict_state: { missing_artifacts: missingArtifacts.length },
    };
  }

  return {
    schema_version: PORT_SCHEMA_VERSION,
    served_at: now,
    granted: true,
    packet: req.output_format === 'markdown' ? null : packet,
    packet_id: packet.packet_id,
    source_manifest: manifest,
    warnings,
    refusal_reasons: [],
    repository_state: { branch: repo.branch, commit: repo.commit, dirty: (repo.dirty_files || []).length > 0 },
    freshness_state: {
      stale_sources: stale.length,
      absent_topics: packet.staleness?.absent_topics || [],
      newest_source_date: packet.staleness?.newest_source_date || null,
    },
    conflict_state: {
      missing_artifacts: missingArtifacts.length,
      unverified_claims: warnings.filter((w) => w.kind === 'unverified_claim').length,
      conflicting_claims: warnings.filter((w) => w.kind === 'conflicting_claim').length,
    },
  };
}
