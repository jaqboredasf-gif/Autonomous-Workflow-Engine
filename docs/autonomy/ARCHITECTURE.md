# Autonomous Development Loop — Architecture Proposal (Milestone 1)

Status: **APPROVED by Jack, 2026-10-11**, with these constraints: build on `pcc-production` (main
is not reconciled; see blocker GOV-1); keep the limits in section 4; S1 and MIGRATION-0016 are
observe-and-escalate only (`autonomy/blockers.json`). **Milestone 2A (the verification foundation)
is implemented:** `autonomy/README.md`. **Milestone 2B (deployment confidence) is implemented,** with the
Inspector/Prioritizer deliberately deferred by Jack (2026-10-11) in favour of evidence for the first
Lippolis installation. **Milestone 3 step 1 is implemented** (Inspector, Prioritizer, Authority Classifier, Work Package
Generator; `npm run inspect`). No Builder or scheduler exists.
Grounded in `docs/autonomy/CURRENT_STATE.md`. Every design choice cites the existing mechanism it
reuses or the gap it answers.

## 0. Design stance

- **Mostly programs, few agents.** Six of the eleven loop stages are deterministic Node scripts. Only
  Planner (partly), Builder and the adversarial half of Evaluator need a model.
- **Wrap, don't duplicate.** `npm run plan` is the business Prioritizer and the 2026-09-01 decision
  forbids a second planner. The loop adds only an **engineering-health** view that plan cannot see,
  and merges the two with a fixed rule.
- **Lives on the production line.** It is built on a branch cut from `pcc-production`, not `main`.
  Same conventions: pure `.mjs` engines, `node:test`-free eval scripts, `npm run <name>` entrypoints,
  facts derived rather than declared.
- **The default outcome of a cycle is a brief, not a commit.** Building is the exception. A
  cycle is eligible to build only when a finding passes every gate in §3.

## 1. The loop, stage by stage

| Stage | Kind | Implementation | Reuses |
|---|---|---|---|
| North Star | file | `NORTH_STAR.md` | claims/gates vocabulary |
| Current state | derived | `npm run plan -- --json`, `readiness`, `evidence`, `deployment-gate` | all existing |
| **Inspector** | **program** | `scripts/awe-inspect.mjs` → `findings.json` | suite registry (new), plan JSON, git |
| Gap register | data | `autonomy/gaps.json`, the de-duplicated findings with first-seen/last-seen | — |
| **Prioritizer** | **program** | `autonomy/prioritize.mjs` (pure): engineering-health rule + plan's ENGINEERING pick | `programs/venture/plan.mjs` ranking |
| **Planner → Work package** | program + agent | Deterministic skeleton (`autonomy/work-package.mjs`). The agent fills implementation notes only | — |
| **Dispatcher** | **program** | `scripts/awe-cycle.mjs`: state machine, budgets, stop conditions, permissions | — |
| **Builder** | **agent** | One Claude Code session, given only the work package, on branch `autonomy/<cycle-id>` | repo `AGENTS.md` rules |
| **Evaluator** | **program + agent** | (a) deterministic: suite registry run in CI plus a diff-scope check against the package's allowlist; (b) adversarial review in a *fresh* session that never saw the Builder transcript | eval suites, perturbation culture |
| PR / artifact | GitHub | Draft PR with the cycle record attached | — |
| **Captain Brief** | **program** | `autonomy/brief.mjs` renders from the cycle record. No model writes it, so it cannot editorialize | — |
| Human approval | Jack | PR merge or close, plus `npm run autonomy -- --decide <cycle> APPROVE\|REJECT\|INVESTIGATE "<why>"` | — |

### Inspector (L0: read-only, no model)
Emits structured findings `{id, source, kind, severity, evidence[], paths[], first_seen}` from:
1. **Suite health:** runs the suite registry (§2) in a normalized environment (Node 24, `npm ci`,
   build). Each failing suite becomes a finding with its failing assertion text.
2. **Plan/readiness:** `awe-plan --json`. ENGINEERING and FOUNDER picks become findings, tagged
   by track.
3. **Repository hygiene:** migration-number collisions across branches, open PRs older than N days,
   security fixes unmerged (`S1`), and divergence between `pcc-production` and its working branch.
   These findings are **reported, never auto-fixed**, because each one is L3.
4. **Static debt:** TODO/FIXME counts, broken lint, and non-hermetic suites (a suite whose result
   changes with build presence).
It writes no repository files except its own output.

### Prioritizer (pure function)
```
1. Any RED suite on pcc-production          → top priority (a defect is always in scope, 2026-08-12)
2. Else plan's ENGINEERING pick, if eligible (§3)
3. Else engineering-health findings, ranked by
     score = (north_star_link × 3 + reliability × 2 + unblocks) / effort,  then risk ascending
4. Else NO BUILD this cycle. The brief carries plan's FOUNDER action as "the real bottleneck"
```
The weights are fixed in code, printed in every brief, and tested. "North star link" is 1 only when
the finding names a claim id or gate from plan; otherwise 0. That makes it checkable and impossible
to assert by declaration.

