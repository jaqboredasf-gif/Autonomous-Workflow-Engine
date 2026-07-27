# Approval Matrix + Outbound Drafts (Task B3)

Contract, rules and evidence for the B3 slice. Vocabulary:
docs/architecture/UBIQUITOUS_LANGUAGE.md. Matrix source of truth:
REQUIREMENTS.md §Approval system. Roles: STAKEHOLDERS_AND_PERMISSIONS.md.
Cut: MVP_SPEC.md §Tool registry / §Approval boundaries.

## What B3 is

The approval matrix stored as **data** (`message_policies`), plus **drafting** of
customer- and crew-facing messages (`outbound_messages`) and the human decision
record on each one. A message type graduates draft→auto by flipping a row, never
by a rebuild (TASK_BACKLOG B3 acceptance).

## What B3 is NOT (hard boundaries this slice does not cross)

- **No send.** No Graph, SMTP, n8n, webhook, HTTP client — none of the machinery
  exists in any file this slice adds, and Runner 4 asserts that structurally.
  `mark_message_sent()` is a **ledger entry** recording that a human already sent
  an approved draft by hand from Outlook (identical to the v1 invoice pattern).
- **No auto-send, in any mode.** `effective_mode` is `'draft'` unconditionally —
  in the engine and in `route_outbound()`. A policy row that already says
  `mode='auto'` is honored as *stored data* and reported (`policy_mode: 'auto'`,
  `auto_downgraded: true`) while still producing a draft.
- **No Entra / no mailbox / no real recipients.** TEST mode requires every
  recipient to be `@example.invalid` (RFC 6761 — permanently unresolvable).
- **No autonomous approval.** `record_approval()` requires `auth.uid()` to resolve
  to a `users` row holding the assigned approver role. A service-role runner has
  no JWT, so it raises. Automation has zero approval authority
  (STAKEHOLDERS universal rule 3).
- **No ADR Graph work.** 0015 was validated offline first; it is now **applied live**
  (2026-07-26) and additionally verified by acceptance slice 4. No Graph path exists —
  slice 4 check 15b asserts `graph_message_id` is NULL on every row.

## Deliverables

| Artifact | What it is |
|---|---|
| `supabase/migrations/0015_approval_matrix_outbound.sql` | `message_policies` + `outbound_messages`, `route_outbound()`, `create_outbound_draft()`, `record_approval()`, `mark_message_sent()`, transition guard, no-delete guards, 6 events, v1 matrix seed. **Applied live 2026-07-26.** |
| `scripts/acceptance-slice4.sh` | **49 live DB checks** — RLS denial, approval events, the send gate, the invoice-auto constraint, 23505 on duplicate `draft_key`, fail-closed routing. In regression. |
| `scripts/parity-route-live.mjs` | Live SQL/JS routing parity harness used by slice 4 — retires the dual-implementation risk. |
| `scripts/lib/approval-matrix.mjs` | Pure routing engine — the JS mirror of `route_outbound()`. |
| `scripts/lib/outbound-draft.mjs` | Pure draft templates + `prepareOutbound()`, the gate every outbound action passes through. |
| `fixtures/outbound/` | 5 policy sets + 16 labelled cases + `labels.json`. |
| `scripts/eval-approval-matrix.{sh,mjs}` | **Runner 4** — offline deterministic eval, in regression. |
| `scripts/lib/validate-migration-0015.mjs` | Offline structural lint + **engine/SQL parity**, in regression. |

## The matrix (message_policies)

One row per (org, message type). Columns that carry the decisions:

| Column | Meaning | v1 seed |
|---|---|---|
| `mode` | `draft` \| `auto` — the graduation switch | `draft` on every row |
| `approver_role` | primary responsible role | per REQUIREMENTS matrix; **NULL for `estimate_proposal`** (approver is an open [ASSUMPTION], B2/§3) |
| `backup_approver_role` | who takes it when the primary is unavailable | owner, except `change_order`/`uncertain_flagged` (owner-only by design) |
| `escalation_role` | who takes it when the amount exceeds the limit | owner |
| `approval_limit_cents` | primary approver's ceiling | **NULL everywhere** — boss §3 values are unanswered |
| `confidence_threshold` | matrix confidence column | 0.90 on the decline row |
| `escalation_after_hours` | matrix escalation column | 4 on service-call confirmation |

Nullable `approver_role` / `approval_limit_cents` are deliberate. An unconfigured
responsibility is a **detectable fail-closed state**, not a silent default to
"anyone may approve" or a guessed spend ceiling.

## Routing rules (identical in `route_outbound()` and `approval-matrix.mjs`)

Evaluated in this exact order; the first match wins:

1. no matrix row → `no_policy`
2. row inactive → `policy_inactive`
3. `approver_role IS NULL` → `missing_approver_role` *(the "missing owner" case)*
4. primary role unavailable → use `backup_approver_role`; if it is null or also
   unavailable → `no_backup_approver`
