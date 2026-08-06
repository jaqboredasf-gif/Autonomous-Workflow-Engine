# Purchasing — async refactor handoff (Checkpoint 1A)

Commit: `5b35bcc`. Baseline: `39160c8`.

The persistence boundary is asynchronous. A Supabase provider can now be written without another
application-wide signature change — which was the entire point, and the reason Checkpoint 1B was
blocked.

---

## What changed

**The rule applied:** async marks a real persistence or external-operation boundary, and nothing
else. Pure domain calculation and every invariant check stayed synchronous. `domain/**` contains
zero `async` and imports no infrastructure.

| Layer | Change |
| --- | --- |
| `domain/repositories.ts` | every method returns `Promise<…>` |
| `infrastructure/sqlite/repositories.ts` | methods are `async`; bodies unchanged, settle in the same tick, no artificial delay |
| `application/ports.ts` | `IdentityPort`, `AuditPort`, `NotificationPort`, `DocumentPort`, `AttachmentPort` async; `UnitOfWork.run` takes an async callback |
| `application/context.ts` | `must`, `allowed`, `loadRequest`, `transitionTo`, `transitionFacts`, `emit` are async |
| `application/*.ts` | all use cases async — 107 call sites |
| `server/service.ts`, `server/session.ts` | facade and identity lookups async |
| `app/**`, `components/Nav.tsx` | 38 facade calls + 6 direct context reads awaited |
| `scripts/eval-purchasing.mjs` | 92 call sites; both assertion helpers await |

**Deliberately still synchronous:** `DocumentRenderer` (PDF rendering is computation),
`EmailDraftPort.compose` (string building), `context()` in the facade (composition, touches no
storage), and every function in `domain/`.

## Interfaces changed

- `PurchaseRequestRepository`, `WorkshopReviewRepository`, `ApprovalRepository`,
  `PurchaseOrderRepository`, `EmailDraftRepository`, `ReceiptRepository`, `InventoryRepository`,
  `ReferenceRepository`, `PoNumberAllocator` — all methods now `Promise`-returning.
- `IdentityPort` — reads and the administrative writes (`createUser`, `setActive`, `setRoles`,
  `setDeliveryReceiver`, `assignJob`, `unassignJob`).
- `AuditPort`, `NotificationPort`, `DocumentPort`, `AttachmentPort`.
- `UnitOfWork.run<T>(fn: () => Promise<T> | T): Promise<T>`.

`AuthPort` was already async and did not change.

## Transaction boundary

`UnitOfWork.run` is the only transaction boundary. The local implementation
(`composition.ts`):

- **nests** — a use case calling another does not open a second transaction;
- **serializes** — every write joins a promise chain, so only one `begin immediate` is ever open.
  With async repositories a second request can otherwise run between one transaction's `await`
  and its `commit` and interleave statements inside it. That is corruption, not latency. Waiting
  is the honest cost of a single-writer store;
- **survives failure** — the queue chains on a settled promise, so a rejected transaction cannot
  poison every write after it.

`inTransaction(db, fn)` was **deleted** from the local store. A synchronous wrapper around
asynchronous calls commits before the work resolves: it looks like a transaction and is not one.

### What each provider can honestly promise

| Provider | Atomicity |
| --- | --- |
| local (SQLite) | real. `begin immediate` … `commit`, serialized in-process, whole callback atomic and isolated. |
| Supabase (1B) | **not from the client.** `supabase-js` has no client-side transaction. Multi-statement atomic units must become a Postgres function called through one RPC, or they are not atomic. Do not simulate. |

Operations that must be atomic, and how 1B should satisfy each:

| Operation | 1B approach |
| --- | --- |
| approval + audit event | `record_purchase_decision()` — already written in migration 0016 |
| PO number allocation + PO creation | `generate_purchase_order()` — already written, allocates under `for update` |
| receipt + quantity/status update | new RPC; the receipt insert and the status transition must not split |
| role assignment + audit | new RPC, or accept a non-atomic pair and say so |
| PO amendment + document version | not built yet (Phase 16) |
| cancellation + unresolved quantity | not built yet (Phase 17) |

