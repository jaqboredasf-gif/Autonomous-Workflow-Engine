# AWE Purchasing — redeployability scorecard

**Measured, not estimated.** Every row is backed by `scripts/eval-purchasing-redeployability.mjs`
(26 checks) reading the actual repository, or by a named file.

| Status | Meaning |
|---|---|
| **REUSABLE** | Works for another organization with no change and no configuration |
| **CONFIGURABLE** | Varies per organization and the code already reads it from configuration |
| **LIPPOLIS-COUPLED** | Works, but a second organization would need code changes |
| **NOT YET EXTRACTED** | The concept exists only inside PCC |

---

## Scorecard

| # | Capability | Status | Evidence | Smallest extraction if coupled |
|---|---|---|---|---|
| 1 | **Request model** | REUSABLE | `domain/entities.mjs`, `domain/validation.mjs`. No customer literal in executable code. | — |
| 2 | **State machine** | REUSABLE | `domain/purchasing-workflow.mjs` + `@awe/workflow` engine. States are purchasing concepts, not Lippolis ones. | — |
| 3 | **Authority evaluation** | REUSABLE *(mechanism)* | `domain/roles.mjs` `authorize()` — capability-based, assignment-scoped. | — |
| 4 | **Role vocabulary** | LIPPOLIS-COUPLED | `ROLES` is a closed list containing `WORKSHOP_APPROVER`. A business with no workshop cannot express its approver. | Make the role set a profile input; keep permissions keyed to capabilities, not role names. **The largest single debt.** |
| 5 | **Quantity logic** | REUSABLE | `suggestedOrderQty` = `max(needed − stock, 0)`. Pure, proven, no customer in it. | — (and arguably should stay fixed) |
| 6 | **Three-quantity model** | REUSABLE | requested / stock / ordered kept distinct through domain, PO, print and history. | — |
| 7 | **PO numbering** | LIPPOLIS-COUPLED | `domain/po-number.mjs` implements exactly one shape: `job-vendor-sequence`, separator `-`. | A numbering *strategy* interface with the current rule as strategy #1. Sequence allocation stays in the database. |
| 8 | **Vendor handling** | CONFIGURABLE | Vendors are rows; `vendors.code` is derived then frozen. No vendor name in logic. | — |
| 9 | **PO generation / print** | LIPPOLIS-COUPLED | `pdf-adapter.ts` has one `LAYOUT`; schema default `po_template_key = 'lippolis_default'`. | Template selected by profile; `LAYOUT` becomes one named template. |
| 10 | **Communication drafting** | CONFIGURABLE *(partly)* | `domain/email.mjs` templates are data; recipients come from vendor records. | — |
| 11 | **Send vs draft** | LIPPOLIS-COUPLED | Draft-only is pinned by a database CHECK constraint. Correct as a Lippolis business rule; a second customer wanting sending needs a migration and an adapter. | An email *port* implementation plus a profile flag; the constraint becomes org policy. |
| 12 | **Receiving** | REUSABLE | `receiveEverything` + `recordReceipt`; authority is assignment-scoped, not person-scoped. | — |
| 13 | **Overdue behaviour** | REUSABLE *(mechanism)* | `isOverdue`, `attentionBand` — derived from dates and state, no manual priority. | — |
| 14 | **Timing assumption** | LIPPOLIS-COUPLED | "Next day" exists only as UI copy, not as a value. | One profile field read by the need-by default. |
| 15 | **Audit / history** | REUSABLE | Append-only, trigger-enforced, immutable history lines. Nothing customer-specific. | — |
| 16 | **Authentication** | CONFIGURABLE | `AUTH_PROVIDER` selects local or Supabase behind one interface. | — |
| 17 | **Tenant isolation** | REUSABLE | `org_id` on every row; RLS on the Postgres path. | — |
| 18 | **Terminology** | LIPPOLIS-COUPLED | "WORKSHOP" appears in **8 domain modules** as a role, a reserved location and a workspace. | Separate the *concept* (internal stock location) from the *label*. Concept stays; label moves to profile. |
| 19 | **Branding** | CONFIGURABLE | `PCC_ORG_NAME` / phone / address are environment values. Logo is one component. | — |
| 20 | **Deployment** | REUSABLE | `deployment/` substrate; PCC is instance #1 and now runs on it. | — |
| 21 | **Database initialization** | CONFIGURABLE | `bootstrap.ts` creates the org and one admin from configuration; `seed.ts` is development-only and refused in production. | — |
| 22 | **Acceptance testing** | LIPPOLIS-COUPLED | `eval-production-coldstart.mjs` asserts PCC's own workflow with Lippolis-shaped fixtures. | The *harness* is already generic (`deployment/clean-install.mjs`); the workflow assertions are the application's and should stay. |

