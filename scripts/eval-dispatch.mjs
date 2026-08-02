// ---------------------------------------------------------------------------
// eval-dispatch.mjs — Runner DP: dispatch lifecycle, handoff contract, verification.
//
// Pure and deterministic. The state machine, the handoff contract and the
// verifier are all pure functions, so every case here runs without a repository,
// a lock file or a clock.
//
// The cases that carry the weight are the refusals: a worker cannot reach
// VERIFIED by asserting it, a completion claim cannot be made without the
// evidence that would let someone falsify it, and a file list that disagrees
// with git is caught rather than believed.
//
// Usage: node scripts/eval-dispatch.mjs
// ---------------------------------------------------------------------------

import {
  STATES, TRANSITIONS, canTransition, transitionError, validateTask, newTask,
  applyTransition, dependencyErrors, TASK_SCHEMA_VERSION,
} from './lib/dispatch/state.mjs';
import {
  newHandoff, validateHandoff, handoffToMarkdown, HANDOFF_SCHEMA_VERSION, COMPLETION_ASSERTIONS,
} from './lib/dispatch/handoff.mjs';
import { verifyHandoff, VERIFICATION_CHECKS } from './lib/dispatch/verify.mjs';

let passed = 0; let failed = 0;
const check = (c, l) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}`); c ? passed++ : failed++; };
const section = (s) => console.log(`--- ${s} ---`);

const AT = '2026-08-02T01:00:00.000Z';

const task = (over = {}) => newTask({
  task_id: 'AWE-INT-101',
  objective: 'Analyze the migration identity collision',
  capability: 'migration-identity',
  priority: 'P0',
  requested_role: 'Integrator',
  required_branch: 'feat/x',
  allowed_scope: ['docs/planning/'],
  forbidden_actions: ['apply a migration'],
  required_tests: ['eval-context-compiler'],
  definition_of_done: ['document exists'],
  ...over,
});

const handoff = (over = {}) => newHandoff({
  task_id: 'AWE-INT-101',
  packet_id: 'AWE-INT-101',
  worker: 'session-a',
  starting_branch: 'feat/x',
  starting_commit: 'aaaaaaa',
  ending_branch: 'feat/x',
  ending_commit: 'bbbbbbb',
  files_created: ['docs/planning/X.md'],
  tests_run: ['eval-context-compiler'],
  results: ['Runner CC: PASS 116/0'],
  git_status: 'clean',
  side_effects_not_performed: ['no push', 'no migration applied'],
  blockers: [],
  completion_assertion: 'COMPLETE',
  ...over,
});

const obs = (over = {}) => ({
  currentBranch: 'feat/x',
  currentCommit: 'bbbbbbb',
  commitExists: () => true,
  filesInRange: () => ['docs/planning/X.md'],
  forbiddenTouched: [],
  evidenceExists: () => true,
  ...over,
});

// ===========================================================================
section('1. state machine shape');
{
  check(STATES.length === 9, 'nine states exist');
  check(STATES.includes('AWAITING_VERIFICATION'), 'AWAITING_VERIFICATION exists — the gap between claimed and proven');
  check(canTransition('DRAFT', 'READY'), 'DRAFT → READY is allowed');
  check(canTransition('AWAITING_VERIFICATION', 'VERIFIED'), 'AWAITING_VERIFICATION → VERIFIED is allowed');
  check(canTransition('AWAITING_VERIFICATION', 'REJECTED'), 'AWAITING_VERIFICATION → REJECTED is allowed');
  check(TRANSITIONS.SUPERSEDED.length === 0, 'SUPERSEDED is terminal');
}

section('2. a worker cannot assert its way to VERIFIED');
{
  for (const from of ['DRAFT', 'READY', 'CLAIMED', 'IN_PROGRESS', 'BLOCKED', 'REJECTED']) {
    check(!canTransition(from, 'VERIFIED'), `${from} → VERIFIED is refused`);
  }
  const msg = transitionError('IN_PROGRESS', 'VERIFIED');
  check(/earned by dispatch:verify/.test(msg), 'the refusal explains that verification is earned, not asserted');
  check(transitionError('AWAITING_VERIFICATION', 'VERIFIED') === null, 'the one legitimate path is open');
  let threw = false;
  try { applyTransition(task({ status: 'CLAIMED' }), 'VERIFIED', { at: AT }); } catch { threw = true; }
  check(threw, 'applyTransition throws on a forbidden transition');
  threw = false;
  try { applyTransition(task({ status: 'DRAFT' }), 'READY', {}); } catch { threw = true; }
  check(threw, 'applyTransition requires an explicit timestamp');
}

section('3. task validation');
{
  check(validateTask(task()).length === 0, 'a complete task validates');
  check(validateTask(task({ task_id: 'nope' })).some((e) => /AWE-INT-101/.test(e)), 'a malformed task id is refused');
  check(validateTask(task({ status: 'MOSTLY_DONE' })).some((e) => /invalid status/.test(e)), 'an invented status is refused');
  check(validateTask(task({ priority: 'P9' })).some((e) => /invalid priority/.test(e)), 'an invalid priority is refused');
  check(validateTask(task({ requested_role: 'Wizard' })).some((e) => /invalid role/.test(e)), 'an invented role is refused');
  check(validateTask(task({ forbidden_actions: [] })).some((e) => /not bounded/.test(e)),
    'a task with no prohibitions is refused as unbounded');
  check(validateTask(task({ objective: '' })).some((e) => /objective/.test(e)), 'an empty objective is refused');
  check(newTask().schema_version === TASK_SCHEMA_VERSION, 'a new task carries the schema version');
}

section('4. dependency enforcement');
{
  const byId = { 'AWE-INT-100': task({ task_id: 'AWE-INT-100', status: 'VERIFIED' }) };
  check(dependencyErrors(task({ depends_on: ['AWE-INT-100'] }), byId).length === 0,
    'a VERIFIED dependency satisfies');
  byId['AWE-INT-100'].status = 'AWAITING_VERIFICATION';
  check(dependencyErrors(task({ depends_on: ['AWE-INT-100'] }), byId).length === 1,
    'a merely-finished dependency does NOT satisfy — inheriting an unverified result is how a mistake propagates');
  check(dependencyErrors(task({ depends_on: ['AWE-INT-999'] }), {}).some((e) => /does not exist/.test(e)),
    'a dependency on a nonexistent task is reported');
  check(dependencyErrors(task(), {}).length === 0, 'no dependencies means no errors');
}

section('5. handoff contract');
{
  check(newHandoff().schema_version === HANDOFF_SCHEMA_VERSION, 'a new handoff carries the schema version');
  check(COMPLETION_ASSERTIONS.includes('NO_CODE_CHANGE'), 'an analysis-only result has an honest assertion available');
  check(validateHandoff(handoff(), { requiredTests: ['eval-context-compiler'] }).length === 0,
    'a complete handoff validates');
  check(validateHandoff(handoff({ task_id: null })).some((e) => /task_id/.test(e)), 'a handoff with no task id is refused');
  check(validateHandoff(handoff({ packet_id: null })).some((e) => /packet_id/.test(e)),
    'a handoff not tied to a packet is refused');
  check(validateHandoff(handoff({ completion_assertion: 'DONE_I_PROMISE' })).some((e) => /completion_assertion/.test(e)),
    'an invented completion assertion is refused');
}

section('6. a completion claim must be falsifiable');
{
  const req = { requiredTests: ['eval-context-compiler'] };
  check(validateHandoff(handoff({ starting_commit: null, ending_commit: null }), req)
    .some((e) => /starting_commit/.test(e)), 'COMPLETE without a commit range is refused');
  check(validateHandoff(handoff({ tests_run: [] }), req).some((e) => /records none/.test(e)),
    'COMPLETE without running the required tests is refused');
  check(validateHandoff(handoff({ results: [] }), req).some((e) => /proves nothing/.test(e)),
    'a test name with no recorded outcome is refused');
  check(validateHandoff(handoff({ git_status: null }), req).some((e) => /git status/.test(e)),
    'COMPLETE without a git status is refused');
  check(validateHandoff(handoff({ side_effects_not_performed: [] }), req).some((e) => /silence is not a declaration/.test(e)),
    'COMPLETE without a side-effect declaration is refused');
  check(validateHandoff(handoff({ completion_assertion: 'BLOCKED', tests_run: [], results: [], git_status: null }), req).length === 0,
    'a BLOCKED handoff is not held to the completion bar — it is not claiming completion');
  const md = handoffToMarkdown(handoff());
  check(md.includes('Side effects explicitly NOT performed'), 'the markdown renders the negative declaration');
  check(md.includes('AWE-INT-101'), 'the markdown names the task');
}

section('7. verification against the repository');
{
  const t = task({ status: 'AWAITING_VERIFICATION' });
  const v = verifyHandoff(t, handoff(), obs());
  check(v.passed && v.verdict === 'VERIFIED', 'a truthful handoff verifies');
  check(v.checks.length === VERIFICATION_CHECKS.length, `all ${VERIFICATION_CHECKS.length} checks run`);

  check(verifyHandoff(task({ status: 'CLAIMED' }), handoff(), obs()).verdict === 'REJECTED',
    'a task not awaiting verification cannot be verified');
  check(verifyHandoff(t, handoff(), obs({ commitExists: () => false })).failed_checks.includes('commit_range_exists'),
    'a claimed commit that does not exist is caught');
  check(verifyHandoff(t, handoff({ ending_branch: 'main' }), obs()).failed_checks.includes('branch_matches'),
    'ending on the wrong branch is caught');
  check(verifyHandoff(t, handoff(), obs({ filesInRange: () => ['docs/planning/X.md', 'packages/awe-kernel/src/index.mjs'] }))
    .failed_checks.includes('files_match_git'),
    'a file changed in git but not claimed in the handoff is caught');
  check(verifyHandoff(t, handoff({ files_created: ['docs/planning/X.md', 'docs/planning/GHOST.md'] }), obs())
    .failed_checks.includes('files_match_git'),
    'a file claimed but not actually changed is caught');
  check(verifyHandoff(t, handoff({ tests_run: [] }), obs()).failed_checks.includes('required_tests_run'),
    'skipping a required test is caught');
  check(verifyHandoff(t, handoff({ results: ['Runner CC: FAIL 3 failed'] }), obs()).failed_checks.includes('test_results_pass'),
    'a handoff that records its own failure is rejected');
  check(verifyHandoff(t, handoff(), obs({ forbiddenTouched: ['supabase/migrations/0016_a.sql'] }))
    .failed_checks.includes('forbidden_scope_untouched'),
    'touching a path outside the allowed scope is caught');
  check(verifyHandoff(task({ status: 'AWAITING_VERIFICATION', required_evidence: ['.awe/x.json'] }), handoff(),
    obs({ evidenceExists: () => false })).failed_checks.includes('evidence_present'),
    'missing required evidence is caught');
  check(verifyHandoff(t, handoff({ side_effects_not_performed: [] }), obs()).failed_checks.includes('side_effects_declared'),
    'a missing side-effect declaration is caught at verification too');
}

section('8. analysis-only work verifies honestly');
{
  const t = task({ status: 'AWAITING_VERIFICATION', required_tests: [] });
  const h = handoff({
    completion_assertion: 'NO_CODE_CHANGE',
    files_created: [], files_modified: [], files_deleted: [],
    starting_commit: null, ending_commit: null, tests_run: [], results: [],
  });
  const v = verifyHandoff(t, h, obs({ filesInRange: () => [] }));
  check(v.passed, 'a NO_CODE_CHANGE handoff with no files verifies');
  const lying = verifyHandoff(t, { ...h, files_modified: ['a.js'] }, obs({ filesInRange: () => [] }));
  check(lying.failed_checks.includes('files_match_git'),
    'a NO_CODE_CHANGE handoff that lists changed files contradicts itself and is caught');
}

section('9. history is recorded on every transition');
{
  let t = task({ status: 'DRAFT' });
  t = applyTransition(t, 'READY', { at: AT, by: 'prepare' });
  t = applyTransition(t, 'CLAIMED', { at: AT, by: 'session-a' });
  t = applyTransition(t, 'AWAITING_VERIFICATION', { at: AT, by: 'session-a' });
  t = applyTransition(t, 'VERIFIED', { at: AT, by: 'verify' });
  check(t.status === 'VERIFIED', 'the full happy path reaches VERIFIED');
  check(t.history.length === 4, 'every transition is recorded');
  check(t.history[0].from === 'DRAFT' && t.history[3].to === 'VERIFIED', 'history preserves the sequence');
  check(t.history.every((h) => h.at === AT), 'every history entry carries its timestamp');
}

section('Runner DP gates');
{
  // Non-vacuity: the verifier must be able to fail, and the state machine to refuse.
  const t = task({ status: 'AWAITING_VERIFICATION' });
  const allBad = verifyHandoff(t, handoff({ ending_branch: 'wrong', tests_run: [], side_effects_not_performed: [] }),
    obs({ commitExists: () => false, filesInRange: () => ['x'], forbiddenTouched: ['y'] }));
  check(allBad.failed_checks.length >= 5, `a thoroughly wrong handoff fails many checks (${allBad.failed_checks.length})`);
  check(!allBad.passed && allBad.verdict === 'REJECTED', 'and is rejected');
  const forbidden = STATES.flatMap((f) => STATES.filter((to) => !canTransition(f, to)).map((to) => [f, to]));
  check(forbidden.length > 40, `most state pairs are forbidden (${forbidden.length}) — the machine is restrictive, not permissive`);
}

console.log(`\neval-dispatch (Runner DP, pure, deterministic): passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'Runner DP: PASS' : 'Runner DP: FAIL');
process.exit(failed === 0 ? 0 : 1);
