// ---------------------------------------------------------------------------
// email-workflow.mjs — the vendor email draft, as one table.
//
// The SECOND workflow on the AWE engine, and the reason 4B exists: a workflow
// engine extracted from one state machine is a refactor, and a workflow engine
// two unrelated state machines both fit is a platform capability. This one is
// deliberately unlike the purchasing one — different states, different
// evidence, a different notion of who may act — and it needed no change to the
// engine to express.
//
// WHAT THIS REPLACES. `EMAIL_DRAFT_TRANSITIONS`, `canTransitionDraft()` and
// `draftGuard()` in email.mjs: a second hand-rolled graph, a second legality
// check and a second closed vocabulary of refusal reasons, all doing what the
// engine already does. They are gone; this table is what remains.
//
// THE RULE THAT MATTERS, preserved exactly: a draft cannot be marked SENT
// without a recorded human review, and without naming the human who sent it.
// Nothing in this codebase transmits anything — SENT means a person copied the
// text into their own mail client — so the review is the only thing standing
// between a generated draft and a vendor believing it came from the company.
// ---------------------------------------------------------------------------

import { defineWorkflow } from '@awe/workflow';

import { EMAIL_DRAFT_STATUSES } from './email.mjs';

/** Nothing follows these. A corrected draft is a new draft. */
export const EMAIL_DRAFT_TERMINAL = ['SENT', 'CANCELLED', 'FAILED'];

const LIVE = EMAIL_DRAFT_STATUSES.filter((s) => !EMAIL_DRAFT_TERMINAL.includes(s));

export const EMAIL_DRAFT_WORKFLOW = defineWorkflow({
  name: 'purchasing.email_draft',
  states: EMAIL_DRAFT_STATUSES,
  terminal: EMAIL_DRAFT_TERMINAL,
  actions: {
    review: {
      from: 'GENERATED',
      to: 'REVIEWED',
      permission: 'email.review',
      event: 'email.draft_reviewed',
    },
    approveToSend: {
      from: 'REVIEWED',
      to: 'APPROVED_TO_SEND',
      permission: 'email.review',
      event: 'email.draft_approved_to_send',
    },
    markSent: {
      from: 'APPROVED_TO_SEND',
      to: 'SENT',
      permission: 'email.review',
      event: 'email.marked_sent',
      // BOTH facts, and the reasons are different. `reviewedBy` is the human
      // who read it; `markedBy` is the human claiming to have sent it. A draft
      // marked sent by nobody is an unattributable claim that a vendor was
      // contacted.
      requires: ['reviewedBy', 'markedBy'],
    },
    cancel: {
      from: LIVE,
      to: 'CANCELLED',
      permission: 'email.review',
      event: 'email.draft_cancelled',
    },
    fail: {
      from: LIVE,
      to: 'FAILED',
      permission: 'email.review',
      event: 'email.draft_failed',
    },
  },
});

/**
 * The action that reaches a draft status. The application still speaks in
 * target statuses at its boundary — `advanceEmailDraft(draftId, 'SENT')` is
 * what the route posts — so this maps that vocabulary onto the engine's rather
 * than forcing a rename through the UI.
 *
 * Unambiguous by construction here: no two actions share a target state, and a
 * test asserts it stays that way.
 */
export function emailDraftActionFor(to) {
  const matches = Object.values(EMAIL_DRAFT_WORKFLOW.actions).filter((a) => a.to === to);
  return matches.length === 1 ? matches[0].name : null;
}
