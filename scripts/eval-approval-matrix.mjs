// ---------------------------------------------------------------------------
// eval-approval-matrix.mjs — assertion harness behind Runner 4 (Task B3).
//
// PURE OFFLINE. No API keys, no model calls, no DB, no network, no Graph, no
// mailbox. Loads the labelled fixtures under fixtures/outbound/, runs the
// deterministic approval-matrix engine (scripts/lib/approval-matrix.mjs) and the
// draft generator (scripts/lib/outbound-draft.mjs), and asserts every label.
//
// Beyond the per-case labels it enforces the invariants that make this slice
// safe, as HARD gates:
//   * determinism   — same input twice, byte-identical output
//   * no-send       — no case can produce an approved or sent state, and no ok
//                     draft may claim send capability
//   * fixture-safety— every recipient on a produced draft is @example.invalid
//   * fail-closed   — every blocked reason in the vocabulary is exercised
//   * templates     — every template renders completely and cleanly
//   * source purity — the engine modules contain no network/send machinery
//   * seed parity   — every message type has a matrix row; no fixture policy
//                     ever puts final_invoice into auto mode
//
// Exit 0 iff all gates pass. Invoked by scripts/eval-approval-matrix.sh.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BLOCKED_REASONS, MESSAGE_TYPES, FIXTURE_EMAIL_DOMAIN } from './lib/approval-matrix.mjs';
import { prepareOutbound, buildDraft, scanForbiddenContent, TEMPLATE_IDS } from './lib/outbound-draft.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIR = join(ROOT, 'fixtures', 'outbound');
const CASES = join(DIR, 'cases');

const REQUIRED_KEYS = ['ok', 'status', 'blocked_reason', 'persist', 'draft', 'routing',
  'draft_key', 'events', 'audit'];

const policySets = JSON.parse(readFileSync(join(DIR, 'policies.json'), 'utf8'));
const labels = JSON.parse(readFileSync(join(DIR, 'labels.json'), 'utf8'));

let pass = 0, fail = 0;
const seenReasons = new Set();
const ok = () => { pass++; };
const bad = (m) => { console.log(`FAIL  ${m}`); fail++; };
const check = (cond, m) => (cond ? ok() : bad(m));
const sameList = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

const files = readdirSync(CASES).filter((f) => f.endsWith('.json')).sort();

for (const f of files) {
  const label = labels[f];
  if (!label) { bad(`${f} has no entry in labels.json`); continue; }

  let c;
  try { c = JSON.parse(readFileSync(join(CASES, f), 'utf8')); }
  catch (e) { bad(`${f} is not valid JSON: ${e.message}`); continue; }

  const policies = policySets[c.policy_set];
  if (!policies) { bad(`${f} references unknown policy_set '${c.policy_set}'`); continue; }

  const input = {
    action: c.action,
    policies,
    messageType: c.message_type,
    context: c.context,
    amountCents: c.amount_cents ?? null,
    unavailableRoles: c.unavailable_roles ?? [],
    workRequestKey: c.work_request_key,
    existingDraftKeys: c.existing_draft_keys ?? [],
    isFixture: c.is_fixture !== false,
    env: c.env ?? {},
  };

  const res = prepareOutbound(input);
  const res2 = prepareOutbound(input);

  // determinism — HARD
  check(JSON.stringify(res) === JSON.stringify(res2), `${f} non-deterministic output`);

  // contract shape — HARD
  check(REQUIRED_KEYS.every((k) => k in res), `${f} missing a required contract key`);

  // ---- universal safety invariants (apply to EVERY case) ----
  check(res.status === 'draft' || res.status === 'blocked',
    `${f} produced status '${res.status}' — only draft|blocked may exist in B3`);
  check(!res.draft || res.draft.status !== 'sent',
    `${f} produced a draft in 'sent' state — no send path may exist`);
  check(!res.draft || res.draft.status !== 'approved',
    `${f} produced a pre-approved draft — automation has zero approval authority`);
  check(!res.events.includes('message.approved') && !res.events.includes('message.sent'),
    `${f} emitted an approval/send event from a drafting run`);
  if (res.ok) {
    check(res.draft.requires_human_approval === true,
      `${f} ok draft does not require human approval`);
    check(res.draft.send_capability === false,
      `${f} ok draft claims send capability`);
    check((res.draft.to_addrs || []).every((a) => String(a).toLowerCase().endsWith(FIXTURE_EMAIL_DOMAIN)),
      `${f} ok draft addresses a non-fixture recipient: ${JSON.stringify(res.draft.to_addrs)}`);
    check(res.routing.effective_mode === 'draft',
      `${f} effective_mode is '${res.routing?.effective_mode}' — zero v1 auto-sends is locked`);
  }
  if (res.blocked_reason) {
    check(BLOCKED_REASONS.includes(res.blocked_reason),
      `${f} unknown blocked_reason '${res.blocked_reason}'`);
    seenReasons.add(res.blocked_reason);
  }
  check(Array.isArray(res.audit) && res.audit.length > 0, `${f} produced no audit trail`);

  // ---- label assertions ----
  check(res.ok === label.ok, `${f} ok: expected ${label.ok} got ${res.ok}`);
  check(res.status === label.status, `${f} status: expected ${label.status} got ${res.status}`);
  check(res.persist === label.persist, `${f} persist: expected ${label.persist} got ${res.persist}`);
  check(res.blocked_reason === (label.blocked_reason ?? null),
    `${f} blocked_reason: expected ${label.blocked_reason ?? null} got ${res.blocked_reason}`);
  check(res.draft_key === label.draft_key,
    `${f} draft_key: expected ${label.draft_key} got ${res.draft_key}`);
  check(sameList(res.events, label.events),
    `${f} events: expected ${JSON.stringify(label.events)} got ${JSON.stringify(res.events)}`);

  if ('approver_role' in label) {
    check(res.routing?.approver_role === label.approver_role,
      `${f} approver_role: expected ${label.approver_role} got ${res.routing?.approver_role}`);
  }
  if ('routing_path' in label) {
    check(res.routing?.routing_path === label.routing_path,
      `${f} routing_path: expected ${label.routing_path} got ${res.routing?.routing_path}`);
  }
  if ('escalated' in label) {
    check(res.routing?.escalated === label.escalated,
      `${f} escalated: expected ${label.escalated} got ${res.routing?.escalated}`);
  }
  if ('policy_mode' in label) {
    check(res.routing?.policy_mode === label.policy_mode,
      `${f} policy_mode: expected ${label.policy_mode} got ${res.routing?.policy_mode}`);
  }
  if ('effective_mode' in label) {
    check(res.routing?.effective_mode === label.effective_mode,
      `${f} effective_mode: expected ${label.effective_mode} got ${res.routing?.effective_mode}`);
  }
  if ('auto_downgraded' in label) {
    check(res.routing?.auto_downgraded === label.auto_downgraded,
      `${f} auto_downgraded: expected ${label.auto_downgraded} got ${res.routing?.auto_downgraded}`);
  }
}

