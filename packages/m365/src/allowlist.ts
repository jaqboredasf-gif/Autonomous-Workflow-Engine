// ---------------------------------------------------------------------------
// allowlist.ts — explicit resource allowlists and the tenant binding.
//
// Nothing in Microsoft 365 is reachable because it exists. It is reachable only
// because a named entry in an allowlist says so, in a specific AWE tenant, bound
// to a specific Microsoft tenant. This is the mechanism behind the safety rule
// "do not access mailboxes, Teams resources or SharePoint sites outside an
// explicit allowlist", and behind tenant isolation: the same Graph resource id
// presented under a different aweTenantId is a cross-tenant attempt.
//
// The allowlist is DATA (fixtures/m365/allowlist.json in tests, configuration in
// deployment), never code, so widening access is a reviewable config change and
// shows up in a diff.
// ---------------------------------------------------------------------------

import type { ResourceKind, TargetResource } from './contracts.ts';

export interface AllowlistEntry {
  readonly kind: ResourceKind;
  /** Graph identifier of the unit of access (mailbox UPN, channel id, drive id). */
  readonly id: string;
  readonly label: string;
  /** Development-only marker. TEST mode refuses any entry that is not one. */
  readonly isDevelopmentResource: boolean;
  /** Capabilities permitted against this entry. Empty = none. */
  readonly capabilities: readonly string[];
  /**
   * Provider-specific addressing this entry needs (teamId for a channel;
   * driveId/siteId/rootPath for a library). Kept as opaque config so adding a
   * resource is a data change, and so nothing above the seam has to know that
   * "a Teams channel" is addressed by two ids.
   */
  readonly graph?: Readonly<Record<string, string>>;
}

export interface TenantBinding {
  readonly aweTenantId: string;
  readonly microsoftTenantId: string;
  readonly label: string;
}

export interface ResourceAllowlist {
  readonly binding: TenantBinding;
  readonly entries: readonly AllowlistEntry[];
  /** Graph permissions actually granted by admin consent in this tenant. */
  readonly grantedScopes: readonly string[];
}

export type AllowlistVerdict =
  | { readonly allowed: true; readonly entry: AllowlistEntry }
  | { readonly allowed: false; readonly reason: string };

function normalizeId(id: string): string {
  // Mailbox UPNs and site paths are case-insensitive in Microsoft 365; Graph
  // message ids are not. Lowercasing everything for comparison would let
  // 'AAmk...' and 'aamk...' collide, so only the address-shaped ids are folded.
  return id.includes('@') ? id.trim().toLowerCase() : id.trim();
}

export function findEntry(allowlist: ResourceAllowlist, kind: ResourceKind, id: string): AllowlistEntry | null {
  const wanted = normalizeId(id);
  return allowlist.entries.find((e) => e.kind === kind && normalizeId(e.id) === wanted) ?? null;
}

/**
 * The single question the executor asks: may THIS capability touch THIS resource
 * in THIS tenant? Answers with a reason on refusal so the evidence row is
 * specific rather than "denied".
 *
 * A message/attachment is authorized through its PARENT mailbox: individual
 * message ids are not (and cannot be) enumerated in advance, so the mailbox is
 * the unit of access and the message must declare which mailbox it belongs to.
 */
export function checkResource(
  allowlist: ResourceAllowlist,
  capability: string,
  resource: TargetResource,
  opts: { readonly requireDevelopmentResource: boolean },
): AllowlistVerdict {
  const unitKind: ResourceKind =
    resource.kind === 'message' || resource.kind === 'attachment' ? 'mailbox' : resource.kind;
  const unitId = resource.kind === 'message' || resource.kind === 'attachment' ? resource.parent : resource.id;

  if (!unitId) {
    return { allowed: false, reason: `resource of kind '${resource.kind}' did not declare its parent mailbox` };
  }

  const entry = findEntry(allowlist, unitKind, unitId);
  if (!entry) {
    return { allowed: false, reason: `no allowlist entry for ${unitKind} '${unitId}'` };
  }
  if (opts.requireDevelopmentResource && !entry.isDevelopmentResource) {
    return { allowed: false, reason: `allowlist entry '${entry.label}' is not marked as a development resource` };
  }
  if (!entry.capabilities.includes(capability)) {
    return { allowed: false, reason: `capability '${capability}' is not permitted on '${entry.label}'` };
  }
  return { allowed: true, entry };
}

/**
 * Tenant isolation. Both directions matter: an AWE tenant may only reach the
 * Microsoft tenant it is bound to, and a Microsoft tenant id arriving on a
 * notification may only be accepted for the AWE tenant it is bound to.
 */
export function checkTenantBinding(
  allowlist: ResourceAllowlist,
  aweTenantId: string,
  microsoftTenantId: string,
): { readonly ok: boolean; readonly reason: string | null } {
  const b = allowlist.binding;
  if (b.aweTenantId !== aweTenantId) {
    return { ok: false, reason: `awe tenant '${aweTenantId}' is not bound to this allowlist` };
  }
  if (b.microsoftTenantId !== microsoftTenantId) {
    return { ok: false, reason: `microsoft tenant '${microsoftTenantId}' is not bound to awe tenant '${aweTenantId}'` };
  }
  return { ok: true, reason: null };
}

/** Every allowlisted id of a kind — used by the fake provider to bound its world. */
export function idsOfKind(allowlist: ResourceAllowlist, kind: ResourceKind): readonly string[] {
  return allowlist.entries.filter((e) => e.kind === kind).map((e) => e.id);
}
