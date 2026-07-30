// ---------------------------------------------------------------------------
// adapters/mail.ts — MicrosoftMailAdapter.
//
// Three operations, and there is no fourth: read a message, read an attachment,
// create a DRAFT. This module contains no send path — not a disabled one, not a
// flagged one, not a commented one. `POST /users/{u}/messages` creates an unsent
// draft in the Drafts folder; `/sendMail` and `/send` appear nowhere in this
// package, which the offline runner asserts by scanning the source.
// ---------------------------------------------------------------------------

import type { GraphRequest, MicrosoftGraphGateway } from '../gateway.ts';
import type { AdapterResult } from './types.ts';
import { failureFromResponse } from './types.ts';

export interface MailMessage {
  readonly id: string;
  readonly internetMessageId: string | null;
  readonly conversationId: string | null;
  readonly subject: string | null;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
  readonly fromAddr: string;
  readonly fromName: string | null;
  readonly toAddrs: readonly string[];
  readonly ccAddrs: readonly string[];
  readonly receivedAt: string;
  readonly hasAttachments: boolean;
  readonly mailbox: string;
}

export interface MailAttachment {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly isInline: boolean;
  readonly contentBase64: string | null;
}

export interface DraftSpec {
  readonly mailbox: string;
  readonly subject: string;
  readonly bodyText: string;
  readonly toAddrs: readonly string[];
  readonly ccAddrs?: readonly string[];
}

export interface CreatedDraft {
  readonly draftMessageId: string;
  readonly isDraft: true;
  readonly webLink: string | null;
  readonly mailbox: string;
}

export interface MicrosoftMailAdapter {
  readMessage(ctx: AdapterCallContext, mailbox: string, messageId: string): Promise<AdapterResult<MailMessage>>;
  listAttachments(ctx: AdapterCallContext, mailbox: string, messageId: string): Promise<AdapterResult<readonly MailAttachment[]>>;
  readAttachment(ctx: AdapterCallContext, mailbox: string, messageId: string, attachmentId: string): Promise<AdapterResult<MailAttachment>>;
  createDraft(ctx: AdapterCallContext, spec: DraftSpec): Promise<AdapterResult<CreatedDraft>>;
}

/** Everything an adapter needs from the executor, and nothing more. */
export interface AdapterCallContext {
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly scopes: readonly string[];
}

type RawMessage = {
  id?: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  hasAttachments?: boolean;
};

type RawAttachment = {
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
};

const addrs = (list: { emailAddress?: { address?: string } }[] | undefined): string[] =>
  (list ?? []).map((r) => r.emailAddress?.address).filter((a): a is string => typeof a === 'string' && a.length > 0);

function toMailAttachment(a: RawAttachment): MailAttachment {
  return {
    id: a.id ?? '',
    name: a.name ?? 'unnamed',
    contentType: a.contentType ?? 'application/octet-stream',
    sizeBytes: typeof a.size === 'number' ? a.size : 0,
    isInline: a.isInline === true,
    contentBase64: typeof a.contentBytes === 'string' ? a.contentBytes : null,
  };
}

