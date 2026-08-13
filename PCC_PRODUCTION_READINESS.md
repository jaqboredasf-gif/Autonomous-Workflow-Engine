# PCC — production readiness scorecard

**Dated 2026-08-13.** Three statuses only:

- **PASS** — done, and tested. The evidence column says how.
- **NEEDS JOSE** — the software is finished; an infrastructure input or decision is missing.
- **BLOCKED** — something genuinely prevents pilot deployment.

Nothing optional is recorded as a blocker.

---

## Scorecard

| # | Item | Status | Evidence / what is needed |
|---|---|---|---|
| 1 | **Production build** | PASS | `npm run build --workspace purchasing` clean. A post-build step now stages `.next/static` and `public` into the standalone output — see §Fixed 1. |
| 2 | **Production start** | PASS | Standalone server started with production configuration against an empty database; health `ok`, stylesheets serve, full workflow completed. |
| 3 | **Clean migration** | PASS | Empty directory → database created, all migrations applied at startup, schema `0038-po-number-per-job-vendor`. No separate migration command exists or is needed. |
| 4 | **Database persistence** | PASS | Process killed and restarted: 3 users, 1 vendor, 1 purchase order, 32 activity rows and the PO number all intact; no new database created. |
| 5 | **Restart resilience** | NEEDS JOSE | Both systemd units exist with `Restart=on-failure` and `RestartPreventExitStatus=1`. **Jose installs one and runs `systemctl enable`** — or the Windows equivalent. Cannot be verified from the repository because the target OS is not chosen. |
| 6 | **Health check** | PASS | `/api/health` (config, database, migrations) and `/api/health/live`. Names a bad variable without printing its value. |
| 7 | **Logging** | PASS | JSON to stdout, collected by journald/Docker. Startup states which database was opened and any configuration problem. Secrets redacted, emails masked. |
| 8 | **Authentication** | PASS | Cold start: bootstrap admin signs in, wrong password mints no session, invited user signs in, no demo account exists in a production database. |
| 9 | **Authorization** | PASS | Cold start: requestor refused administration and the review screen; unauthenticated request redirected. Plus 379 authorization checks in the suite. |
| 10 | **Secrets / configuration** | PASS | `.env.example` completed this session. Production **refuses to start** without `SESSION_SECRET`, `PCC_DATABASE_PATH` or `APP_BASE_URL` — the last was added this session (§Fixed 2). |
| 11 | **Full purchasing workflow** | PASS | Cold start, production build, empty database: request → approve → stock → quantity → print → email draft → mark ordered → dashboard → receive → history. 30/30. |
| 12 | **Mark Ordered idempotency** | PASS | Two genuinely concurrent presses: status moves once, no duplicate. Guard now evaluated against a re-read row (§Fixed 4). |
| 13 | **Receiving idempotency** | PASS | Two concurrent receives: exactly one receipt, quantity 6 not 12, one history line. |
| 14 | **Backup** | PASS | `pcc-backup.mjs` ran against the live database, verified what it wrote: integrity ok, 0.5 MB, counts reported. Online — no downtime. |
| 15 | **Restore** | PASS | Live database **deleted outright**, restored from backup, application served the same purchase order with quantities 10/2/8 intact. |
| 16 | **Hostname / DNS** | NEEDS JOSE | Choose the internal hostname, point it at the VM, set `APP_BASE_URL`. |
| 17 | **TLS / reverse proxy** | NEEDS JOSE | PCC does not terminate TLS. Session cookies are `Secure`, so **sign-in will not persist over plain HTTP** — this is expected behaviour, not a defect. |
| 18 | **Email integration** | PASS | Nothing to integrate. PCC composes drafts and cannot send; a database constraint pins external sending to false. Mike sends from his own mailbox. Not a gap — a decision. |
| 19 | **Production database** | PASS | SQLite, one file, no server to provision. Path is `PCC_DATABASE_PATH`. |
| 20 | **Service startup on reboot** | NEEDS JOSE | Same as #5: `systemctl enable pcc`, or Automatic start on Windows. Then reboot once and confirm — the runbook has the step. |
| 21 | **Audit / history integrity** | PASS | Append-only, trigger-enforced. PO numbers immutable and undeletable in both providers. Verified surviving restart and restore. |

**Totals: 17 PASS · 4 NEEDS JOSE · 0 BLOCKED.**

---

## What was found and fixed this session

These were discovered by running a production build against an empty database — not by
the test suite, which builds every database from the development fixture and so cannot
see any of them.