The two RPCs that already exist are the reason the migration was written the way it was. Use
them rather than reimplementing their logic in the adapter.

## Concurrency

| Risk | Enforced today | 1B requirement |
| --- | --- | --- |
| duplicate PO numbers | **yes** — compare-and-set on the sequence, inside the transaction; asserted by 8 worker threads × 5 allocations, all distinct | `next_po_number()` holds the row lock; call it inside `generate_purchase_order()` only |
| lost update on a request | **yes** — `version` column, expected-version on every status change, `version_conflict` raised | carry the same `where version = ?` into the adapter; a Supabase update returning 0 rows is a conflict, not a success |
| duplicate email drafts | **yes** — unique `(org_id, draft_key)` | preserve the unique index; treat `23505` as "already exists" and return the existing row |
| simultaneous receipts | **partly** — the over-receipt guard reads current progress inside the transaction | needs the receipt RPC above, or two receipts can both pass the guard |
| approval race | **yes** — expected-version transition | same |
| role assignment races | **no** | last write wins; acceptable, but say so rather than claim otherwise |

## Test results

| Gate | Baseline `39160c8` | After `5b35bcc` |
| --- | --- | --- |
| domain unit | 165 | 165 |
| integration | 158 | 158 |
| website acceptance | 88 | 88 |
| typecheck | clean | clean |
| production build | clean | clean |
| lint | **failing (pre-existing)** | failing — `eslint-config-next` cannot resolve `next/dist/compiled/babel/eslint-parser`; identical on the untouched `apps/web` |

Also verified by hand: route smoke tests (8 protected routes 200, foreman → `/unauthorized`,
anonymous → `/sign-in`), and the full nine-step demo scenario end to end through the async layer.

No assertion was weakened. The two harness helpers became stricter: `refuses()` and `throws()`
now await, because a refusal arriving as an unawaited rejected promise is a passing test and a
broken application.

## Remaining synchronous call sites

Six, all correct:

- `application/context.ts:147-151` — five reads inside one `await Promise.all([...])`. Deliberate:
  independent reads should not queue round trips.
- `server/service.ts:138` — `allocatePoNumber` is an arrow returning the promise to its caller.

Plus, by design: `domain/**` (pure), `DocumentRenderer`, `EmailDraftPort.compose`, `context()`,
`demoAccounts()` (developer tool reading the local store directly).

## Known risks

1. **Write throughput on the local provider.** Serializing transactions is correct and slower.
   Irrelevant at pilot scale; measure before assuming it stays so.
2. **`getDb()` is a module singleton.** Fine for one server; the Supabase adapter must be
   request-scoped instead, since a shared client with a user's JWT across requests would leak
   identity between them.
3. **`seed()` runs on every context construction** (`purchasingRequestContext`). Cheap and
   idempotent locally; it must not be wired into the Supabase path.
4. **Promise.all in `transitionFacts`** issues five reads per transition. Against Postgres that
   is five round trips — consider one RPC returning the facts if it shows up in latency.
5. **No test forces a repository to be genuinely deferred.** Every local repository resolves in
   the same tick, so a missing `await` can hide. A fake provider that resolves on a later tick
   would catch it; worth adding in 1B alongside the parity tests.

## Exact next step for Checkpoint 1B

1. Add a **deferred fake provider** in the harness (resolves on `setImmediate`) and run the
   existing integration suite against it. Any missing `await` fails there and nowhere else.
2. Write `supabasePurchasingContext()` in `infrastructure/supabase/`, implementing the same
   repository interfaces with `@supabase/supabase-js`, request-scoped, carrying the caller's JWT
   so RLS applies to the caller and not to a service role.
3. Route the atomic units through the existing RPCs (`record_purchase_decision`,
   `generate_purchase_order`); add the receipt RPC.
4. Select it in `composition.ts` by configuration, exactly as `authAdapter` already selects
   between Supabase and local.
5. Apply migrations `0001`…`0017` against a real project and run the integration suite twice —
   once per provider — as the parity test.

Nothing in steps 2–5 requires another application-wide signature change. That was the point of
this checkpoint.
