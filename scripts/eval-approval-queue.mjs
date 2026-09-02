// ---------------------------------------------------------------------------
// eval-approval-queue.mjs — assertion harness behind Runner 5 (Task B5).
//
// PURE OFFLINE. No API keys, no model calls, no DB, no network, no Graph, no
// mailbox, no browser. It imports the approval queue's decidable logic
// (apps/web/src/lib/approval-queue.ts — Node 24 strips the types) and asserts
// every labelled case in fixtures/queue/, plus the invariants that make the
// queue safe, as HARD gates:
//
//   * determinism      — same row + same capabilities twice, identical verdict
//   * label parity     — guard verdict AND the RPC payload match the label
//   * reason coverage  — every GUARD_REASON in the vocabulary is exercised
//   * duplicate guard  — no already-decided message can be decided again
//   * authz guard      — an unheld role, an unresolved role and no session all deny
//   * TEST mode        — fixture-safety enforced in BOTH directions
//   * view states      — loading / signed_out / error / empty / ready
//   * refresh verdict  — a decision that did not apply is reported as a failure
//   * audit trail      — reconstructed history is ordered and attributed
//   * schema parity    — QUEUE_SELECT names only columns that exist in the
//                        migrations, and no service-role-only table
//   * enum parity      — statuses / roles / message types match 0015's enums
//   * source purity    — the UI has no send path, no service-role key, no
//                        direct write to outbound_messages
//
// Exit 0 iff all gates pass. Invoked by scripts/eval-approval-queue.sh.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  BUSINESS_ROLES,
  DECIDABLE_STATUSES,
  GUARD_REASONS,
  MESSAGE_TYPES,
  OUTBOUND_STATUSES,
  QUEUE_SELECT,
  QUEUE_TABS,
  buildAuditTrail,
  decisionGuard,
  escalationLine,
  filterTab,
  formatAmount,
  planDecision,
  planSendMark,
  queueState,
  recipientLine,
  requesterLine,
  requiredRoles,
  resolveQueueMode,
  sendGuard,
  summarizeQueue,
  tabOf,
  verifyDecisionApplied,
  verifySendApplied,
} from '../apps/web/src/lib/approval-queue.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIR = join(ROOT, 'fixtures', 'queue');
const CASES = join(DIR, 'cases');

const read = (p) => readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));

let pass = 0;
let fail = 0;
const ok = () => { pass++; };
const bad = (m) => { console.log(`FAIL  ${m}`); fail++; };
const check = (cond, m) => (cond ? ok() : bad(m));

const baseRow = readJson(join(DIR, 'base-row.json'));
const labels = readJson(join(DIR, 'labels.json'));
const files = readdirSync(CASES).filter((f) => f.endsWith('.json')).sort();

const seenGuardReasons = new Set();
const allRows = [];

// ---------------------------------------------------------------------------
// Per-case labels
// ---------------------------------------------------------------------------

