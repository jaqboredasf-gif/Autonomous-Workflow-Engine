// ---------------------------------------------------------------------------
// eval-purchasing-authorization.mjs — what each authenticated person may do.
//
// Authentication established WHO. This is the other half: what that person is
// allowed to do, checked where it is enforced rather than where it is
// displayed. Hiding a button is not authorization, so nothing here looks at a
// button.
//
// Three parts:
//   1. COVERAGE — every mutating use case calls must(). A use case that forgets
//      is an unauthorized write, and it will not announce itself.
//   2. THE MATRIX — every role against every capability, asserted both ways.
//      Holding a capability is as much a claim as not holding one.
//   3. THE BOUNDARIES — the specific refusals that matter to this business:
//      job-scoped receiving, cross-tenant, requestor edits after handover,
//      accounting's total absence of write authority.
//   4. BR-011 — approval authority supersedes requester identity. Its five
//      cases are asserted by name; the fifth (the audit record) needs a
//      database and lives in eval-purchasing.mjs.
//   5. BR-014 — receipt authority follows capability and verified possession.
//      Six of its seven cases are decided by pure functions and asserted here;
//      the seventh (the receiving actor in the audit trail) is a write, and
//      lives in eval-purchasing.mjs.
//
// Offline. Pure domain functions plus a source scan; no database, no server.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = join(ROOT, 'apps', 'purchasing', 'src', 'purchasing');

const roles = await import(join(APP, 'domain', 'roles.mjs'));
const {
  ROLES, PERMISSIONS, CAPABILITIES, ROLE_PRESETS, ROLE_PERMISSIONS,
  authorize, permissionsFor, hasCapability, capabilitiesFor, presetByKey,
} = roles;

