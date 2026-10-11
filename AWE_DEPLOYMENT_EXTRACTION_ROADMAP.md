# AWE deployment extraction roadmap

**The question.** If AWE received another business tomorrow, how much of PCC's deployment work
could be reused without copying PCC or hardcoding Lippolis?

**The answer, briefly.** The *reasoning* is almost entirely reusable. The *code* is about 20%
reusable today, and the honest first extraction is small and deep rather than broad.

`PCC_REUSABLE_DEPLOYMENT_LESSONS.md` §5 argues that nothing should be extracted after one
deployment. That argument is right and this document does not overturn it — it identifies the
seams so that when a second deployment exists, the extraction is a decision rather than an
excavation.

---

## 1. Deployment lifecycle states

A universal state model for an AWE-deployed capability. Its purpose is to answer, at any moment:
*where is this deployment, what is blocking it, what happens next.*

```
DISCOVERED ─→ CONFIGURED ─→ PREFLIGHT_PASSED ─→ BUILT ─→ MIGRATED
                                                            │
                                                            ↓
OPERATING ←─ HANDED_OFF ←─ VALIDATED ←─ HEALTHY ←─────── DEPLOYED
                                                            │
                    ┌───────────────────────────────────────┤
                    ↓                                       ↓
              BLOCKED_ON_ORG                          FAILED_ROLLED_BACK
```

| State | Means | Exit condition |
|---|---|---|
| `DISCOVERED` | Blocking discovery answered (§B of the discovery contract) | All ten blocking fields have values |
| `CONFIGURED` | Manifest complete; secrets exist in the secret store | Config validation passes against the target |
| `PREFLIGHT_PASSED` | Read-only machine check clean | Preflight exits 0 |
| `BUILT` | Artifact produced **and finished** | Build + finalize + provenance check all pass |
| `MIGRATED` | Schema present at the expected version | Version stamp matches the code's expectation |
| `DEPLOYED` | Service installed, enabled, running | `systemctl is-enabled` and `is-active` both true |
| `HEALTHY` | Readiness endpoint green **and a real page renders** | Not just the endpoint — see §3 |
| `VALIDATED` | Full workflow exercised on the real instance; restart and restore tested | Cold-start suite passes against it |
| `HANDED_OFF` | Operator trained, owner named, runbook delivered | Named restart owner acknowledges |
| `OPERATING` | In real use | — |
| `BLOCKED_ON_ORG` | Waiting on a customer input | The specific missing field is named |
| `FAILED_ROLLED_BACK` | Deployment reverted | Previous version healthy again |

**Only two failure states, deliberately.** `BLOCKED_ON_ORG` is the common one and it is not a
failure — it is the state PCC is in right now, blocked on a hostname. Modelling richer failure
taxonomies before there is a second deployment would be invention.

---

## 2. Deployment evidence

**Claimed completion ≠ verified completion.** Each state advance requires an artifact, not an
assertion. PCC's readiness scorecard already works this way, and requiring the evidence column is
what changed several rows from optimistic green to honest amber.

| State | Evidence required | PCC's artifact |
|---|---|---|
| `PREFLIGHT_PASSED` | Preflight output, exit 0 | `pcc-preflight.mjs` transcript |
| `BUILT` | Build log + provenance check pass | `check-deployable.mjs` exit 0 |
| `MIGRATED` | Schema version stamp read back from the live database | Startup log line |
| `DEPLOYED` | Service enabled and active | `systemctl status` |
| `HEALTHY` | Readiness JSON **and a rendered page asserting on content** | `/api/health` + stylesheet 200 |
| `VALIDATED` | Cold-start suite, restart-persistence, restore test | `eval-production-coldstart.mjs` (30 checks), destroy-and-restore transcript |
| | Reboot test | Reboot, then health green |
| | DNS + TLS | Resolution from a workstation; certificate valid |
| | Operator acceptance | Named person completed the workflow unaided |
| `HANDED_OFF` | Readiness scorecard with no BLOCKED rows | `PCC_PRODUCTION_READINESS.md` |

