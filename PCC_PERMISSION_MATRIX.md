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

## 1a. The capability vocabulary

Twenty-three coarse names, covering **all thirty-six** permissions. The crosswalk
is total: `capability_crosswalk_total` in the authorization suite fails the build
if a permission is added without a capability that reaches it. A partial
vocabulary is worse than none — it reads as the complete list of what the system
can do, and the eighteen permissions it used to omit were authority nobody could
name in a contract, a role description or on the admin screen.

| Capability | Resolves to |
|---|---|
| `purchase.request.create` | `request.create`, `request.submit` |
| `purchase.request.view` | `request.read.own` |
| `purchase.request.view.all` | `request.read.all` |
| `purchase.request.edit` | `request.update.own` |
| `purchase.request.collaborate` | `request.attach`, `request.note`, `request.respond_clarification` |
| `purchase.request.cancel` | `request.cancel.own` |
| `purchase.request.cancel.any` | `request.cancel.any` |
| `purchase.request.review` | `review.read_queue`, `review.record_stock`, `review.set_quantities`, `review.set_vendor`, `review.set_cost` |
| `purchase.request.approve` | `review.decide` — **APPROVE_PURCHASE** |
| `purchase.request.complete` | `request.complete` |
| `purchase.order.create` | `po.generate` |
| `purchase.order.manage` | `order.track`, `email.draft`, `email.review` |
| `purchase.order.mark_ordered` | `order.mark_ordered` |
| `receiving.confirm` | `receiving.record` — **RECORD_RECEIPT** |
| `delivery.sign_off` | `deliveries.confirm` |
| `inventory.manage` | `inventory.adjust` |
| `accounting.view` | `accounting.read` |
| `accounting.export` | `accounting.packet` |
| `vendor.manage` | `admin.vendors` |
| `job.manage` | `admin.assignments` |
| `user.manage` | `admin.users`, `admin.invite` |
| `audit.view` | `admin.audit` |
| `configuration.manage` | `admin.templates`, `admin.po_config`, `admin.locations`, `admin.settings` |

Three invariants, each asserted:

1. **Total** — every permission is reachable from at least one capability.
2. **Disjoint** — no capability is spelled like a permission. `authorize()` refuses
   an unknown permission, so a capability passed where a permission belongs fails
   closed; that only holds while the namespaces cannot collide.
3. **Never enforced** — no application use case, route guard or navigation rule
   mentions a capability name. The map is a label; `authorize()` takes permissions.
   A capability reaching a call site would be a second, drift-prone gate.

`hasCapability` requires **all** of a bundle's permissions, which is why review
and approve are separate capabilities, and why cancelling your own is separate
from cancelling anybody's — bundling two jobs would report "no" for somebody who
genuinely does one of them.

### Role presets

Seven. Every role in `ROLES` is reachable from at least one, asserted — a role
with no preset can only be assigned by hand.

| Preset | Roles | Approval grant |
|---|---|---|
| `ORGANIZATION_ADMIN` | ADMIN | yes |
| `PURCHASING_MANAGER` | WORKSHOP_APPROVER | yes |
| `OFFICE_COORDINATOR` | OFFICE | **no** |
| `APPROVER` | OFFICE | yes |
| `REQUESTER` | REQUESTOR | no |
| `FIELD_FOREMAN` | FOREMAN | no |
| `ACCOUNTING_READ_ONLY` | ACCOUNTING | no |

`OFFICE_COORDINATOR` closes a real hole: the only OFFICE preset carried the
approval grant, so an administrator setting up a coordinator had to pick
`APPROVER` and then remember to take the grant away. A preset that hands out more
authority than intended unless a second step is remembered is a defect, not a
shortcut. A test now asserts each preset confers approval authority **only** as
declared.

---

## 2. The matrix

### REQUESTER (`REQUESTOR`)

