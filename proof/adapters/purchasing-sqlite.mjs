// ---------------------------------------------------------------------------
// adapters/purchasing-sqlite.mjs — the read, separated from the reader.
//
// The SQL that turns a live purchasing database into execution records lives
// here rather than inside a command-line script, for one reason: a query that
// no test exercises is a query that silently returns nothing. Every measurement
// this system produces passes through these three statements, so they are worth
// a fixture.
//
// The caller supplies an OPEN, READ-ONLY database handle. This module never
// opens, closes, migrates or writes anything — which is also what lets the
// suite run it against a temporary database built from the real SCHEMA.
//
// TENANT SCOPE IS NOT OPTIONAL. Every statement filters on org_id, and orgId is
// a required argument. A reporting query that can cross a tenant boundary
// eventually does, and the resulting figure looks entirely plausible.
// ---------------------------------------------------------------------------

import { overheadTouches, toExecutionRecord } from './purchasing.mjs';

/**
 * @param {object} db      an open node:sqlite DatabaseSync, read-only
 * @param {object} spec
 * @param {string} spec.orgId
 * @param {string} spec.from        ISO instant, inclusive
 * @param {string} spec.to          ISO instant, exclusive
 * @param {string} spec.baselineId  which baseline these executions are measured against
 * @returns {{ records: Array, adminTouches: Array, requestsRead: number }}
 */
/**
 * What kind of installation wrote this database?
 *
 * `unstamped` for anything created before the stamp existed, or by an install
 * that did not declare itself. Never guessed from the data: a rehearsal is
 * built to look exactly like production, so the only honest answer comes from
 * something the installation said about itself at creation.
 */
export function environmentOf(db) {
  try {
    const row = db.prepare(`select value from schema_meta where key = 'environment'`).get();
    return row?.value ?? 'unstamped';
  } catch {
    return 'unstamped';
  }
}

export function readExecutions(db, { orgId, from, to, baselineId }) {
  if (!orgId) throw new Error('readExecutions needs an orgId — evidence is organization-bound');
  if (!from || !to) throw new Error('readExecutions needs a period');
  if (!baselineId) throw new Error('readExecutions needs the baseline these executions are measured against');

  // The period is decided by when the request was RAISED, matching the ledger's
  // stated boundary convention: an execution belongs to the period it started
  // in, so work spanning a month boundary is counted once and in one place.
  const requests = db.prepare(`
    select id, org_id, request_number, job_number, status, need_by_date, need_by_time,
           created_at, submitted_at, decided_at, ordered_at, received_at, completed_at,
           cancelled_at, rejection_reason
      from purchase_requests
     where org_id = ? and created_at >= ? and created_at < ?
     order by created_at
  `).all(orgId, from, to);

  // `interaction_id` is what makes counting human interactions exact rather
  // than inferred from timing — see ANCHOR_ACTIONS in ./purchasing.mjs. It is
  // selected defensively because a database written before schema 0040 does
  // not have the column, and an old database is still evidence.
  const hasInteractionId = db.prepare(
    `select count(*) as n from pragma_table_info('purchase_activity_log') where name = 'interaction_id'`
  ).get()?.n > 0;
  const activityFor = db.prepare(`
    select action, entity_type, actor_id, at, seq${hasInteractionId ? ', interaction_id' : ''}
      from purchase_activity_log
     where org_id = ? and request_id = ? order by at, seq
  `);

  // Ordered against received, per order line.
  //
  // LEFT JOIN with a coalesce to 0, and that is a claim rather than a
  // convenience: the receipt tables record every receipt, so a line with no
  // receipt row was genuinely not received. Absence here is evidence of
  // absence, which is exactly what it is not in most of this system — hence the
  // comment, so the next reader does not "fix" it into a null.
  const linesFor = db.prepare(`
    select oi.id,
           oi.order_qty as ordered_qty,
           coalesce(sum(ri.received_qty), 0) as received_qty
      from purchase_order_items oi
      join purchase_orders o on o.id = oi.purchase_order_id
      left join purchase_receipt_items ri on ri.purchase_order_item_id = oi.id
     where o.request_id = ?
     group by oi.id
  `);

  const records = requests.map((row) => {
    const request = camel(row);
    return toExecutionRecord({
      request,
      activity: activityFor.all(orgId, request.id).map(camel),
      lines: linesFor.all(request.id).map((l) => ({
        orderedQty: Number(l.ordered_qty ?? 0),
        receivedQty: Number(l.received_qty ?? 0),
      })),
      baselineId,
    });
  });

  // Administrative work in the period. A period cost, not a per-request one:
  // creating a vendor is setup for the whole organization, and billing it to
  // whichever purchase happened next would make one request look expensive and
  // every later one look cheap.
  const adminTouches = overheadTouches(db.prepare(`
    select action, actor_id, at, seq from purchase_activity_log
     where org_id = ? and at >= ? and at < ?
  `).all(orgId, from, to).map(camel));

  return { records, adminTouches, requestsRead: requests.length, environment: environmentOf(db) };
}

function camel(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}
