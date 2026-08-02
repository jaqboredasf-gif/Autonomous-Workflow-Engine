// ---------------------------------------------------------------------------
// select.mjs — deterministic relevance selection.
//
// The whole value of a packet is that it is SMALL and still sufficient. Dumping
// every cognition file into every packet would technically satisfy "the agent
// has the context" while destroying the reason to compile one at all.
//
// Selection here is rule-based and explainable. Every included record carries a
// `why` array naming the signals that pulled it in, so a human reading
// source-manifest.json can audit the compiler's judgement rather than trusting
// it. No embeddings, no model call, no vector store: the same objective against
// the same commit must produce the same packet, or a packet cannot be evidence.
//
// Two rules override relevance entirely:
//
//   MANDATORY  — operating policies, repository identity and critical blockers
//                are in every packet whether or not the objective mentions them.
//                An agent that was never told what it may not do is more
//                dangerous than one with no context at all.
//   ABSENCE    — an objective about something the repository does not have
//                (n8n, the Orchestration Plane) must return a stated absence,
//                never an empty section. Silence reads as "nothing to worry
//                about"; that is the failure this compiler exists to prevent.
//
// PURE: no I/O, no clock.
// ---------------------------------------------------------------------------

import { warning } from './contract.mjs';
import { ABSENT_TERMS, CANONICAL_TERMS, WORKSPACE_PACKAGES } from './records.mjs';

// Scoring weights. Deliberately coarse — a finer scale would imply a precision
// this method does not have.
const W = {
  exact_term: 10,       // an objective word appears verbatim in the record
  tag_match: 8,         // a derived tag matches an objective tag
  canonical_term: 6,    // shared canonical vocabulary
  package_name: 7,      // the record is about a package the objective names
  migration_id: 12,     // migration ordinals are highly specific
  adr_ref: 9,
  task_id: 12,
  branch_ref: 7,
  path_ref: 6,
  absent_term: 11,      // objective asks about something known to be missing
  verified_bonus: 4,    // prefer verified evidence
  reported_penalty: -3, // include, but rank below verified
  rejected_penalty: -8, // SUPERSEDED / FAILED rank last but are not dropped
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'without',
  'this', 'that', 'it', 'is', 'are', 'be', 'by', 'from', 'as', 'at', 'any', 'all',
  'do', 'not', 'no', 'into', 'how', 'should', 'must', 'may', 'produce', 'identify',
]);

export function tokenize(objective) {
  return [...new Set(
    objective.toLowerCase().replace(/[^a-z0-9_\-/.]+/g, ' ').split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  )];
}

/** Tags implied by the objective itself, using the same derivation as records. */
export function objectiveTags(objective) {
  const hay = objective.toLowerCase();
  const tags = new Set();
  for (const t of [...CANONICAL_TERMS, ...ABSENT_TERMS, ...WORKSPACE_PACKAGES]) {
    if (hay.includes(t)) tags.add(t);
  }
  for (const m of hay.matchAll(/\b(00\d{2})\b/g)) tags.add(`migration:${m[1]}`);
  for (const m of hay.matchAll(/\badr-(\d{4})\b/g)) tags.add(`adr:${m[1]}`);
  for (const m of hay.matchAll(/\b(awe-int-\d{3})\b/g)) tags.add(m[1]);
  for (const m of hay.matchAll(/\b((?:codex|feat|claude|security|chore)\/[a-z0-9-]+)/g)) tags.add(`branch:${m[1]}`);
  return [...tags];
}

/** Which absent capabilities does this objective ask about? */
export function detectAbsentTopics(objective) {
  const hay = objective.toLowerCase();
  return ABSENT_TERMS.filter((t) => hay.includes(t));
}

function scoreRecord(record, tokens, objTags) {
  let score = 0;
  const why = [];
  const hay = `${record.section || ''} ${record.summary} ${record.body}`.toLowerCase();

  for (const t of tokens) {
    if (hay.includes(t)) { score += W.exact_term; why.push(`term:${t}`); }
  }
  for (const t of objTags) {
    if (record.tags.includes(t)) {
      const w = t.startsWith('migration:') ? W.migration_id
        : t.startsWith('adr:') ? W.adr_ref
          : t.startsWith('branch:') ? W.branch_ref
            : /^awe-int-\d{3}$/.test(t) ? W.task_id
              : WORKSPACE_PACKAGES.includes(t) ? W.package_name
                : ABSENT_TERMS.includes(t) ? W.absent_term
                  : CANONICAL_TERMS.includes(t) ? W.canonical_term : W.tag_match;
      score += w;
      why.push(`tag:${t}`);
    }
  }
  for (const tag of record.tags) {
    if (tag.startsWith('path:') && tokens.some((t) => tag.slice(5).toLowerCase().includes(t))) {
      score += W.path_ref; why.push(tag);
    }
  }

  if (record.support === 'verified') { score += W.verified_bonus; why.push('support:verified'); }
  else if (record.support === 'reported') { score += W.reported_penalty; why.push('support:reported'); }
  else if (record.support === 'rejected') { score += W.rejected_penalty; why.push('support:rejected'); }

  return { score, why: [...new Set(why)] };
}