for (const f of files) {
  const label = labels[f];
  if (!label) { bad(`${f} has no entry in labels.json`); continue; }

  let c;
  try { c = readJson(join(CASES, f)); }
  catch (e) { bad(`${f} is not valid JSON: ${e.message}`); continue; }

  // Cases state only what they are testing; everything else is the base row.
  const row = { ...baseRow, ...(c.row ?? {}) };
  delete row._comment;
  allRows.push(row);

  const input = {
    row,
    mode: c.mode ?? 'TEST',
    capabilities: c.capabilities ?? { userId: null, roles: {} },
  };

  // A case is a DECISION case unless it says otherwise. B5c send cases exercise
  // the same guard/plan contract against sendGuard/planSendMark, so both write
  // paths out of this UI are covered by labelled fixtures rather than by
  // inline assertions only.
  const action = c.action ?? 'decide';
  check(action === 'decide' || action === 'send', `${f} unknown action '${action}'`);

  if (action === 'send') {
    const s1 = sendGuard(input);
    const s2 = sendGuard(input);
    check(JSON.stringify(s1) === JSON.stringify(s2), `${f} sendGuard is non-deterministic`);

    check(s1.allowed === label.guard_allowed,
      `${f} send guard allowed=${s1.allowed} expected ${label.guard_allowed} (${s1.reason})`);
    check((s1.reason ?? null) === (label.guard_reason ?? null),
      `${f} send guard reason=${s1.reason} expected ${label.guard_reason}`);
    if (s1.reason) {
      seenGuardReasons.add(s1.reason);
      check(GUARD_REASONS.includes(s1.reason), `${f} send guard reason '${s1.reason}' is outside the vocabulary`);
      check(typeof s1.detail === 'string' && s1.detail.length > 0,
        `${f} send refusal carries no human-readable detail`);
    }

    const sp1 = planSendMark(input);
    const sp2 = planSendMark(input);
    check(JSON.stringify(sp1) === JSON.stringify(sp2), `${f} planSendMark is non-deterministic`);
    check(sp1.ok === label.plan_ok, `${f} send plan ok=${sp1.ok} expected ${label.plan_ok} (${sp1.reason})`);

    if (label.plan_ok) {
      check(sp1.rpc !== null, `${f} an allowed send-marking produced no RPC payload`);
      check(sp1.rpc?.p_message === row.id, `${f} send RPC targets the wrong message`);
      check(Object.keys(sp1.rpc ?? {}).length === 1,
        `${f} send RPC payload carries fields mark_message_sent() does not accept`);
    } else {
      // HARD: a refused send-marking must produce NOTHING that could be called.
      check(sp1.rpc === null, `${f} a refused send-marking still produced an RPC payload`);
      check(sp1.reason === label.plan_reason,
        `${f} send plan reason=${sp1.reason} expected ${label.plan_reason}`);
      if (sp1.reason) seenGuardReasons.add(sp1.reason);
    }
    continue;
  }

  const g1 = decisionGuard(input);
  const g2 = decisionGuard(input);
  check(JSON.stringify(g1) === JSON.stringify(g2), `${f} decisionGuard is non-deterministic`);

  check(g1.allowed === label.guard_allowed,
    `${f} guard allowed=${g1.allowed} expected ${label.guard_allowed} (${g1.reason})`);
  check((g1.reason ?? null) === (label.guard_reason ?? null),
    `${f} guard reason=${g1.reason} expected ${label.guard_reason}`);
  if (g1.reason) {
    seenGuardReasons.add(g1.reason);
    check(GUARD_REASONS.includes(g1.reason), `${f} guard reason '${g1.reason}' is outside the vocabulary`);
    check(typeof g1.detail === 'string' && g1.detail.length > 0,
      `${f} refusal carries no human-readable detail`);
  }

  const planInput = { ...input, decision: c.decision, reason: c.reason ?? null };
  const p1 = planDecision(planInput);
  const p2 = planDecision(planInput);
  check(JSON.stringify(p1) === JSON.stringify(p2), `${f} planDecision is non-deterministic`);

  check(p1.ok === label.plan_ok, `${f} plan ok=${p1.ok} expected ${label.plan_ok} (${p1.reason})`);

  if (label.plan_ok) {
    check(p1.rpc !== null, `${f} an allowed decision produced no RPC payload`);
    if (p1.rpc) {
      check(p1.rpc.p_message === row.id, `${f} RPC targets the wrong message`);
      check(p1.rpc.p_decision === label.rpc.p_decision,
        `${f} RPC decision=${p1.rpc.p_decision} expected ${label.rpc.p_decision}`);
      check((p1.rpc.p_reason ?? null) === (label.rpc.p_reason ?? null),
        `${f} RPC reason=${JSON.stringify(p1.rpc.p_reason)} expected ${JSON.stringify(label.rpc.p_reason)}`);
      check(Object.keys(p1.rpc).length === 3,
        `${f} RPC payload carries fields record_approval() does not accept`);
    }
  } else {
    // HARD: a refused decision must produce NOTHING that could be sent.
    check(p1.rpc === null, `${f} a refused decision still produced an RPC payload`);
    check(p1.reason === label.plan_reason,
      `${f} plan reason=${p1.reason} expected ${label.plan_reason}`);
    if (p1.reason) seenGuardReasons.add(p1.reason);
  }
}

