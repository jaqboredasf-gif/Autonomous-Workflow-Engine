# Purchasing — pilot checklist

Work top to bottom. Anything unchecked in §1 means the pilot is a single-machine demonstration,
not a shared system.

## 1. Before real people touch it

Three of these are DONE in the code and are ticked as such. The rest are things somebody has to
do to a hosted environment, and none of them can be ticked from a laptop.

- [x] **Supabase repositories implemented.** The async repository refactor landed; the whole
      workflow runs on Supabase persistence locally, proven by
      `scripts/eval-purchasing-supabase-web.sh` and `scripts/eval-purchasing-e2e.mjs`.
- [x] **Sign-in rate limiting implemented.** Five failures per address in fifteen minutes,
      thirty per source; `apps/purchasing/src/purchasing/domain/throttle.mjs`. The counters live
      in the server process, so on a multi-instance host the effective limit multiplies by the
      number of warm instances — `supabase/migrations/0035_purchasing_sign_in_throttle.sql`
      defines the shared store that fixes that, and nothing calls it yet.
- [x] **The chain runs unaided, locally.** `PILOT_PASSWORD=… node scripts/eval-pcc-operability.mjs`
      drives request → review → printed PO → vendor email → ordered → received → completed as
      four different people, for a job site delivery and for a workshop delivery.
- [ ] Supabase project created; every migration in `supabase/migrations` applied and verified in
      `supabase_migrations.schema_migrations`
- [ ] `AUTH_PROVIDER=supabase`, and a real sign-in performed end to end
- [ ] `SESSION_SECRET` set to 32+ random characters, stored in the host's secret store
- [ ] `PURCHASING_DEMO_MODE` unset; `/api/health` returns `ok`
- [ ] TLS on a private hostname; the URL is not indexed or shared outside the company
- [ ] Backup verified by **restoring** it somewhere, not by taking it

## 2. Configure the company

- [ ] Organization name, address and phone corrected in the seed or admin
- [ ] PO numbering agreed with the office — prefix, digits, and the **next number**, which must
      not collide with numbers already issued on paper
- [ ] Vendors entered with a real ordering contact for each
- [ ] Delivery locations entered (workshop, office, each active job site)
- [ ] The real PO layout mapped into `infrastructure/pdf-adapter.ts` (`LAYOUT`) and printed once
      on paper for someone in the office to approve

## 3. People

- [ ] First administrator bootstrapped (see the deployment guide §6)
- [ ] Mike and Rick invited as `WORKSHOP_APPROVER`
- [ ] Office staff invited as `OFFICE`; approval authority granted only where intended
- [ ] Accounting invited as `ACCOUNTING`
- [ ] Foremen invited as `FOREMAN` **and assigned to their job sites**
- [ ] All demo accounts (`@example.invalid`) disabled
- [ ] Everyone has changed their temporary password

## 4. Prove the chain once, with real data

Run this end to end before anyone relies on it. Stop at the first step that surprises you.

1. [ ] A foreman submits a request from a phone, on a real job number
2. [ ] It appears in the workshop queue within seconds
3. [ ] Mike records stock, picks a real vendor, approves
4. [ ] The PO number is the next one the office expects
5. [ ] The PDF prints correctly on the office printer
6. [ ] The vendor email draft is correct; it is sent from a real mailbox by a person
7. [ ] The order is marked ordered, with tracking
8. [ ] A partial delivery is confirmed on site by the assigned foreman
9. [ ] Office and accounting can see the evidence and the discrepancy
10. [ ] The balance is received; the request completes
11. [ ] The activity timeline reads correctly to someone who was not involved

## 5. Refusals worth testing on purpose

- [ ] A foreman cannot open the workshop queue or administration
- [ ] A foreman cannot confirm another job site's delivery
- [ ] An office user without authority cannot approve
- [ ] A requester cannot approve their own request, or anybody else's
- [ ] An approver **can** approve a request they raised (BR-011), and the approval row is
      stamped `self_approved`
- [ ] A disabled account cannot sign in
- [ ] An expired session returns to sign-in with an explanation

## 6. During the pilot

- [ ] Someone owns the daily check: overdue orders, unresolved partials, missing receipts
- [ ] Every complaint is written down with the request number attached
- [ ] Weekly: read the audit log for refusals — they usually mean a permission is wrong
- [ ] A named fallback: what people do if the site is down (paper, and how it is entered later)

## 7. Before calling it production

- [ ] Everything in `PURCHASING_PRODUCTION_GAPS.md` §1 executed and observed
- [ ] The items in §4 of that register triaged into "pilot can live without" and "must have"
- [ ] Rollback rehearsed once