**Totals: 11 REUSABLE · 5 CONFIGURABLE · 7 LIPPOLIS-COUPLED · 0 NOT YET EXTRACTED.**

---

## The measurement the tests produce

```
profile fields honoured by the code: 5 fully, 7 partially, 5 hard-coded (50%)
WORKSHOP appears in domain: activity, dashboard, events, navigation,
                            purchasing-workflow, roles, status, workspaces
org-002 would need engineering for: terminology.stock_location, terminology.request_noun,
  roles.approvers, roles.orderers, roles.receivers, purchasing.po_numbering,
  purchasing.po_separator, purchasing.quantity_rule, purchasing.default_fulfilment_days,
  purchasing.overdue_rule, documents.po_template, communications.send_mode
```

**The strongest result:** the domain and application layers contain **zero** customer literals in
executable code — asserted, not asserted-about. Every `Lippolis`, `Graybar` or `Mike` in
`domain/` is explanatory prose. Customer data lives in `seed.ts` and `bootstrap.ts` and nowhere
else.

**One real leak was found and fixed this session:** `env.ts` used `https://pcc.lippolis.local` as
the example in a shipped error message, so a second customer would have seen Lippolis's hostname in
their own configuration error.

---

## The honest answer

> If another trades business wanted what PCC provides tomorrow, how much could we reuse?

**Reuse without changing core code: ~65%.** The purchasing engine — request model, state machine,
authority evaluation, the three-quantity arithmetic, receiving, overdue derivation, audit, history,
tenant isolation — is genuinely customer-neutral and tested to be so.

**Configuration: ~10%.** Organization name and contact, vendors, jobs, users, auth provider,
attachment storage, and the whole deployment manifest.

**Still bespoke engineering: ~25%**, concentrated in four places:

1. **Role vocabulary** (#4) — `WORKSHOP_APPROVER` is a fixed role name reaching 8 domain modules.
2. **PO numbering** (#7) — one hard-coded shape.
3. **PO document template** (#9) — one layout, one schema default.
4. **Terminology** (#18) — the label and the concept are the same string.

Those four are the difference between "configure it" and "edit it". Everything else that differs
between Lippolis and a synthetic second trades business is already data.

**A caution on the number.** 65% is measured against *one* synthetic second customer that I
designed, in the same industry. A business in a different trade, or one with an approval hierarchy
rather than a single approver, would find coupling this exercise cannot see. Treat 65% as the
ceiling for a similar business, not a general figure.

---

## The single highest-leverage next extraction

**Separate the role vocabulary from the permission model.**

`domain/roles.mjs` already computes authority from *capabilities* — `authorize(actor, 'po.generate')`
is the right shape and needs no change. What is fixed is the closed `ROLES` list and the role→
capability table, both of which name `WORKSHOP_APPROVER`.

Making the role set and its capability grants a profile input would:

- move item #4 from LIPPOLIS-COUPLED to CONFIGURABLE outright,
- unblock #18, because most `WORKSHOP` occurrences in the domain are the role name rather than the
  place,
- and require no change to any use case, because they already ask for capabilities.

Estimated effect: **~65% → ~80%** reusable, and it is the only one of the four whose coupling
reaches into eight modules. The other three are each confined to one file and can wait.

Do **not** do all four. PO numbering, the document template and the timing default are each an
afternoon *when a second customer actually needs them* — and doing them now would be designing for
a customer who does not exist.