// ---------------------------------------------------------------------------
// Coverage: every refusal in the vocabulary is exercised by a fixture
// ---------------------------------------------------------------------------

for (const reason of GUARD_REASONS) {
  check(seenGuardReasons.has(reason), `guard reason '${reason}' is never exercised by a fixture`);
}
const coverage = `${seenGuardReasons.size}/${GUARD_REASONS.length}`;

// ---------------------------------------------------------------------------
// Duplicate-decision protection, stated as an invariant over every status
// ---------------------------------------------------------------------------

const caps = { userId: 'u-admin', roles: { office_admin: true, owner: true } };
for (const status of OUTBOUND_STATUSES) {
  const row = { ...baseRow, status };
  delete row._comment;
  const g = decisionGuard({ row, mode: 'TEST', capabilities: caps });
  if (DECIDABLE_STATUSES.includes(status)) {
    check(g.allowed === true, `status '${status}' should be decidable but was refused (${g.reason})`);
  } else {
    check(g.allowed === false && g.reason === 'not_pending',
      `status '${status}' must not be decidable (got allowed=${g.allowed}/${g.reason})`);
  }
}

// ---------------------------------------------------------------------------
// View states — including the failed fetch and the empty queue
// ---------------------------------------------------------------------------

const someRows = [{ ...baseRow }];
check(queueState({ loading: true, error: null, signedIn: true, rows: someRows }) === 'loading',
  'loading state not reported while loading');
check(queueState({ loading: false, error: null, signedIn: false, rows: null }) === 'signed_out',
  'signed-out state not reported without a session');
check(queueState({ loading: false, error: 'network error', signedIn: true, rows: null }) === 'error',
  'failed fetch not reported as an error state');
check(queueState({ loading: false, error: 'permission denied for table outbound_messages', signedIn: true, rows: [] }) === 'error',
  'an RLS refusal must surface as an error, not as an empty queue');
check(queueState({ loading: false, error: null, signedIn: true, rows: [] }) === 'empty',
  'empty queue not reported');
check(queueState({ loading: false, error: null, signedIn: true, rows: null }) === 'empty',
  'null rows must read as empty, never as ready');
check(queueState({ loading: false, error: null, signedIn: true, rows: someRows }) === 'ready',
  'ready state not reported with rows');

const emptySummary = summarizeQueue([]);
check(Object.values(emptySummary).every((v) => v === 0), 'empty queue summary is not all zeros');
check(summarizeQueue(null).total === 0, 'null queue summary is not zero');

// ---------------------------------------------------------------------------
// Tabs partition the queue exactly once
// ---------------------------------------------------------------------------

const partitioned = QUEUE_TABS.reduce((n, t) => n + filterTab(allRows, t).length, 0);
check(partitioned === allRows.length,
  `tabs do not partition the queue (${partitioned} placed vs ${allRows.length} rows)`);
for (const r of allRows) {
  check(QUEUE_TABS.includes(tabOf(r)), `row with status '${r.status}' lands outside the tab vocabulary`);
}
const summary = summarizeQueue(allRows);
check(summary.total === allRows.length, 'summary total disagrees with the row count');
check(summary.pending + summary.to_send + summary.blocked + summary.decided === summary.total,
  'summary buckets do not add up to the total');

// ---------------------------------------------------------------------------
// Deterministic post-decision refresh
// ---------------------------------------------------------------------------

const decided = { ...baseRow, status: 'approved', approved_at: '2026-07-26T15:00:00.000Z' };
check(verifyDecisionApplied({ rows: [decided], messageId: baseRow.id, decision: 'approve' }).settled === true,
  'a decision that applied was not reported as settled');
check(verifyDecisionApplied({ rows: [{ ...baseRow }], messageId: baseRow.id, decision: 'approve' }).settled === false,
  'a decision that did NOT apply was reported as success');
const vanished = verifyDecisionApplied({ rows: [], messageId: baseRow.id, decision: 'reject' });
check(vanished.settled === false && vanished.status === null,
  'a message missing after refresh was not reported as unsettled');