**The `HEALTHY` row is the one this deployment changed.** PCC answered `200` on health while
serving no stylesheets. *Health evidence must include a rendered page, not only an endpoint.*

---

## 3. Reusable seams in the current repository

What exists, and how much of each is portable.

| Artifact | Portable | Coupled to PCC | Extraction shape |
|---|---|---|---|
| `pcc-preflight.mjs` | **~80%** | Variable names, database-path specifics | Generic host check + app-supplied requirements table |
| `database-location.ts` | **~85%** | Variable names, SQLite | The *refusal set* is the asset: relative path, missing mount, inside-a-repo, create-without-authorization |
| `pcc-backup.mjs` / `pcc-restore.mjs` | **~70%** | SQLite online-backup API | Generic contract: produce one file, read it back, report counts |
| `check-deployable.mjs` | **~90%** | The list of forbidden artefacts | Generic: assert exclusions actually worked |
| `stage-standalone.mjs` | **~60%** | Next.js layout | Generic principle: finish the artifact inside the build |
| `env.ts` + `.env.example` | **~50%** | PCC's variables | The *pattern* — one module, fatal validation, template with owners — not the code |
| Health endpoints | **~70%** | PCC's checks | Readiness/liveness split + a check registry |
| `deploy/*.service` | **~85%** | Paths and names | Templates with substitution |
| `eval-production-coldstart.mjs` | **~40%** | PCC's workflow | The *harness* generalizes; the workflow assertions cannot |
| `pcc-verify-production.mjs` | **~15%** | Entirely PCC's domain | Only the idea transfers |
| Dockerfile / compose | **~75%** | App name, port, data path | Templates |

---

## 4. The top three candidates

### 1. The deployment preflight — *the recommendation*

**Value.** Highest single-artifact value in the repository. It is the thing that turns "install it
and see" into a five-minute read-only check, and it is the first thing an unfamiliar IT person
runs. It found real problems here.

**Reuse potential.** Very high. Disk, port, writable data path, required variables present,
secret strength, absolute-path checks, database presence vs create-authorization — none of that
mentions purchasing. An application supplies a small table of its own requirements; the harness is
common.

**Implementation cost.** Low — roughly a day. It is already a standalone script with no
application imports.

**Coupling risk.** Low. It reads the environment and the filesystem and changes nothing. The worst
outcome of a bad abstraction is a check that does not apply, which is visible immediately.

**Why now.** It is exercised, it is standalone, and it is the artifact deployment #2 needs on day
one rather than at the end. **Why not now:** none that survives scrutiny.

### 2. The persistent-state contract

**Value.** Prevents the most expensive class of deployment failure — the one where everything looks
healthy and the customer's records are somewhere they will be deleted. It caught a runbook error
that no test could.

**Reuse potential.** High in shape. The refusal set is the asset: never default inside the
container, never accept a relative path, never create a missing directory, never sit inside a git
working tree, never create the store without one-time authorization.

**Implementation cost.** Medium. The refusals generalize; the SQLite-file assumption does not.
Getting the abstraction right needs a second *storage model* to test it against, which one
deployment cannot provide.

**Coupling risk.** Medium-high. Extracted from one embedded-database deployment, it would likely
encode "state is a file" — wrong for Postgres, object storage, or a managed platform.

**Why not now.** The reasoning is written down; the code should wait for a second storage model.

### 3. The service + supervision templates

**Value.** Removes a genuinely fiddly deliverable, and encodes one non-obvious lesson
(`RestartPreventExitStatus=1`) that would otherwise be re-learned as a restart loop.

**Reuse potential.** High for Linux, zero for Windows.

**Implementation cost.** Very low — substitute app name, paths, port, user.

**Coupling risk.** Low, but the value is small: a service file is ~40 lines and the reasoning is
already in comments.

**Why not now.** It is the cheapest of the three and the least valuable. Copying two files is not a
problem worth a module. **Revisit when a Windows deployment exists**, because that is when the
abstraction has something real to span.

---

## 5. The single best next extraction

**A shared deployment preflight, with a per-application requirements table.**

Small, deep, exercised, standalone, and useful before anything else on deployment day. It does not
require deciding what an AWE platform is, and it does not encode a storage model.

