# AWE Emergency Preservation Audit

**Audit date:** 2026-08-01/02
**Auditor:** automated read-only audit session
**Mode:** PRESERVATION ONLY — no clean, reset, rebase, merge, delete, or modification was performed on any existing work.

---

## 0. CRITICAL SCOPE LIMITATION — READ FIRST

**This audit did not run on your Mac.** It ran inside an ephemeral Linux cloud
container (`vm`, Linux 6.18.5, container
`container_016QNWDCcbZrD2oYAe7wCLYF--claude_code_remote--1ca715`).

Verified facts about the audit host:

- No `/Users` directory exists — this is not macOS.
- The entire filesystem contains exactly **one** AWE-related Git repository:
  `/home/user/Autonomous-Workflow-Engine`, freshly cloned at container start.
- The only other `.git` directories on the host are toolchain installs:
  `/opt/rbenv/.git`, `/opt/rbenv/plugins/ruby-build/.git`, `/opt/nvm/.git`,
  `/root/.cache/uv/sdists-v9/.git`. None are AWE-related.

**Consequences:**

1. Any repository, worktree, stash, or uncommitted change that exists **only on
   your Mac** is invisible to this audit and is **not covered by this report**.
2. Local-only Mac artifacts — the Obsidian Persistent Cognition vault, n8n
   workflow exports, TEGG work, `.env` files, local test evidence — cannot be
   confirmed or preserved from here.
3. Section 8 contains a **Mac-side command block** you must run locally to
   complete the audit. Until it is run, the Mac-side risk is **unknown, not zero**.

What this audit *can* and *does* establish authoritatively is the state of the
GitHub remote `jaqboredasf-gif/Autonomous-Workflow-Engine` and everything in it.
That is genuinely good news, and it is covered in full below.

---

## 1. Repository inventory (audit host)

### 1.1 `/home/user/Autonomous-Workflow-Engine`

| Field | Value |
|---|---|
| Absolute path | `/home/user/Autonomous-Workflow-Engine` |
| Remote URL (`origin`) | `http://local_proxy@127.0.0.1:41729/git/jaqboredasf-gif/Autonomous-Workflow-Engine` (session git proxy for `github.com/jaqboredasf-gif/Autonomous-Workflow-Engine`) |
| Current branch | `claude/awe-preservation-audit-iuq4k6` |
| HEAD commit | `dbf8f1755f1afefa8f7e44caa6c59bdf7e2863b1` |
| HEAD subject | `Merge pull request #2 from jaqboredasf-gif/chore/agent-handoff-clean` |
| HEAD author / date | `jaqboredasf-gif <jaqboredasf@gmail.com>` / 2026-07-27 10:19:31 -0400 |
| Dirty status | **CLEAN** — zero modified, zero staged |
| Untracked files | **NONE** (`git status --porcelain -uall` returned 0 lines) |
| Ignored-but-present files | none matched |
| Stashes | **NONE** (`git stash list` empty) |
| Worktrees | 1 (the main checkout only) — no linked worktrees |
| Dangling/unreachable commits | **NONE** (`git fsck --no-reflogs --lost-found` clean) |
| Clone depth | full (not shallow), 32 commits reachable from HEAD at clone time |
| Local branches | `claude/awe-preservation-audit-iuq4k6`, `main` |
| Unpushed commits | **NONE** — both local branches point at `dbf8f17`, which exists on the remote as `origin/main` |

**Local branch upstream detail:**

| Local branch | SHA | Upstream | Ahead of upstream |
|---|---|---|---|
| `main` | `dbf8f17` | `origin/main` | 0 |
| `claude/awe-preservation-audit-iuq4k6` | `dbf8f17` | *(none — no upstream set)* | 0 unique commits |

> Note: `claude/awe-preservation-audit-iuq4k6` had a remote counterpart that was
> deleted server-side during this session's fetch/prune. It carries **no unique
> work** — it is identical to `main` — so its loss would destroy nothing.

### 1.2 Non-AWE repositories present (no action needed)

