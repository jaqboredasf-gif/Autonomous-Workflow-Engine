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
// And, since the numbering seam landed, four more about PO NUMBERS:
//   5. Lippolis's numbers are byte-for-byte what they were
//   6. an organization with a completely different rule needs no core change
//   7. one organization's rule cannot reach another organization's counters
//   8. an organization with no rule, or a rule this build cannot perform, is
//      refused — it is never given a placeholder number
//
//   node scripts/eval-organization-provisioning.mjs
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

const PURCHASING = join(ROOT, 'apps', 'purchasing', 'src', 'purchasing');
const { definePoNumberStrategy, requirePoNumberStrategy, poNumberFrom, sequenceKeyFor } =
  await import(join(DOMAIN, 'po-number-strategy.mjs'));
const { JOB_VENDOR_SEQUENCE, poNumberStrategyFor, IMPLEMENTED_IDS } =
  await import(join(PURCHASING, 'organization', 'po-numbering.mjs'));
const { openDatabase } = await import(join(PURCHASING, 'infrastructure', 'sqlite', 'database.ts'));
const { sqlitePoNumberAllocator } = await import(join(PURCHASING, 'infrastructure', 'sqlite', 'repositories.ts'));
const lippolisProfile = (await import(join(CAP, 'profiles', 'lippolis.mjs'))).lippolis
  ?? (await import(join(CAP, 'profiles', 'lippolis.mjs'))).default;
const org002Profile = (await import(join(CAP, 'profiles', 'org-002-trades.mjs'))).org002Trades
  ?? (await import(join(CAP, 'profiles', 'org-002-trades.mjs'))).default;

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


// ===========================================================================
// PO NUMBERING — the second thing an organization owns.
//
// The role vocabulary proved that WHO may act is the organization's. This
// proves the same for WHAT ITS PURCHASE ORDERS ARE CALLED, and it is proved the
// hard way: against a real database, through the real allocator, with a
// strategy defined HERE — in the test file, outside the application entirely —
// so that "a second organization needs no core change" is demonstrated rather
// than asserted.
// ===========================================================================

console.log('--- the profile names the rule, the strategy performs it --------');

eq(lippolisProfile.purchasing.po_numbering, JOB_VENDOR_SEQUENCE.id,
  'the Lippolis profile names the strategy this build implements');
{
  // Selection now BUILDS the strategy, because a rule takes the organization's
  // separator. Identity is therefore the wrong test and behaviour is the right
  // one: the selected strategy must number and scope exactly as the frozen
  // Lippolis instance does.
  const selected = poNumberStrategyFor(lippolisProfile.purchasing.po_numbering);
  eq(selected.id, JOB_VENDOR_SEQUENCE.id, 'selecting by the profile id returns the Lippolis rule');
  eq(selected.format({ jobNumber: '1234', vendorCode: 'COOPER', sequence: 3 }),
    JOB_VENDOR_SEQUENCE.format({ jobNumber: '1234', vendorCode: 'COOPER', sequence: 3 }),
    'and it formats identically to the frozen instance');
  eq(selected.sequenceScope({ jobNumber: '1234', vendorId: 'v1' }),
    JOB_VENDOR_SEQUENCE.sequenceScope({ jobNumber: '1234', vendorId: 'v1' }),
    'and scopes its counter identically');
  eq(poNumberStrategyFor(lippolisProfile.purchasing.po_numbering, 'lippolis',
    { separator: lippolisProfile.purchasing.po_separator }).format({ jobNumber: '1234', vendorCode: 'COOPER', sequence: 3 }),
    '1234-COOPER-3',
    'and passing Lippolis\'s own declared separator changes nothing — it was always the hyphen');
}

// ---------------------------------------------------------------------------
console.log('--- Lippolis numbers are exactly what they were -----------------');

// FROZEN OUTPUT. These four strings came from Mike and Paul. If the seam
// changed any of them it broke a supplier's paperwork, not a test.
for (const [components, want] of [
  [{ jobNumber: '1234', vendorCode: 'COOPER', sequence: 1 }, '1234-COOPER-1'],
  [{ jobNumber: '1234', vendorCode: 'COOPER', sequence: 2 }, '1234-COOPER-2'],
  [{ jobNumber: '1234', vendorCode: 'GRAYBAR', sequence: 1 }, '1234-GRAYBAR-1'],
  [{ jobNumber: '5678', vendorCode: 'COOPER', sequence: 1 }, '5678-COOPER-1'],
  // The job's own hyphen survives; no padding is added.
  [{ jobNumber: '24-118', vendorCode: 'COOPER', sequence: 12 }, '24-118-COOPER-12'],
]) {
  eq(JOB_VENDOR_SEQUENCE.format(components), want, `Lippolis still numbers ${want}`);
}
eq(JOB_VENDOR_SEQUENCE.sequenceScope({ jobNumber: ' 24/118 ', vendorId: 'v1' }), { jobKey: '24118', vendorKey: 'v1' },
  'the Lippolis counter is scoped to the (job, vendor) pair, on the sanitized job');

