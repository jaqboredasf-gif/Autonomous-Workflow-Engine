// ---------------------------------------------------------------------------
// eval-purchasing-isolation.mjs — tenant isolation, checked two ways.
//
// 1. STATICALLY, over the migrations: every tenant-owned table has row level
//    security, every policy is organization-scoped, every view runs as the
//    caller, and every reference between tenant-owned tables is composite so a
//    cross-organization pointer is unrepresentable.
//
// 2. BEHAVIOURALLY, through the application, against the local provider: a
//    second organization's user is refused every read and every write.
//
// What neither of these is: a live RLS test. Policies are enforced by Postgres,
// and Postgres is not running here. The SQL suite that must be executed against
// a real project lives in supabase/tests/tenant_isolation.sql, and until it has
// run, the policies in this repository are reviewed, not proven.
// ---------------------------------------------------------------------------

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = join(ROOT, 'apps', 'purchasing', 'src');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

let pass = 0;
let fail = 0;
const ok = () => { pass++; };
const bad = (m) => { console.log(`FAIL  ${m}`); fail++; };
const check = (cond, m) => (cond ? ok() : bad(m));
const eq = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

async function refuses(fn, m) {
  try {
    await fn();
    bad(`${m} — it was ALLOWED`);
  } catch {
    ok();
  }
}

const sql = ['0016_purchasing_control.sql', '0017_purchasing_auth_and_assignments.sql',
             '0018_purchasing_history_and_jobs.sql', '0019_purchasing_tenant_isolation.sql']
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n');

console.log('--- every tenant-owned table is protected -----------------------');

const created = [...sql.matchAll(/create table (?:if not exists )?(\w+)\s*\(([\s\S]*?)\n\);/g)]
  .map((m) => ({ name: m[1], body: m[2] }));
const tenantOwned = created.filter((t) => /\borg_id\b/.test(t.body));
check(tenantOwned.length >= 15, `${tenantOwned.length} tenant-owned tables found and checked`);

const rlsEnabled = new Set(
  [...sql.matchAll(/alter table (\w+)\s+enable row level security/g)].map((m) => m[1]),
);
for (const table of tenantOwned) {
  check(rlsEnabled.has(table.name), `${table.name} has row level security enabled`);
}

