// ---------------------------------------------------------------------------
// registry.mjs — a machine-readable index of the cognition layer.
//
// The Context Compiler currently re-reads and re-parses every cognition file on
// every invocation. That is fine at this size and will not stay fine. More
// importantly, a compiler that parses on demand has nowhere to record what it
// learned: which document cites which branch, which section went stale, which
// two documents disagree.
//
// The registry is that record. It is derived — never authored — so it can always
// be regenerated from the canonical Markdown, and it is written under the
// gitignored .awe/ precisely so nobody is tempted to edit it and create a second
// truth.
//
// PURE: builds from supplied documents plus a supplied repository observation.
// ---------------------------------------------------------------------------

import { digest } from '../../../packages/awe-kernel/src/canonical.mjs';
import { splitSections, detectStatus, detectDate, detectCommit, deriveTags } from '../context-compiler/records.mjs';
import { EVIDENCE_STATUSES } from '../context-compiler/contract.mjs';

export const REGISTRY_SCHEMA_VERSION = '1.0.0';

export const FRESHNESS = ['CURRENT', 'ANCESTOR_CLEAN', 'STALE', 'UNKNOWN_REF', 'UNDATED'];

/**
 * Build registry entries for one document.
 *
 * @param path      canonical repo-relative path
 * @param text      file contents
 * @param obs       { lastCommitFor(path), classifyRef(sha), branchExists(name),
 *                    pathExists(p), currentCommit }
 */
export function indexDocument(path, text, obs) {
  const fileDate = detectDate(text);
  const lastCommit = obs.lastCommitFor(path);
  const sections = splitSections(text).filter((s) => s.heading && s.body.trim().length > 0);

  return sections.map((s) => {
    const body = s.body;
    const tags = deriveTags(`${s.heading} ${body}`);
    const statuses = EVIDENCE_STATUSES.filter((st) => new RegExp(`\\b${st}\\b`).test(body));
    const refCommit = detectCommit(body) || detectCommit(text);
    const branches = tags.filter((t) => t.startsWith('branch:')).map((t) => t.slice(7));
    const migrations = tags.filter((t) => t.startsWith('migration:')).map((t) => t.slice(10));
    const tasks = tags.filter((t) => /^awe-[a-z]+-\d{3}$/.test(t));
    const packages = tags.filter((t) => /^(awe-[a-z-]+|mcp-server|shared|m365)$/.test(t));

    const missingBranches = branches.filter((b) => !obs.branchExists(b));
    const refClass = refCommit ? obs.classifyRef(refCommit) : null;

    let freshness = 'UNDATED';
    if (!refCommit) freshness = fileDate ? 'UNDATED' : 'UNDATED';
    else if (refClass === 'current') freshness = 'CURRENT';
    else if (refClass === 'fresh') freshness = 'ANCESTOR_CLEAN';
    else if (refClass === 'stale') freshness = 'STALE';
    else freshness = 'UNKNOWN_REF';

    return {
      document: path,
      section: s.heading,
      canonical_path: path,
      content_hash: digest({ path, section: s.heading, body }),
      last_commit: lastCommit,
      evidence_statuses: statuses,
      referenced_packages: packages,
      referenced_branches: branches,
      referenced_commits: refCommit ? [refCommit] : [],
      referenced_migrations: migrations,
      referenced_tasks: tasks,
      vocabulary_terms: tags.filter((t) => !t.includes(':') && !packages.includes(t)),
      last_verified: detectDate(body) || fileDate,
      freshness,
      missing_branches: missingBranches,
      // Filled in by buildRegistry once every entry is known.
      conflicts: [],
      obsidian_projection: null,
    };
  });
}

/**
 * Detect disagreements between sections. Two kinds matter:
 *   - the same migration identifier described with different evidence statuses
 *   - a section claiming VERIFIED while another says the same subject is
 *     REPORTED_NOT_VERIFIED
 */
export function detectConflicts(entries) {
  const conflicts = [];
  const byMigration = {};
  for (const e of entries) {
    for (const m of e.referenced_migrations) {
      (byMigration[m] = byMigration[m] || []).push(e);
    }
  }
  for (const [mig, es] of Object.entries(byMigration)) {
    const statuses = new Set(es.flatMap((e) => e.evidence_statuses));
    if (statuses.has('VERIFIED') && (statuses.has('REPORTED_NOT_VERIFIED') || statuses.has('UNKNOWN'))) {
      conflicts.push({
        kind: 'status_disagreement',
        subject: `migration ${mig}`,
        detail: `described as both VERIFIED and ${statuses.has('REPORTED_NOT_VERIFIED') ? 'REPORTED_NOT_VERIFIED' : 'UNKNOWN'}`,
        sections: es.map((e) => `${e.document} § ${e.section}`),
      });
    }
  }
  for (const e of entries) {
    if (e.missing_branches.length) {
      conflicts.push({
        kind: 'missing_branch_reference',
        subject: `${e.document} § ${e.section}`,
        detail: `references branch(es) that do not exist: ${e.missing_branches.join(', ')}`,
        sections: [`${e.document} § ${e.section}`],
      });
    }
    if (e.freshness === 'STALE') {
      conflicts.push({
        kind: 'stale_section',
        subject: `${e.document} § ${e.section}`,
        detail: 'verified at a commit whose evidence paths have since changed',
        sections: [`${e.document} § ${e.section}`],
      });
    }
  }
  return conflicts;
}

export function buildRegistry(documents, obs, { generatedAt }) {
  if (!generatedAt) throw new Error('buildRegistry requires an explicit timestamp');
  const entries = documents.flatMap(({ path, text }) => indexDocument(path, text, obs));
  const conflicts = detectConflicts(entries);

  const bySection = {};
  for (const c of conflicts) for (const s of c.sections) (bySection[s] = bySection[s] || []).push(c.kind);
  for (const e of entries) e.conflicts = bySection[`${e.document} § ${e.section}`] || [];

  const freshnessCounts = entries.reduce((a, e) => { a[e.freshness] = (a[e.freshness] || 0) + 1; return a; }, {});

  return {
    registry: {
      schema_version: REGISTRY_SCHEMA_VERSION,
      generated_at: generatedAt,
      repository_commit: obs.currentCommit,
      document_count: documents.length,
      section_count: entries.length,
      entries,
    },
    sources: {
      schema_version: REGISTRY_SCHEMA_VERSION,
      generated_at: generatedAt,
      documents: documents.map(({ path, text }) => ({
        path,
        bytes: text.length,
        content_hash: digest({ path, body: text }),
        last_commit: obs.lastCommitFor(path),
        sections: entries.filter((e) => e.document === path).map((e) => e.section),
      })),
    },
    freshness: {
      schema_version: REGISTRY_SCHEMA_VERSION,
      generated_at: generatedAt,
      repository_commit: obs.currentCommit,
      counts: freshnessCounts,
      stale: entries.filter((e) => e.freshness === 'STALE').map((e) => `${e.document} § ${e.section}`),
      unknown_ref: entries.filter((e) => e.freshness === 'UNKNOWN_REF').map((e) => `${e.document} § ${e.section}`),
    },
    conflicts: {
      schema_version: REGISTRY_SCHEMA_VERSION,
      generated_at: generatedAt,
      count: conflicts.length,
      conflicts,
    },
  };
}
