// ---------------------------------------------------------------------------
// authorization.mjs — an organization's role vocabulary, outside the capability.
//
// THE COUPLING THIS REMOVES. Purchasing already decides authority from
// CAPABILITIES — `authorize(actor, 'po.generate')` — which is the right shape
// and needed no change. What was fixed was one step earlier: the map from role
// NAMES to capabilities lived in a module-level constant in the domain, and
// that constant contains `WORKSHOP_APPROVER`. A business with no workshop could
// not express its approver without editing purchasing code.
//
// So the capability VOCABULARY stays in the domain, where it belongs — the set
// of things a purchasing system can do is a property of purchasing, not of a
// customer. What moves out here is which roles an organization has and what
// each one may do.
//
//   Organization profile
//        ↓ roles: { NAME: [capabilities] }
//   effectiveCapabilities(profile, membership)
//        ↓ a flat capability set
//   authorize(actor, capability)
//        ↓
//   purchasing use case, which never learns the role name
//
// DELIBERATELY NOT BUILT: role inheritance, wildcards, conditions, deny rules,
// a policy language. A role is a named set of capabilities. Every one of those
// mechanisms is a thing to debug at 4pm on somebody else's server, and none is
// justified by two organizations.
// ---------------------------------------------------------------------------

import { PERMISSIONS } from '../../apps/purchasing/src/purchasing/domain/roles.mjs';

/**
 * The canonical capability vocabulary, re-exported so a profile author has one
 * place to look. It is the DOMAIN's — an organization chooses which capabilities
 * its roles carry, never what capabilities exist.
 */
export const CAPABILITIES = PERMISSIONS;

/**
 * Describe one organization's authorization.
 *
 * `roles`  role name → the capabilities it carries
 * `approvalGrant` capabilities added by an explicit per-person approval grant,
 *          independent of role. Lippolis uses this to give an office employee
 *          approval authority without handing them the whole workshop role;
 *          an organization that does not want that leaves it empty.
 *
 * Validated at construction rather than at use. A profile naming a capability
 * that does not exist is a provisioning error, and the moment to find it is
 * while writing the profile — not when somebody is refused an action.
 */
export function defineAuthorizationProfile({ orgId, roles = {}, approvalGrant = [] }) {
  if (!orgId) throw new Error('an authorization profile must name the organization it belongs to');

  const problems = [];
  for (const [role, capabilities] of Object.entries(roles)) {
    if (!Array.isArray(capabilities)) {
      problems.push(`role ${role} must list capabilities`);
      continue;
    }
    for (const capability of capabilities) {
      if (!CAPABILITIES.includes(capability)) {
        problems.push(`role ${role} grants unknown capability "${capability}"`);
      }
    }
  }
  for (const capability of approvalGrant) {
    if (!CAPABILITIES.includes(capability)) problems.push(`approval grant includes unknown capability "${capability}"`);
  }
  if (problems.length) {
    throw new Error(`invalid authorization profile for ${orgId}:\n  ${problems.join('\n  ')}`);
  }

  return Object.freeze({
    orgId,
    roles: Object.freeze({ ...roles }),
    approvalGrant: Object.freeze([...approvalGrant]),
    roleNames: Object.freeze(Object.keys(roles)),
  });
}

/**
 * A membership's effective capabilities.
 *
 * TENANT BOUNDARY, ENFORCED HERE. A profile resolves capabilities only for a
 * membership in ITS OWN organization. Passing organization A's profile a
 * membership from organization B yields nothing — not an error, nothing —
 * because the honest answer to "what may this person do here" is "they are not
 * a member here".
 *
 * Unknown role names are ignored rather than rejected: a role removed from the
 * profile while somebody still holds the assignment should lose them authority,
 * not break their session.
 */
export function effectiveCapabilities(profile, membership) {
  if (!profile || !membership) return [];
  if (!membership.orgId || membership.orgId !== profile.orgId) return [];

  const set = new Set();
  for (const role of membership.roles ?? []) {
    for (const capability of profile.roles[role] ?? []) set.add(capability);
  }
  if (membership.canApprove) {
    for (const capability of profile.approvalGrant) set.add(capability);
  }
  return [...set].sort();
}

/**
 * Attach resolved capabilities to an actor.
 *
 * `domain/roles.mjs` prefers `actor.capabilities` when present and falls back to
 * its built-in table when absent, so an organization that has not been given a
 * profile keeps working exactly as before. That fallback is what made this
 * change safe to land in one step.
 */
export function withCapabilities(actor, profile) {
  return { ...actor, capabilities: effectiveCapabilities(profile, actor) };
}

/**
 * Do two profiles authorize the same work, whatever they call their roles?
 *
 * The question a second organization actually asks — "will my operations
 * manager be able to do what their workshop approver does?" — and the one the
 * synthetic-organization test is built on.
 */
export function capabilityDiff(a, b) {
  const setOf = (profile) => new Set(Object.values(profile.roles).flat().concat(profile.approvalGrant));
  const left = setOf(a);
  const right = setOf(b);
  return {
    onlyInFirst: [...left].filter((c) => !right.has(c)).sort(),
    onlyInSecond: [...right].filter((c) => !left.has(c)).sort(),
    shared: [...left].filter((c) => right.has(c)).sort(),
  };
}
