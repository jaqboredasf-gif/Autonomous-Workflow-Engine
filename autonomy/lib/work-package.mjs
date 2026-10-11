// ---------------------------------------------------------------------------
// work-package.mjs — one bounded, checkable unit of machine work.
//
// A package is generated only for a MACHINE_EXECUTABLE finding, and only from
// a template written here in advance. There is no "improve architecture"
// package because there is no template for one. Acceptance criteria are
// commands with expected outcomes, never adjectives.
//
// The forbidden list is the guard's: L3 paths plus every open blocker's paths,
// so a package cannot authorize what the guard would refuse.
//
// A package is PREPARED. Whether it is DISPATCHED is decide()'s answer, and
// the dispatch is recorded by the cycle (cycle.mjs), never by the package.
//
// Pure.
// ---------------------------------------------------------------------------

import { closedPaths } from './guard.mjs';

const TEMPLATES = {
  'production-evidence-intake': (finding) => ({
    objective: 'Give production records a defined, repeatable route into the evidence layer: a read-only intake command for a verified backup copied off RDS02, and the procedure for bringing the copy back.',
    implementation_plan: [
      'scripts/awe-production-intake.mjs --from <copied backup>: open READ-ONLY; refuse a path inside the repository; run the same integrity check as pcc-backup --check; refuse unless schema_meta environment is "production" and the org id is the one declared; print what it is (counts, date range, release)',
      'then run, against that file: npm run plan -- --db <file> --org lippolis --json, and proof-case-study --db; write their outputs to .awe/production/ (gitignored), never the database',
      'docs/proof/PRODUCTION_EVIDENCE_RETURN.md: who copies the nightly backup off RDS02, on what medium, where it may live, that it never enters git, and the command to run',
      'scripts/eval-autonomy.mjs: tests with a rehearsal-stamped and an unstamped database (both refused), a production-stamped fixture (accepted), and a path inside the repo (refused)',
    ],
    allowed_files: ['scripts/awe-production-intake.mjs', 'docs/proof/PRODUCTION_EVIDENCE_RETURN.md', 'scripts/eval-autonomy.mjs', 'package.json', '.gitignore'],
    // How an allowed file may change. Existing tests may only gain lines (anywhere);
    // package.json may only gain scripts. A Builder that needs more than this
    // has hit a stopping condition, not a judgement call.
    file_rules: {
      'scripts/eval-autonomy.mjs': 'no-removals',
      '.gitignore': 'no-removals',
      'package.json': 'add-scripts-only',
    },
    // The contract the evaluator's probes hold the build to. The Builder is
    // told this; the probes themselves are not on its branch and not its to edit.
    interface: [
      'node scripts/awe-production-intake.mjs --from <file> --org <id> [--label <name>] [--from-date YYYY-MM-DD --to-date YYYY-MM-DD]',
      'exit 0 only when the copy is accepted and analysed; any refusal exits non-zero and names the reason on stderr (the words "repository", "rehearsal", "unstamped", "organization" or "integrity", as applicable)',
      'on success writes .awe/production/<label>/intake.json: { schema: "awe.production-intake/1", source: { sha256, bytes }, environment, org, counts: { requests, purchase_orders }, analyses: [{ name, exit_code, output }] } and nothing outside .awe/production/',
      'the source file is byte-identical afterwards and gains no -wal/-shm/-journal sidecar',
    ],
    probes: 'autonomy/probes/production-evidence-intake.mjs',
    acceptance_criteria: [
      { id: 'scope', command: 'evaluator: git diff --name-status <base.commit>..<head>', expect: 'every changed path is in allowed_files and obeys file_rules' },
      { id: 'guard', command: 'evaluator: checkChange(diff paths, autonomy/<cycle>)', expect: 'no violation' },
      { id: 'tests-not-weakened', command: 'evaluator: diff of every test file', expect: 'no test file deleted, no line removed from an existing test, no skip/only added' },
      { id: 'selftest', command: 'node scripts/eval-autonomy.mjs', expect: 'exit 0, including new intake checks' },
      { id: 'probes', command: 'evaluator: autonomy/probes/production-evidence-intake.mjs', expect: 'every probe passes: production accepted; rehearsal, unstamped, wrong org, corrupt and in-repository copies refused; source unchanged; nothing written outside .awe/production/; the engine\'s own capability probe reports the gap closed' },
      { id: 'ci', command: 'GitHub Actions "AWE verify" on the pushed autonomy/<cycle> head', expect: 'verify concluded success for that exact commit' },
    ],
    tests: ['scripts/eval-autonomy.mjs (new intake section)', 'full ci profile'],
    rollback: 'Revert the PR. The command is new and read-only; nothing else depends on it, and no data is written anywhere but .awe/.',
    risk: 'LOW. Read-only. The one real risk is a production database copied into the repository; the command refuses repo paths and .gitignore covers .awe/.',
  }),
};

/**
 * `base` is the commit the Builder's branch is cut from and every diff is
 * measured against. It is a commit, never a branch name: in M3 the package
 * diffed against origin/pcc-production while the engine's own prerequisites
 * were unmerged, so the scope check would have failed on work nobody did.
 */
export function generateWorkPackage(finding, { policy, blockers, now, base = null }) {
  const tpl = TEMPLATES[finding.action.package];
  if (!tpl) return { status: 'NO_TEMPLATE', finding: finding.id, why: 'no bounded template exists for this action; a person must scope it' };
  const t = tpl(finding);
  return {
    schema: 'awe.work-package/1',
    id: `wp-${finding.id}`,
    status: 'PREPARED_NOT_DISPATCHED',
    prepared_at: now,
    finding: finding.id,
    objective: t.objective,
    evidence: finding.evidence,
    why_now: `highest-scoring MACHINE_EXECUTABLE finding (score ${finding.priority.score}); ${finding.factors.urgency[1]}`,
    north_star: { claims: finding.claims, relationship: finding.priority.breakdown.north_star[1] },
    base,
    affected_files: t.allowed_files,
    allowed_files: t.allowed_files,
    file_rules: t.file_rules ?? {},
    interface: t.interface ?? [],
    probes: t.probes ?? null,
    forbidden_files: closedPaths(policy, blockers),
    implementation_plan: t.implementation_plan,
    acceptance_criteria: t.acceptance_criteria,
    tests: t.tests,
    rollback: t.rollback,
    risk: t.risk,
    max_attempts: policy.limits.builder_attempts,
    budget_minutes: policy.limits.autonomous_minutes,
    stopping_conditions: [
      'any changed path outside allowed_files',
      'awe-guard reports a violation',
      'a blocking suite fails on the PR head after the second attempt',
      'a test is deleted, skipped, or an assertion weakened',
      `the ${policy.limits.autonomous_minutes}-minute budget is spent`,
      'the acceptance criteria would need to change',
    ],
  };
}