`/opt/rbenv`, `/opt/rbenv/plugins/ruby-build`, `/opt/nvm`,
`/root/.cache/uv/sdists-v9` — toolchain/package-manager clones, unrelated to AWE.

---

## 2. Remote branch inventory — the real preservation picture

A `git fetch origin --prune` was run (read-only and purely additive; it creates
remote-tracking refs and cannot destroy local work). It revealed **11 remote
branches**, of which the local clone originally had only 2.

| Branch | HEAD SHA | Commits ahead of `main` | Merged into `main`? | Last commit |
|---|---|---|---|---|
| `main` | `dbf8f17` | 0 | — (is main) | 2026-07-27 Merge PR #2 |
| `chore/agent-handoff-clean` | `fecf36a` | 0 | **YES — fully merged** | 2026-07-27 docs: record clean handoff completion |
| `chore/agent-handoff-integration` | `e12eac2` | **6** | NO | 2026-07-27 docs: record final handoff checks |
| `security/c1-policy-cleanup` | `3e617f2` | **1** | NO | 2026-07-27 Security: prepare C1 policy cleanup migration |
| `security/phase-1-remediation` | `92f05a7` | **5** | NO | 2026-07-27 docs: record isolated replay hard stop |
| `feat/kernelized-mcp-context` | `19f5e1c` | **20** | NO | 2026-07-28 docs(handoff): record the execution control plane milestone |
| `codex/live-mcp-data-boundary` | `cf37090` | **24** | NO | 2026-07-28 docs: finalize concurrent platform handoff |
| `codex/agent-runtime` | `bfcb679` | **26** | NO | 2026-07-28 docs: finalize agent runtime handoff |
| `codex/memory-layer` | `cf3335d` | **28** | NO | 2026-07-28 docs: finalize memory layer handoff |
| `codex/durable-execution-plane` | `55c0ba5` | **33** | NO | 2026-07-28 docs(execution): record configured lint result |
| `claude/microsoft-365-integration-plane-fcsm1e` | `ad8589a` | **1** | NO | 2026-07-30 I1: Microsoft 365 Integration Plane (offline slice) |

### 2.1 HEADLINE FINDING — all named work is already on the remote

**Every branch you flagged for special attention already exists on GitHub with
its full history.** `codex/agent-runtime`, `codex/memory-layer`,
`codex/durable-execution-plane`, the execution-control work
(`feat/kernelized-mcp-context`), and the Microsoft 365 integration
(`claude/microsoft-365-integration-plane-fcsm1e`) are all pushed and durable.

**There is no local-only branch anywhere in this environment that needs
rescuing.** Section 7's push commands are therefore verification/no-op commands,
not rescue commands. The genuine remaining risk is Mac-side and non-Git (Sections 6 and 8).

### 2.2 The codex work is a chained PR stack

All five planes are stacked, each PR targeting the previous branch rather than `main`:

```
main
 └── feat/kernelized-mcp-context          (20 ahead)  ← NO PR INTO MAIN  ⚠
      └── codex/live-mcp-data-boundary    (24 ahead)  ← PR #4 → feat/kernelized-mcp-context
           └── codex/agent-runtime        (26 ahead)  ← PR #5 → codex/live-mcp-data-boundary
                └── codex/memory-layer    (28 ahead)  ← PR #6 → codex/agent-runtime
                     └── codex/durable-execution-plane (33 ahead) ← PR #7 → codex/memory-layer
```

`codex/durable-execution-plane` @ `55c0ba5` is the **tip of the stack and a
superset of all four branches beneath it** (162 files changed, +33,300 lines vs
`main`). Preserving that one SHA preserves the whole stack's content.

**⚠ Structural risk:** `feat/kernelized-mcp-context` is the root of the entire
stack and has **no pull request into `main`**. The whole 33-commit tower rests on
a branch with no integration path open. Nothing is lost today — the branch is
pushed — but the stack cannot merge until that base PR exists.

### 2.3 Pull request state

