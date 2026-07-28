// ---------------------------------------------------------------------------
// eval-kernel.mjs — assertion harness behind Runner K (awe-kernel unit suite).
//
// PURE. No API keys, no model calls, no DB, no network, no Graph, no mailbox,
// no fixtures on disk except the two real corpora it reads read-only. Exercises
// every kernel module and asserts, as HARD gates:
//
//   * gate bootstrap  — the gate kernel itself counts, prints and exits
//                       correctly (proven with node:assert, NOT with itself)
//   * canonical form  — key order irrelevant, lossy values rejected, digests
//                       stable across runs and pinned to golden values
//   * error taxonomy  — every failure carries a code from the closed vocabulary
//   * reason registry — cross-namespace collisions are caught; declared shares
//                       are allowed; the REAL platform union loads clean
//   * outcome envelope— ok/blocked/failed invariants hold in both directions,
//                       envelopes are frozen, forbidden events are refused
//   * audit events    — content-addressed keys, credential redaction (by key
//                       AND by value shape), duplicate detection
//   * verify steps    — every check kind, context resolution, probe failure
//                       reported as a failed step rather than a crash
//   * corpora         — parity violations in BOTH directions are reported, and
//                       the repo's real corpora load clean
//   * suite registry  — descriptors valid, ids unique, commands point at files
//                       that exist, plan order and skip reasons correct
//   * layering lint   — the kernel has zero dependencies, no network, no clock,
//                       no randomness, no filesystem writes — and the lint is
//                       proven non-vacuous against a synthetic offender
//
// Exit 0 iff all gates pass. Invoked by scripts/eval-kernel.sh.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHECK_KINDS, CONTEXT_ITEM_KINDS, ERROR_CODES, FINAL_STATES, KernelError, OUTCOME_KEYS,
  REDACTED, REPORT_KEYS, REPORT_SCHEMA, RUN_METADATA_KEYS, SUITES, SUITE_KINDS,
  assertEvent, assertExecutionContext, assertNoEvents, assertOutcome, assertReport, blocked,
  buildCorpus, buildReport, canonicalJson, corpusParity, createArtifactSink, createAuditSink,
  createEvent, createExecutionContext, createGateRun, createReasonRegistry, createSuiteRegistry,
  defineContextProvider, defineSuite, defineVerify, deepFreeze, deriveRunId, digest, explain,
  failed, finalStateFor, fromError, get, instantDate, isInstant, isKernelError, loadCorpus,
  memoryArtifactSink, memoryAuditSink, nullArtifactSink, redact, registry, reportPath, runMetadata,
  runVerify, runWorkflow, sequence, serializeReport, stableEqual, stripComments, succeeded,
} from '../packages/awe-kernel/src/index.mjs';
import { SHARED_REASONS, reasons as platformReasons } from './lib/awe-reasons.mjs';
import { CLASSIFICATION_WRITE_BACK } from './lib/db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const KERNEL_SRC = join(ROOT, 'packages', 'awe-kernel', 'src');

const run = createGateRun({ name: 'eval-kernel (Runner K, pure, deterministic)' });
const { check, equal, section } = run;

// A throw anywhere outside a gate would exit 0 through no fault of the gates,
// so every section body runs inside this wrapper.
function group(title, body) {
  section(title);
  try {
    body();
  } catch (e) {
    check(false, `${title}: threw unexpectedly — ${e?.stack ?? e}`);
  }
}
async function groupAsync(title, body) {
  section(title);
  try {
    await body();
  } catch (e) {
    check(false, `${title}: threw unexpectedly — ${e?.stack ?? e}`);
  }
}

// --- 1. gate bootstrap ------------------------------------------------------
// The gate kernel cannot be its own witness. node:assert proves it counts,
// prints and reports correctly; every later section may then rely on it.
group('gate bootstrap (proven with node:assert, not with itself)', () => {
  const lines = [];
  const probe = createGateRun({ name: 'probe', log: (l) => lines.push(l) });

  probe.check(true, 'unused');
  assert.equal(probe.pass, 1);
  assert.equal(probe.fail, 0);
  assert.equal(probe.exitCode, 0);

  probe.check(false, 'deliberate failure');
  assert.equal(probe.fail, 1);
  assert.equal(probe.exitCode, 1);
  assert.deepEqual(lines, ['FAIL  deliberate failure'], 'failure line format must stay `FAIL  <message>`');

  // equal() compares by canonical bytes, so key order must not matter.
  probe.equal({ a: 1, b: 2 }, { b: 2, a: 1 }, 'key order');
  assert.equal(probe.fail, 1, 'key order must not be a difference');

  // determinism gate: a clock-dependent producer must fail, a pure one must pass.
  let tick = 0;
  probe.deterministic(() => ({ t: (tick += 1) }), 'ticking producer');
  assert.equal(probe.fail, 2, 'determinism gate must catch a varying producer');
  probe.deterministic(() => ({ t: 1 }), 'pure producer');
  assert.equal(probe.fail, 2);

  // coverage gate is HARD and prints the x/y line.
  probe.record('v', ['a']);
  probe.coverage('v', ['a', 'b'], { label: 'v coverage' });
  assert.equal(probe.fail, 3, 'uncovered vocabulary must fail');
  assert.ok(lines.some((l) => l === 'v coverage 1/2'), 'coverage must print x/y');

  // contract gate
  probe.contract({ a: 1 }, ['a', 'b'], 'shape');
  assert.equal(probe.fail, 4);
  probe.contract(null, ['a'], 'null shape');
  assert.equal(probe.fail, 5);

  // throwsKernel
  probe.throwsKernel(() => { throw new KernelError('invalid_input', 'x'); }, 'invalid_input', 'typed throw');
  probe.throwsKernel(() => undefined, 'invalid_input', 'missing throw');
  assert.equal(probe.fail, 6, 'a call that does not throw must fail the gate');

  const report = probe.summary({ quiet: true });
  assert.equal(report.fail, 6);
  assert.equal(report.failures.length, 6);
  assert.equal(typeof report.digest, 'string');

  check(true, 'gate bootstrap');
});

// --- 2. canonical form ------------------------------------------------------
group('canonical form + digests', () => {
  equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}', 'keys sorted at the top level');
  equal(canonicalJson({ a: [{ z: 1, y: 2 }] }), '{"a":[{"y":2,"z":1}]}', 'keys sorted at depth');
  equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}', 'undefined properties dropped');
  equal(canonicalJson([undefined]), '[null]', 'undefined array slots become null');
  equal(canonicalJson(-0), '0', '-0 collapses to 0');
  check(stableEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), 'stableEqual ignores key order');
  check(!stableEqual({ a: 1 }, { a: '1' }), 'stableEqual distinguishes types');

  // Lossy or ambiguous values are refused, loudly, with a path.
  run.throwsKernel(() => canonicalJson({ a: NaN }), 'invalid_input', 'NaN rejected');
  run.throwsKernel(() => canonicalJson({ a: Infinity }), 'invalid_input', 'Infinity rejected');
  run.throwsKernel(() => canonicalJson({ a: () => 1 }), 'invalid_input', 'function rejected');
  run.throwsKernel(() => canonicalJson({ a: new Date(0) }), 'invalid_input', 'Date rejected');
  run.throwsKernel(() => canonicalJson({ a: new Map() }), 'invalid_input', 'Map rejected');
  run.throwsKernel(() => canonicalJson({ a: 1n }), 'invalid_input', 'bigint rejected');
  run.throwsKernel(() => { const o = {}; o.self = o; return canonicalJson(o); }, 'invalid_input', 'cycle rejected');

  // A shared sub-object is not a cycle and must still serialize.
  const shared = { x: 1 };
  equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}', 'shared reference is not a cycle');

  // Golden digests — a change here changes every idempotency key in the
  // platform, so it must be a deliberate, visible edit.
  equal(digest({ a: 1 }), '015abd7f5cc57a2d', 'golden digest {a:1}');
  equal(digest({ a: 1 }), digest({ a: 1 }), 'digest stable within a run');
  check(digest({ a: 1 }) !== digest({ a: 2 }), 'digest distinguishes values');
  equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }), 'digest ignores key order');
  equal(digest({ a: 1 }, { length: 8 }).length, 8, 'digest length honoured');
  run.throwsKernel(() => digest({}, { length: 4 }), 'invalid_input', 'digest length floor enforced');

  // deepFreeze
  const frozen = deepFreeze({ a: { b: 1 } });
  try { frozen.a.b = 2; } catch { /* strict mode throws; sloppy mode ignores */ }
  equal(frozen.a.b, 1, 'deepFreeze protects nested values');

  // get()
  equal(get({ a: [{ b: 7 }] }, 'a.0.b'), 7, 'get resolves array indices');
  equal(get({ a: null }, 'a.b', 'fallback'), 'fallback', 'get falls back through null');
  equal(get({ a: 1 }, ''), { a: 1 }, 'an empty path is the whole value');
  equal(get({ a: 1 }, null), { a: 1 }, 'a null path is the whole value');
});

