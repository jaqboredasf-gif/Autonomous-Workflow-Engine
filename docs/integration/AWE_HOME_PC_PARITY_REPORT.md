# Home PC Parity Report

**Date:** 2026-08-01 · `codex/durable-execution-plane` @ `55c0ba5`
**Machine:** Windows 11 Home 10.0.26200 · **Reference:** the MacBook (not directly observable)

**Verdict: the home PC has full parity for the offline platform surface, and none for anything that
needs a database, a credential, or a local-only artifact.**

An honest caveat: parity is normally measured by diffing this machine's output against saved
source-machine evidence. **No saved MacBook evidence exists.** So the right-hand column below is what
the repository and the earlier handoff assert, not what was observed on the Mac.

---

## 1. Repository parity ✅

| Item | Home PC | Reference | Parity |
|---|---|---|---|
| Clone | full, 12 remote branches, no tags | same remote | ✅ |
| Baseline branch | `codex/durable-execution-plane` @ `55c0ba5` | tip of the stack | ✅ |
| Stack ancestry | 4 predecessors confirmed ancestors | asserted | ✅ verified independently |
| Working tree | clean | — | ✅ |
| Local-only commits | none | — | ✅ |

## 2. Toolchain parity ✅ with one correction

| Item | Home PC | Required | Parity |
|---|---|---|---|
| Node | 24.18.1 | `>= 20` | ✅ |
| Package manager | npm 11.16.0 + `npm ci` | npm workspaces | ✅ |
| pnpm | 11.18.0 present | **not required** | ⚠ harmless surplus |
| `npm ci` | succeeds | — | ✅ |

The earlier handoff's pnpm requirement was wrong for this repository. Corrected in
`AWE_HOME_PC_BOOTSTRAP.md`.

## 3. Test parity — the offline surface is at full parity ✅

| Runner | Home PC 2026-08-01 | Handoff claim | Parity |
|---|---|---|---|
| A — agent runtime | **127 / 0** | 127 / 0 | ✅ **exact** |
| Y — memory layer | **91 / 0** | 91 / 0 | ✅ **exact** |
| K — kernel | **582 / 0** | 577 / 0 | ⚠ suite grew by 5; claim superseded |
| D — durable execution | 309 / 0 | not quantified | ✅ new baseline |
| M — MCP surface | 420 / 0 | not quantified | ✅ new baseline |
| E — execution outcomes | 376 / 0 | not quantified | ✅ new baseline |
| P — control plane | 372 / 0 | not quantified | ✅ new baseline |
| 5 / 4 / 3 | 349 / 327 / 121, all 0 failed | not quantified | ✅ new baseline |
| C — context primitives | 138 / 0 | not quantified | ✅ new baseline |
| V — context validator | 45 / 0 | new this session | ✅ |
| **Aggregate** | **`regression: ALL GREEN [13 ran, 12 skipped]`**, 3,212 assertions | "offline regression: 11 suites green" | ✅ **consistent** |

Reproducing 127 and 91 exactly, on a different machine and OS, is strong evidence the offline suites
are genuinely deterministic and provider-neutral — the property Runner D asserts about itself.

## 4. Where parity does not exist ❌

| Capability | Home PC | Blocker |
|---|---|---|
| Isolated database replay | ❌ | Docker daemon down; WSL2 has no distribution |
| `acceptance-slice1`–`5`, `s1-security`, `eval-intake`, `eval-classification` | ❌ | `SUPABASE_ACCESS_TOKEN` absent |
| `eval-mcp-live` (M-LIVE) | ❌ | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AWE_ORG_ID` absent |
| `mcp-smoke` | ❌ **FAILED** | `jq` not installed |
| Live Microsoft Graph proof | ❌ | never existed anywhere — `docs/integrations/BLOCKED_LIVE_PROOF.md` |
| n8n workflows | ❌ | no export tracked in Git; instance state unknown |
| Obsidian vault | ❌ | MacBook-local, 0 hits across 12 branches |
| Applied-migration truth | ❌ | Supabase project identity unknown |
| Real `.env` shape | ❌ | correctly gitignored; only `apps/mobile/.env.example` is tracked |

## 5. What the MacBook still holds that nothing else does

1. **Obsidian Persistent Cognition vault** — the `context/` directory created this session is a
   Git-backed replacement, but the vault's own content has never been compared to it.
2. **n8n workflow exports** — WF1–WF10, Evaluator 309, Planner 310, and WF8 in two variants
   (`e0d2b551` live/ungated, `22d83e67` hardened). Highest operational risk.
3. **Supabase project identity** and the applied-migration list.
4. **Real `.env` files** — values must never leave a secret store, but key-name-only templates should
   be committed.
5. **Saved evidence** behind "145 database checks" and "61 orchestration tests" — both currently
   `REPORTED_NOT_VERIFIED`.
6. **The Orchestration & Responsibility Plane**, if it exists at all.

## 6. Alignment criteria

| Criterion | Status |
|---|---|
| Required repositories and branches exist locally | ✅ |
| Dependencies install | ✅ `npm ci` |
| Baseline tests understood and reproduced | ✅ 3,212 assertions, ALL GREEN |
| Local database starts | ❌ Docker |
| Canonical migrations can be evaluated | ⚠ lint-only; replay blocked |
| Context files present | ✅ `context/` created + validated |
| Workflow exports present | ❌ |
| No unexplained dirty changes | ✅ (one CRLF entry, identical blob hashes) |
| Secret handling verified | ✅ no secret in tracked files; validator scans `context/` each run |

**Two of nine outstanding, both blocked on things a human can clear in minutes** (start Docker
Desktop; export the n8n workflows).
