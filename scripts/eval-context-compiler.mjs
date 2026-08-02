// ---------------------------------------------------------------------------
// eval-context-compiler.mjs — Runner CC: the Context Compiler suite.
//
// Pure and deterministic. Every case drives the compiler with synthetic records
// built in memory — no fixtures on disk, no repository files read, no Git, no
// clock. `generatedAt` is supplied, which is what lets the JSON-stability case
// assert byte equality rather than "looks about the same".
//
// The suite is organized around the failures that would make a packet dangerous
// rather than merely imperfect: a policy that went missing, a reported claim
// that got promoted to fact, an absence reported as silence, a secret copied
// into an artifact.
//
// Usage: node scripts/eval-context-compiler.mjs
// ---------------------------------------------------------------------------

import { compile, toJson, toMarkdown, UNIVERSAL_FORBIDDEN } from './lib/context-compiler/compile.mjs';
import { select, tokenize, objectiveTags, detectAbsentTopics, isMandatory } from './lib/context-compiler/select.mjs';
import {
  makeRecord, supportFor, splitSections, detectStatus, detectDate, detectCommit, deriveTags, summarize,
} from './lib/context-compiler/records.mjs';
import {
  fromCognition, fromEvidenceDoc, fromGit, fromDecision, fromMigrations, fromTests, fromObjective,
} from './lib/context-compiler/adapters.mjs';
import { SCHEMA_VERSION, validatePacket, warning, EVIDENCE_STATUSES } from './lib/context-compiler/contract.mjs';

