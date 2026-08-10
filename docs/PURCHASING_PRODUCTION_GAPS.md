# Purchasing — production gap register

What is real, what is written but unproven, and what does not exist. Written to be
disagreed with: if a line here is wrong, fix the line rather than the impression.

Status as of Checkpoint 1E-B. Verified locally: **835 automated checks** — 203 domain,
244 provider conformance, 177 integration (local + deferred), 88 website acceptance,
123 tenant isolation — plus **41 checks against the real website running on Supabase
persistence**, two live SQL security suites, and a clean production build.

---

## 1. Externally blocked — cannot be verified from this environment

This section used to say nothing here had ever been executed. That is no longer true: a local
Supabase stack runs under Docker, every migration is applied to it, and the website has been
driven against it. What remains genuinely unexecuted is anything **hosted**.

The distinction that matters throughout this document: *local Postgres* is real Postgres, with
real row level security, and a result there is a real result. It is not a hosted project, and
a hosted project can differ in configuration, extensions and network policy.

| Item | State | What is missing |
| --- | --- | --- |
| Supabase migrations 0016–0021 | **APPLIED AND VERIFIED** against local Postgres (`bash scripts/verify-supabase-live.sh`). Never applied to a hosted project. | a hosted project + `supabase db push` |
| Supabase Auth adapter | **EXERCISED**: real sign-in, sign-out, wrong password and unknown address, against the local stack's auth server, through the website's own form | a hosted project |
| Supabase repositories | **EXIST AND RUN**: every page of the website reads and writes through them under `PURCHASING_PERSISTENCE=supabase`, scoped by the caller's own access token | behavioural parity with the local provider, case for case |
| Browser-level tenant isolation | **PROVEN LOCALLY**: two provisioned organizations, two signed-in users, 41 HTTP checks including forged org identifiers, swapped tokens, expired tokens and suspended memberships | the same run against a hosted project |
| Supabase Storage | **not implemented**; attachments are stored inline in the pilot database | bucket, policies, signed URL flow |
| Real email delivery | deliberately absent; drafts only, and the schema pins `external_send_enabled = false` | a reviewed decision to send at all |
| Production deployment | never performed | a host, a domain, TLS, credentials |
| Pilot with real Lippolis users | never performed | the above, then people |

## 2. The boundary in front of Supabase persistence — RESOLVED

The repository interfaces were synchronous, so no network-backed provider could implement them.
**That is fixed** (commit `5b35bcc`): every repository and port method returns a Promise, the
transaction boundary is an async, nest-safe, serialized unit of work, and the domain layer stayed
synchronous and pure. All 411 checks pass unchanged, and the demo scenario runs end to end
through the async layer.

What remains is the adapter itself, which is Checkpoint 1B and is written up step by step in
`PURCHASING_ASYNC_REFACTOR_HANDOFF.md`. One thing that surfaced during the refactor and matters
for 1B: **`supabase-js` has no client-side transaction**, so any multi-statement atomic unit must
become a Postgres function called through a single RPC. Two of them already exist in migration
0016 (`record_purchase_decision`, `generate_purchase_order`); the receipt path needs a third.

## 3. Written but unproven (would work, has not been shown to)

- **Password reset and administrative account changes** in `supabase-auth.ts` (`setPassword`,
  `setDisabled`, `requestPasswordReset`). Sign-in is exercised; these three are not. They use
  the service role client, so they are also the paths where a mistake costs the most.
- **Behavioural parity between the two providers.** Both are exercised, but not against the
  same scenario asserting the same outputs. `eval-purchasing-providers.sh` compares them
  statically — shape, arity, number conversion, tenancy — not by result.
- **Migration 0017's receiving policy** (`purchasing_may_receive()`, job-assignment scoping) is
  applied locally and passes the isolation suite, but no website check yet drives a foreman
  receiving against an assignment they do not hold.
- **Health endpoint's migration check** compares the *pilot* schema version. Against Supabase it
  needs to read `supabase_migrations.schema_migrations` instead.
- **Sign-in page branding is fixed to Lippolis Electric.** A Northgate user signs in under a
  Lippolis logo and page title, then lands on their own correctly-isolated data. The isolation
  is real; the branding is not tenant-aware. Cosmetic today, wrong for a second customer.

## 4. Not built (named in the brief, absent in the code)

Ordered by what a pilot would miss first.

