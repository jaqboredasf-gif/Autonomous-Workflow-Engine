// ---------------------------------------------------------------------------
// ingest.mjs — turn a worker's handoff into CANDIDATE cognition updates.
//
// The single most dangerous thing this whole control plane could do is let an
// agent write its own conclusions into the organization's memory. A handoff is
// testimony. Testimony becomes evidence only after it is checked against the
// repository, and even then it becomes a *proposal* — never an edit.
//
// So every claim in a handoff is classified:
//
//   ACCEPTABLE_DIRECT_EVIDENCE — the repository independently shows it
//   ACCEPTABLE_TEST_EVIDENCE   — a recorded runner result supports it
//   NEEDS_REVIEW               — plausible, unverifiable from here
//   CONTRADICTED               — the repository says otherwise
//   UNSUPPORTED               — no evidence of any kind was offered
//
// and only the first two are ever eligible to be written — and then only into
// designated operational sections, never into identity, constitutional
// principles or critical decisions. Those are strategic truth; an agent does not
// get to edit them because it had a productive afternoon.
//
// PURE: takes a handoff plus an observation object, returns a patch proposal.
// ---------------------------------------------------------------------------

export const CLASSIFICATIONS = [
  'ACCEPTABLE_DIRECT_EVIDENCE',
  'ACCEPTABLE_TEST_EVIDENCE',
  'NEEDS_REVIEW',
  'CONTRADICTED',
  'UNSUPPORTED',
];

export const APPLICABLE = new Set(['ACCEPTABLE_DIRECT_EVIDENCE', 'ACCEPTABLE_TEST_EVIDENCE']);

// Documents an ingestion may never touch, whatever the evidence says. These hold
// what AWE is and what it has decided — changed by people, in a commit someone
// signs their name to.
export const PROTECTED_DOCUMENTS = [
  'context/AWE_IDENTITY.md',
  'context/CRITICAL_DECISIONS.md',
  'context/AGENT_OPERATING_POLICIES.md',
  'context/ACTIVE_CAPABILITY_SPECIFICATION.md',
];

// The only sections an --apply may write into.
export const OPERATIONAL_TARGETS = [
  { document: 'context/VERIFIED_EVIDENCE.md', section: 'A. Reproduced this session — rank 2 evidence (runner output)' },
  { document: 'context/LATEST_AGENT_HANDOFF.md', section: null },
];

export function isProtected(path) {
  return PROTECTED_DOCUMENTS.includes(path);
}

/**
 * Extract candidate evidence records from a handoff.
 * A candidate is a claim plus whatever the handoff offered in support of it.
 */
