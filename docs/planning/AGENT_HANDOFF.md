# Agent Handoff

## updated_at

2026-09-02T15:40:00Z

## agent

Claude Code

## repository

jaqboredasf-gif/Autonomous-Workflow-Engine

## branch

claude/awe-iic-evidence-campaign-073p0v

## commit

B5c follows EV1 (`e777471`), the EV1 handoff (`a313811`) and the baseline scaffold (`e42a8d1`) on the same branch. Resolve the tip with `git rev-parse HEAD`.

## current objective

Completed: B5c, plus a first-use defect fix found by inspecting it for real employee use (B5c-fix). Integration verification was ATTEMPTED and is BLOCKED: `.env.acceptance` is absent from this container, so no live acceptance run was possible. B5c remains rehearsal-verified, NOT integration-verified.

Prior: B5c — closed the APPROVAL to REAL ACTION to AUDIT link in the outbound workflow. An approved message can now be recorded as sent from the approvals queue. Previously that state transition existed in the database and was covered by acceptance slice 4, but no product surface called it, so `sent` was reachable only by raw SQL or curl.

Do NOT resume the Lippolis purchasing baseline: the founder is blocked on physical evidence until Friday. Do NOT start Case Study #001 (EV2).

## pull request

- PR `#15` — https://github.com/jaqboredasf-gif/Autonomous-Workflow-Engine/pull/15
- Base: `main`
- Head: `claude/awe-iic-evidence-campaign-073p0v`
- State: open draft.

## production boundary before this session

Verified from source, not from the prior report. Email intake to work_request, classification, approval-matrix routing, outbound draft generation, and an approvals queue that can approve or reject. Every seeded `message_policies` row is `mode='draft'`, so there are zero auto-sends. Graph inbound and outbound (B9/B10), shared-calendar write (B11), n8n consumers (B12) and QuickBooks (B13) are all BLOCKED on external human or IT action and could not be advanced today.

The boundary ended one step earlier than the pipeline suggested: an approved message had nowhere to go. `mark_message_sent()` existed in migration 0015 with status, org and role gates, emitted an audit event, and was exercised by acceptance slice 4 — but `grep` confirmed no caller in `apps/web`. The read side was already complete: `QUEUE_SELECT` projects `sent_at` and the sender's name, and `buildAuditTrail()` already rendered a `sent` step. Only the write path was missing.

## completed work

- Verified the production boundary from source: migration 0015 enums, constraints and RPCs; `approval-queue.ts`; `approvals/page.tsx`; the acceptance slices; and the backlog's BLOCKED set.
- Ranked the three real blockers and selected the one that was neither externally blocked nor dependent on Friday's evidence work.
- Added `SENDABLE_STATUSES`, `sendGuard()`, `planSendMark()` and `verifySendApplied()` to `approval-queue.ts`, mirroring the existing decision path exactly rather than introducing a second pattern.
- Split the queue's `decided` tab: an approved-but-unsent message now lands in a `to_send` tab labelled "Approved — you still owe this", because filing outstanding real-world work under "decided" is how it goes missing.
- Added the Real-world send panel to the approvals page, calling `mark_message_sent()` only with a payload `planSendMark()` returned.
- Extended Runner 5's fixture case loop to support `"action": "send"` cases, so both write paths out of this UI are covered by labelled fixtures rather than inline assertions only.
- Added five send fixtures (authorized, draft refused, duplicate refused, unauthorized refused, LIVE-mode fixture refused) plus a B5c assertion block.
- Reverted incidental `package-lock.json` churn caused by running `npm install` in this container (npm stripped `libc` fields from optional platform packages); it is unrelated to this change.

## files changed

- `apps/web/src/lib/approval-queue.ts`
- `apps/web/src/app/approvals/page.tsx`
- `scripts/eval-approval-queue.mjs`
- `fixtures/queue/cases/20_send_authorized.json`
- `fixtures/queue/cases/21_send_on_draft_refused.json`
- `fixtures/queue/cases/22_send_duplicate_refused.json`
- `fixtures/queue/cases/23_send_unauthorized_refused.json`
- `fixtures/queue/cases/24_send_live_mode_fixture_refused.json`
- `fixtures/queue/labels.json`
- `docs/planning/TASK_BACKLOG.md`
- `docs/planning/AGENT_HANDOFF.md`

## migrations

None created, applied, moved, or modified. The repository and the live project remain in sync at 0001 through 0015. B5c adds no schema: the RPC, its gates and its audit event already existed, and only the caller was missing.

## commands run

- `grep`/`sed` over `supabase/migrations/0015_approval_matrix_outbound.sql`, `apps/web/src/lib/approval-queue.ts`, `apps/web/src/app/approvals/page.tsx`, `scripts/acceptance-slice4.sh`, `scripts/acceptance-slice5.sh`
- `npm install --no-audit --no-fund`
- `cd apps/web && npm run build` (before and after the change, and on a stashed tree)
- `cd apps/mobile && npx tsc --noEmit`
- `bash scripts/eval-approval-queue.sh`
- `bash scripts/eval-approval-diff.sh`, `bash scripts/eval-approval-matrix.sh`, `bash scripts/eval-evidence.sh`
- `node scripts/lib/validate-migration-0014.mjs`, `node scripts/lib/validate-migration-0015.mjs`
- `node scripts/evidence.mjs status`
- `git stash` / `git stash pop` to prove the web build failure is pre-existing
- `bash scripts/validate-agent-handoff.sh`

## tests passed