**Shape:**
```
awe-preflight --manifest <deployment.yaml>
  host:   runtime version · disk · port free · data path writable and absolute
  config: required variables present · secret strength · no dev defaults in production
  state:  store reachable or explicitly authorized for creation
  app:    <requirements supplied by the application>
```

The first three blocks are common. The fourth is the seam, and it is the only part PCC would
supply.

**What must not be extracted with it:** the variable *names*, the database assumptions, or
PCC's content checks.

---

## 6. What should not be generalized yet

| Not yet | Why |
|---|---|
| A deployment CLI / framework | One data point. It would encode Lippolis as the shape of a customer. |
| A shared config module | The *pattern* transfers; the variables do not. Sharing code here buys nothing and couples two applications' configuration. |
| The two-provider parity model | Real cost, real benefit, unknown whether customer two wants local-first at all. |
| The row-level production verifier | 15% portable. The idea is worth writing down, the code is not worth sharing. |
| A manifest *consumer* | Write the manifest as a checklist first. Build a generator when there is a second thing to generate. |
| Docker as *the* packaging default | Needs a customer without Docker. |
| Bootstrap-admin as *the* first-account pattern | An SSO-from-day-one customer would never use it. |
| Backup scheduling | Belongs to the customer's platform. Building it in is how a product acquires an opinion about somebody else's operations. |

---

## 7. Second-customer risk: what survives, what breaks

| If customer #2 has… | Survives | Breaks |
|---|---|---|
| **No internal IT person** | Everything technical | The whole handoff model. Every artifact assumes a Jose. This is a commercial problem, not a documentation one. |
| **Cloud-only / container platform** | Build, config, health, migrations, logging | **SQLite on local disk.** Ephemeral or network storage breaks it outright. Switch to the Postgres path — which exists but has never been customer-deployed. |
| **Microsoft-heavy / Windows Server** | The application entirely — nothing in it is Linux-specific | Both service units; `/opt` and `/var/lib` conventions; the install script. The runbook's Windows branch is deliberately unwritten. |
| **Managed hosting, no root** | Build artifact, config, health | Service installation, data directory creation, and possibly the runtime version. |
| **No DNS control** | Everything | `APP_BASE_URL` becomes an IP; TLS becomes awkward. Workable, ugly. |
| **Existing SSO** | Authorization, roles, all business logic | Local auth and the bootstrap-admin pattern. **The boundary already exists** — an Entra adapter is a new file against an existing interface. This is the assumption that cost the least to prepare for. |
| **Multiple sites / external users** | Application, authorization | Exposure model, TLS, session policy, probably MFA. Internal-only is currently assumed throughout. |
| **Stricter security posture** | Config validation, redaction, least-privilege unit, no outbound access | Likely needs audit export, MFA, key rotation and a pen-test response — none of which exist. |

**The abstraction boundaries this reveals**, in priority order:

1. **Storage** — the sharpest. "State is a local file" is load-bearing and will break first.
2. **Supervision** — the OS boundary. Cheap to abstract once Windows is real.
3. **Identity** — already abstracted, and it shows. This is the one that cost nothing.

---

## 8. So: how much is reusable tomorrow?

**Reusable as-is:** the discovery questions, the lifecycle, the evidence model, the reasoning
behind every decision, the shape of preflight/backup/restore/health/supervision, and the
knowledge of which defects only appear in production.

**Reusable with edits:** the systemd units, Dockerfile, compose file, `.env.example` structure,
preflight script, provenance check, cold-start harness — all portable in shape, none portable
without changing names and paths.

**Not reusable:** anything encoding purchasing, SQLite, Lippolis's numbering, or the assumption
that a Jose exists.

**Concretely: deployment #2 should be perhaps 60–70% faster on the operational work**, not because
code is shared but because the questions are known, the failure modes are known, and the artifacts
have templates. The saving is in not rediscovering that a green health check can hide an unstyled
application — not in importing a module.

**The single highest-leverage change for #2** is not an extraction at all. It is asking the ten
blocking discovery questions on day one instead of week six.
