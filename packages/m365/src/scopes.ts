// ---------------------------------------------------------------------------
// scopes.ts — permission/scope policy mapping.
//
// Three separate sets, deliberately not collapsed:
//   1. SPEC scopes   — what a capability genuinely needs (capabilities.ts).
//   2. DECLARED scopes — what the caller said it needs (CapabilityRequest).
//   3. GRANTED scopes  — what admin consent actually gave us (allowlist config).
//
// The gate is: SPEC ⊆ DECLARED ⊆ GRANTED. Requiring DECLARED to cover SPEC stops
// a caller from under-declaring and hiding what it is about to do from the audit
// trail; requiring GRANTED to cover DECLARED stops us from attempting a call the
// tenant never consented to. Over-declaration is refused too — asking for more
// than the capability needs is exactly the tenant-wide-access smell this plane
// exists to prevent.
// ---------------------------------------------------------------------------

import type { CapabilitySpec } from './contracts.ts';

/**
 * Graph permissions this integration may EVER ask for. Anything outside this set
 * is refused at configuration time, so a copied-in scope string cannot silently
 * widen access. Notably absent: Mail.Send, Mail.ReadWrite.All, Sites.ReadWrite.All,
 * Directory.ReadWrite.All, and every other tenant-wide grant.
 */
export const PERMITTED_SCOPES: readonly string[] = [
  'User.ReadBasic.All',
  'Mail.Read',
  'Mail.ReadWrite',
  'ChannelMessage.Send',
  'Sites.Selected',
];

/**
 * Scopes that are refused by name, with the reason, so a configuration review
 * has the argument in front of it instead of having to reconstruct it.
 */
export const FORBIDDEN_SCOPES: Readonly<Record<string, string>> = {
  'Mail.Send': 'this plane never transmits mail; drafts only',
  'Mail.ReadWrite.All': 'tenant-wide mailbox write — use Mail.ReadWrite with an ApplicationAccessPolicy',
  'Mail.Read.All': 'tenant-wide mailbox read — use Mail.Read with an ApplicationAccessPolicy',
  'Sites.ReadWrite.All': 'tenant-wide SharePoint write — use Sites.Selected',
  'Sites.FullControl.All': 'tenant-wide SharePoint control',
  'Files.ReadWrite.All': 'tenant-wide file write',
  'Directory.ReadWrite.All': 'directory write is never needed',
  'Directory.Read.All': 'full directory read — use User.ReadBasic.All',
  'ChannelMessage.Read.All': 'reading all Teams messages is outside this plane',
  'Chat.ReadWrite.All': 'tenant-wide chat write',
  'User.ReadWrite.All': 'user write is never needed',
};

export type ScopeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'scope_not_declared' | 'insufficient_scope'; readonly detail: string };

const missing = (needed: readonly string[], have: readonly string[]): string[] =>
  needed.filter((s) => !have.includes(s));

export function checkScopes(
  spec: CapabilitySpec,
  declaredScopes: readonly string[],
  grantedScopes: readonly string[],
): ScopeVerdict {
  const underDeclared = missing(spec.requiredScopes, declaredScopes);
  if (underDeclared.length > 0) {
    return {
      ok: false,
      reason: 'scope_not_declared',
      detail: `capability '${spec.name}' needs [${underDeclared.join(', ')}] which the request did not declare`,
    };
  }

  // Over-declaration is a denial, not a warning: least privilege is the contract.
  const overDeclared = declaredScopes.filter((s) => !spec.requiredScopes.includes(s));
  if (overDeclared.length > 0) {
    return {
      ok: false,
      reason: 'scope_not_declared',
      detail: `request declared scopes not required by '${spec.name}': [${overDeclared.join(', ')}]`,
    };
  }

  const forbidden = declaredScopes.filter((s) => s in FORBIDDEN_SCOPES);
  if (forbidden.length > 0) {
    return {
      ok: false,
      reason: 'insufficient_scope',
      detail: `forbidden scope requested: ${forbidden.map((s) => `${s} (${FORBIDDEN_SCOPES[s]})`).join('; ')}`,
    };
  }

  const notGranted = missing(declaredScopes, grantedScopes);
  if (notGranted.length > 0) {
    return {
      ok: false,
      reason: 'insufficient_scope',
      detail: `admin consent has not granted [${notGranted.join(', ')}] in this tenant`,
    };
  }

  return { ok: true };
}

/** Configuration-time check: refuses a granted-scope list that is too broad. */
export function auditGrantedScopes(grantedScopes: readonly string[]): {
  readonly ok: boolean;
  readonly problems: readonly string[];
} {
  const problems: string[] = [];
  for (const s of grantedScopes) {
    if (s in FORBIDDEN_SCOPES) problems.push(`${s}: ${FORBIDDEN_SCOPES[s]}`);
    else if (!PERMITTED_SCOPES.includes(s)) problems.push(`${s}: not in the permitted scope set`);
  }
  return { ok: problems.length === 0, problems };
}
