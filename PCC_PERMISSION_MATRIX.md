# PCC Permission Matrix

Who may do what, where it is enforced, and which test proves it.

**The principle this whole model rests on:**

> An identity relationship must not remove authority a user independently
> possesses.

Ownership may **record** a fact (this decision was self-approved), **define** a
permission (`request.update.own` is *about* your own draft), or **widen** access
to a cheaper one (cancel your own request without holding
`request.cancel.any`). It may never subtract. BR-011 and BR-014 are the two
places that rule was broken or misdescribed, and they are fixed the same way:
one capability, plus a scope, and no exceptions carved out per relationship.

- Capability vocabulary: `apps/purchasing/src/purchasing/domain/roles.mjs`
- The decision: `authorize(user, permission, {request, assignedJobNumbers})`
- Parity between code and database: `scripts/lib/validate-migration-0016.mjs`

---

## 1. The two capabilities that carry the business rules

| Capability | Name in code | Resolves to | Rule |
|---|---|---|---|
| APPROVE_PURCHASE | `roles.APPROVE_PURCHASE` → `purchase.request.approve` | `review.decide` | BR-011. Whoever holds it may approve **any** request in their organization, **including their own**. Who raised it is recorded, never consulted. |
| RECORD_RECEIPT | `roles.RECORD_RECEIPT` → `receiving.confirm` | `receiving.record` | BR-014. Whoever holds it may sign for a delivery **within their scope**, regardless of who requested or approved the order. |

The two are **independent**. A foreman receives without approving; an office
approver approves without receiving at the counter being their job. Neither
implies the other, and a test asserts that in both directions.

**Scope** is the only modifier, and it applies to receiving only:

| Who | Receiving scope |
|---|---|
| Field-only users (FOREMAN, REQUESTOR+receiving grant) | The job sites they are assigned to |
| Shop-counter roles (`SHOP_COUNTER_ROLES`: OFFICE, ACCOUNTING, WORKSHOP_APPROVER, ADMIN) | Unscoped — the counter is not a job site |

One definition, in `roles.mjs`, used by `authorize()`, by the receiving index
and by the deliveries index. It used to be three copies.

---

## 2. The matrix

### REQUESTER (`REQUESTOR`)

| | |
|---|---|
| **Capabilities** | `purchase.request.create`, `purchase.request.view`, `purchase.request.edit`. **Neither APPROVE_PURCHASE nor RECORD_RECEIPT.** |
| **Permissions** | `request.create`, `request.read.own`, `request.update.own`, `request.submit`, `request.cancel.own`, `request.respond_clarification`, `request.attach`, `request.note` |
| **Scope** | Their own requests. Editing stops when the workshop takes over (`request_locked`). |
| **Server enforcement** | `authorize()` (`missing_permission` for approval and receiving alike) → `must()` in `requests.ts` → server actions in `app/actions.ts` → route guards in `workspaces.mjs` → RLS `purchase_requests_*`; `purchasing_can()` in every write policy |
| **UI exposure** | `navigationFor()` shows WORK ▸ Requests only. `availableActions()` offers edit/submit/cancel on their drafts. The receiving screen answers `no_capability`. |
| **Tests** | BR-011.1, BR-011.2 (authorization); BR-014.1 (authorization **and** `eval-purchasing.mjs`, server-side refusal); role matrix `REQUESTER.no` list |

### FOREMAN (`FOREMAN`)

| | |
|---|---|
| **Capabilities** | Requester's, **plus RECORD_RECEIPT**. Not APPROVE_PURCHASE. |
| **Permissions** | Requester's + `deliveries.confirm`, `receiving.record` |
| **Scope** | **Assigned job sites only.** `assignedJobNumbers` is resolved server-side from `user_job_assignments` / `purchasing_job_assignments` — never read from the browser. |
| **Server enforcement** | `authorize()` → `ASSIGNMENT_SCOPED` + `isFieldOnly()` → `not_assigned`; `recordReceipt()` in `fulfilment.ts`; RLS `purchase_receipts_write`, `purchase_receipt_items_write`, `purchase_receipt_attachments_write`, all via `purchasing_may_receive()`; RPC `record_purchase_receipt` re-checks it |
| **UI exposure** | WORK ▸ My deliveries and Receiving. `receivableForActor()` / `deliveriesForActor()` list only assigned jobs. Off-scope order → `not_assigned` message naming the scope. |
| **Tests** | BR-014.2, BR-014.3 (authorization + `eval-purchasing.mjs` with Luis, assigned to 24-203); matrix `FIELD_FOREMAN` |

