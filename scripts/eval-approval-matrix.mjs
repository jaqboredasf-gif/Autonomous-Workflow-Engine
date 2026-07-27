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
//   * corpus parity — every fixture is labelled and every label has a fixture
//   * determinism   — same input twice, byte-identical output
//   * no-send       — no case can produce an approved or sent state, and no ok
//                     draft may claim send capability
//   * fixture-safety— every recipient on a produced draft is @example.invalid
//   * fail-closed   — every blocked reason in the vocabulary is exercised, and
//                     every reason the engine emits is registered in the
//                     platform union (scripts/lib/awe-reasons.mjs)
//   * templates     — every template renders completely and cleanly
//   * source purity — the engine modules contain no network/send machinery
//   * seed parity   — every message type has a matrix row; no fixture policy
//                     ever puts final_invoice into auto mode
//
// Built on @exattime/awe-kernel: corpus loading, the gate run and the
// determinism/coverage/purity gates are shared with every other runner, so this
// file contains only what is specific to B3.
//
// Exit 0 iff all gates pass. Invoked by scripts/eval-approval-matrix.sh.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGateRun, loadCorpus } from '../packages/awe-kernel/src/index.mjs';
import { BLOCKED_REASONS, MESSAGE_TYPES, FIXTURE_EMAIL_DOMAIN } from './lib/approval-matrix.mjs';
import { prepareOutbound, buildDraft, scanForbiddenContent, TEMPLATE_IDS } from './lib/outbound-draft.mjs';
import { reasons as platformReasons } from './lib/awe-reasons.mjs';
import { persistSuiteReport } from './lib/runner-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIR = join(ROOT, 'fixtures', 'outbound');

const REQUIRED_KEYS = ['ok', 'status', 'blocked_reason', 'persist', 'draft', 'routing',
  'draft_key', 'events', 'audit'];

const policySets = JSON.parse(readFileSync(join(DIR, 'policies.json'), 'utf8'));

const run = createGateRun({ name: 'eval-approval-matrix (Runner 4, offline, deterministic)' });
const corpus = loadCorpus({
  dir: DIR,
  casesDir: join(DIR, 'cases'),
  name: 'fixtures/outbound',
});

run.corpusParity(corpus);

for (const { name: f, data: c, label } of corpus.cases) {
  if (label === null) continue; // already reported by the parity gate

  const policies = policySets[c.policy_set];
  if (!policies) {
    run.check(false, `${f} references unknown policy_set '${c.policy_set}'`);
    continue;
  }

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

  // determinism — HARD
  run.deterministic(() => prepareOutbound(input), f);

  // contract shape — HARD
  run.contract(res, REQUIRED_KEYS, f);

  // ---- universal safety invariants (apply to EVERY case) ----
  run.check(res.status === 'draft' || res.status === 'blocked',
    `${f} produced status '${res.status}' — only draft|blocked may exist in B3`);
  run.check(!res.draft || res.draft.status !== 'sent',
    `${f} produced a draft in 'sent' state — no send path may exist`);
  run.check(!res.draft || res.draft.status !== 'approved',
    `${f} produced a pre-approved draft — automation has zero approval authority`);
  run.check(!res.events.includes('message.approved') && !res.events.includes('message.sent'),
    `${f} emitted an approval/send event from a drafting run`);
  if (res.ok) {
    run.check(res.draft.requires_human_approval === true,
      `${f} ok draft does not require human approval`);
    run.check(res.draft.send_capability === false,
      `${f} ok draft claims send capability`);
    run.check((res.draft.to_addrs || []).every((a) => String(a).toLowerCase().endsWith(FIXTURE_EMAIL_DOMAIN)),
      `${f} ok draft addresses a non-fixture recipient: ${JSON.stringify(res.draft.to_addrs)}`);
    run.check(res.routing.effective_mode === 'draft',
      `${f} effective_mode is '${res.routing?.effective_mode}' — zero v1 auto-sends is locked`);
  }
  if (res.blocked_reason) {
    run.check(BLOCKED_REASONS.includes(res.blocked_reason),
      `${f} unknown blocked_reason '${res.blocked_reason}'`);
    // Cross-engine check: the reason must also be registered in the platform
    // union, so one string cannot mean two things across route/gate/queue.
    run.check(platformReasons.has(res.blocked_reason),
      `${f} blocked_reason '${res.blocked_reason}' is not in the platform reason union`);
    run.record('blocked_reason', res.blocked_reason);
  }
  run.check(Array.isArray(res.audit) && res.audit.length > 0, `${f} produced no audit trail`);

  // ---- label assertions ----
  run.equal(res.ok, label.ok, `${f} ok`);
  run.equal(res.status, label.status, `${f} status`);
  run.equal(res.persist, label.persist, `${f} persist`);
  run.equal(res.blocked_reason, label.blocked_reason ?? null, `${f} blocked_reason`);
  run.equal(res.draft_key, label.draft_key, `${f} draft_key`);
  // Order-sensitive: the event sequence a run emits is part of its contract.
  run.equal(res.events ?? [], label.events ?? [], `${f} events`);

  for (const field of ['approver_role', 'routing_path', 'escalated', 'policy_mode', 'effective_mode', 'auto_downgraded']) {
    if (field in label) run.equal(res.routing?.[field], label[field], `${f} ${field}`);
  }
}

