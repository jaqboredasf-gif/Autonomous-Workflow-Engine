// ---------------------------------------------------------------------------
// eval-approval-queue.mjs — assertion harness behind Runner 5 (Task B5).
//
// PURE OFFLINE. No API keys, no model calls, no DB, no network, no Graph, no
// mailbox, no browser. It imports the approval queue's decidable logic
// (apps/web/src/lib/approval-queue.ts — Node 24 strips the types) and asserts
// every labelled case in fixtures/queue/, plus the invariants that make the
// queue safe, as HARD gates:
//
//   * corpus parity    — every fixture is labelled and every label has a fixture
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
//   * durable report   — this run's own result is persisted as a run artifact
//
// Built on @exattime/awe-kernel: the corpus loader, the gate run and the
// determinism/coverage/purity gates are shared with every other runner, so this
// file contains only what is specific to B5. Output format is unchanged.
//
// Exit 0 iff all gates pass. Invoked by scripts/eval-approval-queue.sh.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createGateRun, loadCorpus, stripComments } from '../packages/awe-kernel/src/index.mjs';
import { reasons as platformReasons } from './lib/awe-reasons.mjs';
import { persistSuiteReport } from './lib/runner-report.mjs';
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
  queueState,
  recipientLine,
  requesterLine,
  requiredRoles,
  resolveQueueMode,
  summarizeQueue,
  tabOf,
  verifyDecisionApplied,
} from '../apps/web/src/lib/approval-queue.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIR = join(ROOT, 'fixtures', 'queue');
const CASES = join(DIR, 'cases');

const read = (p) => readFileSync(p, 'utf8');

const run = createGateRun({ name: 'eval-approval-queue (Runner 5, offline, deterministic)' });
const { check, equal } = run;

const baseRow = JSON.parse(read(join(DIR, 'base-row.json')));

// `base-row.json` and `labels.json` live beside the cases directory, so only the
// case files are loaded. An unlabelled case is never asserted and an orphan
// label is a rule nobody checks — both are gate failures, not silent skips.
const corpus = loadCorpus({ dir: DIR, casesDir: CASES, name: 'fixtures/queue' });
run.corpusParity(corpus);
check(corpus.cases.length >= 19, `fixtures/queue shrank to ${corpus.cases.length} cases — coverage was removed, not refactored`);

const allRows = [];

// ---------------------------------------------------------------------------
// Per-case labels
// ---------------------------------------------------------------------------

for (const { name: f, data: c, label } of corpus.cases) {
  if (label === null) continue; // already reported by the parity gate

  // Cases state only what they are testing; everything else is the base row.
  const row = { ...baseRow, ...(c.row ?? {}) };
  delete row._comment;
  allRows.push(row);

  const input = {
    row,
    mode: c.mode ?? 'TEST',
    capabilities: c.capabilities ?? { userId: null, roles: {} },
  };

  // HARD determinism gate: compared by canonical bytes, so key order cannot
  // mask a difference and a hidden clock/random dependency cannot pass.
  run.deterministic(() => decisionGuard(input), `${f} decisionGuard`);

  const g1 = decisionGuard(input);
  check(g1.allowed === label.guard_allowed,
    `${f} guard allowed=${g1.allowed} expected ${label.guard_allowed} (${g1.reason})`);
  check((g1.reason ?? null) === (label.guard_reason ?? null),
    `${f} guard reason=${g1.reason} expected ${label.guard_reason}`);
  if (g1.reason) {
    run.record('guard_reason', g1.reason);
    run.member(g1.reason, GUARD_REASONS, `${f} guard reason vocabulary`);
    // Cross-engine check: the reason must also be registered in the platform
    // union, so one string cannot mean two things across route/gate/queue.
    check(platformReasons.has(g1.reason),
      `${f} guard reason '${g1.reason}' is not in the platform reason union`);
    check(typeof g1.detail === 'string' && g1.detail.length > 0,
      `${f} refusal carries no human-readable detail`);
  }

  const planInput = { ...input, decision: c.decision, reason: c.reason ?? null };
  run.deterministic(() => planDecision(planInput), `${f} planDecision`);

  const p1 = planDecision(planInput);
  check(p1.ok === label.plan_ok, `${f} plan ok=${p1.ok} expected ${label.plan_ok} (${p1.reason})`);

  if (label.plan_ok) {
    check(p1.rpc !== null, `${f} an allowed decision produced no RPC payload`);
    if (p1.rpc) {
      check(p1.rpc.p_message === row.id, `${f} RPC targets the wrong message`);
      equal(p1.rpc.p_decision, label.rpc.p_decision, `${f} RPC decision`);
      equal(p1.rpc.p_reason ?? null, label.rpc.p_reason ?? null, `${f} RPC reason`);
      check(Object.keys(p1.rpc).length === 3,
        `${f} RPC payload carries fields record_approval() does not accept`);
    }
  } else {
    // HARD: a refused decision must produce NOTHING that could be sent.
    check(p1.rpc === null, `${f} a refused decision still produced an RPC payload`);
    equal(p1.reason, label.plan_reason, `${f} plan reason`);
    if (p1.reason) {
      run.record('guard_reason', p1.reason);
      check(platformReasons.has(p1.reason),
        `${f} plan reason '${p1.reason}' is not in the platform reason union`);
    }
  }
}

// ---------------------------------------------------------------------------
// Coverage: every refusal in the vocabulary is exercised by a fixture. HARD —
// an unexercised refusal is an unproven refusal.
// ---------------------------------------------------------------------------

run.coverage('guard_reason', [...GUARD_REASONS], { label: 'guard-reason coverage' });

