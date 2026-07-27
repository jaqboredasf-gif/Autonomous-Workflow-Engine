import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const readMigration = (name) =>
  readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');
const c1 = readMigration('20260727142118_phase1_c1_remove_undeclared_policies.sql');
const c2 = readMigration('20260727142120_phase1_c2_restrict_privileged_rpcs.sql');
const c3 = readMigration('20260727142121_phase1_c3_bind_time_and_crew_authorization.sql');
const c4 = readMigration('20260727142123_phase1_c4_mcp_tenant_contract.sql');

for (const table of [
  'integration_events',
  'time_entry_audits',
  'crews',
  'crew_members',
]) {
  for (const operation of ['select', 'insert', 'update', 'delete']) {
    assert.match(c1, new RegExp(`drop policy if exists ${table}_org_${operation}`));
  }
}
assert.match(c1, /c\.relrowsecurity/);
assert.doesNotMatch(c1, /\b(insert|update|delete)\s+from\b/i);

const authenticated = new Set([
  'public.current_org_id()',
  'public.current_role_is(user_role)',
  'public.business_role_matches(uuid, business_role)',
  'public.record_approval(uuid, text, text)',
]);
const anon = new Set([
  'public.current_org_id()',
  'public.current_role_is(user_role)',
]);
const exactAllowed = (role, identity) =>
  (role === 'authenticated' ? authenticated : anon).has(identity);

assert.equal(exactAllowed('authenticated', 'public.business_role_matches(uuid, business_role)'), true);
assert.equal(exactAllowed('authenticated', 'public.record_approval(uuid, text, text)'), true);
assert.equal(exactAllowed('authenticated', 'public.apply_timecard_correction(uuid)'), false);
assert.equal(exactAllowed('authenticated', 'public.mark_message_sent(uuid)'), false);
assert.equal(exactAllowed('authenticated', 'public.record_approval(uuid, text)'), false);
assert.equal(exactAllowed('authenticated', 'public.record_approval(uuid, text, text, text)'), false);
assert.equal(exactAllowed('anon', 'public.business_role_matches(uuid, business_role)'), false);

assert.match(c2, /pg_get_function_identity_arguments\(p\.oid\)/);
assert.match(c2, /has_function_privilege\('authenticated', fn\.oid, 'EXECUTE'\)/);
assert.match(c2, /has_function_privilege\('anon', fn\.oid, 'EXECUTE'\)/);
assert.match(c2, /p\.prorettype = 'trigger'::regtype/);
assert.match(c2, /alter function public\.set_geo_flags\(\)[\s\S]+security definer[\s\S]+set search_path = pg_catalog, public/i);
assert.match(c2, /has_schema_privilege\('authenticated', 'public', 'CREATE'\)/);
assert.match(c2, /p\.proowner <> \(select oid from pg_roles where rolname = current_user\)/);
assert.match(c2, /alter default privileges in schema public[\s\S]+service_role/i);
assert.doesNotMatch(c2, /grant execute on all functions/i);
assert.doesNotMatch(
  c2,
  /grant execute on function public\.(?:apply_timecard_correction|mark_message_sent)\([^;]+to authenticated/is
);
for (const identity of authenticated) {
  assert.ok(c2.includes(`'${identity}'`), `missing exact authenticated identity: ${identity}`);
}

for (const predicate of [
  'org_id = (select public.current_org_id())',
  "current_role_is('foreman')",
  'c.foreman_id = (select auth.uid())',
  'c.org_id = time_entries.org_id',
]) {
  assert.ok(c3.includes(predicate), `missing C3 predicate: ${predicate}`);
}
assert.match(c3, /for update to authenticated[\s\S]+using \([\s\S]+with check \(/i);
assert.match(c3, /validate_time_entry_tenant/);
assert.match(c3, /validate_crew_member_tenant/);

assert.match(c4, /assert_mcp_tenant\(p_org_id uuid\)/);
assert.match(c4, /revoke execute[\s\S]+from public, anon, authenticated/i);
assert.match(c4, /grant execute[\s\S]+to service_role/i);

console.log('PASS: Phase 1 migration structure pins C1-C4 security boundaries');
