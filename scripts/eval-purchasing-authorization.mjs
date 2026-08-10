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
const USE_CASE_FILES = ['requests.ts', 'review.ts', 'decisions.ts', 'fulfilment.ts', 'administration.ts'];

// Internal helpers, exported for composition but never reached from a route.
// Each is listed with the caller that DOES authorize, so this stays a decision
// rather than a hole.
const AUTHORIZED_BY_CALLER = {
  'review.ts:recomputeTotals': 'saveWorkshopReview',
  'review.ts:changesFromOriginal': 'read-only diff, no write',
  'fulfilment.ts:renderAndStore': 'generatePurchaseOrder (po.generate)',
  'decisions.ts:saveReviewAndDecide': 'delegates to saveWorkshopReview + decidePurchaseRequest',
  'administration.ts:poConfig': 'read-only; authorizes with admin.po_config',
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

for (const preset of ROLE_PRESETS) {
  for (const r of preset.roles) {
    check(ROLES.includes(r), `preset ${preset.key} uses only real roles`, `${r} is not a role`);
  }
  check(presetByKey(preset.key) === preset, `preset ${preset.key} is findable by key`);
}

// ===========================================================================
console.log('--- the matrix: who holds what ---------------------------------');

// Asserted in BOTH directions. "Requester cannot approve" is the half that
// protects the business; "purchasing manager can approve" is the half that
// keeps the system usable. A model that fails either is wrong.
const EXPECTED = {
  ORGANIZATION_ADMIN: {
    yes: REQUIRED_CAPABILITIES,
    no: [],
  },
  PURCHASING_MANAGER: {
    yes: ['purchase.request.create', 'purchase.request.approve', 'purchase.order.create',
          'purchase.order.manage', 'purchase.order.mark_ordered', 'receiving.confirm'],
    no: ['vendor.manage', 'job.manage', 'user.manage', 'audit.view'],
  },
  APPROVER: {
    yes: ['purchase.request.approve', 'purchase.order.create'],
    no: ['user.manage', 'vendor.manage', 'audit.view'],
  },
  REQUESTER: {
    yes: ['purchase.request.create', 'purchase.request.view', 'purchase.request.edit'],
    no: ['purchase.request.approve', 'purchase.order.create', 'purchase.order.mark_ordered',
         'receiving.confirm', 'accounting.view', 'user.manage', 'vendor.manage', 'audit.view'],
  },
  FIELD_FOREMAN: {
    yes: ['purchase.request.create', 'receiving.confirm'],
    no: ['purchase.request.approve', 'purchase.order.create', 'purchase.order.mark_ordered',
         'user.manage', 'vendor.manage', 'audit.view'],
  },
  ACCOUNTING_READ_ONLY: {
    yes: ['accounting.view', 'purchase.request.view'],
    no: ['purchase.request.create', 'purchase.request.approve', 'purchase.order.create',
         'purchase.order.mark_ordered', 'receiving.confirm', 'user.manage', 'vendor.manage'],
  },
};

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