check(verifyDecisionApplied({ rows: [decided], messageId: baseRow.id, decision: 'reject' }).settled === false,
  'an approved row was accepted as evidence of a rejection');

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

const fullRow = {
  ...baseRow,
  status: 'sent',
  escalated: true,
  escalation_reason: 'amount 250000 exceeds approval limit 50000 for role office_admin',
  approved_at: '2026-07-26T15:00:00.000Z',
  approver: { full_name: 'Jack Admin' },
  sent_at: '2026-07-26T15:30:00.000Z',
  sender: { full_name: 'Jack Admin' },
};
const trail = buildAuditTrail(fullRow);
const steps = trail.map((e) => e.step);
check(JSON.stringify(steps) === JSON.stringify(['draft_created', 'escalated', 'approved', 'sent']),
  `audit trail out of order or incomplete: ${steps.join(' -> ')}`);
check(trail.every((e) => typeof e.step === 'string' && typeof e.actor === 'string' && e.actor.length > 0),
  'an audit entry has no attributed actor');
check(trail.find((e) => e.step === 'approved').actor === 'Jack Admin',
  'the approver is not named in the audit trail');

const rejectedTrail = buildAuditTrail({
  ...baseRow, status: 'rejected', rejected_at: '2026-07-26T15:05:00.000Z',
  rejection_reason: 'wrong customer', rejector: { full_name: 'Jack Admin' },
});
check(rejectedTrail.some((e) => e.step === 'rejected' && e.detail === 'wrong customer'),
  'the rejection reason is missing from the audit trail');

const blockedTrail = buildAuditTrail({
  ...baseRow, status: 'blocked', assigned_approver_role: null,
  routing_path: null, blocked_reason: 'missing_approver_role',
});
check(blockedTrail[0].step === 'blocked' && /missing_approver_role/.test(blockedTrail[0].detail ?? ''),
  'a blocked row does not explain itself in the audit trail');

check(JSON.stringify(buildAuditTrail(fullRow)) === JSON.stringify(trail),
  'buildAuditTrail is non-deterministic');

// ---------------------------------------------------------------------------
// Presentation helpers (no crashes, no invented data)
// ---------------------------------------------------------------------------

check(formatAmount(null) === '—', 'a null amount must render as an em dash, never as $0.00');
check(formatAmount(250000) === '$2,500.00', `formatAmount(250000)=${formatAmount(250000)}`);
check(recipientLine({ ...baseRow, to_addrs: [] }) === '—', 'no recipient must render as an em dash');
check(requesterLine({ ...baseRow, work_requests: null }) === '—', 'a message with no work request must not invent a requester');
check(/escalated/.test(escalationLine({ ...baseRow, escalated: true, escalation_reason: 'over limit' })),
  'escalation state is not surfaced');
check(requiredRoles(allRows).every((r) => BUSINESS_ROLES.includes(r)),
  'a required approver role is outside the business-role vocabulary');

// ---------------------------------------------------------------------------
// Mode resolution — fail closed
// ---------------------------------------------------------------------------

check(resolveQueueMode({}) === 'TEST', 'unconfigured mode must default to TEST');
check(resolveQueueMode({ AWE_MODE: undefined }) === 'TEST', 'undefined mode must default to TEST');
check(resolveQueueMode({ AWE_MODE: 'live' }) === 'TEST', 'mode matching is case-sensitive by design');
check(resolveQueueMode({ AWE_MODE: 'LIVE' }) === 'LIVE', 'explicit LIVE mode not honored');

// ---------------------------------------------------------------------------
// Enum parity with migration 0015 / 0011
// ---------------------------------------------------------------------------

const sql0015 = read(join(ROOT, 'supabase', 'migrations', '0015_approval_matrix_outbound.sql'));
const sql0011 = read(join(ROOT, 'supabase', 'migrations', '0011_request_intake.sql'));
const sql0001 = read(join(ROOT, 'supabase', 'migrations', '0001_core.sql'));