| | |
|---|---|
| **Preset** | `REQUESTER` |
| **Capabilities** | `purchase.request.create`, `purchase.request.view`, `purchase.request.edit`, `purchase.request.collaborate`, `purchase.request.cancel`. **Neither APPROVE_PURCHASE nor RECORD_RECEIPT.** |
| **Permissions** | `request.create`, `request.read.own`, `request.update.own`, `request.submit`, `request.cancel.own`, `request.respond_clarification`, `request.attach`, `request.note` |
| **Scope** | Their own requests. Editing stops when the workshop takes over (`request_locked`). |
| **Server enforcement** | `authorize()` (`missing_permission` for approval and receiving alike) → `must()` in `requests.ts` → server actions in `app/actions.ts` → route guards in `workspaces.mjs` → RLS `purchase_requests_*`; `purchasing_can()` in every write policy |
| **UI exposure** | `navigationFor()` shows WORK ▸ Requests only. `availableActions()` offers edit/submit/cancel on their drafts. The receiving screen answers `no_capability`. |
| **Tests** | BR-011.1, BR-011.2 (authorization); BR-014.1 (authorization **and** `eval-purchasing.mjs`, server-side refusal); role matrix `REQUESTER.no` list |

### FOREMAN (`FOREMAN`)

| | |
|---|---|
| **Preset** | `FIELD_FOREMAN` |
| **Capabilities** | Requester's, **plus RECORD_RECEIPT** (`receiving.confirm`) and `delivery.sign_off`. Not APPROVE_PURCHASE. The two receiving capabilities are distinct: `receiving.confirm` records what arrived, `delivery.sign_off` is the job-site signature. |
| **Permissions** | Requester's + `deliveries.confirm`, `receiving.record` |
| **Scope** | **Assigned job sites only.** `assignedJobNumbers` is resolved server-side from `user_job_assignments` / `purchasing_job_assignments` — never read from the browser. |
| **Server enforcement** | `authorize()` → `ASSIGNMENT_SCOPED` + `isFieldOnly()` → `not_assigned`; `recordReceipt()` in `fulfilment.ts`; RLS `purchase_receipts_write`, `purchase_receipt_items_write`, `purchase_receipt_attachments_write`, all via `purchasing_may_receive()`; RPC `record_purchase_receipt` re-checks it |
| **UI exposure** | WORK ▸ My deliveries and Receiving. `receivableForActor()` / `deliveriesForActor()` list only assigned jobs. Off-scope order → `not_assigned` message naming the scope. |
| **Tests** | BR-014.2, BR-014.3 (authorization + `eval-purchasing.mjs` with Luis, assigned to 24-203); matrix `FIELD_FOREMAN` |

### PURCHASING / WORKSHOP (`WORKSHOP_APPROVER`) — the Mike/Rick role

| | |
|---|---|
| **Preset** | `PURCHASING_MANAGER` |
| **Capabilities** | **APPROVE_PURCHASE and RECORD_RECEIPT**, plus `purchase.request.review`, `purchase.request.complete`, `purchase.request.cancel.any`, `purchase.order.create`, `purchase.order.manage`, `purchase.order.mark_ordered`, `inventory.manage`, and the requester's five. **Not** `configuration.manage`, `accounting.export`, `delivery.sign_off`, or any administration capability. |
| **Permissions** | Office's + `review.read_queue`, `review.record_stock`, `review.set_quantities`, `review.set_vendor`, `review.set_cost`, `review.decide`, `po.generate`, `email.draft`, `email.review`, `order.mark_ordered`, `inventory.adjust`, `request.complete`, `request.cancel.any` |
| **Scope** | Organization-wide. **Unscoped for receiving** — they receive at the shop counter, on any job. |
| **Server enforcement** | `authorize()` with **no ownership test on `review.decide` or `receiving.record`**; `decidePurchaseRequest()`; `recordReceipt()`; RPC `record_purchase_decision` (0028) and `record_purchase_receipt`; RLS via `purchasing_can()` / `purchasing_may_receive()` |
| **UI exposure** | Full WORK group + Purchasing queue. `availableActions()` offers approve/reject/clarify, generate PO, draft email, mark ordered, receive, complete. **Receiving is offered on orders they raised and approved themselves.** |
| **Tests** | BR-011.3, BR-011.4 (approve others / own); BR-014.4, BR-014.5, BR-014.6 (workshop delivery / own request / own approval); end-to-end in `eval-purchasing.mjs` where one person is requester, approver **and** receiver |

### OFFICE (`OFFICE`)