| PR | Title | Head → Base | State |
|---|---|---|---|
| #9 | I1: Microsoft 365 Integration Plane (offline slice) | `claude/microsoft-365-integration-plane-fcsm1e` → `main` | **OPEN** (draft) |
| #7 | Add provider-neutral Durable Execution Plane | `codex/durable-execution-plane` → `codex/memory-layer` | **OPEN** (draft) |
| #6 | Add tenant-bound versioned Memory Layer | `codex/memory-layer` → `codex/agent-runtime` | **OPEN** (draft) |
| #5 | Add bounded provider-neutral Agent Runtime | `codex/agent-runtime` → `codex/live-mcp-data-boundary` | **OPEN** (draft) |
| #4 | test(mcp): add opt-in live tenant-boundary proof | `codex/live-mcp-data-boundary` → `feat/kernelized-mcp-context` | **OPEN** (draft) |
| #3 | Security: prepare Phase 1 C1-C4 remediation | `security/phase-1-remediation` → `main` | **OPEN** (draft) |
| #2 | Add permanent agent handoff workflow | `chore/agent-handoff-clean` → `main` | **MERGED** 2026-07-27 |
| #1 | Establish GitHub agent handoff workflow | `chore/agent-handoff-integration` → `security/c1-policy-cleanup` | **CLOSED, not merged** |

`chore/agent-handoff-integration` (6 commits ahead) had its only PR **closed
unmerged**. It is pushed and safe, but it is orphaned — no open integration path.

---

## 3. Special-attention items — findings

### 3.1 `codex/agent-runtime` — ✅ PRESERVED
`bfcb679`, 26 commits ahead of `main`. Adds `packages/awe-agent-runtime/`
(`runtime.mjs`, `agent-registry.mjs`, `run-store.mjs`, `transcript.mjs`,
`model.mjs`, `action.mjs`, `manifest.mjs`), `docs/architecture/AGENT_RUNTIME.md`,
and `scripts/eval-agent-runtime.{mjs,sh}`.

### 3.2 `codex/memory-layer` — ✅ PRESERVED
`cf3335d`, 28 commits ahead. Adds `packages/awe-memory/`,
`docs/architecture/MEMORY_LAYER.md`, `scripts/eval-memory.{mjs,sh}`.

### 3.3 `codex/durable-execution-plane` — ✅ PRESERVED
`55c0ba5`, 33 commits ahead — **the single most valuable ref in the repository.**
Adds `packages/awe-execution/`, `docs/architecture/DURABLE_EXECUTION_PLANE.md`,
`docs/planning/EXECUTION_HANDOFF.md`, `scripts/eval-durable-execution.{mjs,sh}`,
`scripts/awe-execution.mjs`, `scripts/lib/awe-execution.mjs`, and seven operator
guides: `docs/guides/EXECUTION_{CHECKPOINTS,IDEMPOTENCY,LEASES,PAUSE_RESUME,REPLAY,RETRY_RECOVERY,WORKERS}.md`.

### 3.4 Execution-control work — ✅ PRESERVED
Lives on `feat/kernelized-mcp-context` (`19f5e1c`, 20 ahead):
`docs/architecture/EXECUTION_CONTROL_PLANE.md`, `packages/awe-control-plane/`
(`kernel.mjs`, `engine.mjs`, `dispatch.mjs`, `journal.mjs`, `policy.mjs`,
`manifest.mjs`, `workflow-registry.mjs`), `packages/awe-kernel/` (17 modules),
and 10 ADRs under `docs/architecture/decisions/`.
**Caveat:** this is the stack root with no PR into `main` (see 2.2).

### 3.5 Orchestration and Responsibility Plane — ⚠ NO EXACT MATCH
A case-insensitive grep for the exact phrase `"Orchestration and Responsibility"`
across **all 11 remote branches** returned **zero hits**. The nearest material is:

- `docs/architecture/AGENT_HARNESS_DOCTRINE.md`
- `docs/architecture/UBIQUITOUS_LANGUAGE.md`
- `docs/architecture/AGENT_RUNTIME.md`, `MEMORY_LAYER.md`, `DURABLE_EXECUTION_PLANE.md`
- `docs/planning/DECISION_LOG.md`

which do use "orchestration" and "responsibility" separately (6–10 files per
branch, richest on `codex/durable-execution-plane`).