### Work package (schema, deterministic skeleton)
`objective, reason, evidence[] (finding ids + command output excerpts), claim/gate served,
affected_paths (allowlist), forbidden_paths, constraints, acceptance_criteria[] (each a command +
expected result), tests_required[], rollback (git revert of the PR; no data/schema touched),
risk_class (LOW|MEDIUM|HIGH), autonomy_level_required (L0–L3), budget {max_turns, max_minutes,
max_retries}`.
Only `risk_class=LOW` **and** `level ≤ L2` packages are dispatched to the Builder. Everything else
stops at L1 with the package attached to the brief for Jack.

## 2. Suite registry (new foundation)

`autonomy/suites.json` lists each test entrypoint with `{id, command, kind: offline|needs-build|needs-db|live,
hermetic: bool, runtime_s}`. One runner, `scripts/awe-verify.mjs`, executes the selected kinds and writes
`verify.json` (per-suite pass/fail counts, exit code, duration, Node version, commit). This is the
missing piece §5 of CURRENT_STATE identifies. CI, the Inspector and the Evaluator all call the
**same** runner, so they cannot disagree.

## 3. Safety and authority model

| Level | Allowed | Enforced by |
|---|---|---|
| **L0 Observe** | Read repo, run offline suites, read GitHub metadata | Inspector has no write path. CI job has `contents: read` |
| **L1 Prepare** | Write findings, gap register, work packages, briefs and docs under `autonomy/` and `docs/autonomy/` | Path allowlist |
| **L2 Build** | Branch `autonomy/<cycle-id>` from `pcc-production`'s working branch. Edit paths in the package allowlist. Run tests. Commit. Push the branch. Open a **draft** PR | Dispatcher refuses push to any other ref. Evaluator diff-scope check fails the cycle if any changed path is outside the allowlist or inside the denylist |
| **L3 Human only** | Merge to `pcc-production` or its working branch, deployments, `supabase/migrations/**`, `deployment/APPROVED_RELEASE.md`, `deploy/**`, `Dockerfile`, install scripts, `.github/workflows/**`, auth/authorization code, `.env*`/secrets, `organizations/**` dossiers, `programs/iic-2027/facts.mjs`, `derive.mjs` and anything that moves a readiness band, deleting branches, closing PRs, external communication, and **new product behavior in `apps/**`** (2026-08-12 freeze; defect fixes need a failing test first) | Hard-coded denylist in the Dispatcher, re-checked by the Evaluator. GitHub branch protection on `pcc-production` (Jack enables it) |

