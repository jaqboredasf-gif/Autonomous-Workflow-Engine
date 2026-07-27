# Approval Queue UI (Task B5)

Contract, rules and evidence for the B5 slice. Vocabulary:
docs/architecture/UBIQUITOUS_LANGUAGE.md. Upstream contract:
docs/testing/APPROVAL_MATRIX.md (B3) and `supabase/migrations/0015_approval_matrix_outbound.sql`.
Roles: STAKEHOLDERS_AND_PERMISSIONS.md.

## What B5 is

The human end of the B3 pipeline: `/approvals` in `apps/web`, where every drafted
customer- or crew-facing message waits for a named human to **approve** or
**reject** it. It reads `outbound_messages` through RLS with the signed-in user's
own JWT and writes exactly one thing: 0015's `record_approval()` RPC.

Three files carry it:

| File | Role |
| --- | --- |
| `apps/web/src/lib/approval-queue.ts` | **All decidable logic**, pure and framework-free. No React, no Supabase client, no fetch, no clock. Runner 5 tests this module directly. |
| `apps/web/src/app/approvals/page.tsx` | The shell: fetch, the five view states, layout, two buttons. Calls nothing the pure module did not return. |
| `apps/web/src/components/Nav.tsx` | The `Approvals` nav entry. |

## What B5 is NOT (hard boundaries this slice does not cross)

- **No send action.** `mark_message_sent()` is never called, imported or
  referenced. Approving records a decision; a human sends from Outlook and that
  is recorded elsewhere. Runner 5 asserts this structurally over both source
  files.
- **No second approval system.** Every guard the UI applies is already enforced
  by 0015 + RLS. The UI decides what to *offer*; the database decides what
  *happens*. When they disagree the database wins and the page shows the raised
  error verbatim.
- **No bypass around the gate.** The only write is `record_approval()`.
  `outbound_messages` has no client insert/update/delete policy at all, so a
  direct PATCH from the browser writes nothing (slice 5 check 9).
- **No RLS weakening, no service-role key in the browser.** The page holds the
  publishable anon key and the user's JWT. No new policy, no new RPC, **no
  migration** — B5 changed zero database objects.
- **No new draft creation.** `create_outbound_draft()` is not called here either;
  the queue only decides on what already exists.

## Data contract

`QUEUE_SELECT` in `approval-queue.ts` is the single definition of the queue's
projection — the page and `scripts/acceptance-slice5.sh` both use that exact
string, so an acceptance test cannot drift from what the UI actually asks for.

It reads `outbound_messages` plus four embeds, each of which has an org-scoped
admin SELECT policy:

- `message_policies` — the matrix row that routed the message (approval evidence)
- `work_requests` → `email_messages!work_requests_email_message_id_fkey` — the
  requester and the mail the request was born from. The FK hint is required:
  those two tables have **two** relationships.
- `users` three times, via `outbound_messages_approved_by_fkey` /
  `_rejected_by_fkey` / `_sent_marked_by_fkey` — the named humans.

Runner 5 parses `QUEUE_SELECT` and resolves every column and FK hint against the
migrations offline, so a typo fails in regression instead of as a PostgREST 300
in a browser.

### What the queue shows per message

requester · recipient · message type · amount (when the type carries one) ·
approval owner (`assigned_approver_role`) · escalation state (`escalated`,
`routing_path`, `escalation_reason`) · created/updated/decision timestamps ·
blocked reason · the matrix row that routed it · the full draft subject + body ·
the originating work request · audit history · TEST/production provenance.

### Audit history without the event log

`integration_events` is declared service-role-only (0009: RLS on, no client
policies). Reading it from the browser would require weakening that or shipping a
service-role key to the client, so B5 does neither: `buildAuditTrail()`
reconstructs the history from the message row's own **write-once** attribution
columns (`created_at`, `escalated`/`escalation_reason`, `approved_by`/`approved_at`,
`rejected_by`/`rejected_at`/`rejection_reason`, `sent_at`/`sent_marked_by`,
`blocked_reason`). Those are the same facts the `message.*` events carry, and
0015's transition guard makes them set-once. The event log stays the system of
record for n8n and for the acceptance slices, which read it as service role.

