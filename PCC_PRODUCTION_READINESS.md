# PCC — production readiness scorecard

**Dated 2026-08-14.** Supersedes the 2026-08-13 edition, which was written mid-session and is
wrong in one place: it recorded "sign-in will not persist over plain HTTP" as *expected behaviour,
not a defect*. It was a defect, it is fixed, and how that was missed is worth keeping — see
§Corrections.

Three statuses:

- **GREEN** — done, and proven by something that runs. The evidence column says what.
- **YELLOW** — the software is finished and tested; a Lippolis input, decision or live validation
  is still outstanding.
- **RED** — a missing capability that blocks independent operation.

Nothing optional is recorded as a blocker.

---

## Scorecard

| Area | Status | Evidence | Remaining blocker |
|---|---|---|---|
| **Core purchasing workflow** | GREEN | 551 integration checks (local + deferred providers); 31 cold-start checks driving request → approve → PO → print → email draft → ordered → receive → history against a production build and an empty database | none |
| **PO numbering** | GREEN | Rule is a named strategy behind `PoNumberStrategy`; the screen prints what the allocator returns rather than assembling it. Sequence continuity proven across a process restart (`PCC_EXPECT_PO_SEQUENCE=2`) and across a full backup/restore (`sequence is still at 405`) | Paper pairs must be set in Administration before the first live order on them — business data entry, not engineering. `pcc-verify-production.mjs` lists every unresolved pair |
| **Authorization** | GREEN | 379 authorization checks; cold-start run confirms a requestor is refused administration and the review screen, and an unauthenticated request is redirected | none |
| **Tenant isolation** | YELLOW | 174 isolation checks pass (static + application). RLS proven on local Postgres | RLS on a *hosted* Supabase project is NOT PROVEN — none configured or touched. Irrelevant to the Lippolis SQLite pilot; matters before any hosted multi-tenant deployment |
| **Database durability** | GREEN | Backup taken while running, database deleted outright, restored, same PO and quantities served; attachments byte-for-byte identical. Idempotence run: four repeat deployments, non-destructive across all four, including the dangerous case of leaving `PCC_DATABASE_ALLOW_CREATE=1` set | none |
| **Migrations** | GREEN | Applied on start, idempotent, version reported at `/api/health` as `schema`. Upgrades verified from `0016` and from `0001-ancient` to `0038` | none |
| **Production build** | GREEN | `npm run build -w purchasing` clean. `postbuild` stages `.next/static` + `public` **and** runs `check-deployable`, so no build path can ship a database, key or `.env`. Verified both directions: a build with a developer database present fails, a clean one passes | none |
| **Startup safety** | GREEN | 50 startup-refusal checks. Nine misconfigurations each exit 1 **and leave no database file**; a control proves a correct start still works | none |
| **VM restart survival** | YELLOW | Process killed and restarted against the same database: data intact, sequence continued, log says `opening the existing purchasing database`. Both systemd units supplied, with `Restart=on-failure` and `RestartPreventExitStatus=1` so a refusal does not restart-loop | Nobody has run `systemctl enable` on the actual VM and rebooted it. Needs the VM |
| **Stable URL readiness** | YELLOW | Reverse-proxy shape documented; `APP_BASE_URL` required in production; no localhost default survives a production start. Cookie `Secure` now follows the URL scheme, and both HTTPS and acknowledged-plain-HTTP are tested | Hostname, DNS and TLS ownership are Lippolis's (§11.1 of the handoff) |
| **Printing** | GREEN | Approving lands on the PO with the print dialogue open; print stylesheet; deterministic hand-written PDF stored as evidence and re-served after restore. Needs no driver, address or credential | Direct-to-workshop-printer is deliberately absent. Not a blocker — see handoff §13 |
| **Vendor email** | GREEN *(as designed)* | PCC composes a draft and **cannot** send: `externalSendEnabled` is `false` in the port type and pinned false by a database constraint. Draft workflow (reviewed → approved → sent) tested in the cold-start and restore runs | Nothing. Sending is a decision Lippolis has not asked for; the seam is ready if they do |
| **Authentication** | YELLOW | Local accounts with scrypt, `HttpOnly`/`SameSite=Lax`/scheme-correct `Secure` cookies, throttled at 5 failures per address per 15 minutes, bootstrap admin created once and never printed. Sign-in proven to stick over plain HTTP by the control | Per-process throttle only (one instance is the supported shape). No MFA/SSO — needs the Entra decision |
| **Logging** | GREEN | JSON to stdout, collected by journald or Docker; `[pcc]` prefix on startup lines. The refusal message distinguishes "nothing was written" from "the database was opened", which sends the operator to different places. Bootstrap password proven absent from the log on both a refusal and a success | none |
| **Deployment docs** | GREEN | `docs/deployment/PCC_IT_DEPLOYMENT_HANDOFF.md` — install, configure, migrate, start, supervise, update, roll back, back up, restore, diagnose; required-before-launch separated from can-wait; ownership stated as roles | none |
| **AWE reuse seam** | YELLOW | 29 redeployability checks. Instance data confined to `bootstrap.ts` and `seed.ts`; numbering is a named strategy selected by id and refused when unimplemented; capability profile honoured for 9 fields fully, 6 partially | 2 fields hard-coded, and a second company (`org-002`) would need engineering for 8 profile fields — `terminology.stock_location`, `request_noun`, `po_separator`, `quantity_rule`, `default_fulfilment_days`, `overdue_rule`, `documents.po_template`, `communications.send_mode` |
| **Live Lippolis validation** | RED | Nothing has run on Lippolis hardware. Every result above is from this machine | The VM. This is the only RED, and it is not an engineering gap |

**Totals: 10 GREEN · 6 YELLOW · 1 RED.**