console.log('--- Runner 4 gates ---');

// Fail-closed coverage: every blocked reason must be exercised by a fixture —
// an unexercised refusal is an unproven refusal. HARD.
const uncovered = BLOCKED_REASONS.filter((r) => !seenReasons.has(r));
check(uncovered.length === 0, `blocked-reason coverage: uncovered ${JSON.stringify(uncovered)}`);
console.log(`blocked-reason coverage ${seenReasons.size}/${BLOCKED_REASONS.length}`);

// Template coverage: every template renders completely, addresses a fixture
// recipient, and contains no forbidden content. HARD.
const CANON = {
  customer_name: 'Dana Fixture',
  customer_email: 'dana.fixture@example.invalid',
  crew_contact_name: 'Fixture Crew Lead',
  crew_contact_email: 'crew.lead@example.invalid',
  service_location: '12 Test Row, Fixtureville',
  scheduled_window: 'Tuesday 8:00-11:00 (fixture)',
  scope_summary: 'Synthetic scope (test data)',
  invoice_reference: 'FIX-INV-0000',
  missing_fields: ['The best phone number to reach you'],
};
for (const t of TEMPLATE_IDS) {
  const built = buildDraft({ messageType: t, context: CANON });
  check(built.ok, `template ${t} failed to render: ${built.error}`);
  if (built.ok) {
    check(built.draft.status === 'draft', `template ${t} produced status ${built.draft.status}`);
    check(built.draft.to_addrs.every((a) => a.endsWith(FIXTURE_EMAIL_DOMAIN)),
      `template ${t} addressed a non-fixture recipient`);
    check(scanForbiddenContent(built.draft.body_text).length === 0,
      `template ${t} body contains forbidden troubleshooting content`);
  }
}
console.log(`template coverage ${TEMPLATE_IDS.length}/${MESSAGE_TYPES.length}`);
check(MESSAGE_TYPES.every((t) => TEMPLATE_IDS.includes(t)),
  `every message type needs a template (missing: ${JSON.stringify(MESSAGE_TYPES.filter((t) => !TEMPLATE_IDS.includes(t)))})`);

// Source purity: the engine modules must contain no network or send machinery.
// This is the structural proof behind "no send capability exists". HARD.
for (const mod of ['lib/approval-matrix.mjs', 'lib/outbound-draft.mjs']) {
  const src = readFileSync(join(HERE, mod), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  check(!/\b(fetch\s*\(|https?:\/\/|require\s*\(|nodemailer|smtp|sendmail|graph\.microsoft)/i.test(code),
    `${mod} contains network/send machinery`);
  check(!/\bimport\s+.*\bfrom\s+['"](?!\.\/)/.test(code),
    `${mod} imports a non-local module`);
}

// Seed parity: the v1 fixture matrix covers every message type, and no fixture
// policy anywhere puts the final invoice into auto mode (REQUIREMENTS: never auto).
const seeded = new Set((policySets.seed_v1 || []).map((p) => p.message_type));
check(MESSAGE_TYPES.every((t) => seeded.has(t)),
  `seed_v1 missing rows for ${JSON.stringify(MESSAGE_TYPES.filter((t) => !seeded.has(t)))}`);
const invoiceAuto = Object.entries(policySets)
  .filter(([k]) => k !== '_readme')
  .flatMap(([set, rows]) => (Array.isArray(rows) ? rows : [])
    .filter((p) => p.message_type === 'final_invoice' && p.mode === 'auto')
    .map(() => set));
check(invoiceAuto.length === 0, `final_invoice in auto mode in policy set(s) ${JSON.stringify(invoiceAuto)}`);
// Every v1 seed row is draft mode — zero v1 auto-sends, seeded honestly.
check((policySets.seed_v1 || []).every((p) => p.mode === 'draft'),
  'seed_v1 contains a non-draft mode row (zero v1 auto-sends is locked)');

console.log(`eval-approval-matrix (Runner 4, offline, deterministic): passed=${pass} failed=${fail}  [${files.length} fixtures]`);
process.exit(fail === 0 ? 0 : 1);
