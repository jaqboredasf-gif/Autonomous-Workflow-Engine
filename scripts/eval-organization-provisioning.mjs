// ---------------------------------------------------------------------------
// eval-organization-provisioning.mjs — can a second organization use purchasing
// without editing purchasing?
//
// THE QUESTION, asked in the only way that means anything: take the real
// purchasing use cases, give them an organization whose roles are named nothing
// like Lippolis's, and see whether the same work is authorized.
//
// It proves four things:
//   1. the built-in default and the explicit profile agree, role for role
//   2. a differently-named role carrying the same capabilities authorizes the
//      same purchasing actions
//   3. a capability nobody holds is refused
//   4. organization A's grants do not reach organization B's members
//
//   node scripts/eval-organization-provisioning.mjs
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DOMAIN = join(ROOT, 'apps', 'purchasing', 'src', 'purchasing', 'domain');
const CAP = join(ROOT, 'capability', 'purchasing');

const { authorize, permissionsFor, ROLE_PERMISSIONS, APPROVAL_GRANT_PERMISSIONS, PERMISSIONS } =
  await import(join(DOMAIN, 'roles.mjs'));
const { defineAuthorizationProfile, effectiveCapabilities, withCapabilities, capabilityDiff, CAPABILITIES } =
  await import(join(CAP, 'authorization.mjs'));
const { lippolisAuthorization } = await import(join(CAP, 'profiles', 'lippolis-authorization.mjs'));
const { org002Authorization } = await import(join(CAP, 'profiles', 'org-002-authorization.mjs'));

