// ---------------------------------------------------------------------------
// records.mjs — the normalized context record, and the adapters that produce it.
//
// Every context source in this repository has a different shape: cognition
// markdown has headings and status tables, ADRs have a Status line, Git has
// refs, migrations have filenames that encode an ordinal. The compiler cannot
// reason about relevance while each source still wears its own clothes.
//
// A normalized record is the common shape:
//
//   { type, source_path, section, summary, evidence_status, support, tags,
//     last_verified, ref, body }
//
//   support — how much weight the record may carry, derived from evidence_status
//             rather than from tone. "reported" never becomes "verified" by
//             being written confidently.
//   tags    — the deterministic relevance surface. No embeddings: tags come from
//             the canonical vocabulary, package names, paths and identifiers
//             actually present in the text.
//
// PURE: every adapter takes text (or already-read state) and returns records.
// Reading files is fs-sources.mjs's job, which is what lets the tests drive all
// of this with synthetic input and no fixtures on disk.
// ---------------------------------------------------------------------------

import { isValidStatus, isValidRecordType, EVIDENCE_STATUSES, TRUSTED_STATUSES } from './contract.mjs';

// Terms the selector can match on. Drawn from context/AWE_UBIQUITOUS_LANGUAGE.md
// — the repository's own words, not the handoff's aspirational ones.
export const CANONICAL_TERMS = [
  'tenant', 'approval', 'policy', 'audit', 'worker', 'outcome', 'idempotency',
  'snapshot', 'resume', 'context item', 'capability', 'evidence', 'adapter',
  'handoff', 'run', 'runner', 'work request', 'email message', 'migration',
  'memory', 'execution', 'kernel', 'control plane', 'agent runtime', 'durable',
  'replay', 'lease', 'checkpoint', 'dispatch', 'journal', 'gate',
];

// Terms that name things the repository does NOT have. Matching one of these is
// itself a finding: the packet must report absence, not quietly return nothing.
export const ABSENT_TERMS = [
  'orchestration', 'responsibility', 'work_package', 'work package', 'replan',
  'objective plane', 'n8n', 'ai_egress', 'plan_valid', 'already_done',
  'externalsendingenabled',
];

export const WORKSPACE_PACKAGES = [
  'awe-kernel', 'awe-control-plane', 'awe-agent-runtime', 'awe-memory',
  'awe-execution', 'awe-runtime', 'mcp-server', 'shared', 'm365',
];

/**
 * Map an evidence status onto how much weight a record may carry.
 * This is the single place the "do not flatten narrative into fact" rule is
 * mechanized — everything downstream reads `support`, never tone.
 */
export function supportFor(status) {
  if (TRUSTED_STATUSES.has(status)) return 'verified';
  if (status === 'UNKNOWN' || status === 'REPORTED_NOT_VERIFIED') return 'reported';
  if (status === 'SUPERSEDED' || status === 'FAILED') return 'rejected';
  return 'conditional'; // GENERATED_NOT_APPLIED, MOCK_ONLY, LIVE_BLOCKED
}

export function makeRecord({
  type, source_path, section = null, summary = '', evidence_status = 'UNKNOWN',
  tags = [], last_verified = null, ref = null, body = '',
}) {
  if (!isValidRecordType(type)) throw new Error(`unknown record type: ${type}`);
  if (!source_path) throw new Error('every record needs a source_path — traceability is the point');
  const status = isValidStatus(evidence_status) ? evidence_status : 'UNKNOWN';
  return {
    type,
    source_path,
    section,
    summary: summary.trim(),
    evidence_status: status,
    support: supportFor(status),
    // Lower-case the matching surface, but never a `path:` tag — filesystem
    // paths are case-bearing, and folding them turns docs/architecture/
    // AGENT_RUNTIME.md into a file that "does not exist".
    tags: [...new Set(tags.map((t) => (t.startsWith('path:') ? t : t.toLowerCase())))].sort(),
    last_verified,
    ref,
    body,
    // Recorded so an invalid status in a source document is surfaced as a
    // warning rather than silently coerced to UNKNOWN.
    status_was_invalid: !isValidStatus(evidence_status),
  };
}

