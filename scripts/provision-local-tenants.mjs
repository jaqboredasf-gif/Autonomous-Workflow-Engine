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

console.log('\nFIXTURE READY');
