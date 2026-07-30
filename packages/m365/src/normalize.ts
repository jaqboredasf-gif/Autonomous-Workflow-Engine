// ---------------------------------------------------------------------------
// normalize.ts — Microsoft artifacts -> AWE ContextItem -> email_messages row.
//
// This is where Microsoft stops. Above this line AWE reasons about a ContextItem
// (a normalized inbound artifact, flagged untrusted); below it there are Graph
// shapes. Replacing the provider means rewriting this file and the adapters, and
// nothing else — no objective, task, policy, approval or execution contract
// changes, which is the success criterion this slice is built to satisfy.
//
// Two representations, one truth:
//   ContextItem       — the in-memory, workflow-neutral form.
//   email_messages row — its persisted form (migration 0011). Column-for-column,
//                        including the reserved 'fixture:' namespace idiom used
//                        by scripts/lib/db.mjs#ingestEmail.
//
// Trust: every ContextItem carries trust: 'untrusted_external'. Instructions
// inside a customer email are DATA (AGENT_HARNESS §2). Nothing in this module
// interprets the content — it only shapes and hashes it.
// ---------------------------------------------------------------------------

import type { ContextAttachment, ContextItem, ProviderFidelity } from './contracts.ts';
import { hashValue, sha256 } from './evidence.ts';
import type { MailAttachment, MailMessage } from './adapters/mail.ts';

export interface NormalizeInput {
  readonly aweTenantId: string;
  readonly microsoftTenantId: string;
  readonly message: MailMessage;
  readonly attachments: readonly MailAttachment[];
  readonly subscriptionId: string | null;
  readonly fidelity: ProviderFidelity;
  /**
   * Marks the row as fixture data. TRUE for anything produced by the fake
   * provider — synthetic content must never look like real mail in the database.
   */
  readonly isFixture: boolean;
}

export function normalizeMessage(input: NormalizeInput): ContextItem {
  const { message: m } = input;

  const attachments: ContextAttachment[] = input.attachments.map((a) => ({
    attachmentId: a.id,
    name: a.name,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    // Hash the bytes when we have them, the metadata when we do not — either way
    // the evidence row can prove what was seen without storing the payload.
    contentHash: a.contentBase64 != null
      ? sha256(a.contentBase64)
      : hashValue({ id: a.id, name: a.name, size: a.sizeBytes }),
    isInline: a.isInline,
    retrieved: a.contentBase64 != null,
    storedResourceId: null,
  }));

  const contentHash = hashValue({
    from: m.fromAddr,
    to: [...m.toAddrs].sort(),
    subject: m.subject,
    body: m.bodyText ?? m.bodyHtml,
    received: m.receivedAt,
    attachments: attachments.map((a) => a.contentHash).sort(),
  });

  return {
    // Derived, not random: re-normalizing the same message yields the same id.
    contextItemId: `ctx_${hashValue({ t: input.aweTenantId, m: m.id }).slice(0, 32)}`,
    kind: 'email_message',
    aweTenantId: input.aweTenantId,
    source: {
      provider: 'microsoft-graph',
      fidelity: input.fidelity,
      microsoftTenantId: input.microsoftTenantId,
      resourceId: m.id,
      internetMessageId: m.internetMessageId,
      conversationId: m.conversationId,
      subscriptionId: input.subscriptionId,
    },
    direction: 'inbound',
    mailbox: m.mailbox,
    fromAddr: m.fromAddr,
    toAddrs: m.toAddrs,
    ccAddrs: m.ccAddrs,
    subject: m.subject,
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtml,
    receivedAt: m.receivedAt,
    attachments,
    contentHash,
    isFixture: input.isFixture,
    trust: 'untrusted_external',
  };
}

/**
 * The persisted form: one email_messages row (supabase/migrations/0011).
 *
 * `graph_message_id` carries the reserved 'fixture:' prefix for synthetic
 * content, matching db.mjs#ingestEmail and the 0011 check constraint
 * (`graph_message_id is not null or is_fixture`). The unique index on
 * (org_id, graph_message_id) is what makes re-ingesting the same message a
 * 23505 rather than a duplicate — the database is the second line of defence
 * behind the delivery ledger.
 */
export interface EmailMessageRow {
  readonly org_id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly mailbox: string;
  readonly graph_message_id: string;
  readonly from_addr: string;
  readonly to_addrs: readonly string[];
  readonly subject: string | null;
  readonly body_text: string | null;
  readonly body_html: string | null;
  readonly attachments: readonly Record<string, unknown>[];
  readonly raw: Record<string, unknown>;
  readonly received_at: string;
  readonly is_fixture: boolean;
}

export function toEmailMessageRow(item: ContextItem): EmailMessageRow {
  return {
    org_id: item.aweTenantId,
    direction: item.direction,
    mailbox: item.mailbox,
    graph_message_id: item.isFixture ? `fixture:${item.source.resourceId}` : item.source.resourceId,
    from_addr: item.fromAddr,
    to_addrs: item.toAddrs,
    subject: item.subject,
    body_text: item.bodyText,
    body_html: item.bodyHtml,
    attachments: item.attachments.map((a) => ({
      attachment_id: a.attachmentId,
      name: a.name,
      content_type: a.contentType,
      size_bytes: a.sizeBytes,
      content_hash: a.contentHash,
      is_inline: a.isInline,
      retrieved: a.retrieved,
      stored_resource_id: a.storedResourceId,
    })),
    // `raw` is provenance, not payload: ids, hashes and trust marking. Message
    // bodies already live in their own columns; duplicating them into raw would
    // double the blast radius of a leak for no gain.
    raw: {
      provider: item.source.provider,
      fidelity: item.source.fidelity,
      microsoft_tenant_id: item.source.microsoftTenantId,
      resource_id: item.source.resourceId,
      internet_message_id: item.source.internetMessageId,
      conversation_id: item.source.conversationId,
      subscription_id: item.source.subscriptionId,
      context_item_id: item.contextItemId,
      content_hash: item.contentHash,
      trust: item.trust,
    },
    received_at: item.receivedAt,
    is_fixture: item.isFixture,
  };
}

/** Attach the SharePoint id to an attachment after m365.document.store succeeded. */
export function withStoredAttachment(item: ContextItem, attachmentId: string, storedResourceId: string): ContextItem {
  return {
    ...item,
    attachments: item.attachments.map((a) =>
      a.attachmentId === attachmentId ? { ...a, storedResourceId } : a),
  };
}
