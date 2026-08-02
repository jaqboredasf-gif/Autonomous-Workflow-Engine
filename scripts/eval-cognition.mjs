// ---------------------------------------------------------------------------
// eval-cognition.mjs — Runner CG: cognition registry and handoff ingestion.
//
// Pure and deterministic. Both subsystems take an injected observation object,
// so a stale section, a missing branch, a contradicted claim and a protected
// document can all be constructed in memory.
//
// The ingestion cases are the important ones. An agent writing its own
// conclusions into the organization's memory is the failure this whole control
// plane exists to prevent, so the suite spends most of its assertions proving
// that a claim cannot become truth by being asserted confidently.
//
// Usage: node scripts/eval-cognition.mjs
// ---------------------------------------------------------------------------

import {
  indexDocument, detectConflicts, buildRegistry, REGISTRY_SCHEMA_VERSION, FRESHNESS,
} from './lib/cognition/registry.mjs';
import {
  extractCandidates, classifyCandidate, proposeCognitionPatch, proposalToMarkdown,
  CLASSIFICATIONS, APPLICABLE, PROTECTED_DOCUMENTS, isProtected,
} from './lib/cognition/ingest.mjs';
import { newHandoff } from './lib/dispatch/handoff.mjs';
import { newTask } from './lib/dispatch/state.mjs';

