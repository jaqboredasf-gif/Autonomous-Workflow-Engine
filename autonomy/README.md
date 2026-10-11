# autonomy/ — the verification foundation (Milestone 2A)

The repository proves what ran and what happened, so that "Claude says the tests passed" stops
being a source of truth. Design: `docs/autonomy/ARCHITECTURE.md`. Audit: `docs/autonomy/CURRENT_STATE.md`.

```bash
npm ci
npm run verify                 # registered suites, profile "ci" → .awe/verify.json (+ .awe/logs/)
npm run engineering-state      # → .awe/engineering-state.json: is autonomous work safe, and why
npm run guard -- --base origin/pcc-production   # would an autonomous change touch a closed path?
npm run test:autonomy          # the layer's own adversarial tests

# Milestone 2B — deployment confidence
node scripts/awe-verify.mjs --profile deploy --out .awe-deploy   # needs Docker + node:24-bookworm-slim
npm run readiness -- --verify .awe-deploy/verify.json            # → .awe-deploy/deployment-readiness.json
npm run attest -- --list                                         # human facts and their state
npm run attest                                                   # a PERSON records one (refuses agents and CI)
```

**While nobody has attested `baseline_captured_before_first_transaction`, `npm run plan`,
`npm run engineering-state` and `npm run readiness` print:
BASELINE REQUIRED BEFORE FIRST REAL PCC TRANSACTION.** Nothing but a person can clear it.

There is no Builder, no scheduler and no model call here. This layer only observes.

## Files

| File | What it is | Who may change it |
|---|---|---|
| `suites.json` | Every verification entrypoint in the repo, classified by running it | **L3 (Jack).** Editing it changes what "green" means |
| `blockers.json` | Known problems autonomy must never repair (S1, MIGRATION-0016, GOV-1) | **L3.** Only a human edit lifts a blocker |
| `policy.json` | Limits and the standing L3 path list | **L3** |
| `human-facts.json` | Facts only a person can establish, and which (few) have a machine check | **L3** |
| `attestations.jsonl` | Append-only human attestations; written only by `npm run attest` | **L3. Never written by an agent** |
| `deployment-readiness.json` | The seven deployment questions, their evidence suites, what each does not prove | **L3** |
| `lib/attestations.mjs` | Fact states (UNKNOWN / HUMAN_VERIFIED / HUMAN_REFUTED / MACHINE_VERIFIED) and the baseline gate (pure) | |
| `lib/readiness.mjs` | Deployment readiness derivation (pure). Never says production ready | |
| `lib/verify.mjs` | Registry validation, preflight, classification, the runner | |
| `lib/state.mjs` | The engineering-state derivation (pure) | |
| `lib/guard.mjs` | Closed-path and closed-ref checks (pure) | |
| `lib/detectors.mjs` | Read-only observations of each blocker | |

## Verdicts

| Status | Meaning | Decided by |
|---|---|---|
| `PASS` | Ran, exited 0 | exit code |
| `FAIL` | Ran and did not pass: non-zero exit, signal, timeout or crash | exit code / signal / timer |
| `BLOCKED` | Could not be run meaningfully here | a **declared** requirement checked *before* running, a prerequisite (`purchasing-build`) that did not pass, or the suite's own **declared** `env_exit_codes` (repo convention: 2) |
| `SKIPPED` | Not selected by this profile or `--only` | always listed with the reason |

**BLOCKED never comes from reading a log.** If every declared requirement is met and the suite still
crashes with "Cannot find module", that is a FAIL. A log heuristic would also soften a genuinely
broken import.

Run verdict: `FAIL` (exit 1) if any blocking suite failed or the registry is invalid; else `BLOCKED`
(exit 3) if any blocking suite was blocked; else `PASS` (exit 0). Non-blocking failures are reported
in full and listed as `known_debt` in the engineering state; they do not change the verdict.

## Registry fields

`id`, `name`, `entry` (file that must exist), `command` (argv, run from the repo root), `category`,
`area`, `requires` (`deps`, `nonroot`, `docker-daemon`, `tool:<x>`, `env:<VAR>`), `offline`,
`requires_build`, `timeout_s`, `criticality`, `blocking`, `authority`
(`authoritative` | `advisory` | `measurement`), `profiles` (`ci`, `local`, `docker`, `manual`,
`live-human-only`), and optionally `env_exit_codes`, `components`, `artifacts`, `note`,
`ci_excluded_because`, `live_writes`.

The registry validates itself. A blocking suite must be in `ci`, a suite outside `ci` must say why,
and a suite that writes to a hosted system may only be `live-human-only`. `eval-autonomy` fails if any
`scripts/eval-*`, `scripts/acceptance-*` or `supabase/tests/*.sql` file is neither a suite nor a
named component, so a new suite cannot be silently left out.

## Engineering state verdicts

`NOT_SAFE`: no verification; verification of a different commit, a dirty tree, a partial run or
a non-CI profile; an invalid registry; or a blocking suite that FAILED or was BLOCKED.
`PROCEED_WITH_RESTRICTIONS`: green, but open blockers close paths, which are listed.
`SAFE_TO_PROCEED`: green, and nothing closed beyond standing L3. None of these authorizes an L3 act.

## Blockers

A blocker's `forbidden_paths` and `forbidden_refs` are closed to every autonomous change while its
status is anything other than `RESOLVED`. Detectors may report that a blocker *looks* resolved; that
changes nothing. Discovering a problem is not permission to repair it.

## Deployment readiness (Milestone 2B)