---

## Corrections to the previous edition

**Row 17 said sign-in over plain HTTP failing was "expected behaviour, not a defect."** That
sentence is how a defect survives a review: it is true of the code and wrong about the product.
`Secure` was read off `NODE_ENV` — a fact about the build — while the thing that matters is the
scheme of the address people type. A production deployment on `http://` therefore accepted every
sign-in and returned the person to the sign-in page, permanently, for everybody, while
`/api/health` reported 200 and the log said ready. The only symptom would have been Mike unable to
get in on the first morning, with every check green.

It is now the scheme that decides, so plain HTTP works — and because it works by putting session
cookies on the wire in clear text, PCC refuses to start until somebody records that decision with
`PCC_ALLOW_INSECURE_HTTP=1`. Both states are tested, including one assertion that follows a
signed-in request to a protected page and checks the answer is not the sign-in page again.

**The previous edition also listed four suites as "not run here, needing a container host."** They
have now all been run: `eval-clean-machine.sh`, `eval-idempotence.sh`, `eval-restore-rehearsal.mjs`
and the Docker deployment lifecycle. All pass.

---

## What this session found by running the repository

Each of these was found by executing something, not by reading it.

1. **`preview` was called without `await` at three call sites.** Both allocator implementations
   answer immediately, so it looked fine — but the deferred-provider gate makes every port member
   answer late, and there the administration screen rendered a `Promise` where the next purchase
   order number goes, and an error message read `[object Promise]` in the one place whose job is to
   tell an administrator which numbers are already on a supplier's paperwork.

2. **`check-deployable` ran only in the Dockerfile.** The plain-Node path — `deploy/pcc-node.service`,
   the one for a VM without a container runtime — had it as a line in a comment that a person could
   skip. It now runs from `postbuild`, so it is on every path. A check is worth nothing on the path
   that bypasses it.

3. **Nothing started PCC wrong.** Every suite here started it correctly and asked whether it worked.
   The expensive failure is not PCC stopping — supervision sees that — it is PCC carrying on
   against a database nobody meant to create. `eval-startup-refusal.mjs` now starts the packaged
   server with nine wrong configurations and asserts, per case, that it exits 1 **and that no
   database file exists afterwards**.

4. **The `Secure` cookie defect**, above.

---

## Test results, this machine, this session

| Suite | Result |
|---|---|
| `tsc --noEmit` | clean |
| `eval-purchasing-domain` | 493 passed, 0 failed |
| `eval-workflow-engine` | 235 passed, 0 failed |
| `eval-purchasing-authorization` | 379 passed, 0 failed |
| `eval-purchasing-isolation` | 174 passed, 0 failed |
| `eval-purchasing-providers` | 321 passed, 0 failed |
| `eval-purchasing` | 551 passed, 0 failed (local + deferred) |
| `eval-purchasing-web` | 115 passed, 0 failed (production build) |
| `eval-startup-refusal` **(new)** | 50 passed, 0 failed |
| `eval-deployment-core` | 117 passed, 0 failed |
| `eval-purchasing-redeployability` | 29 passed, 0 failed |
| `eval-production-coldstart` | 30, then 31 across a restart |
| `eval-idempotence.sh` (Docker) | PASS — four repeat deployments, non-destructive |
| `eval-clean-machine.sh` (Docker) | PASS — build + full backup/restore lifecycle from repository content only |
| `check-deployable` | PASS clean; FAILS correctly with a developer database present |

---

## The three questions

### Can PCC be deployed to the Lippolis VM today?

**Yes**, once six answers exist (handoff §11.1: OS, container runtime or Node 24, hostname/DNS, TLS
ownership, data directory + backup collection, operational owner). None of the six is engineering.
The install path is `scripts/install-production.sh`, the preflight is read-only, and the whole
build-through-restore lifecycle has been executed end to end from a tree containing nothing but
repository content.

### Can Mike use it without Jack or Claude today?

**Partially — and the remaining part is not software.** Everything Mike does is proven on a
production build against an empty database: sign in, raise, approve, get the right Lippolis PO
number, print it, work the vendor email draft, mark ordered, receive. What is missing is that
nobody has done it *on Lippolis hardware at a Lippolis address*. Until the VM exists he is using
software that works, on a machine that is not his.

### Minimum remaining blockers before a real live order should be trusted

1. **PCC running on the VM under a service manager, and the VM rebooted once** to prove it comes
   back. Everything is supplied; nobody has done it.
2. **A stable URL that people type**, with TLS — or the plain-HTTP decision recorded deliberately
   (§4a). Not doing either means PCC refuses to start, which is the intended outcome.
3. **A restore rehearsed on the VM**, not just here. The rehearsal script is the same one that
   passes on this machine.
4. **Paper PO pairs settled in Administration** for any job-and-vendor the office already wrote
   purchase orders for. This is the one item that cannot be undone after the fact: a duplicate
   number reaches a supplier. `pcc-verify-production.mjs` lists every pair about to issue its
   first number.

### Which of those require Lippolis input rather than engineering?

All four. 1–3 need the VM and IT's infrastructure decisions; 4 needs the office's paper records.
There is no engineering task on this list.

### What could Claude complete autonomously right now?

Real work remains, none of it blocking:

- **The AWE reuse seam.** 8 profile fields would need engineering for a second company, and 2 are
  hard-coded. That is the honest gap between "PCC is deployable" and "a purchasing deployment can
  be created for Company B from configuration." Worth doing when a second company is real, and
  worth *not* doing speculatively before then.
- **Hosted-project RLS proof.** Requires a Supabase project to exist; irrelevant to the SQLite pilot.
- **A shared sign-in throttle**, which is the precondition for running more than one instance.

None should delay the VM.