// ---------------------------------------------------------------------------
console.log('--- a synthetic organization with a different rule --------------');

// DELIBERATELY UNLIKE LIPPOLIS, and deliberately trivial: no job in the number,
// no vendor in the number, no hyphen-joined components, and a counter scoped to
// the VENDOR rather than the pair. If purchasing had any assumption about the
// shape of a number left in it, this would not work.
const SYNTHETIC = definePoNumberStrategy({
  id: 'synthetic-vendor-sequence',
  sequenceScope: ({ vendorId }) => ({ vendorKey: vendorId }),
  format: ({ sequence }) => `SYN-${sequence}`,
});

const tmp = mkdtempSync(join(tmpdir(), 'pcc-numbering-'));
const db = openDatabase(join(tmp, 'numbering.db'));
const NOW = '2026-08-13T09:00:00.000Z';

const seedOrg = (orgId, vendors) => {
  db.prepare('insert into orgs (id, name, created_at, updated_at) values (?,?,?,?)').run(orgId, orgId, NOW, NOW);
  for (const [id, name, code] of vendors) {
    db.prepare('insert into vendors (id, org_id, name, code, is_active, created_at, updated_at) values (?,?,?,?,1,?,?)')
      .run(id, orgId, name, code, NOW, NOW);
  }
};
// One administrator per organization: `initialize` records who declared the
// counter, and that is a foreign key rather than a free-text name.
const seedAdmin = (orgId, id) =>
  db.prepare('insert into users (id, org_id, full_name, email, is_active, created_at, updated_at) values (?,?,?,?,1,?,?)')
    .run(id, orgId, 'Administrator', `${id}@example.invalid`, NOW, NOW);

seedOrg('org-lippolis', [['v-cooper', 'Cooper Electric Supply Co.', 'COOPER'], ['v-graybar', 'Graybar', 'GRAYBAR']]);
seedOrg('org-synth', [['v-syn', 'Northgate Supply', 'NORTHGATE']]);
seedAdmin('org-lippolis', 'admin-lip');
seedAdmin('org-synth', 'admin-syn');

// TWO ALLOCATORS OVER ONE DATABASE, each bound to its organization's rule. This
// is the composition root's job in production; doing it by hand here is what
// makes the isolation claim testable.
const lippolisNumbers = sqlitePoNumberAllocator(db, JOB_VENDOR_SEQUENCE);
const synthNumbers = sqlitePoNumberAllocator(db, SYNTHETIC);

const lipScope = (jobNumber, vendorId, vendorCode) => ({ orgId: 'org-lippolis', jobNumber, vendorId, vendorCode });
const synScope = (jobNumber) => ({ orgId: 'org-synth', jobNumber, vendorId: 'v-syn', vendorCode: 'NORTHGATE' });

{
  // Lippolis, through the real allocator and the real counter table.
  const issued = [];
  for (const [job, vendor, code] of [
    ['1234', 'v-cooper', 'COOPER'], ['1234', 'v-cooper', 'COOPER'],
    ['1234', 'v-graybar', 'GRAYBAR'], ['5678', 'v-cooper', 'COOPER'],
  ]) issued.push(await lippolisNumbers.allocate(lipScope(job, vendor, code), NOW));

  eq(issued.map((r) => r.poNumber), ['1234-COOPER-1', '1234-COOPER-2', '1234-GRAYBAR-1', '5678-COOPER-1'],
    'the allocator issues the Lippolis sequence exactly as the office writes it');
  eq(issued.map((r) => r.sequenceValue), [1, 2, 1, 1],
    'each (job, vendor) pair counts on its own from 1');
}

{
  // The synthetic organization, over the SAME database, the SAME allocator
  // code, the SAME counter table. Only the strategy differs.
  const a = await synthNumbers.allocate(synScope('J-1'), NOW);
  const b = await synthNumbers.allocate(synScope('J-2'), NOW);
  eq([a.poNumber, b.poNumber], ['SYN-1', 'SYN-2'],
    'a different organization gets a completely different number shape from unmodified purchasing');
  // AND A DIFFERENT SCOPE. Two different jobs, one counter, because this
  // organization counts per vendor — proof the seam governs the counter's key
  // and not only the string.
  eq([a.sequenceValue, b.sequenceValue], [1, 2],
    'its counter is scoped to the vendor, so a second job continues the same run');
}