The Lippolis target is **Windows Server** (LIPELE-RDS02). The `deploy` profile proves the
platform-neutral half: the packaged application, a clean-environment install, installing twice,
startup, persistence, backup, restore, and restored state matching expected state. It runs on Linux
containers. Every question in `deployment-readiness.json` states what it does **not** prove, and
names the human fact that closes the gap on the real server.

Two verdicts, never "production ready":

- **install**: `NOT_READY` · `MACHINE_EVIDENCE_INCOMPLETE` · `READY_FOR_SUPERVISED_FIRST_INSTALL`.
  It also requires that the application code verified is identical to the signed release in
  `deployment/APPROVED_RELEASE.md`.
- **first_transaction**: `NOT_CLEARED` until every fact required before the first real transaction
  is attested, the baseline first.

The CI job `deploy evidence (non-blocking)` runs this on every PR into `pcc-production`. It cannot
fail the workflow until it has a record of being reliable.

## The improvement engine (Milestone 3, step 1: it thinks, it does not act)

```bash
npm run verify && node scripts/awe-verify.mjs --profile deploy --out .awe-deploy   # fresh evidence first
npm run inspect                                                                    # → .awe/inspection.json
```

OBSERVE (`lib/observe.mjs`, which reads plan, readiness, engineering state, blockers, attestations,
the gate and git) → FINDINGS (`lib/inspect.mjs`) → AUTHORITY (`lib/authority.mjs`) → PRIORITY and
DECISION (`lib/prioritize.mjs`) → WORK PACKAGE (`lib/work-package.mjs`). It changes nothing and
dispatches nothing. There is no Builder.

- **A finding exists only with evidence.** It is OBSERVED (a fact in the evidence) or HYPOTHESIZED
  (an observed gap with a guessed remedy, scored at most 0.5 confidence). Structural gaps come only
  from deterministic probes in `capabilities.json` (L3).
- **Score** = (5·north_star + 2·value + 2·unlock + 2·risk + 2·urgency) × confidence ÷ effort
  (LOW 1, MEDIUM 1.25, HIGH 1.5). North star is the plan's own gate order. A dependency inherits the
  score of what it blocks. Every finding prints its breakdown.
- **Authority** is decided before anything happens, with the same guard that enforces it later:
  MACHINE_EXECUTABLE · HUMAN_APPROVAL_REQUIRED · JACK_ACTION_REQUIRED · EXTERNAL_DEPENDENCY · BLOCKED.
- **The decision may be no.** It builds only if the best machine action is machine-executable,
  serves an unmeasured North Star claim, clears a score floor, the engineering state is not
  NOT_SAFE, and the open autonomy PR count is under the limit. Otherwise it prints why, and when the
  top finding is a person's: `DO NOT BUILD ANYTHING. JACK IS THE BOTTLENECK.`

## The closed loop (Milestone 4: one supervised cycle, end to end)

```bash
node scripts/awe-ci-evidence.mjs --commit <HEAD sha> --check-runs runs.json   # CI's verdict for HEAD
npm run cycle -- start          # observe → judge → STOP, or ONE package + worktree on autonomy/<cycle>
npm run cycle -- dispatch       # writes builder-brief-<n>.md: the Builder's only context
#   … a separate Builder session edits files in .awe/worktrees/<cycle> and nothing else …
npm run cycle -- collect --report builder-report.md   # commits iff every path is allowed
npm run cycle -- push           # fast-forward push of autonomy/<cycle>; CI runs on push
node scripts/awe-ci-evidence.mjs --commit <build head> --check-runs runs.json
npm run cycle -- evaluate --review review.json        # ACCEPT · REJECT · HUMAN_REVIEW
npm run cycle -- pr --url <draft PR> --number <n>     # only if not REJECT
npm run cycle -- finish         # Captain Brief + autonomy/cycles/<cycle>.json + ledger line
npm run cycle -- verify-ledger
```

- **Authoritative CI** (`lib/ci-evidence.mjs`). The engine reads the `verify` check's conclusion
  for the exact HEAD commit, imported with its run ids, URLs and a hash. When it is PASS, a local
  BLOCKED (the root container) is a note, not a failure; a local blocking FAIL on the same commit
  is a disagreement and still NOT_SAFE. A record for another commit is ABSENT, never borrowed.
- **The queue** counts unmerged autonomy branches other than the one being observed (M3 counted
  its own PR against itself).
- **The package** is measured from a base COMMIT, not `origin/pcc-production`, and carries file
  rules (`no-removals`, `add-scripts-only`), the interface the Builder must meet, and the path of
  the evaluator's probes, which are not on the Builder's branch and are hashed into the record.
- **The hands** (`lib/hands.mjs`) are the only code here that changes git: a worktree on a new
  `autonomy/*` branch from the base commit, a commit only if every changed path is allowed, a
  fast-forward push of that one branch. No force, merge, rebase, reset or branch deletion.
- **The evaluator** (`lib/evaluate.mjs`) judges from the diff against the base commit, the guard,
  test-weakening rules, the file rules, the Builder branch's self-test, the probes, CI for the
  pushed head, the budget, and a fresh-session review that saw only the package and the diff.
  Any FAIL is REJECT; anything it cannot establish is HUMAN_REVIEW; there is no override input.
- **The record** (`lib/cycle.mjs`) keeps finding, score, authority, package, build, verification,
  verdict, PR, expected impact, actual impact (UNKNOWN until measured) and human disposition
  (PENDING; derived later from whether the branch was merged). `autonomy/cycles/ledger.jsonl`
  chains each finished record by sha256, so an edit to history is detected.
- **Limits.** One cycle at a time; a cycle does not start from a Builder worktree; two attempts;
  45 minutes from first dispatch to collection; the PR-queue limit is the decision's, as in M3.
  Nothing in the loop merges, deploys, or touches production. Scheduling it is not built.
