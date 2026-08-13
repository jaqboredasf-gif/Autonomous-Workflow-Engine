# AWE deployment substrate

The reusable part of deploying an AWE capability into an organization AWE does not
administer. Extracted from PCC at Lippolis — deployment #1 — and deliberately kept small.

**Run the tests:** `node scripts/eval-deployment-core.mjs` (101 checks).

---

## What this is for

One question, asked of any organization at any moment:

> What is known, what is guessed, what has been verified, what is unresolved, who owns it, and
> what evidence supports the claim that it is ready?

PCC reached the end of application development while still blocked on a hostname nobody had been
asked for. Not because the question was hard — because there was nowhere for *"we have not
established this"* to live.

---

## The boundary

**Core** (`deployment/*.mjs`) — the lifecycle. No `if (os === …)` anywhere.

| Module | Owns |
|---|---|
| `facts.mjs` | How a thing is known: DECLARED / DERIVED / VERIFIED / UNKNOWN |
| `manifest.mjs` | The field table, validation, derivation, secret refusal |
| `blockers.mjs` | What blocks which phase, and who can clear it |
| `preflight.mjs` | Observational environment checks |
| `clean-install.mjs` | The empty-database lifecycle, fixture-free |
| `evidence.mjs` | Evidence records and derived readiness |
| `responsibilities.mjs` | Who owns what — no assumed IT department |
| `handoff.mjs` | The part of a handoff that is pure state |

**Adapters** (`deployment/adapters/`) — environment mechanics. **One exists**: `linux-systemd`,
because that is what PCC actually deployed to. Windows, docker-compose and managed platforms are
named and absent, because an adapter for a platform nobody has used is a guess with a filename.

---

## The four epistemic states

The distinction that carries the most weight is **DECLARED vs VERIFIED**. "IT says the server runs
Linux" and "the preflight ran `uname` on it" are different kinds of true.

```js
runtime:  { name: verified('node', 'process.versions') }   // we are running on it
hosting:  { os: declared('linux', 'organization_it') }     // somebody said so
service:  { manager: /* derived → systemd */ }             // AWE inferred it
network:  { hostname: unknown('not yet chosen') }          // a row in the report, not a silence
```

**DERIVED ranks below DECLARED.** If AWE infers `systemd` from "the OS is Linux" and the customer
said `docker-compose`, the customer is describing their machine and AWE is guessing about it. Only
verification settles it.

---

## Blockers are per phase

Not every unknown stops everything, and treating them alike makes the list worthless.

```
REQUIRED_BEFORE_BUILD    cannot produce an artifact       (e.g. runtime floor)
REQUIRED_BEFORE_DEPLOY   cannot install it                (e.g. data path)
REQUIRED_BEFORE_GO_LIVE  cannot let real users on it      (e.g. hostname, TLS)
NON_BLOCKING             wanted, not load-bearing
```

PCC today:

```
reachable phase: DEPLOY_ONLY
4 unresolved: 4 before go_live. Owned by: CUSTOMER_IT, SHARED.
  GO_LIVE   network.hostname               -> CUSTOMER_IT
  GO_LIVE   network.reverse_proxy          -> CUSTOMER_IT
  GO_LIVE   service.enabled_at_boot        -> CUSTOMER_IT
  GO_LIVE   storage.backed_up_by_customer  -> SHARED
```

That is produced by the model from the manifest. Nothing in the code mentions PCC.

---

## Preflight is observational

Four results, and the fourth is the one most tools omit:

**PASS** · **WARNING** · **BLOCKED** · **UNKNOWN**

`UNKNOWN` is not a soft pass. *"The certificate is valid"* and *"I cannot see the certificate from
here"* are different sentences.

**The safety rule is enforced structurally.** Every check declares `mutates`, and the runner
refuses to execute any check declaring mutation. Diagnose, remediate and execute-remediation are
three operations; the moment a diagnostic tool can fix things, somebody runs it against production
to see what it says.

---

## Readiness is derived, never asserted

There is no `ready = true`. Readiness is a function of blockers plus evidence, and fails in three
separately-reported ways because different people clear them:

- unresolved blockers → usually the customer
- missing evidence → usually us, by running something
- failed evidence → a real defect

Evidence is scoped to an **environment and a version**. A health check that passed against last
week's build in staging is not evidence about today's build in production.

---

## Deployment invariants

Adopted only where the PCC evidence justifies them.

1. **A production deployment is validated from a clean installation path independent of development
   fixtures.** Every serious PCC defect lived in the gap between "fresh fixture" and "real
   installation".
2. **Readiness is supported by evidence, not developer assertion.**
3. **Unknown infrastructure requirements remain UNKNOWN until declared, derived or verified.** Never
   silently defaulted.
4. **Customer records are never treated as invalid because they resemble development examples.**
   PCC's verifier flagged real suppliers as demo data by name, and would have told an operator to
   delete the real vendor directory. *This module reproduced the same class of bug in its own secret
   heuristic, which flagged a legitimate version string — caught by the tests.*
5. **Deployment verification is non-destructive by default.**
6. **Infrastructure ownership is explicit configuration, not an assumed person.** PCC has a Jose.
   That is one organization's staffing, not a property of deployment.
7. **Environment mechanics are adapters; lifecycle and governance are core.**
8. **A green health check is not evidence that the product works.** PCC answered `200` while serving
   no stylesheets — hence `RENDERED_PAGE_VERIFIED` as evidence distinct from `HEALTHCHECK_SUCCEEDED`.

---

## The abstraction test

`examples/org-002-synthetic.manifest.mjs` is a synthetic organization shaped to break Lippolis
assumptions: cloud platform, no internal IT, MSP-managed Postgres, provider-owned DNS and TLS, SSO
from day one, no systemd.

It reports:

```
reachable phase: BUILD_ONLY
1 unresolved: 1 before deploy. Owned by: HOSTING_PROVIDER.
  DEPLOY    hosting.install_path           -> HOSTING_PROVIDER
```

Nothing is owned by `CUSTOMER_IT`; `service.manager` derives to `platform-managed`, for which no
adapter exists, and the model **says so** rather than silently assuming systemd. That is the check
that the assumptions were removed rather than renamed.

---

## What this is not

Not a platform. No Kubernetes, Terraform, cloud orchestration, secrets platform, DNS management,
monitoring system or CLI. There is evidence from **one** deployment; this is sized to make
deployment #2 cheaper, not to pretend there is evidence from deployment #20.

Companion documents: `AWE_DEPLOYMENT_MODEL.md`, `AWE_DEPLOYMENT_DISCOVERY_CONTRACT.md`,
`PCC_DEPLOYMENT_CASE_STUDY.md`, `PCC_REUSABLE_DEPLOYMENT_LESSONS.md`.