let pass = 0;
const failures = [];
function check(ok, name, detail = '') {
  if (ok) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const user = (over = {}) => ({
  id: 'u-1', orgId: 'org-A', roles: [], canApprove: false, isActive: true,
  assignedJobNumbers: [], ...over,
});
const request = (over = {}) => ({
  id: 'r-1', orgId: 'org-A', requestorId: 'u-other', createdBy: 'u-other',
  status: 'PENDING_WORKSHOP_REVIEW', jobNumber: '24-118', ...over,
});

// ===========================================================================
console.log('--- coverage: every mutating use case authorizes ----------------');

// A mutation is an exported use case that takes an actor. Queries are read
// paths and are scoped by orgId instead; they live in queries.ts, which is
// excluded by name rather than by guesswork.
const USE_CASE_FILES = ['requests.ts', 'review.ts', 'decisions.ts', 'fulfilment.ts', 'administration.ts', 'history.ts'];

// Internal helpers, exported for composition but never reached from a route.
// Each is listed with the caller that DOES authorize, so this stays a decision
// rather than a hole.
const AUTHORIZED_BY_CALLER = {
  'review.ts:recomputeTotals': 'saveWorkshopReview',
  'review.ts:changesFromOriginal': 'read-only diff, no write',
  'fulfilment.ts:renderAndStore': 'generatePurchaseOrder (po.generate)',
  'decisions.ts:saveReviewAndDecide': 'delegates to saveWorkshopReview + decidePurchaseRequest',
  'administration.ts:poSequences': 'read-only; authorizes with admin.po_config',
  // The history WRITE is not a use case a route can reach: it runs inside the
  // terminal transition of the three use cases that end a request, each of
  // which authorized before transitioning. Asking again here would authorize
  // the same act twice and, worse, imply there is a way to write history
  // without ending a request. There is not.
  'history.ts:recordPurchaseHistory':
    'completePurchaseRequest (request.complete), cancelPurchaseRequest (request.cancel.*), decidePurchaseRequest (review.decide)',
};

for (const file of USE_CASE_FILES) {
  const src = readFileSync(join(APP, 'application', file), 'utf8');
  // Split on exported functions so each body is examined on its own.
  const parts = src.split(/\nexport async function /).slice(1);
  for (const part of parts) {
    const name = /^(\w+)/.exec(part)?.[1];
    if (!name) continue;
    const takesActor = /^[^)]*actor:\s*Actor/s.test(part);
    if (!takesActor) continue;
    const body = part.split(/\nexport /)[0];
    const authorizes = /await must\(ctx, actor,/.test(body);
    const excused = AUTHORIZED_BY_CALLER[`${file}:${name}`];
    check(authorizes || Boolean(excused),
      `${file}: ${name}() authorizes before it acts`,
      excused ? '' : 'no must(ctx, actor, ...) in its body');
  }
}

// The excuse list must not rot: every name on it still has to exist.
for (const key of Object.keys(AUTHORIZED_BY_CALLER)) {
  const [file, name] = key.split(':');
  const src = readFileSync(join(APP, 'application', file), 'utf8');
  check(src.includes(`export async function ${name}`) || src.includes(`export function ${name}`),
    `the authorization excuse list has no stale entry (${key})`);
}

// ===========================================================================
console.log('--- no identity check may override a capability -----------------');

// THE PRINCIPLE BR-011 AND BR-014 SHARE:
//
//   an identity relationship must not remove authority a user independently
//   possesses.
//
// Both bugs were the same bug. Approval asked "did you raise this?" and
// receiving was *described* as asking it. Neither question has anything to do
// with whether the company authorized this person to approve, or to sign for a
// delivery.
//
// Ownership is still legitimate in one direction: it can GRANT a cheaper
// permission (your own draft, your own cancellation, the clarification
// addressed to you). It may never subtract. So every ownership comparison in
// the domain and the application layer is listed here with the reason it is
// allowed, and a new one fails this test until somebody writes down why.
const OWNERSHIP_SITES = {
  'domain/roles.mjs:isSelfApproval':
    'AUDIT ONLY — stamps a decision as self-approved. Authorizes nothing.',
  'domain/roles.mjs:.own-permissions':
    'GRANTS. The ".own" permissions and request.respond_clarification are DEFINED by ownership: answering a question addressed to you is evidence of who said what.',
  'domain/roles.mjs:read.own-fallback':
    'GRANTS. A user without request.read.all may still read their own request.',
  'application/requests.ts:cancelPurchaseRequest':
    'WIDENS. Owning the request lets you cancel with the cheaper request.cancel.own; a capability holder still passes through request.cancel.any.',
};

{
  const scanned = [
    ['domain/roles.mjs', readFileSync(join(APP, 'domain', 'roles.mjs'), 'utf8')],
    ...['requests.ts', 'review.ts', 'decisions.ts', 'fulfilment.ts', 'administration.ts', 'queries.ts', 'history.ts']
      .map((f) => [`application/${f}`, readFileSync(join(APP, 'application', f), 'utf8')]),
  ];

  const OWNERSHIP = /(requestorId|createdBy|approverId)\s*===\s*(actor|user)\.id/;
  // Every ownership comparison must declare, AT THE SITE, which of the three
  // legitimate kinds it is. A proximity heuristic cannot tell a `.own` refusal
  // (ownership DEFINES that permission) from a capability refusal (forbidden),
  // and a guard that guesses is one people learn to work around. An annotation
  // is unambiguous, survives refactoring, and is visible in review.
  const KINDS = ['AUDIT', 'GRANTS', 'WIDENS'];
  let found = 0;
  for (const [name, src] of scanned) {
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!OWNERSHIP.test(line)) return;
      found += 1;
      const preamble = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
      const marker = /OWNERSHIP-OK:\s*(\w+)/.exec(preamble);
      check(Boolean(marker),
        `${name}:${i + 1} compares identity without an OWNERSHIP-OK annotation — say which kind it is (${KINDS.join('/')}), or it is a capability override`,
        line.trim());
      if (marker) {
        check(KINDS.includes(marker[1]),
          `${name}:${i + 1} declares OWNERSHIP-OK: ${marker[1]}, which is not one of ${KINDS.join('/')} — an identity relationship may record, define or widen authority, never remove it`);
      }
    });
  }
  // The scan must actually be finding things: a regex that matches nothing
  // would pass this section silently forever.
  check(found >= 4, `the ownership scan found ${found} comparison sites to check`);
  check(Object.keys(OWNERSHIP_SITES).length >= 4, 'every known ownership site is documented with why it is allowed');

  // The two capability names the business uses, and the two rules they carry.
  check(hasCapability(user({ roles: ['WORKSHOP_APPROVER'], canApprove: true }), roles.APPROVE_PURCHASE),
    'the purchaser holds APPROVE_PURCHASE');
  check(hasCapability(user({ roles: ['WORKSHOP_APPROVER'], canApprove: true }), roles.RECORD_RECEIPT),
    'the purchaser holds RECORD_RECEIPT');
  check(!hasCapability(user({ roles: ['REQUESTOR'] }), roles.APPROVE_PURCHASE)
     && !hasCapability(user({ roles: ['REQUESTOR'] }), roles.RECORD_RECEIPT),
    'a request-only user holds neither capability');
  // The two are INDEPENDENT: holding one must not imply the other in either
  // direction, or "who may approve" and "who may sign for it" collapse.
  check(hasCapability(user({ roles: ['FOREMAN'], assignedJobNumbers: ['24-118'] }), roles.RECORD_RECEIPT)
     && !hasCapability(user({ roles: ['FOREMAN'], assignedJobNumbers: ['24-118'] }), roles.APPROVE_PURCHASE),
    'a foreman receives without approving — the capabilities are independent');
  check(hasCapability(user({ roles: ['OFFICE'], canApprove: true }), roles.APPROVE_PURCHASE),
    'an office approver approves without holding the workshop role');
}

// ===========================================================================
console.log('--- the capability vocabulary ----------------------------------');

for (const [capability, permissions] of Object.entries(CAPABILITIES)) {
  for (const p of permissions) {
    check(PERMISSIONS.includes(p),
      `capability ${capability} maps only to real permissions`, `${p} is not a permission`);
  }
}

// The brief's minimum capability model, named explicitly so a rename breaks a
// test rather than a conversation.
const REQUIRED_CAPABILITIES = [
  'purchase.request.create', 'purchase.request.view', 'purchase.request.edit',
  'purchase.request.approve', 'purchase.order.create', 'purchase.order.manage',
  'purchase.order.mark_ordered', 'receiving.confirm', 'vendor.manage',
  'job.manage', 'user.manage', 'accounting.view', 'audit.view',
];
for (const c of REQUIRED_CAPABILITIES) {
  check(c in CAPABILITIES, `the capability model includes ${c}`);
}

