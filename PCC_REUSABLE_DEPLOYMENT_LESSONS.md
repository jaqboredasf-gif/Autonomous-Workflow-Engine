# What AWE should learn from deploying PCC at Lippolis

PCC is the first AWE application to leave a developer's laptop for a customer's server. This
document records what that cost, and which parts of it will cost the same again at the next
company.

**It is not a framework, and nothing here should be extracted into shared code yet.** One
deployment is an anecdote. The point of writing it down now is that the reasons are still
legible; by the third customer they will have hardened into habits nobody can explain.

Everything below is sorted into three buckets, and the sorting is the whole value:

| | Meaning |
|---|---|
| **UNIVERSAL** | Seen once, but the reasoning does not mention Lippolis. Expect to need it again. |
| **LIPPOLIS** | A real decision, specific to this customer. Must live in configuration or an adapter, **never** in application code. |
| **UNKNOWN** | Looks like a pattern, but one data point cannot tell the difference between a pattern and a coincidence. Decide after customer two or three. |

---

## 1. The defects that only exist in production

The most valuable thing this deployment produced is a list of bugs that **could not be found by
testing the application**, because in each case the application was working correctly.

**UNIVERSAL — the seed that ships.** PCC's development seed created ten demo accounts, including
an administrator whose password was published in the repository README. It ran on any empty
database. The first production container to start against an empty volume came up with a known
administrator password — verified by signing in as one against the built image. *Lesson: an
environment-blind seed is a production credential. Development data must be refused in production
by the code that creates it, not by remembering not to run it.*

**UNIVERSAL — the database that comes up empty and healthy.** If the data path was unset,
relative, or pointed at an unmounted directory, the app created a fresh database inside the
container, migrated it, served an empty system and reported healthy. The operator sees a green
tick and missing purchase orders. *Lesson: refusing to guess a data location is worth more than
any amount of monitoring. Creating the customer's database must be a once-ever act that somebody
explicitly authorizes (`PCC_DATABASE_ALLOW_CREATE=1`), so a wrong volume is loud on the second
deploy instead of silent forever.*

**UNIVERSAL — the migration stamp that only fires once.** The schema version was recorded when the
database was *created*, not when it was *migrated*. Health compares that stamp against the version
the code expects. So the first release to change the schema would have upgraded every installation
correctly and then reported all of them unhealthy, permanently, with nothing wrong — draining
working instances and paging somebody. *Lesson: the version stamp must name the state the schema
is IN, not the state it was born in. And: a defect in the upgrade path cannot be found by reading
the migration, because the migration works. Test the second deployment, not the first.*

**UNIVERSAL — the file that goes in and never comes out.** Users could attach photographs to
requests and receipts. The bytes were stored, the filenames were listed on three screens, and no
code path anywhere returned the file. Foremen were being asked for evidence that was being
discarded in a way that looked like retention. *Lesson: for every write path, ask what reads it.
"Stored" and "retrievable" look identical from a screen that only lists names.*

**UNIVERSAL — the build that ships the developer's data.** The standalone build copies the
application directory wholesale, including the local `.data/` SQLite file. Without an explicit
exclusion the image contains a real database, and that is the database the container opens.
*Lesson: pair every ignore rule with a build-time assertion that it worked
(`scripts/check-deployable.mjs`). An ignore file is a hope; a failing build is a guarantee.*

**UNIVERSAL — the demo database that walks to the server.** Every mechanism above is a rule about
how a database was *created*. None of them help when a laptop database is copied to the server the
evening before a pilot, which is exactly when it happens. *Lesson: ship a tool that inspects the
ROWS of a live database and reports whether it is fit for real work
(`scripts/pcc-verify-production.mjs`). Provenance rules and content checks catch different things.*

---

## 2. Boundaries that paid for themselves

**UNIVERSAL — authentication is replaceable, authorization is not.**

> Authentication answers *who is this person?* Authorization answers *what may they do?*

PCC's roles and permissions are its own and are computed from its own concepts. Identity is one
interface with one binding line. This meant "the customer might want Microsoft SSO" required no
design work at all — it is a third file against an existing interface. **Every AWE application
should draw this line on day one**, because it costs nothing then and is a rewrite later.

