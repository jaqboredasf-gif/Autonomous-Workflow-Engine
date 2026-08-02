// ---------------------------------------------------------------------------
// verify.mjs — check a handoff against the repository.
//
// This is the module that makes VERIFIED mean something. It takes a worker's
// account and an observation of the actual repository, and reports every place
// they disagree.
//
// It is written as a pure function over an OBSERVATION object so it can be
// tested exhaustively without a git repository: `{ commitExists, filesInRange,
// currentBranch, currentCommit, testResults, forbiddenTouched }`. The CLI
// gathers that observation; this decides what it means.
//
// PURE: no I/O.
// ---------------------------------------------------------------------------

export const VERIFICATION_CHECKS = [
  'task_state',
  'commit_range_exists',
  'branch_matches',
  'files_match_git',
  'required_tests_run',
  'test_results_pass',
  'forbidden_scope_untouched',
  'evidence_present',
  'side_effects_declared',
];

function result(check, ok, message, detail = null) {
  return { check, ok, message, detail };
}

/**
 * @param task     the dispatch task
 * @param handoff  the submitted handoff
 * @param obs      observation of the repository:
 *   { currentBranch, currentCommit, commitExists(sha)->bool,
 *     filesInRange(from,to)->string[], forbiddenTouched: string[],
 *     evidenceExists(path)->bool }
 */
export function verifyHandoff(task, handoff, obs) {
  const checks = [];

  checks.push(result('task_state', task.status === 'AWAITING_VERIFICATION',
    task.status === 'AWAITING_VERIFICATION'
      ? 'task is awaiting verification'
      : `task is ${task.status}; only AWAITING_VERIFICATION can be verified`));

  // --- commit range --------------------------------------------------------
  const noCode = handoff.completion_assertion === 'NO_CODE_CHANGE';
  if (noCode) {
    checks.push(result('commit_range_exists', true, 'handoff asserts NO_CODE_CHANGE; no commit range required'));
  } else {
    const startOk = handoff.starting_commit ? obs.commitExists(handoff.starting_commit) : false;
    const endOk = handoff.ending_commit ? obs.commitExists(handoff.ending_commit) : false;
    checks.push(result('commit_range_exists', startOk && endOk,
      startOk && endOk
        ? `commit range ${String(handoff.starting_commit).slice(0, 7)}..${String(handoff.ending_commit).slice(0, 7)} exists`
        : `claimed commits do not both exist (start=${startOk}, end=${endOk})`,
      { starting_commit: handoff.starting_commit, ending_commit: handoff.ending_commit }));
  }

  // --- branch --------------------------------------------------------------
  const wantBranch = task.required_branch;
  const branchOk = !wantBranch || handoff.ending_branch === wantBranch;
  checks.push(result('branch_matches', branchOk,
    branchOk ? `ended on the required branch (${wantBranch || 'unconstrained'})`
      : `task requires branch "${wantBranch}" but the handoff ended on "${handoff.ending_branch}"`));

  // --- files ---------------------------------------------------------------
  if (noCode) {
    const claimed = [...(handoff.files_created || []), ...(handoff.files_modified || []), ...(handoff.files_deleted || [])];
    checks.push(result('files_match_git', claimed.length === 0,
      claimed.length === 0 ? 'NO_CODE_CHANGE and no files claimed — consistent'
        : `handoff asserts NO_CODE_CHANGE but lists ${claimed.length} changed file(s)`));
  } else {
    const actual = new Set(obs.filesInRange(handoff.starting_commit, handoff.ending_commit) || []);
    const claimed = [...(handoff.files_created || []), ...(handoff.files_modified || []), ...(handoff.files_deleted || [])];
    const unclaimed = [...actual].filter((f) => !claimed.includes(f));
    const overclaimed = claimed.filter((f) => !actual.has(f));
    const ok = unclaimed.length === 0 && overclaimed.length === 0;
    checks.push(result('files_match_git', ok,
      ok ? `all ${claimed.length} claimed file(s) match the commit range`
        : `file list disagrees with git: ${unclaimed.length} changed but unclaimed, ${overclaimed.length} claimed but unchanged`,
      { unclaimed, overclaimed }));
  }

  // --- tests ---------------------------------------------------------------
  const required = task.required_tests || [];
  const ran = handoff.tests_run || [];
  const missing = required.filter((t) => !ran.some((r) => String(r).includes(t) || t.includes(String(r))));
  checks.push(result('required_tests_run', missing.length === 0,
    missing.length === 0 ? `all ${required.length} required test(s) were run`
      : `required test(s) not run: ${missing.join(', ')}`,
    { required, ran, missing }));

  const failures = (handoff.results || []).filter((r) => /fail|error/i.test(String(r)) && !/0 fail|failed=0/i.test(String(r)));
  checks.push(result('test_results_pass', failures.length === 0,
    failures.length === 0 ? 'no failing result recorded'
      : `the handoff itself records ${failures.length} failing result(s)`,
    { failures }));

  // --- forbidden scope -----------------------------------------------------
  const touched = obs.forbiddenTouched || [];
  checks.push(result('forbidden_scope_untouched', touched.length === 0,
    touched.length === 0 ? 'no forbidden path was touched'
      : `forbidden path(s) modified: ${touched.join(', ')}`,
    { touched }));

  // --- evidence ------------------------------------------------------------
  const wantEvidence = task.required_evidence || [];
  const missingEvidence = wantEvidence.filter((p) => !obs.evidenceExists(p));
  checks.push(result('evidence_present', missingEvidence.length === 0,
    missingEvidence.length === 0 ? `all ${wantEvidence.length} required evidence artifact(s) exist`
      : `missing evidence: ${missingEvidence.join(', ')}`,
    { missing: missingEvidence }));

  // --- side effects --------------------------------------------------------
  const declared = Array.isArray(handoff.side_effects_not_performed) && handoff.side_effects_not_performed.length > 0;
  checks.push(result('side_effects_declared', declared,
    declared ? 'the handoff declares which side effects were not performed'
      : 'the handoff makes no side-effect declaration'));

  const failed = checks.filter((c) => !c.ok);
  return {
    checks,
    passed: failed.length === 0,
    failed_checks: failed.map((c) => c.check),
    verdict: failed.length === 0 ? 'VERIFIED' : 'REJECTED',
  };
}