> **Live-drift caveat (found by slice 5, 2026-07-26):** the live database
> currently carries four *undeclared* policies on `integration_events`
> (`org_select` / `org_insert` / `org_update` / `org_delete` for `authenticated`)
> that no migration in this repo creates. A plain `worker` can read and DELETE
> audit events today. The queue is unaffected **because it never reads that
> table**, but the drift is a real finding — TASK_BACKLOG **S1**.

## Decision rules (`decisionGuard` / `planDecision`)

Ordered, fail-closed, every refusal named. `GUARD_REASONS`:

| Reason | When | Mirrored in the DB by |
| --- | --- | --- |
| `not_pending` | status is not `draft` — already approved/rejected/sent, or blocked | `record_approval`: "only a draft can be decided" |
| `unassigned_approver` | a draft with no `assigned_approver_role` (routing could not name an owner) | `business_role_matches(uid, null)` = false |
| `unauthorized_approver` | the signed-in human does not hold the assigned role | `record_approval`: "does not hold the approver role" |
| `test_mode_violation` | TEST mode and the row is not fixture-safe | `enforceTestMode()` (B3 engine, imported not restated) |
| `fixture_in_live_mode` | LIVE mode and the row is a fixture | — UI-only; a fixture must never be approved as real |
| `missing_rejection_reason` | reject with an empty/whitespace reason | `record_approval`: "a rejection must record a reason" |
| `unknown_decision` | a verb outside `{approve, reject}` | `record_approval`: "unknown decision" |

`planDecision()` returns the exact RPC payload or `null`. **A refused decision
has no payload**, so nothing leaves the browser — Runner 5 asserts that on every
refusing fixture.

### Duplicate-decision protection

Two independent layers: `DECIDABLE_STATUSES = ['draft']` in the UI, and the
status/transition guard in 0015. Runner 5 asserts the invariant over *every*
value of the `outbound_message_status` enum, not just the ones a fixture happens
to use; slice 5 proves it live over PostgREST (checks 6b, 7c).

### Unauthorized approvers

The UI never re-implements the role mapping. After a load it calls 0015's
`business_role_matches(auth.uid(), <role>)` once per distinct approver role in
view — the same function `record_approval()` will call. An unresolved capability
(RPC error, no session) counts as **not held**.

### TEST mode

`resolveQueueMode({ AWE_MODE: process.env.NEXT_PUBLIC_AWE_MODE })`, reusing the
B3 engine's `resolveMode`: **TEST unless explicitly `LIVE`**. The mode is shown
in the header, every fixture row is badged `test`, and the guard is symmetric —
in TEST only fixture rows addressed to `@example.invalid` are decidable; in LIVE
a fixture is not decidable at all.

### Deterministic refresh

