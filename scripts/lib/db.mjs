// B2 persistence + deterministic Verify Step, over the Supabase management query
// API (same endpoint the migrations and eval-intake.sh already use). Only needs
// SUPABASE_ACCESS_TOKEN in the env — no service-role client, no SUPABASE_URL, no
// new dependency. All writes go through the same triggers as B1, so emergency
// invariants and event emission are enforced by the database, not this code.

import { defineVerify, runVerify } from '../../packages/awe-kernel/src/index.mjs';

const PROJECT_REF = 'qgoiacwdntaqeghcyjlw';
const ORG_ID = '2b219aa5-1148-4e3e-a1a0-1725d62b935c';
const QUERY_URL = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

export const org = ORG_ID;

// --- SQL literal helpers (single-quote escaping; the management API takes raw SQL) ---
function lit(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
function jsonb(obj) {
  return `${lit(JSON.stringify(obj ?? null))}::jsonb`;
}
function textArray(arr) {
  if (!arr || arr.length === 0) return `ARRAY[]::text[]`;
  return `ARRAY[${arr.map(lit).join(',')}]::text[]`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Supabase management query API rate-limits per minute. A full regression run
// puts several mgmt-heavy suites back to back (acceptance slice 4 alone issues
// ~60 queries), so a 429 here is a harness throttle, NOT a test result — retrying
// it is correct, and failing on it makes the suite report false negatives.
// Retries ONLY on 429/5xx; a real SQL error still fails immediately.
export async function sql(query, { retries = 5 } = {}) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is not set (source .env.acceptance)');

  let lastErr = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(QUERY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();

    if (res.status === 429 || res.status >= 500) {
      lastErr = `DB error (${res.status}): ${text.slice(0, 300)}`;
      if (attempt === retries) break;
      // Exponential backoff, capped. The mgmt-API window is per minute, so the
      // later waits are deliberately long enough to outlast it.
      await sleep(Math.min(2000 * 2 ** attempt, 30000));
      continue;
    }

    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`Non-JSON DB response (${res.status}): ${text.slice(0, 300)}`); }
    if (!res.ok || (body && body.message && !Array.isArray(body))) {
      throw new Error(`DB error (${res.status}): ${body.message || text.slice(0, 300)}`);
    }
    return Array.isArray(body) ? body : [];
  }
  throw new Error(`${lastErr} (after ${retries} retries)`);
}

// --- Deterministic tool results for the context packet (B1 functions) ---
export async function keywordNet(text) {
  const rows = await sql(`select is_emergency_text(${lit(text)}) as kw`);
  return rows[0]?.kw === true;
}
export async function territory(county, zip) {
  const rows = await sql(`select check_territory(${lit(org)}, ${lit(county)}, ${lit(zip)}) as t`);
  return rows[0]?.t ?? null;
}

// --- Idempotent fixture ingest: deterministic graph_message_id dedupes reruns ---
export async function ingestEmail(email, fixtureName) {
  const gid = `fixture:${fixtureName}`;
  const existing = await sql(
    `select id from email_messages where org_id = ${lit(org)} and graph_message_id = ${lit(gid)} limit 1`
  );
  if (existing[0]) return existing[0].id;
  const rows = await sql(
    `insert into email_messages
       (org_id, direction, mailbox, graph_message_id, from_addr, to_addrs,
        subject, body_text, attachments, raw, received_at, is_fixture)
     values (${lit(org)}, 'inbound', ${lit(email.mailbox || 'fixtures@local')}, ${lit(gid)},
        ${lit(email.from_addr)}, ${textArray(email.to_addrs)}, ${lit(email.subject)},
        ${lit(email.body_text)}, ${jsonb(email.attachments || [])}, ${jsonb(email.raw || email)},
        ${lit(email.received_at)}::timestamptz, true)
     returning id`
  );
  return rows[0].id;
}

export async function findWorkRequestByEmail(emailId) {
  const rows = await sql(
    `select id, org_id, status, classification from work_requests where email_message_id = ${lit(emailId)} limit 1`
  );
  return rows[0] || null;
}