// THE VOCABULARY, LOCKED. The full list, so adding or renaming a capability is
// a deliberate act that updates this line — the capability names are what a
// contract, a role description and the admin screen quote, and one of them
// changing spelling between releases is a support call.
const CAPABILITY_VOCABULARY = [
  'accounting.export', 'accounting.view', 'audit.view', 'configuration.manage',
  'delivery.sign_off', 'inventory.manage', 'job.manage', 'purchase.order.create',
  'purchase.order.manage', 'purchase.order.mark_ordered', 'purchase.request.approve',
  'purchase.request.cancel', 'purchase.request.cancel.any', 'purchase.request.collaborate',
  'purchase.request.complete', 'purchase.request.create', 'purchase.request.edit',
  'purchase.request.review', 'purchase.request.view', 'purchase.request.view.all',
  'receiving.confirm', 'user.manage', 'vendor.manage',
];
{
  const actual = Object.keys(CAPABILITIES).sort();
  const expected = [...CAPABILITY_VOCABULARY].sort();
  check(JSON.stringify(actual) === JSON.stringify(expected),
    'the capability vocabulary is exactly the documented list',
    `extra: [${actual.filter((c) => !expected.includes(c)).join(', ')}] `
    + `missing: [${expected.filter((c) => !actual.includes(c)).join(', ')}]`);
}

// TOTALITY. Every permission the server enforces is reachable by at least one
// capability name.
//
// THE DEFECT THIS EXISTS TO CATCH: a partial crosswalk reads as the complete
// list of what the system can do. Eighteen permissions — cancelling, answering
// a clarification, the whole workshop review, completing a request, adjusting
// inventory, signing for a delivery, the accounting packet and every
// configuration screen — were enforced but unnameable, so no contract, role
// description or admin screen could refer to them.
{
  const reachable = new Set(Object.values(CAPABILITIES).flat());
  const orphans = PERMISSIONS.filter((p) => !reachable.has(p));
  check(orphans.length === 0,
    'capability_crosswalk_total: every permission is reachable from a capability',
    `unreachable: ${orphans.join(', ')}`);
}

// DISJOINT NAMESPACES. No capability is spelled like a permission.
//
// authorize() refuses an unknown permission, so a capability name passed where a
// permission belongs fails closed — but only while the two namespaces cannot
// collide. A capability named `inventory.adjust` would be indistinguishable
// from the permission of that name at a call site, and would authorize.
{
  const collisions = Object.keys(CAPABILITIES).filter((c) => PERMISSIONS.includes(c));
  check(collisions.length === 0,
    'no capability name is also a permission name',
    `collides: ${collisions.join(', ')}`);
}

// Nothing is enforced against a capability name. The map is a label; authorize()
// takes permissions. A capability reaching a call site would be a second gate.
{
  const ENFORCEMENT_FILES = [
    ['application', 'requests.ts'], ['application', 'review.ts'], ['application', 'decisions.ts'],
    ['application', 'fulfilment.ts'], ['application', 'administration.ts'], ['application', 'history.ts'],
    ['application', 'queries.ts'], ['application', 'integrations.ts'], ['application', 'context.ts'],
    ['domain', 'workspaces.mjs'], ['domain', 'navigation.mjs'],
  ];
  const capabilityNames = Object.keys(CAPABILITIES).filter((c) => !PERMISSIONS.includes(c));
  for (const parts of ENFORCEMENT_FILES) {
    const src = readFileSync(join(APP, ...parts), 'utf8');
    const used = capabilityNames.filter((c) => src.includes(`'${c}'`) || src.includes(`"${c}"`));
    check(used.length === 0,
      `${parts.join('/')} enforces on permissions, never on a capability name`,
      `mentions ${used.join(', ')}`);
  }
}

for (const preset of ROLE_PRESETS) {
  for (const r of preset.roles) {
    check(ROLES.includes(r), `preset ${preset.key} uses only real roles`, `${r} is not a role`);
  }
  check(presetByKey(preset.key) === preset, `preset ${preset.key} is findable by key`);
}

// Preset keys are unique — presetByKey() returns the first match, so a duplicate
// would make one of them unreachable and silently mis-provision people.
{
  const keys = ROLE_PRESETS.map((p) => p.key);
  check(new Set(keys).size === keys.length, 'preset keys are unique', keys.join(', '));
}

// EVERY ROLE IS PROVISIONABLE. A role with no preset can only be assigned by
// hand, which is how OFFICE-without-approval used to be set up: the only OFFICE
// preset carried the approval grant, so an administrator provisioning a
// coordinator had to pick APPROVER and remember to remove the grant afterwards.
{
  const covered = new Set(ROLE_PRESETS.flatMap((p) => p.roles));
  const orphanRoles = ROLES.filter((r) => !covered.has(r));
  check(orphanRoles.length === 0,
    'every role is reachable from at least one preset',
    `no preset offers: ${orphanRoles.join(', ')}`);
}

// A preset never grants approval authority the administrator did not ask for.
for (const preset of ROLE_PRESETS) {
  const u = user({ roles: preset.roles, canApprove: preset.canApprove });
  check(hasCapability(u, roles.APPROVE_PURCHASE) === Boolean(
    preset.canApprove || preset.roles.some((r) => ROLE_PERMISSIONS[r].includes('review.decide'))),
    `preset ${preset.key} confers approval authority only as declared`);
}

// ===========================================================================
console.log('--- the matrix: who holds what ---------------------------------');

