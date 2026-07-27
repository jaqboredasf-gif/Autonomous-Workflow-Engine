// ---------------------------------------------------------------------------
// validate-migration-0015.mjs — OFFLINE structural validation of
// supabase/migrations/0015_approval_matrix_outbound.sql (Task B3).
//
// This environment has no psql / supabase CLI / docker, so 0015 cannot be applied
// to a real Postgres here — and applying schema to the live Supabase project from
// an isolated session is a human-gated outward action (same posture as 0014, see
// docs/testing/APPROVAL_MATRIX.md). In the meantime this deterministic lint
// asserts the migration is additive, self-consistent, follows project
// conventions, and — the part that actually matters — that its routing rules and
// vocabularies are IDENTICAL to the offline engine Runner 4 evaluates.
//
// Usage: node scripts/lib/validate-migration-0015.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ROUTE_BLOCKED_REASONS, BUSINESS_ROLES, MESSAGE_TYPES,
} from './approval-matrix.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PATH = join(ROOT, 'supabase', 'migrations', '0015_approval_matrix_outbound.sql');
const sql = readFileSync(PATH, 'utf8');
const lower = sql.toLowerCase();
// Comments deliberately DOCUMENT the exclusions (Graph, send, n8n), so purity
// checks lint the non-comment lines only.
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