**Conclusion:** if a document titled "Orchestration and Responsibility Plane"
exists, it is **not in this repository on any branch** — it is Mac-local or in a
different repo. Treat as an unresolved preservation gap (Section 8, P1).

### 3.6 Migration `005` — ⚠ AMBIGUOUS, needs your confirmation
The only migration matching `005` on any branch is `0005_storage_photos.sql`,
present identically on **all 11 branches** and long since merged into `main`.
It is fully preserved and not at risk.

If "Migration 005" meant something else, the two nearby candidates are:
- ADR `docs/architecture/decisions/0005-fixture-session-lifecycle.md`
  (on the codex stack), or
- a migration in a **different repository** not present here.

**The real migration risk is not `005` — it is a `0016` three-way collision:**

| Branch | Migration file claiming slot `0016` |
|---|---|
| `security/c1-policy-cleanup`, `chore/agent-handoff-integration`, and the whole codex stack | `0016_drop_undeclared_client_policies.sql` |
| `claude/microsoft-365-integration-plane-fcsm1e` | `0016_m365_integration_plane.sql` |
| `security/phase-1-remediation` | timestamp-style `20260727142118_phase1_c1_remove_undeclared_policies.sql` (+ `…142120_c2`, `…142121_c3`, `…142123_c4`) — a **competing implementation of the same C1 fix** |

Two different migrations both claim `0016`, and a third branch re-solves C1 under
a different naming convention entirely. This is already acknowledged in-repo by
`docs/architecture/decisions/0009-competing-c1-migration-artifacts.md` and
`docs/planning/MIGRATION_HISTORY_RECONCILIATION_PLAN.md`. **Nothing is lost, but
these cannot all merge as-is.** Flagged as P2 in Section 9.

### 3.7 Microsoft 365 integration — ✅ PRESERVED
`claude/microsoft-365-integration-plane-fcsm1e` @ `ad8589a`, PR #9 open (draft),
based directly on `main` (not on the codex stack). 70 files, +7,861 lines:
- `packages/m365/src/` — `gateway.ts`, `executor.ts`, `execution.ts`,
  `credentials.ts`, `capabilities.ts`, `allowlist.ts`, `contracts.ts`,
  `evidence.ts`, `fake-graph.ts`, and adapters `mail.ts`, `teams.ts`,
  `document.ts`, `identity.ts`, `types.ts`
- `supabase/migrations/0016_m365_integration_plane.sql` (406 lines)
- `docs/architecture/M365_INTEGRATION_PLANE.md`,
  `docs/integrations/M365_ENTRA_CONFIGURATION.md`,
  `docs/integrations/BLOCKED_LIVE_PROOF.md`
- **22 notification fixtures** under `fixtures/m365/notifications/` plus
  `allowlist.json`, `graph-state.json`, `labels.json`, `subscriptions.json`

### 3.8 The tested TEGG implementation — ❌ NOT PRESENT ANYWHERE
A case-insensitive grep for `TEGG` across **all 11 remote branches and all
tracked files** returned **zero hits**. There is no TEGG code, no TEGG handoff
document, and no TEGG test evidence in this repository.

**This is the single largest unresolved gap in the audit.** If a tested TEGG
implementation exists, it is Mac-local, in another repository, or in an
un-pushed working directory — and it is currently **unprotected**. P0 in Section 9.

### 3.9 Obsidian Persistent Cognition vault — ❌ NOT PRESENT ANYWHERE
Greps for `Obsidian` and `Persistent Cognition` across all 11 branches returned
**zero hits**. No `.obsidian/` directory, no vault, no markdown vault structure
exists in this repository or on this host.

By nature an Obsidian vault is a local directory, so this is expected — but it
also means **it is entirely unprotected by Git as far as this audit can verify.**
P0 in Section 9.

### 3.10 Lippolis automation — ✅ PRESERVED (as domain content)
`Lippolis` appears in 17 tracked files on `main`, including
`docs/planning/PROJECT_SCOPE.md`, `docs/planning/CONTEXT.md`,
`docs/AUTOMATION_SYNERGY.md`, `docs/ROADMAP.md`,
`docs/architecture/UBIQUITOUS_LANGUAGE.md`, and the email fixtures
`fixtures/emails/01`–`03`. This is the business domain of the whole repo; it is
merged into `main` and safe.