let pass = 0;
const failures = [];
const ok = () => { pass++; };
const bad = (m) => { failures.push(m); console.log(`FAIL  ${m}`); };
const check = (c, m) => (c ? ok() : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok() : bad(`${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

const actor = (over = {}) => ({ id: 'u1', orgId: 'lippolis', isActive: true, roles: [], ...over });

// ---------------------------------------------------------------------------
console.log('--- the profile reproduces the built-in behaviour exactly -------');

// If the explicit profile cannot reproduce what the code already does, it is
// not a boundary — it is a rewrite wearing one.
for (const role of Object.keys(ROLE_PERMISSIONS)) {
  const builtIn = permissionsFor(actor({ roles: [role] }));
  const viaProfile = effectiveCapabilities(lippolisAuthorization, { orgId: 'lippolis', roles: [role] });
  eq(viaProfile, builtIn, `${role} resolves identically through the profile`);
}
{
  const builtIn = permissionsFor(actor({ roles: ['OFFICE'], canApprove: true }));
  const viaProfile = effectiveCapabilities(lippolisAuthorization, { orgId: 'lippolis', roles: ['OFFICE'], canApprove: true });
  eq(viaProfile, builtIn, 'the per-person approval grant resolves identically too');
}

// ---------------------------------------------------------------------------
console.log('--- an actor carrying capabilities bypasses the built-in table --');

{
  // The seam itself: purchasing consults resolved capabilities when they exist.
  const resolved = withCapabilities(actor({ orgId: 'org-002-trades', roles: ['OPERATIONS_MANAGER'] }), org002Authorization);
  check(resolved.capabilities.includes('po.generate'), 'a resolved actor carries its organization capabilities');
  eq(permissionsFor(resolved), resolved.capabilities, 'and permissionsFor returns exactly those');

  // A role name the built-in table has never heard of.
  check(!Object.keys(ROLE_PERMISSIONS).includes('OPERATIONS_MANAGER'),
    'OPERATIONS_MANAGER is unknown to the built-in vocabulary');
  eq(permissionsFor(actor({ roles: ['OPERATIONS_MANAGER'] })), [],
    'and without a profile it grants nothing — roles are not invented by hoping');
}

// ---------------------------------------------------------------------------
console.log('--- same capability, different vocabulary, same authority -------');

// The headline proof. Two organizations, no shared role name, identical
// purchasing authority — decided by the same authorize() the use cases call.
const PURCHASING_ACTIONS = [
  'review.decide', 'po.generate', 'email.draft', 'email.review',
  'order.mark_ordered', 'receiving.record', 'request.complete',
];
{
  const lippolisApprover = withCapabilities(
    actor({ id: 'mike', orgId: 'lippolis', roles: ['WORKSHOP_APPROVER'] }), lippolisAuthorization,
  );
  const org002Approver = withCapabilities(
    actor({ id: 'sam', orgId: 'org-002-trades', roles: ['OPERATIONS_MANAGER'] }), org002Authorization,
  );

  for (const capability of PURCHASING_ACTIONS) {
    const a = authorize(lippolisApprover, capability);
    const b = authorize(org002Approver, capability);
    check(a.ok, `Lippolis approver may ${capability}`);
    eq(b.ok, a.ok, `and the org-002 operations manager may ${capability} identically`);
  }

  check(!lippolisApprover.roles.some((r) => org002Approver.roles.includes(r)),
    'the two organizations share no role name at all');
}

// ---------------------------------------------------------------------------
console.log('--- a capability nobody holds is refused ------------------------');

{
  const yardHand = withCapabilities(
    actor({ id: 'yh', orgId: 'org-002-trades', roles: ['YARD_HAND'] }), org002Authorization,
  );
  const mayReceive = authorize(yardHand, 'receiving.record');
  check(mayReceive.ok, 'the yard hand may receive');

  for (const forbidden of ['po.generate', 'review.decide', 'order.mark_ordered', 'admin.users']) {
    const decision = authorize(yardHand, forbidden);
    check(!decision.ok, `and is refused ${forbidden}`);
    eq(decision.reason, 'missing_permission', `for the right reason (${forbidden})`);
  }

  // A capability outside the vocabulary is refused whatever the profile says.
  eq(authorize(yardHand, 'purchasing.do_anything').reason, 'unknown_permission',
    'an invented capability is refused as unknown');
}

// ---------------------------------------------------------------------------
console.log('--- grants do not cross the organization boundary ---------------');

{
  // Organization A's profile must not resolve for organization B's member.
  const foreignMember = { orgId: 'org-002-trades', roles: ['WORKSHOP_APPROVER'], canApprove: true };
  eq(effectiveCapabilities(lippolisAuthorization, foreignMember), [],
    "Lippolis's profile grants nothing to a member of another organization");

  const lippolisMember = { orgId: 'lippolis', roles: ['OPERATIONS_MANAGER'] };
  eq(effectiveCapabilities(org002Authorization, lippolisMember), [],
    "and org-002's profile grants nothing to a Lippolis member");

  // Resolving with the WRONG profile leaves the actor with nothing, so a
  // provisioning mistake fails closed rather than granting somebody else's
  // authority.
  const misprovisioned = withCapabilities(
    actor({ id: 'x', orgId: 'org-002-trades', roles: ['OPERATIONS_MANAGER'] }), lippolisAuthorization,
  );
  eq(misprovisioned.capabilities, [], 'a mis-provisioned actor gets nothing, not somebody else authority');
  check(!authorize(misprovisioned, 'po.generate').ok, 'and is refused every action');

  // And the record-level tenant check still fires independently.
  const approver = withCapabilities(actor({ id: 'mike', orgId: 'lippolis', roles: ['WORKSHOP_APPROVER'] }), lippolisAuthorization);
  const otherOrgRequest = { id: 'r1', orgId: 'org-002-trades', requestorId: 'someone' };
  eq(authorize(approver, 'review.decide', { request: otherOrgRequest }).reason, 'cross_tenant',
    'a record from another organization is still refused before any role is considered');
}

// ---------------------------------------------------------------------------
console.log('--- profiles cannot invent what purchasing can do ---------------');

{
  let threw = null;
  try {
    defineAuthorizationProfile({ orgId: 'bad', roles: { R: ['purchasing.delete_everything'] } });
  } catch (err) { threw = err.message; }
  check(threw && /unknown capability/.test(threw), 'a profile granting an unknown capability is refused at construction');

  let noOrg = null;
  try { defineAuthorizationProfile({ roles: {} }); } catch (err) { noOrg = err.message; }
  check(noOrg && /organization/.test(noOrg), 'a profile must name its organization');

  eq(CAPABILITIES, PERMISSIONS, 'the capability vocabulary is the domain, not the profile');
}

// ---------------------------------------------------------------------------
console.log('--- what the two organizations actually differ on ---------------');

{
  const diff = capabilityDiff(lippolisAuthorization, org002Authorization);
  check(diff.shared.length > 20, `the organizations share most capabilities (${diff.shared.length})`);
  // org-002 has no ACCOUNTING role but folds those capabilities into the office,
  // and grants no per-person approval — so the sets are close but not equal.
  console.log(`  note: only Lippolis grants: ${diff.onlyInFirst.join(', ') || '(none)'}`);
  console.log(`  note: only org-002 grants: ${diff.onlyInSecond.join(', ') || '(none)'}`);
}

console.log('');
console.log(`organization provisioning checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);