// --- 3. error taxonomy ------------------------------------------------------
group('error taxonomy', () => {
  check(ERROR_CODES.length === new Set(ERROR_CODES).size, 'error codes are unique');
  const e = new KernelError('verify_failed', 'nope', { a: 1 });
  equal(e.code, 'verify_failed', 'code preserved');
  equal(e.toJSON().details.a, 1, 'details preserved');
  check(isKernelError(e, 'verify_failed'), 'isKernelError matches by code');
  check(!isKernelError(e, 'invalid_input'), 'isKernelError rejects the wrong code');
  check(!isKernelError(new Error('x')), 'a plain Error is not a KernelError');
  // An unknown code is downgraded but flagged, never silently accepted.
  const unknown = new KernelError('not_a_real_code', 'x');
  equal(unknown.code, 'invalid_input', 'unknown code downgraded');
  check(unknown.message.includes('unknown error code'), 'unknown code is announced');
});

// --- 4. reason registry -----------------------------------------------------
group('blocked-reason registry', () => {
  const r = createReasonRegistry();
  r.register('alpha', ['no_policy', 'policy_inactive']);
  r.register('beta', ['not_pending']);
  equal(r.all(), ['no_policy', 'not_pending', 'policy_inactive'], 'union is sorted');
  equal(r.listNamespaces(), ['alpha', 'beta'], 'namespaces listed');
  equal(r.ofNamespace('alpha'), ['no_policy', 'policy_inactive'], 'namespace membership');
  check(r.has('no_policy') && !r.has('nope'), 'membership test');
  equal(r.uncovered(new Set(['no_policy'])), ['not_pending', 'policy_inactive'], 'uncovered reasons');
  equal(r.sharedInUse(), [], 'nothing shared by default');

  run.throwsKernel(() => r.register('alpha', []), 'vocabulary_conflict', 'namespace re-registration refused');
  run.throwsKernel(() => r.register('gamma', ['no_policy']), 'vocabulary_conflict', 'undeclared collision refused');
  run.throwsKernel(() => r.register('gamma', ['NotSnakeCase']), 'invalid_input', 'non-snake_case reason refused');
  run.throwsKernel(() => r.register('gamma', ['dup', 'dup']), 'vocabulary_conflict', 'in-namespace duplicate refused');
  run.throwsKernel(() => r.assert('never_registered'), 'unknown_reason', 'unknown reason refused');

  // Declared sharing is allowed and reported.
  const shared = createReasonRegistry({ shared: ['test_mode_violation'] });
  shared.register('a', ['test_mode_violation']);
  shared.register('b', ['test_mode_violation']);
  equal(shared.sharedInUse(), ['test_mode_violation'], 'declared share reported');
  equal(shared.namespacesOf('test_mode_violation'), ['a', 'b'], 'both owners recorded');

  // The REAL platform union (route + gate + queue + classify + mcp +
  // control_plane). Loading it at all is the collision check; these gates pin
  // its shape. A new execution surface adding a namespace is expected — a new
  // surface adding a reason that COLLIDES with an existing one is what this
  // catches, and it is why the list below is exact rather than a subset check.
  check(platformReasons.all().length >= 15, `platform union has ${platformReasons.all().length} reasons`);
  equal(
    platformReasons.listNamespaces(),
    ['agent_runtime', 'classify', 'control_plane', 'durable_execution', 'gate', 'mcp', 'memory', 'queue', 'route'],
    'platform namespaces',
  );
  equal(platformReasons.sharedInUse(), SHARED_REASONS, 'only the declared reason is shared across namespaces');
  check(platformReasons.has('no_policy') && platformReasons.has('not_pending') && platformReasons.has('duplicate_draft'),
    'platform union spans all three engines');
});

// --- 5. outcome envelope ----------------------------------------------------
group('workflow outcome envelope', () => {
  const ev = createEvent({ event_type: 'request.classified', entity_type: 'work_request', entity_id: 'wr-1' });

  const okOutcome = succeeded({ id: 'wr-1' }, { events: [ev], audit: ['classified'], meta: { workflow: 'triage' } });
  run.contract(okOutcome, OUTCOME_KEYS, 'ok outcome contract');
  check(okOutcome.ok === true && okOutcome.status === 'ok', 'ok status');
  equal(okOutcome.blocked_reason, null, 'ok carries no blocked reason');
  equal(okOutcome.error, null, 'ok carries no error');
  check(Object.isFrozen(okOutcome) && Object.isFrozen(okOutcome.events), 'outcome is deep-frozen');
  assertOutcome(okOutcome);

  const blockedOutcome = blocked('no_policy', { reasons: platformReasons, audit: ['refused'] });
  check(blockedOutcome.ok === false && blockedOutcome.status === 'blocked', 'blocked status');
  equal(blockedOutcome.blocked_reason, 'no_policy', 'blocked reason recorded');
  assertOutcome(blockedOutcome, { reasons: platformReasons });
  run.throwsKernel(() => blocked('invented_reason', { reasons: platformReasons }), 'unknown_reason',
    'blocked() refuses an unregistered reason');

  const failedOutcome = failed('verify_failed', 'write-back did not land');
  check(failedOutcome.ok === false && failedOutcome.status === 'failed', 'failed status');
  equal(failedOutcome.error.code, 'verify_failed', 'error code recorded');
  run.throwsKernel(() => failed('nope', 'x'), 'invalid_input', 'failed() refuses an unknown code');

  const converted = fromError(new KernelError('corpus_parity', 'bad corpus', { n: 1 }));
  equal(converted.error.code, 'corpus_parity', 'fromError preserves a kernel code');
  equal(fromError(new Error('plain')).error.code, 'contract_violation', 'fromError classifies a plain Error');

  // Contradictory envelopes must be caught, in both directions.
  run.throwsKernel(() => assertOutcome({ ...okOutcome, ok: false }), 'contract_violation', 'ok/status contradiction caught');
  run.throwsKernel(() => assertOutcome({ ...okOutcome, blocked_reason: 'no_policy' }), 'contract_violation',
    'ok with a blocked reason caught');
  run.throwsKernel(() => assertOutcome({ ...blockedOutcome, blocked_reason: null, ok: false }), 'contract_violation',
    'blocked without a reason caught');
  run.throwsKernel(() => assertOutcome({ ...okOutcome, status: 'weird' }), 'contract_violation', 'unknown status caught');
  run.throwsKernel(() => assertOutcome({}), 'contract_violation', 'missing keys caught');
  run.throwsKernel(() => succeeded(null, { audit: [''] }), 'invalid_input', 'empty audit line refused');
  run.throwsKernel(() => succeeded(null, { events: [{ event_type: 'x' }] }), 'contract_violation',
    'malformed event refused at the envelope boundary');

  // The reusable "this workflow has no send path" guard.
  assertNoEvents(okOutcome, ['message.sent', 'message.approved']);
  const sendish = succeeded(null, {
    events: [createEvent({ event_type: 'message.sent', entity_type: 'outbound_message', entity_id: 'm1' })],
  });
  run.throwsKernel(() => assertNoEvents(sendish, ['message.sent']), 'contract_violation', 'forbidden event caught');
});