// ---------------------------------------------------------------------------
console.log('--- one organization\'s rule cannot reach another\'s counters -----');

{
  // Lippolis has issued 1234-COOPER-1 and -2. The synthetic organization is
  // asked for the same job and a vendor code that reads the same. It must not
  // see, continue, or disturb that counter.
  const before = db.prepare(
    'select next_value from po_job_vendor_sequences where org_id = ? and job_number = ? and vendor_id = ?',
  ).get('org-lippolis', '1234', 'v-cooper');

  const crossing = await synthNumbers.allocate(synScope('1234'), NOW);
  eq(crossing.poNumber, 'SYN-3', 'the second organization continues its OWN counter, not the first one\'s');

  const after = db.prepare(
    'select next_value from po_job_vendor_sequences where org_id = ? and job_number = ? and vendor_id = ?',
  ).get('org-lippolis', '1234', 'v-cooper');
  eq(Number(after.next_value), Number(before.next_value),
    'the first organization\'s counter was not touched');

  const next = await lippolisNumbers.allocate(lipScope('1234', 'v-cooper', 'COOPER'), NOW);
  eq(next.poNumber, '1234-COOPER-3', 'and it carries on from where it was');

  // The counter rows are org-scoped in the store, which is what makes the above
  // true rather than lucky.
  const rows = db.prepare('select distinct org_id from po_job_vendor_sequences order by org_id').all();
  eq(rows.map((r) => r.org_id), ['org-lippolis', 'org-synth'], 'every counter row names its organization');
}

// ---------------------------------------------------------------------------
console.log('--- sequence correctness survives the seam ----------------------');

{
  // FORWARD ONLY, AND NEVER TWICE. The database, not the strategy, is what
  // makes this true — the strategy is handed a number, it never picks one.
  await lippolisNumbers.initialize(lipScope('9000', 'v-cooper', 'COOPER'), 41, 'admin-lip', NOW);
  const resumed = await lippolisNumbers.allocate(lipScope('9000', 'v-cooper', 'COOPER'), NOW);
  eq(resumed.poNumber, '9000-COOPER-41', 'an initialized pair resumes from the declared value');

  const seen = new Set();
  for (let i = 0; i < 25; i++) seen.add((await lippolisNumbers.allocate(lipScope('7777', 'v-cooper', 'COOPER'), NOW)).poNumber);
  check(seen.size === 25, 'twenty-five allocations produced twenty-five distinct numbers');

  // IDEMPOTENCY IS NOT THE ALLOCATOR'S. Asking twice here deliberately consumes
  // twice — a purchase order is not re-generated because `generatePurchaseOrder`
  // refuses a request that already has one, and the unique index on
  // (org_id, request_id) is what makes that refusal true. Recording the
  // division so nobody later "fixes" the allocator into caching.
  const highest = await lippolisNumbers.highestIssued({ orgId: 'org-lippolis', jobNumber: '1234', vendorId: 'v-cooper' });
  eq(highest, 0, 'highestIssued reads issued ORDERS, not the counter — nothing was written to purchase_orders here');
}

// ---------------------------------------------------------------------------
console.log('--- a missing rule fails, and is never filled in -----------------');