export function extractCandidates(handoff) {
  const out = [];
  for (const claim of handoff.claims_verified || []) {
    out.push({ claim, kind: 'claim_verified', offered_support: handoff.results || [] });
  }
  for (const claim of handoff.claims_unverified || []) {
    out.push({ claim, kind: 'claim_unverified', offered_support: [] });
  }
  for (const t of handoff.tests_run || []) {
    const result = (handoff.results || []).find((r) => String(r).includes(String(t).replace(/^scripts\//, '').replace(/\.(sh|mjs)$/, '')));
    out.push({ claim: `${t} was run`, kind: 'test_run', offered_support: result ? [result] : [] });
  }
  for (const f of handoff.files_created || []) {
    out.push({ claim: `${f} was created`, kind: 'file_created', offered_support: [] });
  }
  for (const f of handoff.files_modified || []) {
    out.push({ claim: `${f} was modified`, kind: 'file_modified', offered_support: [] });
  }
  return out;
}

/**
 * Classify a candidate against the repository.
 *
 * @param obs { fileExists(path)->bool, filesInRange()->string[], suiteExists(name)->bool }
 */
export function classifyCandidate(candidate, obs) {
  const { kind, claim, offered_support } = candidate;

  if (kind === 'claim_unverified') {
    // The worker itself said it could not verify this. Believing it now would
    // be worse than the worker's own assessment.
    return { classification: 'NEEDS_REVIEW', reason: 'the handoff itself marks this claim unverified' };
  }

  if (kind === 'file_created' || kind === 'file_modified') {
    const path = claim.replace(/ was (created|modified)$/, '');
    const inRange = new Set(obs.filesInRange() || []);
    if (inRange.has(path)) {
      return { classification: 'ACCEPTABLE_DIRECT_EVIDENCE', reason: 'the commit range shows this path changed' };
    }
    if (obs.fileExists(path)) {
      return { classification: 'NEEDS_REVIEW', reason: 'the file exists but does not appear in the claimed commit range' };
    }
    return { classification: 'CONTRADICTED', reason: 'the file does not exist and is not in the commit range' };
  }

  if (kind === 'test_run') {
    const name = claim.replace(/ was run$/, '');
    if (!obs.suiteExists(name)) {
      return { classification: 'CONTRADICTED', reason: `no suite named "${name}" exists in this repository` };
    }
    if (!offered_support.length) {
      return { classification: 'UNSUPPORTED', reason: 'the suite exists but the handoff records no result for it' };
    }
    const passing = offered_support.some((r) => /pass|passed=\d+ failed=0|ALL GREEN/i.test(String(r)));
    return passing
      ? { classification: 'ACCEPTABLE_TEST_EVIDENCE', reason: 'a passing result is recorded for an existing suite' }
      : { classification: 'NEEDS_REVIEW', reason: 'a result is recorded but does not clearly indicate success' };
  }

  // A free-text verified claim. Nothing here can check prose; the most it can
  // do is note whether test evidence accompanied it.
  if (offered_support.length) {
    return { classification: 'NEEDS_REVIEW', reason: 'a prose claim accompanied by test results — a human must judge whether the results actually support it' };
  }
  return { classification: 'UNSUPPORTED', reason: 'a prose claim with no evidence offered' };
}

/**
 * Build the full ingestion proposal.
 *
 * @param handoff the submitted handoff
 * @param task    the dispatch task it belongs to (may be null)
 * @param obs     repository observation
 */
export function proposeCognitionPatch(handoff, task, obs, { generatedAt }) {
  if (!generatedAt) throw new Error('proposeCognitionPatch requires an explicit timestamp');

  const preflight = [];
  if (!task) preflight.push(`no dispatch task ${handoff.task_id} exists — the handoff cannot be attributed`);
  else {
    if (task.status !== 'VERIFIED') {
      preflight.push(`task ${task.task_id} is ${task.status}; ingestion of an unverified task's claims is refused`);
    }
    if (task.packet_id && handoff.packet_id !== task.packet_id) {
      preflight.push(`handoff cites packet ${handoff.packet_id} but the task was prepared with ${task.packet_id}`);
    }
  }
  for (const sha of [handoff.starting_commit, handoff.ending_commit].filter(Boolean)) {
    if (!obs.commitExists(sha)) preflight.push(`claimed commit ${sha} does not exist`);
  }

  const candidates = extractCandidates(handoff).map((c) => ({ ...c, ...classifyCandidate(c, obs) }));

  const counts = candidates.reduce((acc, c) => { acc[c.classification] = (acc[c.classification] || 0) + 1; return acc; }, {});
  const applicable = candidates.filter((c) => APPLICABLE.has(c.classification));
  const contradicted = candidates.filter((c) => c.classification === 'CONTRADICTED');

  // Even applicable candidates only ever propose an append to an operational
  // section. Nothing rewrites an existing line.
  const patch = applicable.length && !preflight.length && !contradicted.length
    ? {
      document: 'context/VERIFIED_EVIDENCE.md',
      section: OPERATIONAL_TARGETS[0].section,
      operation: 'append',
      lines: applicable.map((c) => `| ${handoff.task_id} | ${c.claim} | ${handoff.ending_commit || 'n/a'} | \`${c.classification === 'ACCEPTABLE_TEST_EVIDENCE' ? 'VERIFIED' : 'PARTIALLY_VERIFIED'}\` | ${generatedAt.slice(0, 10)} | from handoff ${handoff.task_id}, ingested |`),
    }
    : null;

  return {
    generated_at: generatedAt,
    task_id: handoff.task_id,
    packet_id: handoff.packet_id,
    worker: handoff.worker,
    preflight_failures: preflight,
    candidates,
    counts,
    patch,
    // Stated in the artifact itself so a reader of the JSON cannot mistake a
    // proposal for a change that happened.
    applied: false,
    protected_documents: PROTECTED_DOCUMENTS,
    note: contradicted.length
      ? `${contradicted.length} claim(s) are CONTRADICTED by the repository — no patch is proposed while any claim is contradicted`
      : preflight.length
        ? 'preflight failed — no patch is proposed'
        : applicable.length
          ? 'a patch is proposed; it is NOT applied without an explicit --apply'
          : 'no claim reached an applicable classification',
  };
}

export function proposalToMarkdown(p) {
  const L = [];
  L.push(`# Cognition Ingestion Report — ${p.task_id}`);
  L.push('');
  L.push(`**Generated:** ${p.generated_at} · **Worker:** ${p.worker} · **Packet:** ${p.packet_id}`);
  L.push(`**Applied:** ${p.applied ? 'yes' : '**no** — this is a proposal'}`);
  L.push('');
  if (p.preflight_failures.length) {
    L.push('## Preflight failures');
    L.push('');
    for (const f of p.preflight_failures) L.push(`- ${f}`);
    L.push('');
  }
  L.push('## Candidate classification');
  L.push('');
  L.push('| Claim | Kind | Classification | Reason |');
  L.push('|---|---|---|---|');
  for (const c of p.candidates) L.push(`| ${c.claim} | ${c.kind} | \`${c.classification}\` | ${c.reason} |`);
  L.push('');
  L.push('## Proposed patch');
  L.push('');
  if (!p.patch) {
    L.push(`_No patch proposed._ ${p.note}`);
  } else {
    L.push(`Append to \`${p.patch.document}\` § ${p.patch.section}:`);
    L.push('');
    L.push('```markdown');
    for (const l of p.patch.lines) L.push(l);
    L.push('```');
  }
  L.push('');
  L.push('## Protected documents — never written by ingestion');
  L.push('');
  for (const d of p.protected_documents) L.push(`- \`${d}\``);
  L.push('');
  return L.join('\n');
}
