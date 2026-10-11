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
// A package is PREPARED. Whether it is DISPATCHED is decide()'s answer, and in
// Milestone 3 step 1 nothing dispatches at all: there is no Builder.
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
    acceptance_criteria: [
      { command: 'node scripts/eval-autonomy.mjs', expect: 'exit 0, including the new intake checks' },
      { command: 'node scripts/awe-production-intake.mjs --from <rehearsal-stamped db>', expect: 'refuses, naming the stamp' },
      { command: 'node scripts/awe-production-intake.mjs --from <path inside the repo>', expect: 'refuses: a production copy may not live in the repository' },
      { command: 'npm run verify (CI, profile ci)', expect: 'verdict PASS on the PR head' },
      { command: 'node scripts/awe-guard.mjs --base origin/pcc-production', expect: 'clean' },
      { command: 'git diff --stat origin/pcc-production', expect: 'only allowed_files' },
    ],
    tests: ['scripts/eval-autonomy.mjs (new intake section)', 'full ci profile'],
    rollback: 'Revert the PR. The command is new and read-only; nothing else depends on it, and no data is written anywhere but .awe/.',
    risk: 'LOW. Read-only. The one real risk is a production database copied into the repository; the command refuses repo paths and .gitignore covers .awe/.',
  }),
};

export function generateWorkPackage(finding, { policy, blockers, now }) {
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
    affected_files: t.allowed_files,
    allowed_files: t.allowed_files,
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
