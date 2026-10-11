# AWE Purchasing Capability — status

**Measured, not estimated.** Every claim below is backed by a named test or file.

```
node scripts/eval-organization-provisioning.mjs    78 checks — the boundary
node scripts/eval-purchasing-redeployability.mjs   29 checks — the measurement
node scripts/eval-purchasing-authorization.mjs    379 checks — unchanged behaviour
node scripts/eval-purchasing-providers.mjs        321 checks — both providers agree
node scripts/eval-purchasing.mjs                  550 checks — the workflow, end to end
```

Two boundaries have been extracted so far: **who may act** (authorization) and **what a purchase
order is called** (numbering). Both are proved the same way — against a synthetic organization that
differs deliberately, with no purchasing core file changed for it.

---

## What is now reusable

**The authorization boundary was the extraction this session.** Purchasing already decided
authority from capabilities — `authorize(actor, 'po.generate')` — and that needed no change. The
coupling was one step earlier: the map from role *names* to capabilities was a module constant in
the domain containing `WORKSHOP_APPROVER`.

```
Organization profile              capability/purchasing/profiles/*-authorization.mjs
  roles: { NAME: [capabilities] }
        ↓
effectiveCapabilities(profile, membership)     capability/purchasing/authorization.mjs
        ↓ a flat capability set, scoped to one organization
actor.capabilities
        ↓
permissionsFor(actor)                          domain/roles.mjs  ← the only file changed
        ↓
authorize(actor, capability)                   domain/roles.mjs  ← unchanged
        ↓
purchasing use case                            application/*.ts  ← unchanged, never sees a role name
```

**One production file changed:** `domain/roles.mjs`, and only `permissionsFor()`. It now prefers
`actor.capabilities` when present and falls back to the built-in tables when absent. No use case,
no repository, no screen was touched.

Also reusable and unchanged: the request model, the 14-state machine, the three-quantity model
(`max(requested − stock, 0)`), receiving with assignment-scoped authority, derived overdue, audit
and immutable history, tenant isolation.

---

## The numbering boundary

**The extraction this session.** `domain/po-number.mjs` implemented exactly one shape and the
allocator called it directly, so a customer who numbers differently meant editing purchasing.

```
purchasing use case                   application/fulfilment.ts   ← unchanged
        ↓ asks for a number
PoNumberAllocator                     sqlite/ + supabase/ repositories
        ↓ database allocates the sequence value, then
PO number strategy interface          domain/po-number-strategy.mjs   ← the seam
        ↑ implemented by
organization/po-numbering.mjs         JOB_VENDOR_SEQUENCE
        ↑ selected by
organization profile                  purchasing.po_numbering = 'job-vendor-sequence'
```

**A strategy is two functions and nothing else:**

| | Answers |
|---|---|
| `sequenceScope(scope)` | what the counter counts *within* — Lippolis: the (job, vendor) pair |
| `format(components)` | what the finished identifier looks like — Lippolis: `1234-COOPER-1` |

**What stayed on purchasing's side, deliberately.** The sequence value is still allocated by the
database inside the transaction that writes the order — a strategy is handed a number, it never
picks one. Uniqueness is still the `(org_id, po_number)` and `(org_id, job_number, vendor_id,
sequence_value)` constraints. An issued number is still permanent by trigger. Vendor codes, the job
sanitizer and `planSequenceInitialization` stayed in `domain/po-number.mjs`, because they are true
of purchasing wherever it runs.

**Both providers now format with the same function.** The Postgres path used to build the string in
SQL inside `next_po_number_for()`. It still returns one, and that string is now ignored: the adapter
takes the sequence value the function consumed and formats it with the organization's strategy. One
organization's rule is one JS function rather than a JS function and a migration. The SQL expression
is still asserted to match, by `scripts/lib/validate-migration-0016.mjs`, because the older
all-in-one `generate_purchase_order()` RPC still writes it.

**A missing rule is a refusal, never a placeholder.** An organization with no declared numbering
rule, or one naming a rule this build cannot perform, stops the application at startup:

```
purchase order numbering rule "vendor-sequence" is not implemented in this build.
Implemented: job-vendor-sequence. Implement the organization's rule in
organization/po-numbering.mjs — purchasing will not approximate it.
```

