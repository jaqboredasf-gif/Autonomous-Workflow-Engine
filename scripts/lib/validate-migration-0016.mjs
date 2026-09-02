// Offline structural validation for 0016 (manual intake bridge).
//
// Same role as validate-migration-0014/0015: this migration cannot be applied
// from this environment, so the properties that make it SAFE are asserted
// against the SQL text instead of against a live database. It is a lint, not a
// substitute for applying it — it proves shape, never behavior.
//
// PURE OFFLINE: no keys, no DB, no network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sql = readFileSync(join(ROOT, 'supabase/migrations/0016_manual_intake_bridge.sql'), 'utf8');
const flat = sql.replace(/\s+/g, ' ');
// Assertions are about CODE, not the explanatory header.
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');

let pass = 0;
const fails = [];
const check = (cond, msg) => (cond ? pass++ : fails.push(msg));

// --- the three intake sources are named and closed -------------------------
check(/create type intake_source as enum \('graph', 'manual', 'fixture'\)/.test(flat),
  'intake_source enum is missing or does not name exactly graph/manual/fixture');

// --- provenance columns exist ----------------------------------------------
for (const col of ['source', 'manual_entered_by', 'source_reference', 'manual_client_key']) {
  check(new RegExp(`add column ${col}\\b`).test(flat), `email_messages.${col} is not added`);
}

// --- backfill leaves no null source before NOT NULL ------------------------
check(/update email_messages set source = case when is_fixture then 'fixture' else 'graph' end/.test(flat),
  'existing rows are not backfilled, so `set not null` would fail on apply');
check(flat.indexOf('update email_messages set source') < flat.indexOf('alter column source set not null'),
  'backfill must run BEFORE source is made NOT NULL');

// --- THE core safety property: a manual row cannot masquerade as email ------
const shape = flat.match(/add constraint email_messages_source_shape check \((.*?)\);/)?.[1] ?? '';
check(shape !== '', 'email_messages_source_shape constraint is missing');
check(/when 'manual' then[^]*?graph_message_id is null/.test(shape),
  'a manual row is not forced to have a NULL graph_message_id — it could masquerade as email');
check(/when 'manual' then[^]*?not is_fixture/.test(shape),
  'a manual row is not forced to be non-fixture — real customer data could be labelled synthetic');
check(/when 'manual' then[^]*?manual_entered_by is not null/.test(shape),
  'a manual row does not require an author — it would be an anonymous claim about the real world');
check(/when 'manual' then[^]*?source_reference is not null/.test(shape),
  'a manual row does not require its real-world origin');
check(/when 'graph' then[^]*?graph_message_id is not null/.test(shape),
  'a graph row no longer requires a graph_message_id — the old invariant was lost');
check(/when 'graph' then[^]*?manual_entered_by is null/.test(shape),
  'a graph row is not forced to have no manual author');

// --- the old constraint is actually removed, or the migration cannot apply --
check(/pg_get_constraintdef\(oid\) like '%graph_message_id%'/.test(flat),
  'the superseded check constraint is not located for removal');
check(/drop constraint %I/.test(flat), 'the superseded check constraint is never dropped');

// --- immutability now covers the new provenance columns --------------------
const guard = flat.match(/create or replace function guard_email_immutability\(\)(.*?)\$\$;/)?.[1] ?? '';
for (const col of ['source', 'manual_entered_by', 'source_reference', 'manual_client_key']) {
  check(new RegExp(`new\\.${col}\\s+is distinct from old\\.${col}`).test(guard),
    `guard_email_immutability does not protect ${col} — a manual row could be relabelled after the fact`);
}

// --- idempotency: a double-clicked form must not create two requests -------
check(/create unique index email_messages_manual_client_key_idx/.test(flat),
  'no unique index on the manual client key — duplicate submits would create duplicate requests');
check(/where manual_client_key is not null/.test(flat),
  'the client-key index is not partial, so existing NULL rows would collide');

// --- the RPC: authority stays server-side ----------------------------------
const fn = flat.match(/create or replace function create_manual_work_request\((.*?)\$\$;/)?.[1] ?? '';
check(fn !== '', 'create_manual_work_request is missing');
check(/security definer/.test(fn), 'create_manual_work_request is not SECURITY DEFINER');
check(/auth\.uid\(\)/.test(fn) && /requires an authenticated human/.test(fn),
  'the RPC does not require an authenticated human');
check(/current_role_is\('admin'\)/.test(fn), 'the RPC does not check the admin role');
check(/v_org uuid := current_org_id\(\)/.test(fn),
  'org is not taken from current_org_id() — the caller could choose another tenant');
check(!/p_org\b/.test(fn), 'the RPC accepts an org argument; tenant must never be client-supplied');
check(/'manual', v_uid/.test(fn), 'the RPC does not force source=manual with the caller as author');
check(/graph_message_id[^]*?null/.test(fn), 'the RPC does not explicitly write a NULL graph_message_id');
check(/false,\s*'manual'/.test(fn) || /is_fixture[^]*?false/.test(fn.replace(/\s+/g, ' ')),
  'the RPC does not force is_fixture = false');
check(/received_at cannot be in the future/.test(fn), 'the RPC does not reject a future received_at');
check(/manual_client_key = p_client_key/.test(fn), 'the RPC does not honour the idempotency key');

// --- no insert policy is opened on the intake tables ------------------------
check(!/create policy[^;]*on (email_messages|work_requests)[^;]*for insert/i.test(code),
  'an INSERT policy was opened on an intake table — the browser must not insert directly');

// --- nothing auto-sends or auto-drafts -------------------------------------
check(!/create_outbound_draft/.test(code),
  '0016 creates an outbound draft; manual intake must not trigger outbound anything');
check(!/mark_message_sent/.test(code), '0016 touches the send path');
check(/classification stays 'unknown'|classification/.test(sql),
  'the migration does not state what happens to classification');

// --- additive only: no data-destroying statements --------------------------
for (const [re, what] of [
  [/drop table/i, 'drop table'],
  [/drop column/i, 'drop column'],
  [/\bdelete from\b/i, 'delete from'],
  [/truncate/i, 'truncate'],
]) {
  check(!re.test(code), `0016 contains a destructive statement (${what})`);
}

if (fails.length) {
  console.error(`\n0016 validation: ${fails.length} FAILURE(S)`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`0016 structural validation: ${pass} checks passed`);
