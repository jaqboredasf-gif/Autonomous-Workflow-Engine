# Deployment case study #1 — PCC at Lippolis Electric

**What this is.** An account of the first time an AWE application left a developer's laptop for a
customer's server: the constraints, the decisions, what generalized, what did not, and what it
cost. Written for the person doing deployment #2.

**Status at the time of writing.** The repository is handoff-ready. The application has **not yet
been installed on the Lippolis VM** — the hostname is still outstanding. Everything below about
*preparation* is evidenced; nothing below about *installation day* is, and it is marked where that
distinction matters.

Companion documents: `PCC_REUSABLE_DEPLOYMENT_LESSONS.md` (what it cost and why),
`AWE_DEPLOYMENT_MODEL.md` (the structure), `PCC_PRODUCTION_READINESS.md` (the evidence).

---

## 1. The constraints we started with

| Constraint | Consequence |
|---|---|
| Two real users — Mike and Rick | Nothing about the architecture may assume scale. A pipeline for two users is a liability. |
| Customer-owned infrastructure, VM not yet provisioned | The application had to be built without knowing the OS, hostname, or network. That turned out to be a *feature*. |
| One IT contact (Jose), part-time on this | Every operational artifact has to be readable by somebody who has never seen the application. |
| A paper process that already works | The fallback is free insurance — and the shared state between the two systems (purchase-order numbers) became the single hardest problem in the deployment. |
| No dedicated ops function | Supervision, backup and health had to be *shipped*, not assumed. |

---

## 2. Infrastructure decisions, and whether they were right

| Decision | Why | Verdict |
|---|---|---|
| **SQLite, one file** | Removes a database server from IT's plate; makes backup one verified file | Right *here*. Also the assumption most likely to break next — see §6. |
| **Attachments inside the database** | One backup, one restore, no second source of truth | Right at this volume. Behind a port, so it moves. |
| **Standalone Node build** | No runtime dependency on the repository or the package registry | Right, and unexpectedly load-bearing — it is also the air-gapped deployment story. |
| **Ship two systemd units** | The OS was unknown | Right. Guessing would have meant rewriting the deployment story in front of the customer. |
| **Docker as packaging, not dependency** | Customer had it; the app must not need it | Right, but **unproven** — needs a customer who does not have Docker. |
| **No outbound network at runtime** | Nothing needs it | Right, and worth protecting deliberately. It makes PCC deployable in a segmented network without a conversation. |
| **Draft-only email** | Lippolis business rule: a person reviews every vendor email | Right *for Lippolis*. Enforced in the schema, which is the universal part. |
| **Migrations at startup** | Removes "did anyone run the migration?" | Right. Made repeat deployment safe by construction. |
| **Bootstrap admin from environment** | An empty database needs one account | Right here; a customer with SSO from day one would never use it. |

---

## 3. What generalized cleanly

These carried no trace of Lippolis, and are the honest output of this deployment:

- **Configuration read once, validated once, fatal in production.** Caught a published-password
  seed and a data-path defect before either reached a customer.
- **The persistent-state contract enforced by the application.** The strongest single piece of
  engineering here. It refuses a relative path, a missing mount, a path inside a git working tree,
  and creating a database without one-time authorization.
- **Readiness and liveness as separate endpoints** with opposite remedies.
- **Restart on crash, not on refusal.**
- **A backup that reads back what it wrote**, and a restore rehearsal that is a *script*, not a
  procedure.
- **Build-time provenance assertion** — an ignore rule is a hope, a failing build is a guarantee.
- **Evidence per go-live row.** Several rows changed colour when the evidence column was filled in
  honestly.
- **Authentication replaceable, authorization not.**

---

## 4. What was Lippolis-specific and must stay that way

SQLite as the operational store · inline attachments · draft-only email · the sizing numbers ·
the purchase-order numbering rule (`job-vendor-sequence`) · the workshop/receiving role model ·
`pcc-verify-production`'s actual checks · the bootstrap-admin pattern.

The *shapes* behind several of these generalize. The values do not, and the distinction is the
whole point of writing them down separately.

---

## 5. What surprised us

**Every serious defect was found by deployment, not by testing.** The test suite is large and
passes; it built every database from the development fixture and therefore could not see any of
these:

