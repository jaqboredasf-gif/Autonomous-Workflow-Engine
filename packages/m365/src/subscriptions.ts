// ---------------------------------------------------------------------------
// subscriptions.ts — MicrosoftSubscriptionManager + the lifecycle state machine.
//
// A Graph subscription is a standing grant to be told about changes in ONE
// resource. It expires (mail subscriptions max out around 3 days), it can be
// revoked by the tenant, and Graph can drop lifecycle notices asking us to
// renew or to reauthorize. Treating that as a state machine rather than a
// boolean is what stops "we stopped receiving mail" from being invisible.
//
// States and the only legal moves between them:
//
//     pending ──created──▶ active ──renewed──▶ active
//        │                   │  │  │
//        │                   │  │  └──expired────▶ expired ──recreated──▶ pending
//        │                   │  └─────revoked────▶ revoked
//        │                   └────reauth_required─▶ reauthorization_required
//        └──create_failed──▶ failed ──recreated──▶ pending
//
// Terminal-ish states (expired / revoked / failed / reauthorization_required)
// accept notifications for NOTHING: a notification against a non-active
// subscription is refused, which is the "expired subscription" test case.
// ---------------------------------------------------------------------------

import type { ResourceKind } from './contracts.ts';

export type SubscriptionState =
  | 'pending'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'reauthorization_required'
  | 'failed';

export type SubscriptionEvent =
  | 'created'
  | 'create_failed'
  | 'renewed'
  | 'renew_failed'
  | 'expired'
  | 'revoked'
  | 'reauth_required'
  | 'recreated';

export const SUBSCRIPTION_STATES: readonly SubscriptionState[] = [
  'pending', 'active', 'expired', 'revoked', 'reauthorization_required', 'failed',
];

const TRANSITIONS: Readonly<Record<SubscriptionState, Partial<Record<SubscriptionEvent, SubscriptionState>>>> = {
  pending: { created: 'active', create_failed: 'failed' },
  active: {
    renewed: 'active',
    renew_failed: 'expired',
    expired: 'expired',
    revoked: 'revoked',
    reauth_required: 'reauthorization_required',
  },
  // A dead subscription is never resurrected in place — it is recreated, which
  // mints a new Graph subscription id and a new clientState secret.
  expired: { recreated: 'pending' },
  revoked: { recreated: 'pending' },
  reauthorization_required: { recreated: 'pending', renewed: 'active' },
  failed: { recreated: 'pending' },
};

export type TransitionResult =
  | { readonly ok: true; readonly state: SubscriptionState }
  | { readonly ok: false; readonly state: SubscriptionState; readonly reason: string };

export function transition(from: SubscriptionState, event: SubscriptionEvent): TransitionResult {
  const next = TRANSITIONS[from]?.[event];
  if (!next) {
    return { ok: false, state: from, reason: `illegal transition: ${from} --${event}--> (none)` };
  }
  return { ok: true, state: next };
}

export interface SubscriptionRecord {
  readonly subscriptionId: string;
  readonly aweTenantId: string;
  readonly microsoftTenantId: string;
  /** Graph resource path, e.g. `/users/dev@example.onmicrosoft.com/mailFolders('inbox')/messages`. */
  readonly resource: string;
  /** The allowlist unit this subscription is bound to. */
  readonly resourceKind: ResourceKind;
  readonly resourceUnitId: string;
  readonly changeTypes: readonly string[];
  readonly notificationUrl: string;
  /** Shared secret echoed by Graph in every notification. Compared, never logged. */
  readonly clientState: string;
  readonly expiresAt: string;
  readonly state: SubscriptionState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubscriptionStore {
  get(subscriptionId: string): SubscriptionRecord | null;
  put(record: SubscriptionRecord): void;
  all(): readonly SubscriptionRecord[];
}

export function createInMemorySubscriptionStore(seed: readonly SubscriptionRecord[] = []): SubscriptionStore {
  const rows = new Map<string, SubscriptionRecord>(seed.map((s) => [s.subscriptionId, s]));
  return {
    get: (id) => rows.get(id) ?? null,
    put: (r) => { rows.set(r.subscriptionId, r); },
    all: () => [...rows.values()],
  };
}

export interface MicrosoftSubscriptionManager {
  /** Apply a lifecycle event; returns the updated record or an explanation. */
  apply(
    subscriptionId: string,
    event: SubscriptionEvent,
    patch?: Partial<Pick<SubscriptionRecord, 'expiresAt' | 'clientState' | 'subscriptionId'>>,
  ): TransitionResult & { readonly record: SubscriptionRecord | null };
  /** Is this subscription fit to accept a notification at `atIso`? */
  assertUsable(subscriptionId: string, atIso: string): { readonly ok: boolean; readonly reason: string | null; readonly record: SubscriptionRecord | null };
  /** Subscriptions inside the renewal window at `atIso`. */
  dueForRenewal(atIso: string, windowMs: number): readonly SubscriptionRecord[];
  store: SubscriptionStore;
}

export function createSubscriptionManager(
  store: SubscriptionStore,
  clock: { now(): string },
): MicrosoftSubscriptionManager {
  return {
    store,

    apply(subscriptionId, event, patch) {
      const current = store.get(subscriptionId);
      if (!current) {
        return { ok: false, state: 'failed', reason: `unknown subscription '${subscriptionId}'`, record: null };
      }
      const t = transition(current.state, event);
      if (!t.ok) return { ...t, record: current };

      const next: SubscriptionRecord = {
        ...current,
        ...(patch ?? {}),
        state: t.state,
        updatedAt: clock.now(),
      };
      store.put(next);
      return { ok: true, state: t.state, record: next };
    },

    assertUsable(subscriptionId, atIso) {
      const record = store.get(subscriptionId);
      if (!record) return { ok: false, reason: 'unknown_subscription', record: null };
      if (record.state !== 'active') return { ok: false, reason: `subscription_state_${record.state}`, record };
      if (Date.parse(record.expiresAt) <= Date.parse(atIso)) {
        return { ok: false, reason: 'subscription_expired', record };
      }
      return { ok: true, reason: null, record };
    },

    dueForRenewal(atIso, windowMs) {
      const at = Date.parse(atIso);
      return store
        .all()
        .filter((s) => s.state === 'active' && Date.parse(s.expiresAt) - at <= windowMs)
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    },
  };
}