// Asserted in BOTH directions. "Requester cannot approve" is the half that
// protects the business; "purchasing manager can approve" is the half that
// keeps the system usable. A model that fails either is wrong.
const EXPECTED = {
  ORGANIZATION_ADMIN: {
    // Every capability, not just the brief's minimum: ADMIN_PERMISSIONS is
    // PERMISSIONS, so a capability an admin does NOT hold is a broken bundle.
    yes: CAPABILITY_VOCABULARY,
    no: [],
  },
  PURCHASING_MANAGER: {
    yes: ['purchase.request.create', 'purchase.request.approve', 'purchase.request.review',
          'purchase.request.complete', 'purchase.request.cancel', 'purchase.request.cancel.any',
          'purchase.order.create', 'purchase.order.manage', 'purchase.order.mark_ordered',
          'receiving.confirm', 'inventory.manage'],
    no: ['vendor.manage', 'job.manage', 'user.manage', 'audit.view',
         'configuration.manage', 'accounting.export'],
  },
  OFFICE_COORDINATOR: {
    yes: ['purchase.request.create', 'purchase.request.view', 'purchase.request.view.all',
          'purchase.request.edit', 'purchase.request.collaborate', 'purchase.request.cancel',
          'receiving.confirm'],
    // The whole point of this preset: office authority WITHOUT approval.
    no: ['purchase.request.approve', 'purchase.request.review', 'purchase.request.complete',
         'purchase.request.cancel.any', 'purchase.order.create', 'purchase.order.manage',
         'purchase.order.mark_ordered', 'inventory.manage', 'accounting.view',
         'user.manage', 'vendor.manage', 'audit.view', 'configuration.manage'],
  },
  APPROVER: {
    yes: ['purchase.request.approve', 'purchase.request.review', 'purchase.order.create',
          'purchase.order.manage', 'purchase.order.mark_ordered', 'receiving.confirm'],
    no: ['user.manage', 'vendor.manage', 'audit.view', 'configuration.manage',
         // The grant confers purchasing authority, not closing or cancelling
         // authority: those stay with the workshop role.
         'purchase.request.complete', 'purchase.request.cancel.any', 'inventory.manage'],
  },
  REQUESTER: {
    yes: ['purchase.request.create', 'purchase.request.view', 'purchase.request.edit',
          'purchase.request.collaborate', 'purchase.request.cancel'],
    no: ['purchase.request.approve', 'purchase.request.review', 'purchase.request.view.all',
         'purchase.request.cancel.any', 'purchase.order.create', 'purchase.order.mark_ordered',
         'receiving.confirm', 'delivery.sign_off', 'inventory.manage', 'accounting.view',
         'accounting.export', 'user.manage', 'vendor.manage', 'audit.view', 'configuration.manage'],
  },
  FIELD_FOREMAN: {
    yes: ['purchase.request.create', 'purchase.request.collaborate', 'purchase.request.cancel',
          'receiving.confirm', 'delivery.sign_off'],
    no: ['purchase.request.approve', 'purchase.request.review', 'purchase.request.view.all',
         'purchase.order.create', 'purchase.order.mark_ordered', 'inventory.manage',
         'user.manage', 'vendor.manage', 'audit.view', 'configuration.manage'],
  },
  ACCOUNTING_READ_ONLY: {
    yes: ['accounting.view', 'accounting.export', 'purchase.request.view',
          'purchase.request.view.all'],
    no: ['purchase.request.create', 'purchase.request.approve', 'purchase.request.review',
         'purchase.request.collaborate', 'purchase.request.cancel', 'purchase.order.create',
         'purchase.order.mark_ordered', 'receiving.confirm', 'delivery.sign_off',
         'inventory.manage', 'user.manage', 'vendor.manage', 'configuration.manage'],
  },
};

// Every preset appears above. A preset added without expectations would be
// provisioned by administrators and asserted by nobody.
for (const preset of ROLE_PRESETS) {
  check(preset.key in EXPECTED, `preset ${preset.key} has capability expectations in this suite`);
}

for (const [key, expect] of Object.entries(EXPECTED)) {
  const preset = presetByKey(key);
  const u = user({ roles: preset.roles, canApprove: preset.canApprove });
  for (const c of expect.yes) {
    check(hasCapability(u, c), `${key} HOLDS ${c}`);
  }
  for (const c of expect.no) {
    check(!hasCapability(u, c), `${key} does NOT hold ${c}`, 'this role has more authority than intended');
  }
}

// Accounting holds no write permission at all. Stated as a property rather than
// a list, so a permission added later cannot quietly land in it.
{
  const acc = user({ roles: ['ACCOUNTING'] });
  const WRITES = PERMISSIONS.filter((p) =>
    /^(request\.(create|update|submit|cancel|attach|respond)|review\.|po\.|email\.|order\.|receiving\.|inventory\.|admin\.)/.test(p)
    && p !== 'request.note');
  const held = WRITES.filter((p) => permissionsFor(acc).includes(p));
  check(held.length === 0, 'ACCOUNTING holds no write permission', `holds ${held.join(', ')}`);
}

// ===========================================================================
console.log('--- the boundaries that matter ---------------------------------');

// Scenario D: a requester attempts approval.
{
  const requester = user({ roles: ['REQUESTOR'] });
  const d = authorize(requester, 'review.decide', { request: request() });
  check(!d.ok && d.reason === 'missing_permission', 'a requester attempting approval is refused', d.reason);
}

// Scenario D: a receiving-only user attempts PO generation.
{
  const field = user({ roles: ['FOREMAN'], assignedJobNumbers: ['24-118'] });
  const d = authorize(field, 'po.generate', { request: request() });
  check(!d.ok && d.reason === 'missing_permission', 'a field user attempting PO generation is refused', d.reason);
}

