// ---------------------------------------------------------------------------
// validate-migration-0016.mjs — OFFLINE structural validation of
// supabase/migrations/0016_m365_integration_plane.sql (Task I1).
//
// Same posture as the 0014 and 0015 lints: this environment has no psql /
// supabase CLI / docker, and applying schema to the live project is a
// human-gated outward action (AGENTS.md). Until a human applies it, this
// deterministic lint asserts the migration is additive, self-consistent,
// follows project conventions, and — the part that matters — that its
// vocabularies and constraints are IDENTICAL to the engine that Runner 6
// evaluates (packages/m365).
//
// Usage: node scripts/lib/validate-migration-0016.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DENIAL_REASONS, FAILURE_REASONS,
} from '../../packages/m365/src/contracts.ts';
import { CAPABILITY_NAMES } from '../../packages/m365/src/capabilities.ts';
import { NOTIFICATION_REJECTIONS } from '../../packages/m365/src/notifications.ts';
import { SUBSCRIPTION_STATES } from '../../packages/m365/src/subscriptions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PATH = join(ROOT, 'supabase', 'migrations', '0016_m365_integration_plane.sql');
const sql = readFileSync(PATH, 'utf8');
const lower = sql.toLowerCase();
// Comments deliberately DOCUMENT the exclusions (send, secrets, engine tables),
// so purity checks lint the non-comment lines only.
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const codeLower = code.toLowerCase();