**UNIVERSAL — configuration is read in exactly one place, validated once, and fatal when wrong.**
One module owns the environment; a startup preflight refuses to serve a misconfigured production
deployment; the health endpoint reports which *variable* is at fault without ever reporting its
*value*. The property that matters: **the application fails loudly at startup rather than quietly
at 4pm.**

**UNIVERSAL — the health endpoint answers two different questions and must not conflate them.**
Readiness ("do not send traffic, do not restart me") and liveness ("I am wedged, restart me") have
opposite remedies. One endpoint serving both guarantees one of them is wrong: a supervisor pointed
at readiness turns a config typo into a restart loop.

**UNIVERSAL — the customer's records are the only thing that is not disposable.** Stating this
explicitly — one volume, one file, everything else rebuildable — organizes the deployment, the
backup boundary and the rollback story all at once.

**UNKNOWN — the two-provider data model held to one shape by an automated parity check.** PCC
carries a SQLite pilot store and a Postgres/RLS production store, kept in lockstep by a script
that asserts both agree on tables, columns, statuses and transitions. It has worked well and it
caught real drift. But it is a genuine cost, and whether the next customer needs a local-first
mode at all is unknown. **Do not generalize this until a second customer asks for it.**

---

## 3. What the customer decides, and what we must not decide for them

**UNIVERSAL — the infrastructure questionnaire.** Deploying into a company we do not administer
requires answers we cannot guess, and asking late is what stalls a deployment. The list that
mattered here, which is probably the list every time: server OS and environment; container runtime
availability; hostname and DNS control; what terminates TLS; public or VPN-only reach; existing
backup platform, schedule and retention; existing monitoring that can poll an endpoint; whether a
company database server exists; identity provider and whether staff should use work accounts;
outbound email policy; and **who restarts it at 7am**. That last one is asked least and matters
most.

**UNIVERSAL — remote access is the customer's decision, and the application must not have an
opinion.** Whether field staff reach the app over VPN, a reverse proxy or a Zero Trust gateway is
infrastructure. AWE applications should require only: an HTTP port, an HTTPS endpoint in front,
standard proxy headers, and one variable naming their own address. **Anything more couples the
product to one customer's network.**

**UNIVERSAL — the backup responsibility boundary.** Ours: identify what must be backed up, ship a
command that produces one verified file, document restore, ship a restore *test*. Theirs: the
platform, the schedule, the retention, offsite storage, VM-level recovery. Do not build backup
scheduling into the product; do not assume the customer has a system either.

**LIPPOLIS — SQLite for the pilot.** Correct *here* because it removes a second server from IT's
plate and makes backup one verified file. It is a customer-configuration decision
(`PURCHASING_PERSISTENCE`), not an AWE default, and the Postgres path exists beside it.

**LIPPOLIS — files stored inline in the database.** Right at this volume: one backup, one restore,
no second source of truth to reconcile. Wrong at a company with real document volume. Behind a
port, so it moves without touching business logic.

**LIPPOLIS — draft-only email.** PCC composes vendor emails and cannot send: a CHECK constraint in
the schema and no `send` method on the port. This is Lippolis's *business* rule — a person reviews
every vendor email — not a technical limitation, and the next customer may well want sending.
**Enforcing a business rule in the schema is universal; this particular rule is not.**

**LIPPOLIS — the org name, PO number sequence, and PO template.** Obvious, and listed because the
PO sequence is the one that bites: it must be set to the office's real next number before the
first live order, and it can only move forward.

---

## 4. Deployment shape

**UNIVERSAL — prefer a boring release path.** `git pull`, rebuild, restart, check health, read the
log. No pipeline to maintain for an application with two users. Complexity in a release process is
not safety; it is another thing that can be broken on the day.

**UNIVERSAL — supervision is part of the product.** "Someone leaves a terminal open" is not a
deployment. Ship the unit file, and write it to **restart on a crash but not on a refusal** — a
supervisor that loops on a deliberate configuration failure buries the one line explaining it.

**UNIVERSAL — do not assume the customer's OS.** Ship both supported paths and mark the choice as
a question. Guessing wrong means rewriting the deployment story in front of the customer.