// Scenario D: another organization's record.
{
  const manager = user({ roles: ['WORKSHOP_APPROVER'], canApprove: true });
  const d = authorize(manager, 'review.decide', { request: request({ orgId: 'org-B' }) });
  check(!d.ok && d.reason === 'cross_tenant', 'another organization\'s request is refused', d.reason);
  // Ordering matters: tenant BEFORE role. An admin of org A is not an admin of
  // org B, and the refusal must not depend on them lacking a permission.
  const admin = user({ roles: ['ADMIN'], canApprove: true });
  const d2 = authorize(admin, 'review.decide', { request: request({ orgId: 'org-B' }) });
  check(!d2.ok && d2.reason === 'cross_tenant', 'an ADMIN is refused another organization\'s request', d2.reason);
}

// ===========================================================================
// BR-011 — APPROVAL AUTHORITY SUPERSEDES REQUESTER IDENTITY.
//
// The five cases the business stated, checked against authorize() itself. The
// question is never "did this person raise it"; it is only ever "does this
// person hold approval authority". Case 5 (the audit record) is a write, so it
// is asserted in eval-purchasing.mjs against a real database.
console.log('--- BR-011: approval authority ---------------------------------');
{
  // A request-only user: raises and submits, holds no approval capability.
  const requesterOnly = user({ id: 'u-req', roles: ['REQUESTOR'] });
  // An authorized purchaser: the Mike/Rick role. Buys, and approves.
  const purchaser = user({ id: 'u-buy', roles: ['WORKSHOP_APPROVER'], canApprove: true });
  // Office staff handed approval authority as a grant, without the workshop
  // role. Same authority, arrived at differently — BR-011 must not care which.
  const grantedApprover = user({ id: 'u-off', roles: ['OFFICE'], canApprove: true });

  const ownedBy = (id) => request({ requestorId: id, createdBy: id });

  // 1. A request-only user cannot approve their OWN request.
  const c1 = authorize(requesterOnly, 'review.decide', { request: ownedBy('u-req') });
  check(!c1.ok && c1.reason === 'missing_permission',
    'BR-011.1 a request-only user cannot approve their own request', c1.reason);

  // 2. ...nor anyone else's. Same reason: they hold no approval capability.
  const c2 = authorize(requesterOnly, 'review.decide', { request: ownedBy('u-other') });
  check(!c2.ok && c2.reason === 'missing_permission',
    "BR-011.2 a request-only user cannot approve another person's request", c2.reason);

  // 3. An authorized purchaser approves someone else's request.
  check(authorize(purchaser, 'review.decide', { request: ownedBy('u-other') }).ok,
    "BR-011.3 an authorized purchaser can approve another person's request");

  // 4. ...and their own. THIS is the rule that changed: the person authorized
  //    to buy is usually the person who needs the material.
  const c4 = authorize(purchaser, 'review.decide', { request: ownedBy('u-buy') });
  check(c4.ok, 'BR-011.4 an authorized purchaser can approve their own request', c4.reason);

  // The grant route reaches the same place. Approval authority is approval
  // authority however it was granted.
  check(authorize(grantedApprover, 'review.decide', { request: ownedBy('u-off') }).ok,
    'BR-011.4b an office approver with the explicit grant can approve their own request');

  // The rule the old code used is gone, in both directions: no org setting can
  // restore it, and none is needed to lift it.
  check(authorize(purchaser, 'review.decide', { request: ownedBy('u-buy'), settings: {} }).ok,
    'BR-011 approval does not depend on an org-wide self-approval setting');
  check(authorize(purchaser, 'review.decide', {
      request: ownedBy('u-buy'), settings: { allowSelfApproval: false },
    }).ok,
    'BR-011 the deprecated allowSelfApproval flag no longer gates a capability holder');
  check(!roles.DENY_REASONS.includes('self_approval'),
    "BR-011 'self_approval' is gone from the denial vocabulary");

  // The capability name the business uses resolves to the permission the code
  // enforces — one gate, two names, no drift.
  check(roles.APPROVE_PURCHASE === 'purchase.request.approve',
    'BR-011 APPROVE_PURCHASE names the approval capability');
  check(hasCapability(purchaser, roles.APPROVE_PURCHASE) && !hasCapability(requesterOnly, roles.APPROVE_PURCHASE),
    'BR-011 the approval capability is held by the purchaser and not by the requester');

  // Self-approval is still VISIBLE — it is recorded rather than refused.
  check(roles.isSelfApproval(purchaser, ownedBy('u-buy')), 'BR-011 a self-decision is identified for the audit trail');
  check(!roles.isSelfApproval(purchaser, ownedBy('u-other')), "BR-011 deciding someone else's request is not stamped as self-approval");

  // What BR-011 did NOT loosen: everything else still applies to an approver.
  const crossTenant = authorize(purchaser, 'review.decide', {
    request: request({ orgId: 'org-B', requestorId: 'u-buy', createdBy: 'u-buy' }),
  });
  check(!crossTenant.ok && crossTenant.reason === 'cross_tenant',
    'BR-011 does not let an approver reach another organization, even for their own request', crossTenant.reason);
  const inactive = authorize({ ...purchaser, isActive: false }, 'review.decide', { request: ownedBy('u-buy') });
  check(!inactive.ok && inactive.reason === 'inactive_user',
    'BR-011 does not let a deactivated approver decide their own request', inactive.reason);
}