### 3.11 n8n — ✅ PRESERVED as design docs; ❌ NO WORKFLOW EXPORTS
`n8n` appears in 42 files on `main` and up to 61 on
`codex/durable-execution-plane` — but these are **design and architecture
references** (`docs/AUTOMATION_SYNERGY.md`, `docs/GAP_ANALYSIS.md`,
`docs/architecture/AGENT_HARNESS.md`, `apps/web/src/lib/approval-queue.ts`, etc.).

A filename search for n8n workflow export JSON across all 11 branches returned
**zero files**. **No n8n workflow export is tracked in Git anywhere.** If exports
exist, they are Mac-local and unprotected. P1 in Section 9.

### 3.12 Supabase — ✅ PRESERVED
`supabase/config.toml` plus 15 migrations (`0001`–`0015`) merged in `main`, with
branch-specific `0016`s as described in 3.6. `supabase/.gitignore` is tracked.

---

## 4. Test evidence, harnesses, and handoffs found in Git

| Artifact | Location | Status |
|---|---|---|
| Database harness | `scripts/lib/db.mjs` | on `main` ✅ |
| Migration validators | `scripts/lib/validate-migration-0014.mjs`, `-0015.mjs` | on `main` ✅ |
| Phase-1 security validator | `scripts/lib/validate-phase1-security.mjs` | `security/phase-1-remediation` only |
| Tenant-DB harness + test | `packages/mcp-server/src/tenant-db.js`, `packages/mcp-server/test/tenant-db.test.mjs` | `security/phase-1-remediation` only |
| Acceptance suites 1–5 | `scripts/acceptance-slice{1..5}.sh` | on `main` ✅ |
| Security acceptance | `scripts/acceptance-s1-security.sh` | `security/c1-policy-cleanup`, `chore/agent-handoff-integration`, codex stack |
| Policy rehearsal / rollback SQL | `scripts/s1-policy-cleanup-{rehearsal,rollback}.sql` | `security/c1-policy-cleanup` + codex stack |
| Eval harnesses (18 on codex tip) | `scripts/eval-{kernel,context,control-plane,agent-runtime,memory,execution,durable-execution,mcp,mcp-live,…}.{mjs,sh}` | `codex/durable-execution-plane` (superset) |
| Artifact store / runner report / suite plan | `scripts/lib/{artifact-store,runner-report,suite-plan}.mjs` | codex stack |
| Approval evidence schema | `supabase/migrations/0014_approval_evidence.sql` | on `main` ✅ |
| Agent handoff | `docs/planning/AGENT_HANDOFF.md`, `scripts/validate-agent-handoff.sh`, `.github/workflows/agent-handoff.yml` | on `main` ✅ |
| Codex handoff | `docs/planning/CODEX_HANDOFF.md` | codex stack + security/c1 (**not on `main`**) |
| Execution handoff | `docs/planning/EXECUTION_HANDOFF.md` | `codex/durable-execution-plane` only |
| Session handoff | `docs/planning/SESSION_HANDOFF.md` | on `main` ✅ |
| **TEGG handoff** | — | **NOT FOUND ON ANY BRANCH** ❌ |

---

## 5. Fixture corpora (test evidence, all Git-protected)

- `fixtures/emails/` — 12 cases + `labels.json` + `model_recorded.json` (`main`)
- `fixtures/approvals/` — 15 cases + `labels.json` (`main`)
- `fixtures/outbound/` — `cases/`, `labels.json`, `policies.json` (`main`)
- `fixtures/queue/` — `cases/`, `base-row.json`, `labels.json` (`main`)
- `fixtures/m365/` — 22 notification cases + 4 state files (M365 branch only)

---

## 6. Files NOT protected by Git

### 6.1 On the audit host — none

The working tree is completely clean: zero modified files, zero untracked files,
zero stashes, zero dangling objects. Nothing here is at risk.

