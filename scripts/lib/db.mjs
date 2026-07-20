// B2 persistence + deterministic Verify Step, over the Supabase management query
// API (same endpoint the migrations and eval-intake.sh already use). Only needs
// SUPABASE_ACCESS_TOKEN in the env — no service-role client, no SUPABASE_URL, no
// new dependency. All writes go through the same triggers as B1, so emergency
// invariants and event emission are enforced by the database, not this code.

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

export async function sql(query) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is not set (source .env.acceptance)');
  const res = await fetch(QUERY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Non-JSON DB response (${res.status}): ${text.slice(0, 300)}`); }
  if (!res.ok || (body && body.message && !Array.isArray(body))) {
    throw new Error(`DB error (${res.status}): ${body.message || text.slice(0, 300)}`);
  }
  return Array.isArray(body) ? body : [];
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
export async function verify(workRequestId, emailId, expected) {
  const rows = await sql(
    `select id, org_id, classification, status, urgency from work_requests where id = ${lit(workRequestId)}`
  );
  const row = rows[0] || null;
  const evRows = await sql(
    `select count(*)::int as n from integration_events
      where entity_id = ${lit(workRequestId)} and entity_type = 'work_request'
        and event_type = ${lit(expected.event)}`
  );
  const dupRows = await sql(
    `select count(*)::int as n from work_requests where email_message_id = ${lit(emailId)}`
  );
  const checks = {
    row_updated: !!row,
    values_match: !!row
      && row.classification === expected.classification
      && row.status === expected.status,
    org_scoped: !!row && row.org_id === org,
    event_present: (evRows[0]?.n ?? 0) >= 1,
    no_duplicate_side_effect: (dupRows[0]?.n ?? 0) === 1,
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}