There is no fallback rule and no placeholder number. `TEMP-001` on a purchase order leaves the
building on a supplier's paperwork and is reconciled against an invoice months later, by which point
the missing decision has become operational data. Refusing to start is recoverable; fabricated
numbers are not. Asserted three ways: an allocator cannot be constructed without a strategy, a
strategy producing a blank is refused inside the transaction so the consumed sequence rolls back, and
the suite checks that no `TEMP-001` / `UNKNOWN` / `TBD` counter was created by any of it.

**Proved against a synthetic organization**, in `eval-organization-provisioning.mjs`, using a
strategy defined *in the test file* — outside the application entirely:

```js
const SYNTHETIC = definePoNumberStrategy({
  id: 'synthetic-vendor-sequence',
  sequenceScope: ({ vendorId }) => ({ vendorKey: vendorId }),   // not the pair
  format: ({ sequence }) => `SYN-${sequence}`,                   // no job, no vendor, no hyphens
});
```

Two allocators over one database, one per organization. Lippolis issues `1234-COOPER-1`,
`1234-COOPER-2`, `1234-GRAYBAR-1`, `5678-COOPER-1`; the synthetic organization issues `SYN-1`,
`SYN-2`, `SYN-3` on a counter scoped to the vendor. Asking the synthetic organization for job `1234`
does not see, continue or disturb Lippolis's counter, and Lippolis's next number is still
`1234-COOPER-3`.

---

## The capability model

| Layer | Owns | Lives in |
|---|---|---|
| **Capability vocabulary** | The 35 things purchasing can do | `domain/roles.mjs` `PERMISSIONS` — a property of purchasing, not of a customer |
| **Role definitions** | Which roles an organization has | Organization profile |
| **Capability grants** | What each role may do | Organization profile |
| **Membership** | Which organization a person belongs to, and their roles | `users` + `user_roles`, org-scoped |
| **Resolution** | Membership → capabilities | `effectiveCapabilities()` |
| **Enforcement** | May this actor do this? | `authorize()`, server-side, unchanged |

**A profile cannot invent what purchasing can do.** `defineAuthorizationProfile` validates every
granted capability against the domain vocabulary and throws at construction. This caught nine
invented capability names while the synthetic profile was being written.

**Invariants preserved:** identity ≠ membership ≠ role ≠ capability. No `isAdmin`. UI reflects
authority; the server decides it.

---

## What remains Lippolis-specific

| Area | State | Where |
|---|---|---|
| **PO numbering rule** | Extracted. One *implementation* exists — `job-vendor-sequence` — because one organization has told us their rule | `organization/po-numbering.mjs`, selected by profile |
| **Document template** | One `LAYOUT`; schema default `po_template_key = 'lippolis_default'` | `pdf-adapter.ts`, `sqlite/database.ts` |
| **Terminology** | `WORKSHOP` in 8 domain modules — now mostly the *reserved location* concept, since the role-name half is extracted | `roles.mjs`, `navigation.mjs`, `workspaces.mjs`, … |
| **Send vs draft** | Draft-only pinned by a database CHECK constraint | migration `0016` |
| **Timing default** | "Next day" exists as UI copy, not a value | `NewRequestForm.tsx` |
| **Instance data** | Vendors, jobs, people | `seed.ts`, `bootstrap.ts` — correctly isolated |

---

## Customer #2 change surface

For a similar trades business, today. Four questions, answered plainly.

**1. Does their role vocabulary require a purchasing core edit?** **No.** One profile file names
their roles and what each may do. Proved by org-002: five roles sharing no name with Lippolis's six,
every use case authorizing identically, zero core files changed.

**2. Does their PO numbering require a purchasing core edit?** **No — and this is new.** It requires
one new function in `organization/po-numbering.mjs` plus a line in `IMPLEMENTED`, and their profile
naming its id. Nothing in `domain/`, `application/`, the repositories or the screens changes. That is
an adapter, in the same sense the document template is one — with the honest qualifier that
`organization/` lives inside this repository, so it is a code change we make, not a setting they
supply.

**3. Which of the remainder are adapters or configuration?**

