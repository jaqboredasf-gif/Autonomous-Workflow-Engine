// ---------------------------------------------------------------------------
// outcomes.ts — what each action says when it worked.
//
// Deliberately NOT in actions.ts. That file is `'use server'`, and such a
// module may export async functions and nothing else: exporting this table
// from there compiles, typechecks, and then fails the production build with
//
//   A "use server" file can only export async functions, found object.
//
// which surfaces as "Failed to collect configuration for /admin" — a message
// naming a page that has nothing to do with the cause. So the wording lives
// here, in an ordinary module both the actions and the screens can import.
//
// The messages are keyed by the `done` parameter the action redirects with;
// see `outcome()` in actions.ts for why the outcome travels in the URL.
// ---------------------------------------------------------------------------

export const OUTCOME_MESSAGES: Record<string, string> = {
  submitted: 'Request submitted. The workshop can see it now.',
  cancelled: 'Request cancelled. The record has been kept.',
  noted: 'Note added to the record.',
  answered: 'Answer sent back to the workshop.',
  ordered: 'Marked as ordered. Receiving is expecting the delivery.',
  completed: 'Request completed and closed.',
  tracking: 'Tracking details saved.',
  received: 'Marked received. The record is closed and searchable.',
  po_sequence: 'Purchase order sequence set for that job and vendor.',
  po_pair_new: 'Recorded: that job and vendor has no paper purchase orders behind it.',
};
