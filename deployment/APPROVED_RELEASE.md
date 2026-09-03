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

- **Commit**: `585b749`
- **Full**: `585b749ee54d087716cf78c69928afbc735affa9`
- **Branch**: `pcc-production`
- **Date**: 2026-09-03
- **Subject**: Refuse to authorise a vendor email that is addressed to nobody

### Why the candidate moved from `e69827a`

`e69827a` (2026-08-31) was proposed and never signed. Thirty commits have landed since, and one of
them is the reason this record was refreshed rather than left alone: **a purchase order could be
recorded as emailed to a vendor who has no email address.** For a supply-house counter account the
draft was composed with an empty recipient list, could be reviewed, approved to send and marked
SENT, and the request advanced to ORDERED — leaving an audit trail stating a vendor had been
contacted when none had. It would have fired on a real order, on a real job, in the first weeks.
Installing `e69827a` would install that defect. See `docs/planning/DECISION_LOG.md`, 2026-09-03.

The other twenty-nine are the Windows deployment line, second-organization provisioning, the
evidence and discovery programs, and per-job-vendor PO numbering. None of them changes the schema:
the migration sequence is unchanged at `0001`–`0038` with no gaps and no duplicate numbers, and the
SQLite schema version is unchanged at `0040-audit-interaction-id`.

## Why this commit and not another

Chosen from repository state, not by recency. Every line below is checkable by running the command
beside it. Figures are from a full sweep at `585b749` on 2026-09-03.

| Criterion | State | How to check |
|---|---|---|
| Commit exists on a remote | yes — `pcc-production` and `backup/purchasing-control-center-2026-09-03` | `git ls-remote origin pcc-production` |
| Working tree clean at the commit | yes | `git status --porcelain` — empty |
| Offline test suites | **33 suites, 0 failures** (5 more refuse to report a pass without credentials; 2 more need the running server and pass inside `npm run rehearse`) | run every `scripts/eval-*.mjs` |
| Type checking | clean | `npx tsc --noEmit -p apps/purchasing/tsconfig.json` |
| Migration sequence | `0001`–`0038`, no gaps, no duplicate numbers | `ls supabase/migrations` |
| Schema version | `0040-audit-interaction-id` — applied on startup, idempotent | `scripts/eval-purchasing-domain.mjs` |
| Production artifact builds and is safe to ship | yes — 597 files examined, no database, no journal, no secret | `npm run build --workspace purchasing` runs `check-deployable.mjs` |
| The application installs, runs, restarts, persists | yes, on this platform — 42 cold-start + 11 idempotency checks | `npm run rehearse` |
| Evidence identity fails closed | yes | `scripts/eval-evidence-provenance.mjs` (55) and `scripts/eval-startup-refusal.mjs` (130) |
| Windows deployment contract | consistent (174) | `scripts/eval-windows-deployment.mjs` |
| Release packaging self-check | 48 passed, 0 failed | `scripts/eval-release-package.mjs` |
| Deployment gate | `BUILD_ONLY` — one AWE-owned blocker, which is this signature | `npm run deployment-gate` |

### What this commit is NOT proven to do

**No PCC installation has ever been performed on Windows Server.** The Windows tooling is covered by
its own offline suite and the application by a local rehearsal on macOS/Linux. What the first
supervised installation on RDS02 proves is the *server*: the service, IIS, the scheduled backup
task, and reboot recovery. `deployment/adapters/windows-service.mjs` stays `proven: false` until
that has happened, and flipping it is step 22 of the execution package.

**No purchase has ever run through PCC in production.** `npm run readiness` reports
`usage: 0 executions, 0 active days`. Everything proven above is rehearsal and offline evidence.
This candidate is REHEARSAL VERIFIED, not LIVE VERIFIED, and nothing in this repository can raise
that — only a real purchase on the real server can.

---

## Before installing this commit

1. Build the package from **exactly this commit**, on a clean tree:
   ```bash
   git checkout 585b749
   npm run build --workspace purchasing
   node scripts/package-release.mjs
   ```
   This produces `dist/PCC-585b749.zip` and its `.sha256`. The packager refuses a dirty tree
   and refuses a build older than the commit, so the label cannot disagree with the box.
2. Copy both files to the server and verify the hash **before extracting**.
3. Follow `docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md` §1.

### Reference hash — compare, do not trust

A build of `585b749` performed on 2026-09-03 produced:

```
PCC-585b749.zip   1651 files   13,230,298 bytes
sha256  37f0bda3b5ff83acd78603345a066a4f6d364c244451478d8a09812f5e98f286
```

This is recorded so a second, independent build can be compared against it — that comparison is the
check. It is **not** a substitute for building the package yourself, and it is deliberately not
written into the approval block below.

---

## Approval

Filling in the two fields below is what makes this an approved release. Leave them blank until the
decision is actually made — an unsigned record is not an approval, and the gate treats it as one.

- **Approved by**: ________________________
- **Date**: ________________________
- **Package sha256** (from the build above): ________________________________________________
- **Deviations from the candidate above, if any**: ______________________________________

Once signed, set `PCC_RELEASE=585b749` in the server's environment file so `/api/health`
reports the build that is actually running.
