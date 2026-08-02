# Latest Agent Handoff

**Date:** 2026-08-01
**Branch:** `feat/persistent-cognition-compiler`
**Commit:** `53b8f7f` — the preservation commit; the compiler commit follows it on this branch
**Evidence baseline:** `55c0ba5` — the durable-execution tip this branch was cut from
**Session role:** Builder + Documentarian (Windows home PC, `C:\AWE\repos\Autonomous-Workflow-Engine`)

---

## What was built

The **AWE Context Compiler** — the cognition layer is no longer a static set of documents; it is a
capability that assembles them. A human-defined objective now compiles into a bounded execution
packet so an agent begins from repository evidence instead of reconstructing AWE from conversation.

```bash
npm run context:compile -- --objective "Resolve the 0016 migration identity collision" --task-id AWE-INT-101 --output .awe/packets/AWE-INT-101
```

```bash
npm run context:check
```

**Placement:** `scripts/lib/context-compiler/` — repo tooling, no new package. The pure core has no
I/O; `fs-sources.mjs` isolates every filesystem and Git call, so moving behind a service replaces one
module. Reasoning and precedent are in [CRITICAL_DECISIONS.md](CRITICAL_DECISIONS.md).

## What was verified — exact results

| Suite | Result |
|---|---|
| Runner V — context validator | **45 / 0** PASS |
| Runner CC — Context Compiler | **114 / 0** PASS |
| `node scripts/validate-context.mjs` | **PASS** — 0 errors, 7 warnings |
| `npm run context:check` | **PASS** — 0 staleness errors, 31 warnings |
| `bash scripts/regression.sh --kinds=unit,offline,static` | **`ALL GREEN [13 ran, 12 skipped]`**, exit 0 |

Platform runners unchanged: K 582 · M 420 · E 376 · P 372 · 5 349 · 4 327 · D 309 · C 138 · A 127 ·
3 121 · Y 91. **Total 3,371 assertions, 0 failures.** Raw output in `C:\AWE\evidence\runs-2026-08-01\`.

Three real packets were generated and inspected: `AWE-INT-101` (migration identity), `AWE-INT-102`
(M365 merge risk), `AWE-INT-103` (n8n recovery). Each selected 63 sources from 249 records — 23
mandatory, 40 topical — and each surfaced a different, correct top-ranked source. Packet 103
correctly reports **n8n as an absent topic** rather than returning an empty section.

## Two real defects the work surfaced and fixed

1. **Path tags were being lower-cased**, so `docs/architecture/AGENT_RUNTIME.md` was reported as a
   missing file. Filesystem paths are case-bearing; only the matching surface is folded now.
2. **Any 7–40 char hex token was read as a commit**, so the n8n workflow id `e0d2b551` produced a
   confident, wrong staleness warning. A token now counts as a commit only when it is a full 40-char
   SHA or the surrounding text labels it. `context:check` additionally distinguishes an ancestor
   commit, a commit on another branch, a blob hash, and a hash naming no object at all — and treats
   an *added* file as unable to invalidate a claim about existing ones.

Both were found by running the tool against the real repository, not by inspection.

## What remains unknown

Unchanged from the previous handoff: applied-migration state · Supabase project identity · n8n
instance state · whether the Orchestration & Responsibility Plane exists anywhere · the source of
the "145 database checks" and "61 orchestration tests" figures (both still `REPORTED_NOT_VERIFIED`) ·
live Microsoft Graph behaviour (`MOCK_ONLY`).

New and specific to this work: `fs-sources.mjs` is `PARTIALLY_VERIFIED` — it is exercised by the CLI
runs but not by Runner CC, which is deliberately pure.

## Files changed

**Created:** `scripts/lib/context-compiler/{contract,records,adapters,select,compile,fs-sources}.mjs` ·
`scripts/context-compile.mjs` · `scripts/context-check.mjs` ·
`scripts/eval-context-compiler.{mjs,sh}` · `docs/integration/dispatch/TASK_FORMAT.md` ·
`docs/integration/dispatch/tasks/AWE-INT-10{1..6}.md`

**Modified:** `package.json` (four `context:*` scripts — the root had none) · `.gitignore` (`.awe/`) ·
`context/{AWE_CURRENT_STATE,AWE_SYSTEM_MAP,ACTIVE_CAPABILITY_SPECIFICATION,CRITICAL_DECISIONS,VERIFIED_EVIDENCE,AWE_UBIQUITOUS_LANGUAGE,LATEST_AGENT_HANDOFF}.md` ·
`docs/integration/{AWE_ASSET_INVENTORY,AWE_EVIDENCE_LEDGER,AWE_COMPONENT_GRAPH,AWE_INTEGRATION_PLAN,AWE_LATEST_HANDOFF}.md` ·
`docs/integration/dispatch/QUEUE.md`

**Restored:** `packages/mcp-server/src/index.js` — the CRLF-only worktree entry from the previous
session. Worktree and index blob hashes were identical (`1463386…`) and the diff was zero bytes, so
`git checkout --` discarded nothing.

## Next safest bounded task

**`AWE-INT-101`** — resolve the three-way `0016` migration-identity collision on paper, touching no
migration file. Its dispatch task is `docs/integration/dispatch/tasks/AWE-INT-101.md`, and its packet
compiles with the command in that file.

Two minute-scale unblockers for a human: launch Docker Desktop once (WSL2 is installed but has no
distribution), and `winget install jqlang.jq` (the only reason `mcp-smoke` fails).

## What remains on the MacBook

Obsidian vault · n8n exports (WF1–WF10, 309, 310, both WF8 variants) · Supabase project identity and
applied-migration state · real `.env` shape · saved evidence behind the 145/61 figures · the
Orchestration & Responsibility Plane if it exists. TEGG is preserved separately in the private
`TRANSCEND` repo and is out of scope.

## What was intentionally not executed

No push · no merge, rebase, reset, force push, or branch deletion · no PR opened or modified · no
commit to `main` · no migration created, modified, or applied · no database contacted · no Docker
container started · no Microsoft Graph call · no n8n contact or activation · no email · no credential
opened, printed, or committed · no repository visibility change · no file deleted · the M365 branch
was never checked out · `TRANSCEND` was not cloned or modified · the historical LIPPOLIS files and
their backup were not touched · the `0016` collision was **analysed but not resolved**, per scope ·
the Orchestration Plane was **not** reconstructed — it is reported absent · no Agent Runtime
integration was begun.