| Missing | Consequence today | Brief |
| --- | --- | --- |
| `WORKSHOP_RECEIVER` role; delivery destination type on an order | workshop vs job-site receipt authority is inferred from role and assignment, not declared per order | Phase 10 |
| Statuses `VENDOR_CONFIRMED`, `SHIPPED`, `ARCHIVED`; queue folders for them | the queue groups by the statuses that exist; three named folders cannot exist yet | Phase 8 |
| Job directory — **schema exists (0018), no UI** | `purchase_jobs` holds customer, site, PM, foreman, delivery instructions; nothing creates or edits one yet, and the Supabase `jobs()` reader still returns empty | Phase 5 |
| Vendor directory beyond name/contact | no branch, terms, categories, preferred flag, emergency contact | Phase 6 |
| File upload from the field forms | attachments are modelled, audited and stored, but nothing uploads a photo | Phase 7 |
| Invitations with pending state, resend, last sign-in, session revocation | admin can invite, disable, reset, assign — but there is no invitation lifecycle | Phase 4 |
| Sign-in rate limiting | a password can be guessed as fast as the server answers | Phase 3, 21 |
| Password reset token exchange (`/reset-password`) | the local provider returns a code for an admin to hand over; there is no screen to redeem it | Phase 3 |
| Configurable allowed email domains per tenant | nothing checks the domain of an invited address | Phase 3 |
| Comments and mentions | there is an immutable activity timeline and notes, but no discussion thread | Phase 12 |
| Global search, saved views | each workspace filters its own list; there is no cross-entity search | Phase 14 |
| Duplicate and risk detection | none | Phase 15 |
| PO amendments (`PO-1042-R1`) | a purchase order is immutable and has no revision path | Phase 16 |
| Cancellation, returns, credits | a request can be cancelled; lines, returns and credits cannot | Phase 17 |
| Invoice capture and three-way match — **columns exist (0018)** | `actual_unit_cost`, `actual_line_total`, `actual_total` are in place and always null; nothing writes them | Phase 18 |
| Tenant configuration (branding, terminology, required fields, templates) | one hard-coded organization seed; the domain itself is free of Lippolis specifics, but the configuration layer does not exist | Phase 19 |
| Security headers, CSRF tokens, upload validation | Next's defaults only | Phase 21 |
| Backup and restore documentation, rollback procedure | the pilot database is a file nobody has a policy for | Phase 22 |

## 4a0. Fixed in 1E — four defects only a real database could find

Static analysis called migrations 0016–0019 correct for four checkpoints. Postgres disagreed
four times on first execution:

1. **0018 could not apply at all.** `purchase_line_history` selected a column added later in the
   same file. The migration would have failed on first deploy.
2. **The purchasing schema was unreachable.** Every table had RLS and policies; none was granted
   to `authenticated`. Supabase does not auto-expose new tables, so PostgREST answers
   "permission denied" before RLS is consulted.
3. **`users` has no `email` column.** Purchasing assumed one throughout. The parity lint compared
   table *names*, not columns.
4. **`users.id` has no default — it IS the auth user id.** Provisioning generated a fresh id, so
   every provisioned administrator would have had a profile no signed-in caller resolves to.

And one found by the live security suite itself: a **suspended membership still had access**
through the legacy `users.org_id` fallback. The fallback now serves only users with no
membership row at all.

**Live status:** `tenant_isolation.sql` and `membership_and_provisioning.sql` both PASS under
real RLS, and a negative control (RLS disabled on one table) makes the isolation suite report
three leaks — so the suite can fail, which is what makes the pass mean something.

## 4a-0. Fixed after Phase A — three defects only the live database could show

Migration 0030 was written, reviewed and proven against six offline suites. Applying it to a
real Supabase stack found three things none of them could see.

1. **The table was unreachable.** 0030 created `purchase_history_lines` with RLS and two
   policies and no `GRANT`. Supabase does not auto-expose a new table, so PostgREST answers
   *permission denied* before a policy is consulted. Every refusal check passed while the
   feature was completely unusable on Supabase — and because the history write is inside the
   terminal transition, the failure mode was not "history is missing" but "the purchase cannot
   be completed at all". Fixed in **0031**, which grants `select, insert` and nothing else.
   The isolation suite now proves a tenant can read and write its OWN history, because a suite
   that only proves refusals passes just as well on a table nobody can reach.

2. **`TRUNCATE` ignored every fence.** Row level security does not apply to `TRUNCATE`, and
   `for each row` triggers do not fire for it — and Supabase's default privileges grant it to
   `anon` and `authenticated` on every new table in `public`. Verified against the live stack:
   an ordinary signed-in user of one organization could execute
   `truncate purchase_history_lines` and destroy **every** organization's purchasing history in
   one statement. The same was true of the audit log, the receipts, the approvals and the
   orders — **57 tables**. It predates the immutable history and is not caused by it. Fixed in
   **0032**: the privilege is revoked across the schema and from the default privileges, and the
   append-only evidence tables carry a statement-level `guard_no_truncate()`.