// --- 6. audit events --------------------------------------------------------
group('audit event envelope', () => {
  const a = createEvent({ event_type: 'request.classified', entity_type: 'work_request', entity_id: 'wr-1', org_id: 'org-1', payload: { n: 1 } });
  const b = createEvent({ event_type: 'request.classified', entity_type: 'work_request', entity_id: 'wr-1', org_id: 'org-1', payload: { n: 1 } });
  equal(a.event_key, b.event_key, 'identical events share an event_key');
  check(Object.isFrozen(a), 'events are frozen');
  assertEvent(a);

  const c = createEvent({ ...a, payload: { n: 2 } });
  check(a.event_key !== c.event_key, 'payload change changes the event_key');

  // occurred_at is excluded from the key: the same logical event replayed later
  // is still the same event for idempotency.
  const later = createEvent({ ...a, occurred_at: '2026-07-27T12:00:00Z' });
  equal(later.event_key, a.event_key, 'occurred_at does not change the event_key');

  equal(createEvent({ event_type: 'duplicate_flagged', entity_type: 'work_request', entity_id: null }).entity_id, null,
    'snake_case event types and null entity ids are legal');
  run.throwsKernel(() => createEvent({ event_type: 'Request.Classified', entity_type: 'work_request', entity_id: 'x' }),
    'invalid_input', 'non-snake_case event type refused');
  run.throwsKernel(() => createEvent({ event_type: 'a.b', entity_type: 'Work_Request', entity_id: 'x' }),
    'invalid_input', 'non-snake_case entity type refused');
  run.throwsKernel(() => createEvent({ event_type: 'a.b', entity_type: 'wr', entity_id: 'x', occurred_at: '2026-07-27' }),
    'invalid_input', 'a date without an instant is refused (no clock guessing)');
  run.throwsKernel(() => assertEvent({ ...a, event_key: 'tampered0000000' }), 'contract_violation',
    'a tampered event_key is caught');

  // Redaction: by key name AND by value shape, at any depth.
  const dirty = {
    api_key: 'plain-value',
    nested: { SUPABASE_SERVICE_ROLE_KEY: 'x', note: 'fine' },
    list: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'ordinary'],
    header: 'Bearer abcdefghijklmnopqrstuvwx',
    token_count: 42,
  };
  const clean = redact(dirty);
  equal(clean.api_key, REDACTED, 'secret key name redacted');
  equal(clean.nested.SUPABASE_SERVICE_ROLE_KEY, REDACTED, 'nested secret redacted');
  equal(clean.nested.note, 'fine', 'innocent value preserved');
  equal(clean.list[0], REDACTED, 'JWT redacted by value shape even in an array');
  equal(clean.list[1], 'ordinary', 'non-secret array entry preserved');
  equal(clean.header, REDACTED, 'Authorization-style value redacted');
  equal(clean.token_count, REDACTED, 'a key that reads as a credential is redacted even when numeric');

  // A credential inside a longer message is the realistic case: tokens arrive in
  // error text, not on their own. Scrubbing is by substring, and the surrounding
  // words survive so the message still means something to a human.
  equal(redact({ msg: 'auth failed for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig at step 3' }).msg,
    `auth failed for ${REDACTED} at step 3`, 'an embedded JWT is scrubbed in place');
  equal(redact({ msg: 'used sbp_0123456789abcdef0123456789 to connect' }).msg,
    `used ${REDACTED} to connect`, 'an embedded management token is scrubbed');
  equal(redact({ msg: 'header was Bearer abcdefghijklmnopqrstuvwx (rejected)' }).msg,
    `header was ${REDACTED} (rejected)`, 'an embedded Authorization value is scrubbed');
  equal(redact({ msg: 'key sk-abcdefghijklmnopqrstuv rotated' }).msg,
    `key ${REDACTED} rotated`, 'an embedded provider key is scrubbed');
  equal(redact({ msg: 'nothing secret here at all' }).msg, 'nothing secret here at all',
    'an innocent message is returned byte-identical');
  // The deny-list must not eat the evidence it exists to protect. `pass` is a
  // runner's pass counter, not a credential; `password` still is one.
  equal(redact({ pass: 349, fail: 0 }), { pass: 349, fail: 0 }, 'a pass/fail counter survives redaction');
  equal(redact({ password: 'hunter2' }).password, REDACTED, 'a password is still redacted');
  equal(redact({ passphrase: 'x' }).passphrase, REDACTED, 'a passphrase is still redacted');
  equal(redact({ passcode: 'x' }).passcode, REDACTED, 'a passcode is still redacted');
  equal(redact({ compass_bearing: 12 }).compass_bearing, 12, 'an unrelated word containing "pass" survives');

  // Repeated calls must not drift: a global regex carries `lastIndex` state.
  equal(redact({ a: 'x sbp_0123456789abcdef0123456789', b: 'y sbp_0123456789abcdef0123456789' }),
    { a: `x ${REDACTED}`, b: `y ${REDACTED}` }, 'scrubbing is stateless across values');
  equal(createEvent({ event_type: 'a.b', entity_type: 'wr', entity_id: 'x', payload: { password: 'hunter2' } }).payload.password,
    REDACTED, 'createEvent redacts on the way in');

  // Batch sequencing + duplicate detection.
  const batch = sequence([a, c, b]);
  equal(batch.events.map((e) => e.seq), [1, 2, 3], 'seq is positional');
  equal(batch.duplicates.length, 1, 'repeat detected');
  equal(batch.duplicates[0].repeat, 2, 'repeat index reported');
  equal(sequence([a, c]).duplicates, [], 'distinct events produce no duplicates');
});