export function createMailAdapter(gateway: MicrosoftGraphGateway): MicrosoftMailAdapter {
  const req = (ctx: AdapterCallContext, partial: Omit<GraphRequest, 'correlationId' | 'idempotencyKey' | 'timeoutMs' | 'scopes'>): GraphRequest => ({
    ...partial,
    scopes: ctx.scopes,
    correlationId: ctx.correlationId,
    idempotencyKey: ctx.idempotencyKey,
    timeoutMs: ctx.timeoutMs,
  });

  return {
    async readMessage(ctx, mailbox, messageId) {
      const res = await gateway.execute<RawMessage>(
        req(ctx, { method: 'GET', path: `/users/${encodeURIComponent(mailbox)}/messages/${messageId}` }),
      );
      if (!res.ok || !res.body) return failureFromResponse(res);
      const m = res.body;
      const from = m.from?.emailAddress?.address;
      if (!m.id || !from || !m.receivedDateTime) {
        // A message we cannot attribute or timestamp is not usable evidence.
        return { ok: false, failureReason: 'provider_error', detail: 'message missing id, sender or receivedDateTime', retryable: false, retryAfterSeconds: null, raw: m };
      }
      const isHtml = (m.body?.contentType ?? '').toLowerCase() === 'html';
      const content = m.body?.content ?? null;
      return {
        ok: true,
        microsoftResourceIds: { messageId: m.id, mailbox },
        raw: m,
        data: {
          id: m.id,
          internetMessageId: m.internetMessageId ?? null,
          conversationId: m.conversationId ?? null,
          subject: m.subject ?? null,
          bodyText: isHtml ? null : content,
          bodyHtml: isHtml ? content : null,
          fromAddr: from,
          fromName: m.from?.emailAddress?.name ?? null,
          toAddrs: addrs(m.toRecipients),
          ccAddrs: addrs(m.ccRecipients),
          receivedAt: m.receivedDateTime,
          hasAttachments: m.hasAttachments === true,
          mailbox,
        },
      };
    },

    async listAttachments(ctx, mailbox, messageId) {
      // $select keeps contentBytes out of the manifest: the manifest says WHAT
      // is attached, m365.mail.attachment.read fetches the bytes of one named
      // attachment. Two capabilities, two evidence rows, and a message read
      // never quietly drags payloads along with it.
      const res = await gateway.execute<{ value?: RawAttachment[] }>(
        req(ctx, {
          method: 'GET',
          path: `/users/${encodeURIComponent(mailbox)}/messages/${messageId}/attachments`,
          query: { $select: 'id,name,contentType,size,isInline' },
        }),
      );
      if (!res.ok || !res.body) return failureFromResponse(res);
      const list = (res.body.value ?? []).map(toMailAttachment);
      return {
        ok: true,
        microsoftResourceIds: { messageId, mailbox },
        raw: res.body,
        data: list,
      };
    },

    async readAttachment(ctx, mailbox, messageId, attachmentId) {
      const res = await gateway.execute<RawAttachment>(
        req(ctx, { method: 'GET', path: `/users/${encodeURIComponent(mailbox)}/messages/${messageId}/attachments/${attachmentId}` }),
      );
      if (!res.ok || !res.body) return failureFromResponse(res);
      return {
        ok: true,
        microsoftResourceIds: { messageId, mailbox, attachmentId: res.body.id ?? attachmentId },
        raw: res.body,
        data: toMailAttachment(res.body),
      };
    },

    async createDraft(ctx, spec) {
      // NOTE: this is a create, not a send. Graph puts the result in Drafts and
      // it stays there forever unless a human opens Outlook and sends it.
      const res = await gateway.execute<{ id?: string; isDraft?: boolean; webLink?: string }>(
        req(ctx, {
          method: 'POST',
          path: `/users/${encodeURIComponent(spec.mailbox)}/messages`,
          body: {
            subject: spec.subject,
            body: { contentType: 'text', content: spec.bodyText },
            toRecipients: spec.toAddrs.map((a) => ({ emailAddress: { address: a } })),
            ccRecipients: (spec.ccAddrs ?? []).map((a) => ({ emailAddress: { address: a } })),
          },
        }),
      );
      if (!res.ok || !res.body?.id) return failureFromResponse(res);
      if (res.body.isDraft === false) {
        // Defensive: if a provider ever hands back a non-draft from this route,
        // treat it as a failure rather than record a send we did not intend.
        return { ok: false, failureReason: 'provider_error', detail: 'provider returned a non-draft message from the draft route', retryable: false, retryAfterSeconds: null, raw: res.body };
      }
      return {
        ok: true,
        microsoftResourceIds: { draftMessageId: res.body.id, mailbox: spec.mailbox },
        raw: res.body,
        data: { draftMessageId: res.body.id, isDraft: true, webLink: res.body.webLink ?? null, mailbox: spec.mailbox },
      };
    },
  };
}