function enumValues(sql, name) {
  const m = new RegExp(`create type ${name} as enum\\s*\\(([^)]*)\\)`, 'i').exec(sql);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const sameSet = (a, b) => a && b && [...a].sort().join(',') === [...b].sort().join(',');

check(sameSet(enumValues(sql0015, 'outbound_message_status'), OUTBOUND_STATUSES),
  'OUTBOUND_STATUSES has drifted from the outbound_message_status enum in 0015');
check(sameSet(enumValues(sql0015, 'business_role'), BUSINESS_ROLES),
  'BUSINESS_ROLES has drifted from the business_role enum in 0015');
check(sameSet(enumValues(sql0015, 'outbound_message_type'), MESSAGE_TYPES),
  'MESSAGE_TYPES has drifted from the outbound_message_type enum in 0015');
check(DECIDABLE_STATUSES.length === 1 && DECIDABLE_STATUSES[0] === 'draft',
  "DECIDABLE_STATUSES must stay ['draft'] — 0015 refuses any other status");

// ---------------------------------------------------------------------------
// QUEUE_SELECT parity: every column the UI asks for exists, and nothing it asks
// for is a table the browser has no policy on.
// ---------------------------------------------------------------------------

function tableColumns(sql, table) {
  const m = new RegExp(`create table ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(sql);
  if (!m) return null;
  const cols = [];
  for (const line of m[1].split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('--')) continue;
    const c = /^([a-z_][a-z0-9_]*)\s+/.exec(t);
    if (!c) continue;
    if (['check', 'constraint', 'primary', 'unique', 'foreign'].includes(c[1])) continue;
    cols.push(c[1]);
  }
  return cols;
}

// Split a PostgREST projection on top-level commas only.
function splitTop(sel) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const COLUMNS = {
  outbound_messages: tableColumns(sql0015, 'outbound_messages'),
  message_policies: tableColumns(sql0015, 'message_policies'),
  work_requests: tableColumns(sql0011, 'work_requests'),
  email_messages: tableColumns(sql0011, 'email_messages'),
  users: tableColumns(sql0001, 'users'),
};
for (const [t, cols] of Object.entries(COLUMNS)) {
  check(Array.isArray(cols) && cols.length > 0, `could not parse the ${t} column list out of the migrations`);
}

// Tables with NO client SELECT policy anywhere. Naming one in QUEUE_SELECT would
// mean the queue only works with a service-role key in the browser.
const SERVICE_ROLE_ONLY = ['integration_events', 'approval_outcomes'];

function verifySelect(sel, table, path) {
  for (const token of splitTop(sel)) {
    const embed = /^(?:([a-z_]+):)?([a-z_]+)(?:!([a-z_]+))?\(([\s\S]*)\)$/.exec(token);
    if (embed) {
      const [, , relation, hint, inner] = embed;
      check(!SERVICE_ROLE_ONLY.includes(relation),
        `${path} embeds '${relation}', which has no client SELECT policy`);
      // A disambiguating FK hint is '<source table>_<source column>_fkey'.
      // Resolve it against the real column lists so a typo fails here rather
      // than as a PostgREST 300 in the browser.
      if (hint) {
        const resolved = Object.entries(COLUMNS).some(([t, cols]) => {
          if (!hint.startsWith(`${t}_`) || !hint.endsWith('_fkey')) return false;
          const col = hint.slice(t.length + 1, -'_fkey'.length);
          return (cols ?? []).includes(col);
        });
        check(resolved, `${path} FK hint '${hint}' does not resolve to a real column`);
      }
      const cols = COLUMNS[relation];
      check(cols !== undefined, `${path} embeds unknown relation '${relation}'`);
      if (cols) verifySelect(inner, relation, `${path}.${relation}`);
      continue;
    }
    check(COLUMNS[table].includes(token),
      `${path} selects '${token}', which is not a column of ${table}`);
  }
}
verifySelect(QUEUE_SELECT, 'outbound_messages', 'QUEUE_SELECT');

for (const t of SERVICE_ROLE_ONLY) {
  check(!QUEUE_SELECT.includes(t), `QUEUE_SELECT references the service-role-only table '${t}'`);
}

// ---------------------------------------------------------------------------
// B5c — recording a real-world send (mark_message_sent)
//
// An approved message is OUTSTANDING WORK: a human still owes the customer an
// email. These assertions protect the two ways that can go wrong — the loop
// never closing, and the system recording a send that never happened.
// ---------------------------------------------------------------------------

const ADMIN = { userId: 'u-admin', roles: { office_admin: true } };
const NOBODY = { userId: 'u-none', roles: {} };
const approvedRow = {
  ...baseRow,
  status: 'approved',
  approved_at: '2026-07-26T15:00:00.000Z',
  approver: { full_name: 'Fixture Admin' },
};

// --- the happy path -------------------------------------------------------
const sendPlan = planSendMark({ row: approvedRow, mode: 'TEST', capabilities: ADMIN });
check(sendPlan.ok === true, `an approved fixture row was not markable as sent: ${sendPlan.reason} ${sendPlan.detail}`);
check(sendPlan.rpc?.p_message === approvedRow.id, 'send plan carries the wrong message id');
check(Object.keys(sendPlan.rpc ?? {}).length === 1,
  'send plan passes arguments mark_message_sent() does not take');

// --- only an approved message can be marked sent --------------------------
for (const status of ['draft', 'rejected', 'blocked', 'failed']) {
  const g = sendGuard({ row: { ...baseRow, status }, mode: 'TEST', capabilities: ADMIN });
  check(g.allowed === false && g.reason === 'not_awaiting_send',
    `a '${status}' message was offered a send-marking`);
}

// --- duplicate protection: a sent message cannot be re-marked -------------
const sentRow = {
  ...approvedRow,
  status: 'sent',
  sent_at: '2026-07-26T16:00:00.000Z',
  sender: { full_name: 'Fixture Admin' },
};
const dup = planSendMark({ row: sentRow, mode: 'TEST', capabilities: ADMIN });
check(dup.ok === false && dup.reason === 'not_awaiting_send',
  'an already-sent message could be marked sent again');
check(dup.rpc === null, 'a refused send-marking still produced an RPC payload');
check(/already recorded as sent/.test(dup.detail ?? ''),
  'duplicate send refusal does not explain itself');

// --- authorization --------------------------------------------------------
const noRole = planSendMark({ row: approvedRow, mode: 'TEST', capabilities: NOBODY });
check(noRole.ok === false && noRole.reason === 'unauthorized_approver',
  'a user without the approver role could record a send');
check(noRole.rpc === null, 'an unauthorized send-marking still produced an RPC payload');

const noApprover = sendGuard({
  row: { ...approvedRow, assigned_approver_role: null },
  mode: 'TEST',
  capabilities: ADMIN,
});
check(noApprover.allowed === false && noApprover.reason === 'unassigned_approver',
  'a message with no assigned approver could be marked sent');

// --- fixture safety, both directions --------------------------------------
// THE critical one: marking a fixture "sent" in LIVE would write a permanent
// claim that a real customer email went out when nothing did.
const fixtureLive = planSendMark({ row: approvedRow, mode: 'LIVE', capabilities: ADMIN });
check(fixtureLive.ok === false && fixtureLive.reason === 'fixture_in_live_mode',
  'a FIXTURE row could be recorded as sent in LIVE mode');
check(fixtureLive.rpc === null, 'a LIVE-mode fixture send-marking still produced an RPC payload');

const realInTest = planSendMark({
  row: { ...approvedRow, is_fixture: false, to_addrs: ['real.customer@example.com'] },
  mode: 'TEST',
  capabilities: ADMIN,
});
check(realInTest.ok === false && realInTest.reason === 'test_mode_violation',
  'a real recipient could be recorded as sent in TEST mode');

// --- tabs: approved is outstanding work, not finished business ------------
check(tabOf(approvedRow) === 'to_send',
  'an approved-but-unsent message was filed as decided — outstanding work would go missing');
check(tabOf(sentRow) === 'decided', 'a sent message did not settle into decided');
const sendSummary = summarizeQueue([approvedRow, sentRow, { ...baseRow }]);
check(sendSummary.to_send === 1 && sendSummary.decided === 1 && sendSummary.pending === 1,
  `send-tab summary is wrong: ${JSON.stringify(sendSummary)}`);

// --- deterministic post-send refresh --------------------------------------
check(verifySendApplied({ rows: [sentRow], messageId: approvedRow.id }).settled === true,
  'a send-marking that applied was not reported as settled');
const stuck = verifySendApplied({ rows: [approvedRow], messageId: approvedRow.id });
check(stuck.settled === false, 'a send-marking that did NOT apply was reported as success');
check(/still outstanding/.test(stuck.message),
  'an unapplied send-marking does not tell the human the work is still outstanding');
check(verifySendApplied({ rows: [], messageId: approvedRow.id }).settled === false,
  'a vanished message was reported as successfully sent');

// --- the audit trail records the send -------------------------------------
const sentTrail = buildAuditTrail(sentRow);
check(sentTrail.some((e) => e.step === 'sent'),
  'the audit trail does not record the send');

// ---------------------------------------------------------------------------
// Source purity — the UI cannot send, cannot escalate privilege, holds no secret
// ---------------------------------------------------------------------------

const UI_FILES = {
  'apps/web/src/lib/approval-queue.ts': read(join(ROOT, 'apps/web/src/lib/approval-queue.ts')),
  'apps/web/src/app/approvals/page.tsx': read(join(ROOT, 'apps/web/src/app/approvals/page.tsx')),
};

// Comments explain the boundaries, so purity is asserted against code only.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

// B5c NOTE: mark_message_sent was previously forbidden here, because B5 shipped
// approve/reject only. It is now permitted and allow-listed below -- it is a
// LEDGER call recording that a human sent a message, gated by 0015 on status,
// org and role. The invariant that actually protects the customer is unchanged
// and still asserted: the UI has NO MAIL TRANSPORT and cannot write to
// outbound_messages directly.
const FORBIDDEN_IN_UI = [
  [/\bcreate_outbound_draft\b/, 'a draft-creation call (the queue only decides)'],
  [/service_role|SERVICE_ROLE|sb_secret_|SUPABASE_ACCESS_TOKEN/, 'a service-role or management credential'],
  [/eyJ[A-Za-z0-9_-]{10,}/, 'a hard-coded JWT'],
  [/graph\.microsoft\.com|smtp|nodemailer|sendMail/i, 'mail transport machinery'],
  [/\.from\(\s*['"]outbound_messages['"]\s*\)\s*\.(insert|update|delete|upsert)/, 'a direct write to outbound_messages'],
  [/\.from\(\s*['"]integration_events['"]\s*\)/, 'a read of the service-role-only event log'],
];

for (const [name, src] of Object.entries(UI_FILES)) {
  const code = stripComments(src);
  for (const [re, what] of FORBIDDEN_IN_UI) {
    check(!re.test(code), `${name} contains ${what}`);
  }
}

// The queue may call exactly these RPCs, and no others.
const rpcCalls = [...Object.values(UI_FILES).join('\n').matchAll(/\.rpc\(\s*['"]([a-z_]+)['"]/g)]
  .map((m) => m[1]);
const allowedRpcs = ['record_approval', 'business_role_matches', 'mark_message_sent'];
for (const r of rpcCalls) {
  check(allowedRpcs.includes(r), `the queue calls an unexpected RPC '${r}'`);
}
check(rpcCalls.includes('record_approval'), 'the queue never calls record_approval — the approval gate is bypassed');

// The page must route every decision through planDecision: an .rpc('record_approval')
// that is not fed by a plan would skip every guard above.
const pageCode = stripComments(UI_FILES['apps/web/src/app/approvals/page.tsx']);
check(/planDecision\(/.test(pageCode), 'the page does not call planDecision — guards are bypassable');
check(/plan\.rpc/.test(pageCode), 'the page does not pass the planned payload to record_approval');
check(/verifyDecisionApplied\(/.test(pageCode), 'the page does not verify the decision after refresh');

// ---------------------------------------------------------------------------

console.log(`guard-reason coverage ${coverage}`);
console.log(
  `eval-approval-queue (Runner 5, offline, deterministic): passed=${pass} failed=${fail}  [${files.length} fixtures]`,
);
process.exit(fail === 0 ? 0 : 1);