### PURCHASING / WORKSHOP (`WORKSHOP_APPROVER`) — the Mike/Rick role

| | |
|---|---|
| **Capabilities** | **APPROVE_PURCHASE and RECORD_RECEIPT**, plus `purchase.order.create`, `purchase.order.manage`, `purchase.order.mark_ordered` |
| **Permissions** | Office's + `review.read_queue`, `review.record_stock`, `review.set_quantities`, `review.set_vendor`, `review.set_cost`, `review.decide`, `po.generate`, `email.draft`, `email.review`, `order.mark_ordered`, `inventory.adjust`, `request.complete`, `request.cancel.any` |
| **Scope** | Organization-wide. **Unscoped for receiving** — they receive at the shop counter, on any job. |
| **Server enforcement** | `authorize()` with **no ownership test on `review.decide` or `receiving.record`**; `decidePurchaseRequest()`; `recordReceipt()`; RPC `record_purchase_decision` (0028) and `record_purchase_receipt`; RLS via `purchasing_can()` / `purchasing_may_receive()` |
| **UI exposure** | Full WORK group + Purchasing queue. `availableActions()` offers approve/reject/clarify, generate PO, draft email, mark ordered, receive, complete. **Receiving is offered on orders they raised and approved themselves.** |
| **Tests** | BR-011.3, BR-011.4 (approve others / own); BR-014.4, BR-014.5, BR-014.6 (workshop delivery / own request / own approval); end-to-end in `eval-purchasing.mjs` where one person is requester, approver **and** receiver |

### OFFICE (`OFFICE`)

| | |
|---|---|
| **Capabilities** | Requester's + `purchase.request.view.all` + **RECORD_RECEIPT**. **APPROVE_PURCHASE only with the explicit grant** (`users.can_approve`). |
| **Permissions** | Requester's + `request.read.all`, `order.track`, `receiving.record`; with the grant, `APPROVAL_GRANT_PERMISSIONS` (review.*, `review.decide`, `po.generate`, `email.draft`, `email.review`, `order.mark_ordered`) |
| **Scope** | Organization-wide. Unscoped for receiving. |
| **Server enforcement** | Same path. The grant is a column, applied in `permissionsFor()`, mirrored by `purchasing_grant_permissions` in SQL and checked for parity by the migration lint |
| **UI exposure** | WORK ▸ Office, Receiving; DIRECTORY; RECORDS. Approval controls appear **only** with the grant. The sidebar states "Approval authority · granted". |
| **Tests** | "office cannot approve without an explicit grant" / "office WITH the grant can" (domain + integration); BR-011.4b (granted approver approves their own); BR-014.4 (office receives at the counter with no assignment) |

### ADMIN (`ADMIN`)

| | |
|---|---|
| **Capabilities** | All of them, including `user.manage`, `vendor.manage`, `job.manage`, `audit.view` |
| **Scope** | **Their own organization only.** Admin is not a cross-tenant role — the tenant check fires *before* the role check, so an admin of org A is refused org B's records with `cross_tenant`, not with a permission error. |
| **Server enforcement** | Same `authorize()` path; `administration.ts` for user/role/vendor/job writes; RLS `current_org_id()` on every policy; privileged Supabase client used **only after** the application has authorized the caller |
| **UI exposure** | Everything, plus CONFIGURE ▸ Administration. Approval and receiving follow configured authority like anyone else — an admin who receives is recorded as the receiver. |
| **Tests** | "the tenant check fires before the role check, even for an admin"; matrix `ORGANIZATION_ADMIN`; tenant-isolation suites, static and live |

---

## 3. Where enforcement actually lives

Five layers. The first is a courtesy; the rest are controls.

