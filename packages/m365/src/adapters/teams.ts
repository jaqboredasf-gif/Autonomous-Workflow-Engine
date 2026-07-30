// ---------------------------------------------------------------------------
// adapters/teams.ts — MicrosoftTeamsAdapter.
//
// Posts internal messages into an allowlisted development channel. Two shapes:
// a notification (informational) and an approval request (asks a named human to
// decide, and carries the approval reference the decision will be recorded
// against).
//
// The approval request is a MESSENGER, not an approver. It cannot grant
// anything: the decision arrives back through AWE's approval contracts, and the
// executor's approval gate is what unlocks the side effect. UBIQUITOUS_LANGUAGE:
// "automation never approves".
// ---------------------------------------------------------------------------

import type { MicrosoftGraphGateway } from '../gateway.ts';
import type { AdapterCallContext } from './mail.ts';
import type { AdapterResult } from './types.ts';
import { failureFromResponse } from './types.ts';

export interface TeamsChannelTarget {
  readonly teamId: string;
  readonly channelId: string;
}

export interface TeamsNotification {
  readonly title: string;
  readonly bodyText: string;
  /** Correlation shown to humans so a Teams post can be traced to an execution. */
  readonly executionId: string;
  readonly objectiveId: string;
}

export interface TeamsApprovalRequest extends TeamsNotification {
  readonly approvalId: string;
  readonly capability: string;
  readonly resourceLabel: string;
  readonly approverRole: string;
}

export interface PostedTeamsMessage {
  readonly teamsMessageId: string;
  readonly channelId: string;
  readonly teamId: string;
  readonly webUrl: string | null;
}

export interface MicrosoftTeamsAdapter {
  postNotification(ctx: AdapterCallContext, target: TeamsChannelTarget, n: TeamsNotification): Promise<AdapterResult<PostedTeamsMessage>>;
  postApprovalRequest(ctx: AdapterCallContext, target: TeamsChannelTarget, r: TeamsApprovalRequest): Promise<AdapterResult<PostedTeamsMessage>>;
}

/**
 * Plain text, deliberately. Adaptive Cards with action buttons would put a
 * decision surface in Teams; approvals belong in AWE's queue where the decision
 * is recorded with who/what/when. The post links out, it does not decide.
 */
function notificationBody(n: TeamsNotification): string {
  return [
    `**${n.title}**`,
    '',
    n.bodyText,
    '',
    `objective: ${n.objectiveId}`,
    `execution: ${n.executionId}`,
  ].join('\n');
}

function approvalBody(r: TeamsApprovalRequest): string {
  return [
    `**${r.title}**`,
    '',
    r.bodyText,
    '',
    `capability: ${r.capability}`,
    `resource: ${r.resourceLabel}`,
    `approver role: ${r.approverRole}`,
    `approval reference: ${r.approvalId}`,
    '',
    'Decide in the AWE approval queue. Replying here does not approve anything.',
    '',
    `objective: ${r.objectiveId}`,
    `execution: ${r.executionId}`,
  ].join('\n');
}

export function createTeamsAdapter(gateway: MicrosoftGraphGateway): MicrosoftTeamsAdapter {
  const post = async (
    ctx: AdapterCallContext,
    target: TeamsChannelTarget,
    content: string,
  ): Promise<AdapterResult<PostedTeamsMessage>> => {
    const res = await gateway.execute<{ id?: string; webUrl?: string }>({
      method: 'POST',
      path: `/teams/${target.teamId}/channels/${target.channelId}/messages`,
      body: { body: { contentType: 'text', content } },
      scopes: ctx.scopes,
      correlationId: ctx.correlationId,
      idempotencyKey: ctx.idempotencyKey,
      timeoutMs: ctx.timeoutMs,
    });
    if (!res.ok || !res.body?.id) return failureFromResponse(res);
    return {
      ok: true,
      microsoftResourceIds: { teamsMessageId: res.body.id, channelId: target.channelId, teamId: target.teamId },
      raw: res.body,
      data: {
        teamsMessageId: res.body.id,
        channelId: target.channelId,
        teamId: target.teamId,
        webUrl: res.body.webUrl ?? null,
      },
    };
  };

  return {
    postNotification: (ctx, target, n) => post(ctx, target, notificationBody(n)),
    postApprovalRequest: (ctx, target, r) => post(ctx, target, approvalBody(r)),
  };
}