// Receiving is job-scoped for field users, and NOT for shop staff.
{
  const assigned = user({ roles: ['FOREMAN'], assignedJobNumbers: ['24-118'] });
  const elsewhere = user({ roles: ['FOREMAN'], assignedJobNumbers: ['25-007'] });
  check(authorize(assigned, 'receiving.record', { request: request() }).ok,
    'a foreman signs for a delivery on his own job');
  const d = authorize(elsewhere, 'receiving.record', { request: request() });
  check(!d.ok && d.reason === 'not_assigned',
    'a foreman does NOT sign for a delivery on someone else\'s job', d.reason);

  const office = user({ roles: ['OFFICE'] });
  check(authorize(office, 'receiving.record', { request: request() }).ok,
    'shop staff receive at the counter without a job assignment');
}

// THE HANDOFF SEPARATION the brief asks for: purchasing authority is not
// receiving authority, in both directions.
{
  const purchaser = user({ roles: ['WORKSHOP_APPROVER'], canApprove: true });
  const receiver = user({ roles: ['FOREMAN'], assignedJobNumbers: ['24-118'] });
  check(authorize(purchaser, 'po.generate', { request: request() }).ok,
    'the purchasing manager orders');
  check(authorize(receiver, 'receiving.record', { request: request() }).ok,
    'someone else entirely confirms what arrived');
  check(!authorize(receiver, 'review.decide', { request: request() }).ok,
    'the receiver cannot approve');
  // And the purchaser is not REQUIRED to be the receiver — the brief's
  // "do not assume only the original purchaser can receive".
  check(authorize(receiver, 'receiving.record', { request: request({ requestorId: 'u-other' }) }).ok,
    'receiving does not require being the requestor or the purchaser');
}

// ===========================================================================
// BR-014 — RECEIPT AUTHORITY FOLLOWS CAPABILITY AND VERIFIED POSSESSION.
//
// Signing for material that physically arrived is a statement about a
// DELIVERY, not a second approval of the purchase. So the identity rules that
// govern approval have no place here: what decides it is the RECORD_RECEIPT
// capability plus the scope a person is authorized to verify.
//
// Case 7 (the actor recorded in the audit trail) is a write, and is asserted
// in eval-purchasing.mjs against a real database.
console.log('--- BR-014: receipt authority ----------------------------------');
{
  const requesterOnly = user({ id: 'u-req', roles: ['REQUESTOR'] });
  const foreman = user({ id: 'u-fore', roles: ['FOREMAN'], assignedJobNumbers: ['24-118'] });
  // The Mike/Rick shape: full purchasing authority, receives at the shop.
  const purchaser = user({ id: 'u-buy', roles: ['WORKSHOP_APPROVER'], canApprove: true });
  const admin = user({ id: 'u-adm', roles: ['ADMIN'], canApprove: true });
  // Office staff given receiving without the workshop role.
  const clerk = user({ id: 'u-off', roles: ['OFFICE'] });

  const ordered = (over = {}) => request({ status: 'ORDERED', ...over });

  // 1. A request-only user holds no receipt authority.
  const c1 = authorize(requesterOnly, 'receiving.record', { request: ordered() });
  check(!c1.ok && c1.reason === 'missing_permission',
    'BR-014.1 a request-only user cannot record receiving', c1.reason);
  check(!hasCapability(requesterOnly, roles.RECORD_RECEIPT),
    'BR-014.1 ...because they do not hold RECORD_RECEIPT');
  // ...and granting it is what changes that — the capability is the gate.
  check(hasCapability(user({ id: 'u-req2', roles: ['REQUESTOR', 'FOREMAN'], assignedJobNumbers: ['24-118'] }), roles.RECORD_RECEIPT),
    'BR-014.1 a separately granted receiving role carries RECORD_RECEIPT');

  // 2. A foreman receives on a job site he is assigned to.
  check(authorize(foreman, 'receiving.record', { request: ordered({ jobNumber: '24-118' }) }).ok,
    'BR-014.2 a foreman records receiving on his assigned job');

  // 3. ...and not on one he is not. Scope, not identity.
  const c3 = authorize(foreman, 'receiving.record', { request: ordered({ jobNumber: '25-007' }) });
  check(!c3.ok && c3.reason === 'not_assigned',
    'BR-014.3 a scope-restricted foreman cannot receive an unrelated job', c3.reason);

  // 4. Purchasing/workshop staff receive at the shop counter, unscoped — the
  //    counter is not a job site, so an assignment list would be meaningless.
  check(authorize(purchaser, 'receiving.record', { request: ordered({ jobNumber: '99-999' }) }).ok,
    'BR-014.4 a workshop user records receipt for a workshop delivery, on any job');
  check(authorize(clerk, 'receiving.record', { request: ordered({ jobNumber: '99-999' }) }).ok,
    'BR-014.4 office staff receive at the counter without a job assignment');
  check(authorize(admin, 'receiving.record', { request: ordered() }).ok,
    'BR-014.4 an admin receives according to configured authority');

  // 5. The order they raised themselves.
  const own = ordered({ requestorId: 'u-buy', createdBy: 'u-buy' });
  check(authorize(purchaser, 'receiving.record', { request: own }).ok,
    'BR-014.5 an authorized purchaser receives an order they requested themselves');

  // 6. The order they approved themselves — including a BR-011 self-approval,
  //    where one person is requester AND approver. Neither fact is consulted.
  const selfApproved = ordered({ requestorId: 'u-buy', createdBy: 'u-buy', approverId: 'u-buy' });
  check(authorize(purchaser, 'receiving.record', { request: selfApproved }).ok,
    'BR-014.6 an authorized purchaser receives an order they approved themselves');
  check(authorize(purchaser, 'receiving.record', { request: ordered({ approverId: 'u-buy' }) }).ok,
    'BR-014.6 approving an order does not disqualify you from signing for it');

  // The refusal the screen shows must name the RIGHT thing. One message for
  // three situations is what made a status problem look like a permissions
  // problem to somebody who had every permission.
  const availability = roles.receivingAvailability;
  check(availability(purchaser, ordered()).ok, 'BR-014 receiving is available to a capable user on an open order');
  check(availability(purchaser, ordered({ status: 'PARTIALLY_RECEIVED' })).ok,
    'BR-014 a part-received order is still receivable — partial receiving is preserved');
  check(availability(purchaser, request({ status: 'RECEIVED' })).reason === 'not_receivable',
    'BR-014 a fully received order reports the STATUS, not a permissions problem');
  check(availability(purchaser, request({ status: 'APPROVED' })).reason === 'not_receivable',
    'BR-014 an order that has not been placed yet reports the status too');
  check(availability(requesterOnly, ordered()).reason === 'no_capability',
    'BR-014 someone who genuinely cannot receive is told that, and only that');
  check(availability(foreman, ordered({ jobNumber: '25-007' })).reason === 'not_assigned',
    'BR-014 a scope refusal names the scope');
  check(availability(purchaser, ordered({ orgId: 'org-B' })).reason === 'cross_tenant',
    'BR-014 the tenant boundary still fires first');
  check(availability(purchaser, own).ok,
    'BR-014 the screen offers receiving on an order the viewer raised — no identity test anywhere');

  check(roles.RECORD_RECEIPT === 'receiving.confirm', 'BR-014 RECORD_RECEIPT names the receiving capability');
  check(CAPABILITIES[roles.RECORD_RECEIPT].includes('receiving.record'),
    'BR-014 the capability resolves to the permission authorize() actually enforces');
}

