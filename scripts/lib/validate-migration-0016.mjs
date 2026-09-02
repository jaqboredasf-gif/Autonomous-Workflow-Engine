// Offline structural validation for 0016 (work_request becomes source-neutral).
//
// Same role as validate-migration-0014/0015: this migration cannot be applied
// from this environment, so the properties that make it SAFE are asserted
// against the SQL text. It is a lint, not a substitute for applying it — it
// proves shape, never behavior.
//
// PURE OFFLINE: no keys, no DB, no network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sql = readFileSync(join(ROOT, 'supabase/migrations/0016_manual_intake_bridge.sql'), 'utf8');
const flat = sql.replace(/\s+/g, ' ');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');

let pass = 0;
const fails = [];
const check = (c, m) => (c ? pass++ : fails.push(m));

// --- exactly two intake sources; no omni-channel framework -----------------
check(/create type request_source as enum \('email', 'manual'\)/.test(flat),
  'request_source must be an enum of exactly email and manual');

// --- email_messages MUST NOT be touched ------------------------------------
// The cleanest property of this design: every existing email invariant survives
// because the email table is not modified at all.
check(!/alter table email_messages/.test(code),
  '0016 alters email_messages — the source-neutral design must leave email invariants untouched');
check(!/drop constraint/.test(code),
  '0016 drops a constraint; nothing needs dropping in the source-neutral design');
check(!/is_fixture/.test(code), '0016 references is_fixture — manual data must never touch fixture semantics');
check(!/graph_message_id/.test(code), '0016 references graph_message_id — no email provenance may be fabricated');
check(!/from_addr/.test(code), '0016 references from_addr — no email address may be fabricated');

// --- the relationship becomes conditional ----------------------------------
check(/alter table work_requests alter column email_message_id drop not null/.test(flat),
  'email_message_id is not made nullable, so manual requests still cannot exist');
for (const col of ['source_type', 'entered_by', 'source_reference', 'intake_client_key', 'request_text']) {
  check(new RegExp(`add column ${col}\\b`).test(flat), `work_requests.${col} is not added`);
}
check(/source_type request_source not null default 'email'/.test(flat),
  "source_type must default to 'email' so existing rows stay valid");

// --- THE invariant: neither source can impersonate the other ---------------
const shape = flat.match(/add constraint work_requests_source_shape check \((.*?)\);/)?.[1] ?? '';
check(shape !== '', 'work_requests_source_shape constraint is missing');
check(/when 'email' then[^]*?email_message_id is not null/.test(shape),
  'an email request no longer requires an email_message — the original invariant was lost');
check(/when 'email' then[^]*?entered_by is null/.test(shape),
  'an email request is not forced to have no operator');
check(/when 'manual' then[^]*?email_message_id is null/.test(shape),
  'a manual request is not forced to have NO email_message — it could claim email provenance');
check(/when 'manual' then[^]*?entered_by is not null/.test(shape),
  'a manual request does not require an author — it would be an anonymous claim');
check(/when 'manual' then[^]*?source_reference is not null/.test(shape),
  'a manual request does not require its real-world origin');
check(/when 'manual' then[^]*?request_text is not null/.test(shape),
  'a manual request does not require the request text');

// --- request text must be readable by the product --------------------------
// integration_events is service-role-only, so a body stored only on the event
// could never be displayed. It must be on the row.
check(/add column request_text/.test(flat) && /request_text, customer_name/.test(flat),
  'request_text is not written to the row — the product could never display what the customer asked for');

// --- provenance is immutable ------------------------------------------------
const guard = flat.match(/create or replace function guard_work_request_provenance\(\)(.*?)\$\$;/)?.[1] ?? '';
check(guard !== '', 'no provenance immutability guard');
for (const col of ['source_type', 'email_message_id', 'entered_by', 'source_reference', 'intake_client_key', 'request_text', 'org_id']) {
  check(new RegExp(`new\\.${col}\\s+is distinct from old\\.${col}`).test(guard),
    `provenance guard does not protect ${col} — it could be relabelled after creation`);
}
check(/create trigger work_requests_provenance_immutability/.test(flat),
  'the provenance guard is never installed as a trigger');

// --- idempotency ------------------------------------------------------------
check(/create unique index work_requests_intake_client_key_idx/.test(flat),
  'no unique index on the intake client key — duplicate submits would duplicate requests');
check(/where intake_client_key is not null/.test(flat),
  'the client-key index is not partial, so existing NULL rows would collide');

// --- the governed write path ------------------------------------------------
const fn = flat.match(/create or replace function create_manual_work_request\((.*?)\$\$;/)?.[1] ?? '';
check(fn !== '', 'create_manual_work_request is missing');
check(/security definer/.test(fn), 'create_manual_work_request is not SECURITY DEFINER');
check(/auth\.uid\(\)/.test(fn) && /requires an authenticated human/.test(fn),
  'the RPC does not require an authenticated human');
check(/current_role_is\('admin'\)/.test(fn), 'the RPC does not check the business role');
check(/v_org uuid := current_org_id\(\)/.test(fn),
  'org is not taken from current_org_id() — the caller could choose another tenant');
check(!/p_org\b/.test(fn), 'the RPC accepts an org argument; tenant must never be client-supplied');
check(/'manual', null, v_uid/.test(fn),
  'the RPC does not force source_type=manual with a NULL email and the caller as author');
check(/received_at cannot be in the future/.test(fn), 'the RPC does not reject a future received_at');
check(/intake_client_key = p_client_key/.test(fn), 'the RPC does not honour the idempotency key');
check(/emit_event\('request\.manual_intake'/.test(fn),
  'the RPC emits no audit event — no existing trigger fires on an unclassified insert');
check(/classification stays 'unknown'/.test(sql),
  'the migration does not state that manual intake performs no classification');

// --- no broad INSERT policy -------------------------------------------------
check(!/create policy[^;]*for insert/i.test(code),
  'an INSERT policy was opened — the browser must not insert directly');

// --- nothing auto-sends or auto-drafts --------------------------------------
check(!/create_outbound_draft|mark_message_sent|record_approval/.test(code),
  '0016 touches the outbound or approval path; manual intake must not trigger either');

// --- additive only ----------------------------------------------------------
for (const [re, what] of [
  [/drop table/i, 'drop table'], [/drop column/i, 'drop column'],
  [/\bdelete from\b/i, 'delete from'], [/truncate/i, 'truncate'],
]) {
  check(!re.test(code), `0016 contains a destructive statement (${what})`);
}

if (fails.length) {
  console.error(`\n0016 validation: ${fails.length} FAILURE(S)`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`0016 structural validation: ${pass} checks passed`);
