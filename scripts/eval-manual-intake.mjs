// Runner 7 — DETERMINISTIC manual-intake eval (0016 bridge).
//
// PURE OFFLINE: no keys, no model, no database, no network. Imports the module
// the page actually ships (apps/web/src/lib/manual-intake.ts) and asserts the
// properties that keep a temporary bridge from becoming a hole in the system.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planManualIntake, verifyIntakeApplied, URGENCIES } from '../apps/web/src/lib/manual-intake.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
const check = (c, m) => (c ? pass++ : fails.push(m));

const NOW = '2026-09-02T16:00:00.000Z';
const base = {
  bodyText: 'Kitchen outlet stopped working, needs someone this week.',
  sourceReference: 'Phone call from 914-555-0134',
  receivedAt: '2026-09-02T15:30:00.000Z',
};
const plan = (over = {}, opts = {}) =>
  planManualIntake({ input: { ...base, ...over }, now: NOW, isAuthorized: true, ...opts });

const reasons = (p) => p.errors.map((e) => e.reason);

// --- happy path -------------------------------------------------------------
const ok = plan();
check(ok.ok === true, `a valid request was refused: ${JSON.stringify(ok.errors)}`);
check(ok.rpc?.p_body_text === base.bodyText, 'body text not carried into the RPC payload');
check(ok.rpc?.p_source_reference === base.sourceReference, 'source reference not carried');
check(Object.keys(ok.rpc ?? {}).length === 11,
  `RPC payload carries fields create_manual_work_request() does not accept: ${Object.keys(ok.rpc ?? {})}`);

// --- determinism ------------------------------------------------------------
check(JSON.stringify(plan()) === JSON.stringify(plan()), 'planManualIntake is non-deterministic');

// --- authorization ----------------------------------------------------------
const unauth = planManualIntake({ input: base, now: NOW, isAuthorized: false });
check(unauth.ok === false && reasons(unauth).includes('not_authorized'),
  'an unauthorized user could build an intake payload');
check(unauth.rpc === null, 'a refused intake still produced an RPC payload');

// --- the two genuinely required facts --------------------------------------
for (const [field, reason] of [['bodyText', 'missing_body_text'], ['sourceReference', 'missing_source_reference']]) {
  for (const empty of ['', '   ', '\n\t']) {
    const p = plan({ [field]: empty });
    check(p.ok === false && reasons(p).includes(reason), `${field}="${empty}" was accepted`);
    check(p.rpc === null, `${field}="${empty}" still produced an RPC payload`);
  }
}

// --- everything else is optional: an operator must never invent data --------
const sparse = plan({
  customerName: '', customerEmail: '', customerPhone: '',
  customerAddress: '', county: '', zip: '',
});
check(sparse.ok === true, 'a request with only the required facts was refused');
for (const k of ['p_customer_name', 'p_customer_email', 'p_customer_phone',
  'p_customer_address', 'p_county', 'p_zip']) {
  check(sparse.rpc?.[k] === null, `${k} became "" instead of null — empty strings pollute the record`);
}
check(plan({ customerName: '  Maria Lopez  ' }).rpc?.p_customer_name === 'Maria Lopez',
  'whitespace is not trimmed off optional fields');

// --- received_at ------------------------------------------------------------
const future = plan({ receivedAt: '2026-09-03T16:00:00.000Z' });
check(future.ok === false && reasons(future).includes('received_at_in_future'),
  'a request could be recorded as arriving in the future');
check(plan({ receivedAt: 'not a date' }).ok === false, 'an unparseable received_at was accepted');
check(plan({ receivedAt: null }).ok === true, 'a blank received_at should default to now, not fail');
check(plan({ receivedAt: null }).rpc?.p_received_at === new Date(NOW).toISOString(),
  'a blank received_at did not default to now');
// A minute of clock skew between browser and server must not block real entry.
check(plan({ receivedAt: '2026-09-02T16:00:30.000Z' }).ok === true,
  '30s of clock skew was treated as a future request');

// --- customer email is a REPLY ADDRESS downstream ---------------------------
// approval-queue.ts falls back to from_addr as a recipient, so junk here could
// later address a reply to nonsense.
for (const bad of ['not-an-email', 'a@b', '914-555-0134', 'foo@bar', '@example.com']) {
  const p = plan({ customerEmail: bad });
  check(p.ok === false && reasons(p).includes('invalid_customer_email'),
    `"${bad}" was accepted as a customer email and could become a reply address`);
}
check(plan({ customerEmail: 'maria@example.com' }).ok === true, 'a valid email was refused');

// --- idempotency key is carried so a double-click cannot duplicate ---------
check(plan({ clientKey: 'abc-123' }).rpc?.p_client_key === 'abc-123',
  'the idempotency key is not carried into the RPC payload');
check(plan({ clientKey: null }).rpc?.p_client_key === null, 'a missing client key is not null');

// --- verification posture: success is what the re-read says ----------------
check(verifyIntakeApplied({ workRequestId: 'wr-1', found: true }).settled === true,
  'a created request that read back was not reported as settled');
const unread = verifyIntakeApplied({ workRequestId: 'wr-1', found: false });
check(unread.settled === false, 'a request that could not be read back was reported as success');
check(/before re-entering it/.test(unread.message),
  'an unconfirmed creation does not warn against re-entering it (duplicate risk)');
check(verifyIntakeApplied({ workRequestId: null, found: false }).settled === false,
  'a missing work request id was reported as success');