### 6.2 Excluded by `.gitignore` (by design)

Repo `.gitignore`: `node_modules/`, `.env`, `.env.*`, `.expo/`, `.next/`,
`dist/`, `.DS_Store`, with `!.env.example` re-included.

**Environment templates:** the only tracked template on any branch is
`apps/mobile/.env.example`. Real `.env` / `.env.*` files are correctly ignored
and therefore **not backed up by Git** — this is right for secrets, but it means
the *structure* of your live configuration exists only on the Mac.
**No secret values are recorded in this report.** Preserve real `.env` files
through a password manager or encrypted store, never by committing them.

Gaps worth closing: there is **no** `apps/web/.env.example`, **no**
`packages/mcp-server/.env.example`, and **no** `packages/m365/.env.example`,
despite those components requiring configuration (Supabase keys, Microsoft Graph
/ Entra app registration). Adding *key-name-only* templates would preserve
configuration shape without exposing values.

### 6.3 Mac-local and unverifiable from here — the actual exposure

These categories are **named in your request but absent from every branch of this
repository**, so unless they live in another remote they are unprotected:

| Category | Status | Evidence |
|---|---|---|
| Obsidian Persistent Cognition vault | ❌ unprotected / not found | 0 grep hits across 11 branches |
| Tested TEGG implementation + TEGG handoffs | ❌ unprotected / not found | 0 grep hits across 11 branches |
| n8n workflow exports (`.json`) | ❌ unprotected / not found | 0 matching filenames across 11 branches |
| "Orchestration and Responsibility Plane" doc | ❌ unprotected / not found | 0 exact-phrase hits across 11 branches |
| Live `.env` files | ❌ by design (gitignored) | `.gitignore` |
| Local eval run outputs / test evidence artifacts | ❌ likely untracked | harnesses are tracked; their outputs are not |
| Untracked migrations | ⚠ none here; unknown on Mac | all branch migrations enumerated in §3.6 |
| Local documentation not in `docs/` | ⚠ unknown | cannot inspect Mac |

---

## 7. Push commands to preserve local-only branches

**Audit result: there are no local-only branches on this host that need pushing.**
Both local branches are at `dbf8f17`, already present on the remote. The commands
below are therefore **verification commands** — they should each report
"Everything up-to-date" or a no-op.

```bash
cd /home/user/Autonomous-Workflow-Engine

# 1. Confirm nothing is unpushed (expect empty output for each branch)
for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do
  echo "== $b"; git log --oneline origin/main.."$b"
done

# 2. Verify every remote branch tip is reachable locally (expect no output)
for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do
  git cat-file -e "$b^{commit}" 2>/dev/null || echo "MISSING LOCALLY: $b"
done
```

### 7.1 If, on the Mac, a branch turns out to be local-only

Use this **safe, non-destructive** pattern — `--no-force` semantics only. Never
add `--force` or `--force-with-lease` to a preservation push.

```bash
# Generic safe push (creates the remote branch or fast-forwards it; fails loudly
# rather than overwriting anything):
git push -u origin <branch-name>

# Named, ready to paste — run only the ones that report unpushed commits:
git push -u origin codex/agent-runtime
git push -u origin codex/memory-layer
git push -u origin codex/durable-execution-plane
git push -u origin codex/live-mcp-data-boundary
git push -u origin feat/kernelized-mcp-context
git push -u origin claude/microsoft-365-integration-plane-fcsm1e
git push -u origin security/phase-1-remediation
git push -u origin security/c1-policy-cleanup
git push -u origin chore/agent-handoff-integration
```

### 7.2 If a Mac branch diverged from the remote — preserve BOTH sides

Do **not** force-push. Push the local state under a new rescue name so nothing is
overwritten:

```bash
git push origin <branch-name>:refs/heads/rescue/<branch-name>-mac-$(date +%Y%m%d)
```

### 7.3 Preserving stashes and detached work found on the Mac

Stashes are not pushed by `git push`. Convert each to a real branch first:

