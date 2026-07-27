# ADR-0006 — Human gates reuse the B5 approval queue (open question O5)

**Status:** Proposed (2026-07-27) — awaiting Jack's ratification.

## Context

A harness session can stop for a human in two different situations, and they are
not the same thing:

1. **Approval gate** — the session produced an `outbound_messages` draft that a
   human must approve. This surface already exists: B5's approval queue
   (`apps/web/src/lib/approval-queue.ts`, Runner 5, `message_policies` routing).
2. **Operational block** — a guard refused (`blocked`), a budget was exhausted, or a
   Verify Step failed. Nobody approves this; somebody investigates it.

Building one screen for both would put "investigate a harness bug" in the same
queue as "approve a customer email", training the office admin to click past
safety signals.

## Decision

**Split by kind, reuse for approvals:**

- **Approvals stay in the B5 queue.** A harness session that drafts a message
  creates a normal `outbound_messages` row through the existing
  `create_outbound_draft()` RPC and enters `awaiting_human`. The office admin sees
  exactly what they see today; nothing indicates a new workflow. Approval remains a
  human RPC call (G4) — the harness is never the approver and never polls itself
  into approval.
- **Operational blocks go to a read-only ops list**, sourced from the
  `agent_blocked_sessions` view and `/api/agent/sessions/:id/trace` (H15/H16). Admin-only.
  No approve/reject controls on it. Not part of the office admin's daily queue.

## Alternatives considered

- **One combined harness queue.** Rejected: mixes two decisions with different
  authority and different audiences; would also duplicate the approval semantics
  that `message_policies` already owns as data.
- **No UI at all for blocks (CLI only).** Rejected for H15+: a block that nobody can
  see becomes a silently stuck session. The read-only list is small — a view plus a
  trace endpoint.

## Consequences

- No change to B5's approval semantics, RLS, or Runner 5 gates. Slices 4 and 5 must
  stay green through H14 (explicit acceptance criterion).
- `awaiting_human` sessions must always carry a pointer to what the human is looking
  at (`outbound_message_id` for approvals, block reason for ops).
- The ops list is read-only by construction: no route mutates a session except
  `cancel` and `resume`, both admin-only.

## Security impact

Positive: keeps the approval authority path exactly where it is already tested
(RLS + `record_approval()` + `message_policies`), rather than creating a second
path to the same authority.

## Operational impact

One new admin-only page (or API-only until a page is warranted), one view. The
office admin's workflow is unchanged.

## Reversal strategy

The ops list is read-only and additive; deleting it loses no state.

## Related tasks and guardrails

O5 · Tasks H14, H15, H16 · Guardrails G3 (zero external send), G4 (automation
approves nothing), G13 (verify before success).