A decision is not believed because the RPC returned. The page re-reads the queue
and `verifyDecisionApplied()` checks the row actually moved to the expected
status; a row that stayed in `draft`, or vanished, is reported as a failure in
the live region. (Same posture as B2's Verify Step.)

## View states

`queueState()` decides which of five screens is showing: `loading`,
`signed_out`, `error` (failed fetch or an RLS refusal), `empty`, `ready`. Null
rows read as `empty`, never as `ready`.

## Accessibility + responsive

Single `aria-live="polite"` region for every success/failure message; tabs are
buttons with `aria-pressed`; the table has a `<caption>` and `scope="col"`
headers; the rejection reason has a real `<label>`, `aria-invalid` and
`aria-describedby` wired to its error, and focus moves to it when the reason is
missing; refusals are stated in visible text, never only in a `title`. Layout is
a single column that becomes a two-column grid at `lg`; the table scrolls inside
its own `overflow-x-auto` container.

## Runner 5 — `scripts/eval-approval-queue.sh`

Pure offline: no keys, no DB, no network, no browser. Node 24 strips TypeScript
types on import, so the runner tests **the module the page ships**, not a copy.
Fixtures: `fixtures/queue/` (19 labelled cases over `base-row.json`; every case
states only the fields it is testing).

Hard gates: label parity (guard verdict *and* RPC payload) · determinism ·
guard-reason coverage 7/7 · duplicate-decision invariant across every status ·
authorization (role not held / capability unresolved / no session) · required
rejection reason (empty and whitespace) · TEST mode in both directions · the five
view states incl. failed fetch and empty queue · refresh verdict · audit-trail
ordering and attribution · `QUEUE_SELECT` schema + FK-hint resolution against the
migrations · enum parity with 0015 (`outbound_message_status`, `business_role`,
`outbound_message_type`) · source purity (no send call, no draft creation, no
service-role/management credential, no hard-coded JWT, no mail transport, no
direct write to `outbound_messages`, no read of `integration_events`, only the
two expected RPCs, and the page must route decisions through `planDecision` and
verify them afterwards).

## Slice 5 — `scripts/acceptance-slice5.sh`

Live, against the browser's real credentials (anon key + the signed-in user's
JWT), 27 checks. What only this slice can prove: the FK hints and the two-level
embed resolve; an admin's own JWT reads the queue while anon and the fixture
`worker` read zero; `business_role_matches` answers over the browser path;
`record_approval()` enforces the reason, the role and one-decision-per-message
against those credentials; a blocked message is visible but undecidable; a direct
PATCH writes nothing. Sends nothing — every recipient is `@example.invalid`,
`mark_message_sent()` is never called, and checks 10/10b assert it.

## Evidence (2026-07-26)

- Runner 5: `passed=325 failed=0`, 19 fixtures, guard-reason coverage 7/7.
- Non-vacuity by perturbation: adding `'approved'` to `DECIDABLE_STATUSES` → 6
  failures; removing the reason `.trim()` → 4 failures. Both restored, green.
- Slice 5: `passed=27 failed=0`, green on two consecutive full-regression runs
  (it namespaces each run's `draft_key`, so it is re-runnable).
- Full regression **ALL GREEN** twice: mobile tsc, web build (15 routes), MCP 10
  tools, slices 1–5 (9 + 10 + 20 + 49 + 27), Runner 1 24/24, Runner 2A 20/20
  (accuracy 12/12), Runner 3 120/0, Runner 4 314/0, Runner 5 325/0, 0014 + 0015
  lints PASS.
- Drift check clean: 24 live base tables, unchanged — **B5 made zero database
  changes**.

## Limits / deliberate exclusions

- **Approve/reject only.** No "mark sent" action, no bulk decisions, no editing a
  draft before approving (0015 freezes content once a message leaves `draft`;
  a correction is a new draft, which is a drafting concern, not a queue one).
- **No requests inbox.** TASK_BACKLOG B5 named two pages; this slice ships the
  approval queue only. The requests-list page is carried forward (B5b) — the
  approval queue is the one that gates outbound messages, so it is the half that
  earns its keep first.
- **Realtime is polling-free.** The queue refreshes on load and after a decision.
  Two approvers working the same queue see each other's decisions on their next
  refresh; the duplicate guard makes a stale click a clean refusal, not a double
  approval.
- **Escalation is displayed, not driven.** `escalation_after_hours` timeouts are
  B4's job; B5 shows the escalation state the matrix already recorded.
- **Role resolution is still 0015's interim mapping.** Every office/owner
  responsibility maps onto DB role `admin` until the Phase 5 `user_roles`
  migration; the queue inherits that approximation by calling
  `business_role_matches` rather than restating it.
- **`npm run lint` in `apps/web` is broken repo-wide** (`eslint-config-next`
  requires `next/dist/compiled/babel/eslint-parser`, absent in Next 16).
  Pre-existing — it fails identically on the pre-B5 tree, and it is not in
  regression. TypeScript strict checking still runs in the production build.
  Tracked in TASK_BACKLOG AR.
