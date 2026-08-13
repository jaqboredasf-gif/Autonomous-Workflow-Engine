# AWE Purchasing Capability — contract v0

What purchasing fundamentally does, extracted from a working implementation rather than designed
in advance. Every action below is proven at Lippolis.

**Run the measurement:** `node scripts/eval-purchasing-redeployability.mjs` (26 checks).
**The scorecard:** `AWE_PURCHASING_REDEPLOYABILITY.md`.

---

## The lifecycle

```
PurchaseRequest → Review → Approval → PurchaseOrder → Placement → Receiving → Completion
```

States (`domain/status.mjs`, 14 total): `DRAFT · SUBMITTED · PENDING_WORKSHOP_REVIEW ·
CLARIFICATION_REQUESTED · RESUBMITTED · APPROVED · REJECTED · PO_GENERATED · EMAIL_DRAFTED ·
ORDERED · PARTIALLY_RECEIVED · RECEIVED · COMPLETED · CANCELLED`.

**Terminal states are terminal.** A correction after completion is a new request, never an edit.

---

## The three quantities

The distinction that carries the most business weight, and the one a second implementation would
most likely get wrong:

| Quantity | Meaning | Mutable by |
|---|---|---|
| **requested** | What the job needs | The requester, before submission. Never afterwards. |
| **stock on hand** | What the organization already holds internally | The reviewer |
| **ordered** | What the vendor is actually sold | Derived: `max(requested − stock, 0)`; overridable |

`requested` is immutable after submission — entering stock never rewrites what the job asked for.
All three are snapshotted onto the purchase order, so the arithmetic stays explicable years later.

---

## Actions

Each is a real function in `application/`. `policy` names where an organization may differ.

### `submit_request(request)`
- **input** job identifier, line items (description, quantity, unit), need-by
- **authority** `request.create`
- **transition** `DRAFT → SUBMITTED`
- **persists** request + immutable line items
- **audit** `request.submitted`
- **policy** need-by default; whether a reason is required *(Lippolis: not required)*

### `record_stock_and_decide(request, lines, decision)`
- **input** stock on hand per line, optional order-quantity override, vendor
- **authority** `review.record_stock`, `review.decide`, `review.set_vendor`
- **transition** `PENDING_REVIEW → APPROVED | REJECTED | CLARIFICATION_REQUESTED`
- **persists** review lines; inventory observation; stock-applied adjustment
- **audit** `review.saved`, `decision.approved`
- **policy** who may approve; whether a price is required at approval *(Lippolis: no)*

### `generate_purchase_order(request)`
- **authority** `po.generate`; request must be `APPROVED`
- **transition** `APPROVED → PO_GENERATED`
- **persists** order + snapshot of job, vendor code, sequence; renders and stores the document
- **audit** `po.generated`
- **idempotent** asking twice returns the same number and burns no sequence value
- **policy** **numbering rule**; document template

### `draft_vendor_communication(order)`
- **authority** `email.draft`
- **transition** `PO_GENERATED → EMAIL_DRAFTED`
- **policy** channel; **draft vs send** *(Lippolis: draft-only, enforced in the schema)*

### `mark_ordered(request)`
- **authority** `order.mark_ordered`; requires the communication to have been dealt with
- **transition** `EMAIL_DRAFTED → ORDERED`
- **persists** `ordered_at`, actor
- **audit** `order.placed`
- **idempotent** a second press is refused by the state machine, not by a dialog

### `receive(request, lines?)`
- **authority** `receiving.record`, **scoped to assignment**
- **transition** `ORDERED → PARTIALLY_RECEIVED | RECEIVED`
- **persists** receipt + lines; inventory adjustments
- **policy** who may receive; whether partial receipt is offered

### `complete(request)`
- **authority** `request.complete`
- **transition** `RECEIVED → COMPLETED`
- **persists** **immutable history lines** — the record that outlives the request
- **note** receiving authority is deliberately wider than completion authority

---

## Organization policy hooks

Modelled in `profile.mjs`, instantiated in `profiles/`. Each field records whether the code
actually honours it today — `yes`, `partial`, or `no`.

Currently **5 honoured, 7 partial, 5 hard-coded (50%)**. That number is asserted by the test suite
so it cannot silently regress, and is expected to rise as extraction proceeds.

---

## What is deliberately NOT configurable

- **The state machine.** A business needing a different purchasing lifecycle needs a different
  capability, not a longer profile.
- **`max(requested − stock, 0)`.** Proven, and a business that wants different arithmetic here
  probably means something else by "purchasing".
- **Immutability of issued PO numbers, and of history.** These are invariants, not preferences.
- **Capability-based authority.** *Which* roles exist should become configurable; *that* authority
  is computed from capabilities rather than identity should not.

---

## The redeployment package

| Piece | State |
|---|---|
| Domain model, state machine, quantity logic | **Exists, reusable** |
| Authority evaluation | **Exists, reusable** — role *vocabulary* is not |
| Audit / history | **Exists, reusable** |
| Document interface | **Partial** — one template, one layout |
| Communication interface | **Partial** — port exists, send-mode pinned in schema |
| Organization policy schema | **Exists** (`profile.mjs`), 50% honoured |
| Deployment requirements | **Exists** (`deployment/`) — PCC is instance #1 |
| Acceptance tests | **Partial** — harness generic, assertions application-specific |
| Organization profile | **Exists**, two instantiated |
| Vendor / job / user data | **Instance data**, entered through the application |