// ===========================================================================
console.log('--- the workshop is a location, not a role ---------------------');

// Receiving scope used to be inferred from ROLE. A foreman who also worked the
// shop counter could only be given shop receiving authority by handing him an
// OFFICE or WORKSHOP_APPROVER role — approving, ordering and every request in
// the company, to let him sign for a box. The workshop is now a LOCATION,
// assigned through the same mechanism as a job site.
{
  const { WORKSHOP_LOCATION, mayReceiveAt, receivingScopeFor, isReservedLocation } = roles;
  const at = (jobNumber, locationKind = 'JOBSITE') => ({ jobNumber, locationKind });
  const foreman = (locations) => user({ id: 'u-fm', roles: ['FOREMAN'], assignedJobNumbers: locations });

  check(WORKSHOP_LOCATION === 'WORKSHOP', 'the reserved location key is WORKSHOP');

  // --- no regression: shop-counter roles stay unscoped ---------------------
  for (const role of roles.SHOP_COUNTER_ROLES) {
    const shopStaff = user({ roles: [role], assignedJobNumbers: [] });
    check(receivingScopeFor(shopStaff).unscoped, `${role} is unscoped for receiving`);
    check(mayReceiveAt(shopStaff, at('24-999')) && mayReceiveAt(shopStaff, at(null, 'WORKSHOP')),
      `${role} signs anywhere without an assignment — the counter is their post`);
  }

  // --- a field user is scoped to what they were ASSIGNED -------------------
  const site = foreman(['24-118']);
  check(mayReceiveAt(site, at('24-118')), 'a foreman signs for his own job site');
  check(!mayReceiveAt(site, at('24-999')), 'a foreman does not sign for a site he is not on');

  // THE POINT OF THE CHANGE, in both directions.
  check(!mayReceiveAt(site, at('24-118', 'WORKSHOP')),
    'a job-site foreman does NOT sign for a workshop delivery — he is not standing there, '
    + 'even when the material is destined for his job');
  const shopForeman = foreman([WORKSHOP_LOCATION]);
  check(mayReceiveAt(shopForeman, at('24-118', 'WORKSHOP')),
    'a foreman assigned the workshop signs for a workshop delivery');
  check(!mayReceiveAt(shopForeman, at('24-118')),
    'and gains nothing on a job site he was not assigned — the assignment is the whole grant');

  // Both, because assignment has always been a join table.
  const both = foreman(['24-118', '24-203', WORKSHOP_LOCATION]);
  check(mayReceiveAt(both, at('24-118')) && mayReceiveAt(both, at('24-203'))
     && mayReceiveAt(both, at('24-118', 'WORKSHOP')),
    'a person may hold several job sites and the workshop at once');
  check(!mayReceiveAt(both, at('24-999')), 'and still nothing they were not given');

  // Collected from the vendor, or dropped at the office: not a job site, so it
  // is the shop assignment that answers.
  for (const kind of ['OFFICE', 'VENDOR_PICKUP']) {
    check(mayReceiveAt(shopForeman, at('24-118', kind)) && !mayReceiveAt(site, at('24-118', kind)),
      `${kind} follows the workshop assignment, not the job assignment`);
  }

  // An unknown or absent kind means what every record meant before this
  // existed: the job site. No record changes meaning.
  check(mayReceiveAt(site, { jobNumber: '24-118' }) && mayReceiveAt(site, at('24-118', null)),
    'a destination with no kind is the job site — existing records are unchanged');

  // --- the key cannot be counterfeited by a job number ---------------------
  check(isReservedLocation('WORKSHOP') && isReservedLocation('workshop') && isReservedLocation(' Workshop '),
    'the reserved key is recognised whatever the casing or padding');
  check(!isReservedLocation('24-118') && !isReservedLocation('') && !isReservedLocation(null),
    'an ordinary job number is not reserved');

  // --- and authorize() asks the same question ------------------------------
  const ordered = (over = {}) => request({ status: 'ORDERED', jobNumber: '24-118', ...over });
  check(authorize(shopForeman, 'receiving.record', { request: ordered({ deliveryLocationKind: 'WORKSHOP' }) }).ok,
    'authorize() lets the shop-assigned foreman record a workshop receipt');
  const refused = authorize(site, 'receiving.record', { request: ordered({ deliveryLocationKind: 'WORKSHOP' }) });
  check(!refused.ok && refused.reason === 'not_assigned',
    'authorize() refuses the job-site foreman the same receipt', refused.reason);
  check(/workshop/i.test(refused.message ?? ''),
    'and the refusal names the WORKSHOP rather than a job number the reader would go looking for',
    refused.message);
  check(authorize(site, 'receiving.record', { request: ordered() }).ok,
    'while his own job site still works exactly as before');
}