**1. The application served no stylesheets.** `next build --output standalone` does not
fold `.next/static` or `public` into the standalone tree. The Dockerfile copied them and
the systemd unit documented the two `rsync` lines — but a build run in place did not, and
that is the first thing anyone tries. The result: health `200`, log says ready, every
stylesheet `404`, page renders unstyled. **Fixed** by `scripts/stage-standalone.mjs`,
which runs as `postbuild`, so every deployment path now produces the same finished
directory.

**2. `APP_BASE_URL` defaulted to `http://localhost:3000` in production.** It is the
address reset links are built from and the origin cookies are scoped against. The
preflight caught it; the application did not, and the preflight is a separate command an
operator can skip. **Fixed** — production now refuses to start without it.

**3. The vendor selector only worked with JavaScript.** When the supplier dropdown was
hoisted to one per request it lost its `name`, so it drove React state and nothing else.
Worse, the **quantity to order** was computed in the browser into a hidden field: an
unhydrated page posted the server-rendered value, which is the *full requested amount*.
A job needing 10 with 2 on the shelf would have ordered **10 instead of 8** — wrong
quantity, no error, on a purchase order sent to a supplier. **Fixed**: the select is
named, and the quantity is now derived server-side from the stock figure unless the
purchaser explicitly overrides it. The server was already doing this arithmetic
correctly; the form was overriding it with a worse answer.

**4. `Mark Ordered` evaluated its guard against a stale row.** The request was loaded
before joining the write queue, so a second press was judged on the status as it was
before the first press moved it. **Fixed** by re-reading inside the transaction; the
second press is now refused with `illegal_transition`.

**5. The go/no-go verifier failed a correctly configured system.** It detected
demonstration vendors **by name** — and the fixture names are real suppliers Lippolis
buys from, so a production database with a genuine Graybar entry was reported NOT READY
and Jose would have been told to delete his own vendor directory. It also counted jobs
from the legacy `jobs` table while the directory screens write `purchase_jobs`, so it
reported "no active jobs are on file" on a fully populated system. **Both fixed** —
seeded vendors are now recognised by their `@example.invalid` ordering contact, which is
what actually marks fixture data, and both job tables are read.

A check that cries wolf on the right answer is worse than no check, because the next real
finding gets waved through with it.

---

## Test results

| Suite | Result |
|---|---|
| `eval-purchasing-domain` | 493 passed, 0 failed |
| `eval-purchasing` | 550 passed, 0 failed |
| `eval-purchasing-providers` | 318 passed, 0 failed |
| `eval-purchasing-isolation` | 174 passed, 0 failed |
| `eval-purchasing-authorization` | 379 passed, 0 failed |
| `eval-workflow-engine` | 235 passed, 0 failed |
| `eval-purchasing-web` | 115 passed, 0 failed (production build) |
| `eval-production-coldstart` **(new)** | 30 passed, 0 failed |
| `eval-production-idempotency` **(new)** | 11 passed, 0 failed |
| `tsc --noEmit` | clean |

Not run here, and needing a container host or a live VM: `eval-clean-machine.sh`,
`eval-idempotence.sh`, `eval-deployment.mjs`, `eval-restore-rehearsal.mjs`. They exist,
they are current, and they are the right things to run on the VM after install.

---

## The four NEEDS JOSE items, precisely

1. **Restart resilience (#5)** — install `deploy/pcc-node.service` (or the Docker unit),
   `systemctl enable --now pcc`. Windows: a service wrapper set to Automatic + restart on
   failure.
2. **Hostname / DNS (#16)** — choose it, point it at the VM, set `APP_BASE_URL` to it.
3. **TLS / reverse proxy (#17)** — terminate TLS at the proxy, forward to PCC's port.
   Without HTTPS, sign-in will not stick.
4. **Reboot confirmation (#20)** — after enabling the service, reboot once and confirm
   PCC returns and `/api/health` is `ok`.

None of these is a software gap. All four are decisions or infrastructure only Lippolis
can provide.

---

## Genuine blockers

**None.**

One thing is *not* a blocker but must not be forgotten, because it cannot be undone: for
any job-and-vendor pair the office has **already written paper purchase orders for**, an
administrator must set where that pair had reached before the first PCC order on it
(Administration → PO numbering). `pcc-verify-production.mjs` lists every unresolved pair
and every job nobody has been asked about. A pair with no paper history needs nothing.

---

## Verdict

**PCC can operate independently of the developer machine and is ready to hand to Lippolis
IT for server deployment.**

It builds, starts, migrates, serves, survives restart, backs up and restores using only
what is in this repository, running on the server. Claude Code and the developer's Mac
are not runtime dependencies of any part of it.
