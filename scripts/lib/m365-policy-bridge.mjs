// ---------------------------------------------------------------------------
// m365-policy-bridge.mjs — binds the Microsoft plane to AWE's EXISTING policy.
//
// packages/m365 declares a PolicyEngine interface and refuses to contain one.
// This file is the implementation: it routes Microsoft capability requests
// through the same approval matrix that governs every other outbound action
// (scripts/lib/approval-matrix.mjs, mirrored in SQL by route_outbound() in
// migration 0015). There is exactly one routing engine in this repo and this
// does not become the second.
//
// Capability -> policy mapping, and why each one is what it is:
//
//   m365.mail.draft.create        -> action 'create_draft', routed as the
//                                    'uncertain_flagged' message type. A
//                                    Microsoft draft is an outbound message; the
//                                    matrix decides who owns it, and a blocked
//                                    route is a policy DENY, not a warning.
//   m365.mail.message.read        -> permit. Reading an allowlisted development
//   m365.mail.attachment.read        mailbox is not a side effect; the allowlist
//   m365.identity.resolve            IS the policy for reads.
//   m365.teams.notification.create-> permit for allowlisted development channels
//   m365.teams.approval.request      only. Internal, no customer commitment.
//   m365.document.store           -> permit for allowlisted development
//                                    libraries only; the capability separately
//                                    requires a human approval.
//
// Fail-closed everywhere: an unknown capability is a deny, and so is any route
// the matrix blocks.
// ---------------------------------------------------------------------------

import { route, authorizeAction, resolveMode } from './approval-matrix.mjs';

export const DRAFT_MESSAGE_TYPE = 'uncertain_flagged';
export const POLICY_ENGINE_ID = 'm365-policy-bridge-1';

const READ_CAPABILITIES = new Set([
  'm365.mail.message.read',
  'm365.mail.attachment.read',
  'm365.identity.resolve',
]);

const INTERNAL_POST_CAPABILITIES = new Set([
  'm365.teams.notification.create',
  'm365.teams.approval.request',
]);

/**
 * createPolicyBridge({policies, allowlist, env, validityMs}) -> PolicyEngine
 *
 * `policies` is a message_policies row set (fixtures/outbound/policies.json in
 * tests, the table in deployment). `allowlist` is the resource allowlist — the
 * bridge re-reads it rather than trusting the caller, because a policy decision
 * that ignored the allowlist would be a decision about the wrong thing.
 */
export function createPolicyBridge({ policies, allowlist, env = {}, validityMs = 900000 } = {}) {
  const mode = resolveMode(env);

  const entryFor = (kind, id) => {
    const wanted = String(id ?? '').trim().toLowerCase();
    return (allowlist?.entries ?? []).find(
      (e) => e.kind === kind && String(e.id).trim().toLowerCase() === wanted,
    ) ?? null;
  };

  const decision = (query, effect, reason) => ({
    id: `pol_${query.capability}_${query.executionId}_${effect}`,
    effect,
    capability: query.capability,
    resourceId: query.targetResource.id,
    executionId: query.executionId,
    decidedAt: query.atIso,
    expiresAt: new Date(Date.parse(query.atIso) + validityMs).toISOString(),
    reason,
    engine: POLICY_ENGINE_ID,
  });

  return {
    decide(query) {
      const permit = (reason) => decision(query, 'permit', reason);
      const deny = (reason) => decision(query, 'deny', reason);

      if (READ_CAPABILITIES.has(query.capability)) {
        return permit('read of an allowlisted development resource');
      }

      if (INTERNAL_POST_CAPABILITIES.has(query.capability)) {
        const entry = entryFor('teams_channel', query.targetResource.id);
        if (!entry) return deny('teams channel is not on the allowlist');
        if (!entry.isDevelopmentResource) return deny('teams channel is not a development resource');
        return permit('internal notification to an allowlisted development channel');
      }

      if (query.capability === 'm365.document.store') {
        const entry = entryFor('sharepoint_library', query.targetResource.id);
        if (!entry) return deny('sharepoint library is not on the allowlist');
        if (!entry.isDevelopmentResource) return deny('sharepoint library is not a development resource');
        return permit('store into an allowlisted development library (approval required separately)');
      }

      if (query.capability === 'm365.mail.draft.create') {
        // 1. Is creating a draft an action the registry permits at all?
        const authz = authorizeAction('create_draft', { mode });
        if (!authz.allowed) return deny(`action 'create_draft' is not authorized in mode ${mode}`);

        // 2. What does the approval matrix say about this message type?
        const routed = route({
          policies,
          messageType: query.messageType ?? DRAFT_MESSAGE_TYPE,
          amountCents: query.amountCents ?? null,
          unavailableRoles: [],
        });
        if (routed.blocked) return deny(`approval matrix: ${routed.blocked_reason}`);

        // 3. The matrix may already carry mode='auto' for a type (that is how
        //    graduation is meant to happen). It changes nothing here: the
        //    effective mode is always 'draft', and a draft still needs its
        //    human approval at the executor's approval gate.
        return permit(
          `approval matrix permits a draft; approver_role=${routed.approver_role}, effective_mode=${routed.effective_mode}`,
        );
      }

      return deny(`no policy rule for capability '${query.capability}'`);
    },
  };
}