5. amount present and `approval_limit_cents IS NULL` → `missing_approval_limit`
6. amount > limit and `escalation_role IS NULL` → `missing_escalation_role`
7. amount > limit → route to `escalation_role`, `routing_path='escalation'`,
   `escalated=true`
8. otherwise → primary (or backup) role, `escalated=false`

`effective_mode` is always `draft`, whatever `mode` says.

## The gate (`prepareOutbound`)

Every outbound action passes through it. Deterministic fail-closed order:

| # | Check | Blocked reason | Row written? |
|---|---|---|---|
| 1 | action in `ALLOWED_ACTIONS` (`route`, `create_draft`, `record_approval`, `mark_sent`) | `unauthorized_external_action` | no |
| 2 | `draft_key` not already known | `duplicate_draft` | no |
| 3 | template renders with every required field | `draft_build_failed` | no |
| 4 | body/subject free of troubleshooting advice | `forbidden_content` | no |
| 5 | TEST mode: `@example.invalid` recipients, `is_fixture` | `test_mode_violation` | no |
| 6 | matrix routing (rules above) | route reason | **yes — `blocked` row** |

Steps 1–5 refuse *before anything reaches the database*. Step 6 deliberately
**writes a `blocked` row**: an unroutable message is an operational fact a human
must see in the approval queue, not something to drop silently. Every path
returns an ordered `audit` array of the gate decisions.

`forbidden_content` implements REQUIREMENTS "the system never sends electrical
troubleshooting instructions" — and it scans interpolated *customer* text too,
because inbound email content is untrusted data, never instructions.

## Idempotency and duplicate prevention

`draft_key` = `fixture:<message_type>:<work_request_key>` in TEST mode
(`<message_type>:<work_request_key>` in LIVE) — the same deterministic-key idiom
as `email_messages.graph_message_id` and `approval_drafts.draft_key`. Three
layers:

1. Engine: a known key returns `duplicate_draft` before any write.
2. `create_outbound_draft()`: an existing key returns the **existing row id** —
   re-running a fixture is a no-op, not a second draft.
3. Schema: `unique (org_id, draft_key)` (23505), plus a partial unique index
   allowing **one active draft per (request, type)** (`status in
   ('draft','approved')`) while leaving rejected/blocked/sent rows as history.

## Status machine and the send gate

```
draft ──> approved ──> sent          (sent only via mark_message_sent, human-marked)
  │           └──────> rejected
  ├──> rejected | blocked | failed   (terminal; corrections are a NEW draft)
```

Enforced three ways: the transition guard trigger, CHECK constraints
(`outbound_sent_requires_approval`, `outbound_sent_at_requires_approval`,
`outbound_draft_has_no_decision`, `outbound_rejected_requires_reason`,
`outbound_blocked_requires_reason`), and the RPCs being the only writers (no
insert/update RLS policy exists on `outbound_messages`). Message content is
**frozen once it leaves `draft`** — you approve the words you read.

## Events (n8n contract, `emit_event()` spine)

`message.draft_created`, `message.blocked`, `message.escalated`,
`message.approved`, `message.rejected`, `message.sent`. Trigger-emitted, so they
are evidence by construction (MVP_SPEC §Verify Steps).

## Roles

`message_policies.approver_role` uses the 10-role `business_role` vocabulary from
STAKEHOLDERS. The live DB still has only `worker/foreman/admin`, so
`business_role_matches()` is the single interim mapping point (office/owner roles
→ `admin`; `crew_leader` → `foreman`; `field_employee` → `worker`/`foreman`).
The Phase 5 `user_roles` join table replaces that one function — nothing else.

## Runner 4 gates (all HARD)

- every label in `fixtures/outbound/labels.json`
- determinism: same input twice, byte-identical
- **no-send**: no case may yield `approved`/`sent`; no `message.approved` /
  `message.sent` event from a drafting run; every ok draft carries
  `send_capability: false` and `requires_human_approval: true`
- **fixture safety**: every recipient on a produced draft is `@example.invalid`
- **fail-closed coverage**: all 11 blocked reasons exercised
- **template coverage**: all 10 templates render completely, address a fixture
  recipient, and contain no forbidden content
- **source purity**: the two engine modules contain no `fetch(`, URL, `require(`,
  SMTP/nodemailer/Graph reference, and import nothing non-local
- **seed parity**: every message type has a row; no policy set anywhere puts
  `final_invoice` in auto; every `seed_v1` row is `draft`

Lint (`validate-migration-0015.mjs`, 64 checks) additionally asserts the SQL and
the engine agree: identical message-type and business-role vocabularies, and an
identical route-blocked-reason set (missing *or* extra in SQL both fail).

## Evidence (2026-07-26)

- Runner 4: `passed=314 failed=0` over 16 fixtures; blocked-reason coverage
  11/11; template coverage 10/10.
- Perturbation check: flipping two labels produced exactly 2 failures
  (`02` approver_role, `10` ok) — the runner is not vacuous. Labels restored.