/**
 * Is this record mandatory regardless of the objective?
 * Policies, repository identity, and blockers. Kept as one predicate so the
 * rule is stated once and testable directly.
 */
export function isMandatory(record) {
  if (record.type === 'git') return true;
  if (record.type === 'objective') return true;
  if (/AGENT_OPERATING_POLICIES/.test(record.source_path)) return true;
  if (/AWE_IDENTITY/.test(record.source_path) && /working rules|constitutional/i.test(record.section || '')) return true;
  if (/blocker/i.test(record.section || '')) return true;
  return false;
}

/**
 * Select the records that belong in the packet.
 *
 * @param records  normalized records from the adapters
 * @param objective human-defined objective text
 * @param opts.limit maximum non-mandatory records (the "smallest trustworthy" knob)
 * @param opts.minScore score below which a record is not relevant
 * @param opts.knownPaths paths that exist in the repo, for missing-reference detection
 * @param opts.currentCommit for staleness detection
 * @param opts.knownBranches for branch-existence detection
 */
export function select(records, objective, {
  limit = 40, minScore = 8, knownPaths = null, currentCommit = null, knownBranches = null,
} = {}) {
  const tokens = tokenize(objective);
  const objTags = objectiveTags(objective);
  const warnings = [];

  const scored = records.map((r) => {
    const { score, why } = scoreRecord(r, tokens, objTags);
    const mandatory = isMandatory(r);
    return { record: r, score, why: mandatory ? [...why, 'mandatory'] : why, mandatory };
  });

  const mandatory = scored.filter((s) => s.mandatory);
  const relevant = scored
    .filter((s) => !s.mandatory && s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.record.source_path.localeCompare(b.record.source_path));

  const dropped = relevant.length - Math.min(relevant.length, limit);
  const chosen = [...mandatory, ...relevant.slice(0, limit)];

  if (dropped > 0) {
    warnings.push(warning('missing_source',
      `${dropped} relevant record(s) exceeded the packet limit of ${limit} and were omitted`,
      { detail: { limit, dropped } }));
  }

  // --- absence reporting ------------------------------------------------
  // If the objective asks about something the repository does not have, say so
  // explicitly. An empty section is not an answer.
  const absentTopics = detectAbsentTopics(objective);
  for (const topic of absentTopics) {
    const hasEvidence = chosen.some((s) => s.record.tags.includes(topic) && s.record.support === 'verified');
    if (!hasEvidence) {
      warnings.push(warning('missing_capability',
        `the objective references "${topic}", which has no code-backed implementation in this repository`,
        { detail: { topic, see: 'context/AWE_UBIQUITOUS_LANGUAGE.md — Terms that DO NOT EXIST in code' } }));
    }
  }

  // --- evidence quality -------------------------------------------------
  for (const s of chosen) {
    const r = s.record;
    if (r.status_was_invalid) {
      warnings.push(warning('invalid_evidence_status',
        `${r.source_path}${r.section ? ` § ${r.section}` : ''} declares an evidence status outside the allowed set; treated as UNKNOWN`,
        { source: r.source_path }));
    }
    if (r.support === 'reported') {
      warnings.push(warning('unverified_claim',
        `${r.source_path}${r.section ? ` § ${r.section}` : ''} is ${r.evidence_status} — included, but must not be relied on as fact`,
        { source: r.source_path }));
    }
    if (r.support === 'rejected') {
      warnings.push(warning('conflicting_claim',
        `${r.source_path}${r.section ? ` § ${r.section}` : ''} is ${r.evidence_status} — a superseded or failed claim; do not act on it`,
        { source: r.source_path }));
    }
    if (currentCommit && r.ref && r.ref.length >= 7 && !currentCommit.startsWith(r.ref) && r.type !== 'git') {
      warnings.push(warning('stale_source',
        `${r.source_path} references commit ${r.ref}, but HEAD is ${currentCommit.slice(0, 7)}`,
        { source: r.source_path, detail: { referenced: r.ref, current: currentCommit.slice(0, 7) } }));
    }
    if (knownPaths) {
      for (const tag of r.tags) {
        if (!tag.startsWith('path:')) continue;
        const p = tag.slice(5);
        if (!knownPaths.has(p)) {
          warnings.push(warning('missing_source',
            `${r.source_path} references ${p}, which does not exist at this commit`,
            { source: r.source_path, detail: { referenced: p } }));
        }
      }
    }
    if (knownBranches) {
      for (const tag of r.tags) {
        if (!tag.startsWith('branch:')) continue;
        const b = tag.slice(7);
        if (!knownBranches.has(b)) {
          warnings.push(warning('branch_mismatch',
            `${r.source_path} references branch "${b}", which does not exist locally or on origin`,
            { source: r.source_path, detail: { referenced: b } }));
        }
      }
    }
  }

  // De-duplicate: the same finding from many records is one finding.
  const seen = new Set();
  const uniqueWarnings = warnings.filter((w) => {
    const k = `${w.kind}::${w.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { selected: chosen, warnings: uniqueWarnings, tokens, objectiveTags: objTags, absentTopics };
}