let fail = 0;
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`); if (!cond) fail++; };
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// --- Additive only ----------------------------------------------------------

const destructive = codeLower.match(
  /\b(drop\s+(table|type|function|trigger|policy|index|column|schema)|truncate\b|alter\s+table\s+\w+\s+drop|delete\s+from)\b/g,
) || [];
check(destructive.length === 0, `additive-only: no destructive statements (found ${JSON.stringify(destructive)})`);

// --- Tables + conventions ---------------------------------------------------

const TABLES = ['m365_subscriptions', 'm365_notifications', 'm365_executions', 'm365_capability_invocations'];
for (const t of TABLES) {
  check(new RegExp(`create table ${t}\\b`).test(lower), `${t}: created`);
  check(new RegExp(`${t}[\\s\\S]{0,4000}?org_id\\s+uuid not null references orgs\\(id\\)`).test(lower),
    `${t}: org-scoped with an FK to orgs`);
  check(new RegExp(`alter table ${t} enable row level security`).test(lower), `${t}: RLS enabled`);
}

// Client write is impossible: no table gets an insert/update/delete policy.
check(!/for\s+(insert|update|delete)/i.test(code.replace(/before\s+(update|delete)/gi, '')),
  'no client insert/update/delete policy on any m365 table');

// Read policies exist only where an admin genuinely needs the audit view.
check(/create policy m365_executions_admin_read/.test(lower), 'm365_executions: admin read policy');
check(/create policy m365_invocations_admin_read/.test(lower), 'm365_capability_invocations: admin read policy');
check(!/create policy m365_subscriptions_\w*_read/.test(lower),
  'm365_subscriptions: service-role only (no client read policy)');
check(!/create policy m365_notifications_\w*_read/.test(lower),
  'm365_notifications: service-role only (no client read policy)');

// --- Idempotency indexes: the exactly-once guarantees ------------------------

check(/create unique index m365_notifications_delivery_uidx[\s\S]{0,200}on m365_notifications\(org_id, delivery_key\)/.test(lower),
  'notification delivery key is unique per tenant (at-least-once -> exactly-once)');
check(/create unique index m365_executions_delivery_uidx[\s\S]{0,200}on m365_executions\(org_id, delivery_key\)/.test(lower),
  'one execution per delivery');
check(/create unique index m365_invocations_idem_uidx[\s\S]{0,300}where outcome = 'succeeded'/.test(lower),
  'one successful invocation per idempotency key');
check(/create unique index m365_subscriptions_sub_uidx/.test(lower), 'one row per Graph subscription id');

// --- Vocabulary parity with the engine --------------------------------------

const listAfter = (anchor) => {
  const at = sql.indexOf(anchor);
  if (at < 0) return [];
  const open = sql.indexOf('(', at + anchor.length);
  const close = sql.indexOf(')', open);
  return [...sql.slice(open, close).matchAll(/'([a-z0-9_.]+)'/g)].map((m) => m[1]);
};

check(sameSet(listAfter('denial_reason          text'), DENIAL_REASONS),
  `denial_reason vocabulary == DENIAL_REASONS (${DENIAL_REASONS.length})`);
check(sameSet(listAfter('failure_reason         text'), FAILURE_REASONS),
  `failure_reason vocabulary == FAILURE_REASONS (${FAILURE_REASONS.length})`);
check(sameSet(listAfter('capability             text'), CAPABILITY_NAMES),
  `capability vocabulary == CAPABILITY_CATALOG (${CAPABILITY_NAMES.length})`);
check(sameSet(listAfter('rejection_reason     text'), NOTIFICATION_REJECTIONS),
  `rejection_reason vocabulary == NOTIFICATION_REJECTIONS (${NOTIFICATION_REJECTIONS.length})`);

const stateEnum = /create type m365_subscription_state as enum\s*\(([^)]*)\)/.exec(sql);
const sqlStates = [...(stateEnum?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
check(sameSet(sqlStates, SUBSCRIPTION_STATES), `subscription state enum == SUBSCRIPTION_STATES (${SUBSCRIPTION_STATES.length})`);

// --- The safety constraints -------------------------------------------------

check(/m365_sub_client_state_is_hash[\s\S]{0,200}\[0-9a-f\]\{64\}/.test(sql),
  'clientState is stored as a sha256 hash, never in the clear');
check(/m365_inv_denied_has_reason/.test(sql), 'a denied invocation must name its reason');
check(/m365_inv_failed_has_reason/.test(sql), 'a failed invocation must name its reason');
check(/m365_inv_success_is_clean/.test(sql), 'a successful invocation carries no refusal reason');
check(/m365_inv_denied_made_no_attempt/.test(sql), 'a denial cannot claim a provider attempt');
check(/m365_inv_hashes_are_sha256/.test(sql), 'evidence hashes are shape-checked');
check(/m365_notif_accepted_has_key/.test(sql), 'an accepted notification names its delivery and execution');
check(/m365_notif_rejected_has_reason/.test(sql), 'a refused notification names its reason');

// --- Append-only evidence ---------------------------------------------------

check(/guard_m365_evidence_immutability/.test(lower), 'evidence immutability guard exists');
check(/create trigger m365_invocations_no_update[\s\S]{0,200}before update on m365_capability_invocations/.test(lower),
  'evidence rows cannot be updated');
check(/create trigger m365_invocations_no_delete[\s\S]{0,200}before delete on m365_capability_invocations/.test(lower),
  'evidence rows cannot be deleted');

// --- Event spine ------------------------------------------------------------

for (const ev of ['m365.notification.accepted', 'm365.notification.rejected',
  'm365.capability.invoked', 'm365.capability.denied', 'm365.capability.failed']) {
  check(sql.includes(`'${ev}'`), `emits ${ev}`);
}
check(/perform emit_event\(/.test(lower), 'uses the shared emit_event spine (0009)');

// --- Purity: nothing here can describe, store or enable a send --------------

check(!/mail\.send|sendmail/i.test(code), 'no send vocabulary in the schema');
check(!/\bsent_at\b|\bstatus[\s\S]{0,40}'sent'/i.test(code), 'no sent state exists in this schema');
check(!/client_secret|access_token|refresh_token|bearer/i.test(code), 'no credential column of any kind');
// No generic engine tables (DECISION_LOG 2026-07-17).
check(!/create table (workflow_definitions|workflow_runs|agent_runs|tool_calls)\b/i.test(codeLower),
  'no generic workflow-engine tables');

// --- Ordering / dependencies ------------------------------------------------

check(sql.indexOf('create type m365_subscription_state') < sql.indexOf('create table m365_subscriptions'),
  'enums are declared before the tables that use them');
check(/references work_requests\(id\)/.test(lower),
  'an execution can point at the work_request that is its objective');
check(/touch_m365_updated_at/.test(lower), 'updated_at maintenance is defined locally (0012 dropped the shared one)');

console.log(`\nvalidate-migration-0016: ${fail === 0 ? 'PASS' : `${fail} FAILURES`}`);
process.exit(fail === 0 ? 0 : 1);