**UNKNOWN — Docker as the packaging default.** It worked well and the customer had it. Whether it
should be AWE's default, or one of several, needs a customer who does not.

---

## 4a. Candidate AWE deployment capabilities, from the go-live pass

The productionization exercise produced a second, more specific list: the things AWE would
plausibly want to *provide* to the next customer deployment, rather than reinvent. Each is
classified by how much evidence actually stands behind it.

**The classification is the point.** One deployment cannot distinguish a pattern from a
coincidence, and the honest label for most of this is the third one.

| Capability | Classification | What PCC actually established |
|---|---|---|
| **Customer infrastructure discovery** — a fixed questionnaire, split into blocks-installation vs can-wait | **UNIVERSAL CANDIDATE** | Ten questions, seven blocking. The split is what made it useful: an undifferentiated list of twelve questions stalls a deployment on items that could have waited. |
| **Runtime sizing from architecture, not from what's available** | **UNIVERSAL CANDIDATE** | The VM offered 48 cores; PCC asked for 2, and the reasoning (single-writer store, so cores buy nothing) is the kind that generalizes even when the numbers do not. |
| **Environment separation with fatal validation** — one config module, one preflight, refuse to serve when production configuration is wrong | **UNIVERSAL CANDIDATE** | Caught a published-password seed and a database-path defect before either reached a customer. |
| **Customer-owned production infrastructure as the default posture** | **UNIVERSAL CANDIDATE** | The application never learned the customer's hosting choices. That is what let "which VM?" stay unanswered for weeks without blocking development. |
| **Deployment manifests shipped with the app** — Dockerfile, compose, and *both* systemd variants | **UNIVERSAL CANDIDATE** | Shipping two supervision paths meant an unknown VM OS was not a blocker. Guessing would have meant rewriting the deployment story in front of the customer. |
| **Health contract: readiness AND liveness, with opposite remedies** | **UNIVERSAL CANDIDATE** | Conflating them makes a config typo into a restart loop. Cheap to get right, expensive to discover. |
| **Operational logging contract** — structured, redacted by field name, startup lines prefixed | **UNIVERSAL CANDIDATE** | Redaction by field name rather than by discipline. Also: a warning that fires on every correct start teaches operators to ignore warnings, so it must be a fact, not a scold. |
| **Backup contract** — the app produces one verified file and documents restore; the customer owns platform, schedule, retention, offsite | **UNIVERSAL CANDIDATE** | A clean responsibility seam that neither party has to negotiate per deployment. |
| **Restore rehearsal as an executable artifact, not a procedure** | **UNIVERSAL CANDIDATE** | The strongest single result of this pass. A written procedure would have been marked GREEN and never run. A script that restores into a throwaway environment and *verifies the application's behaviour* — not the file's integrity — is the only thing that proves a backup is a backup. |
| **Verify restored state through the application, byte-for-byte** | **UNIVERSAL CANDIDATE** | An integrity check passes on a database whose attachments are gone. Comparing downloaded bytes against what was uploaded is what distinguishes "the row is there" from "the file is". |
| **Test isolation guard** — prove the instance answering is the one you deployed | **UNIVERSAL CANDIDATE** | A stale container produced three convincing false defects. Any integration suite that assumes the thing answering is the thing it started will eventually be confidently wrong. |
| **Identity-provider boundary** — authentication replaceable, authorization never | **UNIVERSAL CANDIDATE** | Cost nothing on day one; made "might want Microsoft SSO" a non-event. |
| **Remote-access boundary** — the app requires a port, HTTPS in front, standard proxy headers, and its own address; nothing more | **UNIVERSAL CANDIDATE** | Kept an undecided network architecture from blocking anything. |
| **Application/IT responsibility split** | **UNIVERSAL CANDIDATE** | Three columns: is the machine working, is the app working, is the app doing the right thing. |
| **Controlled pilot strategy** — smoke test on controlled data → few real users → adoption, each with a condition to proceed | **UNIVERSAL CANDIDATE** | The conditions matter more than the phases. "Move on when two weeks pass without somebody reaching for paper mid-order" is falsifiable; "when it seems stable" is not. |
| **Rollback to the pre-existing manual process** | **UNIVERSAL CANDIDATE** *(the shape)* | Every first deployment replaces something that already works. Keeping it as the fallback is free insurance — and the reconciliation of shared state on the way back is the part everybody forgets. |
| **Go-live gate with evidence per row** | **UNIVERSAL CANDIDATE** | Requiring an evidence column is what stops optimistic green. Several rows changed colour when the evidence column was filled in honestly. |
| **Database scaling triggers** — named signals, not a feeling | **UNIVERSAL CANDIDATE** *(the practice)* | Writing down what ends Phase 1 converts a future argument into a checklist. |
| **File-storage scaling triggers with monitoring commands** | **UNIVERSAL CANDIDATE** *(the practice)* | Same. The specific thresholds are PCC's. |
| **Shared-state reconciliation on rollback** — PO numbers | **LIPPOLIS-SPECIFIC** | The *mechanism* is a purchase order sequence that only moves forward. The *shape* — an identifier shared between the new system and the fallback, which must never collide — is probably universal, but one instance is not evidence. |
| Sizing figures: 2 vCPU / 4 GB / 50 GB | **LIPPOLIS-SPECIFIC** | Derived from this workload. The derivation is reusable; the numbers are not. |
| SQLite as Phase 1 operational store | **LIPPOLIS-SPECIFIC** | Right for a single-instance, low-concurrency, customer-operated box where removing a database server from IT's plate is worth more than concurrency. |
| Inline attachment storage | **LIPPOLIS-SPECIFIC** | Right when the advantage of a single-file backup outweighs storage growth. |
| Draft-only email | **LIPPOLIS-SPECIFIC** | A business rule enforced in the schema. *Enforcing business rules in the schema* is universal; this rule is not. |
| **A local-first mode alongside a managed-infrastructure mode**, held to one data model by an automated parity check | **UNPROVEN — NEEDS MORE DEPLOYMENTS** | It works and it has caught real drift, but it is a standing cost. Whether the next customer needs a local-first mode at all is unknown. |
| **Docker as the packaging default** | **UNPROVEN — NEEDS MORE DEPLOYMENTS** | Worked here; the customer had it. Needs a customer who does not. |
| **Two supervision variants as the standard offering** | **UNPROVEN — NEEDS MORE DEPLOYMENTS** | Shipping both was clearly right with an unknown OS. Whether it stays right, or collapses to one once AWE knows its market, is not yet visible. |
| **Bootstrap-administrator pattern** — one account from configuration, created once, password removed after | **UNPROVEN — NEEDS MORE DEPLOYMENTS** | Correct here. A customer with SSO from day one would never use it, and would want a first-admin mapping from their directory instead. |
| **Provenance rules + a row-level content verifier** (`pcc-verify-production.mjs`) | **UNPROVEN — NEEDS MORE DEPLOYMENTS** | Genuinely useful — it catches the laptop database copied to the server. But the checks it runs are entirely PCC's domain (demo vendors, PO sequence, workshop location), so what generalizes is the *idea*, and one instance cannot show what the general shape is. |