// --- urgency: recorded, but explicitly not an alert -------------------------
check(plan().rpc?.p_urgency === 'standard', 'urgency does not default to standard');
for (const u of URGENCIES) {
  check(plan({ urgency: u }).rpc?.p_urgency === u, `urgency "${u}" was not carried`);
}
const badU = plan({ urgency: 'catastrophic' });
check(badU.ok === false && reasons(badU).includes('invalid_urgency'),
  'an urgency outside the enum was accepted and would fail at the database');

// --- the migration's schema invariants (asserted against the SQL text) ------
// Behavior needs a database; these assert the CONTRACT the client is written
// against, so client and schema cannot drift apart silently.
const MIG = readFileSync(join(ROOT, 'supabase/migrations/0016_manual_intake_bridge.sql'), 'utf8');
const migFlat = MIG.replace(/\s+/g, ' ');
const migCode = MIG.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

// (2) a real manual request creates no fake email data
check(!/graph_message_id|from_addr|is_fixture/.test(migCode),
  'the migration touches email-only fields — manual intake must fabricate none of them');
check(!/insert into email_messages/i.test(migCode),
  'the migration inserts an email row for a manual request');
// (3) email work requests continue working unchanged
check(!/alter table email_messages/.test(migCode),
  'email_messages is altered — existing email intake invariants must remain untouched');
check(/source_type request_source not null default 'email'/.test(migFlat),
  'existing rows would not remain valid: source_type must default to email');
// (4) email source requires a legitimate email_message
check(/when 'email' then[^]*?email_message_id is not null/.test(migFlat),
  'an email request could exist without an email_message');
// (5) manual source cannot claim email provenance
check(/when 'manual' then[^]*?email_message_id is null/.test(migFlat),
  'a manual request could carry an email_message_id and claim email provenance');
// (6)(7)(8) authorization, tenant, authentication — enforced in the RPC
check(/current_role_is\('admin'\)/.test(migFlat), 'the RPC does not gate on business role');
check(/v_org uuid := current_org_id\(\)/.test(migFlat) && !/p_org\b/.test(migFlat),
  'tenant is not derived from the session — cross-org creation would be possible');
check(/requires an authenticated human/.test(migFlat), 'the RPC does not require authentication');
// (9) audit event
check(/emit_event\('request\.manual_intake'/.test(migFlat), 'no audit event is emitted for the intake act');
// (11) fixture and production semantics stay separated
check(!/is_fixture/.test(migCode), 'the migration references fixture semantics');

// The request text must be readable by the product, not only by service-role.
check(/add column request_text/.test(migFlat),
  'request_text is not stored on the row — the product could never show what the customer asked for');

// --- source purity ----------------------------------------------------------
const UI = {
  'apps/web/src/lib/manual-intake.ts': readFileSync(join(ROOT, 'apps/web/src/lib/manual-intake.ts'), 'utf8'),
  'apps/web/src/app/requests/new/page.tsx': readFileSync(join(ROOT, 'apps/web/src/app/requests/new/page.tsx'), 'utf8'),
};
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

for (const [name, src] of Object.entries(UI)) {
  const c = stripComments(src);
  // The bridge must never be able to forge an email or a fixture.
  check(!/graph_message_id/.test(c), `${name} references graph_message_id — the bridge could masquerade as email`);
  check(!/is_fixture/.test(c), `${name} sets is_fixture — real customer data must never be labelled synthetic`);
  check(!/service_role|SERVICE_ROLE|sb_secret_|SUPABASE_ACCESS_TOKEN/.test(c), `${name} holds a privileged credential`);
  check(!/eyJ[A-Za-z0-9_-]{10,}/.test(c), `${name} contains a hard-coded JWT`);
  // Tenant must come from the session, never the form.
  check(!/p_org\b|org_id\s*:/.test(c), `${name} supplies an org — tenant must come from current_org_id()`);
  check(!/source_type\s*:/.test(c), `${name} chooses its own source_type — the RPC must decide that`);
  // A bridge that sends is not a bridge.
  check(!/mark_message_sent|create_outbound_draft|record_approval/.test(c),
    `${name} touches the approval or send path`);
  check(!/graph\.microsoft\.com|smtp|nodemailer|sendMail/i.test(c), `${name} contains mail transport machinery`);
  // No direct writes: the RPC is the only door.
  check(!/\.from\(\s*['"](email_messages|work_requests)['"]\s*\)\s*\.(insert|update|upsert|delete)/.test(c),
    `${name} writes directly to an intake table instead of going through the RPC`);
}

const page = stripComments(UI['apps/web/src/app/requests/new/page.tsx']);
const rpcCalls = [...page.matchAll(/\.rpc\(\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);
for (const r of rpcCalls) {
  check(['create_manual_work_request', 'current_role_is'].includes(r),
    `the intake page calls an unexpected RPC '${r}'`);
}
check(rpcCalls.includes('create_manual_work_request'), 'the intake page never calls the intake RPC');
check(/crypto\.randomUUID\(\)/.test(page), 'the page does not generate an idempotency key');

// --- the bridge must not be documented or presented as the normal path -----
check(/temporary bridge/i.test(UI['apps/web/src/app/requests/new/page.tsx']),
  'the page does not tell the operator this is a temporary bridge');

if (fails.length) {
  console.error(`\n${fails.length} FAILURE(S):`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  console.error(`\n${pass} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log(`${pass} checks passed`);
