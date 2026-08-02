// ---------------------------------------------------------------------------
// schema.mjs — the evidence record contract.
//
// The point of an evidence collector is not to produce facts. It is to produce
// facts WITH THEIR PROVENANCE, so that nothing downstream can quietly promote
// "a document said so" into "the repository is so".
//
// Every record therefore carries an `origin`:
//
//   DIRECT_INSPECTION — the collector looked. `git rev-parse` said this;
//                       the file exists; the SQL contains this statement.
//   NARRATIVE_CLAIM   — a document asserted it. It may well be true. It has not
//                       been checked, and it must never be counted as if it had.
//
// That single distinction is what stops the cognition layer drifting back into
// the thing it replaced.
//
// PURE: no I/O in this module.
// ---------------------------------------------------------------------------

export const COLLECTOR_SCHEMA_VERSION = '1.0.0';

export const ORIGINS = ['DIRECT_INSPECTION', 'NARRATIVE_CLAIM'];

export const EVIDENCE_CLASSES = [
  'git', 'package', 'migration', 'test', 'documentation', 'security',
];

export const WARNING_KINDS = [
  'unpushed_branch',
  'local_only_commit',
  'dirty_worktree',
  'undeclared_dependency',
  'migration_slot_collision',
  'mixed_migration_scheme',
  'unreproducible_claim',
  'broken_reference',
  'missing_env_example',
  'sensitive_filename',
  'public_repository_exposure',
  'side_effect_capable_script',
  'stale_reference',
  'collector_error',
];

export function isOrigin(o) { return ORIGINS.includes(o); }
export function isWarningKind(k) { return WARNING_KINDS.includes(k); }

/**
 * Build an evidence record. `origin` is required and unguessable on purpose —
 * a collector author must decide, per record, whether they looked or were told.
 */
export function record(evidenceClass, key, value, {
  origin, sourcePath = null, detail = null,
} = {}) {
  if (!EVIDENCE_CLASSES.includes(evidenceClass)) {
    throw new Error(`unknown evidence class: ${evidenceClass}`);
  }
  if (!isOrigin(origin)) {
    throw new Error(`record(${evidenceClass}.${key}) needs an explicit origin (${ORIGINS.join(' | ')})`);
  }
  return { class: evidenceClass, key, value, origin, source_path: sourcePath, detail };
}

export function warn(kind, message, { sourcePath = null, detail = null } = {}) {
  if (!isWarningKind(kind)) throw new Error(`unknown evidence warning kind: ${kind}`);
  return { kind, message, source_path: sourcePath, detail };
}

/**
 * Strip credentials from a remote URL. A collector that writes
 * `https://user:token@github.com/...` into a JSON file has leaked a token into
 * an artifact somebody will paste into a chat window.
 */
export function stripCredentials(url) {
  if (!url) return url;
  return url
    .replace(/\/\/[^/@]*@/, '//')
    .replace(/:\/\/[^/]*:[^@]*@/, '://');
}

/** Envelope shared by every collector output file. */
export function envelope(kind, commit, payload, { warnings = [], errors = [], generatedAt }) {
  if (!generatedAt) throw new Error('envelope() requires generatedAt — collectors own no clock');
  return {
    schema_version: COLLECTOR_SCHEMA_VERSION,
    kind,
    generated_at: generatedAt,
    repository_commit: commit,
    warnings,
    errors,
    ...payload,
  };
}