// --- 7. verify steps --------------------------------------------------------
await groupAsync('verify steps', async () => {
  check(CHECK_KINDS.length === new Set(CHECK_KINDS).size, 'check kinds are unique');

  const spec = defineVerify({
    name: 'classification.write_back',
    sources: ['row', 'events', 'rows', 'name'],
    checks: [
      { id: 'row_updated', kind: 'exists', source: 'row' },
      { id: 'values_match', kind: 'fields_equal', source: 'row', fields: { classification: { $ctx: 'classification' }, status: { $ctx: 'status' } } },
      { id: 'org_scoped', kind: 'equals', source: 'row', path: 'org_id', expectedPath: 'org' },
      { id: 'event_present', kind: 'count_at_least', source: 'events', expected: 1 },
      { id: 'no_duplicate_side_effect', kind: 'count_equals', source: 'rows', expected: 1 },
      { id: 'urgency_known', kind: 'one_of', source: 'row', path: 'urgency', expected: ['standard', 'emergency'] },
      { id: 'not_draft', kind: 'not_equals', source: 'row', path: 'status', expected: 'draft' },
      { id: 'reason_absent', kind: 'absent', source: 'row', path: 'blocked_reason' },
      { id: 'name_shape', kind: 'matches', source: 'name', pattern: '^wr-[0-9]+$' },
      { id: 'name_present', kind: 'non_empty', source: 'name' },
    ],
  });

  equal(spec.sources, ['events', 'name', 'row', 'rows'], 'declared sources sorted');

  const context = { classification: 'emergency', status: 'escalated', org: 'org-1' };
  const good = {
    row: { org_id: 'org-1', classification: 'emergency', status: 'escalated', urgency: 'emergency', blocked_reason: null },
    events: [{ n: 2 }],   // management-API count shape
    rows: 1,              // bare number
    name: 'wr-42',
  };

  let probeCalls = 0;
  const okResult = await runVerify(spec, { probe: (s) => { probeCalls += 1; return good[s]; }, context });
  check(okResult.ok, `all checks pass: ${explain(okResult)}`);
  equal(probeCalls, 4, 'each source is probed exactly once');
  equal(Object.keys(okResult.checks).length, 10, 'every check reported');
  check(explain(okResult).includes('OK'), 'explain renders a passing step');

  // Same verdict twice => same digest. This is what makes a Verify Step
  // comparable across runs.
  const again = await runVerify(spec, { probe: (s) => good[s], context });
  equal(again.digest, okResult.digest, 'verify digest is stable');

  const badRow = { ...good, row: { ...good.row, org_id: 'other-org', status: 'draft', urgency: 'whenever', blocked_reason: 'x' } };
  const badResult = await runVerify(spec, { probe: (s) => badRow[s], context });
  check(!badResult.ok, 'wrong org / status / urgency fails');
  equal(badResult.failures.map((f) => f.id).sort(),
    ['not_draft', 'org_scoped', 'reason_absent', 'urgency_known', 'values_match'],
    'exactly the violated checks are reported');
  check(explain(badResult).includes('FAILED'), 'explain renders a failing step');

  const missing = await runVerify(spec, { probe: () => undefined, context });
  check(!missing.ok, 'an absent row fails the step');

  // A probe that throws is a FAILED step, not a crash: an unreachable database
  // must never be mistaken for a verified write.
  const thrown = await runVerify(spec, {
    probe: (s) => { if (s === 'row') throw new Error('connection reset'); return good[s]; },
    context,
  });
  check(!thrown.ok, 'probe failure fails the step');
  check(thrown.failures.some((f) => f.probe_error === 'connection reset'), 'probe error is reported verbatim');
  check(explain(thrown).includes('connection reset'), 'explain surfaces the probe error');

  // Spec construction is validated up front, so a typo cannot silently become a
  // check that never runs.
  run.throwsKernel(() => defineVerify({ name: 'x', checks: [{ id: 'a', kind: 'nope', source: 's' }] }), 'invalid_input', 'unknown kind refused');
  run.throwsKernel(() => defineVerify({ name: 'x', checks: [{ id: 'A', kind: 'exists', source: 's' }] }), 'invalid_input', 'non-snake_case id refused');
  run.throwsKernel(() => defineVerify({ name: 'x', checks: [{ id: 'a', kind: 'exists', source: 's' }, { id: 'a', kind: 'exists', source: 's' }] }), 'invalid_input', 'duplicate id refused');
  run.throwsKernel(() => defineVerify({ name: 'x', checks: [{ id: 'a', kind: 'exists', source: 's' }], sources: ['t'] }), 'invalid_input', 'undeclared source refused');
  run.throwsKernel(() => defineVerify({ name: 'x', checks: [] }), 'invalid_input', 'empty spec refused');
  run.throwsKernel(() => defineVerify({ name: 'x', checks: [{ id: 'a', kind: 'one_of', source: 's', expected: 'not-an-array' }] }), 'invalid_input', 'one_of needs an array');
  run.throwsKernel(() => defineVerify({ name: 'x', checks: [{ id: 'a', kind: 'count_equals', source: 's', expected: 'many' }] }), 'invalid_input', 'count needs a number');
  await assert.rejects(() => runVerify(spec, {}), (e) => isKernelError(e, 'invalid_input'), 'runVerify demands a probe');
  check(true, 'runVerify demands a probe');
});

// --- 7b. execution context + run metadata -----------------------------------
group('execution context + run metadata', () => {
  const ctx = createExecutionContext({
    run_id: 'run-1', workflow_id: 'outbound_draft', org_id: 'org-1',
    started_at: '2026-07-27T09:00:00Z', trace_id: 't-1',
  });
  run.contract(ctx, RUN_METADATA_KEYS, 'execution context contract');
  equal(ctx.actor, 'service', 'actor defaults to service');
  equal(ctx.mode, 'TEST', 'mode fails closed to TEST');
  equal(ctx.is_fixture, true, 'runs are fixture runs unless stated otherwise');
  check(Object.isFrozen(ctx), 'context is frozen');
  assertExecutionContext(ctx);

  equal(runMetadata(ctx), {
    run_id: 'run-1', workflow_id: 'outbound_draft', org_id: 'org-1',
    actor: 'service', mode: 'TEST', is_fixture: true, trace_id: 't-1',
  }, 'run metadata is the correlation subset');

  // Attributes are redacted on the way in: a token passed here must not leak
  // into every artifact the run writes.
  equal(createExecutionContext({ run_id: 'r', workflow_id: 'w', attributes: { api_key: 'x', note: 'fine' } }).attributes,
    { api_key: REDACTED, note: 'fine' }, 'context attributes are redacted');

  // Derived ids are deterministic — a replay is the same run.
  equal(deriveRunId({ workflow_id: 'classify_email', inputs: { a: 1 } }),
    deriveRunId({ workflow_id: 'classify_email', inputs: { a: 1 } }), 'run id is deterministic');
  check(deriveRunId({ workflow_id: 'classify_email', inputs: { a: 1 } })
    !== deriveRunId({ workflow_id: 'classify_email', inputs: { a: 2 } }), 'run id distinguishes inputs');
  check(deriveRunId({ workflow_id: 'classify_email', inputs: null }).startsWith('classify_email-'),
    'run id names its workflow');

  // Fail-closed refusals. A LIVE run with no tenant is the MCP "first org"
  // defect (ADR-0002 condition 1) and must be impossible to construct.
  run.throwsKernel(() => createExecutionContext({ run_id: 'r', workflow_id: 'w', mode: 'LIVE', is_fixture: false }),
    'invalid_input', 'a LIVE run with no tenant is refused');
  run.throwsKernel(() => createExecutionContext({ run_id: 'r', workflow_id: 'w', mode: 'LIVE', org_id: 'o', is_fixture: true }),
    'invalid_input', 'is_fixture=true contradicting LIVE is refused');
  run.throwsKernel(() => createExecutionContext({ run_id: 'r', workflow_id: 'NotSnake' }), 'invalid_input', 'non-snake_case workflow refused');
  run.throwsKernel(() => createExecutionContext({ run_id: '', workflow_id: 'w' }), 'invalid_input', 'empty run id refused');
  run.throwsKernel(() => createExecutionContext({ run_id: 'r', workflow_id: 'w', actor: 'robot' }), 'invalid_input', 'unknown actor refused');
  run.throwsKernel(() => createExecutionContext({ run_id: 'r', workflow_id: 'w', mode: 'test' }), 'invalid_input', 'mode matching is case-sensitive');
  run.throwsKernel(() => createExecutionContext({ run_id: 'r', workflow_id: 'w', started_at: '2026-07-27' }),
    'invalid_input', 'a bare date is not an instant (no clock guessing)');
  run.throwsKernel(() => assertExecutionContext({}), 'contract_violation', 'a bag with no run metadata is refused');

  check(isInstant('2026-07-27T09:00:00Z') && !isInstant('2026-07-27'), 'isInstant demands a point in time');
  equal(instantDate('2026-07-27T09:00:00.123Z'), '2026-07-27', 'instantDate partitions by day');
});