- Runner 5: PASS — 425 checks, 24 fixtures, guard-reason coverage 8 of 8 (3 new checks assert the irreversible write stays behind a confirmation).
- Runner 3, Runner 4, Runner 6: PASS. Migration 0014 and 0015 offline lints: OK. No regressions.
- Mobile typecheck: clean.
- Web production build: TypeScript compiled and typechecked successfully.
- `node scripts/evidence.mjs status` still reports 0 of 13. B5c collected no evidence and raised no readiness, which is correct.

## first-use defect found and fixed (B5c-fix)

Recording a send is IRREVERSIBLE. Verified from source: `guard_outbound_transition()` in 0015 permits `draft -> approved|rejected|blocked|failed` and `approved -> sent|rejected` only, so `sent` is terminal with no transition out of it, and the file's own comment says "Corrections after a terminal state are a NEW draft row."

As originally shipped, B5c fired that irreversible write on a SINGLE UNGUARDED CLICK, and the copy did not say it was permanent. A stray click, or a user who misread the button as an act of sending, would permanently assert that a customer had been emailed when they had not — and the obligation would vanish from the "Approved — you still owe this" tab forever, with nothing ever flagging it again. That is a concrete first-use defect, not a hypothetical.

Fixed with the minimum proportionate change: the write now takes two deliberate acts. The first click opens a confirmation that asks "Have you already sent this email from Outlook?" and states that it cannot be undone; only the second click calls the RPC. No gate was weakened and no recovery system was built — reversing `sent` would undermine the ledger, which is why the fix is prevention rather than undo. Runner 5 now asserts the confirmation's shape so it cannot be silently removed in a later refactor.

The copy was also strengthened to say what AWE genuinely cannot know: it records that YOU sent it, and it cannot verify that.

## tests failed

- `cd apps/web && npm run build` fails at the prerender step with `Error: supabaseUrl is required` on `/approvals`. This is environmental, not a regression: `apps/web/.env.local` is gitignored and absent from this container. Proven by stashing the change and rebuilding — the pre-change tree fails identically, and TypeScript passes in both. Compilation and typechecking, the parts this change could break, both pass.
- Acceptance slices 1 through 5, Runner 1 and Runner 2A did not run: `.env.acceptance` is gitignored and absent, so the live project could not be reached.

## live changes

- Supabase/database: no live change. No schema, no data, no policy change.
- GitHub: commit and push to `claude/awe-iic-evidence-campaign-073p0v`, updating draft PR #15.
- n8n/external APIs/production/mailboxes: no live change. AWE still has no mail transport and sent nothing.

## approvals required

- Keep PR #15 as draft; do not merge without explicit approval from Jack.
- Before the send-marking path is exercised against real customer messages, `NEXT_PUBLIC_AWE_MODE` must be set to LIVE deliberately and the fixture rows must be understood to be non-markable in that mode.
- Security item S1 (undeclared client policies on the audit tables) remains open and human-gated; untouched by this session.

## risks

- The send-marking button is an ATTESTATION, not an action. If a user believes it sends the email, they will click it and never send anything, and the customer gets nothing while the ledger says otherwise. The UI states plainly that it does not send and instructs the user to send from Outlook first, but this is a human-factors risk that copy alone cannot fully eliminate. It is worth watching in the first real use.
- `sent` is now reachable from the browser. It was previously unreachable outside raw SQL, which was a de facto safety property. The database gates (status must be approved, org must match, role must match) are unchanged and still authoritative; the UI guard mirrors them and is not the only enforcement.
- Runner 5's purity gate no longer forbids `mark_message_sent` in the UI. The RPC allow-list grew by exactly one named, database-gated call and remains closed. The invariants that protect the customer — no mail transport, no service-role credential, no direct write to `outbound_messages` — are unchanged and still asserted.
- The browser path has NOT been verified against the live project this session. It is code-verified and rehearsal-verified only.

## blockers

No engineering blocker for B5c. The remaining outbound blockers are external: Graph requires an Entra app registration from IT (B9/B10/B11), n8n requires an instance URL (B12), QuickBooks requires a variant and billing-process confirmation (B13). The evidence campaign is blocked on the founder's physical Lippolis visit, expected Friday.

## integration verification attempt (2026-09-02)

Attempted and blocked. `.env.acceptance` does not exist in this container; `apps/web/.env.local` does not exist either; and no Supabase credentials are present in the environment (the only SUPABASE/ANTHROPIC matches in `env` are proxy and base-URL settings, not keys). Both files are gitignored by `.env.*` and by design never committed.

The prescribed commands were re-verified as still correct: `scripts/regression.sh` documents `SUPABASE_ACCESS_TOKEN=... SUPABASE_SERVICE_ROLE_KEY=... EMAIL=... PASSWORD=... bash scripts/regression.sh`, and slice 5 hard-requires SUPABASE_ACCESS_TOKEN, EMAIL and PASSWORD. So `source .env.acceptance && bash scripts/regression.sh` remains the right invocation — on a machine that holds the file.

No credentials were fabricated and no acceptance results were simulated. B5c stays rehearsal-verified.

## exact next prompt

Run the live acceptance slices against this branch with `.env.acceptance` sourced (`source .env.acceptance && bash scripts/regression.sh`) to move B5c from rehearsal-verified to integration-verified, then walk one fixture message through the full loop in the browser — approve it, confirm it appears under "Approved — you still owe this", record the send, and confirm the audit trail shows the send step with the correct actor and timestamp. Do not begin any new capability until that walkthrough passes.