**Preserved evidence.** The scripts are the artifact, not this table: `scripts/restore-rehearsal.sh`
and `scripts/eval-restore-rehearsal.mjs` (backup/restore proof), `scripts/lib/port-guard.mjs` (test
isolation), `scripts/eval-deployment.mjs` (redeploy survival), `scripts/check-deployable.mjs`
(build-time provenance), `scripts/pcc-verify-production.mjs` (row-level content). A future AWE
deployment capability should be generalized from what these actually do, not from the description
above.

---

## 4b. The pre-VM pass — what preparing for installation day taught

A separate exercise from productionizing the application: making installation day require no
improvisation, **before** having access to the machine. Three classifications, and the middle one
is where most of this honestly sits.

### PROVEN AT LIPPOLIS — actually exercised, with evidence in this repository

| | Evidence |
|---|---|
| **Backup → restore → verify-through-the-application rehearsal** | `scripts/restore-rehearsal.sh`, 23 checks against a restored instance including byte-identical attachments |
| **Deployment idempotence as a test, not a claim** | `scripts/eval-idempotence.sh`, four repeat-deployment actions including the forgotten first-install flag |
| **Clean-machine reproducibility** | `scripts/eval-clean-machine.sh` — export the tree with no `node_modules`, `.next`, `.data` or `.git`, then run the whole lifecycle from it |
| **Read-only install preflight** | `scripts/pcc-preflight.mjs`, PASS/WARNING/FAIL, run before touching anything |
| **Test-isolation guard** | `scripts/lib/port-guard.mjs`, after a stale container produced three convincing false defects |
| **Reading your own runbook as a stranger** | Found the highest-severity issue of the whole pass — see below |