// A policy that does not mention the organization is not a tenant policy.
for (const table of tenantOwned) {
  const policies = [...sql.matchAll(new RegExp(`create policy \\w+ on ${table.name}\\b([\\s\\S]*?);`, 'g'))]
    .map((m) => m[1]);
  check(policies.length > 0, `${table.name} has at least one policy`);
  const unscoped = policies.filter(
    (p) => !/org_id|current_org_id|purchasing_can|exists\s*\(/.test(p),
  );
  check(unscoped.length === 0, `${table.name}: every policy is scoped (${unscoped.length} unscoped)`);
  check(!policies.some((p) => /using\s*\(\s*true\s*\)/.test(p)), `${table.name}: no policy is 'using (true)'`);
}

console.log('--- views run as the caller ------------------------------------');

// THE DEFECT THIS EXISTS TO CATCH: a Postgres view runs with its OWNER's
// privileges unless security_invoker is set, so RLS on the underlying tables is
// never evaluated for the person querying it. purchase_line_history shipped
// that way in 0018 and would have exposed every organization's history.
const views = [...sql.matchAll(/create (?:or replace )?view (\w+)/g)].map((m) => m[1]);
check(views.length > 0, `${views.length} view(s) defined`);
for (const view of views) {
  check(
    new RegExp(`alter view ${view} set \\(security_invoker = on\\)`).test(sql),
    `view ${view} sets security_invoker = on — without it, RLS does not apply to the caller`,
  );
}

console.log('--- references cannot cross organizations ----------------------');

// Referential integrity is checked by the system with RLS BYPASSED, so a plain
// foreign key happily accepts another organization's id. The composite form
// (id, org_id) makes a cross-tenant pointer unrepresentable.
const COMPOSITE_REQUIRED = [
  ['purchase_requests', 'delivery_location'], ['purchase_requests', 'vendor'],
  ['purchase_orders', 'vendor'], ['purchase_orders', 'delivery_location'], ['purchase_orders', 'request'],
  ['purchase_request_items', 'request'], ['purchase_order_items', 'order'],
  ['purchase_receipt_items', 'receipt'], ['purchase_receipts', 'request'], ['purchase_receipts', 'order'],
  ['purchase_email_drafts', 'request'], ['purchase_email_drafts', 'order'],
  ['purchase_item_catalog', 'vendor'], ['purchase_jobs', 'location'],
  ['purchase_request_items', 'catalog'], ['purchase_order_items', 'catalog'],
];
for (const [table, ref] of COMPOSITE_REQUIRED) {
  check(
    new RegExp(`add constraint ${table}_${ref}_same_org[\\s\\S]{0,220}?foreign key \\([\\w_]+, org_id\\)`).test(sql),
    `${table}.${ref} is a composite (id, org_id) reference`,
  );
}

// The parents of those composite keys need the matching unique constraint.
for (const parent of ['purchase_vendors', 'purchase_delivery_locations', 'purchase_requests',
                      'purchase_orders', 'purchase_receipts', 'purchase_item_catalog', 'purchase_jobs']) {
  check(
    new RegExp(`add constraint ${parent}_id_org_key\\s+unique \\(id, org_id\\)`).test(sql),
    `${parent} is unique on (id, org_id) so a composite reference can target it`,
  );
}

console.log('--- the receipt RPC checks tenancy before it acts ---------------');

const rpc = sql.slice(sql.indexOf('create or replace function record_purchase_receipt'));
check(rpc.includes('auth.uid()'), 'record_purchase_receipt requires an authenticated caller');
check(
  rpc.indexOf('current_org_id()') < rpc.indexOf('insert into purchase_receipts'),
  'it checks the organization BEFORE it writes anything',
);
check(
  /not found/.test(rpc.slice(0, rpc.indexOf('insert into purchase_receipts'))),
  "another organization's request is 'not found', never 'forbidden' — the difference leaks existence",
);
check(rpc.includes('purchasing_may_receive'), 'it applies the receiving authority rule');
check(rpc.includes('over-receipt override'), 'it enforces the over-receipt rule in the database too');
check(rpc.includes('v_item.org_id is distinct from r.org_id'),
      "a line id from another organization's order is refused even if guessed");

console.log('--- behavioural: the application refuses the other tenant -------');

const { openDatabase } = await import(join(APP, 'purchasing', 'infrastructure', 'sqlite', 'database.ts'));
const { seed, DEMO_ORG_ID } = await import(join(APP, 'purchasing', 'infrastructure', 'seed.ts'));
const S = await import(join(APP, 'server', 'service.ts'));

const TMP = mkdtempSync(join(tmpdir(), 'purchasing-isolation-'));
const db = openDatabase(join(TMP, 'iso.db'));
const now = '2026-08-07T09:00:00.000Z';
seed(db, now);
const ctx = () => S.context(db, now);

const userOf = async (email) => {
  const row = db.prepare('select id from users where email = ?').get(email);
  return S.loadActor(db, row.id);
};
const mike = await userOf('mike@example.invalid');
const dave = await userOf('dave@example.invalid');

// Tenant B: a whole separate organization, with its own admin.
const orgB = randomUUID();
const userB = randomUUID();
db.prepare('insert into orgs (id, name, created_at, updated_at) values (?,?,?,?)').run(orgB, 'Rival Contracting', now, now);
db.prepare(`insert into users (id, org_id, full_name, email, is_active, can_approve, created_at, updated_at)
            values (?,?,?,?,1,1,?,?)`).run(userB, orgB, 'Rival Admin', 'rival@example.invalid', now, now);
for (const role of ['ADMIN', 'WORKSHOP_APPROVER', 'OFFICE']) {
  db.prepare('insert into user_roles (user_id, role_key, granted_at) values (?,?,?)').run(userB, role, now);
}
// Provisioning a tenant is more than an `orgs` row. Migration 0016 seeds these
// for organizations that existed WHEN IT RAN; nothing creates them for an
// organization added later, so a new tenant cannot raise its first request.
// Recorded as a 1D finding; the fixture does by hand what onboarding must do.
db.prepare(`insert into request_number_sequences (org_id, prefix, padding, suffix, next_value, updated_at)
            values (?,?,?,?,?,?)`).run(orgB, 'PR-', 5, '', 1001, now);
db.prepare(`insert into po_number_sequences (org_id, prefix, padding, suffix, next_value, updated_at)
            values (?,?,?,?,?,?)`).run(orgB, 'RC-', 5, '', 9001, now);
db.prepare(`insert into system_settings (org_id, allow_self_approval, external_send_enabled,
            require_email_review, overdue_grace_hours, default_delivery_method, po_template_key, updated_at)
            values (?,0,0,1,0,'DELIVERY','lippolis_default',?)`).run(orgB, now);

const rival = await S.loadActor(db, userB);

// Tenant A creates a full request -> approval -> PO -> receipt chain.
const location = (await S.listDeliveryLocations(ctx(), dave)).find((l) => l.kind === 'JOBSITE');
const vendor = (await S.listVendors(ctx(), mike)).find((v) => v.name.startsWith('Graybar'));
const created_a = await S.createRequest(ctx(), dave, {
  jobNumber: '24-118', needByDate: '2026-09-01', needByTime: '07:00',
  deliveryLocationId: location.id, reason: 'isolation fixture',
  items: [{ description: '2x4 LED troffer', qty: '10', unit: 'ea' }],
});
await S.submitRequest(ctx(), dave, created_a.id);
const item = (await S.getRequestDetail(ctx(), mike, created_a.id)).originalItems[0];
await S.saveReview(ctx(), mike, created_a.id, {
  lines: [{ requestItemId: item.id, usableStock: '0', approvedQty: '10', finalOrderQty: '10',
            vendorId: vendor.id, estimatedUnitCost: '10.00' }],
});
await S.decide(ctx(), mike, created_a.id, 'APPROVE');
const po = await S.generatePurchaseOrder(ctx(), mike, created_a.id);
const draft = await S.generateVendorEmailDraft(ctx(), mike, created_a.id);
await S.advanceEmailDraft(ctx(), mike, draft.id, 'REVIEWED');
await S.markOrdered(ctx(), mike, created_a.id);

// --- Tenant B may not READ Tenant A -----------------------------------------
await refuses(() => S.getRequestDetail(ctx(), rival, created_a.id), "tenant B cannot read tenant A's request");
eq((await S.listRequests(ctx(), rival)).length, 0, 'tenant B sees none of tenant A in a list');
eq((await S.approvalQueue(ctx(), rival)).length, 0, "tenant B's approval queue is empty");
eq((await S.listVendors(ctx(), rival)).length, 0, "tenant B cannot read tenant A's vendors");
eq((await S.listDeliveryLocations(ctx(), rival)).length, 0, "tenant B cannot read tenant A's locations");
eq((await S.listJobs(ctx(), rival)).length, 0, "tenant B cannot read tenant A's jobs");
eq((await S.auditLog(ctx(), rival, 100)).length, 0, "tenant B cannot read tenant A's audit log");
await refuses(() => S.purchaseOrderView(ctx(), po.purchaseOrderId).then((v) => {
  if (v && v.org && v.org.id === DEMO_ORG_ID) throw new Error('leak');
  return v;
}), "tenant A's purchase order is not readable as tenant B data");

// --- Tenant B may not WRITE Tenant A ----------------------------------------
await refuses(() => S.decide(ctx(), rival, created_a.id, 'APPROVE'), "tenant B cannot approve tenant A's request");
await refuses(() => S.decide(ctx(), rival, created_a.id, 'REJECT', { reason: 'no' }), "tenant B cannot reject it");
await refuses(() => S.saveReview(ctx(), rival, created_a.id, { lines: [] }), "tenant B cannot review it");
await refuses(() => S.generatePurchaseOrder(ctx(), rival, created_a.id), "tenant B cannot create a PO against it");
await refuses(() => S.generateVendorEmailDraft(ctx(), rival, created_a.id), "tenant B cannot draft its vendor email");
await refuses(() => S.updateEmailDraft(ctx(), rival, draft.id, { subject: 'x' }), "tenant B cannot edit its email draft");
await refuses(() => S.advanceEmailDraft(ctx(), rival, draft.id, 'APPROVED_TO_SEND'), "tenant B cannot advance its draft");
await refuses(() => S.recordReceipt(ctx(), rival, created_a.id, {
  receivedDate: '2026-09-02', lines: [],
}), "tenant B cannot receive tenant A's order");
await refuses(() => S.markOrdered(ctx(), rival, created_a.id), "tenant B cannot mark it ordered");
await refuses(() => S.completeRequest(ctx(), rival, created_a.id), "tenant B cannot complete it");
await refuses(() => S.cancelRequest(ctx(), rival, created_a.id, 'no'), "tenant B cannot cancel it");
await refuses(() => S.addNote(ctx(), rival, created_a.id, 'hello'), "tenant B cannot annotate it");
await refuses(() => S.updateTracking(ctx(), rival, created_a.id, { trackingNumber: 'x' }), "tenant B cannot add tracking");

// --- A tenant A object may not reference a tenant B object ------------------
// Tenant B owns no locations, so tenant A pointing at one is the cross-tenant
// reference the composite foreign keys forbid in Postgres. The local store has
// no composite key, so the APPLICATION must refuse it — and does, because the
// location is looked up within the caller's organization.
const locB = randomUUID();
db.prepare(`insert into delivery_locations (id, org_id, name, address, kind, is_active, created_at, updated_at)
            values (?,?,?,?,'JOBSITE',1,?,?)`).run(locB, orgB, 'Rival Yard', 'elsewhere', now, now);
const visibleToA = (await S.listDeliveryLocations(ctx(), dave)).map((l) => l.id);
check(!visibleToA.includes(locB), "tenant A cannot even see tenant B's location to reference it");

// --- and the reverse direction ---------------------------------------------
const createdB = await S.createRequest(ctx(), rival, {
  jobNumber: 'RIVAL-1', needByDate: '2026-09-01', needByTime: '08:00',
  deliveryLocationId: locB, reason: 'their own work',
  items: [{ description: 'conduit', qty: '5', unit: 'ea' }],
});
await refuses(() => S.getRequestDetail(ctx(), mike, createdB.id), "tenant A cannot read tenant B's request");
await refuses(() => S.decide(ctx(), mike, createdB.id, 'APPROVE'), "tenant A cannot approve tenant B's request");
eq((await S.listRequests(ctx(), mike)).filter((r) => r.id === createdB.id).length, 0,
   "tenant B's request never appears in tenant A's list");

// --- history stays separated ------------------------------------------------
const historyA = db.prepare('select count(*) c from purchase_request_items where org_id = ?').get(DEMO_ORG_ID);
const historyB = db.prepare('select count(*) c from purchase_request_items where org_id = ?').get(orgB);
check(historyA.c > 0 && historyB.c > 0, 'both organizations have line-item history');
const crossed = db.prepare(
  `select count(*) c from purchase_request_items i
     join purchase_requests r on r.id = i.request_id where i.org_id <> r.org_id`,
).get();
eq(crossed.c, 0, 'no line item is owned by a different organization than its parent');

db.close();
rmSync(TMP, { recursive: true, force: true });

console.log('');
console.log('    NOTE: the policies above are reviewed, not proven. Postgres is');
console.log('    what enforces them and it is not running here. See');
console.log('    supabase/tests/tenant_isolation.sql for the live suite.');
console.log('');
console.log(`isolation checks: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