// Every reason this engine can produce is registered in the platform union —
// the same gate Runner 4 applies to the routing vocabulary.
run.includesAll(platformReasons.all(), [...GUARD_REASONS], 'queue reasons missing from the platform union');

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
  run.member(tabOf(r), [...QUEUE_TABS], `row with status '${r.status}' tab`);
}
const summary = summarizeQueue(allRows);
check(summary.total === allRows.length, 'summary total disagrees with the row count');
check(summary.pending + summary.blocked + summary.decided === summary.total,
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
equal(trail.map((e) => e.step), ['draft_created', 'escalated', 'approved', 'sent'],
  'audit trail order and completeness');
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

run.deterministic(() => buildAuditTrail(fullRow), 'buildAuditTrail');

// ---------------------------------------------------------------------------
// Presentation helpers (no crashes, no invented data)
// ---------------------------------------------------------------------------

check(formatAmount(null) === '—', 'a null amount must render as an em dash, never as $0.00');
check(formatAmount(250000) === '$2,500.00', `formatAmount(250000)=${formatAmount(250000)}`);
check(recipientLine({ ...baseRow, to_addrs: [] }) === '—', 'no recipient must render as an em dash');
check(requesterLine({ ...baseRow, work_requests: null }) === '—', 'a message with no work request must not invent a requester');
check(/escalated/.test(escalationLine({ ...baseRow, escalated: true, escalation_reason: 'over limit' })),
  'escalation state is not surfaced');
run.includesAll([...BUSINESS_ROLES], requiredRoles(allRows), 'required approver roles outside the business-role vocabulary');

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

run.sameSet(enumValues(sql0015, 'outbound_message_status'), OUTBOUND_STATUSES,
  'OUTBOUND_STATUSES has drifted from the outbound_message_status enum in 0015');
run.sameSet(enumValues(sql0015, 'business_role'), BUSINESS_ROLES,
  'BUSINESS_ROLES has drifted from the business_role enum in 0015');
run.sameSet(enumValues(sql0015, 'outbound_message_type'), MESSAGE_TYPES,
  'MESSAGE_TYPES has drifted from the outbound_message_type enum in 0015');
equal(DECIDABLE_STATUSES, ['draft'],
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
// Source purity — the UI cannot send, cannot escalate privilege, holds no secret
// ---------------------------------------------------------------------------

const UI_PATHS = [
  'apps/web/src/lib/approval-queue.ts',
  'apps/web/src/app/approvals/page.tsx',
];

// Comments explain the boundaries, so purity is asserted against code only. The
// kernel's stripper is a state scanner, not a regex: a forbidden call hidden in
// a string literal still trips the lint, and a URL inside a string is not
// mistaken for a comment.
run.sourcePurity(
  UI_PATHS.map((p) => join(ROOT, p)),
  [
    { name: 'mark_message_sent', pattern: /mark_message_sent/, message: 'a send-marking call (B5 has no send action)' },
    { name: 'create_outbound_draft', pattern: /\bcreate_outbound_draft\b/, message: 'a draft-creation call (the queue only decides)' },
    { name: 'privileged credential', pattern: /service_role|SERVICE_ROLE|sb_secret_|SUPABASE_ACCESS_TOKEN/, message: 'a service-role or management credential' },
    { name: 'hard-coded JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}/, message: 'a hard-coded JWT' },
    { name: 'mail transport', pattern: /graph\.microsoft\.com|smtp|nodemailer|sendMail/i, message: 'mail transport machinery' },
    { name: 'direct outbound write', pattern: /\.from\(\s*['"]outbound_messages['"]\s*\)\s*\.(insert|update|delete|upsert)/, message: 'a direct write to outbound_messages' },
    { name: 'event-log read', pattern: /\.from\(\s*['"]integration_events['"]\s*\)/, message: 'a read of the service-role-only event log' },
  ],
  { label: 'queue UI purity' },
);

const uiCode = UI_PATHS.map((p) => stripComments(read(join(ROOT, p))));

// The queue may call exactly two RPCs, and no others.
const rpcCalls = [...uiCode.join('\n').matchAll(/\.rpc\(\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);
const allowedRpcs = ['record_approval', 'business_role_matches'];
for (const r of rpcCalls) {
  run.member(r, allowedRpcs, 'the queue calls an unexpected RPC');
}
check(rpcCalls.includes('record_approval'), 'the queue never calls record_approval — the approval gate is bypassed');

// The page must route every decision through planDecision: an .rpc('record_approval')
// that is not fed by a plan would skip every guard above.
const pageCode = uiCode[1];
check(/planDecision\(/.test(pageCode), 'the page does not call planDecision — guards are bypassable');
check(/plan\.rpc/.test(pageCode), 'the page does not pass the planned payload to record_approval');
check(/verifyDecisionApplied\(/.test(pageCode), 'the page does not verify the decision after refresh');

// ---------------------------------------------------------------------------

const report = run.summary({ fixtures: corpus.cases.length });

// Durable evidence: this run's own verdict, as a run-report artifact, through
// the same scaffolding every AWE workflow uses. `AWE_ARTIFACTS=off` opts out.
const persisted = await persistSuiteReport(report, { workflowId: 'approval_queue' });
if (persisted.skipped) console.log('run artifact: skipped (AWE_ARTIFACTS=off)');
else if (persisted.ok) console.log(`run artifact: ${persisted.ref} [${persisted.final_state}]`);
else console.log(`FAIL  run artifact was not written — ${persisted.error}`);

// A durable record that did not land is a failure of this run, not a warning:
// the report is the evidence. It cannot be counted in the summary above (it
// records that summary), so it is a hard gate on the exit code instead.
process.exit(run.exitCode || (persisted.skipped || persisted.ok ? 0 : 1));