// A requestor's edit window closes when the workshop takes over.
{
  const requester = user({ id: 'u-1', roles: ['REQUESTOR'] });
  const own = (status) => request({ requestorId: 'u-1', createdBy: 'u-1', status });
  check(authorize(requester, 'request.update.own', { request: own('DRAFT') }).ok,
    'a requestor edits their own draft');
  const d = authorize(requester, 'request.update.own', { request: own('PENDING_WORKSHOP_REVIEW') });
  check(!d.ok && d.reason === 'request_locked',
    'a requestor cannot edit a request the workshop is reviewing', d.reason);
  check(!authorize(requester, 'request.update.own', { request: request({ requestorId: 'u-2', createdBy: 'u-2', status: 'DRAFT' }) }).ok,
    'a requestor cannot edit someone else\'s draft');
}

// A deactivated user is refused everything, whatever they hold.
{
  const gone = user({ roles: ['ADMIN'], canApprove: true, isActive: false });
  for (const p of ['request.create', 'review.decide', 'po.generate', 'admin.users']) {
    const d = authorize(gone, p, { request: request() });
    check(!d.ok && d.reason === 'inactive_user', `a deactivated ADMIN is refused ${p}`, d.reason);
  }
}

// No session at all.
{
  const d = authorize(null, 'request.create');
  check(!d.ok && d.reason === 'no_session', 'no session is refused');
}

// An unknown permission is refused rather than allowed. A typo in a call site
// must fail closed.
{
  const admin = user({ roles: ['ADMIN'], canApprove: true });
  const d = authorize(admin, 'request.aprove');
  check(!d.ok && d.reason === 'unknown_permission', 'a misspelled permission is refused, not allowed', d.reason);
}

// ===========================================================================
console.log('--- home is a permission decision, not a constant ---------------');

// The brand mark used to link to `/`, which redirects to the DEFAULT WORKSPACE:
// clicking the logo took an admin to Administration and never took anybody to
// the dashboard. Pointing it at /dashboard unconditionally would be worse — a
// requester holds no `request.read.all`, so the most-clicked control on the
// screen would redirect them to /unauthorized every time.
{
  const { homeFor, defaultWorkspaceFor, guardFor } = await import(join(APP, 'domain', 'workspaces.mjs'));

  check(guardFor('/dashboard')?.permission === 'request.read.all',
    'the dashboard is guarded by request.read.all — the permission home must respect');

  for (const key of ['ORGANIZATION_ADMIN', 'PURCHASING_MANAGER', 'OFFICE_COORDINATOR',
                     'APPROVER', 'ACCOUNTING_READ_ONLY']) {
    const preset = presetByKey(key);
    const u = user({ roles: preset.roles, canApprove: preset.canApprove });
    check(homeFor(u) === '/dashboard', `${key} goes home to the dashboard`);
  }

  for (const key of ['REQUESTER', 'FIELD_FOREMAN']) {
    const preset = presetByKey(key);
    const u = user({ roles: preset.roles, canApprove: preset.canApprove });
    const home = homeFor(u);
    check(home !== '/dashboard', `${key} is not sent to a dashboard they cannot open`);
    check(home === defaultWorkspaceFor(u), `${key} goes home to their own workspace instead`);
    // The whole point: home must be a page they can actually open.
    const guard = guardFor(home);
    check(!guard || permissionsFor(u).includes(guard.permission),
      `${key}'s home passes its own route guard`, `${home} needs ${guard?.permission}`);
  }

  // Signing in is a different question and must not have moved.
  check(defaultWorkspaceFor(user({ roles: ['ADMIN'], canApprove: true })) === '/admin'
     && defaultWorkspaceFor(user({ roles: ['FOREMAN'] })) === '/my-requests',
    'where sign-in lands is unchanged — home is only where "back to the start" goes');
}

// No individual is named in authorization logic.
{
  const src = readFileSync(join(APP, 'domain', 'roles.mjs'), 'utf8');
  for (const name of ['Mike', 'Rick', 'mike', 'rick', 'Lippolis', 'lippolis']) {
    check(!new RegExp(`\\b${name}\\b`).test(src),
      `no individual or customer is hardcoded in roles.mjs (${name})`);
  }
}

// ===========================================================================
console.log('');
console.log(`authorization checks: ${pass} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