// --- 7c. sinks (artifact / audit / context provider) -------------------------
await groupAsync('sink and provider boundaries', async () => {
  const ctx = createExecutionContext({ run_id: 'run-2', workflow_id: 'outbound_draft', org_id: 'org-1', started_at: '2026-07-27T09:00:00Z' });

  const artifacts = memoryArtifactSink();
  const outcome = succeeded({ id: 1 }, { audit: [{ step: 'gate', ok: true, detail: null }] });
  const rep = buildReport({ context: ctx, outcome, finished_at: '2026-07-27T09:00:01Z' });

  const written = await artifacts.write(rep, { path: 'a/b.json' });
  check(written.ok && written.ref === 'a/b.json', 'memory artifact sink stores by path');
  equal(artifacts.list(), ['a/b.json'], 'stored artifacts are listable');
  equal(artifacts.read('a/b.json').run_id, 'run-2', 'stored artifact is readable');
  equal(artifacts.read('nope'), null, 'an unknown ref reads as null');

  const discard = nullArtifactSink();
  check((await discard.write(rep, { path: 'x' })).ok, 'null sink accepts and keeps nothing');

  const audit = memoryAuditSink();
  const e1 = createEvent({ event_type: 'message.draft_created', entity_type: 'outbound_message', entity_id: 'd-1' });
  const e2 = createEvent({ event_type: 'message.escalated', entity_type: 'outbound_message', entity_id: 'd-1' });
  const emitted = await audit.emit([e1, e2, e1], ctx);
  check(emitted.ok, 'audit sink accepts events');
  equal(emitted.written, 2, 'distinct events written');
  equal(emitted.deduped, 1, 'a repeated event is deduped at the sink, before any database');
  equal(audit.events().length, 2, 'only distinct events are retained');

  // Malformed input never reaches an implementation.
  await assert.rejects(async () => audit.emit([{ event_type: 'x' }], ctx),
    (e) => isKernelError(e, 'contract_violation'), 'a malformed event is refused at the sink boundary');
  check(true, 'a malformed event is refused at the sink boundary');
  run.throwsKernel(() => audit.emit('not-an-array', ctx), 'invalid_input', 'audit sink demands an array');

  // Interface validation: a sink is a shape, and a broken one fails at wiring
  // time rather than on the first run that needed it.
  run.throwsKernel(() => createArtifactSink({ name: 'no_write' }), 'invalid_input', 'artifact sink must implement write()');
  run.throwsKernel(() => createArtifactSink({ name: 'Bad Name', write() {} }), 'invalid_input', 'sink name must be snake_case');
  run.throwsKernel(() => createAuditSink({ name: 'no_emit' }), 'invalid_input', 'audit sink must implement emit()');
  run.throwsKernel(() => createArtifactSink(null), 'invalid_input', 'a null sink is refused');

  // Context provider: a declared shape that returns data and grants nothing.
  const provider = defineContextProvider({
    name: 'policy_rows', kind: 'policy', trusted: true, load: () => [{ id: 'p1', body: 'draft only' }],
  });
  equal(provider.item_kind, 'policy', 'provider declares the kind of item it produces');
  equal(provider.trusted, true, 'trust is a property of the source, declared once');
  equal((await provider.load(ctx)).length, 1, 'provider returns items');
  run.throwsKernel(() => defineContextProvider({ name: 'p', kind: 'nonsense', trusted: true, load: () => [] }),
    'invalid_input', 'unknown context item kind refused');
  run.throwsKernel(() => defineContextProvider({ name: 'p', kind: 'policy', load: () => [] }),
    'invalid_input', 'a provider that does not declare trust is refused');
  check(CONTEXT_ITEM_KINDS.length === new Set(CONTEXT_ITEM_KINDS).size, 'context item kinds are unique');

  // The boundary decides nothing that ADR-0002 still has to decide: there is no
  // capability, permission, role or policy surface anywhere on a sink.
  const surface = [...Object.keys(artifacts), ...Object.keys(audit), ...Object.keys(provider)];
  equal(surface.filter((k) => /capabilit|permission|authoriz|grant|policy_check|tenant_policy/i.test(k)), [],
    'sink and provider interfaces expose no authorization surface');
});