1. A seed that created a **published administrator password** on any empty database.
2. A misconfigured data path producing a **new empty database, migrated, healthy** — a green tick
   and no purchase orders.
3. A schema version stamped at *creation* rather than at *migration*, which would have reported
   every correctly-upgraded installation permanently unhealthy.
4. Attachments that were stored, listed, and **never retrievable** by any code path.
5. The standalone build serving **`200` on health and `404` on every stylesheet** — a healthy
   process and an unusable product.
6. The order quantity computed **in the browser** into a hidden field, so an unhydrated page would
   have ordered 10 instead of 8 — wrong quantity, no error, on a supplier's purchase order.
7. The go/no-go verifier **failing a correct system** because it detected demo vendors by name, and
   the fixture names are real suppliers the customer buys from.

**The most useful review technique was reading our own runbook as a stranger.** It found the
highest-severity issue of the whole preparation pass: the runbook said clone to `/srv/pcc` *and*
put data in `/srv/pcc/data`. Each half was sensible; together they put the customer's records
inside a git working tree, where a re-clone deletes them with no command that looks destructive.
No test would ever have caught it, because it is a property of the instructions.

**Simplification was driven by users, not by design.** Mike's feedback removed an estimated-cost
field, a confirmation dialog, a priority system and a detailed receiving form. Each had been built
because the domain supported it. *Completeness and usability are different goals, and the second
one only shows up when a real operator uses it.*

---

## 6. What caused friction

- **The unknown OS.** Cost: two service units and an unwritten Windows path. Cheap insurance, but a
  single answer would have halved it.
- **The hostname.** Still outstanding, and now the last thing between the repository and a live
  deployment. It should have been question one on day one.
- **Shared state with the fallback process.** Purchase-order numbering consumed several sessions,
  ending in a rule (`job + vendor + sequence`) that only became knowable by asking the customer.
  **Any first deployment that replaces a working process will have an equivalent, and it will not
  be discoverable from the code.**
- **The development fixture as a blind spot.** Every database in the suite came from a seed. The
  entire class of defects in §5 lived in the gap between "fresh fixture" and "real installation".

---

## 7. What should be automated next time

| Candidate | Why |
|---|---|
| **Cold-start acceptance against an empty database** | Found five defects in one session that nothing else could. Should be a standard artifact of any AWE deployment, not a thing invented at the end. |
| **The read-only preflight** | Reusable in shape almost verbatim: disk, port, config, data path, PASS/WARNING/FAIL. |
| **Restore rehearsal into a throwaway environment** | The only thing that proves a backup is a backup. |
| **Build-completion staging** | Generic: whatever finishes the artifact must be in the build, not in the runbook. |
| **The discovery questionnaire** | Ten questions; seven blocking. The split is the value. |

## 8. What should remain human and IT-owned

DNS · TLS certificates and the reverse proxy · backup platform, schedule, offsite · monitoring ·
firewall · who restarts it · the decision to go live · **and every business identifier that is
shared with the process being replaced.**

Do not build backup *scheduling* into the product. Do not have an opinion about the customer's
network. Both are how a product becomes coupled to one customer's circumstances.

---

## 9. What AWE should ask earlier next time

In order of how much delay each would have removed:

1. **Hostname and who controls DNS.** Still outstanding here.
2. **Server OS.** One answer would have removed a whole branch of work.
3. **"What does this replace, and what identifiers are shared with it?"** The purchase-order
   sequence was discoverable only by asking, and it blocked go-live.
4. **"Who restarts it at 7am?"** Asked least, matters most.
5. **Can the required runtime version be installed?** A hard limit, cheap to check, expensive to
   discover late.

---

## 10. The honest summary

The application was ready long before the deployment was, and the gap was not features — it was
the difference between *software that works* and *software somebody else can run*. That gap was
roughly: configuration validation, persistent-state enforcement, supervision, health, backup,
restore rehearsal, provenance checks, a cold-start test, and about a dozen documents.

**Most of it is reusable in shape and almost none of it in substance.** The next deployment should
expect to re-derive the values and reuse the reasoning — which is exactly why the reasoning is
written down here rather than extracted into code that would carry Lippolis's circumstances into
a customer who does not share them.
