// ---------------------------------------------------------------------------
// handlers.ts — capability name -> adapter call bindings.
//
// The executor owns authorization; the adapters own transport; this file is the
// thin, boring wiring between them. It is the only place that knows, for
// example, that "post to an allowlisted Teams channel" needs a teamId from the
// allowlist entry rather than from the caller — which is deliberate: a caller
// cannot redirect a post by supplying its own team id, because it is never asked
// for one.
//
// Capability-specific input that is missing or malformed is returned as a
// non-retryable failure (recorded as outcome 'failed' with a specific detail),
// not thrown: every attempted side effect must leave evidence, and an exception
// escaping the handler would leave a gap in the trail.
// ---------------------------------------------------------------------------

import type { CapabilityHandler, HandlerContext } from './executor.ts';
import type { AdapterFailure, AdapterResult } from './adapters/types.ts';
import type { MicrosoftMailAdapter } from './adapters/mail.ts';
import type { MicrosoftTeamsAdapter } from './adapters/teams.ts';
import type { MicrosoftDocumentAdapter } from './adapters/document.ts';
import type { MicrosoftIdentityAdapter } from './adapters/identity.ts';

export interface AdapterBundle {
  readonly identity: MicrosoftIdentityAdapter;
  readonly mail: MicrosoftMailAdapter;
  readonly teams: MicrosoftTeamsAdapter;
  readonly document: MicrosoftDocumentAdapter;
}

const badInput = (detail: string): AdapterFailure => ({
  ok: false,
  failureReason: 'provider_error',
  detail: `invalid capability input: ${detail}`,
  retryable: false,
  retryAfterSeconds: null,
  raw: null,
});

const str = (ctx: HandlerContext, key: string): string | null => {
  const v = (ctx.request.input ?? {})[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};

const strList = (ctx: HandlerContext, key: string): readonly string[] => {
  const v = (ctx.request.input ?? {})[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

export function createCapabilityHandlers(adapters: AdapterBundle): Readonly<Record<string, CapabilityHandler>> {
  return {
    'm365.identity.resolve': async (ctx): Promise<AdapterResult<unknown>> =>
      adapters.identity.resolve(ctx.call, ctx.request.targetResource.id),

    // Reading a message means the message AND its attachment manifest: both are
    // Mail.Read on the same resource, and a ContextItem without the manifest is
    // incomplete (we would not know what we had not fetched). The bytes are a
    // separate capability — see m365.mail.attachment.read.
    'm365.mail.message.read': async (ctx): Promise<AdapterResult<unknown>> => {
      const mailbox = ctx.request.targetResource.parent;
      if (!mailbox) return badInput('message resource has no parent mailbox');
      const message = await adapters.mail.readMessage(ctx.call, mailbox, ctx.request.targetResource.id);
      if (!message.ok) return message;
      if (!message.data.hasAttachments) {
        return { ...message, data: { message: message.data, attachments: [] } };
      }
      const manifest = await adapters.mail.listAttachments(ctx.call, mailbox, ctx.request.targetResource.id);
      // An unreadable manifest fails the whole read rather than yielding a
      // ContextItem that silently claims the message had no attachments.
      if (!manifest.ok) return manifest;
      return {
        ok: true,
        microsoftResourceIds: message.microsoftResourceIds,
        raw: { message: message.raw, attachments: manifest.raw },
        data: { message: message.data, attachments: manifest.data },
      };
    },

    'm365.mail.attachment.read': async (ctx): Promise<AdapterResult<unknown>> => {
      const mailbox = ctx.request.targetResource.parent;
      const messageId = str(ctx, 'messageId');
      if (!mailbox) return badInput('attachment resource has no parent mailbox');
      if (!messageId) return badInput('attachment read needs input.messageId');
      return adapters.mail.readAttachment(ctx.call, mailbox, messageId, ctx.request.targetResource.id);
    },

    'm365.mail.draft.create': async (ctx): Promise<AdapterResult<unknown>> => {
      const subject = str(ctx, 'subject');
      const bodyText = str(ctx, 'bodyText');
      const toAddrs = strList(ctx, 'toAddrs');
      if (!subject) return badInput('draft create needs input.subject');
      if (!bodyText) return badInput('draft create needs input.bodyText');
      if (toAddrs.length === 0) return badInput('draft create needs input.toAddrs');
      // The mailbox is the allowlist entry, never a caller-supplied address.
      return adapters.mail.createDraft(ctx.call, {
        mailbox: ctx.entry.id,
        subject,
        bodyText,
        toAddrs,
        ccAddrs: strList(ctx, 'ccAddrs'),
      });
    },

    'm365.teams.notification.create': async (ctx): Promise<AdapterResult<unknown>> => {
      const teamId = ctx.entry.graph?.teamId;
      if (!teamId) return badInput(`allowlist entry '${ctx.entry.label}' has no graph.teamId`);
      const title = str(ctx, 'title');
      const bodyText = str(ctx, 'bodyText');
      if (!title || !bodyText) return badInput('teams notification needs input.title and input.bodyText');
      return adapters.teams.postNotification(ctx.call, { teamId, channelId: ctx.entry.id }, {
        title,
        bodyText,
        executionId: ctx.request.executionId,
        objectiveId: ctx.request.objectiveId,
      });
    },

    'm365.teams.approval.request': async (ctx): Promise<AdapterResult<unknown>> => {
      const teamId = ctx.entry.graph?.teamId;
      if (!teamId) return badInput(`allowlist entry '${ctx.entry.label}' has no graph.teamId`);
      const title = str(ctx, 'title');
      const bodyText = str(ctx, 'bodyText');
      const approvalId = str(ctx, 'approvalId');
      const capability = str(ctx, 'capability');
      const approverRole = str(ctx, 'approverRole');
      if (!title || !bodyText) return badInput('approval request needs input.title and input.bodyText');
      if (!approvalId) return badInput('approval request needs input.approvalId');
      if (!capability) return badInput('approval request needs input.capability (what is being asked for)');
      if (!approverRole) return badInput('approval request needs input.approverRole');
      return adapters.teams.postApprovalRequest(ctx.call, { teamId, channelId: ctx.entry.id }, {
        title,
        bodyText,
        approvalId,
        capability,
        approverRole,
        resourceLabel: str(ctx, 'resourceLabel') ?? ctx.entry.label,
        executionId: ctx.request.executionId,
        objectiveId: ctx.request.objectiveId,
      });
    },

    'm365.document.store': async (ctx): Promise<AdapterResult<unknown>> => {
      const driveId = ctx.entry.graph?.driveId;
      const siteId = ctx.entry.graph?.siteId;
      const rootPath = ctx.entry.graph?.rootPath;
      if (!driveId || !siteId || !rootPath) {
        return badInput(`allowlist entry '${ctx.entry.label}' needs graph.driveId, graph.siteId and graph.rootPath`);
      }
      const fileName = str(ctx, 'fileName');
      const contentBase64 = str(ctx, 'contentBase64');
      const contentHash = str(ctx, 'contentHash');
      if (!fileName) return badInput('document store needs input.fileName');
      if (!contentBase64) return badInput('document store needs input.contentBase64');
      if (!contentHash) return badInput('document store needs input.contentHash');
      return adapters.document.store(ctx.call, { driveId, siteId, rootPath }, {
        objectiveId: ctx.request.objectiveId,
        fileName,
        contentType: str(ctx, 'contentType') ?? 'application/octet-stream',
        contentBase64,
        contentHash,
      });
    },
  };
}