// --- 7d. durable run report --------------------------------------------------
group('durable run report', () => {
  const ctx = createExecutionContext({
    run_id: 'run-3', workflow_id: 'outbound_draft', org_id: 'org-1',
    started_at: '2026-07-27T09:00:00Z', trace_id: 'trace-3',
  });
  const ev = createEvent({ event_type: 'message.blocked', entity_type: 'outbound_message', entity_id: 'fixture:x', org_id: 'org-1' });
  const outcome = blocked('no_policy', {
    reasons: platformReasons,
    events: [ev],
    audit: [
      { step: 'authorize_action', ok: true, detail: 'create_draft' },
      { step: 'route', ok: false, detail: 'no active policy row' },
      'plain note',
    ],
  });

  const rep = buildReport({ context: ctx, outcome, finished_at: '2026-07-27T09:00:02Z' });
  run.contract(rep, REPORT_KEYS, 'run report contract');
  assertReport(rep);
  equal(rep.schema, REPORT_SCHEMA, 'schema is pinned and versioned');
  equal(rep.status, 'blocked', 'status carried from the outcome');
  equal(rep.blocked_reason, 'no_policy', 'machine-readable reason carried');
  equal(rep.final_state, 'blocked', 'a refusal is a blocked run, not a failure');
  equal(rep.run_id, 'run-3', 'correlation id present');
  equal(rep.trace_id, 'trace-3', 'trace id present');
  equal(rep.gate_decisions.map((g) => [g.seq, g.gate, g.ok]),
    [[1, 'authorize_action', true], [2, 'route', false], [3, 'plain note', true]],
    'gate decisions are ordered and normalized from both audit shapes');
  equal(rep.audit_log, ['plain note'], 'plain notes are kept separately');
  equal(rep.audit_events.length, 1, 'audit events travel with the report');

  // Determinism: the same run produces the same bytes, so a replay overwrites
  // its own artifact instead of accumulating near-duplicates.
  run.deterministic(() => buildReport({ context: ctx, outcome, finished_at: '2026-07-27T09:00:02Z' }), 'buildReport');
  equal(serializeReport(rep), `${canonicalJson(rep)}\n`, 'serialization is canonical JSON with a newline');

  // The report proves WHICH result was produced without republishing it.
  const okOutcome = succeeded({ subject: 'Re: your request', body_text: 'Hello Dana' });
  const okRep = buildReport({ context: ctx, outcome: okOutcome, finished_at: '2026-07-27T09:00:02Z' });
  equal(okRep.data_digest, digest({ subject: 'Re: your request', body_text: 'Hello Dana' }), 'data recorded as a digest');
  check(!serializeReport(okRep).includes('Hello Dana'), 'the draft body never reaches the artifact');
  equal(buildReport({ context: ctx, outcome: succeeded(null), finished_at: null }).data_digest, null,
    'no data means no digest, not an invented one');

  // Redaction is belt and braces: a credential anywhere in the run is gone.
  const dirtyRep = buildReport({
    context: ctx,
    outcome: succeeded(null, { audit: [{ step: 'x', ok: true, detail: 'ok' }] }),
    summary: { service_role_key: 'sb_secret_abc', token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', keep: 'visible' },
    finished_at: '2026-07-27T09:00:02Z',
  });
  equal(dirtyRep.summary.service_role_key, REDACTED, 'a credential in the summary is redacted');
  equal(dirtyRep.summary.token, REDACTED, 'a JWT in the summary is redacted');
  equal(dirtyRep.summary.keep, 'visible', 'non-secret summary detail survives');

  // The second layer: a credential that arrived through the gate trail rather
  // than the summary is redacted too. Nothing in a report is exempt.
  const dirtyTrail = buildReport({
    context: ctx,
    outcome: succeeded(null, {
      audit: [
        { step: 'authenticate', ok: false, detail: 'rejected token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' },
        { step: 'connect', ok: false, detail: 'Bearer abcdefghijklmnopqrstuvwx' },
      ],
    }),
    finished_at: '2026-07-27T09:00:02Z',
  });
  equal(dirtyTrail.gate_decisions[0].detail, `rejected token ${REDACTED}`,
    'a JWT in a gate decision is redacted, and the surrounding message survives');
  equal(dirtyTrail.gate_decisions[1].detail, REDACTED, 'an Authorization value in a gate decision is redacted');
  check(!serializeReport(dirtyTrail).includes('eyJhbGciOiJIUzI1NiJ9'), 'no credential survives serialization');

  // Error detail is bounded and code-first.
  const failRep = buildReport({
    context: ctx,
    outcome: failed('verify_failed', 'x'.repeat(900)),
    finished_at: '2026-07-27T09:00:02Z',
  });
  equal(failRep.error.code, 'verify_failed', 'error code is the machine contract');
  check(failRep.error.message.length <= 501, `error message truncated (${failRep.error.message.length} chars)`);
  equal(failRep.final_state, 'failed', 'a failure reports as failed');

  // An unpersisted run is never reported as completed.
  equal(buildReport({ context: ctx, outcome: okOutcome, finished_at: null, persisted: false }).final_state, 'incomplete',
    'a run whose record did not land is incomplete, not completed');
  equal(finalStateFor('ok'), 'completed', 'finalStateFor maps a success');
  check(FINAL_STATES.length === new Set(FINAL_STATES).size, 'final states are unique');

  // Predictable, contained paths.
  equal(reportPath(rep), 'outbound_draft/2026-07-27/run-3.json', 'artifact path is <workflow>/<date>/<run_id>.json');
  equal(reportPath(buildReport({ context: createExecutionContext({ run_id: 'r', workflow_id: 'w' }), outcome: okOutcome })),
    'w/undated/r.json', 'a run with no start time lands under undated, not a guessed date');

  // Tampering is caught.
  run.throwsKernel(() => assertReport({ ...rep, status: 'ok' }), 'contract_violation', 'a tampered report is caught by its digest');
  run.throwsKernel(() => assertReport({ ...rep, schema: 'awe.run_report/v99' }), 'contract_violation', 'an unknown schema version is refused');
  run.throwsKernel(() => assertReport({}), 'contract_violation', 'missing report keys caught');
  run.throwsKernel(() => buildReport({ context: ctx, outcome: { ok: true } }), 'contract_violation', 'a non-envelope outcome is refused');
  run.throwsKernel(() => buildReport({ context: {}, outcome: okOutcome }), 'contract_violation', 'a report needs a real context');
});

// --- 7e. run scaffolding -----------------------------------------------------
await groupAsync('run scaffolding (runWorkflow)', async () => {
  const ctx = createExecutionContext({
    run_id: 'run-4', workflow_id: 'outbound_draft', org_id: 'org-1', started_at: '2026-07-27T09:00:00Z',
  });
  const ev = createEvent({ event_type: 'message.draft_created', entity_type: 'outbound_message', entity_id: 'd-9', org_id: 'org-1' });

  const artifacts = memoryArtifactSink();
  const audit = memoryAuditSink();
  const ok = await runWorkflow({
    context: ctx, artifacts, audit, finished_at: '2026-07-27T09:00:01Z',
    body: () => succeeded({ draft_key: 'd-9' }, { events: [ev], audit: [{ step: 'route', ok: true, detail: null }] }),
  });
  equal(ok.final_state, 'completed', 'a verified, persisted success completes');
  equal(ok.outcome.meta.run_id, 'run-4', 'run metadata is stamped onto the envelope');
  equal(ok.outcome.meta.workflow_id, 'outbound_draft', 'workflow id is stamped onto the envelope');
  equal(ok.artifact.ok, true, 'the artifact was written');
  equal(ok.audit_result.written, 1, 'the audit event was emitted');
  equal(artifacts.list(), ['outbound_draft/2026-07-27/run-4.json'], 'the artifact landed on the predictable path');
  assertReport(ok.report);
  equal(ok.report.final_state, 'completed', 'the stored report agrees with the returned final state');

  // A refusal is a normal outcome and still produces a durable record.
  const refused = await runWorkflow({
    context: ctx, artifacts: memoryArtifactSink(),
    body: () => blocked('no_policy', { reasons: platformReasons }),
  });
  equal(refused.final_state, 'blocked', 'a refusal terminates as blocked, not failed');
  equal(refused.report.blocked_reason, 'no_policy', 'the refusal reason is in the record');

  // runWorkflow NEVER throws — this is what makes it safe to run unattended.
  const thrown = await runWorkflow({
    context: ctx, body: () => { throw new KernelError('verify_failed', 'the write did not land'); },
  });
  equal(thrown.final_state, 'failed', 'a thrown workflow terminates as failed');
  equal(thrown.outcome.error.code, 'verify_failed', 'the thrown code is preserved');

  const plainThrown = await runWorkflow({ context: ctx, body: () => { throw new Error('boom'); } });
  equal(plainThrown.outcome.error.code, 'contract_violation', 'an unclassified throw fails closed');

  const wrongShape = await runWorkflow({ context: ctx, body: () => ({ ok: true, result: 'fine' }) });
  equal(wrongShape.final_state, 'failed', 'a workflow that returns the wrong shape fails');
  equal(wrongShape.outcome.error.code, 'contract_violation', 'wrong shape is a contract violation');

  const returnedNothing = await runWorkflow({ context: ctx, body: () => undefined });
  equal(returnedNothing.final_state, 'failed', 'a workflow that returns nothing fails');

  // A sink that cannot write downgrades the run, and never turns it into a crash.
  const brokenSink = createArtifactSink({ name: 'broken', write() { throw new Error('read-only file system'); } });
  const undurable = await runWorkflow({ context: ctx, artifacts: brokenSink, body: () => succeeded({ a: 1 }) });
  equal(undurable.final_state, 'incomplete', 'a run whose record did not land is incomplete');
  equal(undurable.outcome.status, 'ok', 'the workflow verdict itself is untouched by a sink failure');
  equal(undurable.artifact.ok, false, 'the sink failure is reported');
  check(undurable.artifact.error.includes('read-only'), 'the sink error is reported verbatim');
  equal(undurable.report.final_state, 'incomplete', 'the report states its own incompleteness');

  const refusingSink = createArtifactSink({ name: 'refuser', write: () => ({ ok: false, error: 'quota exceeded' }) });
  equal((await runWorkflow({ context: ctx, artifacts: refusingSink, body: () => succeeded(null) })).final_state, 'incomplete',
    'a sink that reports failure downgrades the run too');

  // Opting out of persistence is a decision, and it is honoured.
  equal((await runWorkflow({ context: ctx, artifacts: brokenSink, requireArtifact: false, body: () => succeeded(null) })).final_state,
    'completed', 'an explicitly optional artifact does not downgrade the run');

  // No sink at all: still a complete, standardized outcome.
  const sinkless = await runWorkflow({ context: ctx, body: () => succeeded({ a: 1 }) });
  equal(sinkless.final_state, 'completed', 'a run with no sinks still terminates explicitly');
  equal(sinkless.artifact, null, 'no sink means no artifact result, not a fake one');

  // Duplicate events are surfaced before anything durable sees them.
  const dupes = await runWorkflow({ context: ctx, body: () => succeeded(null, { events: [ev, ev] }) });
  equal(dupes.duplicates.length, 1, 'a repeated event is reported as a duplicate');

  // The only rejections are malformed CALLS — a wiring bug in the caller, not a
  // result of the run. Everything the workflow itself does comes back as an
  // envelope, which is what makes this safe to drive unattended.
  await assert.rejects(() => runWorkflow({ context: ctx }),
    (e) => isKernelError(e, 'invalid_input'), 'runWorkflow demands a body');
  check(true, 'runWorkflow demands a body');
  await assert.rejects(() => runWorkflow({ context: {}, body: () => succeeded(null) }),
    (e) => isKernelError(e, 'contract_violation'), 'runWorkflow demands a real context');
  check(true, 'runWorkflow demands a real context');
});

// --- 8. corpora -------------------------------------------------------------
group('labelled corpora', () => {
  const parity = corpusParity(['a.json', 'b.json'], ['a.json', 'c.json']);
  equal(parity.missingLabels, ['b.json'], 'unlabelled case reported');
  equal(parity.orphanLabels, ['c.json'], 'orphan label reported');

  const clean = buildCorpus({
    name: 'synthetic',
    labels: { 'a.json': { x: 1 } },
    entries: [{ name: 'a.json', data: { hello: 'world' } }],
  });
  check(clean.ok && clean.problems.length === 0, 'a consistent corpus is clean');
  equal(clean.get('a.json').label.x, 1, 'label attached to case');
  equal(clean.withLabelKey('x').length, 1, 'withLabelKey selects');
  equal(clean.withLabelKey('nope').length, 0, 'withLabelKey excludes');
  check(clean.assertClean(), 'assertClean passes on a clean corpus');
  run.throwsKernel(() => clean.get('missing.json'), 'invalid_input', 'unknown case refused');

  const dirty = buildCorpus({
    name: 'synthetic-dirty',
    labels: { 'a.json': {}, 'ghost.json': {} },
    entries: [{ name: 'a.json', data: {} }, { name: 'b.json', data: {} }, { name: 'c.json', parseError: 'c.json is not valid JSON: x' }],
  });
  check(!dirty.ok, 'an inconsistent corpus is not clean');
  equal(dirty.problems.map((p) => p.kind).sort(), ['missing_label', 'orphan_label', 'parse_error'], 'all three problem kinds reported');
  run.throwsKernel(() => dirty.assertClean(), 'corpus_parity', 'assertClean fails on a dirty corpus');

  // A corpus parity gate reports each problem as its own failure.
  const lines = [];
  const probe = createGateRun({ name: 'p', log: (l) => lines.push(l) });
  probe.corpusParity(dirty);
  assert.equal(probe.fail, 3, 'each corpus problem is one gate failure');
  check(true, 'corpusParity gate reports every problem');

  // The repo's real corpora must load clean through the kernel loader.
  const approvals = loadCorpus({ dir: join(ROOT, 'fixtures', 'approvals'), name: 'fixtures/approvals' });
  check(approvals.ok, `fixtures/approvals parity: ${approvals.problems.map((p) => p.message).join('; ')}`);
  check(approvals.cases.length >= 15, `fixtures/approvals has ${approvals.cases.length} cases`);

  const outbound = loadCorpus({
    dir: join(ROOT, 'fixtures', 'outbound'),
    casesDir: join(ROOT, 'fixtures', 'outbound', 'cases'),
    name: 'fixtures/outbound',
  });
  check(outbound.ok, `fixtures/outbound parity: ${outbound.problems.map((p) => p.message).join('; ')}`);
  check(outbound.cases.length >= 15, `fixtures/outbound has ${outbound.cases.length} cases`);
});

// --- 9. suite registry ------------------------------------------------------
group('suite registry + regression plan', () => {
  const ids = registry.ids();
  check(ids.length === new Set(ids).size, 'suite ids are unique');
  check(ids.length === SUITES.length, 'every descriptor is registered');
  for (const suite of registry.all()) {
    run.member(suite.kind, SUITE_KINDS, `suite ${suite.id} kind`);
    check(suite.name.length > 0, `suite ${suite.id} has a name`);
    // Every file a suite guards on, and every script it runs, must exist —
    // otherwise the plan silently skips a suite forever.
    for (const path of suite.skipIfMissing) {
      check(existsSync(join(ROOT, path)), `suite ${suite.id} guards on a missing file: ${path}`);
    }
    const scriptMatch = suite.command.match(/(?:bash|node)\s+(scripts\/[\w./-]+)/);
    if (scriptMatch) check(existsSync(join(ROOT, scriptMatch[1])), `suite ${suite.id} runs a missing script: ${scriptMatch[1]}`);
  }

  // A credential-free kind may never declare required env.
  for (const suite of registry.all()) {
    if (['unit', 'offline', 'static'].includes(suite.kind)) {
      equal(suite.requires.length, 0, `suite ${suite.id} claims kind '${suite.kind}' but wants credentials`);
    }
  }
  run.throwsKernel(() => defineSuite({ id: 'x', name: 'x', kind: 'offline', command: 'true', requires: ['TOKEN'] }),
    'invalid_input', 'an offline suite that needs a token is refused');
  run.throwsKernel(() => defineSuite({ id: 'Bad_Id', name: 'x', kind: 'unit', command: 'true' }), 'invalid_input', 'non-kebab id refused');
  run.throwsKernel(() => defineSuite({ id: 'x', name: 'x', kind: 'nope', command: 'true' }), 'invalid_input', 'unknown kind refused');
  run.throwsKernel(() => defineSuite({ id: 'x', name: 'x', kind: 'unit', command: 'a\tb' }), 'invalid_input', 'tab in a command refused (breaks the plan format)');
  run.throwsKernel(() => defineSuite({ id: 'x', name: 'x', kind: 'db', command: 'true', optInEnv: 'bad-name' }),
    'invalid_input', 'opt-in gate must name an uppercase environment variable');
  run.throwsKernel(() => createSuiteRegistry([
    { id: 'dup', name: 'a', kind: 'unit', command: 'true' },
    { id: 'dup', name: 'b', kind: 'unit', command: 'true' },
  ]), 'invalid_input', 'duplicate suite id refused');
  run.throwsKernel(() => registry.get('does-not-exist'), 'unregistered_suite', 'unknown suite id refused');

  // Plan mechanics.
  const fullPlan = registry.plan({
    exists: () => true,
    env: {
      SUPABASE_ACCESS_TOKEN: 'x',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'x',
      AWE_ORG_ID: 'org-1',
      AWE_RUN_LIVE_MCP: '1',
    },
  });
  equal(fullPlan.length, SUITES.length, 'every suite appears in the plan');
  check(fullPlan.every((p) => p.status === 'run'), 'nothing is skipped when files and env are present');
  equal(fullPlan.map((p) => p.id), registry.ids(), 'plan preserves declaration order');
  equal(fullPlan.filter((p) => p.cooldown_after_seconds > 0).map((p) => p.id), ['acceptance-slice4'],
    'the mgmt-API cooldown is declared exactly once, after slice 4');

  const missingPlan = registry.plan({ exists: (p) => !p.endsWith('acceptance-slice5.sh') });
  const slice5 = missingPlan.find((p) => p.id === 'acceptance-slice5');
  equal(slice5.status, 'skipped', 'a missing script is skipped, not failed');
  check(slice5.skip_reason.includes('missing file'), 'skip reason names the missing file');
  check(missingPlan.every((p) => p.id !== 'acceptance-slice5' ? true : p.status === 'skipped'), 'only that suite is skipped');

  const offlineOnly = registry.plan({ exists: () => true, kinds: ['offline', 'unit', 'static'] });
  check(offlineOnly.filter((p) => p.status === 'run').every((p) => ['offline', 'unit', 'static'].includes(p.kind)),
    'kind filter selects only credential-free suites');
  check(offlineOnly.some((p) => p.id === 'acceptance-slice1' && p.status === 'skipped'), 'db suites excluded by kind filter');

  const onlyOne = registry.plan({ exists: () => true, only: ['kernel-unit'] });
  equal(onlyOne.filter((p) => p.status === 'run').map((p) => p.id), ['kernel-unit'], '--only selects a single suite');

  // Env is reported even when it does not cause a skip (current behaviour: a
  // db suite with no token still runs and fails loudly).
  const noEnv = registry.plan({ exists: () => true, env: {} });
  const slice1 = noEnv.find((p) => p.id === 'acceptance-slice1');
  equal(slice1.status, 'run', 'a missing token does not silently skip a db suite');
  equal(slice1.missing_env, ['SUPABASE_ACCESS_TOKEN'], 'missing env is reported');
  const liveMcp = noEnv.find((p) => p.id === 'eval-mcp-live');
  equal(liveMcp.status, 'skipped', 'a LIVE proof is absent from the default regression path');
  equal(liveMcp.skip_reason, 'requires explicit opt-in: AWE_RUN_LIVE_MCP=1',
    'the LIVE proof names the exact opt-in needed');

  const optedInWithoutCredentials = registry.plan({
    exists: () => true,
    env: { AWE_RUN_LIVE_MCP: '1' },
  }).find((p) => p.id === 'eval-mcp-live');
  equal(optedInWithoutCredentials.status, 'skipped', 'opt-in alone cannot run a credentialed proof');
  check(optedInWithoutCredentials.skip_reason.includes('missing env'), 'missing LIVE credentials are reported after opt-in');

  run.deterministic(() => registry.plan({ exists: () => true }), 'plan is deterministic');
});

// --- 10. layering lint ------------------------------------------------------
// The kernel's guarantees are only guarantees if something checks them.
group('kernel layering lint', () => {
  const FORBIDDEN = [
    { name: 'network (fetch)', pattern: /\bfetch\s*\(/, message: 'the kernel must never reach the network' },
    { name: 'network (node:http)', pattern: /from\s+['"]node:(http|https|net|tls|dgram)['"]/, message: 'the kernel must never open a socket' },
    { name: 'clock (Date.now)', pattern: /Date\.now\s*\(/, message: 'a kernel that reads the clock cannot be deterministic' },
    { name: 'clock (new Date)', pattern: /new\s+Date\s*\(/, message: 'a kernel that reads the clock cannot be deterministic' },
    { name: 'randomness', pattern: /Math\.random\s*\(|randomUUID|randomBytes/, message: 'a kernel with randomness cannot be deterministic' },
    { name: 'process.env', pattern: /process\.env/, message: 'the kernel takes its inputs as arguments, never from ambient env' },
    { name: 'filesystem write', pattern: /(writeFile|appendFile|mkdir|rm|unlink|rename|copyFile)(Sync)?\s*\(/, message: 'the kernel never writes' },
    { name: 'child process', pattern: /child_process|execSync|spawnSync/, message: 'the kernel never executes anything' },
    { name: 'process exit', pattern: /process\.exit\s*\(/, message: 'exiting is the runner\'s decision, not the kernel\'s' },
    { name: 'external dependency', pattern: /^\s*import[^;]*from\s+['"](?!node:|\.\/|\.\.\/)/m, message: 'the kernel has zero runtime dependencies' },
  ];

  const files = readdirSync(KERNEL_SRC).filter((f) => f.endsWith('.mjs')).sort();
  check(files.length >= 10, `kernel exposes ${files.length} modules`);
  run.sourcePurity(files.map((f) => join(KERNEL_SRC, f)), FORBIDDEN, { label: 'kernel purity' });

  // Non-vacuity: the same rules must FIRE on a synthetic offender. A lint that
  // cannot fail is not a lint.
  const offender = stripComments(`
    import axios from 'axios';
    export const t = Date.now();
    export async function go() { await fetch('https://example.invalid'); }
    export const r = Math.random();
    export const e = process.env.SECRET;
    writeFileSync('/tmp/x', 'y');
    process.exit(1);
  `);
  const fired = FORBIDDEN.filter((rule) => rule.pattern.test(offender)).map((r) => r.name);
  equal(fired.sort(), [
    'clock (Date.now)', 'external dependency', 'filesystem write', 'network (fetch)',
    'process exit', 'process.env', 'randomness',
  ], 'every applicable lint rule fires on a synthetic offender');

  // Comment stripping must not blind the lint to real code on the same line.
  check(!/\bfetch\s*\(/.test(stripComments('// no fetch( here, only prose')), 'prose in a comment does not trip the lint');
  check(/\bfetch\s*\(/.test(stripComments('await fetch(url); // network')), 'real code beside a comment still trips the lint');
  check(stripComments('const url = "https://x/y//z";').includes('//z'), 'a URL inside a string is not treated as a comment');

  // The package must declare no dependencies at all.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'awe-kernel', 'package.json'), 'utf8'));
  check(!pkg.dependencies && !pkg.peerDependencies, 'awe-kernel declares zero runtime dependencies');
  equal(pkg.type, 'module', 'awe-kernel is ESM');
});

// --- 11. B2 write-back spec (offline equivalence proof) ---------------------
// `db.verify()` used to hand-code its five booleans; it now declares them as a
// kernel spec. This section proves the declared spec produces byte-identical
// verdicts to the hand-written logic across the whole truth table — without a
// database, using recorded probe values.
await groupAsync('B2 classification write-back spec (recorded probes, no DB)', async () => {
  const ORG = '2b219aa5-1148-4e3e-a1a0-1725d62b935c';
  const expected = { classification: 'emergency', status: 'escalated', event: 'request.emergency_escalated' };

  // The exact logic db.verify() contained before the spec replaced it.
  const legacy = (row, evN, dupN) => ({
    row_updated: !!row,
    values_match: !!row && row.classification === expected.classification && row.status === expected.status,
    org_scoped: !!row && row.org_id === ORG,
    event_present: evN >= 1,
    no_duplicate_side_effect: dupN === 1,
  });

  const rows = [
    null,
    { id: 'wr-1', org_id: ORG, classification: 'emergency', status: 'escalated', urgency: 'emergency' },
    { id: 'wr-1', org_id: ORG, classification: 'service_call', status: 'escalated', urgency: 'standard' },
    { id: 'wr-1', org_id: ORG, classification: 'emergency', status: 'new', urgency: 'emergency' },
    { id: 'wr-1', org_id: 'other-org', classification: 'emergency', status: 'escalated', urgency: 'emergency' },
  ];

  let cases = 0;
  let mismatches = 0;
  for (const row of rows) {
    for (const evN of [0, 1, 3]) {
      for (const dupN of [0, 1, 2]) {
        const result = await runVerify(CLASSIFICATION_WRITE_BACK, {
          // Probe returns the management-API shapes verbatim: a row object or
          // null, and `[{ n }]` for the two counts.
          probe: (source) => ({ row, event_count: [{ n: evN }], work_request_count: [{ n: dupN }] })[source],
          context: { classification: expected.classification, status: expected.status, org: ORG },
        });
        cases += 1;
        if (canonicalJson(result.checks) !== canonicalJson(legacy(row, evN, dupN))) {
          mismatches += 1;
          check(false, `write-back spec differs from the legacy logic for row=${JSON.stringify(row)} ev=${evN} dup=${dupN}: `
            + `${canonicalJson(result.checks)} vs ${canonicalJson(legacy(row, evN, dupN))}`);
        }
      }
    }
  }
  equal(cases, 45, 'the whole truth table was exercised');
  equal(mismatches, 0, 'declared spec matches the legacy hand-written verdicts');

  // The check ids Runner 2A reads by name must never drift.
  equal(CLASSIFICATION_WRITE_BACK.checks.map((c) => c.id),
    ['row_updated', 'values_match', 'org_scoped', 'event_present', 'no_duplicate_side_effect'],
    'write-back check ids are stable (Runner 2A reads them by name)');

  // A dead database is a failed step, not a passed one.
  const dead = await runVerify(CLASSIFICATION_WRITE_BACK, {
    probe: () => { throw new Error('SUPABASE_ACCESS_TOKEN is not set'); },
    context: { classification: 'emergency', status: 'escalated', org: ORG },
  });
  check(!dead.ok, 'an unreachable database fails the Verify Step');
  check(Object.values(dead.checks).every((v) => v === false), 'no check passes when the probe is dead');
});

// --- summary ----------------------------------------------------------------
console.log('--- Runner K gates ---');
const report = run.summary({ fixtures: null });
if (report.fail > 0) console.log(`failures:\n  ${report.failures.join('\n  ')}`);
process.exit(run.exitCode);
