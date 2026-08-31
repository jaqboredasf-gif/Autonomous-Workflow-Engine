# The commit approved for installation on LIPELE-RDS02

**Status: A CANDIDATE IS PROPOSED. NOBODY HAS APPROVED IT.**

`PCC_VM_INSTALLATION_RUNBOOK.md` §Step 5 requires a specific commit or tag —
*"deploy a specific commit or tag, never a moving branch"* — recorded here, in the installation
record, and in `PCC_RELEASE` so `/api/health` reports which build is running.

Approval is a person's signature. This file is the evidence a person needs in order to give it, and
the deployment gate reads it: until **Approved by** is filled in, `application.version` is UNKNOWN
and the gate reports the deployment as BUILD_ONLY. Nothing here approves anything.

**The candidate goes out of date whenever work lands, and that is expected.** The gate reports how
many commits behind HEAD it is, and refuses a candidate that is not in this history at all. Deploying
a commit older than the tip is normal — deploying one that does not exist is a typo nobody would
catch on the day. Before signing, either refresh the commit below to the tip or state deliberately
that an older one is being installed.

---

## The candidate

- **Commit**: `e69827a`
- **Full**: `e69827a3b865b4c9497f50b6f6c0ecb13acb0313`
- **Branch**: `claude/purchasing-control-center`
- **Date**: 2026-08-31
- **Subject**: Refuse a first production start that would make the records unmeasurable, and build the artifact the runbook asks for

## Why this commit and not another

Chosen from repository state, not by recency. Every line below is checkable by running the command
beside it.

| Criterion | State | How to check |
|---|---|---|
| Working tree clean at the commit | yes | `git status --porcelain` — empty |
| Offline test suites | 26 suites, 0 failures | run every `scripts/eval-*.mjs`; 7 more need credentials or a live server and refuse to report a pass without them |
| Type checking | clean | `npx tsc --noEmit -p apps/purchasing/tsconfig.json` |
| Schema version | `0040-audit-interaction-id` — applied on startup, idempotent | `scripts/eval-purchasing-domain.mjs` |
| Production artifact builds and is safe to ship | yes | `npm run build --workspace purchasing` runs `check-deployable.mjs`: no database, no env file, no key |
| The application installs, runs, restarts, persists | yes, on this platform | `npm run rehearse` — 42 cold-start + 11 idempotency checks, restart, persistence |
| Evidence identity fails closed | yes | `scripts/eval-evidence-provenance.mjs` (55) and `scripts/eval-startup-refusal.mjs` (108+) |
| Windows deployment contract | consistent | `scripts/eval-windows-deployment.mjs` |
| Deployment gate | `BUILD_ONLY` | `npm run deployment-gate` |

### What this commit is NOT proven to do

**No PCC installation has ever been performed on Windows Server.** The Windows tooling is covered by
its own offline suite and the application by a local rehearsal on macOS/Linux. What the first
supervised installation on RDS02 proves is the *server*: the service, IIS, the scheduled backup
task, and reboot recovery. `deployment/adapters/windows-service.mjs` stays `proven: false` until
that has happened, and flipping it is step 22 of the execution package.

---

## Before installing this commit

1. Build the package from **exactly this commit**, on a clean tree:
   ```bash
   git checkout e69827a
   npm run build --workspace purchasing
   node scripts/package-release.mjs
   ```
   This produces `dist/PCC-e69827a.zip` and its `.sha256`. The packager refuses a dirty tree
   and refuses a build older than the commit, so the label cannot disagree with the box.
2. Copy both files to the server and verify the hash **before extracting**.
3. Follow `docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md` §1.

---

## Approval

Filling in the two fields below is what makes this an approved release. Leave them blank until the
decision is actually made — an unsigned record is not an approval, and the gate treats it as one.

- **Approved by**: ________________________
- **Date**: ________________________
- **Package sha256** (from the build above): ________________________________________________
- **Deviations from the candidate above, if any**: ______________________________________

Once signed, set `PCC_RELEASE=e69827a` in the server's environment file so `/api/health`
reports the build that is actually running.
