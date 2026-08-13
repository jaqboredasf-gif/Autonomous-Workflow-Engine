# AWE Purchasing Capability — status

**Measured, not estimated.** Every claim below is backed by a named test or file.

```
node scripts/eval-organization-provisioning.mjs    45 checks — the boundary
node scripts/eval-purchasing-redeployability.mjs   29 checks — the measurement
node scripts/eval-purchasing-authorization.mjs    379 checks — unchanged behaviour
```

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
| **PO numbering** | One hard-coded shape: `job-vendor-sequence`, separator `-` | `domain/po-number.mjs` |
| **Document template** | One `LAYOUT`; schema default `po_template_key = 'lippolis_default'` | `pdf-adapter.ts`, `sqlite/database.ts` |
| **Terminology** | `WORKSHOP` in 8 domain modules — now mostly the *reserved location* concept, since the role-name half is extracted | `roles.mjs`, `navigation.mjs`, `workspaces.mjs`, … |
| **Send vs draft** | Draft-only pinned by a database CHECK constraint | migration `0016` |
| **Timing default** | "Next day" exists as UI copy, not a value | `NewRequestForm.tsx` |
| **Instance data** | Vendors, jobs, people | `seed.ts`, `bootstrap.ts` — correctly isolated |

---

## Customer #2 change surface

For a similar trades business, today:

**Configure** (no code):
- organization identity — `PCC_ORG_NAME`, phone, address
- role names and capability grants — one profile file
- users, memberships, role assignments — through the application
- vendors, jobs — through the application
- auth provider, storage driver, deployment manifest

**Bespoke adapter** (new implementation behind an existing interface):
- PO document template — one `LAYOUT` object
- email sending, if they want it rather than drafts — the port exists; the CHECK constraint needs a migration

**Reusable-core modification** (the honest remainder):
- **PO numbering** — a different rule means editing `po-number.mjs`
- **Terminology** — "workshop" as a reserved location and UI label
- **Timing default** — a copy change

**Zero purchasing core files need modification for the tested role variation.** That was the
session's stopping condition and it holds: org-002 uses five roles sharing no name with Lippolis's
six, and every purchasing use case authorizes identically.

---

## Reuse estimate

**~70% reusable · ~15% configuration · ~15% bespoke.**

Up from the prior session's 65/10/25, and the movement is entirely the role extraction.

**Evidence:** the profile-honouring score went 50% → **68%** (8 fields fully honoured, 7 partial,
2 hard-coded), measured by `extractionScore()` and asserted by the suite. The 45-check provisioning
suite proves the role variation needs no core change.

**Caveats, and they matter.** This is measured against **one synthetic organization that I
designed**, in the same trade, differing in ways I chose. A business with an approval *hierarchy*
(two-stage approval, thresholds by value) would find coupling this exercise cannot see — PCC has
one approval step and no concept of an amount threshold. Treat 70% as the ceiling for a similar
contractor, not a general figure.

---

## Remaining extraction candidates, ranked

1. **PO numbering strategy** — one file, one obvious seam (`formatPoNumber` + the allocator). A
   second customer with a different rule is plausible. **Do this when one asks.**
2. **Terminology** — separate the *concept* (an internal stock location) from the *label*. Touches
   8 modules for modest benefit; the concept is genuinely purchasing's.
3. **Document template** — a template registry. Cheap, but every customer's form differs anyway, so
   a bespoke adapter may stay the right answer.
4. **Approval policy** — not currently a seam at all. The first customer needing thresholds or
   two-stage approval will need real design, not configuration.

---

## Next recommended extraction

**None yet — run the deployment instead.**

The role boundary was the one coupling that reached across many modules and it is done. The other
three are each concentrated in one or two files, and extracting them now would be designing for a
customer who does not exist. The evidence that would tell us which one matters is a second real
customer, and the thing standing between this repository and operational proof is still a hostname.

If forced to name one engineering task: **PO numbering strategy**, because it is the only remaining
item that would require editing reusable core rather than supplying an adapter.
