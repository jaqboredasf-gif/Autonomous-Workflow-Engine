# Agent Execution Packet

Two parts: a **reusable template**, then **one populated packet** for the next bounded task.
A packet is the minimum trustworthy context for one job. If a field does not apply, write `n/a` —
never delete the field, because the validator checks for it.

---

## Part 1 — Template

```markdown
## Task ID
AWE-INT-NNN

## Objective
One sentence. What is true after this task that is not true now.

## Current verified state
Branch, commit SHA, and the two or three facts from context/AWE_CURRENT_STATE.md this task depends
on. Cite evidence status for each.

## Relevant files
Explicit paths. Not directories, not "the codebase".

## Applicable decisions
ADR numbers from docs/architecture/decisions/ and rows from context/CRITICAL_DECISIONS.md.

## Applicable policies
Policy IDs from context/AGENT_OPERATING_POLICIES.md (P1–P16).

## Allowed scope
Files this task may create or modify. Everything else is out of bounds.

## Forbidden actions
Named, not implied. Always includes: push, merge, rebase, reset, force push, branch deletion,
remote migration, live provider call, outbound email, n8n activation, secret exposure.

## Required tests
Exact commands. Prefer `scripts/regression.sh --dry-run` first, then a bounded `--only=` or
`--kinds=` run.

## Required evidence
What output must be captured, and where it is written.

## Definition of done
Checklist. Each item independently checkable by the next session.

## Required handoff format
Update context/LATEST_AGENT_HANDOFF.md with: branch, commit, inspected, created, verified, unknown,
files changed, tests run with exact results, commands run, git status, next task, and an explicit
statement of what was intentionally not executed.
```

---

## Part 2 — Populated packet: the next bounded task

## Task ID
`AWE-INT-101`

## Objective
Produce a written, reviewable resolution for the three-way `0016` migration-identity collision —
**without modifying any migration file** — so that migration-touching integration can unblock.

## Current verified state
- Branch `codex/durable-execution-plane` @ `55c0ba5`, working tree clean. `VERIFIED` 2026-08-01.
- 16 migrations, 2,286 lines, 23 tables present as files. `VERIFIED` (files) / `UNKNOWN` (applied).
- Slot `0016` is claimed three ways across branches. `VERIFIED`.
- `scripts/regression.sh --kinds=unit,offline,static` is ALL GREEN, 3,212 assertions. `VERIFIED`.
- Docker is **not operational**, so no replay can validate the proposal. `LIVE_BLOCKED`.

## Relevant files
- `supabase/migrations/0016_drop_undeclared_client_policies.sql` (this branch, 80 lines)
- `supabase/migrations/0016_m365_integration_plane.sql` (`claude/microsoft-365-integration-plane-fcsm1e`, read via `git show`)
- `20260727142118_phase1_c1_remove_undeclared_policies.sql` and siblings `…142120_c2`, `…142121_c3`, `…142123_c4` (`security/phase-1-remediation`, read via `git show`)
- `docs/architecture/decisions/0009-competing-c1-migration-artifacts.md`
- `scripts/lib/validate-migration-0014.mjs`, `-0015.mjs` — the existing lint pattern to imitate
- `supabase/config.toml`

## Applicable decisions
ADR-0009 (the collision, `Proposed`, unresolved) · ADR-0002 (service-role access path) ·
`CRITICAL_DECISIONS.md` → "The migration-identity collision".

## Applicable policies
P2 (evidence over narrative) · P5 (no remote migration) · P6 (no destructive Git) · P9 (no
integration claim without tests) · P11 (do not invent architecture) · P14 (evidence per claim) ·
P15 (durable handoff).

## Allowed scope
Create **one** new file: `docs/planning/MIGRATION_IDENTITY_RESOLUTION.md`.
Update `context/VERIFIED_EVIDENCE.md` and `context/LATEST_AGENT_HANDOFF.md`.
**No file under `supabase/` may be created, modified, renamed, or deleted.**

## Forbidden actions
Modifying any migration · `supabase db push` or any remote/shared database contact · applying a
migration in any environment · push, merge, rebase, reset, force push, branch deletion · checking
out the M365 or phase-1 branches (read them with `git show` instead) · guessing which naming scheme
is canonical — present options, let a human ratify.

## Required tests
```bash
bash scripts/regression.sh --dry-run
bash scripts/regression.sh --only=validate-migration-0014,validate-migration-0015
```
Both must still pass; this task must not disturb them.

## Required evidence
- A three-column diff of what each competing artifact actually does to policy objects, obtained via
  `git show <branch>:<path>` — no checkout.
- Whether the two C1 implementations are semantically identical, overlapping, or divergent.
- Runner output for the two validators, captured to `C:\AWE\evidence\runs-2026-08-01\`.

## Definition of done
1. `docs/planning/MIGRATION_IDENTITY_RESOLUTION.md` exists and states: the identity scheme options
   (sequential ordinals vs Supabase timestamps), the consequence of each for all three artifacts,
   a recommended option with reasoning, an explicit rollback, and the named human decision required.
2. Every claim in it cites a file path and a branch or commit.
3. `git status --short` shows only that new file plus the two context updates.
4. `validate-migration-0014` and `-0015` still pass.
5. `context/VERIFIED_EVIDENCE.md` records the analysis with a status.
6. `context/LATEST_AGENT_HANDOFF.md` is updated per P15.
7. **No migration file changed** — verifiable with `git status --short supabase/`.

## Required handoff format
Per the template above, plus an explicit line: *"No migration was created, modified, or applied in
any environment."*
