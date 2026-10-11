# autonomy/ — the verification foundation (Milestone 2A)

The repository proves what ran and what happened, so that "Claude says the tests passed" stops
being a source of truth. Design: `docs/autonomy/ARCHITECTURE.md`. Audit: `docs/autonomy/CURRENT_STATE.md`.

```bash
npm ci
npm run verify                 # registered suites, profile "ci" → .awe/verify.json (+ .awe/logs/)
npm run engineering-state      # → .awe/engineering-state.json: is autonomous work safe, and why
npm run guard -- --base origin/pcc-production   # would an autonomous change touch a closed path?
npm run test:autonomy          # the layer's own adversarial tests
```

There is no Builder, no scheduler and no model call here. This layer only observes.

## Files

| File | What it is | Who may change it |
|---|---|---|
| `suites.json` | Every verification entrypoint in the repo, classified by running it | **L3 (Jack).** Editing it changes what "green" means |
| `blockers.json` | Known problems autonomy must never repair (S1, MIGRATION-0016, GOV-1) | **L3.** Only a human edit lifts a blocker |
| `policy.json` | Limits and the standing L3 path list | **L3** |
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
