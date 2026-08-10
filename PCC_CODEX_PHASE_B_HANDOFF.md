# PCC — Phase B Handoff: Practical Purchasing Intelligence

## Status

Phase B is implemented on `codex/pcc-phase-b-intelligence`, stacked on the
Phase A PR branch until PR #12 merges. Phase A's immutable ID + snapshot
architecture is frozen and was not redesigned.

## What changed

- Vendor part number now flows from workshop review to purchase-order line and
  is copied into the immutable completion snapshot.
- Material autocomplete still allows free text, but completed-history matches
  now show completed-order count, last purchase date, and common quantity.
  Choosing a match can prefill description, unit, configured catalog number,
  and an empty quantity on a completely new request.
- Material matches use the existing shared exact → alias → prefix → contains
  tiers, with completed frequency and recency as tie-breakers.
- Review shows two deliberately separate sources:
  - **Observed from completed purchases**, ranked by completed order count and
    then recency, with snapshot vendor name, part number, price, date, and
    common quantity.
  - **Configured default vendor**, resolved from the current vendor directory.
- Reuse is always an explicit button click. No history read automatically
  selects a vendor, approves, orders, or mutates evidence.

## Migration

`supabase/migrations/20260810140316_purchasing_intelligence_phase_b.sql`

The additive migration:

1. Adds nullable `vendor_part_number` to review and order items.
2. Copies the review value on order-item INSERT, including the existing
   `generate_purchase_order` RPC path.
3. Copies the order value into `vendor_part_number_snapshot` only while a new
   immutable history row is inserted.
4. Leaves all Phase A UPDATE/DELETE refusal guards unchanged.

It was applied and smoke-tested in a dedicated temporary PostgreSQL 17
container. The trigger result was `VENDOR-42:VENDOR-42` for order/history.
The container was removed afterward. No hosted Supabase migration was applied.

## Verification

- TypeScript: pass
- Domain: 288 passed
- Authorization: 215 passed
- Provider conformance: 286 passed
- Tenant isolation: 167 passed
- Integration: 255 local + 256 deferred passed
- Web acceptance: 89 passed
- Production build: pass
- Isolated PostgreSQL migration + trigger smoke test: pass

## Manual verification

Run `npm run dev -w purchasing -- --port 3100`, then:

1. Sign in as a workshop purchaser and complete a request after entering a
   vendor part number on its review line.
2. Open `http://localhost:3100/requests/new`, type that completed material, and
   select it. Confirm the new line receives reusable starting values while the
   form remains a new request.
3. Submit it and open `/requests/<new-id>/review`. Confirm the blue **Observed
   from completed purchases** card and violet **Configured default vendor**
   card are distinct, and neither changes the vendor field until its button is
   clicked.
4. Generate the PO and open `/requests/<new-id>/po`; confirm the vendor part
   number appears on the order.

## Remaining risks

- The branch remains stacked on PR #12 until Phase A merges; rebase/retarget it
  to `claude/purchasing-control-center` after that merge.
- Hosted RLS and trigger behavior remain unproven because hosted Supabase was
  intentionally not touched.
- Completed records captured before Phase B correctly retain a null vendor part
  number; this phase does not guess or rewrite old evidence.
- Vendor part number is human-entered text. Authoritative bulk import and
  conflict review remain a later, separately scoped catalog-import task.
- Supabase catalog aggregation is deliberately bounded at 5,000 history rows;
  larger tenants will need the already-documented security-invoker view/RPC
  path rather than silently raising that limit.
