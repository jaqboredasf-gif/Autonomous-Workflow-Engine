# Development Roadmap

Rule: every task sized for one short Claude Code session, tested at session end. Task details in TASK_BACKLOG.md. No implementation until first task approved.

## Phase A — Stabilize Workstream A (unblocked, in progress)

- A1. Fix 6 failing slice-2 acceptance checks → 10/10, rerun full regression, commit
- A2. Web corrections UI (/corrections page + Nav)
- A3. Payroll parallel-run tooling (blocked on: rounding/OT policy from boss + one ExakTime export sample)

## Phase B0 — Discovery (human tasks, run in parallel with build)

- D1. Confirm mailbox receiving requests; who administers M365; who approves Entra app; can shared mailbox be created
- D2. Pricing discovery (where rates live, estimate approver, per-customer rates, price-change handling, fixed vs T&M mix)
- D3. Emergency contact + channel; real licensed territory list; rounding/OT policy; n8n instance URL; QuickBooks Desktop vs Online

## Phase B1 — Intake spine (unblocked — fixtures)

- B1. email_messages + work_requests tables, RLS, events, immutability guard + ~12 fixture emails covering edge cases + deterministic emergency-keyword and territory safety nets + acceptance script ← **recommended first task**
- B2. AI classification harness over fixtures (classification, confidence, reasoning, property_type, urgency) + accuracy report vs hand-labeled expectations

## Phase B2 — Approvals + emergency escalation (unblocked)

- B3. message_policies (approval matrix as data) + outbound_messages + approve/reject RPCs + events + acceptance script
- B4. emergency_contacts + escalation config + request.emergency_escalated event + auto-scheduling halt trigger + acceptance script
- B5. Web: Requests inbox page + Approval queue page (reuse existing Nav/auth/patterns)

## Phase B3 — Scheduling link (unblocked)

- B6. Approved service call → shift creation via existing shifts/find_best_worker + dispatch draft message + events + acceptance script

## Phase B4 — Estimates & pricing (unblocked, placeholder data)

- B7. price_book placeholder structure + estimates/estimate_line_items + pricing_complete gate + acceptance script
- B8. proposals/change_orders/customers/jobs/invoices data model (both billing types) + acceptance script (model only — no sending, no QB)

## Phase B5 — Go live on email [BLOCKED: Entra app]

- B9. Graph inbound: shared mailbox → email_messages (replaces fixtures; zero routing changes)
- B10. Graph outbound: auto-decline send (only after real territory data loaded + boss approves matrix) ; drafts sent via human click
- B11. Shared-calendar write (jobs → calendar entries)

## Phase B6 — n8n wiring [BLOCKED: instance URL]

- B12. integration_events → n8n webhook consumers, wave 1 workflows (classify assist, escalation delivery, approval notifications)

## Phase B7 — Invoicing integration [BLOCKED: QB variant + billing-process confirmation]

- B13. QuickBooks sync (Option B — deferred by decision; see INTEGRATIONS.md recommendation)

## Cutover (Workstream A)

- C1. Parallel run pay period 1 → compare vs ExakTime → fix deltas
- C2. Parallel run pay period 2 → match → boss cancels ExakTime

## Session operating system (every coding session)

1. Read docs/planning/*.md + SESSION_HANDOFF.md
2. Select ONE approved task
3. Restate goal + acceptance criteria
4. Inspect relevant existing files
5. Smallest necessary change
6. Test (task's acceptance script + scripts/regression.sh)
7. Fix errors before expanding scope
8. Update TASK_BACKLOG.md + SESSION_HANDOFF.md
9. Stop
10. Output the exact prompt for the next session
