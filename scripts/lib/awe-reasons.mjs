// ---------------------------------------------------------------------------
// awe-reasons.mjs — the platform's blocked-reason union.
//
// Every fail-closed vocabulary in AWE registered in ONE place, over the kernel's
// reason registry (@exattime/awe-kernel/reasons). Importing this module is the
// check: a reason claimed by two namespaces with no shared declaration throws
// `vocabulary_conflict` at load time, so the conflict surfaces in Runner K
// rather than as two different meanings of the same string in an evidence
// report six months from now.
//
// Namespaces mirror the engines that own them:
//   route  — routing refusals from approval-matrix.mjs, mirrored by
//            route_outbound() in migration 0015.
//   gate   — refusals from the runner/gate around routing (no SQL counterpart).
//   queue  — approval-queue guard reasons (apps/web/src/lib/approval-queue.ts),
//            mirrored by the decide RPC.
//   classify — refusals from the B2 classification workflow when it is executed
//            through the shared run scaffolding (scripts/lib/awe-execution.mjs).
//            Both names are already in the harness BlockedReason union
//            (AGENT_HARNESS_CONTRACTS §2.4) — spelled once, here.
//
// PURE OFFLINE: no DB, no network, no keys. Node 24 strips the types from the
// imported .ts module, the same way Runner 5 imports it.
// ---------------------------------------------------------------------------

import { createReasonRegistry } from '../../packages/awe-kernel/src/reasons.mjs';
import { GATE_BLOCKED_REASONS, ROUTE_BLOCKED_REASONS } from './approval-matrix.mjs';
import { GUARD_REASONS } from '../../apps/web/src/lib/approval-queue.ts';

// `test_mode_violation` is deliberately shared: the fixture-safety rule is one
// rule, enforced at two layers (the outbound gate before a draft is built, and
// the queue guard before a decision is applied). Same string, same meaning, by
// design. Anything NOT listed here that collides is a bug.
export const SHARED_REASONS = ['test_mode_violation'];

// The classification workflow's fail-closed refusals. Both are cases where B2
// already refuses to trust a result; naming them makes the refusal a
// machine-readable outcome instead of a flag a caller has to remember to read.
export const CLASSIFY_BLOCKED_REASONS = [
  'classification_fail_closed',  // model output unparseable after the retry budget
  'ungrounded_extraction',       // an extracted value is absent from the source text (G11)
];

export const reasons = createReasonRegistry({ shared: SHARED_REASONS });

reasons.register('route', ROUTE_BLOCKED_REASONS);
reasons.register('gate', GATE_BLOCKED_REASONS);
reasons.register('queue', [...GUARD_REASONS]);
reasons.register('classify', CLASSIFY_BLOCKED_REASONS);

export default reasons;
