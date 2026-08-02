// ---------------------------------------------------------------------------
// eval-runtime-port.mjs — Runner RP: the Agent Runtime context port.
//
// Pure and deterministic. The port takes an injected compile adapter, so every
// case here runs without a repository, a filesystem or a clock.
//
// The suite is weighted toward refusal. Serving a packet is the easy half; the
// half that matters is declining to serve one when the repository is not in the
// state the caller required, because a runtime handed stale context proceeds
// confidently on a false premise.
//
// Usage: node scripts/eval-runtime-port.mjs
// ---------------------------------------------------------------------------

import {
  newContextRequest, evaluateRefusals, allowedStatusesFor, requestContext,
  PORT_SCHEMA_VERSION, EVIDENCE_LEVELS, REFUSAL_REASONS,
} from './lib/context-compiler/runtime-port.mjs';

let passed = 0; let failed = 0;
const check = (c, l) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}`); c ? passed++ : failed++; };
const section = (s) => console.log(`--- ${s} ---`);

const NOW = '2026-08-02T03:00:00.000Z';

const repo = (over = {}) => ({
  branch: 'feat/x',
  commit: 'abc1234def5678',
  dirty_files: [],
  commitExists: (sha) => ['abc1234def5678', 'abc1234', 'old1111'].some((c) => c.startsWith(sha) || sha.startsWith(c)),
  capabilities: ['migration-identity', 'durable-execution'],
  ...over,
});

const packet = (over = {}) => ({
  packet_id: 'PKT-1',
  sources: [
    { source_path: 'context/AGENT_OPERATING_POLICIES.md', evidence_status: 'VERIFIED' },
    { source_path: 'context/AWE_CURRENT_STATE.md', evidence_status: 'VERIFIED' },
  ],
  staleness: { absent_topics: [], newest_source_date: '2026-08-01' },
  ...over,
});

const adapter = (over = {}) => ({
  compile: () => ({ packet: packet(), manifest: { sources: [] }, warnings: [], errors: [] }),
  ...over,
});

const serve = (reqOver = {}, repoOver = {}, adapterOver = {}) => requestContext(
  newContextRequest({ objective: 'Analyze the migration identity collision', ...reqOver }),
  repo(repoOver),
  adapter(adapterOver),
  { now: NOW },
);

// ===========================================================================
section('1. successful compilation request');
{
  const r = serve();
  check(r.granted === true, 'a satisfiable request is granted');
  check(r.schema_version === PORT_SCHEMA_VERSION, 'the response carries the port schema version');
  check(r.packet_id === 'PKT-1', 'the packet id is returned');
  check(r.served_at === NOW, 'served_at is the supplied instant, not a clock read');
  check(r.refusal_reasons.length === 0, 'a granted response carries no refusals');
  check(!!r.repository_state && !!r.freshness_state && !!r.conflict_state,
    'repository, freshness and conflict state are always reported');
  check(r.source_manifest !== null, 'the source manifest is returned for traceability');
}

section('2. dirty-state refusal');
{
  const r = serve({ require_clean_worktree: true }, { dirty_files: ['a.js', 'b.js'] });
  check(!r.granted, 'a dirty worktree refuses when clean state was required');
  check(r.refusal_reasons[0].reason === 'DIRTY_WORKTREE', 'the refusal names DIRTY_WORKTREE');
  check(r.packet === null, 'no packet is returned with a refusal');
  check(serve({ require_clean_worktree: false }, { dirty_files: ['a.js'] }).granted,
    'a dirty worktree is fine when the request did not require cleanliness');
}

section('3. branch mismatch');
{
  const r = serve({ required_branch: 'main' });
  check(!r.granted && r.refusal_reasons[0].reason === 'BRANCH_MISMATCH', 'the wrong branch refuses');
  check(/requires branch "main"/.test(r.refusal_reasons[0].message), 'the refusal says which branch was wanted');
  check(serve({ required_branch: 'feat/x' }).granted, 'the right branch proceeds');
}

section('4. commit pinning');
{
  check(serve({ required_commit: 'deadbee' }).refusal_reasons[0].reason === 'COMMIT_NOT_FOUND',
    'a commit that does not exist refuses with COMMIT_NOT_FOUND');
  check(serve({ required_commit: 'old1111' }).refusal_reasons[0].reason === 'COMMIT_MISMATCH',
    'a real commit that is not HEAD refuses with COMMIT_MISMATCH');
  check(serve({ required_commit: 'abc1234' }).granted, 'pinning HEAD proceeds');
}

section('5. missing capability');
{
  const r = serve({ capability: 'orchestration' });
  check(!r.granted && r.refusal_reasons[0].reason === 'CAPABILITY_ABSENT',
    'a capability with no implementation refuses rather than producing an empty packet');
  check(r.refusal_reasons[0].detail.available.includes('migration-identity'),
    'the refusal lists what capabilities do exist');
  check(serve({ capability: 'migration-identity' }).granted, 'an implemented capability proceeds');
}

section('6. mandatory policy source');
{
  const noPolicy = adapter({
    compile: () => ({
      packet: packet({ sources: [{ source_path: 'context/AWE_CURRENT_STATE.md', evidence_status: 'VERIFIED' }] }),
      manifest: {}, warnings: [], errors: [],
    }),
  });
  const r = requestContext(newContextRequest({ objective: 'x' }), repo(), noPolicy, { now: NOW });
  check(!r.granted && r.refusal_reasons[0].reason === 'MANDATORY_SOURCE_MISSING',
    'a packet missing the operating policies is refused, not warned about');
  check(/AGENT_OPERATING_POLICIES/.test(r.refusal_reasons[0].message), 'the refusal names the missing source');
  const custom = requestContext(
    newContextRequest({ objective: 'x', required_policies: [] }), repo(), noPolicy, { now: NOW },
  );
  check(custom.granted, 'a caller that explicitly requires no policies is served — the rule is the request, not a hardcode');
}

section('7. evidence-status gating');
{
  check(allowedStatusesFor(newContextRequest({ evidence_level: 'any' })).size >= 9, 'level "any" allows every status');
  check(allowedStatusesFor(newContextRequest({ evidence_level: 'verified_only' })).has('VERIFIED'), 'verified_only allows VERIFIED');
  check(!allowedStatusesFor(newContextRequest({ evidence_level: 'verified_only' })).has('UNKNOWN'), 'verified_only excludes UNKNOWN');
  check(allowedStatusesFor(newContextRequest({ evidence_level: 'trusted_only' })).has('PARTIALLY_VERIFIED'),
    'trusted_only allows PARTIALLY_VERIFIED');

  const mixed = adapter({
    compile: () => ({
      packet: packet({
        sources: [
          { source_path: 'context/AGENT_OPERATING_POLICIES.md', evidence_status: 'VERIFIED' },
          { source_path: 'docs/integration/X.md', evidence_status: 'REPORTED_NOT_VERIFIED' },
        ],
      }),
      manifest: {}, warnings: [], errors: [],
    }),
  });
  const r = requestContext(newContextRequest({ objective: 'x', evidence_level: 'verified_only' }), repo(), mixed, { now: NOW });
  check(!r.granted && r.refusal_reasons.some((x) => x.reason === 'DISALLOWED_EVIDENCE_STATUS'),
    'a source outside the requested evidence level refuses');
  check(requestContext(newContextRequest({ objective: 'x' }), repo(), mixed, { now: NOW }).granted,
    'the same packet is served when the request allows any status');
  check(serve({ allowed_evidence_statuses: ['NOT_A_STATUS'] }).refusal_reasons[0].reason === 'DISALLOWED_EVIDENCE_STATUS',
    'an invented evidence status in the request is refused');
  check(serve({ evidence_level: 'whatever' }).refusal_reasons[0].reason === 'DISALLOWED_EVIDENCE_STATUS',
    'an invalid evidence level is refused');
}

section('8. stale evidence');
{
  const stale = adapter({
    compile: () => ({
      packet: packet(), manifest: {},
      warnings: [{ kind: 'stale_source', message: 'x', source: 'context/A.md' }],
      errors: [],
    }),
  });
  const strict = requestContext(newContextRequest({ objective: 'x', evidence_level: 'verified_only' }), repo(), stale, { now: NOW });
  check(!strict.granted && strict.refusal_reasons.some((r) => r.reason === 'STALE_EVIDENCE'),
    'stale sources refuse a verified_only request');
  const lenient = requestContext(newContextRequest({ objective: 'x' }), repo(), stale, { now: NOW });
  check(lenient.granted && lenient.freshness_state.stale_sources === 1,
    'a lenient request is served but told how much of its context is stale');
}

section('9. compilation failure and invalid packets');
{
  const thrower = adapter({ compile: () => { throw new Error('boom'); } });
  const r = requestContext(newContextRequest({ objective: 'x' }), repo(), thrower, { now: NOW });
  check(!r.granted && r.refusal_reasons[0].reason === 'COMPILATION_FAILED', 'an adapter that throws becomes a refusal, not a crash');
  check(/boom/.test(r.refusal_reasons[0].message), 'the underlying error is reported');

  const invalid = adapter({
    compile: () => ({ packet: packet(), manifest: {}, warnings: [], errors: ['applicable_policies is empty'] }),
  });
  const r2 = requestContext(newContextRequest({ objective: 'x' }), repo(), invalid, { now: NOW });
  check(!r2.granted && r2.refusal_reasons.some((x) => x.reason === 'COMPILATION_FAILED'),
    'a structurally invalid packet is never served');
}

section('10. contract shape and serialization');
{
  check(REFUSAL_REASONS.length === 10, 'ten refusal reasons are defined');
  check(EVIDENCE_LEVELS.length === 3, 'three evidence levels are defined');
  const req = newContextRequest({ objective: 'x' });
  check(req.output_format === 'both', 'both formats are the default');
  check(req.max_records === 40, 'a record cap is part of the request, not a hidden constant');
  const md = serve({ output_format: 'markdown' });
  check(md.granted && md.packet === null, 'a markdown-only request omits the JSON packet from the response');
  const a = serve(); const b = serve();
  check(JSON.stringify(a) === JSON.stringify(b), 'two identical requests produce identical responses');
  let threw = false;
  try { requestContext(newContextRequest({ objective: 'x' }), repo(), adapter(), {}); } catch { threw = true; }
  check(threw, 'requestContext refuses to run without an explicit instant');
  threw = false;
  try { requestContext(newContextRequest({}), repo(), adapter(), { now: NOW }); } catch { threw = true; }
  check(threw, 'a request without an objective is refused outright');
}

section('11. refusals accumulate');
{
  const r = serve({ required_branch: 'main', required_commit: 'deadbee', require_clean_worktree: true, capability: 'orchestration' },
    { dirty_files: ['x'] });
  const reasons = new Set(r.refusal_reasons.map((x) => x.reason));
  check(reasons.size >= 4, `every independent problem is reported, not just the first (${reasons.size})`);
  check(reasons.has('DIRTY_WORKTREE') && reasons.has('BRANCH_MISMATCH')
    && reasons.has('COMMIT_NOT_FOUND') && reasons.has('CAPABILITY_ABSENT'),
    'all four distinct refusals appear');
}

section('Runner RP gates');
{
  const clean = serve();
  check(clean.granted, 'the happy path still passes — the port is not refusing everything');
  const all = evaluateRefusals(newContextRequest({ objective: 'x', required_branch: 'nope' }), repo());
  check(all.length === 1, 'a single problem yields a single refusal — the port is not inventing failures');
}

console.log(`\neval-runtime-port (Runner RP, pure, deterministic): passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'Runner RP: PASS' : 'Runner RP: FAIL');
process.exit(failed === 0 ? 0 : 1);