```bash
git stash list
# For each stash@{N}:
git branch rescue/stash-N stash@{N}
git push -u origin rescue/stash-N

# Any dangling/unreachable commits worth keeping:
git fsck --lost-found
git branch rescue/dangling-<shortsha> <full-sha>
git push -u origin rescue/dangling-<shortsha>
```

### 7.4 Belt-and-braces full mirror (recommended before any cleanup)

```bash
# Complete bare backup of every ref, on the Mac, to external storage:
git clone --mirror <mac-repo-path> ~/AWE-BACKUP-$(date +%Y%m%d).git
tar -czf ~/AWE-BACKUP-$(date +%Y%m%d).git.tar.gz -C ~ AWE-BACKUP-$(date +%Y%m%d).git
```

---

## 8. Mac-side audit — run these to close the gap

This audit cannot see your Mac. Run the following **read-only** block locally and
compare against this report. Nothing here modifies any repository.

```bash
# --- 8.1 Find every Git repo on the Mac ---
find ~ -name .git -maxdepth 8 -not -path '*/node_modules/*' 2>/dev/null

# --- 8.2 Full state dump for each repo found ---
for r in $(find ~ -name .git -maxdepth 8 -not -path '*/node_modules/*' 2>/dev/null); do
  d=$(dirname "$r"); echo "######## $d"
  git -C "$d" remote -v
  git -C "$d" status -sb
  git -C "$d" status --porcelain -uall          # dirty + untracked
  git -C "$d" branch -vv                        # local branches + upstream
  git -C "$d" branch -r                         # remote branches
  git -C "$d" stash list                        # stashes
  git -C "$d" worktree list                     # worktrees
  git -C "$d" fsck --lost-found 2>/dev/null     # dangling commits
  git -C "$d" for-each-ref --format='%(refname:short) %(upstream:short) %(upstream:track)' refs/heads
done

# --- 8.3 Locate the specifically-flagged artifacts ---
find ~ -name '.obsidian' -maxdepth 8 2>/dev/null            # Obsidian vault root
find ~ -iname '*TEGG*' -maxdepth 8 2>/dev/null              # TEGG work
find ~ -ipath '*n8n*' -name '*.json' -maxdepth 8 2>/dev/null # n8n exports
grep -ril "Orchestration and Responsibility" ~ 2>/dev/null   # the missing doc
find ~ -name '005*.sql' -o -name '0005*.sql' 2>/dev/null     # migration 005

# --- 8.4 Confirm whether Obsidian vault / n8n dirs are under Git at all ---
# (run from inside each candidate directory)
git -C <candidate-dir> rev-parse --is-inside-work-tree 2>/dev/null || echo "NOT IN GIT"
```

---

## 9. Prioritized preservation plan

Ordered by *irreplaceability* — what, if lost right now, would destroy unique AWE
work that exists nowhere else.

### P0 — Unique, unbacked, loss is unrecoverable. Do today.

1. **Obsidian Persistent Cognition vault.** Confirmed absent from all 11 branches
   and from this host. A vault is authored thinking — it cannot be regenerated
   from code. Locate it (§8.3), then get it into version control or an encrypted
   backup *before anything else*:
   ```bash
   cd <vault-path>
   git init && git add -A && git commit -m "Preserve Persistent Cognition vault"
   # then create a PRIVATE remote and:  git push -u origin main
   ```
   If the vault contains sensitive notes, back up to encrypted storage instead of
   a hosted remote — but back it up *now*, either way.

2. **The tested TEGG implementation and TEGG handoffs.** Zero occurrences of
   "TEGG" anywhere in this repository. "Tested" means the test evidence is unique
   too. Locate (§8.3) and push to a remote, or commit to a new private repo.

3. **Any dirty working tree or stash on the Mac.** Uncommitted changes are the
   most fragile state in Git. Run §8.2, and for every repo reporting dirt:
   ```bash
   git -C <repo> add -A
   git -C <repo> commit -m "WIP: preservation checkpoint $(date +%F)"
   git -C <repo> push -u origin HEAD
   ```
   Convert stashes to branches per §7.3.

4. **Full mirror backup before any cleanup.** Run §7.4 on every Mac repo found.
   This is cheap and makes every later step reversible.