| | Kind | What it costs |
|---|---|---|
| Organization identity, vendors, jobs, users, memberships | **Configuration** | data entry |
| Auth provider, storage driver, deployment manifest | **Configuration** | environment values |
| Role names and capability grants | **Configuration** | one profile file |
| PO numbering rule | **Adapter** | two functions and a map entry |
| PO document template | **Adapter** | one `LAYOUT` object |
| Email sending instead of drafting | **Adapter + migration** | the port exists; a CHECK constraint pins draft-only |

**4. Which are genuinely unsupported workflows — not configuration, not adapters?**

- **Approval hierarchy.** Two-stage approval, or approval thresholds by value. PCC has *one*
  approval step and no concept of an amount threshold. This is design work.
- **Stock-location terminology.** `WORKSHOP` is both a concept (the reserved internal location that
  receiving authority is scoped to) and a label, in 8 domain modules. Separating them is a core
  edit — modest, but real.
- **Need-by default.** "Next day" exists as UI copy rather than a value. A copy change, but a core
  file.
- **The quantity rule.** `max(requested − stock, 0)` is fixed, and arguably should stay fixed. A
  business wanting different arithmetic here probably means something else by "purchasing".

---

## Onboarding another company: the numbering step

Discover the company's PO-numbering rule — ask *"show me the last purchase order you wrote by hand"*
— then implement it as an organization-scoped strategy and select it:

1. Write a `definePoNumberStrategy({ id, sequenceScope, format })` in
   `apps/purchasing/src/purchasing/organization/po-numbering.mjs` and add it to `IMPLEMENTED`.
2. Set `purchasing.po_numbering` to that id in their profile under `capability/purchasing/profiles/`.
3. Set `PCC_PO_NUMBERING` to the same id in their environment.
4. Before their first order, initialize any (job, vendor) they already wrote paper purchase orders
   for, in Administration → PO numbering. This cannot be guessed and cannot be undone.

**The purchasing core must not be modified.** If a numbering rule seems to require a change under
`domain/` or `application/`, the seam is wrong and the seam is what to fix. And if the rule is not
known yet, the installation does not start — do not give it a placeholder to run on.

---

## Reuse estimate

**~72% reusable · ~16% configuration · ~12% bespoke.**

Up from 70/15/15, and the movement is the numbering seam alone. **Deliberately a small step**: the
seam removed one customization from the "edit reusable code" column and put it in the "write an
adapter" column. That is worth two or three points, not ten, and inflating it would make the number
useless for planning.

**Evidence:** the profile-honouring score went 68% → **71%** (9 fields fully honoured, 6 partial,
2 hard-coded), measured by `extractionScore()` and asserted by the suite. The provisioning suite grew
45 → **78 checks**, the new ones covering numbering.

**Caveats, and they matter.** This is measured against **one synthetic organization that I
designed**, in the same trade, differing in ways I chose. A business with an approval *hierarchy*
would find coupling this exercise cannot see. Treat ~72% as the ceiling for a similar contractor, not
a general figure — and note that both extractions so far have been the *easy* kind, where purchasing
already computed the right thing and only the vocabulary was fixed. Approval policy will not be.

---

## Remaining extraction candidates, ranked

1. **Terminology** — separate the *concept* (an internal stock location, which receiving authority is
   scoped to) from the *label*. Touches 8 modules for modest benefit; the concept is genuinely
   purchasing's.
2. **Document template** — a template registry. Cheap, but every customer's form differs anyway, so
   a bespoke adapter may stay the right answer.
3. **Approval policy** — not currently a seam at all. The first customer needing thresholds or
   two-stage approval will need real design, not configuration. **The one that will hurt.**

---

## Next recommended extraction

**None. Run the deployment.**

Both couplings that reached across many modules — role vocabulary and numbering — are now behind
seams, and each was justified by a real question a real second customer would ask on day one. What is
left is either confined to one file (the template, the timing copy), genuinely purchasing's
(terminology's concept half, the quantity rule), or design work that cannot be done without a
customer to do it for (approval policy).

The thing standing between this repository and operational proof is still a hostname, and a third
extraction against a synthetic organization I invented would tell us less than one afternoon with a
real second business.