### CANDIDATE REUSABLE PRIMITIVE — likely useful at the next organization

**The dry-run runbook review is the strongest of these, and the cheapest.** Reading our own
installation document line by line, as somebody who had never seen the machine, found that it said
*clone to `/srv/pcc`* and *put the data in `/srv/pcc/data`*. Each half was sensible. Together they
put the company's purchasing records inside a git working tree, where `git clean -xfd`, a re-clone,
or a release replacing the application directory deletes both the database and the backups beside
it — with no command that looks destructive. **Nothing in the test suite would ever have caught
that, because it is not a property of the software. It is a property of the instructions.** The
fix was to move the data and then make the application refuse the layout outright, so the rule
does not depend on anybody remembering it.

Generalizing: **the persistent-state contract must be enforced by the application, not by the
runbook.** Any AWE deployment should refuse, at startup, a data path that a routine deployment
action could destroy. Documentation that says "don't put it there" is a hope.

Also candidates:

* **A `--dry-run` installer that automates only the deterministic half**, and enumerates in its own
  output what it deliberately will not do (secrets, DNS, HTTPS, firewall, business identifiers).
  Scope stated in the artifact is scope that survives.
* **Configuration templates classified by WHO SUPPLIES THE VALUE**, not merely by required/optional.
  On installation day the delay is never "what does this variable mean" — it is "whose answer is
  this?"
* **A secrets checklist that stores no secrets** — purpose, who creates it, where it is expected,
  whether the app starts without it, and what rotation costs.
* **Storage visibility sized to the architecture.** With full-copy backups, the operator's real
  question is "how many more backups fit?", not "how big is the database?" One read-only command
  (`scripts/pcc-storage-status.mjs`) answers it.
* **Separate handoffs per audience.** IT gets no purchasing content; purchasing gets no server
  content. Mixing them means each party reads past their own obligations.
* **A recorded transition from build mode to deploy/observe/refine mode**, with named evidence
  sources — so "should we add X?" has a documented answer that is not a matter of taste.

### STILL UNPROVEN — needs another customer before it becomes doctrine

* **Whether the installer is worth having at all.** It automates perhaps fifteen minutes of a
  half-day installation, and the runbook remains the real document. At the second customer, either
  it generalizes or it is revealed as ceremony.
* **`/var/lib/<app>` as the persistent-state convention.** Correct on Linux; means nothing on
  Windows, and the Windows branch of this deployment is deliberately unwritten.
* **The three-phase pilot with falsifiable exit conditions.** Written, agreed, not yet run. Its
  value is entirely unproven until Phase B either catches something or does not.
* **Whether a single evidence record is enough.** One installation record has been designed and
  zero have been filled in.

**A caution for whoever generalizes this.** Almost everything above was written in one week, for
one customer, by one person, without access to the target machine. It is the *right* preparation
as far as anyone can tell — and nobody has yet installed anything. The list should be re-read after
installation day, and the items that turn out to have been ceremony should be struck out rather
than quietly kept because they were expensive to write.

---

## 5. The rule this document exists to protect

**Nothing here justifies putting an AWE abstraction into PCC.**

Every pattern above is currently one instance of a shape. The correct action after one deployment
is to write it down, not to extract it. A shared configuration module, a shared health check or a
common deployment framework built from a single data point will encode Lippolis's circumstances as
if they were universal, and the second customer will pay for the mistake without being able to see
it.

Re-read this after the second deployment. What is still true in both places is a pattern. What is
not was a coincidence, and the honest thing is to move it into the LIPPOLIS column and carry on.
