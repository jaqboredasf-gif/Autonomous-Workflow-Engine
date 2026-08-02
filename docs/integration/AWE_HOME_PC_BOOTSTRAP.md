# AWE Home PC Bootstrap

**Date:** 2026-08-01 · Verified on Windows 11 Home 10.0.26200, drive `C:` only.
**Status: the PC can develop and test AWE offline today. It cannot run databases yet.**

---

## Workspace layout

```
C:\AWE\repos\Autonomous-Workflow-Engine   ← the clone (outside OneDrive, deliberately)
C:\AWE\vault                              ← Obsidian vault target (empty — MacBook-local)
C:\AWE\exports                            ← n8n exports target (empty)
C:\AWE\evidence\runs-2026-08-01\          ← captured runner output
C:\AWE\backups\LIPPOLIS-2026-08-01\       ← the pre-Git Windows work, 15 files
```

Repositories are kept **out of OneDrive**: a synced folder plus a `.git` index plus `node_modules`
invites index corruption, file locks, and slow I/O.

## Toolchain — verified 2026-08-01

| Tool | Required | Installed | Verdict |
|---|---|---|---|
| Node | `engines.node >= 20` | **24.18.1** | ✅ |
| npm | workspaces | **11.16.0** | ✅ |
| Git | — | 2.55.0.windows.2 | ✅ |
| GitHub CLI | — | 2.97.0, authenticated as `jaqboredasf-gif` | ✅ |
| Python | TEGG scripts only | 3.12.10 | ✅ (not needed here) |
| pnpm | **not required** | 11.18.0 (harmless) | ⚠ unnecessary — see below |
| WSL2 | Docker prerequisite | installed, **no distribution** | ⚠ |
| Docker Desktop | isolated DB replay | 4.84.0 installed, **daemon down** | ❌ |
| `jq` | `scripts/smoke-mcp.sh` | **not installed** | ❌ |

### Correction to earlier bootstrap guidance

The project uses **npm workspaces**, not pnpm. There is no `pnpm-workspace.yaml` and no
`packageManager` field; there is a `package-lock.json`.

```bash
npm ci
```

`corepack enable` is **not needed** and the global pnpm is unnecessary. Do not run
`pnpm install --frozen-lockfile` against this repository.

## Clone and check out

```bash
git clone https://github.com/jaqboredasf-gif/Autonomous-Workflow-Engine.git C:\AWE\repos\Autonomous-Workflow-Engine
```

```bash
git fetch --all --tags --prune
```

```bash
git checkout -b codex/durable-execution-plane --track origin/codex/durable-execution-plane
```

That branch is the integration baseline: +33/−8 vs `main`, and the only one carrying all six
`awe-*` packages. `main` carries none of the platform work.

## Baseline verification

```bash
bash scripts/regression.sh --dry-run
```

```bash
bash scripts/regression.sh --kinds=unit,offline,static
```

Expected: **`regression: ALL GREEN [13 ran, 12 skipped]`**, exit 0, 3,212 assertions across 11
runners plus the two migration linters. Actual output from 2026-08-01 is in
`C:\AWE\evidence\runs-2026-08-01\`.

```bash
node scripts/validate-context.mjs
```

```bash
bash scripts/eval-context-validator.sh
```

## Two remaining human steps

**1. Start Docker Desktop once.** WSL2 is installed but has no distribution; Docker Desktop creates
its own `docker-desktop` distro on first launch. Until then `docker version` reports a client and no
daemon, and every DB-kind suite stays blocked.

**2. Install `jq`** — the only reason `mcp-smoke` fails here:

```bash
winget install jqlang.jq
```

## Known local results, recorded honestly

- `npm ci` succeeds and reports **17 vulnerabilities (12 moderate, 5 high)**, plus 2 packages with
  install scripts not covered by `allowScripts` (`sharp`, `unrs-resolver`). Not triaged.
- `eval-classification` (Runner 2A) **fails closed** without `SUPABASE_ACCESS_TOKEN`. That is correct
  behaviour, not a defect.
- `core.autocrlf=true` makes `packages/mcp-server/src/index.js` show as modified after a runner reads
  it, while the worktree and index blob hashes are identical. Cosmetic; do not "fix" it by committing.

## Alignment status

**Not aligned.** Achieved: repository, branches, dependencies, offline baseline, cognition layer.
Outstanding: Docker, `jq`, credentials for the 12 gated suites, and every MacBook-only artifact
(vault, n8n exports, Supabase identity, real `.env` shape). See `AWE_HOME_PC_PARITY_REPORT.md`.