let passed = 0; let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`); cond ? passed++ : failed++; };
const section = (s) => console.log(`--- ${s} ---`);

const AT = '2026-08-01T21:00:00.000Z';
const GIT = {
  repository: 'jaqboredasf-gif/Autonomous-Workflow-Engine',
  branch: 'feat/persistent-cognition-compiler',
  commit: '0123456789abcdef0123456789abcdef01234567',
  dirty_files: [],
  branches: ['main', 'codex/durable-execution-plane', 'claude/microsoft-365-integration-plane-fcsm1e'],
};

// A minimal but valid record set: policies + identity + a few topical records.
const POLICY = makeRecord({
  type: 'cognition', source_path: 'context/AGENT_OPERATING_POLICIES.md',
  section: 'P4 — No live side effects', summary: 'No live Graph, Supabase, email or n8n activation.',
  evidence_status: 'VERIFIED', tags: ['policy'], body: 'No live Microsoft Graph call. No outbound email.',
});
const IDENTITY = makeRecord({
  type: 'cognition', source_path: 'context/AWE_IDENTITY.md', section: 'Working rules',
  summary: 'Repository is the source of truth.', evidence_status: 'VERIFIED',
  tags: ['policy'], body: 'The repository is the source of truth.',
});
const BLOCKER = makeRecord({
  type: 'cognition', source_path: 'context/AWE_CURRENT_STATE.md', section: 'Known blockers',
  summary: 'Docker is not operational; WSL2 has no distribution.', evidence_status: 'VERIFIED',
  tags: ['docker'], body: 'Docker daemon down.',
});
const base = () => [...fromObjective('placeholder'), ...fromGit(GIT), POLICY, IDENTITY, BLOCKER];

const M365 = makeRecord({
  type: 'evidence', source_path: 'docs/integration/AWE_MERGE_RISK_REPORT.md', section: 'Dry-run merge result',
  summary: 'Three conflicts between the m365 branch and the codex stack.', evidence_status: 'VERIFIED',
  tags: ['m365', 'migration:0016', 'branch:claude/microsoft-365-integration-plane-fcsm1e'],
  last_verified: '2026-08-01', body: 'm365 conflicts with regression.sh',
});
const MIG16A = makeRecord({
  type: 'migration', source_path: 'supabase/migrations/0016_drop_undeclared_client_policies.sql',
  section: '0016_drop_undeclared_client_policies', summary: 'migration 0016 — drop undeclared client policies',
  evidence_status: 'PARTIALLY_VERIFIED', tags: ['migration:0016', 'migration'], body: '',
});
const MIG16B = makeRecord({
  type: 'migration', source_path: 'supabase/migrations/0016_m365_integration_plane.sql',
  section: '0016_m365_integration_plane', summary: 'migration 0016 — m365 integration plane',
  evidence_status: 'PARTIALLY_VERIFIED', tags: ['migration:0016', 'migration', 'm365'], body: '',
});
const REPORTED = makeRecord({
  type: 'evidence', source_path: 'docs/integration/AWE_EVIDENCE_LEDGER.md', section: '61 orchestration tests',
  summary: 'Reported 61/61 orchestration tests; no reproducible source exists.',
  evidence_status: 'REPORTED_NOT_VERIFIED', tags: ['orchestration'], body: 'no suite exists',
});
const VERIFIED_DUR = makeRecord({
  type: 'evidence', source_path: 'context/VERIFIED_EVIDENCE.md', section: 'Durable Execution Plane',
  summary: 'Runner D: 309 assertions, 0 failures.', evidence_status: 'VERIFIED',
  tags: ['durable', 'execution', 'awe-execution'], body: 'Runner D 309/0',
});

const run = (records, objective, opts = {}) => compile(records, { objective, git: GIT, generatedAt: AT, ...opts });

// ---------------------------------------------------------------------------
section('1. successful packet compilation');
{
  const { packet, errors } = run([...base(), M365], 'Compare the microsoft 365 branch merge risk');
  check(errors.length === 0, `packet validates cleanly (${errors.join('; ') || 'no errors'})`);
  check(packet.schema_version === SCHEMA_VERSION, 'packet carries the schema version');
  check(typeof packet.packet_id === 'string' && packet.packet_id.length > 0, 'packet has an id');
  check(packet.generated_at === AT, 'generated_at is the supplied instant, not a clock read');
  check(packet.repository === GIT.repository && packet.commit === GIT.commit, 'repository identity is recorded');
}

section('2. minimal-context selection');
{
  const noise = Array.from({ length: 60 }, (_, i) => makeRecord({
    type: 'evidence', source_path: `docs/integration/noise-${i}.md`, section: `noise ${i}`,
    summary: 'entirely unrelated material about pay periods', evidence_status: 'VERIFIED',
    tags: ['unrelated'], body: 'nothing to do with the objective',
  }));
  const { packet } = run([...base(), ...noise, M365], 'Compare the microsoft 365 branch merge risk');
  check(packet.sources.length < 20, `packet stays small: ${packet.sources.length} sources from ${noise.length + 6} records`);
  check(!packet.sources.some((s) => s.source_path.includes('noise-')), 'irrelevant records are excluded');
  check(packet.sources.some((s) => s.source_path.includes('MERGE_RISK')), 'the relevant record is included');
}

section('3. mandatory policy inclusion');
{
  // An objective that shares no vocabulary with the policy documents.
  const { packet } = run([...base(), M365], 'Rename a css class in the mobile app');
  check(packet.applicable_policies.length > 0, 'policies are included even when the objective never mentions them');
  check(packet.forbidden_actions.length === UNIVERSAL_FORBIDDEN.length, 'every universal prohibition is present');
  check(packet.sources.some((s) => s.source_path.includes('AGENT_OPERATING_POLICIES')), 'the policy source is in the manifest');
  check(isMandatory(POLICY) === true, 'the policy record is classified mandatory');
  check(isMandatory(M365) === false, 'a topical record is not mandatory');
}

section('4. verified evidence preferred over reported');
{
  const { packet } = run([...base(), REPORTED, VERIFIED_DUR],
    'Understand the durable execution plane and the orchestration claims');
  const v = packet.sources.find((s) => s.source_path.includes('VERIFIED_EVIDENCE'));
  const r = packet.sources.find((s) => s.section === '61 orchestration tests');
  check(!!v && !!r, 'both the verified and the reported record are present');
  check(v.score > r.score, `verified outranks reported (${v.score} > ${r.score})`);
  check(r.support === 'reported', 'the reported record keeps its support classification');
  check(supportFor('REPORTED_NOT_VERIFIED') === 'reported', 'status maps to support, not tone');
  check(supportFor('VERIFIED') === 'verified' && supportFor('SUPERSEDED') === 'rejected', 'support mapping is total');
}

section('5. conflicting migration claims surfaced');
{
  const { packet } = run([...base(), MIG16A, MIG16B], 'Resolve the 0016 migration identity collision');
  const sel = packet.sources.filter((s) => s.source_path.includes('0016'));
  check(sel.length === 2, `both competing 0016 migrations are selected (${sel.length})`);
  check(packet.relevant_files.length >= 0, 'relevant files list is present');
  check(sel.every((s) => s.included_because.some((w) => w.includes('migration:0016'))),
    'each is included because of the migration identifier, and says so');
}

section('6. missing file references surfaced');
{
  const ghost = makeRecord({
    type: 'cognition', source_path: 'context/AWE_SYSTEM_MAP.md', section: 'Adapters',
    summary: 'references a file that does not exist', evidence_status: 'VERIFIED',
    tags: ['adapter', 'path:packages/ghost/src/nowhere.mjs'], body: 'see packages/ghost/src/nowhere.mjs',
  });
  const { packet } = run([...base(), ghost], 'Review the adapter boundaries',
    { knownPaths: new Set(['package.json']) });
  check(packet.warnings.some((w) => w.kind === 'missing_source' && /nowhere\.mjs/.test(w.message)),
    'a reference to a nonexistent path raises missing_source');
}

section('7. stale commit references surfaced');
{
  const stale = makeRecord({
    type: 'cognition', source_path: 'context/AWE_CURRENT_STATE.md', section: 'Canonical repository',
    summary: 'verified at an older commit', evidence_status: 'VERIFIED',
    tags: ['git'], ref: 'deadbee', body: 'verified at deadbee',
  });
  const { packet } = run([...base(), stale], 'Confirm the canonical repository and current state');
  check(packet.warnings.some((w) => w.kind === 'stale_source' && /deadbee/.test(w.message)),
    'a record naming a different commit raises stale_source');
  check(packet.staleness.compiled_at_commit === GIT.commit, 'staleness records the compile commit');
}

section('8. unknown evidence statuses rejected');
{
  const bogus = makeRecord({
    type: 'evidence', source_path: 'docs/integration/bogus.md', section: 'Bogus',
    summary: 'claims a status that does not exist', evidence_status: 'MOSTLY_FINE',
    tags: ['migration:0016'], body: 'x',
  });
  check(bogus.evidence_status === 'UNKNOWN', 'an invalid status is coerced to UNKNOWN, never trusted');
  check(bogus.status_was_invalid === true, 'the coercion is recorded, not hidden');
  const { packet } = run([...base(), bogus], 'Resolve the 0016 migration identity collision');
  check(packet.warnings.some((w) => w.kind === 'invalid_evidence_status'), 'an invalid status raises a warning');
  let threw = false;
  try { warning('not_a_real_kind', 'x'); } catch { threw = true; }
  check(threw, 'an unknown warning kind throws rather than emitting an unbranchable warning');
  check(EVIDENCE_STATUSES.length === 9, 'the evidence vocabulary has nine members');
}

section('9. dirty repository warning');
{
  const dirtyGit = { ...GIT, dirty_files: ['packages/awe-kernel/src/index.mjs', 'README.md'] };
  const { packet } = compile([...fromObjective('x'), ...fromGit(dirtyGit), POLICY, IDENTITY],
    { objective: 'Check the kernel', git: dirtyGit, generatedAt: AT });
  check(packet.warnings.some((w) => w.kind === 'dirty_git_state'), 'a dirty tree raises dirty_git_state');
  check(packet.staleness.dirty === true, 'staleness records the dirty flag');
  const { packet: clean } = run([...base()], 'Check the kernel');
  check(!clean.warnings.some((w) => w.kind === 'dirty_git_state'), 'a clean tree raises no dirty warning');
}

section('10. JSON output stability');
{
  const a = run([...base(), M365], 'Compare the microsoft 365 branch merge risk');
  const b = run([...base(), M365], 'Compare the microsoft 365 branch merge risk');
  check(toJson(a.packet) === toJson(b.packet), 'same input and instant produce byte-identical JSON');
  check(toJson(a.packet).endsWith('\n'), 'JSON output ends with a newline');
  const parsed = JSON.parse(toJson(a.packet));
  check(parsed.packet_id === a.packet.packet_id, 'JSON round-trips');
  const keys = Object.keys(parsed);
  check(JSON.stringify(keys) === JSON.stringify([...keys].sort()), 'JSON keys are canonically ordered');
}

section('11. Markdown packet completeness');
{
  const { packet } = run([...base(), M365, VERIFIED_DUR], 'Compare the microsoft 365 branch merge risk');
  const md = toMarkdown(packet);
  for (const h of ['# Execution Packet', '## Objective', '## Current verified state',
    '## Applicable policies', '## Forbidden actions', '## Allowed actions', '## Known blockers',
    '## Relevant packages', '## Relevant files', '## Applicable decisions', '## Required tests',
    '## Definition of done', '## Required handoff format', '## Sources', '## Evidence summary',
    '## Staleness']) {
    check(md.includes(h), `markdown contains "${h}"`);
  }
  check(md.includes(GIT.commit), 'markdown names the commit');
  check(md.includes(packet.objective), 'markdown states the objective verbatim');
}

section('12. source-manifest traceability');
{
  // Include a record the selector will reject, so "considered vs selected" is a
  // real difference rather than an accident of a tiny input set.
  const irrelevant = makeRecord({
    type: 'evidence', source_path: 'docs/integration/pay-periods.md', section: 'Pay periods',
    summary: 'unrelated payroll material', evidence_status: 'VERIFIED', tags: ['unrelated'], body: 'x',
  });
  const { packet, manifest } = run([...base(), M365, irrelevant], 'Compare the microsoft 365 branch merge risk');
  check(manifest.sources.length === packet.sources.length, 'manifest and packet agree on source count');
  check(packet.sources.every((s) => s.source_path), 'every source has a path');
  check(packet.sources.every((s) => Array.isArray(s.included_because) && s.included_because.length > 0),
    'every source explains why it was included');
  check(manifest.objective_tokens.includes('microsoft'), 'manifest records the objective tokens used');
  check(manifest.selection.considered > manifest.selection.selected,
    `manifest records what was considered vs selected (${manifest.selection.considered} > ${manifest.selection.selected})`);
  check(!packet.sources.some((s) => s.source_path.includes('pay-periods')), 'the rejected record is absent from the packet');
  const invalid = validatePacket({ ...packet, sources: [{ source_path: '', evidence_status: 'VERIFIED' }] });
  check(invalid.some((e) => /traceable/.test(e)), 'a source with no path fails validation');
}

section('13. no secret values copied into packets');
{
  const leaky = makeRecord({
    type: 'evidence', source_path: 'docs/integration/leak.md', section: 'Credentials',
    summary: 'redacted', evidence_status: 'VERIFIED', tags: ['migration:0016'],
    body: 'token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  });
  const { packet } = run([...base(), leaky], 'Resolve the 0016 migration identity collision');
  const serialized = `${toJson(packet)}\n${toMarkdown(packet)}`;
  check(!/ghp_[A-Za-z0-9]{20,}/.test(serialized), 'a token-shaped literal in a record body never reaches the packet');
  check(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(serialized), 'no private key material reaches the packet');
  check(!serialized.includes('AKIA0000000000000000'), 'no AWS-shaped key reaches the packet');
}

section('14. objective with no relevant capability');
{
  const { packet } = run([...base()], 'Repaint the bikeshed a slightly different colour');
  check(packet.applicable_policies.length > 0, 'policies are still present');
  check(packet.sources.some((s) => s.type === 'git'), 'repository identity is still present');
  check(packet.sources.every((s) => s.included_because.includes('mandatory')),
    'with no topical match, only mandatory records are selected');
}

section('15. objective related to Microsoft 365');
{
  const { packet } = run([...base(), M365, MIG16B, VERIFIED_DUR],
    'Compare the durable-execution branch with the microsoft 365 integration branch');
  check(packet.sources.some((s) => s.source_path.includes('MERGE_RISK')), 'the merge-risk report is selected');
  check(packet.sources.some((s) => s.source_path.includes('0016_m365')), 'the m365 migration is selected');
}

section('16. objective related to durable execution');
{
  const { packet } = run([...base(), VERIFIED_DUR, M365], 'Extend the durable execution plane retry policy');
  const dur = packet.sources.find((s) => s.section === 'Durable Execution Plane');
  check(!!dur, 'the durable-execution evidence is selected');
  check(dur.evidence_status === 'VERIFIED', 'it is carried with its verified status');
}

section('17. objective related to n8n, artifacts missing');
{
  const { packet } = run([...base()], 'Recover the missing n8n workflow exports and design the n8n adapter');
  check(packet.warnings.some((w) => w.kind === 'missing_capability' && /n8n/.test(w.message)),
    'n8n is reported as having no code-backed implementation');
  check(packet.staleness.absent_topics.includes('n8n'), 'n8n is listed as an absent topic');
  check(toMarkdown(packet).includes('no implementation in this repository'),
    'the markdown states the absence rather than showing an empty section');
  check(detectAbsentTopics('recover n8n exports').includes('n8n'), 'absence detection is direct and testable');
}

section('18. objective related to the missing Orchestration Plane');
{
  const { packet } = run([...base(), REPORTED],
    'Implement the orchestration and responsibility plane described in the handoff');
  check(packet.staleness.absent_topics.includes('orchestration'), 'orchestration is flagged absent');
  check(packet.staleness.absent_topics.includes('responsibility'), 'responsibility is flagged absent');
  check(packet.warnings.some((w) => w.kind === 'missing_capability' && /orchestration/.test(w.message)),
    'the packet reports absence instead of reconstructing the plane');
  const orch = packet.sources.find((s) => s.section === '61 orchestration tests');
  check(!!orch && orch.evidence_status === 'REPORTED_NOT_VERIFIED',
    'the unverified orchestration claim is surfaced with its status, not silently dropped');
  check(packet.warnings.some((w) => w.kind === 'unverified_claim'), 'an unverified claim raises a warning');
}

section('19. contract and record primitives');
{
  check(splitSections('# A\nbody a\n## B\nbody b').length === 2, 'markdown splits into sections');
  check(detectStatus('this is `VERIFIED` work') === 'VERIFIED', 'status detection works');
  check(detectStatus('both VERIFIED and REPORTED_NOT_VERIFIED') === 'REPORTED_NOT_VERIFIED',
    'a mixed section takes the weaker claim');
  check(detectDate('on 2026-08-01 we did') === '2026-08-01', 'ISO date detection works');
  check(detectCommit('verified at commit 55c0ba5') === '55c0ba5', 'a labelled short SHA is detected');
  check(detectCommit('branch @ 53b8f7f') === '53b8f7f', 'an @-prefixed short SHA is detected');
  check(detectCommit('**Commit:** `abc1234`') === 'abc1234',
    'a bold markdown label with a backticked SHA is detected — the form these documents use');
  check(detectCommit('a sentence about commit hygiene mentioning deadbeef somewhere later') === null,
    'the word "commit" far from a hex token does not create a false match');
  check(detectCommit('workflow e0d2b551 is live and ungated') === null,
    'a bare hex token (an n8n workflow id) is NOT read as a commit');
  check(detectCommit('0123456789abcdef0123456789abcdef01234567') === '0123456789abcdef0123456789abcdef01234567',
    'a full 40-char SHA needs no label');
  check(makeRecord({ type: 'cognition', source_path: 'x.md', tags: ['path:docs/architecture/AGENT_RUNTIME.md'] })
    .tags[0] === 'path:docs/architecture/AGENT_RUNTIME.md', 'path tags keep their case');
  check(makeRecord({ type: 'cognition', source_path: 'x.md', tags: ['Tenant'] }).tags[0] === 'tenant',
    'non-path tags are lower-cased for matching');
  check(deriveTags('the awe-kernel handles tenant policy').includes('awe-kernel'), 'package tags derive');
  check(deriveTags('migration 0016 and ADR-0009').includes('migration:0016'), 'migration tags derive');
  check(deriveTags('migration 0016 and ADR-0009').includes('adr:0009'), 'ADR tags derive');
  check(summarize('# h\n\nthis is a reasonably long substantive sentence about tenants').length > 20,
    'summaries pick a substantive line');
  check(tokenize('Resolve the 0016 migration collision').includes('0016'), 'tokenizer keeps identifiers');
  check(!tokenize('Resolve the collision').includes('the'), 'tokenizer drops stopwords');
  check(objectiveTags('compare the m365 branch').includes('m365'), 'objective tags derive');
  let threw = false;
  try { makeRecord({ type: 'cognition', source_path: '' }); } catch { threw = true; }
  check(threw, 'a record without a source path is refused');
  threw = false;
  try { makeRecord({ type: 'not_a_type', source_path: 'x.md' }); } catch { threw = true; }
  check(threw, 'an unknown record type is refused');
}

section('20. adapters');
{
  check(fromCognition('context/X.md', '# Heading\n' + 'a'.repeat(60)).length === 1, 'cognition adapter emits a record');
  check(fromEvidenceDoc('docs/integration/X.md', '# H\n' + 'b'.repeat(60))[0].evidence_status === 'UNKNOWN',
    'an evidence section with no declared status defaults to UNKNOWN, not VERIFIED');
  check(fromDecision('docs/architecture/decisions/0009-x.md', '# ADR-0009 — x\n**Status:** Proposed (2026-07-27)')[0]
    .evidence_status === 'PARTIALLY_VERIFIED', 'a Proposed ADR is PARTIALLY_VERIFIED, not VERIFIED');
  check(fromDecision('docs/architecture/decisions/0001-y.md', '# ADR-0001 — y\n**Status:** Accepted 2026-07-27')[0]
    .evidence_status === 'VERIFIED', 'an Accepted ADR is VERIFIED');
  check(fromMigrations([{ name: '0016_x', ordinal: '0016', path: 'supabase/migrations/0016_x.sql', lines: 80 }])[0]
    .evidence_status === 'PARTIALLY_VERIFIED', 'a migration file is PARTIALLY_VERIFIED — present, not proven applied');
  check(fromTests([{ name: 'acceptance-slice1', kind: 'db', runner: null, path: 'scripts/acceptance-slice1.sh' }])[0]
    .evidence_status === 'LIVE_BLOCKED', 'a db-kind suite is LIVE_BLOCKED, not listed as available');
  check(fromGit(GIT)[0].evidence_status === 'VERIFIED', 'git state is verified evidence');
  check(fromObjective('do a thing', 'AWE-INT-101')[0].section === 'AWE-INT-101', 'objective carries the task id');
}

section('21. compiler refuses to run without its inputs');
{
  const cases = [
    [() => compile([], { git: GIT, generatedAt: AT }), 'objective'],
    [() => compile([], { objective: 'x', generatedAt: AT }), 'git state'],
    [() => compile([], { objective: 'x', git: GIT }), 'generatedAt'],
  ];
  for (const [fn, what] of cases) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(threw, `compile() refuses to run without ${what}`);
  }
  const empty = validatePacket({ schema_version: SCHEMA_VERSION, sources: [], warnings: [] });
  check(empty.some((e) => /applicable_policies is empty/.test(e)), 'a packet with no policies fails validation');
  check(empty.some((e) => /forbidden_actions is empty/.test(e)), 'a packet with no prohibitions fails validation');
}

section('Runner CC gates');
{
  // Non-vacuity: the selector must actually reject things, or every case above
  // would pass for the wrong reason.
  const { selected } = select([...base(), M365], 'entirely unrelated bikeshed colour', { minScore: 8 });
  check(selected.every((s) => s.mandatory), 'with an unrelated objective, only mandatory records survive selection');
  const { selected: hit } = select([...base(), M365], 'microsoft 365 merge risk', { minScore: 8 });
  check(hit.length > selected.length, 'a relevant objective selects strictly more than an irrelevant one');
}

console.log(`\neval-context-compiler (Runner CC, pure, deterministic): passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'Runner CC: PASS' : 'Runner CC: FAIL');
process.exit(failed === 0 ? 0 : 1);