let fail = 0;
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`); if (!cond) fail++; };

// --- Additive only ----------------------------------------------------------
const destructive = lower.match(/\b(drop\s+(table|type|function|trigger|policy|index|column|schema)|truncate\b|alter\s+table\s+\w+\s+drop|delete\s+from)\b/g) || [];
check(destructive.length === 0, `additive-only: no destructive statements (found ${JSON.stringify(destructive)})`);

// --- Tables + conventions ---------------------------------------------------
for (const t of ['message_policies', 'outbound_messages']) {
  check(new RegExp(`create table ${t}\\b`).test(lower), `table ${t} created`);
  check(new RegExp(`create table ${t}[\\s\\S]*?org_id\\s+uuid not null references orgs`).test(lower), `${t} org-scoped to orgs`);
  check(new RegExp(`create table ${t}[\\s\\S]*?is_fixture\\s+boolean`).test(lower), `${t} has is_fixture boolean`);
  check(new RegExp(`create table ${t}[\\s\\S]*?created_at\\s+timestamptz`).test(lower), `${t} has created_at timestamptz`);
  check(new RegExp(`create table ${t}[\\s\\S]*?updated_at\\s+timestamptz`).test(lower), `${t} has updated_at timestamptz`);
  check(new RegExp(`alter table ${t} enable row level security`).test(lower), `${t} RLS enabled`);
  check(new RegExp(`on ${t}\\(`).test(lower), `${t} has at least one index`);
  check(new RegExp(`before delete on ${t}`).test(lower), `${t} blocks hard deletes`);
}

// FK targets must already exist (0001-0014) or be the new tables.
const known = new Set(['orgs', 'users', 'work_requests', 'message_policies', 'outbound_messages']);
const unknownFk = [...new Set([...lower.matchAll(/references\s+(\w+)/g)].map((m) => m[1]))]
  .filter((t) => !known.has(t));
check(unknownFk.length === 0, `FK targets all known (unknown: ${JSON.stringify(unknownFk)})`);

// --- Enums, in lockstep with the engine ------------------------------------
for (const e of ['outbound_message_type', 'message_mode', 'outbound_message_status', 'business_role']) {
  check(new RegExp(`create type ${e} as enum`).test(lower), `enum ${e} defined`);
}
const enumValues = (name) => {
  const m = lower.match(new RegExp(`create type ${name} as enum\\s*\\(([\\s\\S]*?)\\);`));
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
};
const sqlTypes = enumValues('outbound_message_type');
const sqlRoles = enumValues('business_role');
check(sqlTypes.length === MESSAGE_TYPES.length && MESSAGE_TYPES.every((t) => sqlTypes.includes(t)),
  `message-type vocabulary matches the engine (sql: ${sqlTypes.length}, engine: ${MESSAGE_TYPES.length})`);
check(sqlRoles.length === BUSINESS_ROLES.length && BUSINESS_ROLES.every((r) => sqlRoles.includes(r)),
  `business-role vocabulary matches the engine (sql: ${sqlRoles.length}, engine: ${BUSINESS_ROLES.length})`);
check(enumValues('outbound_message_status').includes('blocked'), 'status enum has an explicit blocked state');

// --- Routing parity: SQL route_outbound() vs scripts/lib/approval-matrix.mjs -
check(/create or replace function route_outbound/.test(lower), 'route_outbound() present');
const sqlReasons = [...new Set([...sql.matchAll(/'blocked_reason',\s*'([a-z_]+)'/g)].map((m) => m[1]))];
const missingInSql = ROUTE_BLOCKED_REASONS.filter((r) => !sqlReasons.includes(r));
const extraInSql = sqlReasons.filter((r) => !ROUTE_BLOCKED_REASONS.includes(r));
check(missingInSql.length === 0, `route reasons missing from SQL: ${JSON.stringify(missingInSql)}`);
check(extraInSql.length === 0, `SQL emits route reasons the engine does not know: ${JSON.stringify(extraInSql)}`);
check(/'effective_mode',\s*'draft'/.test(sql), "route_outbound() forces effective_mode='draft' (zero v1 auto-sends)");

// --- The approval gate ------------------------------------------------------
check(/constraint outbound_sent_requires_approval/.test(lower), 'sent requires a recorded approval (CHECK)');
check(/constraint outbound_sent_at_requires_approval/.test(lower), 'sent_at requires approved_at (CHECK)');
check(/constraint outbound_blocked_requires_reason/.test(lower), 'blocked rows must state a reason (CHECK)');
check(/constraint outbound_rejected_requires_reason/.test(lower), 'rejections must record who + why (CHECK)');
check(/constraint outbound_draft_has_no_decision/.test(lower), 'a draft cannot carry pre-filled decision fields (CHECK)');
check(/constraint message_policies_invoice_never_auto/.test(lower), 'final invoice can never be auto (CHECK)');
check(/constraint message_policies_auto_requires_limit/.test(lower), 'auto mode requires a configured approval limit (CHECK)');
check(/constraint message_policies_auto_requires_approver/.test(lower), 'auto mode requires a named approver (CHECK)');
check(/create or replace function guard_outbound_transition/.test(lower), 'status-transition guard present');
check(/illegal outbound_messages transition/.test(lower), 'transition guard raises on illegal transitions');
check(/content is frozen once it leaves draft/.test(lower), 'approved content is immutable (you approve what you read)');

// --- RPCs -------------------------------------------------------------------
for (const fn of ['create_outbound_draft', 'record_approval', 'mark_message_sent']) {
  check(new RegExp(`create or replace function ${fn}`).test(lower), `RPC ${fn}() present`);
}
check(/automation has no approval authority/.test(lower), 'record_approval() refuses an unauthenticated (automation) caller');
check(/only an approved message can be marked sent/.test(lower), 'mark_message_sent() refuses anything not approved');
check(/business_role_matches\(v_uid, m\.assigned_approver_role\)/.test(sql),
  'approval and send-marking both check the assigned approver role');

// --- Idempotency / duplicates ----------------------------------------------
check(/create unique index outbound_messages_draft_key_uidx/.test(lower), 'draft_key uniqueness (idempotent re-draft)');
check(/create unique index outbound_messages_active_uidx/.test(lower), 'one active draft per (request, type)');
check(/where status in \('draft', 'approved'\)/.test(lower), 'active-draft index excludes terminal rows');

// --- Events -----------------------------------------------------------------
for (const e of ['message.draft_created', 'message.approved', 'message.rejected',
  'message.sent', 'message.blocked', 'message.escalated']) {
  check(new RegExp(`emit_event\\('${e.replace('.', '\\.')}'`).test(sql), `emits ${e}`);
}

// --- Purity: no send / network machinery in the migration CODE -------------
check(!/\b(https?:\/\/|fetch\s*\(|smtp|nodemailer|n8n|webhook|subscription)\b/i.test(code),
  'no network/send machinery in code');
check(!/\bgraph\b/i.test(code), 'no Microsoft Graph machinery in code (graph_message_id column is inert evidence)');
check(/constraint outbound_no_graph_id_in_v1/.test(lower), 'graph_message_id cannot be populated without a human-marked send');

// --- Seed honesty -----------------------------------------------------------
const seedBlock = sql.slice(sql.indexOf('insert into message_policies'));
check(seedBlock.length > 0, 'matrix seed present');
const seededTypes = MESSAGE_TYPES.filter((t) => seedBlock.includes(`'${t}'`));
check(seededTypes.length === MESSAGE_TYPES.length,
  `seed covers every message type (missing: ${JSON.stringify(MESSAGE_TYPES.filter((t) => !seededTypes.includes(t)))})`);
check(!/'auto'::message_mode/.test(seedBlock) && !seedBlock.includes("'auto'"),
  'every seeded policy row is draft mode (zero v1 auto-sends)');
check(/on conflict \(org_id, message_type\) do nothing/.test(lower), 'seed is idempotent (re-runnable)');

// --- Structural sanity ------------------------------------------------------
check(((sql.match(/\$\$/g) || []).length % 2) === 0, 'balanced $$ function delimiters');
const opens = (sql.match(/\(/g) || []).length, closes = (sql.match(/\)/g) || []).length;
check(opens === closes, `balanced parentheses (${opens} open / ${closes} close)`);

console.log(`\nvalidate-migration-0015: ${fail === 0 ? 'PASS' : `FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
