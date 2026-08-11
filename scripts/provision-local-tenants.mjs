// ---------------------------------------------------------------------------
// provision-local-tenants.mjs — create two real tenants, with real Supabase Auth
// users, against the LOCAL stack, so the website can be exercised the way a
// customer would exercise it.
//
// This is a fixture builder, not a product feature. It uses the service role
// key deliberately and only here: creating an account for someone who has none
// is exactly the administrative act that key exists for. Nothing it writes is
// read back through a privileged client — the acceptance run signs in normally.
//
// Refuses to run against anything but 127.0.0.1, because a fixture script that
// can reach production is a loaded gun.
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL)) {
  console.error(`REFUSED: ${URL} is not the local stack.`);
  process.exit(1);
}
// Belt as well as braces. The URL check above already makes a production run
// impossible, and this makes the INTENT impossible to misread: this script
// creates accounts with known passwords, and it exists for a developer's
// laptop only.
if (process.env.NODE_ENV === 'production') {
  console.error('REFUSED: fixture provisioning is a development tool and will not run with NODE_ENV=production.');
  process.exit(1);
}
if (!SERVICE) {
  console.error('REFUSED: SUPABASE_SERVICE_ROLE_KEY is not set.');
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const TENANTS = [
  { org: 'Lippolis Electric', email: 'admin@lippolis.test', name: 'Lippolis Admin', prefix: 'LE-' },
  { org: 'Northgate Mechanical', email: 'admin@northgate.test', name: 'Northgate Admin', prefix: 'NG-' },
];
const PASSWORD = 'pilot-password-9137';

async function authUser(email) {
  // Idempotent: reuse the account if the fixture has been built before, so
  // reruns do not accumulate half-provisioned tenants.
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (found) {
    await admin.auth.admin.updateUserById(found.id, { password: PASSWORD });
    return found.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error) throw new Error(`could not create ${email}: ${error.message}`);
  return data.user.id;
}

const out = [];
for (const t of TENANTS) {
  const authId = await authUser(t.email);

  const existing = await admin
    .from('purchasing_org_memberships')
    .select('org_id')
    .eq('user_id', authId)
    .maybeSingle();

  let orgId = existing.data?.org_id ?? null;
  if (!orgId) {
    const { data, error } = await admin.rpc('provision_organization', {
      p_name: t.org,
      p_admin_auth_id: authId,
      p_admin_email: t.email,
      p_admin_name: t.name,
      p_po_prefix: t.prefix,
      p_po_start: 1001,
    });
    if (error) throw new Error(`could not provision ${t.org}: ${error.message}`);
    orgId = Array.isArray(data) ? data[0].out_org_id : data.out_org_id;
  }

  out.push({ org: t.org, orgId, email: t.email, authId, password: PASSWORD });
  console.log(`${t.org}\n  org_id  ${orgId}\n  user    ${t.email} / ${PASSWORD}\n  auth_id ${authId}`);
}

// A distinguishable record per tenant, so a cross-tenant read is visible on
// sight rather than needing a join to interpret.
for (const t of out) {
  const marker = t.org === 'Lippolis Electric' ? 'LIPPOLIS-ONLY-VENDOR' : 'NORTHGATE-ONLY-VENDOR';
  const { data: has } = await admin
    .from('purchase_vendors').select('id').eq('org_id', t.orgId).eq('name', marker).maybeSingle();
  if (!has) {
    const { error } = await admin.from('purchase_vendors').insert({
      org_id: t.orgId, name: marker, is_active: true,
    });
    if (error) throw new Error(`could not seed a marker vendor for ${t.org}: ${error.message}`);
  }
  console.log(`  marker  ${marker}`);
}

// ---------------------------------------------------------------------------
// ROLE-SEPARATED PEOPLE for the Lippolis tenant.
//
// The point of the end-to-end scenarios is that purchasing authority and
// receiving authority are held by DIFFERENT people, so the fixture has to
// contain different people. None of them is named after a real employee: they
// are the roles an administrator assigns, which is exactly how the product is
// meant to be configured.
// ---------------------------------------------------------------------------

const lippolis = out.find((t) => t.org === 'Lippolis Electric');

const PEOPLE = [
  { email: 'purchasing@lippolis.test', name: 'Purchasing Manager', roles: ['WORKSHOP_APPROVER'], canApprove: true, jobs: [] },
  // The pilot purchaser's own account, so the pilot is driven by a real named
  // person rather than by a shared fixture login and the audit trail says who
  // actually did each thing. PURCHASING_MANAGER preset exactly — the workshop
  // role plus approval authority, and nothing wider. No job assignment: a
  // shop-counter role is unscoped for receiving already, so assigning one
  // would grant nothing and imply a limit that is not there.
  { email: 'mike@lippolis.test', name: 'Mike (Purchasing)', roles: ['WORKSHOP_APPROVER'], canApprove: true, jobs: [] },
  { email: 'foreman@lippolis.test',    name: 'Site Foreman',       roles: ['FOREMAN'],           canApprove: false, jobs: ['24-118'] },
  { email: 'requester@lippolis.test',  name: 'Shop Requester',     roles: ['REQUESTOR'],         canApprove: false, jobs: [] },
  { email: 'accounting@lippolis.test', name: 'Accounting Clerk',   roles: ['ACCOUNTING'],        canApprove: false, jobs: [] },
  // ---------------------------------------------------------------------
  // THE LOCAL INSPECTION ACCOUNT.
  //
  // One person holding every role, so a developer can walk all ten screens
  // without juggling five sign-ins. It is an ordinary user in every respect:
  // it signs in with a password like anybody else, RLS applies to it like
  // anybody else, and it is scoped to the Lippolis tenant like anybody else.
  // There is NO bypass anywhere in the application for this address.
  //
  // It exists only where this script can run — the local Supabase stack on
  // 127.0.0.1 — so it cannot appear in a deployed environment. Its authority
  // comes from ADMIN, which is a real role an administrator can assign, not
  // from a special case in the code.
  //
  // It is assigned to job 24-118 so the assignment-scoped screens (deliveries,
  // receiving) have something in them: ADMIN is not field-scoped and would see
  // them anyway, but a screen you inspect with no rows teaches you nothing.
  {
    email: 'dev@lippolis.test',
    name: 'Local Dev Inspector',
    roles: ['ADMIN', 'WORKSHOP_APPROVER', 'OFFICE', 'FOREMAN', 'REQUESTOR', 'ACCOUNTING'],
    canApprove: true,
    jobs: ['24-118'],
  },
];

for (const person of PEOPLE) {
  const authId = await authUser(person.email);

  const { data: existingUser } = await admin.from('users').select('id').eq('id', authId).maybeSingle();
  if (!existingUser) {
    const { error } = await admin.from('users').insert({
      id: authId, org_id: lippolis.orgId, email: person.email, full_name: person.name,
      is_active: true, purchasing_can_approve: person.canApprove,
    });
    if (error) throw new Error(`could not create ${person.email}: ${error.message}`);
  } else {
    await admin.from('users').update({ purchasing_can_approve: person.canApprove }).eq('id', authId);
  }

  const { data: membership } = await admin.from('purchasing_org_memberships')
    .select('id').eq('user_id', authId).eq('org_id', lippolis.orgId).maybeSingle();
  if (!membership) {
    const { error } = await admin.from('purchasing_org_memberships').insert({
      org_id: lippolis.orgId, user_id: authId, status: 'ACTIVE', is_primary: true,
    });
    if (error) throw new Error(`could not add ${person.email} to the organization: ${error.message}`);
  }

  for (const role of person.roles) {
    const { data: held } = await admin.from('purchasing_user_roles')
      .select('user_id').eq('user_id', authId).eq('role', role).maybeSingle();
    if (!held) {
      const { error } = await admin.from('purchasing_user_roles').insert({ user_id: authId, role });
      if (error) throw new Error(`could not grant ${role} to ${person.email}: ${error.message}`);
    }
  }

  for (const job of person.jobs) {
    const { data: assigned } = await admin.from('purchasing_job_assignments')
      .select('user_id').eq('user_id', authId).eq('job_number', job).maybeSingle();
    if (!assigned) {
      const { error } = await admin.from('purchasing_job_assignments')
        // No org_id column: a job assignment is tenanted through its user.
        .insert({ user_id: authId, job_number: job });
      if (error) throw new Error(`could not assign ${person.email} to job ${job}: ${error.message}`);
    }
  }

  console.log(`  ${person.email.padEnd(28)} ${person.roles.join(',')}${person.canApprove ? ' +approve' : ''}${person.jobs.length ? ` jobs:${person.jobs.join(',')}` : ''}`);
}

// A job and a delivery location for the scenarios to use.
for (const [jobNumber, name] of [['24-118', 'Harrison Gym'], ['25-007', 'Riverside Plant']]) {
  const { data: job } = await admin.from('purchase_jobs')
    .select('id').eq('org_id', lippolis.orgId).eq('job_number', jobNumber).maybeSingle();
  if (!job) {
    const { error } = await admin.from('purchase_jobs').insert({
      org_id: lippolis.orgId, job_number: jobNumber, name, status: 'ACTIVE',
      site_address: `${name} site address`,
    });
    if (error) throw new Error(`could not create job ${jobNumber}: ${error.message}`);
  }
  console.log(`  job ${jobNumber} — ${name}`);
}

// Delivery destinations. The WORKSHOP one is not decoration: `purchase_location_kind`
// has carried WORKSHOP since migration 0016 and migration 0034 scopes receiving
// authority by the destination's KIND, but no organization had a workshop row —
// so "deliver it to the shop" was not selectable on the request form and the
// whole workshop path was unreachable through the UI.
const LOCATIONS = [
  { name: 'Harrison Gym site', kind: 'JOBSITE', address: 'Harrison Gym site address' },
  { name: 'Lippolis workshop', kind: 'WORKSHOP', address: 'The shop counter' },
];

for (const location of LOCATIONS) {
  const { data: loc } = await admin.from('purchase_delivery_locations')
    .select('id').eq('org_id', lippolis.orgId).eq('name', location.name).maybeSingle();
  if (!loc) {
    const { error } = await admin.from('purchase_delivery_locations').insert({
      org_id: lippolis.orgId, ...location, is_active: true,
    });
    if (error) throw new Error(`could not create delivery location ${location.name}: ${error.message}`);
  }
  console.log(`  delivery location ${location.name} (${location.kind})`);
}

console.log('\nFIXTURE READY');