{
  // The two provisioning failures, both loud.
  let unset = null;
  try { poNumberStrategyFor(undefined, 'org-new'); } catch (err) { unset = err; }
  check(unset?.reason === 'po_numbering_unconfigured', 'an organization with no declared numbering rule is refused');
  check(unset && /org-new/.test(unset.message), 'and the refusal names the organization');

  // org-002's rule USED to be the unimplemented case, and its being
  // unimplemented was a source-code blocker on provisioning a second customer.
  // It is implemented now, so the refusal is proven with a rule nobody has
  // written — which is the case that actually needs guarding, permanently.
  eq(org002Profile.purchasing.po_numbering, 'vendor-sequence',
    'org-002 declares the per-vendor rule');
  check(IMPLEMENTED_IDS.includes(org002Profile.purchasing.po_numbering),
    'and this build can now perform it — a second organization no longer needs a source change to be numbered');

  let unknown = null;
  try { poNumberStrategyFor('quarterly-branch-sequence', 'org-003'); } catch (err) { unknown = err; }
  check(unknown?.reason === 'po_numbering_not_implemented',
    'a rule nobody has implemented is still refused, never approximated');
  check(unknown && IMPLEMENTED_IDS.every((id) => unknown.message.includes(id)),
    'and the refusal says what this build CAN perform');

  // The per-vendor rule, end to end: no job in the number, counter on the
  // vendor alone, and the organization's own separator.
  {
    const v = poNumberStrategyFor('vendor-sequence', 'org-002-trades',
      { separator: org002Profile.purchasing.po_separator });
    eq(v.format({ vendorCode: 'COOPER', sequence: 1 }), 'COOPER/1', 'org-002 numbers COOPER/1');
    eq(v.format({ jobNumber: '9999', vendorCode: 'COOPER', sequence: 2 }), 'COOPER/2',
      'and a job number changes nothing — this rule does not count per job');
    eq(v.sequenceScope({ jobNumber: '1234', vendorId: 'v-cooper' }), { vendorKey: 'v-cooper' },
      'its scope names the vendor and no job at all');
    // The counter KEY is what the database is keyed on, and it is sequenceKeyFor
    // that normalizes an absent job to the empty key. That is the contract the
    // allocator relies on, so it is the one worth asserting.
    eq(sequenceKeyFor(v, { orgId: 'org-002-trades', jobNumber: '1234', vendorId: 'v-cooper' }),
      { jobKey: '', vendorKey: 'v-cooper' },
      'and its counter key carries an empty job — one counter per vendor, across every job');
    eq(sequenceKeyFor(v, { orgId: 'org-002-trades', jobNumber: '9999', vendorId: 'v-cooper' }),
      sequenceKeyFor(v, { orgId: 'org-002-trades', jobNumber: '1234', vendorId: 'v-cooper' }),
      'two different jobs share one Cooper counter, which is the whole point of the rule');
  }

  // A separator this build will not print is refused rather than substituted.
  let sep = null;
  try { poNumberStrategyFor('vendor-sequence', 'org-004', { separator: ' ' }); } catch (err) { sep = err; }
  check(sep?.reason === 'po_separator_not_allowed',
    'a separator this build will not put in an identifier is refused, not swapped for a hyphen');

  // NO PLACEHOLDER, ANYWHERE. The failure modes above must not be reachable as
  // a number. A strategy that produces nothing usable is an error inside the
  // transaction, so the sequence value it consumed rolls back with it.
  let unwired = null;
  try { sqlitePoNumberAllocator(db, null); } catch (err) { unwired = err; }
  check(unwired?.reason === 'po_numbering_unconfigured',
    'an allocator cannot even be built without a strategy — the failure is at wiring, not at the first order');

  const EMPTY = definePoNumberStrategy({
    id: 'produces-nothing',
    sequenceScope: ({ vendorId }) => ({ vendorKey: vendorId }),
    format: () => '   ',
  });
  let blank = null;
  try { await sqlitePoNumberAllocator(db, EMPTY).allocate(synScope('J-9'), NOW); } catch (err) { blank = err; }
  check(blank?.reason === 'po_number_not_produced',
    'a strategy that produces a blank is refused rather than issuing one');

  for (const forbidden of ['TEMP-001', 'UNKNOWN', 'TBD']) {
    const rows = db.prepare('select count(*) as n from po_job_vendor_sequences where job_number = ?').get(forbidden);
    check(Number(rows.n) === 0, `nothing in this run invented a ${forbidden} counter`);
  }

  // And the strategy contract itself refuses a half-built rule.
  for (const [broken, why] of [
    [{ id: '', sequenceScope: () => ({}), format: () => 'x' }, 'without an id'],
    [{ id: 'x', format: () => 'x' }, 'without a sequence scope'],
    [{ id: 'x', sequenceScope: () => ({}) }, 'without a format'],
  ]) {
    let threw = null;
    try { definePoNumberStrategy(broken); } catch (err) { threw = err.message; }
    check(threw && /invalid PO numbering strategy/.test(threw), `a strategy ${why} is refused at construction`);
  }

  // A scope with no vendor is refused rather than silently keyed on nothing.
  let noVendor = null;
  try { sequenceKeyFor(SYNTHETIC, { orgId: 'org-synth', jobNumber: 'J', vendorId: '' }); } catch (err) { noVendor = err; }
  check(noVendor?.reason === 'po_sequence_scope_invalid', 'a counter cannot be keyed on an absent vendor');

  check(typeof requirePoNumberStrategy === 'function' && typeof poNumberFrom === 'function',
    'the seam exports exactly the two guards purchasing calls');
}

db.close();
rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(`organization provisioning checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);
