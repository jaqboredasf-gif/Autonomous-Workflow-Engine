# AWE — Current State (autonomy audit, Milestone 1)

Audit date: 2026-10-11. Read-only audit: no application code, schema, branch or live system was changed.
Method: every remote branch fetched and compared to `main`. `pcc-production` was checked out in a
scratch worktree and its offline suites were run. Planning, decision and architecture documents were
read on both lines. GitHub PRs, issues and Actions history were read.

> **The single most important fact:** `main` is not AWE. `main` stopped at 2026-07-27. The product
> that runs at Lippolis lives on **`pcc-production`**: 113 commits ahead of `main`, last commit
> 2026-09-03. Its `SOURCE_OF_TRUTH.md` names it as the only deployable branch. Any autonomous
> system built on `main` would inspect and improve the wrong codebase.

---

## 1. What AWE does today

| Line | Where | What it is | State |
|---|---|---|---|
| **PCC — Purchasing Control Center** | `pcc-production` (`apps/purchasing`, `capability/purchasing`, `deployment/`, `deploy/`) | Purchase-request → review → approval → PO → receipt workflow for Lippolis Electric. Next.js 16, `node:sqlite` store (Supabase variant exists), Docker/systemd/Windows installers, backup/restore, signed release record | **Approved for install, never run in production.** `npm run plan`: gate 1 "Production ready"; 0 production executions |
| **Proof / venture layer** | `pcc-production` (`proof/`, `programs/`, `organizations/`) | Baseline measurement, value ledger, case-study standard, 12 venture claims, 5 stage gates, readiness scorecard, discovery/interview tooling, IIC 2027 pitch spec | Built and tested. Readiness **7/48**. Evidence deadline for IIC: **31 Jan 2027** (`programs/iic-2027/MASTER_SPEC.md`) |
| **Exattime / Workstream A** | `main` (and inherited by `pcc-production`) | ExakTime replacement: Expo punch app, Next.js admin, Supabase RLS, payroll draft, timecard corrections | Built; parallel-run cutover blocked on boss's OT/rounding policy (A3/B8) |
| **AWE triage / Workstream B** | `main` + `claude/awe-iic-evidence-campaign-073p0v` (PR #15) | Email intake → classify → territory → approval matrix → outbound drafts → human approval queue | Built on fixtures. Real mail blocked on Entra (I1). Manual-intake bridge (MI1) is on an unmerged branch with an unapplied migration |
| **Agent execution planes** | `feat/kernelized-mcp-context` → `codex/*` stack (PRs #4–#7), `wip/agent-execution-plane-2026-07-28` | Control plane (journal, leases, approval quorum), bounded agent runtime, memory layer, durable execution | **Unmerged, unreviewed, no integration path** (stack root has no PR into `main`). Not used by PCC |
| **M365 integration plane** | `claude/microsoft-365-integration-plane-fcsm1e` (PR #9) | Offline Graph integration slice | Unmerged; blocked on Entra |
| **TEGG estimating** | `claude/tegg-agent-gaps-af4ziv`, `backup/tegg-mock-sprint-*` | Pricing/estimating engine experiment | Unrelated history (no merge base with `main`) |

## 2. Major components and architecture (production line)

```
organizations/<org>/dossier.mjs ─┐   (a customer described in one file)
capability/purchasing/profile ────┼─► deployment/manifest.mjs ─► deployment-gate / preflight / verify
                                  │
apps/purchasing (Next.js) ── domain (pure .mjs) ── application ── store: node:sqlite | supabase
        │                                                   └── audit actions (45, all classified)
        └── /api/health reports PCC_RELEASE (signed in deployment/APPROVED_RELEASE.md)

proof/   baseline · execution · value · ledger · case-study · provenance   (pure, no I/O)
programs/venture   claims (12) → gates (5) → plan (one action per track)     (pure)
programs/iic-2027  derive.mjs (facts from repo) → readiness (12 bands) → narrative/pitch
programs/evidence, programs/discovery  field-sheet import → interview/evidence records
```

Design principles that are already enforced in code and that the autonomy system must keep:
- **Facts are derived, never declared.** `programs/iic-2027/derive.mjs` reads the repository. `facts.mjs`
  `DECLARED` is empty. `AGENTS.md`: "Do not raise a readiness band by declaring a fact."
- **Pure engines, thin I/O shells.** Planners, ledgers and gates have no clock, no randomness and no I/O.
- **Refuse rather than guess.** Importers, the deployment gate and startup all fail closed.
- **Non-vacuity by perturbation.** Most suites are proven able to fail by deliberately breaking the
  rule they guard. The decision logs record this repeatedly.
- **Human gates are explicit.** The approval matrix, signed release record, "live migration needs
  Jack" and zero v1 auto-sends are all in place.

## 3. Current development workflow

- Sessions are single-task Claude Code / Codex runs on per-task branches, merged by fast-forward into
  `claude/purchasing-control-center` and then into `pcc-production`. Draft PRs are used for review.
  Most production-line work was **pushed directly**, not merged through PRs.
- **Session start** (pcc-production `AGENTS.md`): `npm run plan`, `npm run readiness`, `npm run evidence`,
  `git log`.
- **Session end:** commit message carries a paragraph of *why*, plus a `DECISION_LOG.md` entry for
  non-obvious decisions.
- **Conflict:** `main`'s `AGENTS.md` still requires `docs/planning/AGENT_HANDOFF.md` updates, and its
  only CI workflow enforces that. `pcc-production` retired both on 2026-09-01 as "a second source of
  truth". The two lines give agents contradictory instructions.
- **Mode (DECISION_LOG 2026-08-12):** PCC moved from build mode to *deploy/observe/refine*. Changes now
  need evidence: smoke-test failures, user friction, production defects, stakeholder requests or
  operational evidence. Speculative features, architectural preferences and the Postgres/object-storage
  migrations are explicitly out of bounds until their triggers fire.

## 4. Existing automation (reusable)

| Mechanism | Location | Reuse for the autonomy loop |
|---|---|---|
| `npm run plan` (`programs/venture/plan.mjs`) | pcc-production | **The Prioritizer for business work, already built.** Gate-first, then leverage = (1+unlocks)/cost. One action per track. Refuses blocked or EXTERNAL claims. Has a `--json` mode. The 2026-09-01 decision explicitly rejects "a second planner" |
| `npm run readiness` / `evidence` / `pitch` | pcc-production | Context for briefs; facts all come from `derive.mjs` |
| `npm run deployment-gate`, `pcc-preflight`, `pcc-verify-*` | pcc-production | Deterministic deployability check |
| About 60 `scripts/eval-*` suites, `apps/purchasing npm test` | pcc-production | **The Evaluator's deterministic half.** Pure, offline, mostly hermetic |
| `proof/ledger.mjs`, `proof/provenance.mjs` | pcc-production | Patterns (refusals, provenance) for a cycle ledger. Business-value specific, not reused directly |
| `.github/workflows/agent-handoff.yml` | `main` only | The **only** CI that has ever run (97 runs). Validates a markdown file and runs no tests. Deleted on `pcc-production` |
| Control plane journal / approval quorum / bounded agent runtime | `codex/*`, `feat/kernelized-mcp-context` (unmerged) | Conceptually relevant (dispatch, journal, budgets) but unmerged, unreviewed and tenant/business-runtime shaped. **Do not build on it for v1.** Revisit in Phase 9 |
| Claude Code remote sessions + Routines (scheduled triggers) | this environment | Already how the work gets done. A cheap scheduler for agent stages that holds no API key in the repo |

## 5. Testing situation

Measured in this audit (Node 22.22, scratch worktree of `pcc-production` @ `bee8e44`):

| Suite | Result |
|---|---|
| `eval-programs` | 80/0 pass |
| `eval-evidence` | 200/0 pass |
| `eval-source-of-truth` | 26/0 pass |
| `eval-proof` | 282/0 pass (after `npm ci`; before it, crashed: `@awe/workflow` not linked) |
| `eval-workflow-engine` | 238/0 pass (after `npm ci`) |
| `eval-second-customer`, `eval-purchasing-domain` | pass (after `npm ci`) |
| `eval-venture-plan` | **264/3 fail.** Environment-dependent: the plan reads whether a local `.next` build exists, so the "current gate" differs by machine |
| `eval-deployment-gate` | **fails** for the same reason (`artifact.built` absent locally) |

Findings:
1. **No CI runs any test on the production line.** Green is whatever the last session said. Nothing
   independently verifies a push.
2. **The test environment is undeclared.** Node ≥24 is required (`package.json`); this container has
   22. Suites need `npm ci` first. Two suites are non-hermetic: they depend on a local build artifact.
3. There is **no suite registry.** No list says which suites are offline, which need a build and which
   need a live DB. `regression.sh` on `pcc-production` is still the July `main` version and never
   mentions purchasing.
4. `main`'s live acceptance slices 1–5 need `.env.acceptance` (live Supabase) and macOS `date -v`.
   They cannot run in CI.

## 6. Deployment situation

- `npm run deployment-gate` → `BLOCKED_BEFORE_BUILD` locally. The only AWE-owned blocker is
  `artifact.built`, which is a local build artifact, not a real defect. Remaining go-live facts
  (`network.hostname`, `service.enabled_at_boot`, `storage.backed_up_by_customer`) belong to
  Lippolis IT.
- Release `585b749` is signed in `deployment/APPROVED_RELEASE.md`. HEAD carries additional tooling,
  recorded as a stated choice. No server is known to be running PCC (`usage.executions = 0`).
- No deployment automation exists and none should be autonomous. Install is a human act on a
  Lippolis machine.

## 7. Major gaps

1. **Branch sprawl with no integration path.** 24 remote branches, 10 open draft PRs (oldest
   2026-07-27), and a 4-deep stacked PR tower whose root has no PR. Since 2026-09-03 nothing has moved.
2. **Migration history disagrees with itself.** `0016` means four different things on four branches:
   `purchasing_control` (pcc-production), `manual_intake_bridge` (PR #15), and
   `drop_undeclared_client_policies` (codex stack and security/c1). Security remediation also uses
   timestamped names on `security/phase-1-remediation`. Four migrations were found applied out of band
   to a local DB (`docs/recovered/2026-08-10-*`). By the repository's own rule this is a **stop**
   condition for any schema work.
3. **Security finding S1 is open and unmerged everywhere.** 16 undeclared policies let any org member
   delete audit events on the hosted Supabase project. Fixes exist on three branches, none merged.
   Live state is unknown from here: the network policy blocks api.supabase.com.
4. **No CI on the production line** (§5). That makes every "tests pass" claim a self-report.
5. **The engineering track has run out of evidence-free work.** The plan's top engineering action is a
   local build. Every remaining North Star gap is founder-side: a baseline at Lippolis, interviews,
   installation. An autonomous builder that "finds things to build" would violate the 2026-08-12
   decision.
6. **Contradictory agent instructions** between `main` and `pcc-production` (§3).
7. Standing debt from `main`: broken `npm run lint` in `apps/web`, macOS-only acceptance scripts,
   copy-pasted shell helpers, an un-revoked `sbp_` management token, and a service-role key rotation
   before real data (CONTEXT.md).

## 8. Major risks

| Risk | Why it matters |
|---|---|
| An autonomous agent working on `main` | It would improve a codebase nobody deploys and add to the sprawl |
| An agent "fixing" the migration collision or S1 | Destructive and live-affecting. Requires Jack, and requires knowing live state |
| An agent producing features to look productive | Directly contradicts DECISION_LOG 2026-08-12. Dilutes the evidence story |
| An agent moving readiness bands | Only real-world acts may move them. The code already refuses declared facts, and an agent must not route around that, e.g. by editing `derive.mjs` |
| Unverified green | With no CI, an agent's "tests pass" is a self-report, which is the exact failure mode the proof layer was built to refuse |
| Five-week silence before an evidence deadline | 16 weeks remain to 31 Jan 2027, and production usage is 0 |

## 9. Highest-leverage opportunities

1. **Make "is the production line green?" a fact, not a claim.** Add a suite registry plus one
   deterministic runner that emits JSON, run by CI on `pcc-production`. This is the foundation that
   the Inspector, the Evaluator and scheduling all need. It changes no product behavior.
2. **Wrap `npm run plan`, don't rebuild it.** The business Prioritizer exists. The autonomy loop adds
   only what plan cannot see: engineering health (suites, CI, drift, branch/PR hygiene). It routes
   founder-track actions into the Captain Brief instead of trying to execute them.
3. **Make repository hygiene visible.** Report stale PRs, unmerged security fixes and migration-number
   collisions as findings every cycle, so they stop being invisible. The fixes stay human decisions.
4. **Keep the builder small and boring.** Deterministic eligibility rules, path allowlists, one work
   package per cycle, and CI as the independent verifier.