| Layer | File | What it decides |
|---|---|---|
| UI visibility | `domain/navigation.mjs`, `availableActions()`, `receivingAvailability()` | What is *offered*. Derived from `authorize()`, so an offered action always succeeds and an unoffered one always fails. |
| Route guard | `domain/workspaces.mjs` `ROUTE_GUARDS` + `requireAccess()` | Whether a URL opens at all |
| Use case | `application/*.ts` via `must(ctx, actor, permission, request)` | Every mutation, with the record in hand |
| Server action | `app/actions.ts` | Actor comes from the session, never the form |
| Database | RLS policies + `purchasing_can()` / `purchasing_may_receive()`, and SECURITY DEFINER RPCs | The last word, for any client |

**Receiving writes, specifically** (BR-014, migration 0029): the receipt header,
its lines and its evidence all ask `purchasing_may_receive()`. They did not
before — the lines were gated on tenancy alone by a `FOR ALL` policy that also
granted UPDATE and DELETE on an append-only record. A receipt is corrected by
recording another receipt, never by editing one.

---

## 4. What the tests cover

| Suite | Command | Covers |
|---|---|---|
| Authorization | `bash scripts/eval-purchasing-authorization.sh` | The matrix both ways, BR-011 and BR-014 case by case, the ownership-annotation guard, use-case coverage |
| Domain | `bash scripts/eval-purchasing-domain.sh` | `authorize()` decisions, denial vocabulary, capability model |
| Integration | `bash scripts/eval-purchasing.sh` | The same rules against a real database, including the audit rows |
| Isolation | `bash scripts/eval-purchasing-isolation.sh` | Effective RLS policy set across **all** migrations, receiving-write scope, tenant boundaries |
| Live RLS | `bash scripts/verify-supabase-live.sh` | Postgres actually enforcing it, with a negative control |
| End-to-end | `node scripts/eval-purchasing-e2e.mjs` | Four people, one purchase, over HTTP |

**The eleven required cases, and where each is proven:**

| # | Case | Where |
|---|---|---|
| 1 | Requester cannot approve own | BR-011.1 — authorization, domain |
| 2 | Requester cannot approve others | BR-011.2 — authorization, domain |
| 3 | Purchaser can approve own | BR-011.4 — authorization + integration (real DB) |
| 4 | Purchaser can approve others | BR-011.3 — authorization + integration |
| 5 | Requester without RECORD_RECEIPT cannot receive | BR-014.1 — authorization + integration (server-side refusal) |
| 6 | Assigned foreman can receive assigned job | BR-014.2 — authorization + integration |
| 7 | Foreman cannot receive unrelated job when scoped | BR-014.3 — authorization + integration |
| 8 | Mike/Rick purchaser can receive workshop delivery | BR-014.4 — authorization |
| 9 | Purchaser can receive an order they requested | BR-014.5 — authorization + integration |
| 10 | Purchaser can receive an order they approved | BR-014.6 — authorization + integration |
| 11 | Approval and receiving actors correctly audited | BR-011.5 + BR-014.7 — integration, against a real database |

---

## 5. Guards that keep this true

Documentation rots; these do not.

1. **The ownership annotation guard** (`eval-purchasing-authorization.mjs`).
   Every `requestorId === actor.id`-style comparison in the domain and
   application layers must carry an `OWNERSHIP-OK: AUDIT|GRANTS|WIDENS` comment
   at the site. A new one fails the suite until somebody writes down which it
   is — and `DENIES` is not an option.
2. **The migration parity lint.** The *latest* definition of
   `record_purchase_decision()` must gate on `review.decide`, must not refuse
   self-approval, and must stamp `self_approved`. The latest definition of
   `purchasing_may_receive()` must gate on capability **and** job scope, and
   must never reference `requestor_id`, `created_by` or `approver_id`.
3. **The effective-policy scan** (`eval-purchasing-isolation.mjs`). Replays
   every migration in order, keeps the last definition of each policy, and
   checks what the database *actually* enforces — not what the first four
   migrations said.
4. **Negative controls.** Each of the three was verified by introducing the
   defect and confirming the guard fails.