3. **A history row could lie about itself.** 0030's INSERT policy checked the organization and
   that the request had ended. Everything else was taken on trust, so a signed-in user talking
   to PostgREST directly could write, for their own organization, a row attributing the entry to
   a colleague, or claiming a request `COMPLETED` when it was in fact `CANCELLED` — which
   changes whether the line counts as a purchase at all. Neither is a cross-tenant leak; both
   are lies inside a tenant, in the one record that is not re-derivable from anything else.
   Fixed in **0033**: `recorded_by = auth.uid()` and the row's terminal state must equal the
   request's actual status. The same rule is enforced in `application/history.ts` so the pilot
   store, which has no policies, agrees.

All three have negative controls in `supabase/tests/tenant_isolation.sql`: reintroduce the
defect, and the suite reports it.

## 4a-1. Fixed in Phase A — history that rewrote itself

`purchase_line_history` was a **view over live entities**, so it resolved `vendor_id` and the
line descriptions at read time. Renaming a vendor silently changed what every past purchase said
it was bought from; re-describing a material changed what had been bought. Its `INNER JOIN` to
`purchase_orders` also meant a **cancelled or rejected** request never appeared at all, and it
carried no approver, no received/completed timestamps and no damaged/backordered/written-off
breakdown.

Migration `0030_purchasing_immutable_history.sql` drops the view and replaces it with
`purchase_history_lines`: one row per request line, written once at the terminal transition,
carrying the **id and the snapshot** of every entity it names. Append-only by RLS (no UPDATE or
DELETE policy) and by trigger, on both providers. The catalogue's "last ordered from" and "last
price" now read the snapshots instead of joining the live vendor row — the same defect had been
written twice, once per provider.

Verified: the full migration set replays cleanly into an empty database including 0030; the
integration suite renames the vendor, material, job and approver and asserts history does not
move; reverting the read model to the live join makes that assertion fail.

## 4a. Fixed in 1D — a real cross-tenant defect

`purchase_line_history` (added in 1C) was created **without `security_invoker`**. A Postgres view
runs with its owner's privileges by default, so row level security on the underlying tables was
never evaluated for the caller: any authenticated user could have read **every organization's**
purchasing history through it. Fixed in migration 0019, and a test now asserts every view sets
`security_invoker = on`.

Second defect, same migration: plain foreign keys are validated with RLS bypassed, so one
organization could create a row *pointing at* another's vendor, location or request. Sixteen
references are now composite `(id, org_id)`, which makes a cross-tenant pointer unrepresentable
rather than merely hidden.

Third, found by the new isolation suite: **creating an organization does not provision it.**
Migration 0016 seeds settings and number sequences for organizations that existed when it ran;
nothing does so for a tenant added later, so a new tenant cannot raise its first request. This
blocks the SaaS onboarding milestone and belongs in 1E/3A.

## 4b. Added in 1C, schema only (no UX, by instruction)

- Line items carry `org_id` directly, with a trigger forbidding drift and a test asserting no row
  belongs to a different organization than its parent.
- `normalized_description` stored beside the original text; normalization lives in the domain and
  is versioned.
- `purchase_item_catalog` (unique per organization), `purchase_line_history` view — the view was
  replaced by the immutable `purchase_history_lines` table in Phase A (§4a-1).
- `purchase_jobs` directory; job number stays free text on the request on purpose.
- Estimated vs actual cost, where unknown is NULL rather than zero.
- Audit `seq` now has a database default (was a read-modify-write race).
- i18n seam: the domain emits message keys; English helpers remain as labelled fallbacks.

**Not done in 1C, and still owed:** routing approval and PO generation through the existing
Postgres RPCs (they are atomic on the local provider and not on Supabase), the receipt RPC, and
the storage bucket. See `PURCHASING_ASYNC_REFACTOR_HANDOFF.md`.

## 5. Known-good, and why you can believe it

Each of these is asserted by a test that fails if it stops being true:

- authorization decisions, including tenant-before-role ordering, self-approval refusal, and
  the field firewall on requestor payloads (domain unit suite)
- the six quantities never overwriting each other; the suggestion never negative (unit)
- the closed status graph, checked over all 14 × 14 transitions in both directions (unit)
- PO number uniqueness under eight concurrent worker threads (integration)
- draft-only email: no transport exists, and `SENT` is unreachable without a recorded human
  review (unit + integration)
- every workspace boundary over real HTTP, including a forged cookie, an expired session, and a
  foreman who cannot open the workshop queue (website acceptance)
- assignment-scoped deliveries: one foreman cannot see another's job site (website acceptance)

## 6. Readiness

| Question | Answer |
| --- | --- |
| Local implementation readiness | **High.** The end-to-end purchasing loop runs, is tested, and survives a production build. |
| Controlled pilot readiness (real people, one shared server) | **Not yet.** Shared data needs the Supabase adapter and everything in §1. A single-machine pilot on the local provider is possible today but gives one workstation, no backup story, and no rate limiting. |
| Production readiness | **No.** Everything in §1 is unexecuted, and §4 contains work a real purchasing department would notice within a day. |

Anyone reporting this as production-ready is reporting §1 as done. It is not.