let passed = 0; let failed = 0;
const check = (c, l) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}`); c ? passed++ : failed++; };
const section = (s) => console.log(`--- ${s} ---`);

const AT = '2026-08-02T02:00:00.000Z';

const regObs = (over = {}) => ({
  currentCommit: 'ffffffffffffffffffffffffffffffffffffffff',
  lastCommitFor: () => 'abc1234',
  classifyRef: () => 'fresh',
  branchExists: (b) => b === 'codex/durable-execution-plane',
  pathExists: () => true,
  ...over,
});

// ===========================================================================
section('1. registry indexing');
{
  const text = '# Doc\n\n## Section A\n\nVerified at commit `55c0ba5`. Uses `awe-kernel` and migration 0016.\nLast verified 2026-08-01. Status `VERIFIED`.\n';
  const entries = indexDocument('context/X.md', text, regObs());
  check(entries.length === 1, 'a bare title with no body is not indexed — a heading is not a claim');
  const withBody = indexDocument('context/X.md', '# Doc\n\nintro body here\n\n## S\n\nsection body here\n', regObs());
  check(withBody.length === 2, 'a title WITH a body is indexed alongside its sections');
  const a = entries.find((e) => e.section === 'Section A');
  check(!!a, 'the named section is indexed');
  check(a.content_hash && a.content_hash.length > 0, 'each section carries a content hash');
  check(a.last_commit === 'abc1234', 'the last commit touching the document is recorded');
  check(a.evidence_statuses.includes('VERIFIED'), 'evidence statuses are extracted');
  check(a.referenced_packages.includes('awe-kernel'), 'referenced packages are extracted');
  check(a.referenced_migrations.includes('0016'), 'referenced migrations are extracted');
  check(a.last_verified === '2026-08-01', 'the last-verified date is extracted');
  check(FRESHNESS.includes(a.freshness), 'freshness is from the allowed set');
}

section('2. freshness classification');
{
  const text = '# D\n\n## S\n\nverified at commit `55c0ba5` with enough body to index.\n';
  const mk = (kind) => indexDocument('context/X.md', text, regObs({ classifyRef: () => kind }))
    .find((e) => e.section === 'S');
  check(mk('current').freshness === 'CURRENT', 'a reference to HEAD is CURRENT');
  check(mk('fresh').freshness === 'ANCESTOR_CLEAN', 'an ancestor with no evidence change is ANCESTOR_CLEAN');
  check(mk('stale').freshness === 'STALE', 'an ancestor with changed evidence paths is STALE');
  check(mk('other_branch').freshness === 'UNKNOWN_REF', 'a commit on another branch is UNKNOWN_REF');
  const undated = indexDocument('context/X.md', '# D\n\n## S\n\nno commit reference here at all.\n', regObs())
    .find((e) => e.section === 'S');
  check(undated.freshness === 'UNDATED', 'a section citing no commit is UNDATED, not assumed current');
}

section('3. missing branch and conflict detection');
{
  const text = '# D\n\n## S\n\nsee branch `claude/ghost-branch` for details of this work.\n';
  const e = indexDocument('context/X.md', text, regObs()).find((x) => x.section === 'S');
  check(e.missing_branches.includes('claude/ghost-branch'), 'a reference to a nonexistent branch is recorded');

  const conflicts = detectConflicts([
    { document: 'a.md', section: 'A', referenced_migrations: ['0016'], evidence_statuses: ['VERIFIED'], missing_branches: [], freshness: 'CURRENT' },
    { document: 'b.md', section: 'B', referenced_migrations: ['0016'], evidence_statuses: ['REPORTED_NOT_VERIFIED'], missing_branches: [], freshness: 'CURRENT' },
  ]);
  check(conflicts.some((c) => c.kind === 'status_disagreement'),
    'the same migration described as both VERIFIED and REPORTED_NOT_VERIFIED is a conflict');
  check(detectConflicts([{ document: 'a.md', section: 'A', referenced_migrations: [], evidence_statuses: [], missing_branches: ['x/y'], freshness: 'CURRENT' }])
    .some((c) => c.kind === 'missing_branch_reference'), 'a missing branch is a conflict');
  check(detectConflicts([{ document: 'a.md', section: 'A', referenced_migrations: [], evidence_statuses: [], missing_branches: [], freshness: 'STALE' }])
    .some((c) => c.kind === 'stale_section'), 'a stale section is a conflict');
  check(detectConflicts([]).length === 0, 'no entries means no conflicts');
}

section('4. registry assembly');
{
  const docs = [
    { path: 'context/A.md', text: '# A\n\n## One\n\nbody about `awe-kernel` and migration 0016 here.\n' },
    { path: 'context/B.md', text: '# B\n\n## Two\n\nbody referencing branch `codex/durable-execution-plane`.\n' },
  ];
  const r = buildRegistry(docs, regObs(), { generatedAt: AT });
  check(r.registry.schema_version === REGISTRY_SCHEMA_VERSION, 'the registry carries its schema version');
  check(r.registry.document_count === 2, 'documents are counted');
  check(r.registry.section_count === r.registry.entries.length, 'section count matches entries');
  check(r.sources.documents.length === 2, 'a source record exists per document');
  check(r.sources.documents[0].content_hash, 'each source carries a whole-file hash');
  check(typeof r.freshness.counts === 'object', 'freshness counts are produced');
  check(Array.isArray(r.conflicts.conflicts), 'conflicts are produced');
  check(r.registry.entries.every((e) => Array.isArray(e.conflicts)), 'every entry carries its conflict list');
  let threw = false;
  try { buildRegistry(docs, regObs(), {}); } catch { threw = true; }
  check(threw, 'buildRegistry refuses to run without an explicit timestamp');
}

section('5. candidate extraction');
{
  const h = newHandoff({
    claims_verified: ['the collision is three-way'],
    claims_unverified: ['which scheme is canonical'],
    tests_run: ['eval-dispatch'],
    results: ['eval-dispatch: passed=63 failed=0'],
    files_created: ['docs/planning/X.md'],
    files_modified: ['context/VERIFIED_EVIDENCE.md'],
  });
  const cands = extractCandidates(h);
  check(cands.some((c) => c.kind === 'claim_verified'), 'verified claims become candidates');
  check(cands.some((c) => c.kind === 'claim_unverified'), 'unverified claims become candidates too — they are not dropped');
  check(cands.some((c) => c.kind === 'test_run'), 'tests become candidates');
  check(cands.some((c) => c.kind === 'file_created'), 'created files become candidates');
  check(cands.some((c) => c.kind === 'file_modified'), 'modified files become candidates');
  const t = cands.find((c) => c.kind === 'test_run');
  check(t.offered_support.length === 1, 'a result naming the suite is attached as support');
}

section('6. classification against the repository');
{
  const obs = {
    fileExists: (p) => p === 'docs/planning/EXISTS.md',
    filesInRange: () => ['docs/planning/EXISTS.md'],
    suiteExists: (n) => n === 'eval-dispatch',
    commitExists: () => true,
  };
  const cl = (c) => classifyCandidate(c, obs).classification;

  check(cl({ kind: 'file_created', claim: 'docs/planning/EXISTS.md was created', offered_support: [] }) === 'ACCEPTABLE_DIRECT_EVIDENCE',
    'a file in the commit range is direct evidence');
  check(cl({ kind: 'file_created', claim: 'docs/planning/GHOST.md was created', offered_support: [] }) === 'CONTRADICTED',
    'a claimed file that does not exist and is not in the range is CONTRADICTED');
  check(cl({ kind: 'test_run', claim: 'eval-dispatch was run', offered_support: ['eval-dispatch: passed=63 failed=0'] }) === 'ACCEPTABLE_TEST_EVIDENCE',
    'an existing suite with a passing result is test evidence');
  check(cl({ kind: 'test_run', claim: 'eval-ghost was run', offered_support: ['passed'] }) === 'CONTRADICTED',
    'a test claim naming a suite that does not exist is CONTRADICTED');
  check(cl({ kind: 'test_run', claim: 'eval-dispatch was run', offered_support: [] }) === 'UNSUPPORTED',
    'a test claim with no recorded result is UNSUPPORTED — the suite existing is not the same as it having run');
  check(cl({ kind: 'claim_unverified', claim: 'x', offered_support: [] }) === 'NEEDS_REVIEW',
    "a claim the worker itself could not verify stays NEEDS_REVIEW — believing it now would beat the worker's own judgement");
  check(cl({ kind: 'claim_verified', claim: 'prose', offered_support: [] }) === 'UNSUPPORTED',
    'a prose claim with no evidence is UNSUPPORTED');
  check(cl({ kind: 'claim_verified', claim: 'prose', offered_support: ['passed=1 failed=0'] }) === 'NEEDS_REVIEW',
    'prose accompanied by results still needs a human — the results may not support the sentence');
  check(CLASSIFICATIONS.length === 5, 'five classifications exist');
  check(APPLICABLE.size === 2, 'only two of them are ever eligible to be written');
}

section('7. protected documents');
{
  check(PROTECTED_DOCUMENTS.includes('context/AWE_IDENTITY.md'), 'identity is protected');
  check(PROTECTED_DOCUMENTS.includes('context/CRITICAL_DECISIONS.md'), 'critical decisions are protected');
  check(PROTECTED_DOCUMENTS.includes('context/AGENT_OPERATING_POLICIES.md'), 'operating policies are protected');
  check(isProtected('context/AWE_IDENTITY.md'), 'isProtected recognizes a protected document');
  check(!isProtected('context/VERIFIED_EVIDENCE.md'), 'the evidence ledger is an operational target, not protected');
}

section('8. proposal safety');
{
  const obs = {
    fileExists: () => true,
    filesInRange: () => ['docs/planning/X.md'],
    suiteExists: () => true,
    commitExists: () => true,
  };
  const task = newTask({ task_id: 'AWE-INT-101', status: 'VERIFIED', packet_id: 'AWE-INT-101' });
  const good = newHandoff({
    task_id: 'AWE-INT-101', packet_id: 'AWE-INT-101', worker: 'w',
    starting_commit: 'aaa1111', ending_commit: 'bbb2222',
    files_created: ['docs/planning/X.md'],
    tests_run: ['eval-dispatch'], results: ['eval-dispatch: passed=63 failed=0'],
    completion_assertion: 'COMPLETE',
  });

  const p = proposeCognitionPatch(good, task, obs, { generatedAt: AT });
  check(p.applied === false, 'a proposal is never marked applied');
  check(p.patch !== null, 'a clean handoff produces a proposed patch');
  check(p.patch.operation === 'append', 'the patch only ever appends');
  check(!PROTECTED_DOCUMENTS.includes(p.patch.document), 'the patch never targets a protected document');
  check(/NOT applied without an explicit --apply/.test(p.note), 'the note states that nothing was written');

  const unverified = proposeCognitionPatch(good, { ...task, status: 'AWAITING_VERIFICATION' }, obs, { generatedAt: AT });
  check(unverified.preflight_failures.length > 0 && unverified.patch === null,
    "an unverified task's claims are refused before classification even matters");

  const noTask = proposeCognitionPatch(good, null, obs, { generatedAt: AT });
  check(noTask.preflight_failures.some((f) => /cannot be attributed/.test(f)),
    'a handoff with no dispatch task cannot be attributed and is refused');

  const wrongPacket = proposeCognitionPatch({ ...good, packet_id: 'OTHER' }, task, obs, { generatedAt: AT });
  check(wrongPacket.preflight_failures.some((f) => /packet/.test(f)),
    'a handoff citing a different packet than the task was prepared with is refused');

  const contradicted = proposeCognitionPatch(
    { ...good, files_created: ['docs/planning/GHOST.md'] },
    task,
    { ...obs, fileExists: () => false, filesInRange: () => [] },
    { generatedAt: AT },
  );
  check(contradicted.patch === null && /CONTRADICTED/.test(contradicted.note),
    'one contradicted claim blocks the whole patch — a handoff that is wrong about anything is not trusted about the rest');

  const badCommit = proposeCognitionPatch(good, task, { ...obs, commitExists: () => false }, { generatedAt: AT });
  check(badCommit.preflight_failures.some((f) => /does not exist/.test(f)), 'a nonexistent claimed commit fails preflight');

  let threw = false;
  try { proposeCognitionPatch(good, task, obs, {}); } catch { threw = true; }
  check(threw, 'proposeCognitionPatch refuses to run without an explicit timestamp');

  const md = proposalToMarkdown(p);
  check(md.includes('**no** — this is a proposal'), 'the report says plainly that nothing was applied');
  check(md.includes('Protected documents'), 'the report lists what ingestion may never touch');
  check(md.includes('ACCEPTABLE_TEST_EVIDENCE') || md.includes('ACCEPTABLE_DIRECT_EVIDENCE'),
    'the report shows the classification of each candidate');
}

section('Runner CG gates');
{
  // Non-vacuity: a proposal must be capable of being refused, and of being made.
  const obs = { fileExists: () => true, filesInRange: () => ['a.md'], suiteExists: () => true, commitExists: () => true };
  const task = newTask({ task_id: 'AWE-INT-101', status: 'VERIFIED', packet_id: 'P' });
  const empty = proposeCognitionPatch(newHandoff({ task_id: 'AWE-INT-101', packet_id: 'P' }), task, obs, { generatedAt: AT });
  check(empty.patch === null, 'a handoff claiming nothing proposes nothing');
  check(empty.candidates.length === 0, 'and produces no candidates');
}

console.log(`\neval-cognition (Runner CG, pure, deterministic): passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'Runner CG: PASS' : 'Runner CG: FAIL');
process.exit(failed === 0 ? 0 : 1);