**Builder rules** (in the session prompt *and* checked mechanically where possible): never disable,
skip or weaken a test (the diff check flags deleted assertions and `skip`); never edit a suite and the
code it guards in the same package unless the package says so; never fabricate results (the
Evaluator reruns everything; Builder claims are ignored); no secrets (gitleaks-style pattern scan on
the diff, reusing `validate-agent-handoff.sh`'s patterns).

**Hard stop conditions** (the Dispatcher ends the cycle and the brief says why):
- the repo, migration history and live state disagree (any migration finding in a package's path)
- a finding touches a denylisted path
- a baseline suite is red before the Builder starts and the package is not about that suite
- the Builder exceeds its budget, or the Evaluator rejects twice
- any secret pattern appears in the diff

## 4. Dispatcher limits

| Limit | v1 value |
|---|---|
| Work packages built per cycle | **1** |
| Builder attempts per package | 2 (second only with the Evaluator's rejection reasons) |
| Builder budget | 60 agent turns / 45 min wall clock |
| Cycles per day | 1 scheduled + manual |
| Open autonomy PRs at once | **2**. The Dispatcher refuses to build while 2 await Jack, which prevents an unreviewed pile-up |
| Same finding re-attempted | not before Jack's decision on the last attempt. A REJECT marks the finding `suppressed` |
| Recursion | none. A cycle cannot start a cycle. Follow-ups are findings for the *next* cycle |

## 5. Audit trail

One directory per cycle, append-only, committed with the cycle:
```
autonomy/cycles/<YYYY-MM-DD>-<seq>/
  cycle.json      objective, inputs (commit SHAs, plan JSON hash), findings[], scores[],
                  selected, work_package, actions[], tests (verify.json before/after),
                  evaluation {deterministic, adversarial, verdict}, result, human_decision
  events.jsonl    one line per stage transition: {ts, stage, actor, input_hash, output_hash, ok, note}
  BRIEF.md        rendered from cycle.json
```
Records chain by `prev_cycle_hash` in `cycle.json`, the same idea as the control-plane journal
without importing it. No-build cycles commit to a long-lived `autonomy/ledger` branch, so they
create no PR noise. Build cycles carry their record inside the PR. JSON/JSONL only: no DB, no
service, nothing to operate. The human decision is written back by `--decide`, so the chain records
OBJECTIVE → … → HUMAN DECISION.

## 6. Captain Brief (rendered, about 2 minutes)

```
AWE CAPTAIN BRIEF — 2026-10-12 · cycle 2026-10-12-01 · base pcc-production@abc123
Examined        42 suites (41 green), plan gate 1, 10 open PRs, 3 hygiene findings
Top finding     <one line> — score 4.0 (link 1, reliability 1, unblocks 0, effort 1)
Why it matters  <claim/gate it serves, or "engineering health: <suite>">
Work done       <PR link> · 3 files · allowlist respected
Validation      tests 41→42 green · deterministic eval PASS · adversarial eval PASS (2 notes)
Real bottleneck (from npm run plan, founder track) <action>
Decision        APPROVE / REJECT / INVESTIGATE   →  npm run autonomy -- --decide <id> …
Next objective  <runner-up finding>
Not done        <hygiene findings that need Jack: S1, migration 0016 collision, stale PRs>
```

## 7. Scheduling

Uses only infrastructure the repository and environment already use:
- **GitHub Actions** (`.github/workflows/autonomy-verify.yml` on `pcc-production` and its working
  branch): on push and PR, plus a daily `schedule`. Runs `awe-verify` and `awe-inspect` with
  `contents: read` and no secrets. Uploads `verify.json`/`findings.json` as artifacts. This is the
  independent deterministic Evaluator: the Builder cannot influence it.
- **Claude Code Routine** (scheduled trigger, fresh session per firing), daily: runs
  `npm run autonomy` (Dispatcher). If a package is eligible, the same session builds. A **second,
  fresh session** is fired for the adversarial review, so no API key is stored in the repo.
- Neither path can merge or deploy. Jack enables branch protection on `pcc-production`
  (require PR + review), which makes that a property of GitHub, not of the agents' good behavior.

## 8. Dogfooding — what may become an AWE capability

| Dev-loop piece | General AWE capability | Already exists in product form |
|---|---|---|
| Inspector findings with evidence | OBSERVE/UNDERSTAND: workflow observation | `proof/baseline`, discovery interviews |
| Prioritizer with printed weights | PRIORITIZE with explainable ranking | `programs/venture/plan.mjs` |
| Work package with allowlist and risk class | PROPOSE within declared authority | approval matrix (`message_policies`) |
| L0–L3 + denylist | EXECUTE WITHIN AUTHORITY | `category_authority`, PCC approval authority |
| Evaluator rerun, never trust the builder | VERIFY (Verify Step convention) | B2 Verify Step, `verifyDecisionApplied()` |
| Cycle ledger + decision write-back | MEASURE/ESCALATE/LEARN | `proof/ledger`, ADR approval-diff graduation |

Rule: **no abstraction is extracted until the loop has run 10 real cycles** and the
same shape is needed by a second, non-development workflow.

## 9. Files to add or change (all on a branch from `pcc-production`)

New: `autonomy/suites.json`, `scripts/awe-verify.mjs`, `scripts/awe-inspect.mjs`,
`autonomy/prioritize.mjs`, `autonomy/work-package.mjs`, `autonomy/brief.mjs`,
`scripts/awe-cycle.mjs`, `autonomy/policy.mjs` (levels, allow/denylists, limits),
`scripts/eval-autonomy.mjs` (tests for all of the above, including perturbation),
`.github/workflows/autonomy-verify.yml` (**L3: Jack approves the workflow file**),
`docs/autonomy/*`, `NORTH_STAR.md`. Changed: `package.json` (scripts only),
`AGENTS.md` (pointer to the loop), `docs/planning/DECISION_LOG.md`.
**Untouched:** `apps/**`, `supabase/**`, `deploy/**`, `deployment/**`, `proof/**`, `programs/**`.

## 10. Milestone plan

| M | Deliverable | Done when |
|---|---|---|
| 2 | suite registry + `awe-verify` + `awe-inspect` + prioritizer + work-package generator | Run against `pcc-production` and produce a findings file and a package whose evidence a human can re-run; eval-autonomy green, perturbation-proven |
| 3 | Dispatcher + bounded Builder session + policy | One LOW package built on an `autonomy/*` branch; a planted out-of-allowlist edit is refused |
| 4 | Evaluator (CI deterministic + fresh-session adversarial) | A planted regression and a planted deleted assertion are both caught |
| 5 | cycle record + hash chain + brief + `--decide` | One cycle readable in about 2 minutes; the chain validates; tampering is detected |
| 6 | GH Actions workflow + Routine | Two unattended cycles with no human prompt |
| 7 | One full cycle against AWE | Jack approves or rejects a real PR from the brief alone |