| | |
|---|---|
| **Presets** | `OFFICE_COORDINATOR` (no grant) and `APPROVER` (with the grant). Two presets, one role — the grant is the only difference, and it is declared rather than remembered. |
| **Capabilities** | Requester's + `purchase.request.view.all` + **RECORD_RECEIPT**. With the grant, additionally `purchase.request.review`, **APPROVE_PURCHASE**, `purchase.order.create`, `purchase.order.manage`, `purchase.order.mark_ordered`. The grant confers purchasing authority, **not** `purchase.request.complete`, `purchase.request.cancel.any` or `inventory.manage` — those stay with the workshop role. |
| **Permissions** | Requester's + `request.read.all`, `order.track`, `receiving.record`; with the grant, `APPROVAL_GRANT_PERMISSIONS` (review.*, `review.decide`, `po.generate`, `email.draft`, `email.review`, `order.mark_ordered`) |
| **Scope** | Organization-wide. Unscoped for receiving. |
| **Server enforcement** | Same path. The grant is a column, applied in `permissionsFor()`, mirrored by `purchasing_grant_permissions` in SQL and checked for parity by the migration lint |
| **UI exposure** | WORK ▸ Office, Receiving; DIRECTORY; RECORDS. Approval controls appear **only** with the grant. The sidebar states "Approval authority · granted". |
| **Tests** | "office cannot approve without an explicit grant" / "office WITH the grant can" (domain + integration); BR-011.4b (granted approver approves their own); BR-014.4 (office receives at the counter with no assignment) |

### ACCOUNTING (`ACCOUNTING`)

| | |
|---|---|
| **Preset** | `ACCOUNTING_READ_ONLY` |
| **Capabilities** | `purchase.request.view`, `purchase.request.view.all`, `accounting.view`, `accounting.export`. **Four, all reads.** Neither APPROVE_PURCHASE nor RECORD_RECEIPT, and not `purchase.request.collaborate` — accounting may leave a note but may not attach evidence or answer a clarification, so the bundle correctly reports "no". |
| **Permissions** | `request.read.own`, `request.read.all`, `request.note`, `accounting.read`, `accounting.packet` |
| **Scope** | Organization-wide, read-only. |
| **Server enforcement** | `authorize()` → `must()` in `queries.ts` and `integrations.ts`; every write path refuses with `missing_permission`. `order.track` is deliberately **absent** — it reads like a view permission and is not one: the only thing that checks it writes a carrier and tracking number onto a shipment accounting is supposed to be auditing. |
| **UI exposure** | RECORDS ▸ Accounting and Reports. No approve, order, receive or configure control is ever offered. |
| **Tests** | "ACCOUNTING holds no write permission" — asserted as a **property** over `PERMISSIONS`, not a list, so a permission added later cannot quietly land in it; matrix `ACCOUNTING_READ_ONLY` yes/no lists |

### ADMIN (`ADMIN`)

| | |
|---|---|
| **Preset** | `ORGANIZATION_ADMIN` |
| **Capabilities** | **All twenty-three**, including `user.manage`, `vendor.manage`, `job.manage`, `audit.view` and `configuration.manage`. Asserted against the full vocabulary rather than a sample: `ADMIN_PERMISSIONS` is `PERMISSIONS`, so a capability an admin does **not** hold is a broken bundle, and the test says so. |
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
| Authorization | `bash scripts/eval-purchasing-authorization.sh` | The matrix both ways, BR-011 and BR-014 case by case, the ownership-annotation guard, use-case coverage, and the four capability invariants (§5.5) |
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
5. **The capability invariants** (`eval-purchasing-authorization.mjs`). Four,
   each of which failed silently before it existed:
   - `capability_crosswalk_total` — every permission is reachable from a
     capability. Adding a permission without one fails the build.
   - **disjoint namespaces** — no capability is spelled like a permission, so a
     capability passed where a permission belongs still fails closed at
     `authorize()`.
   - **never enforced** — no use case, route guard or navigation rule mentions a
     capability name. The map is a label, not a second gate.
   - **every role is provisionable** — each role in `ROLES` is reachable from at
     least one preset, and each preset confers approval authority only as
     declared. This is what `OFFICE_COORDINATOR` closed.

   The vocabulary itself is locked to an explicit list, so adding or renaming a
   capability updates a test line rather than drifting between releases.