/** Split markdown into (heading, body) sections. Deterministic, no parser dep. */
export function splitSections(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let current = { heading: null, lines: [] };
  for (const line of lines) {
    const m = /^(#{1,4})\s+(.*)$/.exec(line);
    if (m) {
      if (current.heading !== null || current.lines.length) out.push(current);
      current = { heading: m[2].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.heading !== null || current.lines.length) out.push(current);
  return out.map((s) => ({ heading: s.heading, body: s.lines.join('\n').trim() }));
}

/** The strongest evidence status appearing in a block of text, if any. */
export function detectStatus(text) {
  const found = EVIDENCE_STATUSES.filter((s) => new RegExp(`\\b${s}\\b`).test(text));
  if (found.length === 0) return null;
  // Prefer the weakest claim present: a section that says both VERIFIED and
  // REPORTED_NOT_VERIFIED is not a verified section.
  const order = ['FAILED', 'SUPERSEDED', 'UNKNOWN', 'REPORTED_NOT_VERIFIED', 'LIVE_BLOCKED',
    'MOCK_ONLY', 'GENERATED_NOT_APPLIED', 'PARTIALLY_VERIFIED', 'VERIFIED'];
  return order.find((s) => found.includes(s)) || found[0];
}

/** The first ISO date in a block, used as `last_verified`. */
export function detectDate(text) {
  const m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  return m ? m[1] : null;
}

/**
 * A commit reference, used to detect stale context.
 *
 * Deliberately not "any hex-shaped token": this repository's documents are full
 * of n8n workflow IDs like `e0d2b551`, which are hex, eight characters, and not
 * commits. Reading one as a stale SHA produces a confident, wrong warning — the
 * exact thing this compiler is supposed to eliminate. So a token counts only
 * when it is a full 40-character SHA, or when the surrounding text says what it
 * is (`commit abc1234`, `@ abc1234`, `HEAD is abc1234`).
 */
export function detectCommit(text) {
  const full = /\b([0-9a-f]{40})\b/.exec(text);
  if (full) return full[1];
  // Allow the Markdown punctuation these documents actually use between the
  // label and the hash — "**Commit:** `53b8f7f`" must match, or the detector
  // fails on the very files it exists to check.
  const labelled = /(?:commit|HEAD is|HEAD|@)[\s*:`]{0,6}\b([0-9a-f]{7,40})\b/i.exec(text);
  return labelled ? labelled[1] : null;
}

/**
 * Derive tags from text. Deterministic and explainable — every tag is a term
 * that literally appears. This is what replaces an embedding model in v1.
 */
export function deriveTags(text) {
  const hay = text.toLowerCase();
  const tags = new Set();
  for (const t of CANONICAL_TERMS) if (hay.includes(t)) tags.add(t);
  for (const t of ABSENT_TERMS) if (hay.includes(t)) tags.add(t);
  for (const p of WORKSPACE_PACKAGES) if (hay.includes(p)) tags.add(p);
  // Migration ordinals: 0016, 0011 …
  for (const m of hay.matchAll(/\b(00\d{2})\b/g)) tags.add(`migration:${m[1]}`);
  // ADR references: ADR-0009
  for (const m of hay.matchAll(/\badr-(\d{4})\b/g)) tags.add(`adr:${m[1]}`);
  // Task IDs: AWE-INT-102
  for (const m of hay.matchAll(/\b(awe-int-\d{3})\b/g)) tags.add(m[1]);
  // Branch-shaped references.
  for (const m of hay.matchAll(/\b((?:codex|feat|claude|security|chore)\/[a-z0-9-]+)/g)) tags.add(`branch:${m[1]}`);
  return [...tags];
}

/** Repo-relative paths cited in a block, used for traceability and existence checks. */
export function derivePaths(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([A-Za-z0-9_@./-]+\.(?:mjs|js|ts|tsx|sql|md|json|toml|sh|yml|yaml))`/g)) {
    const p = m[1];
    if (p.startsWith('http') || !p.includes('/')) continue;
    out.add(p);
  }
  return [...out];
}

/** A one-line summary: the first substantive sentence, bounded. */
export function summarize(body, limit = 240) {
  const line = body
    .split(/\n/)
    .map((l) => l.replace(/^[|>*\-\s]+/, '').trim())
    .find((l) => l.length > 30 && !/^[-|:\s]+$/.test(l)) || body.trim().split('\n')[0] || '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