- Migration 0015 lint: **PASS**, 64 checks. Perturbation check: rewriting
  `effective_mode` to `'auto'` and renaming the invoice constraint produced
  exactly 2 failures. Migration restored.
- Runner 3 (ADR) and the 0014 lint re-run green — no regression.
- **Live (2026-07-26)**: 0014 + 0015 applied; acceptance slice 4 **49/49**; full
  regression **ALL GREEN** (mobile tsc, web build 14 routes, MCP 10 tools, slices
  1–4 = 9+10+20+49, Runners 1–4, both migration lints); drift check clean at 24
  live base tables. See "Live evidence" below.

## Live evidence — acceptance slice 4 (2026-07-26)

`source .env.acceptance && bash scripts/acceptance-slice4.sh` → **passed=49 failed=0**,
green on two consecutive runs (the suite is re-runnable: `draft_key`s are namespaced per
run and the fixture user upsert is idempotent).

What slice 4 proves that the offline lint could not:

| Gate | Checks | Proof |
|---|---|---|
| Non-approver blocked by RLS | 4–4g | fixture `worker` sees 0 `outbound_messages` / 0 `message_policies`; `record_approval` + `mark_message_sent` refuse it; direct table update writes nothing; anon blocked from both |
| approve → `message.approved` | 7, 7b | status→approved with approver + timestamp; event emitted once, carrying `approved_by` |
| `sent` unreachable without approval | 6–6d | refused three independent ways (RPC approval gate, transition guard, check constraint) + global invariant: zero `sent` rows lack a full approval record |
| Invoice refuses auto | 10–10c | `message_policies_invoice_never_auto` raises; row stays `draft`; auto without a limit also refused |
| Duplicate `draft_key` | 2, 2b | RPC idempotent (same id, no 2nd row); direct insert → **23505** |
| draft→auto by data alone | 11–11c | flip succeeds without a code change, still routes `effective_mode=draft`; live matrix stays all-draft |
| Automation has zero authority | 5 | service role (no JWT) → "automation has no approval authority" |
| Fail-closed routing, live | 3–3c | `estimate_proposal` → `blocked/missing_approver_role`; amount + NULL limit → `blocked/missing_approval_limit` |
| Content frozen / terminal states | 7c, 7d, 8c, 9–9d | frozen after leaving draft; re-decide refused; `sent` and `rejected` terminal; rejection needs a reason |
| No hard deletes | 12–12c | refused on `outbound_messages`, `message_policies`, `approval_drafts` |
| No send happened | 15, 15b | every recipient `@example.invalid`; `graph_message_id` NULL everywhere |

**Dual-implementation risk: RETIRED** (checks 14–14d). `scripts/parity-route-live.mjs`
routes every (message_type × amount × unavailable-roles) case through both the live
`route_outbound()` and the offline `route()`, over the same live policy rows:

- Pass 1 (live matrix as seeded): 160 cases, 642 field comparisons, **0 mismatches**.
- Pass 2 (14b — same matrix with limits + backup + escalation roles configured, inside a
  rolled-back transaction): 300 cases, 2304 comparisons, **0 mismatches**.
- 14c asserts pass 2 actually reached the escalation (78) and backup (32) branches, so
  the parity claim cannot pass vacuously. 14d re-asserts the live matrix is still
  fail-closed (zero configured limits).

Pass 2 exists because of a real hole found while proving non-vacuity: with every live
`approval_limit_cents` NULL, the limit/escalation branches are never reached, so
perturbing the JS engine's `amountCents >` to `>=` produced **zero** mismatches in pass 1.
It produces 39 in pass 2. The other perturbation (`path='backup'` → `'secondary'`)
produced exactly 7 mismatches in pass 1. Engine restored; `git diff` clean.

## Known limits / deliberate exclusions

- **Parity covers routing, not the whole RPC surface.** `route_outbound()` vs `route()`
  is now compared branch-by-branch, but `create_outbound_draft()` /
  `record_approval()` / `mark_message_sent()` have no JS counterpart to compare against —
  they are covered by slice 4's behavioral checks instead.
- **Approval limits are still unknown** (boss §3 unanswered), so every live
  `approval_limit_cents` is NULL and every amount-bearing message blocks. This is
  correct fail-closed behavior, not a defect — but it means the escalation path is
  proven only under synthetic (rolled-back) configuration, never yet with real numbers.
- **`estimate_proposal` has no approver** ([ASSUMPTION], open B2/§3), so it blocks live.
  Same posture: verified fail-closed, awaiting a human answer.
- **`business_role` has 9 labels, not 10.** STAKEHOLDERS defines 10 roles; the 10th
  (`customer`) is an email-only actor with no login and is deliberately not an approver
  role. Earlier handoff text saying "the 10 STAKEHOLDERS roles" was imprecise.
- **No amounts are invented.** Templates never fabricate a price; `amount_cents`
  is supplied by the caller or absent. Seeded limits stay NULL until boss §3.
- **Model-drafted bodies are out of scope.** B3 templates are deterministic. A
  model-composed body would ride the same gate unchanged.
