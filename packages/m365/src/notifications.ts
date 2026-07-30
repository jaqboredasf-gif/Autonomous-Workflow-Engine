// ---------------------------------------------------------------------------
// notifications.ts — webhook validation and deduplication.
//
// Microsoft Graph change notifications are AT-LEAST-ONCE. Graph retries a
// notification it could not confirm, batches several into one POST, and delivers
// them out of order. Anything that treats a notification as "this happened once"
// will create duplicate objectives and duplicate drafts.
//
// So this module does exactly two jobs, and refuses to do any work:
//   1. VALIDATE  — is this notification one we asked for, from the tenant we are
//      bound to, for a subscription that is alive, carrying our clientState, for
//      a resource on the allowlist?
//   2. DEDUPLICATE — have we already accepted this exact change? The ledger is
//      the idempotency boundary for the whole pipeline: a duplicate returns the
//      original execution id and does no work.
//
// Validation is fail-closed and ordered so the cheapest, most specific refusal
// wins. Nothing here retrieves a message; a validated notification is a claim
// that something changed, never the content of the change.
// ---------------------------------------------------------------------------

import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { ResourceAllowlist } from './allowlist.ts';
import { checkResource, checkTenantBinding } from './allowlist.ts';
import type { MicrosoftSubscriptionManager } from './subscriptions.ts';
import { hashValue } from './evidence.ts';

/** One notification exactly as Graph sends it (the fields we accept). */
export interface GraphChangeNotification {
  readonly subscriptionId: string;
  readonly subscriptionExpirationDateTime: string;
  readonly clientState?: string;
  readonly changeType: string;
  readonly resource: string;
  readonly resourceData?: { readonly id?: string; readonly '@odata.type'?: string } | null;
  readonly tenantId: string;
  /** Graph's lifecycle notices arrive on the same endpoint. */
  readonly lifecycleEvent?: 'reauthorizationRequired' | 'subscriptionRemoved' | 'missed';
}

export interface NotificationEnvelope {
  readonly value: readonly GraphChangeNotification[];
  /** Present on the initial endpoint handshake; must be echoed verbatim. */
  readonly validationToken?: string;
}

export const NOTIFICATION_REJECTIONS = [
  'malformed_notification',
  'unknown_subscription',
  'subscription_not_active',
  'subscription_expired',
  'client_state_mismatch',
  'tenant_mismatch',
  'resource_mismatch',
  'resource_not_allowlisted',
  'change_type_not_subscribed',
] as const;

export type NotificationRejection = (typeof NOTIFICATION_REJECTIONS)[number];

export type NotificationVerdict =
  | {
      readonly accepted: true;
      readonly deliveryKey: string;
      readonly mailbox: string;
      readonly messageId: string;
      readonly subscriptionId: string;
      readonly changeType: string;
    }
  | { readonly accepted: false; readonly rejection: NotificationRejection; readonly detail: string };

