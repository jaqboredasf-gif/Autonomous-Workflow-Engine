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

assert.match(
  c2,
  /revoke execute on all functions in schema public from public, anon, authenticated/i
);
for (const privileged of [
  'create_outbound_draft',
  'route_outbound',
  'emit_event',
  'capture_correction_original',
]) {
  assert.doesNotMatch(
    c2,
    new RegExp(`grant execute on function public\\.${privileged}[^;]+to authenticated`, 'is')
  );
}
assert.match(c2, /grant execute on all functions in schema public to service_role/i);

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
