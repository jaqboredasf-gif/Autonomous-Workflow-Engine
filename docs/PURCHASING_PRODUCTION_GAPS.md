# Purchasing — production gap register

What is real, what is written but unproven, and what does not exist. Written to be
disagreed with: if a line here is wrong, fix the line rather than the impression.

Status as of commit `5b35bcc`. Verified locally: **411 automated checks** (165 domain unit,
158 integration, 88 website acceptance) plus a clean production build.

---

## 1. Externally blocked — cannot be verified from this environment

These are not "nearly done". They have **never been executed**, because this machine has no
Supabase project, no Supabase CLI, no Docker and no credentials. Nothing below should be
described to anyone as working.

| Item | State | What is missing |
| --- | --- | --- |
| Supabase migrations 0016 / 0017 | written, parity-linted, **never run** | a project + `supabase db push` |
| Supabase Auth adapter | written and wired behind `AuthPort`, **never contacted a server** | project URL, anon key, service role key |
| Supabase repositories | **do not exist** | the adapter itself — the async boundary it plugs into is done (§2), so this is now writing code rather than changing the application |
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

- **Supabase Auth** (`infrastructure/auth/supabase-auth.ts`): sign-in, password set, disable,
  and the `users.auth_user_id` binding. Selected by `AUTH_PROVIDER=supabase`. Every automated
  check runs against the local provider instead.
- **Migration 0017**: the auth link, job assignments, `purchasing_may_receive()` and the
  receiving policy that answers to assignments. Linted for parity with the app's role and
  permission tables; never applied.
- **Health endpoint's migration check** compares the *pilot* schema version. Against Supabase it
  needs to read `supabase_migrations.schema_migrations` instead.

## 4. Not built (named in the brief, absent in the code)

Ordered by what a pilot would miss first.

| Missing | Consequence today | Brief |
| --- | --- | --- |
| `WORKSHOP_RECEIVER` role; delivery destination type on an order | workshop vs job-site receipt authority is inferred from role and assignment, not declared per order | Phase 10 |
| Statuses `VENDOR_CONFIRMED`, `SHIPPED`, `ARCHIVED`; queue folders for them | the queue groups by the statuses that exist; three named folders cannot exist yet | Phase 8 |
| Job directory (jobs are free text on a request) | no customer, site address, PM, primary/backup foreman, delivery instructions | Phase 5 |
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
| Invoice capture and three-way match | accounting reads receipt evidence only | Phase 18 |
| Tenant configuration (branding, terminology, required fields, templates) | one hard-coded organization seed; the domain itself is free of Lippolis specifics, but the configuration layer does not exist | Phase 19 |
| Security headers, CSRF tokens, upload validation | Next's defaults only | Phase 21 |
| Backup and restore documentation, rollback procedure | the pilot database is a file nobody has a policy for | Phase 22 |

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