/** Constant-time compare so a mismatch cannot be probed byte by byte. */
function secretEquals(a: string | undefined, b: string): boolean {
  if (a == null) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * Parse `/users/{mailbox}/messages/{id}` (with or without a mailFolders segment)
 * into the mailbox that owns it and the message id. Returning null is a refusal,
 * not a best guess: an unparseable resource path is never "probably fine".
 */
export function parseMessageResource(resource: string): { readonly mailbox: string; readonly messageId: string } | null {
  const m = /^\/?users\/([^/]+)\/(?:mailFolders\/[^/]+\/|mailFolders\('[^']+'\)\/)?messages\/([^/?]+)$/i.exec(resource);
  if (!m || !m[1] || !m[2]) return null;
  return { mailbox: decodeURIComponent(m[1]), messageId: m[2] };
}

/**
 * The delivery key IS the idempotency boundary. It is derived from what the
 * change actually is — subscription, resource, change type — and deliberately
 * NOT from anything that varies between redeliveries of the same change
 * (expiration timestamp, batch position, arrival time).
 */
export function deliveryKeyFor(n: GraphChangeNotification): string {
  return `del_${hashValue({
    s: n.subscriptionId,
    r: n.resource.replace(/^\//, '').toLowerCase(),
    c: n.changeType,
    i: n.resourceData?.id ?? null,
  }).slice(0, 40)}`;
}

export interface ValidateOptions {
  readonly allowlist: ResourceAllowlist;
  readonly subscriptions: MicrosoftSubscriptionManager;
  readonly aweTenantId: string;
  readonly nowIso: string;
  readonly requireDevelopmentResource: boolean;
}

export function validateNotification(n: GraphChangeNotification, opts: ValidateOptions): NotificationVerdict {
  const reject = (rejection: NotificationRejection, detail: string): NotificationVerdict => ({
    accepted: false, rejection, detail,
  });

  if (!n || typeof n !== 'object' || !n.subscriptionId || !n.resource || !n.changeType || !n.tenantId) {
    return reject('malformed_notification', 'missing subscriptionId, resource, changeType or tenantId');
  }

  // 1. Do we know this subscription, and is it alive right now?
  const usable = opts.subscriptions.assertUsable(n.subscriptionId, opts.nowIso);
  if (!usable.record) return reject('unknown_subscription', `subscription '${n.subscriptionId}' is not ours`);
  const sub = usable.record;
  if (!usable.ok) {
    return usable.reason === 'subscription_expired'
      ? reject('subscription_expired', `subscription expired at ${sub.expiresAt}`)
      : reject('subscription_not_active', `subscription state is '${sub.state}'`);
  }

  // 2. clientState proves the notification came from the Graph subscription we
  //    created, not from anyone who learned our webhook URL.
  if (!secretEquals(n.clientState, sub.clientState)) {
    return reject('client_state_mismatch', 'clientState did not match the subscription secret');
  }

  // 3. Tenant identity, both directions.
  if (n.tenantId !== sub.microsoftTenantId) {
    return reject('tenant_mismatch', `notification tenant '${n.tenantId}' is not the subscription's tenant`);
  }
  const binding = checkTenantBinding(opts.allowlist, opts.aweTenantId, n.tenantId);
  if (!binding.ok) return reject('tenant_mismatch', binding.reason ?? 'tenant binding refused');
  if (sub.aweTenantId !== opts.aweTenantId) {
    return reject('tenant_mismatch', `subscription belongs to awe tenant '${sub.aweTenantId}'`);
  }

  // 4. Did we subscribe to this kind of change?
  if (!sub.changeTypes.includes(n.changeType)) {
    return reject('change_type_not_subscribed', `changeType '${n.changeType}' is not subscribed`);
  }

  // 5. Is the resource the one the subscription covers? A notification whose
  //    resource is outside its own subscription's scope is an attack shape.
  const parsed = parseMessageResource(n.resource);
  if (!parsed) return reject('resource_mismatch', `unparseable message resource '${n.resource}'`);
  if (parsed.mailbox.toLowerCase() !== sub.resourceUnitId.toLowerCase()) {
    return reject('resource_mismatch', `resource mailbox '${parsed.mailbox}' is outside subscription scope`);
  }

  // 6. And is that mailbox still allowlisted for reading? (Config may have
  //    narrowed since the subscription was created.)
  const allowed = checkResource(
    opts.allowlist,
    'm365.mail.message.read',
    { kind: 'message', id: parsed.messageId, parent: parsed.mailbox },
    { requireDevelopmentResource: opts.requireDevelopmentResource },
  );
  if (!allowed.allowed) return reject('resource_not_allowlisted', allowed.reason);

  return {
    accepted: true,
    deliveryKey: deliveryKeyFor(n),
    mailbox: parsed.mailbox,
    messageId: parsed.messageId,
    subscriptionId: n.subscriptionId,
    changeType: n.changeType,
  };
}

// --- Deduplication ledger ---------------------------------------------------

export interface DeliveryLedgerEntry {
  readonly deliveryKey: string;
  readonly aweTenantId: string;
  readonly subscriptionId: string;
  readonly executionId: string;
  readonly firstSeenAt: string;
  readonly deliveryCount: number;
}

export interface DeliveryLedger {
  /**
   * Claim this delivery. First caller gets `{first: true}` and owns the work;
   * every later caller gets `{first: false}` plus the original execution id and
   * must do nothing but return it.
   */
  claim(deliveryKey: string, aweTenantId: string, subscriptionId: string, executionId: string, atIso: string): {
    readonly first: boolean;
    readonly entry: DeliveryLedgerEntry;
  };
  get(deliveryKey: string): DeliveryLedgerEntry | null;
  all(): readonly DeliveryLedgerEntry[];
}

export function createInMemoryDeliveryLedger(): DeliveryLedger {
  const rows = new Map<string, DeliveryLedgerEntry>();
  return {
    claim(deliveryKey, aweTenantId, subscriptionId, executionId, atIso) {
      // Tenant is part of the key so two tenants cannot collide — or observe
      // each other — through the ledger.
      const key = `${aweTenantId}|${deliveryKey}`;
      const existing = rows.get(key);
      if (existing) {
        const bumped: DeliveryLedgerEntry = { ...existing, deliveryCount: existing.deliveryCount + 1 };
        rows.set(key, bumped);
        return { first: false, entry: bumped };
      }
      const entry: DeliveryLedgerEntry = {
        deliveryKey, aweTenantId, subscriptionId, executionId, firstSeenAt: atIso, deliveryCount: 1,
      };
      rows.set(key, entry);
      return { first: true, entry };
    },
    get: (deliveryKey) => [...rows.values()].find((r) => r.deliveryKey === deliveryKey) ?? null,
    all: () => [...rows.values()],
  };
}