// Earliest prior work_request from the same sender, for duplicate detection.
// Excludes the email being processed and anything already closed as duplicate.
// Scoped to the B2 fixture corpus (graph_message_id 'fixture:<name>') so the
// deterministic eval is isolated from accumulated slice/production rows and
// stays regression-safe. Production duplicate scoping (all real inbound from a
// sender) is wired later at the MCP/n8n boundary — see B2 known limitations.
export async function candidateOriginals(fromAddr, excludeEmailId) {
  return sql(
    `select wr.id, wr.created_at, em.body_text
       from work_requests wr join email_messages em on em.id = wr.email_message_id
      where wr.org_id = ${lit(org)} and em.from_addr = ${lit(fromAddr)}
        and em.graph_message_id like 'fixture:%'
        and wr.email_message_id <> ${lit(excludeEmailId)} and wr.status <> 'duplicate'
      order by wr.created_at asc`
  );
}

export async function writeClassification(emailId, existingId, c) {
  const sets = {
    classification: c.classification,
    confidence: c.confidence,
    classification_reasoning: c.reasoning,
    property_type: c.property_type,
    urgency: c.urgency,
    status: c.status,
    customer_name: c.customer_name,
    customer_email: c.customer_email,
    customer_phone: c.customer_phone,
    customer_address: c.customer_address,
    county: c.county,
    zip: c.zip,
    duplicate_of_work_request_id: c.duplicate_of,
  };
  if (existingId) {
    const assigns = Object.entries(sets).map(([k, v]) => `${k} = ${lit(v)}`);
    assigns.push(`territory_result = ${jsonb(c.territory_result)}`);
    const rows = await sql(
      `update work_requests set ${assigns.join(', ')} where id = ${lit(existingId)}
       returning id, org_id, classification, status, urgency, confidence, duplicate_of_work_request_id`
    );
    return rows[0];
  }
  const cols = Object.keys(sets).concat(['territory_result', 'org_id', 'email_message_id']);
  const vals = Object.values(sets).map(lit).concat([jsonb(c.territory_result), lit(org), lit(emailId)]);
  const rows = await sql(
    `insert into work_requests (${cols.join(', ')}) values (${vals.join(', ')})
     returning id, org_id, classification, status, urgency, confidence, duplicate_of_work_request_id`
  );
  return rows[0];
}

// Deterministic Verify Step: re-read the DB and confirm the write actually landed,
// belongs to the right org, emitted the expected event, and created no duplicate row.
//
// The checks are DECLARED (a kernel verify spec) and evaluated by
// @exattime/awe-kernel, not hand-coded here: the same spec can be evaluated
// against a recorded probe with no database, the check ids are stable, and a
// probe that throws is reported as a FAILED step rather than crashing the run —
// an unreachable database must never be mistaken for a verified write.
// Returned shape is `{ ok, checks, ... }`; `.verify.ok` and
// `.verify.checks.<id>` are what Runner 2A reads, and both are unchanged.
export const CLASSIFICATION_WRITE_BACK = defineVerify({
  name: 'classification.write_back',
  description: 'B2 write-back landed, in the right org, with its event, and no duplicate row.',
  sources: ['row', 'event_count', 'work_request_count'],
  checks: [
    { id: 'row_updated', kind: 'exists', source: 'row' },
    {
      id: 'values_match',
      kind: 'fields_equal',
      source: 'row',
      fields: { classification: { $ctx: 'classification' }, status: { $ctx: 'status' } },
    },
    { id: 'org_scoped', kind: 'equals', source: 'row', path: 'org_id', expectedPath: 'org' },
    { id: 'event_present', kind: 'count_at_least', source: 'event_count', expected: 1 },
    { id: 'no_duplicate_side_effect', kind: 'count_equals', source: 'work_request_count', expected: 1 },
  ],
});

export async function verify(workRequestId, emailId, expected) {
  const probe = async (source) => {
    switch (source) {
      case 'row': {
        const rows = await sql(
          `select id, org_id, classification, status, urgency from work_requests where id = ${lit(workRequestId)}`
        );
        return rows[0] || null;
      }
      case 'event_count':
        return sql(
          `select count(*)::int as n from integration_events
            where entity_id = ${lit(workRequestId)} and entity_type = 'work_request'
              and event_type = ${lit(expected.event)}`
        );
      case 'work_request_count':
        return sql(
          `select count(*)::int as n from work_requests where email_message_id = ${lit(emailId)}`
        );
      /* istanbul ignore next -- sources are fixed by the spec above */
      default:
        throw new Error(`unknown verify source '${source}'`);
    }
  };

  const result = await runVerify(CLASSIFICATION_WRITE_BACK, {
    probe,
    context: { classification: expected.classification, status: expected.status, org },
  });
  return { ok: result.ok, checks: result.checks, failures: result.failures, digest: result.digest };
}