run.section('Runner 4 gates');

// Fail-closed coverage: every blocked reason must be exercised by a fixture —
// an unexercised refusal is an unproven refusal. HARD.
run.coverage('blocked_reason', BLOCKED_REASONS, { label: 'blocked-reason coverage' });

// Every reason this engine can produce is registered in the platform union.
run.includesAll(platformReasons.all(), BLOCKED_REASONS, 'engine reasons missing from the platform union');

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
  run.check(built.ok, `template ${t} failed to render: ${built.error}`);
  if (built.ok) {
    run.check(built.draft.status === 'draft', `template ${t} produced status ${built.draft.status}`);
    run.check(built.draft.to_addrs.every((a) => a.endsWith(FIXTURE_EMAIL_DOMAIN)),
      `template ${t} addressed a non-fixture recipient`);
    run.check(scanForbiddenContent(built.draft.body_text).length === 0,
      `template ${t} body contains forbidden troubleshooting content`);
  }
}
console.log(`template coverage ${TEMPLATE_IDS.length}/${MESSAGE_TYPES.length}`);
run.includesAll(TEMPLATE_IDS, MESSAGE_TYPES, 'every message type needs a template');

// Source purity: the engine modules must contain no network or send machinery.
// This is the structural proof behind "no send capability exists". HARD.
run.sourcePurity(
  ['lib/approval-matrix.mjs', 'lib/outbound-draft.mjs'].map((m) => join(HERE, m)),
  [
    {
      name: 'network/send machinery',
      pattern: /\b(fetch\s*\(|https?:\/\/|require\s*\(|nodemailer|smtp|sendmail|graph\.microsoft)/i,
      message: 'the outbound engines must contain no network or send capability',
    },
    {
      name: 'non-local import',
      pattern: /\bimport\s+.*\bfrom\s+['"](?!\.\/)/,
      message: 'the outbound engines depend on nothing but their own directory',
    },
  ],
  { label: 'engine purity' },
);

// Seed parity: the v1 fixture matrix covers every message type, and no fixture
// policy anywhere puts the final invoice into auto mode (REQUIREMENTS: never auto).
run.includesAll((policySets.seed_v1 || []).map((p) => p.message_type), MESSAGE_TYPES, 'seed_v1 message-type rows');
const invoiceAuto = Object.entries(policySets)
  .filter(([k]) => k !== '_readme')
  .flatMap(([set, rows]) => (Array.isArray(rows) ? rows : [])
    .filter((p) => p.message_type === 'final_invoice' && p.mode === 'auto')
    .map(() => set));
run.check(invoiceAuto.length === 0, `final_invoice in auto mode in policy set(s) ${JSON.stringify(invoiceAuto)}`);
// Every v1 seed row is draft mode — zero v1 auto-sends, seeded honestly.
run.check((policySets.seed_v1 || []).every((p) => p.mode === 'draft'),
  'seed_v1 contains a non-draft mode row (zero v1 auto-sends is locked)');

const report = run.summary({ fixtures: corpus.cases.length });

// Durable evidence: this run's own verdict, as a run-report artifact, through
// the same scaffolding every AWE workflow uses. `AWE_ARTIFACTS=off` opts out.
const persisted = await persistSuiteReport(report, { workflowId: 'approval_matrix' });
if (persisted.skipped) console.log('run artifact: skipped (AWE_ARTIFACTS=off)');
else if (persisted.ok) console.log(`run artifact: ${persisted.ref} [${persisted.final_state}]`);
else console.log(`FAIL  run artifact was not written — ${persisted.error}`);

// A durable record that did not land is a failure of this run, not a warning.
// It cannot be counted in the summary above (it records that summary), so it is
// a hard gate on the exit code instead.
process.exit(run.exitCode || (persisted.skipped || persisted.ok ? 0 : 1));