### P1 — Unique but partially reconstructible, or unclear location. This week.

5. **n8n workflow exports.** No export JSON is tracked on any branch, yet n8n is
   central to the design (referenced in 42–61 files). Live workflows in an n8n
   instance are a single-instance-failure away from gone. Export and commit:
   ```bash
   # export from n8n UI/CLI, then:
   mkdir -p integrations/n8n && cp <exports>/*.json integrations/n8n/
   git add integrations/n8n && git commit -m "Preserve n8n workflow exports"
   ```

6. **"Orchestration and Responsibility Plane" document.** Zero exact-phrase hits
   across all branches. Either it is Mac-local (find it via §8.3 and commit it),
   or the concept lives under different naming in
   `AGENT_HARNESS_DOCTRINE.md` / `UBIQUITOUS_LANGUAGE.md` — confirm which, so it
   is not silently lost to a naming mismatch.

7. **Clarify what "Migration 005" refers to.** The repo's `0005_storage_photos.sql`
   is safe on all branches. If you meant a different `005`, it is not here — see
   §8.3 to search the Mac.

8. **Local test evidence / eval run outputs.** The harnesses are tracked; their
   *outputs* are not. If any eval run constitutes acceptance evidence you'd need
   to reproduce, archive those outputs deliberately.

9. **Local documentation outside `docs/`.** Anything authored on the Mac and
   never committed. §8.2's `--porcelain -uall` output will reveal it.

### P2 — Already durable on GitHub; needs integration, not rescue. Next.

10. **Open a PR for `feat/kernelized-mcp-context` → `main`.** It is the base of
    the entire five-branch codex stack (PRs #4→#5→#6→#7 all chain onto it) and
    currently has no integration path. The code is safe; the *stack* is stranded.

11. **Resolve the `0016` migration collision** before merging anything.
    `0016_drop_undeclared_client_policies.sql` and
    `0016_m365_integration_plane.sql` both claim slot `0016`, and
    `security/phase-1-remediation` re-solves C1 under timestamp naming
    (`20260727142118_…`). Follow the existing
    `docs/planning/MIGRATION_HISTORY_RECONCILIATION_PLAN.md` and ADR
    `0009-competing-c1-migration-artifacts.md`. Renumber the M365 migration to
    `0017` (or adopt timestamp naming repo-wide) and pick one C1 implementation.

12. **Decide the fate of `chore/agent-handoff-integration`** (6 commits, PR #1
    closed unmerged). It is pushed and safe but orphaned — either reopen a PR or
    explicitly retire it so it is not mistaken for live work.

13. **Add key-name-only `.env.example` templates** for `apps/web`,
    `packages/mcp-server`, and `packages/m365`, so configuration *shape* survives
    even though values correctly never enter Git.

### P3 — Housekeeping. No urgency.

14. `claude/awe-preservation-audit-iuq4k6` (local, no upstream) is identical to
    `main` and carries no unique work. Its remote counterpart was pruned during
    this audit. Safe to ignore or delete once this report is pushed.

15. Once P0–P1 are complete, re-run §8.2 and diff against this report to confirm
    the exposure is actually closed.

---

## 10. Commands executed during this audit (all read-only)

`uname`, `hostname`, `ls`, `find`, `cat`, `git remote -v`, `git rev-parse`,
`git log`, `git status`, `git branch`, `git for-each-ref`, `git stash list`,
`git worktree list`, `git reflog`, `git fsck`, `git config --get-regexp`,
`git ls-tree`, `git grep`, `git diff --stat`, `git diff --name-status`,
`git merge-base --is-ancestor`, `git rev-list`, and one
`git fetch origin --prune`.

`git fetch` is additive: it creates remote-tracking refs and cannot alter or
delete local commits, branches, stashes, or working-tree files. The prune line
`- [deleted] (none) -> origin/claude/awe-preservation-audit-iuq4k6` reflects a
branch already removed **server-side**; the local branch of that name was
untouched and still exists at `dbf8f17`.

**No clean, reset, rebase, merge, checkout of another branch, deletion, or file
modification was performed. No branch was pushed. No secret values are recorded
in this report.**
