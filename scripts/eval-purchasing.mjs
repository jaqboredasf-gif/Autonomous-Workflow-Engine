// ---------------------------------------------------------------------------
// eval-purchasing.mjs — assertion harness for the Purchasing Control Center.
//
// PURE OFFLINE. No API keys, no model calls, no network, no Supabase, no
// browser. It drives the SAME modules the app ships (Node 24 strips the types
// on import) against a throwaway SQLite file, and asserts, as hard gates:
//
//   * intake rules       — job number, need-by date AND time, multi-line,
//                          one job number per request
//   * the field firewall — a requestor's payload cannot carry vendor, price,
//                          stock or purchasing quantity, and the attempt is
//                          recorded
//   * authorization      — requestor cannot approve; office cannot approve
//                          without the grant; office WITH the grant can; Rick
//                          approves as the authorized backup
//   * BR-011             — approval authority supersedes requester identity: a
//                          purchaser decides his own request and a colleague's,
//                          a request-only user decides neither, and the audit
//                          row names requester, approver, and which was which
//   * quantity algebra   — suggested = approved - stock, never negative, the
//                          override sticks, and the requested quantity is
//                          unchanged by everything the workshop does
//   * the state machine  — no PO without approval, none after rejection, no
//                          vendor email without a PO, no receipt without
//                          receiving information, no completion with lines open
//   * PO numbering       — unique, permanent, and duplicate-free under REAL
//                          concurrency (8 worker threads on one database file)
//   * email              — draft-only, external send disabled, review before
//                          "sent", and the draft is frozen once reviewed
//   * receiving          — partial receipts, the over-receipt guard, and the
//                          explicit override
//   * BR-014             — receipt authority follows capability and scope: a
//                          purchaser receives the order he raised AND approved,
//                          a request-only user is refused server-side, a foreman
//                          is refused off his sites, and every receipt records
//                          its own receiver, date, quantities and exceptions
//   * audit              — every meaningful action appears on the timeline
//   * tenancy            — another org's request is not found, not forbidden
//   * the §16 demo       — the whole scenario, end to end, in order
//
// Exit 0 iff every gate passes. Invoked by scripts/eval-purchasing.sh.
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = join(ROOT, 'apps', 'purchasing', 'src');

const { openDatabase } = await import(join(APP, 'purchasing', 'infrastructure', 'sqlite', 'database.ts'));
const { seed, DEMO_ORG_ID } = await import(join(APP, 'purchasing', 'infrastructure', 'seed.ts'));
const S = await import(join(APP, 'server', 'service.ts'));
const { suggestedOrderQty, parseQty, formatQty, formatMoney, lineTotalCents, receiptGuard } =
  await import(join(APP, 'purchasing', 'domain', 'numbers.mjs'));
const { REQUEST_STATUSES, TRANSITIONS, GUARD_REASONS, transitionGuard } =
  await import(join(APP, 'purchasing', 'domain', 'status.mjs'));
const { PERMISSIONS, ROLES, authorize, permissionsFor } = await import(join(APP, 'purchasing', 'domain', 'roles.mjs'));
const { validateRequestDraft } = await import(join(APP, 'purchasing', 'domain', 'validation.mjs'));
const { EXTERNAL_SEND_ENABLED, EMAIL_TEMPLATE_TYPES, EMAIL_DRAFT_STATUSES } =
  await import(join(APP, 'purchasing', 'domain', 'email.mjs'));
const { ACTIVITY_ACTIONS, NOTIFICATION_EVENTS, buildTimeline } = await import(join(APP, 'purchasing', 'domain', 'activity.mjs'));
const {
  HISTORY_LINE_FIELDS, HISTORY_TERMINAL_STATES, RECEIPT_OUTCOMES,
  countsTowardPricing, countsTowardPurchaseFrequency, leadTimeDays, summarizeByMaterial,
} = await import(join(APP, 'purchasing', 'domain', 'history.mjs'));
const { summarize, isOverdue, attentionBand, attentionQueue } =
  await import(join(APP, 'purchasing', 'domain', 'dashboard.mjs'));
const { parsePoNumber } = await import(join(APP, 'purchasing', 'organization', 'po-numbering.mjs'));
// The directory use cases are not on the server facade — the screens call them
// directly — so the harness does too.
const ADMIN = await import(join(APP, 'purchasing', 'application', 'administration.ts'));

// --- harness plumbing -------------------------------------------------------

let pass = 0;
let fail = 0;
const failures = [];
const ok = () => { pass++; };
const bad = (m) => { failures.push(m); console.log(`FAIL  ${m}`); fail++; };
const check = (cond, m) => (cond ? ok() : bad(m));
const eq = (actual, expected, m) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), `${m} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);

/**
 * Assert that `fn` rejects with a ServiceError whose reason is `reason`.
 * Awaited, because the use cases are async now: a refusal that arrives as a
 * rejected promise nobody awaited is a passing test and a broken application.
 */
async function refuses(fn, reason, m) {
  try {
    await fn();
    bad(`${m} — expected refusal (${reason}) but it succeeded`);
  } catch (err) {
    if (err?.reason === reason) ok();
    else bad(`${m} — expected reason ${reason}, got ${err?.reason ?? err?.message}`);
  }
}

/** Assert that `fn` fails at all, with a message matching `pattern`. */
async function throws(fn, pattern, m) {
  try {
    await fn();
    bad(`${m} — expected a failure but it succeeded`);
  } catch (err) {
    if (pattern.test(String(err?.message ?? err))) ok();
    else bad(`${m} — wrong error: ${err?.message ?? err}`);
  }
}

const TMP = mkdtempSync(join(tmpdir(), 'purchasing-eval-'));
const dbPath = join(TMP, 'eval.db');

let clock = Date.parse('2026-08-03T13:00:00Z');
const tick = () => new Date((clock += 60_000)).toISOString();

const db = openDatabase(dbPath);
seed(db, new Date(clock).toISOString());

// PROVIDER UNDER TEST. `local` resolves in the same tick; `deferred` wraps the
// same repositories so every call settles on a later macrotask, which is what
// a remote provider does and what catches a missing `await`.
const PROVIDER = process.env.PURCHASING_TEST_PROVIDER ?? 'local';
const { deferContext } = await import(join(ROOT, 'scripts', 'lib', 'deferred-provider.mjs'));

let deferredCalls = () => 0;
const ctx = () => {
  const base = S.context(db, tick());
  if (PROVIDER !== 'deferred') return base;
  const wrapped = deferContext(base);
  deferredCalls = wrapped.calls;
  return wrapped.context;
};
console.log(`provider under test: ${PROVIDER}`);

const users = Object.fromEntries(
  await Promise.all(
    db.prepare('select id, email from users').all()
      .map(async (u) => [u.email.split('@')[0], await S.loadActor(db, u.id)]),
  ),
);
const mike = users.mike;
const rick = users.rick;
const foreman = users.dave;
const office = users.karen;
const officeApprover = users.tom;
const admin = users.admin;

const locations = await S.listDeliveryLocations(ctx(), foreman);
const jobsite = locations.find((l) => l.kind === 'JOBSITE');
const vendors = await S.listVendors(ctx(), mike);
const graybar = vendors.find((v) => v.name.startsWith('Graybar'));

console.log('--- vocabulary + parity ---------------------------------------');

eq(REQUEST_STATUSES.length, 14, 'the status model has all 14 states');
check(
  ['DRAFT', 'SUBMITTED', 'PENDING_WORKSHOP_REVIEW', 'CLARIFICATION_REQUESTED', 'RESUBMITTED', 'REJECTED',
   'APPROVED', 'PO_GENERATED', 'EMAIL_DRAFTED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'COMPLETED',
   'CANCELLED'].every((s) => REQUEST_STATUSES.includes(s)),
  'every status named in the spec exists',
);
check(Object.keys(TRANSITIONS).length === REQUEST_STATUSES.length, 'every status has a transition list');
check(
  Object.values(TRANSITIONS).flat().every((s) => REQUEST_STATUSES.includes(s)),
  'no transition targets an unknown status',
);
eq(ROLES, ['REQUESTOR', 'FOREMAN', 'OFFICE', 'ACCOUNTING', 'WORKSHOP_APPROVER', 'ADMIN'],
   'every role the website routes by exists');
check(EMAIL_TEMPLATE_TYPES.length === 6, 'all six email templates exist');
check(EMAIL_DRAFT_STATUSES.length === 6, 'all six draft statuses exist');
check(EXTERNAL_SEND_ENABLED === false, 'external sending is disabled at the source');

console.log('--- intake validation ------------------------------------------');

const baseDraft = {
  jobNumber: '24-118',
  needByDate: '2026-08-07',
  needByTime: '07:00',
  deliveryLocationId: jobsite.id,
  deliveryMethod: 'DELIVERY',
  reason: 'Fixture rough-in on the second floor.',
  items: [{ description: '2x4 LED troffer, 4000K', qty: '20', unit: 'ea' }],
};

check(validateRequestDraft(baseDraft).ok, 'a complete draft validates');
check(
  validateRequestDraft({ ...baseDraft, jobNumber: '' }).errors.some((e) => e.code === 'job_number_required'),
  'a job number is required',
);
check(
  validateRequestDraft({ ...baseDraft, needByDate: '' }).errors.some((e) => e.code === 'need_by_date_required'),
  'a need-by date is required',
);
check(
  validateRequestDraft({ ...baseDraft, needByTime: '' }).errors.some((e) => e.code === 'need_by_time_required'),
  'a need-by time is required',
);
check(
  validateRequestDraft({ ...baseDraft, needByTime: '25:00' }).errors.some((e) => e.code === 'need_by_time_invalid'),
  'a bogus need-by time is rejected',
);
check(
  validateRequestDraft({
    ...baseDraft,
    items: [{ description: 'a', qty: '1', unit: 'ea' }, { description: 'b', qty: '2', unit: 'ft', jobNumber: '24-999' }],
  }).errors.some((e) => e.code === 'multiple_job_numbers'),
  'a request may not carry two job numbers',
);
check(
  validateRequestDraft({ ...baseDraft, items: [] }).errors.some((e) => e.code === 'items_required'),
  'a request needs at least one item',
);
check(
  validateRequestDraft({ ...baseDraft, items: [{ description: 'x', qty: '0', unit: 'ea' }] })
    .errors.some((e) => e.code === 'item_quantity_invalid'),
  'a zero quantity is rejected',
);
check(
  validateRequestDraft({
    ...baseDraft,
    items: [{ description: 'a', qty: '1', unit: 'ea' }, { description: 'b', qty: '2.5', unit: 'ft' }],
  }).ok,
  'multiple line items are accepted',
);

console.log('--- the field firewall -----------------------------------------');

const created = await S.createRequest(ctx(), foreman, {
  ...baseDraft,
  // Everything below is a purchasing decision. The requestor must not be able
  // to set any of it, even by hand-crafting the payload.
  vendor_id: graybar.id,
  estimated_unit_cost_cents: 1,
  usable_stock_qty: 99,
  final_order_qty: 500,
  priority: 'Emergency',
  items: [{ description: '2x4 LED troffer, 4000K', qty: '20', unit: 'ea', estimated_unit_cost_cents: 4200 }],
});
check(created.rejectedFields.length >= 5, 'purchasing fields sent by a requestor are stripped');
check(created.rejectedFields.includes('priority'), 'the removed Priority field is refused');
const afterIntake = db.prepare('select * from purchase_requests where id = ?').get(created.id);
check(afterIntake.vendor_id === null, 'no vendor reached the stored request');
check(afterIntake.estimated_total_cents === 0, 'no cost reached the stored request');
check(
  db.prepare("select count(*) c from purchase_activity_log where request_id = ? and action = 'validation.rejected_fields'")
    .get(created.id).c === 1,
  'the stripped fields are recorded in the activity log',
);

console.log('--- submission + queue -----------------------------------------');

await S.submitRequest(ctx(), foreman, created.id);
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status,
   'PENDING_WORKSHOP_REVIEW', 'a submitted request enters the workshop queue');

await refuses(
  async () => S.submitRequest(ctx(), foreman, created.id),
  'request_locked',
  'a requestor cannot touch a request once the workshop owns it',
);
await refuses(async () => S.approvalQueue(ctx(), foreman), 'missing_permission', 'a requestor cannot open the approval queue');
check((await S.approvalQueue(ctx(), mike)).some((r) => r.id === created.id), "Mike's queue contains the request");
check((await S.approvalQueue(ctx(), rick)).some((r) => r.id === created.id), "Rick's queue contains the request too");

console.log('--- requestor cannot make purchasing decisions ------------------');

await refuses(
  async () => S.saveReview(ctx(), foreman, created.id, { lines: [] }),
  'missing_permission',
  'a requestor cannot record workshop stock',
);
await refuses(
  async () => S.decide(ctx(), foreman, created.id, 'APPROVE'),
  'missing_permission',
  'a requestor cannot approve a request',
);
await refuses(
  async () => S.decide(ctx(), office, created.id, 'APPROVE'),
  'missing_permission',
  'an office user without the grant cannot approve',
);
check(
  permissionsFor(officeApprover).includes('review.decide'),
  'an office user WITH the approval grant carries review.decide',
);
await refuses(
  async () => S.generatePurchaseOrder(ctx(), foreman, created.id),
  'missing_permission',
  'a requestor cannot generate a purchase order',
);

console.log('--- workshop review: the quantity algebra ----------------------');

eq(suggestedOrderQty(20_000, 6_000), 14_000, 'suggested = approved - stock');
eq(suggestedOrderQty(6_000, 20_000), 0, 'the suggestion never goes negative');
eq(suggestedOrderQty(0, 0), 0, 'nothing needed, nothing suggested');

const item = (await S.getRequestDetail(ctx(), mike, created.id)).originalItems[0];
await S.saveReview(ctx(), mike, created.id, {
  workshopNotes: 'Six on the shelf; taking four extra for stock.',
  lines: [{
    requestItemId: item.id,
    usableStock: '6',
    approvedQty: '20',
    finalOrderQty: '18',
    vendorId: graybar.id,
    estimatedUnitCost: '86.40',
    overrideReason: 'four spare fixtures back into workshop stock',
  }],
});

const reviewed = await S.getRequestDetail(ctx(), mike, created.id);
const line = reviewed.reviewLines[0];
eq(line.requestedQty, 20_000, 'the requested quantity is untouched by the review');
eq(line.usableStockQty, 6_000, 'Mike can record workshop stock');
eq(line.suggestedOrderQty, 14_000, 'the system suggests 14');
eq(line.finalOrderQty, 18_000, 'Mike overrides the suggestion to 18');
eq(line.replenishmentQty, 4_000, 'the four extra are recorded as replenishment, not as job need');
eq(line.stockAppliedQty, 6_000, 'six units come off the shelf for the job');
eq(line.estimatedUnitCostCents, 8_640, 'the unit cost is stored in cents');
eq(line.estimatedLineTotalCents, lineTotalCents(8_640, 18_000), 'the line total is calculated');
eq(line.estimatedLineTotalCents, 155_520, '18 x $86.40 = $1,555.20');
eq(formatMoney(line.estimatedLineTotalCents), '$1,555.20', 'money formats exactly');
eq(reviewed.originalItems[0].requestedQty, 20_000, 'Section A still shows what the field asked for');

console.log('--- decisions --------------------------------------------------');

await refuses(
  async () => S.generatePurchaseOrder(ctx(), mike, created.id),
  'po_before_approval',
  'an unapproved request cannot produce a purchase order',
);

await S.decide(ctx(), mike, created.id, 'APPROVE', { notes: 'Ordering 18 to leave four on the shelf.' });
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'APPROVED', 'Mike approves');
check(
  db.prepare("select changes_json from purchase_approvals where request_id = ?").get(created.id).changes_json.includes('18000'),
  'the approval freezes what changed relative to the original request',
);
check(
  db.prepare("select count(*) c from inventory_adjustments where request_id = ? and reason = 'STOCK_APPLIED'").get(created.id).c === 1,
  'stock taken off the shelf creates an auditable inventory adjustment',
);
check(
  db.prepare("select count(*) c from inventory_observations where request_id = ?").get(created.id).c >= 1,
  'the observed stock reading is preserved with the request',
);

console.log('--- purchase order ---------------------------------------------');

const po = await S.generatePurchaseOrder(ctx(), mike, created.id);
// Job + vendor + a sequence that counts from 1 for that pair. This is the
// FIRST order for job 24-118 to Graybar, so it is number 1.
eq(po.poNumber, `24-118-${graybar.code}-1`, `the PO number is job-vendor-sequence (${po.poNumber})`);
const poRow = db.prepare('select * from purchase_orders where request_id = ?').get(created.id);
eq(Number(poRow.estimated_total_cents), 155_520, 'the PO carries the estimated total');
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'PO_GENERATED', 'the request moves to PO_GENERATED');

const doc = db.prepare('select * from purchase_order_documents where purchase_order_id = ?').get(poRow.id);
check(Boolean(doc), 'a document is stored with the purchase order');
const pdfBytes = Buffer.from(doc.data_base64, 'base64');
check(pdfBytes.subarray(0, 5).toString() === '%PDF-', 'the stored document is a real PDF');
check(pdfBytes.includes(Buffer.from(po.poNumber)), 'the PDF contains the PO number');
check(pdfBytes.includes(Buffer.from('24-118')), 'the PDF contains the job number');
check(pdfBytes.includes(Buffer.from('Graybar')), 'the PDF contains the vendor');
check(pdfBytes.includes(Buffer.from('$1,555.20')), 'the PDF contains the total');
check(doc.sha256.length === 64, 'the document is hashed for evidence');
writeFileSync(join(TMP, 'sample-po.pdf'), pdfBytes);

const regenerated = await S.generatePurchaseOrder(ctx(), mike, created.id);
eq(regenerated.poNumber, po.poNumber, 'regenerating returns the same permanent PO number');
eq(
  Number(db.prepare('select next_value from po_job_vendor_sequences where org_id = ? and job_number = ? and vendor_id = ?')
    .get(DEMO_ORG_ID, '24-118', graybar.id).next_value),
  2,
  'a reused PO does not burn a sequence number',
);

console.log('--- vendor email draft -----------------------------------------');

const draft = await S.generateVendorEmailDraft(ctx(), mike, created.id);
const draftRow = db.prepare('select * from purchase_email_drafts where id = ?').get(draft.id);
eq(draftRow.status, 'GENERATED', 'the draft starts as GENERATED');
eq(Number(draftRow.external_send_enabled), 0, 'the draft records that sending is disabled');
check(draftRow.subject.includes(po.poNumber), 'the subject carries the PO number');
check(draftRow.body.includes('24-118'), 'the body carries the job number');
check(draftRow.body.includes('2026-08-07'), 'the body carries the need-by date');
check(draftRow.body.includes('07:00'), 'the body carries the need-by time');
check(JSON.parse(draftRow.attachments)[0].filename === `${po.poNumber}.pdf`, 'the PO PDF is attached');
check(JSON.parse(draftRow.to_addrs)[0].endsWith('@example.invalid'), 'the recipient is a fixture address');
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'EMAIL_DRAFTED', 'the request moves to EMAIL_DRAFTED');

await refuses(
  async () => S.advanceEmailDraft(ctx(), mike, draft.id, 'SENT'),
  'illegal_transition',
  'a draft cannot jump straight to sent',
);
await S.advanceEmailDraft(ctx(), mike, draft.id, 'REVIEWED');
await refuses(
  async () => S.updateEmailDraft(ctx(), mike, draft.id, { body: 'rewritten after review' }),
  'draft_frozen',
  'a reviewed draft is frozen — the review refers to those words',
);
await S.advanceEmailDraft(ctx(), mike, draft.id, 'APPROVED_TO_SEND');
await S.advanceEmailDraft(ctx(), mike, draft.id, 'SENT');
eq(db.prepare('select status from purchase_email_drafts where id = ?').get(draft.id).status, 'SENT',
   'a human can record that they sent it themselves');

console.log('--- ordering, tracking, receiving ------------------------------');

await S.markOrdered(ctx(), mike, created.id, { notes: 'Called it in to the counter.' });
await S.updateTracking(ctx(), office, created.id, { trackingNumber: '1Z999AA10123456784', carrier: 'UPS', expectedArrivalDate: '2026-08-06' });
eq(db.prepare('select tracking_number from purchase_requests where id = ?').get(created.id).tracking_number,
   '1Z999AA10123456784', 'office can add tracking');

const poItem = db.prepare('select * from purchase_order_items where purchase_order_id = ?').get(poRow.id);

await refuses(
  async () => S.recordReceipt(ctx(), mike, created.id, {
    receivedDate: '2026-08-05',
    lines: [{ purchaseOrderItemId: poItem.id, receivedQty: '19' }],
  }),
  'over_receipt',
  'receiving more than was ordered needs an explicit override',
);

const partial = await S.recordReceipt(ctx(), mike, created.id, {
  receivedDate: '2026-08-05',
  packingSlipNumber: 'PS-88213',
  lines: [{ purchaseOrderItemId: poItem.id, receivedQty: '12' }],
});
eq(partial.outstandingLines, 1, 'a partial receipt leaves the line outstanding');
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'PARTIALLY_RECEIVED',
   'the request moves to PARTIALLY_RECEIVED');

await refuses(
  async () => S.completeRequest(ctx(), mike, created.id),
  'illegal_transition',
  'a partially received request cannot be completed',
);

const final = await S.recordReceipt(ctx(), mike, created.id, {
  receivedDate: '2026-08-06',
  packingSlipNumber: 'PS-88377',
  lines: [{ purchaseOrderItemId: poItem.id, receivedQty: '6' }],
});
eq(final.outstandingLines, 0, 'the remaining quantity closes the line');
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'RECEIVED',
   'the request moves to RECEIVED');
check(
  db.prepare("select count(*) c from purchase_notifications where request_id = ? and event = 'purchase_material.ready_for_pickup'")
    .get(created.id).c > 0,
  'the requestor is notified that the material is ready',
);

await S.completeRequest(ctx(), mike, created.id, 'Foreman collected the balance.');
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'COMPLETED', 'the request completes');

console.log('--- over-receipt override --------------------------------------');

eq(receiptGuard({ orderedQty: 18_000, alreadyReceivedQty: 0, incomingQty: 19_000 }).reason, 'over_receipt',
   'over-receipt is refused by default');
check(receiptGuard({ orderedQty: 18_000, alreadyReceivedQty: 0, incomingQty: 19_000, override: true }).ok,
      'an explicit override accepts a small over-receipt');
eq(receiptGuard({ orderedQty: 18_000, alreadyReceivedQty: 0, incomingQty: 100_000, override: true }).reason,
   'over_receipt_hard_limit', 'even an override refuses an obvious data-entry error');

console.log('--- activity timeline ------------------------------------------');

const detail = await S.getRequestDetail(ctx(), mike, created.id);
const actions = detail.timeline.map((t) => t.action);
for (const required of [
  'request.created', 'request.submitted', 'review.stock_recorded', 'review.saved', 'decision.approved',
  'po.generated', 'po.document_generated', 'email.draft_generated', 'email.draft_reviewed', 'email.marked_sent',
  'order.placed', 'order.tracking_updated', 'receipt.partial', 'receipt.completed', 'inventory.adjusted',
  'request.completed',
]) {
  check(actions.includes(required), `the timeline records ${required}`);
}
check(actions.every((a) => ACTIVITY_ACTIONS.includes(a)), 'every recorded action is in the closed vocabulary');
const timeline = buildTimeline(detail.timeline);
check(timeline.every((t) => typeof t.description === 'string' && t.description.length > 0),
      'every timeline row renders a human sentence');
check(
  timeline.every((t, i) => i === 0 || timeline[i - 1].at < t.at || (timeline[i - 1].at === t.at && timeline[i - 1].seq <= t.seq)),
  'the timeline is ordered',
);
check(
  timeline.some((t) => t.action === 'decision.approved' && Array.isArray(t.changes)),
  'timeline rows expose their recorded field changes',
);
check(detail.timeline.every((t) => t.actorName), 'every action is attributed to a person');

console.log('--- rejection path ---------------------------------------------');

const rejected = await S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'Second run of fixtures.' });
await S.submitRequest(ctx(), foreman, rejected.id);
await refuses(
  async () => S.decide(ctx(), mike, rejected.id, 'REJECT'),
  'reason_required',
  'a rejection must record a reason',
);
await S.saveReview(ctx(), mike, rejected.id, {
  lines: [{
    requestItemId: (await S.getRequestDetail(ctx(), mike, rejected.id)).originalItems[0].id,
    usableStock: '25', approvedQty: '20', finalOrderQty: '0',
  }],
});
await S.decide(ctx(), mike, rejected.id, 'REJECT', { reason: 'Twenty-five already on the shelf.' });
await refuses(
  async () => S.generatePurchaseOrder(ctx(), mike, rejected.id),
  'po_before_approval',
  'a rejected request cannot generate a purchase order',
);
await refuses(
  async () => S.decide(ctx(), rick, rejected.id, 'APPROVE'),
  'not_in_review',
  'a rejected request cannot be approved afterwards',
);

console.log('--- clarification path + Rick as backup approver ----------------');

const clarify = await S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'Panel feeders.' });
await S.submitRequest(ctx(), foreman, clarify.id);
await S.decide(ctx(), rick, clarify.id, 'CLARIFY', { question: 'Which floor is this for?' });
eq(db.prepare('select status from purchase_requests where id = ?').get(clarify.id).status, 'CLARIFICATION_REQUESTED',
   'Rick can send a request back for clarification');
await refuses(
  async () => S.answerClarification(ctx(), office, clarify.id, 'Third floor'),
  'not_owner',
  'only the requestor answers their own clarification',
);
await S.answerClarification(ctx(), foreman, clarify.id, 'Third floor, east side.');
eq(db.prepare('select status from purchase_requests where id = ?').get(clarify.id).status, 'PENDING_WORKSHOP_REVIEW',
   'an answered clarification returns to the queue');

const clarifyItem = (await S.getRequestDetail(ctx(), rick, clarify.id)).originalItems[0];
await S.saveReview(ctx(), rick, clarify.id, {
  lines: [{ requestItemId: clarifyItem.id, usableStock: '0', approvedQty: '20', finalOrderQty: '20',
            vendorId: graybar.id, estimatedUnitCost: '86.40' }],
});
await S.decide(ctx(), rick, clarify.id, 'APPROVE', { notes: 'Backup approver.' });
eq(db.prepare('select status from purchase_requests where id = ?').get(clarify.id).status, 'APPROVED',
   'Rick can approve as the authorized backup');
const rickPo = await S.generatePurchaseOrder(ctx(), rick, clarify.id);
// Same job, same vendor as the first order in this run, so this is that pair's
// SECOND number — not the company's second.
eq(rickPo.poNumber, `24-118-${graybar.code}-2`, 'the next PO number continues that job-and-vendor pair');

console.log('--- the PO -> email flow (reachable from the PO itself) ---------');

// The bug this covers: the purchase order page linked to an email page that
// could only say "nothing here", because the create action lived on the request
// page. What the PO page offers is driven by this state, so assert the state.
const beforeDraft = await S.getRequestDetail(ctx(), rick, clarify.id);
eq(beforeDraft.emailDrafts.length, 0, 'a fresh purchase order has no email draft yet');
check(Boolean(beforeDraft.purchaseOrder), 'the PO page has a purchase order to offer a draft for');

const fromPo = await S.generateVendorEmailDraft(ctx(), rick, clarify.id);
const afterDraft = await S.getRequestDetail(ctx(), rick, clarify.id);
eq(afterDraft.emailDrafts.length, 1, 'the draft is created without leaving the purchase order');
eq(afterDraft.emailDrafts[0].purchaseOrderId, afterDraft.purchaseOrder.id,
   'the draft is bound to the purchase order it was created from');

const again = await S.generateVendorEmailDraft(ctx(), rick, clarify.id);
eq(again.id, fromPo.id, 'pressing create twice does not produce a second draft');
eq((await S.getRequestDetail(ctx(), rick, clarify.id)).emailDrafts.length, 1,
   'the draft state survives a re-read — a refresh shows the same one draft');

console.log('--- office approver grant --------------------------------------');

const officeReq = await S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'Wire for the same job.' });
await S.submitRequest(ctx(), foreman, officeReq.id);
const officeItem = (await S.getRequestDetail(ctx(), officeApprover, officeReq.id)).originalItems[0];
await S.saveReview(ctx(), officeApprover, officeReq.id, {
  lines: [{ requestItemId: officeItem.id, usableStock: '2', approvedQty: '20', finalOrderQty: '18',
            vendorId: graybar.id, estimatedUnitCost: '10.00' }],
});
await S.decide(ctx(), officeApprover, officeReq.id, 'APPROVE', { notes: 'Granted approval authority.' });
eq(db.prepare('select status from purchase_requests where id = ?').get(officeReq.id).status, 'APPROVED',
   'an office user with an explicit grant can approve');

console.log('--- BR-011: approval authority over requester identity ----------');

// BR-011 case 4, end to end: the authorized purchaser raises a request and
// decides it himself. This is the ORDINARY case at this company — the people
// who hold purchasing authority are the people who need the material — and the
// system must complete it, not refuse it.
const mikesOwn = await S.createRequest(ctx(), mike, { ...baseDraft, reason: 'Workshop restock.' });
await S.submitRequest(ctx(), mike, mikesOwn.id);
await S.saveReview(ctx(), mike, mikesOwn.id, {
  lines: [{ requestItemId: (await S.getRequestDetail(ctx(), mike, mikesOwn.id)).originalItems[0].id,
            usableStock: '0', approvedQty: '20', finalOrderQty: '20', vendorId: graybar.id, estimatedUnitCost: '5.00' }],
});
await S.decide(ctx(), mike, mikesOwn.id, 'APPROVE', { notes: 'Shop stock, my own call.' });
eq(db.prepare('select status from purchase_requests where id = ?').get(mikesOwn.id).status, 'APPROVED',
   'BR-011.4 an authorized purchaser can approve the request he raised');

// BR-011 case 5: the audit trail. Approving your own request must leave MORE
// evidence than refusing it did, not less — both parties named, and the fact
// that they are one person stated rather than left to be inferred.
const selfRow = db.prepare(
  `select r.requestor_id, a.approver_id, a.self_approved, a.decision, a.notes
     from purchase_approvals a join purchase_requests r on r.id = a.request_id
    where a.request_id = ?`).get(mikesOwn.id);
eq(selfRow.requestor_id, mike.id, 'BR-011.5 the audit record keeps the requester');
eq(selfRow.approver_id, mike.id, 'BR-011.5 the audit record keeps the approver');
eq(selfRow.self_approved, 1, 'BR-011.5 a self-approval is stamped as one');
eq(selfRow.decision, 'APPROVED', 'BR-011.5 the decision itself is recorded');
eq(db.prepare('select approver_id from purchase_requests where id = ?').get(mikesOwn.id).approver_id, mike.id,
   'BR-011.5 the request names who decided it');

// BR-011 cases 1 and 2: a request-only user holds no approval authority, so
// neither his own request nor anyone else's is decidable by him. Same refusal,
// same reason — the refusal is about the missing capability, never about who
// raised the request.
const foremansOwn = await S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'Field restock.' });
await S.submitRequest(ctx(), foreman, foremansOwn.id);
await refuses(
  async () => S.decide(ctx(), foreman, foremansOwn.id, 'APPROVE'),
  'missing_permission',
  'BR-011.1 a request-only user cannot approve his own request',
);
await refuses(
  async () => S.decide(ctx(), foreman, mikesOwn.id, 'APPROVE'),
  'missing_permission',
  "BR-011.2 a request-only user cannot approve someone else's request",
);

// BR-011 case 3, and the audit stamp's other half: a colleague's decision is
// recorded as exactly that.
await S.saveReview(ctx(), rick, foremansOwn.id, {
  lines: [{ requestItemId: (await S.getRequestDetail(ctx(), rick, foremansOwn.id)).originalItems[0].id,
            usableStock: '0', approvedQty: '20', finalOrderQty: '20', vendorId: graybar.id, estimatedUnitCost: '5.00' }],
});
await S.decide(ctx(), rick, foremansOwn.id, 'APPROVE');
eq(db.prepare('select status from purchase_requests where id = ?').get(foremansOwn.id).status, 'APPROVED',
   "BR-011.3 an authorized purchaser can approve a colleague's request");
const colleagueRow = db.prepare(
  `select r.requestor_id, a.approver_id, a.self_approved
     from purchase_approvals a join purchase_requests r on r.id = a.request_id
    where a.request_id = ?`).get(foremansOwn.id);
eq(colleagueRow.requestor_id, foreman.id, 'BR-011.5 the requester is the foreman who raised it');
eq(colleagueRow.approver_id, rick.id, 'BR-011.5 the approver is the purchaser who decided it');
eq(colleagueRow.self_approved, 0, "BR-011.5 deciding a colleague's request is not stamped as self-approval");

console.log('--- BR-014: receipt authority ----------------------------------');

// Sam raises requests and nothing else; Luis is a foreman assigned to 24-203,
// not to this order's job. Both are seeded for exactly this kind of proof.
const requestOnly = users.sam;
const otherSiteForeman = users.luis;

// BR-014 cases 5, 6 and 7 end to end, on the request Mike raised AND approved
// himself under BR-011. One person is requester, approver and receiver here —
// the hardest case for the rule, and the ordinary case in a small shop. Every
// step must go through, and the record must say who did each part.
{
  await S.generatePurchaseOrder(ctx(), mike, mikesOwn.id);
  const ownDraft = await S.generateVendorEmailDraft(ctx(), mike, mikesOwn.id);
  // The human review gate still applies to a self-approved order — BR-014
  // loosens who may RECEIVE, and loosens nothing about how an order goes out.
  await S.advanceEmailDraft(ctx(), mike, ownDraft.id, 'REVIEWED');
  await S.advanceEmailDraft(ctx(), mike, ownDraft.id, 'APPROVED_TO_SEND');
  await S.advanceEmailDraft(ctx(), mike, ownDraft.id, 'SENT');
  await S.markOrdered(ctx(), mike, mikesOwn.id, { notes: 'Placed at the counter.' });
  eq(db.prepare('select status from purchase_requests where id = ?').get(mikesOwn.id).status, 'ORDERED',
     'BR-014 the self-approved order reaches ORDERED');

  const ownItem = db.prepare(
    `select i.* from purchase_order_items i
       join purchase_orders o on o.id = i.purchase_order_id
      where o.request_id = ?`).get(mikesOwn.id);

  // A partial receipt first: partial receiving must survive BR-014 untouched.
  const part = await S.recordReceipt(ctx(), mike, mikesOwn.id, {
    receivedDate: '2026-08-07',
    packingSlipNumber: 'PS-90001',
    lines: [{ purchaseOrderItemId: ownItem.id, receivedQty: '8', damagedQty: '1',
              notes: 'One coil crushed in transit.' }],
  });
  check(part.outstandingLines > 0, 'BR-014.5/6 a purchaser receives the order they raised and approved');
  eq(db.prepare('select status from purchase_requests where id = ?').get(mikesOwn.id).status, 'PARTIALLY_RECEIVED',
     'BR-014 partial receiving is preserved — the order stays visibly incomplete');

  // BR-014.7: the audit trail names the RECEIVER, and does so independently of
  // the requester and the approver — who here happen to be the same person, so
  // the columns must be populated separately rather than inferred.
  const receipt = db.prepare(
    'select * from purchase_receipts where request_id = ? order by created_at desc limit 1').get(mikesOwn.id);
  eq(receipt.received_by, mike.id, 'BR-014.7 the receiving actor is recorded on the receipt');
  check(Boolean(receipt.created_at), 'BR-014.7 the receipt records when it was written');
  eq(receipt.received_date, '2026-08-07', 'BR-014.7 the receipt records the date the material arrived');
  eq(receipt.packing_slip_number, 'PS-90001', 'BR-014.7 the packing slip is kept as evidence');

  const line = db.prepare('select * from purchase_receipt_items where receipt_id = ?').get(receipt.id);
  check(Number(line.received_qty) > 0, 'BR-014.7 the quantity received is recorded');
  check(Number(line.damaged_qty) > 0, 'BR-014.7 damage is recorded as an exception rather than lost');
  check(String(line.notes ?? '').length > 0, 'BR-014.7 the receiver\'s note about the exception is kept');

  const requestRow = db.prepare('select requestor_id, approver_id from purchase_requests where id = ?').get(mikesOwn.id);
  eq(requestRow.requestor_id, mike.id, 'BR-014.7 the requester is still named');
  eq(requestRow.approver_id, mike.id, 'BR-014.7 the approver is still named');
  const receiptEvents = db.prepare(
    `select action, actor_id, at from purchase_activity_log
      where request_id = ? and action like 'receipt.%' order by seq`).all(mikesOwn.id);
  check(receiptEvents.length > 0, 'BR-014.7 the receipt appears in the activity history');
  check(receiptEvents.every((e) => e.actor_id === mike.id),
    'BR-014.7 the activity entry names the person who did the receiving, not the requester or approver');
  check(receiptEvents.every((e) => Boolean(e.at)), 'BR-014.7 every receiving event is timestamped');

  // The approval actor and the receiving actor are recorded SEPARATELY, even
  // when they are the same person. BR-011 and BR-014 each write their own
  // actor; neither infers one from the other.
  const approvalEvents = db.prepare(
    `select action, actor_id from purchase_activity_log
      where request_id = ? and action like 'request.approved%'`).all(mikesOwn.id);
  check(approvalEvents.every((e) => e.actor_id === mike.id),
    'BR-014.7 the approval actor is recorded independently of the receiving actor');

  // BR-014.1 on the write path: a request-only user is refused server-side,
  // not merely un-offered a button.
  await refuses(
    async () => S.recordReceipt(ctx(), requestOnly, mikesOwn.id, {
      receivedDate: '2026-08-07',
      lines: [{ purchaseOrderItemId: ownItem.id, receivedQty: '1' }],
    }),
    'missing_permission',
    'BR-014.1 a request-only user cannot record a receipt, enforced on the server',
  );

  // BR-014.3: a foreman assigned elsewhere is refused on THIS job, by scope.
  await refuses(
    async () => S.recordReceipt(ctx(), otherSiteForeman, mikesOwn.id, {
      receivedDate: '2026-08-07',
      lines: [{ purchaseOrderItemId: ownItem.id, receivedQty: '1' }],
    }),
    'not_assigned',
    'BR-014.3 a foreman on another job site is refused, by scope rather than identity',
  );

  // BR-014.2: the foreman assigned to THIS job may finish it — and the fact
  // that Mike raised, approved and part-received it changes nothing.
  const rest = await S.recordReceipt(ctx(), foreman, mikesOwn.id, {
    receivedDate: '2026-08-08',
    // 20 ordered, 8 received and 1 damaged already accounted for: 11 closes it.
    lines: [{ purchaseOrderItemId: ownItem.id, receivedQty: '11' }],
  });
  eq(rest.outstandingLines, 0, 'BR-014.2 the assigned foreman finishes the receipt');
  const second = db.prepare(
    'select received_by from purchase_receipts where request_id = ? order by created_at desc limit 1').get(mikesOwn.id);
  eq(second.received_by, foreman.id,
     'BR-014.7 each receipt records ITS OWN receiver — two people, two rows, no overwrite');
}

console.log('--- integration seams ------------------------------------------');

// The seams where QuickBooks, Microsoft 365 and the material spreadsheet will
// attach. They are bound to purchasing's own data today, so what is asserted
// here is the CONTRACT a future adapter has to satisfy — canonical identifiers
// survive, an exact lookup is exact, and the email path cannot report a send.
{
  const integrations = ctx().integrations;
  check(Boolean(integrations), 'the context exposes the integration seams');

  // Jobs — the type-ahead and the exact re-check a server action performs.
  const jobs = await integrations.jobs.list(mike.orgId);
  check(jobs.length > 0, 'the job directory answers from this organization');
  check(jobs.every((j) => j.sourceId && j.jobNumber), 'every job carries a canonical id AND the number people type');
  const known = jobs[0];
  const typeAhead = await integrations.jobs.search(mike.orgId, known.jobNumber.slice(0, 3), 5);
  check(typeAhead.some((j) => j.jobNumber === known.jobNumber), 'typing the first characters of a job number finds it');
  eq((await integrations.jobs.byNumber(mike.orgId, known.jobNumber))?.sourceId, known.sourceId,
     'the exact lookup returns the same canonical record');
  eq(await integrations.jobs.byNumber(mike.orgId, 'no-such-job'), null,
     'an unknown job number is null, not a nearest match — this is what re-checks a submitted form');

  // Vendors.
  const vendorHits = await integrations.vendors.search(mike.orgId, 'gray', 5);
  check(vendorHits.every((v) => v.vendorId), 'every vendor record carries its id');
  check((await integrations.vendors.list(mike.orgId)).length > 0, 'the vendor directory answers');

  // Materials — the ranking is the domain's, exercised through the provider.
  const materialHits = await integrations.materials.search(mike.orgId, 'wire', 5);
  check(Array.isArray(materialHits), 'the material catalogue answers a search');
  check(materialHits.length <= 5, 'and honours the limit it was given');

  // Email: prepared for a human, never sent.
  const prepared = await integrations.email.prepare({
    orgId: mike.orgId, actorId: mike.id, purchaseOrderId: 'po-1',
    payload: { to: ['sales@example.invalid'], subject: 'PO LE-00001', body: 'Please supply the following.' },
  });
  eq(prepared.sent, false, 'a prepared draft is NEVER reported as sent');
  check(['display', 'mailto'].includes(prepared.handoff), 'the handoff is one this deployment can actually perform');
  check(!('send' in integrations.email), 'the email seam has no send() at all — absence is the control');
  await refuses(
    async () => integrations.email.prepare({
      orgId: mike.orgId, actorId: mike.id, purchaseOrderId: 'po-1',
      payload: { to: [], subject: 'x', body: 'y' },
    }),
    'no_recipient',
    'a draft addressed to nobody is refused rather than produced',
  );

  // Time tracking is declared and NOT implemented. Null is the honest answer;
  // an adapter returning zero hours would be indistinguishable from a job
  // nobody has worked.
  eq(integrations.timeTracking, null, 'the time-tracking seam is null until Exact Time is connected');
}

console.log('--- tenant isolation + unauthorized access ---------------------');

const otherOrg = randomUUID();
const otherUser = randomUUID();
const nowIso = tick();
db.prepare('insert into orgs (id, name, created_at, updated_at) values (?,?,?,?)').run(otherOrg, 'Another Contractor LLC', nowIso, nowIso);
db.prepare('insert into users (id, org_id, full_name, email, is_active, can_approve, created_at, updated_at) values (?,?,?,?,1,1,?,?)')
  .run(otherUser, otherOrg, 'Someone Else', 'else@example.invalid', nowIso, nowIso);
db.prepare('insert into user_roles (user_id, role_key, granted_at) values (?,?,?)').run(otherUser, 'ADMIN', nowIso);
const stranger = await S.loadActor(db, otherUser);

await refuses(async () => S.getRequestDetail(ctx(), stranger, created.id), 'not_found', "another org's request is not found");
await refuses(async () => S.decide(ctx(), stranger, clarify.id, 'APPROVE'), 'not_found', "another org's request cannot be approved");
check((await S.listRequests(ctx(), stranger)).length === 0, 'another org sees no requests');
check(
  authorize({ id: 'x', orgId: 'A', roles: ['ADMIN'], canApprove: true, isActive: true }, 'review.decide',
            { request: { id: 'r', orgId: 'B', status: 'PENDING_WORKSHOP_REVIEW' } }).reason === 'cross_tenant',
  'the tenant check fires before the role check',
);

const foremanView = await S.listRequests(ctx(), foreman);
check(foremanView.every((r) => r.requestorId === foreman.id), 'a requestor sees only their own requests');
check((await S.listRequests(ctx(), office)).length > foremanView.length, 'office sees all requests');
await refuses(
  async () => S.getRequestDetail(ctx(), users.sam, created.id),
  'not_owner',
  "a field worker cannot open someone else's request",
);
await refuses(async () => S.auditLog(ctx(), foreman), 'missing_permission', 'a requestor cannot read the audit log');
check((await S.auditLog(ctx(), admin)).length > 0, 'an admin can read the audit log');
check(
  db.prepare("select count(*) c from purchase_activity_log where action = 'authz.denied'").get().c > 0,
  'refusals are recorded, not merely refused',
);

console.log('--- dashboard --------------------------------------------------');

const all = await S.listRequests(ctx(), office);
const cards = summarize(all, '2026-08-06T12:00:00Z');
check(cards.pending_workshop_review >= 0 && cards.open_order_value_cents >= 0, 'the summary cards compute');
eq(cards.received_this_month >= 1, true, 'the completed request counts toward received this month');
check(
  isOverdue({ status: 'ORDERED', needByDate: '2026-08-01', needByTime: '07:00' }, '2026-08-06T12:00:00Z'),
  'a late open order is overdue',
);
check(
  !isOverdue({ status: 'COMPLETED', needByDate: '2026-08-01', needByTime: '07:00' }, '2026-08-06T12:00:00Z'),
  'a completed request is not overdue',
);

console.log('--- state machine invariants -----------------------------------');

const reasonsSeen = new Set();
for (const from of REQUEST_STATUSES) {
  for (const to of REQUEST_STATUSES) {
    const g = transitionGuard(from, to, {});
    if (!g.ok) reasonsSeen.add(g.reason);
  }
}
for (const r of ['illegal_transition', 'terminal_status', 'review_incomplete', 'email_before_po', 'receipt_missing']) {
  check(reasonsSeen.has(r) || GUARD_REASONS.includes(r), `guard reason ${r} is reachable and in the vocabulary`);
}
check(transitionGuard('UNKNOWN', 'DRAFT').reason === 'unknown_status', 'an unknown status is refused');
check(!transitionGuard('APPROVED', 'ORDERED', {}).ok, 'a request cannot skip the PO and email steps');
check(!transitionGuard('PO_GENERATED', 'ORDERED', {}).ok, 'a request cannot be ordered before the email is drafted');
check(
  transitionGuard('ORDERED', 'RECEIVED', { hasReceipt: false }).reason === 'receipt_missing',
  'a request cannot be received without receiving information',
);
check(
  transitionGuard('RECEIVED', 'COMPLETED', { outstandingLines: 2 }).reason === 'lines_outstanding',
  'a request cannot be completed with lines outstanding',
);
check(PERMISSIONS.length === new Set(PERMISSIONS).size, 'the permission vocabulary has no duplicates');
check(NOTIFICATION_EVENTS.length === 11, 'all eleven notification events exist');

console.log('--- PO numbering: the sequence belongs to the job AND the vendor -');

// THE LIPPOLIS RULE, from Mike and Paul: job number + vendor + a number that
// counts from 1 FOR THAT PAIR. What this section exists to prove is that the
// three counters below never see each other.
//
//   job A + vendor X -> 1, 2, 3
//   job A + vendor Y -> 1, 2
//   job B + vendor X -> 1, 2
//
const cooper = vendors.find((v) => v.name.startsWith('Cooper')) ?? vendors.find((v) => v.id !== graybar.id);
check(Boolean(cooper) && cooper.id !== graybar.id, 'the fixture has two vendors to tell apart');
check(/^[A-Z0-9]+$/.test(graybar.code), `a vendor carries the code its purchase order numbers are built from (${graybar.code})`);

const pair = (job, vendor) => ({ orgId: DEMO_ORG_ID, jobNumber: job, vendorId: vendor.id, vendorCode: vendor.code });
const take = (job, vendor) => ctx().uow.run(() => S.allocatePoNumber(ctx(), pair(job, vendor)));

{
  const ax = [await take('1234', graybar), await take('1234', graybar), await take('1234', graybar)];
  const ay = [await take('1234', cooper), await take('1234', cooper)];
  const bx = [await take('5678', graybar), await take('5678', graybar)];

  eq(ax.map((a) => a.sequenceValue), [1, 2, 3], 'job A with vendor X counts 1, 2, 3');
  eq(ay.map((a) => a.sequenceValue), [1, 2], 'job A with vendor Y starts again at 1');
  eq(bx.map((a) => a.sequenceValue), [1, 2], 'job B with vendor X starts again at 1');

  eq(ax.map((a) => a.poNumber), [`1234-${graybar.code}-1`, `1234-${graybar.code}-2`, `1234-${graybar.code}-3`],
     'and the numbers read job-vendor-sequence');
  eq(ay[0].poNumber, `1234-${cooper.code}-1`, 'a different vendor on the same job is a different number');
  eq(bx[0].poNumber, `5678-${graybar.code}-1`, 'the same vendor on a different job is a different number');

  // The pairs must not have moved each other. Re-reading the counters is the
  // whole property: an implementation that shared one counter would have left
  // job A + vendor X at 6 rather than 4.
  const rows = Object.fromEntries(
    db.prepare('select job_number, vendor_id, next_value from po_job_vendor_sequences where org_id = ?')
      .all(DEMO_ORG_ID).map((r) => [`${r.job_number}:${r.vendor_id}`, Number(r.next_value)]),
  );
  eq(rows[`1234:${graybar.id}`], 4, 'job A + vendor X advanced only for its own three');
  eq(rows[`1234:${cooper.id}`], 3, 'job A + vendor Y advanced only for its own two');
  eq(rows[`5678:${graybar.id}`], 3, 'job B + vendor X advanced only for its own two');
}

// A JOB NUMBER WITH A HYPHEN IN IT. Lippolis writes 24-118, so the separator
// appears inside a component — and the identifier still has to come apart.
{
  const allocated = await take('26-204', graybar);
  eq(allocated.poNumber, `26-204-${graybar.code}-1`, 'a hyphenated job number keeps its hyphen');
  const parsed = parsePoNumber(allocated.poNumber);
  eq(parsed.jobNumber, '26-204', 'and parses back to the job');
  eq(parsed.vendorCode, graybar.code, 'the vendor');
  eq(parsed.sequence, 1, 'and the sequence');
}

console.log('--- PO numbering under real concurrency ------------------------');

// Eight worker threads, one database file, ONE (job, vendor) pair. If the
// allocation is not atomic this produces a duplicate; nothing else in the
// harness would catch it. The pair is the unit that has to be safe — two people
// approving two requests for the same job and the same supplier in the same
// second is the ordinary case, not the exotic one.
const WORKERS = 8;
const workerSource = `
import { workerData, parentPort } from 'node:worker_threads';
const { openDatabase } = await import(workerData.dbModule);
const S = await import(workerData.serviceModule);
const db = openDatabase(workerData.dbPath);
const ctx = S.context(db, new Date().toISOString());
const out = [];
for (let i = 0; i < workerData.iterations; i++) {
  // Through the application's own transaction boundary — the async, serialized
  // unit of work — so this gate exercises what the app actually does.
  const allocated = await ctx.uow.run(() => S.allocatePoNumber(ctx, workerData.scope));
  out.push(allocated.poNumber);
}
parentPort.postMessage(out);
`;
const workerFile = join(TMP, 'po-worker.mjs');
writeFileSync(workerFile, workerSource);

const CONTENDED_JOB = '9001';
const results = await Promise.all(
  Array.from({ length: WORKERS }, () =>
    new Promise((resolve, reject) => {
      const w = new Worker(workerFile, {
        workerData: {
          dbPath,
          scope: { orgId: DEMO_ORG_ID, jobNumber: CONTENDED_JOB, vendorId: graybar.id, vendorCode: graybar.code },
          iterations: 5,
          dbModule: join(APP, 'purchasing', 'infrastructure', 'sqlite', 'database.ts'),
          serviceModule: join(APP, 'server', 'service.ts'),
        },
        execArgv: ['--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'],
      });
      w.on('message', resolve);
      w.on('error', reject);
    }),
  ),
);
const issued = results.flat();
eq(issued.length, WORKERS * 5, 'every worker allocated its numbers');
eq(new Set(issued).size, issued.length, 'concurrent PO generation produced no duplicate numbers');

// NO GAPS EITHER. A compare-and-set that retried, or an allocator that skipped
// on contention, would still pass the uniqueness check above while quietly
// burning numbers a vendor was told to expect.
const contended = issued.map((p) => parsePoNumber(p).sequence).sort((a, b) => a - b);
eq(contended, Array.from({ length: WORKERS * 5 }, (_, i) => i + 1),
   'the pair issued 1..40 with no duplicate and no gap');
const pairAfter = db
  .prepare('select next_value from po_job_vendor_sequences where org_id = ? and job_number = ? and vendor_id = ?')
  .get(DEMO_ORG_ID, CONTENDED_JOB, graybar.id).next_value;
eq(Number(pairAfter), WORKERS * 5 + 1, 'the counter advanced exactly once per issued number');

// THE DATABASE ITSELF, not just the allocator. Two orders on the same job to
// the same vendor cannot carry the same sequence...
const spare = await S.createRequest(ctx(), mike, { ...baseDraft, reason: 'Spare, for the constraint checks.' });
const writeOrder = (requestId, poNumber, sequence, vendor, job) =>
  db.prepare('insert into purchase_orders (id, org_id, request_id, po_number, sequence_value, vendor_id, vendor_code, job_number, approver_id, delivery_location_id, delivery_method, need_by_date, need_by_time, generated_at, generated_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), DEMO_ORG_ID, requestId, poNumber, sequence, vendor.id, vendor.code, job, mike.id, jobsite.id, 'DELIVERY', '2026-08-07', '07:00', nowIso, mike.id, nowIso, nowIso);

await throws(
  () => writeOrder(spare.id, `24-118-${graybar.code}-1`, 1, graybar, '24-118'),
  /UNIQUE/i,
  'the database itself refuses a duplicate PO number',
);

// ...but the SAME sequence on a different pair is not a duplicate of anything,
// and the old `unique (org_id, sequence_value)` would have refused it. This is
// the constraint change, asserted rather than assumed.
{
  writeOrder(spare.id, `7777-${cooper.code}-1`, 1, cooper, '7777');
  check(Boolean(db.prepare('select 1 from purchase_orders where request_id = ?').get(spare.id)),
        'sequence 1 on a different job and vendor is accepted, not refused as a duplicate');

  // AND IT CANNOT BE TAKEN BACK. The number has been issued; a purchase order
  // that can be deleted is a number that can be issued twice, and one that can
  // be edited is a supplier holding paperwork that no longer matches ours.
  await throws(
    () => db.prepare('delete from purchase_orders where request_id = ?').run(spare.id),
    /already been issued/i,
    'a purchase order cannot be deleted once its number exists',
  );
  // A NULL vendor_code may be filled in ONCE — that is the migration recording
  // the code against an order raised before the column existed — and never
  // changed again, nor cleared. Written with a null code here rather than
  // nulled afterwards, because nulling it afterwards is precisely what the
  // fence forbids.
  {
    const legacyShaped = await S.createRequest(ctx(), mike, { ...baseDraft, reason: 'An order from before the column existed.' });
    db.prepare('insert into purchase_orders (id, org_id, request_id, po_number, sequence_value, vendor_id, vendor_code, job_number, approver_id, delivery_location_id, delivery_method, need_by_date, need_by_time, generated_at, generated_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), DEMO_ORG_ID, legacyShaped.id, 'LE-52901', 52901, cooper.id, null, '24-118', mike.id, jobsite.id, 'DELIVERY', '2026-08-07', '07:00', nowIso, mike.id, nowIso, nowIso);

    db.prepare('update purchase_orders set vendor_code = ? where request_id = ?').run(cooper.code, legacyShaped.id);
    eq(db.prepare('select vendor_code from purchase_orders where request_id = ?').get(legacyShaped.id).vendor_code,
       cooper.code, 'a missing vendor code can be filled in once');
    await throws(
      () => db.prepare('update purchase_orders set vendor_code = null where request_id = ?').run(legacyShaped.id),
      /permanent/i,
      'and cannot be cleared again',
    );
    await throws(
      () => db.prepare('update purchase_orders set vendor_code = ? where request_id = ?').run('OTHER', legacyShaped.id),
      /permanent/i,
      'nor changed once it is there',
    );
  }

  for (const [column, value] of [
    ['po_number', 'SOMETHING-ELSE-1'],
    ['sequence_value', 99],
    ['vendor_code', 'OTHER'],
    ['job_number', '0000'],
    ['vendor_id', graybar.id],
  ]) {
    await throws(
      () => db.prepare(`update purchase_orders set ${column} = ? where request_id = ?`).run(value, spare.id),
      /permanent/i,
      `${column} cannot be changed after the purchase order is issued`,
    );
  }

  // The columns that legitimately move still move — the fence is on identity,
  // not on the row.
  db.prepare('update purchase_orders set actual_total_cents = ?, updated_at = ? where request_id = ?')
    .run(12345, nowIso, spare.id);
  eq(Number(db.prepare('select actual_total_cents from purchase_orders where request_id = ?').get(spare.id).actual_total_cents),
     12345, 'but the actual cost can still be recorded against it');
}

console.log('--- a pair whose paper sequence already ran ---------------------');

// THE ONE THING A PERSON STILL HAS TO SAY. PCC counts a pair from 1 because a
// pair it has issued nothing for HAS issued nothing. Where the office already
// wrote purchase orders for that job and that vendor by hand, starting at 1
// would put a number a supplier already has on a second, different order.
{
  const JOB = '4242';

  // Only an administrator. A purchaser who may raise purchase orders may not
  // decide what they are called.
  await refuses(
    async () => S.initializePoSequence(ctx(), foreman, { jobNumber: JOB, vendorId: graybar.id, nextSequence: 12 }),
    'missing_permission',
    'a field user cannot set a purchase order sequence',
  );

  // Neither form given, or both: refused rather than guessed at.
  await refuses(
    async () => S.initializePoSequence(ctx(), admin, { jobNumber: JOB, vendorId: graybar.id }),
    'validation_failed',
    'saying neither the last nor the next number is refused',
  );
  await refuses(
    async () => S.initializePoSequence(ctx(), admin, { jobNumber: JOB, vendorId: graybar.id, lastIssuedSequence: 3, nextSequence: 9 }),
    'validation_failed',
    'saying both is refused',
  );

  // "The last one we wrote by hand was 11."
  const set = await S.initializePoSequence(ctx(), admin, { jobNumber: JOB, vendorId: graybar.id, lastIssuedSequence: 11 });
  eq(set.nextValue, 12, 'the last issued number means the next one is one higher');
  eq(set.nextPoNumber, `${JOB}-${graybar.code}-12`, 'and the screen can say exactly what the next order will be called');

  const first = await take(JOB, graybar);
  eq(first.poNumber, `${JOB}-${graybar.code}-12`, 'the next purchase order continues the office paper sequence');

  // ONLY FORWARD. Winding back would re-issue a number that is on a vendor's
  // invoice.
  await refuses(
    async () => S.initializePoSequence(ctx(), admin, { jobNumber: JOB, vendorId: graybar.id, nextSequence: 5 }),
    'sequence_rewind',
    'a pair sequence cannot be wound backwards',
  );
  eq(
    Number(db.prepare('select next_value from po_job_vendor_sequences where org_id = ? and job_number = ? and vendor_id = ?')
      .get(DEMO_ORG_ID, JOB, graybar.id).next_value),
    13,
    'and the refusal left it untouched',
  );

  // Nor may it be set to a number PCC has ALREADY issued, even if the counter
  // would technically allow it — that is read from the orders, not the counter.
  await refuses(
    async () => S.initializePoSequence(ctx(), admin, { jobNumber: JOB, vendorId: graybar.id, nextSequence: 0 }),
    'validation_failed',
    'zero is not a purchase order sequence',
  );

  // It moves ONE pair. A second vendor on the same job is untouched.
  const otherVendorFirst = await take(JOB, cooper);
  eq(otherVendorFirst.sequenceValue, 1, 'initializing one pair does not move another vendor on the same job');

  // And the database refuses a rewind even if the application is bypassed.
  await throws(
    () => db.prepare('update po_job_vendor_sequences set next_value = 2 where org_id = ? and job_number = ? and vendor_id = ?')
      .run(DEMO_ORG_ID, JOB, graybar.id),
    /forward/i,
    'the database itself refuses a backwards sequence',
  );

  // AND IT IS ON THE RECORD. Deciding which number a real supplier receives is
  // exactly the kind of act somebody has to be able to ask about later.
  const audit = db
    .prepare("select * from purchase_activity_log where action like '%po_sequence%' order by at desc")
    .all();
  check(audit.length > 0, 'setting a pair sequence is written to the activity log');
  check(audit.every((row) => row.actor_id), 'and every such entry names who did it');
}

console.log('--- the whole purchase, four times, watching the number ----------');

// THE PRODUCTION REGRESSION. Everything above tests the allocator; this tests
// the PURCHASE — request, workshop stock check, vendor choice, approval, number,
// PDF, vendor email, ordered, received, completed — and follows one identifier
// all the way from issuance into the immutable history.
//
// Run four times over the matrix the rule is actually about:
//
//   job A + vendor X, first   -> A-X-1
//   job A + vendor X, second  -> A-X-2
//   job A + vendor Y, first   -> A-Y-1     (different vendor, own count)
//   job B + vendor X, first   -> B-X-1     (different job, own count)
//
// and a fifth on a pair whose paper sequence was declared at 7, which must
// issue 8.
{
  const JOB_A = '7001';
  const JOB_B = '7002';

  /** One complete purchase, start to finish, as the people who do it. */
  const wholePurchase = async (jobNumber, vendor, description) => {
    const req = await S.createRequest(ctx(), foreman, {
      ...baseDraft, jobNumber, reason: `End-to-end: ${description}`,
      items: [{ description, qty: '10', unit: 'ea' }],
    });
    await S.submitRequest(ctx(), foreman, req.id);

    // Mike checks the shelf, chooses the vendor, prices it.
    const line = (await S.getRequestDetail(ctx(), mike, req.id)).originalItems[0];
    await S.saveReview(ctx(), mike, req.id, {
      workshopNotes: 'Two on the shelf.',
      lines: [{
        requestItemId: line.id, usableStock: '2', approvedQty: '10', finalOrderQty: '8',
        vendorId: vendor.id, estimatedUnitCost: '12.50',
      }],
    });
    await S.decide(ctx(), mike, req.id, 'APPROVE', { notes: 'Ordering the balance.' });

    // The number is assigned HERE and nowhere else.
    const order = await S.generatePurchaseOrder(ctx(), mike, req.id);

    // Print and email, both carrying the same string.
    const orderRow = db.prepare('select * from purchase_orders where request_id = ?').get(req.id);
    const pdf = db.prepare('select * from purchase_order_documents where purchase_order_id = ?').get(orderRow.id);
    check(Buffer.from(pdf.data_base64, 'base64').includes(Buffer.from(order.poNumber)),
          `${order.poNumber}: the printed PO carries the number`);
    const emailDraft = await S.generateVendorEmailDraft(ctx(), mike, req.id);
    const draftRow = db.prepare('select * from purchase_email_drafts where id = ?').get(emailDraft.id);
    check(draftRow.subject.includes(order.poNumber), `${order.poNumber}: the vendor email carries it`);
    for (const to of ['REVIEWED', 'APPROVED_TO_SEND', 'SENT']) {
      await S.advanceEmailDraft(ctx(), mike, emailDraft.id, to);
    }

    await S.markOrdered(ctx(), mike, req.id, { notes: 'Called it in.' });

    // Receiving, in full, so the request can complete.
    const progress = await S.orderProgress(ctx(), req.id);
    await S.recordReceipt(ctx(), mike, req.id, {
      receivedDate: '2026-08-14',
      packingSlipNumber: `PS-${order.poNumber}`,
      lines: progress.map((pr) => ({ purchaseOrderItemId: pr.purchaseOrderItemId, receivedQty: String(pr.outstandingQty / 1000) })),
    });
    await S.completeRequest(ctx(), mike, req.id, 'Collected.');
    eq(db.prepare('select status from purchase_requests where id = ?').get(req.id).status, 'COMPLETED',
       `${order.poNumber}: the purchase completes`);

    // THE SAME NUMBER, in the record that outlives the request.
    const history = db.prepare('select po_number from purchase_history_lines where request_id = ?').all(req.id);
    check(history.length > 0 && history.every((h) => h.po_number === order.poNumber),
          `${order.poNumber}: the immutable history carries the same number`);

    // And in the receiving record, and on the request row the queue reads.
    const receipt = db.prepare('select purchase_order_id from purchase_receipts where request_id = ?').get(req.id);
    eq(receipt.purchase_order_id, orderRow.id, `${order.poNumber}: the receipt is against that purchase order`);
    const listed = (await S.listRequests(ctx(), mike, {})).find((r) => r.id === req.id);
    eq(listed.poNumber, order.poNumber, `${order.poNumber}: the queue row shows the same number`);

    return order.poNumber;
  };

  eq(await wholePurchase(JOB_A, graybar, '3/4in EMT connector'), `${JOB_A}-${graybar.code}-1`,
     'job A, vendor X, first purchase');
  eq(await wholePurchase(JOB_A, graybar, '1in EMT coupling'), `${JOB_A}-${graybar.code}-2`,
     'job A, vendor X, second purchase continues that pair');
  eq(await wholePurchase(JOB_A, cooper, '4in square box'), `${JOB_A}-${cooper.code}-1`,
     'job A, a DIFFERENT vendor, starts its own count at 1');
  eq(await wholePurchase(JOB_B, graybar, '12/2 MC cable'), `${JOB_B}-${graybar.code}-1`,
     'a DIFFERENT job, same vendor, starts its own count at 1');

  // And the four counts did not move each other.
  eq(
    Object.fromEntries(
      db.prepare('select job_number, vendor_id, next_value from po_job_vendor_sequences where org_id = ? and job_number in (?, ?)')
        .all(DEMO_ORG_ID, JOB_A, JOB_B).map((r) => [`${r.job_number}:${r.vendor_id === graybar.id ? 'X' : 'Y'}`, Number(r.next_value)]),
    ),
    { [`${JOB_A}:X`]: 3, [`${JOB_A}:Y`]: 2, [`${JOB_B}:X`]: 2 },
    'each pair advanced only for its own purchases',
  );

  // THE LEGACY CASE, end to end. The office wrote 1 to 7 by hand; PCC issues 8.
  const JOB_LEGACY = '7003';
  await S.initializePoSequence(ctx(), admin, { jobNumber: JOB_LEGACY, vendorId: graybar.id, lastIssuedSequence: 7 });
  eq(await wholePurchase(JOB_LEGACY, graybar, '#12 THHN, black'), `${JOB_LEGACY}-${graybar.code}-8`,
     'a pair whose paper sequence reached 7 issues 8, through the whole workflow');
  eq(await wholePurchase(JOB_LEGACY, graybar, '#12 THHN, white'), `${JOB_LEGACY}-${graybar.code}-9`,
     'and then 9');
}

console.log('--- a pair already in use cannot be moved by accident ------------');

// Forward is legitimate — an office reconciling a gap after an outage — and it
// is a bad accident. The two are told apart by whether the person had seen the
// orders that are already out there.
{
  const JOB = '7001';
  await refuses(
    async () => S.initializePoSequence(ctx(), admin, { jobNumber: JOB, vendorId: graybar.id, nextSequence: 50 }),
    'sequence_already_issued',
    'a pair PCC has already issued against is not moved without acknowledgement',
  );
  eq(
    Number(db.prepare('select next_value from po_job_vendor_sequences where org_id = ? and job_number = ? and vendor_id = ?')
      .get(DEMO_ORG_ID, JOB, graybar.id).next_value),
    3,
    'and the refusal left the counter alone',
  );

  const moved = await S.initializePoSequence(ctx(), admin, {
    jobNumber: JOB, vendorId: graybar.id, nextSequence: 50, acknowledgeIssued: true,
  });
  eq(moved.nextValue, 50, 'acknowledged, it moves');
  eq(moved.issuedSequence, 2, 'and the answer says what was already issued');

  // Backwards is still refused, acknowledged or not — those numbers are out.
  await refuses(
    async () => S.initializePoSequence(ctx(), admin, {
      jobNumber: JOB, vendorId: graybar.id, nextSequence: 2, acknowledgeIssued: true,
    }),
    'sequence_rewind',
    'acknowledgement does not buy a rewind onto an issued number',
  );

  // Declaring a pair NEW is the other half of the answer: it changes no count,
  // and it is what stops pcc-verify-production.mjs asking about the pair.
  const fresh = await S.initializePoSequence(ctx(), admin, { jobNumber: '7009', vendorId: cooper.id, nextSequence: 1 });
  eq(fresh.nextValue, 1, 'a pair declared new still starts at 1');
  check(fresh.declaredNew === true, 'and says so');
  const declared = db
    .prepare('select initialized_at from po_job_vendor_sequences where org_id = ? and job_number = ? and vendor_id = ?')
    .get(DEMO_ORG_ID, '7009', cooper.id);
  check(Boolean(declared.initialized_at), 'the decision is recorded, which is the whole point of recording it');
  eq((await ctx().uow.run(() => S.allocatePoNumber(ctx(), { orgId: DEMO_ORG_ID, jobNumber: '7009', vendorId: cooper.id, vendorCode: cooper.code }))).poNumber,
     `7009-${cooper.code}-1`, 'and it issues 1 as it would have anyway');
}

console.log('--- one press to order, and urgency nobody types -----------------');

// TWO PILOT FINDINGS, as tests. Mike does not want to confirm an order he has
// just placed, and he does not want to grade the urgency of work that is
// almost always for tomorrow.
{
  const JOB = '7300';
  const K = 1000;

  const toOrdered = async (description) => {
    const req = await S.createRequest(ctx(), foreman, {
      ...baseDraft, jobNumber: JOB, reason: '', items: [{ description, qty: '10', unit: 'ea' }],
    });
    await S.submitRequest(ctx(), foreman, req.id);
    const item = (await S.getRequestDetail(ctx(), mike, req.id)).originalItems[0];
    const po = await S.reviewApproveAndCreatePo(
      ctx(), mike, req.id,
      { lines: [{ requestItemId: item.id, usableStock: '0', vendorId: graybar.id }] },
      { notes: '' },
    );
    for (const to of ['REVIEWED', 'APPROVED_TO_SEND', 'SENT']) {
      await S.advanceEmailDraft(ctx(), mike, po.emailDraftId, to);
    }
    return req;
  };

  // ONE ACTION. `markOrdered` takes the request and nothing else — no
  // acknowledgement flag, no second call, no "confirmed: true".
  const req = await toOrdered('1in EMT coupling');
  const before = db.prepare('select status from purchase_requests where id = ?').get(req.id).status;
  eq(before, 'EMAIL_DRAFTED', 'the order is ready to be placed');
  await S.markOrdered(ctx(), mike, req.id);
  eq(db.prepare('select status from purchase_requests where id = ?').get(req.id).status, 'ORDERED',
     'one call places the order — there is no confirmation step to satisfy');
  // Arity: (ctx, actor, requestId) with an optional input bag. No
  // acknowledgement parameter exists to be passed.
  eq(S.markOrdered.length, 3, 'and its signature takes no confirmation argument');

  // THE GOVERNANCE BEHIND IT IS UNCHANGED. Removing a dialog removed a dialog.
  check(Boolean(db.prepare('select ordered_at from purchase_requests where id = ?').get(req.id).ordered_at),
        'the moment it was placed is recorded');
  const logged = db.prepare(
    "select * from purchase_activity_log where request_id = ? and action = 'order.placed'").get(req.id);
  check(Boolean(logged), 'the act is in the activity log');
  check(Boolean(logged.actor_id), 'and it names who did it');

  // Still authorized, and still idempotent-by-transition: a second press cannot
  // move it again.
  await refuses(
    async () => S.markOrdered(ctx(), requestOnly, req.id),
    'missing_permission',
    'somebody without purchasing authority still cannot place an order',
  );
  await refuses(
    async () => S.markOrdered(ctx(), mike, req.id),
    'illegal_transition',
    'and pressing it twice is refused by the state machine, not by a dialog',
  );

  // NO MANUAL URGENCY ANYWHERE. `priority` remains a forbidden requestor field,
  // so a client that sends one is stripped and reported rather than obeyed.
  const withPriority = await S.createRequest(ctx(), foreman, {
    ...baseDraft, jobNumber: JOB, reason: '', priority: 'EMERGENCY',
    items: [{ description: 'Wire nuts', qty: '5', unit: 'ea' }],
  });
  check(withPriority.rejectedFields.includes('priority'),
        'a request carrying a priority has it stripped and recorded');

  // URGENCY IS DERIVED FROM THE WORK, and ordinary next-day purchasing is quiet.
  const tomorrow = '2026-08-14';
  const quiet = { status: 'PENDING_WORKSHOP_REVIEW', needByDate: tomorrow, needByTime: '07:00' };
  eq(attentionBand(quiet, '2026-08-13T09:00:00'), 'NEW',
     'next-day work is ordinary — it is not badged as urgent');
  check(!isOverdue(quiet, '2026-08-13T09:00:00'), 'and it is not overdue');

  // Past its moment and still needing purchasing: elevated, by the clock alone.
  const late = { status: 'PENDING_WORKSHOP_REVIEW', needByDate: '2026-08-12', needByTime: '07:00' };
  eq(attentionBand(late, '2026-08-13T09:00:00'), 'OVERDUE', 'work past its date is elevated automatically');
  check(isOverdue(late, '2026-08-13T09:00:00'), 'and reads as overdue');

  // Due today and not yet ordered is the band the purchaser can still act on.
  eq(attentionBand({ status: 'APPROVED', needByDate: '2026-08-13', needByTime: '16:00' }, '2026-08-13T09:00:00'),
     'DUE_TODAY', 'work due today that nobody has ordered is called out');
  // Once ordered, due-today is the vendor's problem — a different, lower kind.
  eq(attentionBand({ status: 'ORDERED', needByDate: '2026-08-13', needByTime: '16:00' }, '2026-08-13T09:00:00'),
     'ARRIVING', 'once it is ordered it stops shouting at the purchaser');
  // And finished work never shouts at all.
  eq(attentionBand({ status: 'COMPLETED', needByDate: '2026-01-01', needByTime: '07:00' }, '2026-08-13T09:00:00'),
     null, 'closed work is never urgent');

  // THE ORDERING IS EXCEPTIONS FIRST. Overdue above due-today above ordinary.
  const ranked = attentionQueue(
    [
      { id: 'c', status: 'PENDING_WORKSHOP_REVIEW', needByDate: tomorrow, needByTime: '07:00' },
      { id: 'a', status: 'PENDING_WORKSHOP_REVIEW', needByDate: '2026-08-12', needByTime: '07:00' },
      { id: 'b', status: 'APPROVED', needByDate: '2026-08-13', needByTime: '16:00' },
    ],
    '2026-08-13T09:00:00',
  );
  eq(ranked.items.map((r) => r.request.id), ['a', 'b', 'c'],
     'the queue ranks overdue, then due today, then ordinary work');
}

console.log('--- three quantities, and they stay three ------------------------');

// JOB NEEDS · WORKSHOP STOCK · TO ORDER. Different facts about different
// things, and the failure this pins is the tempting one: letting the shelf
// count overwrite what the job asked for, so a request for 10 covered by 2 in
// stock becomes a request for 8 and the job's actual requirement is lost.
//
// Workshop stock is also NOT a receipt. Nothing has arrived when Mike counts
// the shelf; that material was already Lippolis's.
{
  const JOB = '7200';
  const K = 1000;

  const purchase = async (description, requestedQty, stockQty) => {
    const req = await S.createRequest(ctx(), foreman, {
      ...baseDraft, jobNumber: JOB, reason: '',
      items: [{ description, qty: String(requestedQty), unit: 'ea' }],
    });
    await S.submitRequest(ctx(), foreman, req.id);
    const item = (await S.getRequestDetail(ctx(), mike, req.id)).originalItems[0];
    const po = await S.reviewApproveAndCreatePo(
      ctx(), mike, req.id,
      { lines: [{ requestItemId: item.id, usableStock: String(stockQty), vendorId: graybar.id }] },
      { notes: '' },
    );
    return { req, item, po };
  };

  // The arithmetic, at the four boundaries §8 names.
  for (const [requested, stock, expected, what] of [
    [10, 2, 8, 'normal subtraction: 10 needed, 2 on the shelf, 8 bought'],
    [10, 0, 10, 'no stock: the vendor supplies the whole requirement'],
    [10, 10, 0, 'full stock: nothing is bought'],
    [10, 12, 0, 'excess stock: the order never goes negative'],
  ]) {
    eq(suggestedOrderQty(requested * K, stock * K), expected * K, what);
  }

  // And through the real workflow, not just the pure function.
  const { req, item, po } = await purchase('1in EMT coupling', 10, 2);

  // THE JOB'S REQUIREMENT IS UNTOUCHED. This is the whole point.
  eq(Number(db.prepare('select requested_qty from purchase_request_items where id = ?').get(item.id).requested_qty),
     10 * K, 'entering workshop stock does not rewrite what the job asked for');

  // The three numbers are each stored, separately, where they belong.
  const review = db.prepare(
    `select rvi.* from purchase_review_items rvi join purchase_reviews rv on rv.id = rvi.review_id
      where rv.request_id = ? limit 1`).get(req.id);
  eq(Number(review.usable_stock_qty), 2 * K, 'the shelf count is recorded on the review');
  eq(Number(review.final_order_qty), 8 * K, 'and the quantity to buy beside it');

  // THE VENDOR IS SOLD 8, NOT 10.
  const orderRow = db.prepare('select * from purchase_orders where request_id = ?').get(req.id);
  const orderLine = db.prepare('select * from purchase_order_items where purchase_order_id = ?').get(orderRow.id);
  eq(Number(orderLine.order_qty), 8 * K, 'the vendor is ordered only what Lippolis actually needs to buy');

  // MIKE'S PRINTED COPY CARRIES ALL THREE.
  const view = await S.purchaseOrderView(ctx(), orderRow.id);
  const printed = view.items[0];
  eq(printed.requestedQty, 10 * K, "the printed copy shows the job's quantity");
  eq(printed.workshopStockQty, 2 * K, 'and the workshop stock');
  eq(printed.finalOrderQty, 8 * K, 'and what was actually ordered');
  check(printed.requestedQty !== printed.finalOrderQty,
        'the three are visibly different numbers, not one number repeated');

  // STOCK IS NOT RECEIVING. Nothing has arrived yet, and the order is fully
  // outstanding despite there being material on the shelf.
  for (const to of ['REVIEWED', 'APPROVED_TO_SEND', 'SENT']) {
    await S.advanceEmailDraft(ctx(), mike, po.emailDraftId, to);
  }
  await S.markOrdered(ctx(), mike, req.id);
  const before = await S.orderProgress(ctx(), req.id);
  eq(before[0].receivedQty, 0, 'workshop stock is not counted as received');
  eq(before[0].outstandingQty, 8 * K, 'the full ordered quantity is still owed by the vendor');

  // Receiving is the separate act, and it settles the ORDERED quantity.
  await S.receiveEverything(ctx(), mike, req.id);
  const after = await S.orderProgress(ctx(), req.id);
  eq(after[0].receivedQty, 8 * K, 'receiving records what the vendor delivered');
  eq(after[0].outstandingQty, 0, 'and nothing is left owed');

  // HISTORY CAN STILL TELL THE STORY: asked for 10, bought 8 — and the shelf
  // count survives on the review row, so "Mike found 2" is recoverable.
  const historyLine = db.prepare('select * from purchase_history_lines where request_id = ? limit 1').get(req.id);
  eq(Number(historyLine.requested_qty), 10 * K, 'history keeps what the job asked for');
  eq(Number(historyLine.ordered_qty), 8 * K, 'and what was bought');
  eq(Number(historyLine.received_qty), 8 * K, 'and what arrived');
  eq(
    Number(historyLine.requested_qty) - Number(historyLine.ordered_qty),
    Number(review.usable_stock_qty),
    'and the difference between them is exactly the stock Mike found',
  );

  // The other three cases, end to end, to prove nothing special happens at the
  // boundaries — including full stock, where there is nothing to order at all.
  const none = await purchase('4in square box', 10, 0);
  eq(Number(db.prepare('select order_qty from purchase_order_items where purchase_order_id = (select id from purchase_orders where request_id = ?)').get(none.req.id).order_qty),
     10 * K, 'with no stock the vendor supplies all ten');

  const excess = await S.createRequest(ctx(), foreman, {
    ...baseDraft, jobNumber: JOB, reason: '', items: [{ description: 'Wire nuts', qty: '10', unit: 'ea' }],
  });
  await S.submitRequest(ctx(), foreman, excess.id);
  const excessItem = (await S.getRequestDetail(ctx(), mike, excess.id)).originalItems[0];
  await refuses(
    async () => S.reviewApproveAndCreatePo(
      ctx(), mike, excess.id,
      { lines: [{ requestItemId: excessItem.id, usableStock: '12', vendorId: graybar.id }] },
      { notes: '' },
    ),
    'nothing_to_order',
    'more stock than the job needs orders nothing, and says so rather than ordering zero',
  );
  eq(Number(db.prepare('select requested_qty from purchase_request_items where id = ?').get(excessItem.id).requested_qty),
     10 * K, 'and the refusal still left the original request saying ten');
}

console.log("--- Mike's workflow: no price, one click to receive --------------");

// THE PILOT FEEDBACK, as tests. Each of these is something Mike said he does
// not do, encoded so it cannot come back.
{
  const JOB = '7100';

  const raise = async (description) => {
    const req = await S.createRequest(ctx(), foreman, {
      ...baseDraft, jobNumber: JOB, reason: '', items: [{ description, qty: '10', unit: 'ea' }],
    });
    await S.submitRequest(ctx(), foreman, req.id);
    return req;
  };

  // A REQUEST NEEDS NO REASON. The material request is the reason.
  const req = await raise('1in EMT coupling');
  eq(db.prepare('select reason from purchase_requests where id = ?').get(req.id).reason, '',
     'a request can be raised without a written justification');

  // A COMPLETE PURCHASE ORDER, WITH NO PRICE ANYWHERE. Lippolis prices from the
  // vendor's invoice, in accounting, later.
  const item = (await S.getRequestDetail(ctx(), mike, req.id)).originalItems[0];
  const approved = await S.reviewApproveAndCreatePo(
    ctx(), mike, req.id,
    { lines: [{ requestItemId: item.id, usableStock: '2', finalOrderQty: '8', vendorId: graybar.id }] },
    { notes: '' },
  );
  eq(approved.poNumber, `${JOB}-${graybar.code}-1`, 'a purchase order is created without an estimated cost');
  const orderRow = db.prepare('select * from purchase_orders where request_id = ?').get(req.id);
  eq(Number(orderRow.estimated_total_cents), 0, 'and its estimated total is simply zero, not a guess');
  check(
    db.prepare('select unit_cost_cents from purchase_order_items where purchase_order_id = ?').all(orderRow.id)
      .every((l) => Number(l.unit_cost_cents) === 0),
    'no line carries an invented unit cost',
  );

  // THE VENDOR EMAIL IS ALREADY WRITTEN. Mike does not press a button to have
  // PCC assemble facts it is holding.
  check(Boolean(approved.emailDraftId), 'the vendor email draft is prepared by the same action');
  const draft = db.prepare('select * from purchase_email_drafts where id = ?').get(approved.emailDraftId);
  check(draft.subject.includes(approved.poNumber), 'the draft names the purchase order');
  check(draft.body.includes(JOB), 'and the job');
  check(draft.body.includes('1in EMT coupling'), 'and what was ordered');
  eq(draft.status, 'GENERATED', 'and it is a draft — nothing is sent');

  // THE EMAIL GATE STAYS. BR-010: an order is not "placed" until a person has
  // reviewed the draft and said they sent it. That is Mike's own described
  // sequence — review, send, then mark ordered — so the gate is preserved and
  // the walk through it is part of the test rather than something to remove.
  await refuses(
    async () => S.markOrdered(ctx(), mike, req.id),
    'missing_evidence',
    'an order cannot be marked placed before the vendor email has been dealt with',
  );
  for (const to of ['REVIEWED', 'APPROVED_TO_SEND', 'SENT']) {
    await S.advanceEmailDraft(ctx(), mike, approved.emailDraftId, to);
  }

  // MARK ORDERED, then IT ARRIVED. One click each, no forms between them.
  await S.markOrdered(ctx(), mike, req.id);
  eq(db.prepare('select status from purchase_requests where id = ?').get(req.id).status, 'ORDERED',
     'marking it ordered takes no confirmation and no arguments');

  const received = await S.receiveEverything(ctx(), mike, req.id);
  check(received.completed === true, 'one click receives everything and closes it');
  eq(db.prepare('select status from purchase_requests where id = ?').get(req.id).status, 'COMPLETED',
     'the request is closed');

  // AND THE RECORD IS ALL THERE. The receipt row exists, nobody typed it.
  const receipt = db.prepare('select * from purchase_receipts where request_id = ?').get(req.id);
  check(Boolean(receipt), 'a receipt record was written automatically');
  eq(receipt.received_by, mike.id, 'and it records who signed for it');
  check(Boolean(receipt.received_date), 'and when');
  const progress = await S.orderProgress(ctx(), req.id);
  check(progress.every((p) => Number(p.outstandingQty) === 0), 'nothing is left outstanding');
  check(db.prepare('select count(*) n from purchase_history_lines where request_id = ?').get(req.id).n > 0,
        'and the immutable history was written, so it stays searchable');

  // RECEIVING AUTHORITY IS STILL BOUNDED. One click did not widen it.
  const other = await raise('4in square box');
  const otherItem = (await S.getRequestDetail(ctx(), mike, other.id)).originalItems[0];
  await S.reviewApproveAndCreatePo(
    ctx(), mike, other.id,
    { lines: [{ requestItemId: otherItem.id, usableStock: '0', finalOrderQty: '10', vendorId: graybar.id }] },
    { notes: '' },
  );
  const otherDraft = db.prepare('select id from purchase_email_drafts where request_id = ?').get(other.id);
  for (const to of ['REVIEWED', 'APPROVED_TO_SEND', 'SENT']) {
    await S.advanceEmailDraft(ctx(), mike, otherDraft.id, to);
  }
  await S.markOrdered(ctx(), mike, other.id);
  await refuses(
    async () => S.receiveEverything(ctx(), requestOnly, other.id),
    'missing_permission',
    'somebody without receiving authority still cannot receive in one click',
  );

  // RECEIVING IS STILL SCOPED TO THE JOB. A foreman signs for his own sites and
  // not for somebody else's, and one click did not widen that either.
  await refuses(
    async () => S.receiveEverything(ctx(), foreman, other.id),
    'not_assigned',
    'a foreman still cannot receive against a job that is not his',
  );

  // A FOREMAN MAY RECEIVE BUT NOT CLOSE. On his OWN job the shortcut works and
  // stops at RECEIVED — it must not quietly promote him to closing the purchase.
  {
    const onHisJob = await S.createRequest(ctx(), foreman, { ...baseDraft, reason: '' });
    await S.submitRequest(ctx(), foreman, onHisJob.id);
    const line = (await S.getRequestDetail(ctx(), mike, onHisJob.id)).originalItems[0];
    const po = await S.reviewApproveAndCreatePo(
      ctx(), mike, onHisJob.id,
      { lines: [{ requestItemId: line.id, usableStock: '0', finalOrderQty: '5', vendorId: graybar.id }] },
      { notes: '' },
    );
    for (const to of ['REVIEWED', 'APPROVED_TO_SEND', 'SENT']) {
      await S.advanceEmailDraft(ctx(), mike, po.emailDraftId, to);
    }
    await S.markOrdered(ctx(), mike, onHisJob.id);

    const asForeman = await S.receiveEverything(ctx(), foreman, onHisJob.id);
    check(asForeman.completed === false, 'a receiver who cannot complete does not complete it');
    eq(db.prepare('select status from purchase_requests where id = ?').get(onHisJob.id).status, 'RECEIVED',
       'the delivery is recorded and the closing is left to somebody who may');
  }

  // And receiving twice is refused rather than double-counted.
  await refuses(
    async () => S.receiveEverything(ctx(), mike, req.id),
    'nothing_outstanding',
    'receiving an order that is already fully received is refused',
  );
}

console.log('--- a vendor rename does not renumber anything -------------------');

// WHY THE CODE AND THE NAME ARE KEPT APART. The display name is corrected,
// merged and re-spelled over a company's life; the code is on a supplier's
// paperwork.
{
  const RENAME_JOB = '8080';
  const before = await take(RENAME_JOB, cooper);
  const originalCode = cooper.code;

  await ADMIN.updateVendor(ctx(), admin, cooper.id, { name: 'Cooper Electric Supply Company' });
  const renamed = (await S.listVendors(ctx(), mike)).find((v) => v.id === cooper.id);
  eq(renamed.name, 'Cooper Electric Supply Company', 'the vendor was renamed');
  eq(renamed.code, originalCode, 'and its purchase order code did not move with the name');

  const after = await take(RENAME_JOB, renamed);
  eq(after.poNumber, `${RENAME_JOB}-${originalCode}-2`, 'the next order continues the same pair under the same code');
  eq(before.poNumber, `${RENAME_JOB}-${originalCode}-1`, 'and the earlier number is exactly as it was sent');

  // The code itself cannot be changed once the vendor has been sent an order.
  // Graybar is the one this run has actually raised purchase orders to.
  check(Boolean(db.prepare('select 1 from purchase_orders where vendor_id = ?').get(graybar.id)),
        'the fixture has issued purchase orders to Graybar');
  await refuses(
    async () => S.setVendorCode(ctx(), admin, graybar.id, 'GBAR'),
    'vendor_code_frozen',
    'a vendor that has been sent purchase orders cannot have its code changed',
  );

  // A vendor that has NOT been ordered from can, because nothing carries it yet.
  const fresh = await ADMIN.createVendor(ctx(), admin, { name: 'Rexel Northeast' });
  const rexel = (await S.listVendors(ctx(), mike)).find((v) => v.id === fresh.vendorId);
  eq(rexel.code, 'RexelNortheast'.toUpperCase(), 'a new vendor is given a code derived from its name');
  await S.setVendorCode(ctx(), admin, rexel.id, 'REXEL');
  eq((await S.listVendors(ctx(), mike)).find((v) => v.id === rexel.id).code, 'REXEL',
     'and it can be shortened until the first order');
  await refuses(
    async () => S.setVendorCode(ctx(), admin, rexel.id, graybar.code),
    'duplicate',
    'two vendors cannot share a purchase order code',
  );
  await ADMIN.setVendorActive(ctx(), admin, rexel.id, false);
}

console.log('--- email cannot outrun the purchase order ---------------------');

const noPo = await S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'Third run.' });
await refuses(
  async () => S.generateVendorEmailDraft(ctx(), mike, noPo.id),
  'email_before_po',
  'a vendor email cannot be drafted without a purchase order',
);

console.log('--- purchasing history is preserved and tenant-scoped ----------');

// The forward-compatibility requirement: an organization's line-item history
// must stay identifiable, complete and separate, so later features (catalog,
// autocomplete, ranking, reorder, analytics) have something to learn from.
const histRows = db.prepare(
  `select i.org_id, i.description, i.normalized_description, i.requested_qty, i.unit, r.job_number
     from purchase_request_items i join purchase_requests r on r.id = i.request_id`,
).all();
check(histRows.length > 0, 'there is line-item history to preserve');
check(histRows.every((r) => r.org_id), 'EVERY historical line carries its organization on the row');
check(histRows.every((r) => r.org_id === DEMO_ORG_ID), 'and it is the organization of its parent request');
check(histRows.every((r) => r.description && r.description.trim().length > 0),
      'the original user-entered description is preserved verbatim');
check(histRows.every((r) => r.normalized_description), 'the normalized form is stored beside it, not derived on read');
check(histRows.every((r) => r.requested_qty > 0 && r.unit), 'quantity and unit are preserved');
check(histRows.every((r) => r.job_number), 'job context is preserved');

const orderedRows = db.prepare(
  `select oi.org_id, oi.description, oi.normalized_description, oi.order_qty, oi.unit,
          oi.unit_cost_cents, oi.actual_unit_cost_cents, po.vendor_id, po.po_number, po.job_number
     from purchase_order_items oi join purchase_orders po on po.id = oi.purchase_order_id`,
).all();
check(orderedRows.length > 0, 'there is ordered-line history');
check(orderedRows.every((r) => r.org_id === DEMO_ORG_ID), 'ordered lines carry their organization');
check(orderedRows.every((r) => r.vendor_id), 'the vendor relationship is preserved on ordered history');
check(orderedRows.every((r) => r.po_number && r.job_number), 'PO and job context are preserved');
check(orderedRows.every((r) => r.normalized_description), 'ordered lines carry a normalized form for matching');
// Estimated and actual are DIFFERENT facts and either may be unknown.
check(orderedRows.every((r) => r.unit_cost_cents !== null), 'estimated cost is recorded where it was known');
check(orderedRows.every((r) => r.actual_unit_cost_cents === null),
      'actual cost is null until reconciled — unknown is not zero');

// Cross-tenant: the second organization created earlier must own no history,
// and a history query scoped to it must return nothing belonging to Lippolis.
const strangerHistory = db.prepare('select count(*) c from purchase_request_items where org_id = ?').get(otherOrg);
eq(strangerHistory.c, 0, 'another organization has no line-item history of its own');
const mixed = db.prepare(
  `select count(*) c from purchase_request_items i
     join purchase_requests r on r.id = i.request_id
    where i.org_id <> r.org_id`,
).get();
eq(mixed.c, 0, 'NO line item belongs to a different organization than its parent — history cannot be mixed');

const catalogTable = db.prepare(
  "select count(*) c from sqlite_master where type='table' and name='purchase_item_catalog'",
).get();
eq(catalogTable.c, 1, 'the organization catalog table exists for later curation');
const jobsTable = db.prepare(
  "select count(*) c from sqlite_master where type='table' and name='purchase_jobs'",
).get();
eq(jobsTable.c, 1, 'the job directory table exists');

console.log('--- BR-012: immutable history, written at the terminal state ----');

// The whole point of the architecture, tested where it can actually be broken:
// a completed purchase, then the world changes around it.

const completedHistory = await S.requestHistory(ctx(), mike, created.id);
check(completedHistory.length > 0, 'completing a request writes its history');
eq(completedHistory.length, (await S.getRequestDetail(ctx(), mike, created.id)).originalItems.length,
   'one history row per REQUEST line — including any line the workshop filled from stock');

const hLine = completedHistory[0];
for (const field of HISTORY_LINE_FIELDS) {
  check(field in hLine, `the history row carries ${field}`);
}
eq(hLine.terminalState, 'COMPLETED', 'the row records the state the request ended in');
check(HISTORY_TERMINAL_STATES.includes(hLine.terminalState), 'and it is one of the three terminal states');
check(RECEIPT_OUTCOMES.includes(hLine.outcome), 'the outcome is from the closed vocabulary');
eq(hLine.outcome, 'RECEIVED', 'a fully received line reads as RECEIVED');

// IDS **AND** SNAPSHOTS. Both, for the same things.
for (const idField of ['requestId', 'requestItemId', 'purchaseOrderId', 'purchaseOrderItemId', 'vendorId', 'requestorId', 'approverId']) {
  check(hLine[idField], `the row keeps the ${idField} — history stays joinable to current data`);
}
eq(hLine.requestNumber, db.prepare('select request_number from purchase_requests where id = ?').get(created.id).request_number,
   'the request NUMBER is snapshotted, not only the id');
eq(hLine.poNumber, poRow.po_number, 'the PO number is snapshotted');
eq(hLine.vendorName, graybar.name, 'the vendor NAME as the purchase order carried it');
eq(hLine.jobNumber, baseDraft.jobNumber, 'the job number the field typed');
check(hLine.requestorName && hLine.approverName, 'the requester and the approver are named, not only referenced');
check(hLine.requestedDescription && hLine.orderedDescription, 'what was asked for and what was ordered are both kept');
check(hLine.normalizedDescription && hLine.normalizerVersion >= 1,
      'the matching key is stored with the normalizer version that produced it');

// The timestamps the old view could not answer with.
check(hLine.orderedAt && hLine.receivedAt && hLine.completedAt,
      'ordered, received and completed timestamps are all recorded');
check(hLine.poGeneratedAt && hLine.poGeneratedAt !== hLine.orderedAt,
      'PO generation and actually placing the order are kept apart — lead time depends on which one you mean');
eq(leadTimeDays(hLine), 0, 'lead time is measurable for a line that was ordered and received');
check(hLine.receivedQty > 0 && hLine.orderedQty > 0, 'the quantities are preserved');
eq(hLine.actualUnitCostCents, null, 'an unreconciled invoice stays unknown — never zero');
check(countsTowardPricing(hLine) && countsTowardPurchaseFrequency(hLine),
      'a completed, ordered, priced line is price and frequency evidence');

// --- THE DECISIVE TEST: the world changes, history does not -----------------
//
// This is the test the view could not pass. Rename the vendor, re-describe the
// material, rename the job, correct the approver's name — everything the row
// used to resolve at read time — and read it again.
const beforeRename = JSON.stringify(await S.requestHistory(ctx(), mike, created.id));

db.prepare('update vendors set name = ? where id = ?').run('Graybar Electric Company, Inc.', graybar.id);
db.prepare('update purchase_order_items set description = ? where id = ?').run('SUPERSEDED FIXTURE TEXT', poItem.id);
db.prepare('update purchase_request_items set description = ? where id = ?')
  .run('SUPERSEDED REQUEST TEXT', poItem.request_item_id);
db.prepare('update purchase_requests set job_number = ? where id = ?').run('99-999', created.id);
db.prepare('update users set full_name = ? where id = ?').run('M. Renamed', mike.id);

const afterRename = await S.requestHistory(ctx(), mike, created.id);
eq(JSON.stringify(afterRename), beforeRename,
   'renaming the vendor, the material, the job and the approver changes NOTHING in history');
eq(afterRename[0].vendorName, graybar.name, 'the historical row still names the vendor as it was at the time');
check(db.prepare('select name from vendors where id = ?').get(graybar.id).name !== afterRename[0].vendorName,
      'and the live vendor really did change — the assertion above is not vacuous');

// The read model inherits the property, because it reads the snapshots.
const catalogAfterRename = await ctx().catalog.list(DEMO_ORG_ID);
const learned = catalogAfterRename.find((e) => e.lastVendorName);
check(learned, 'the catalogue learns a vendor from history');
eq(learned.lastVendorName, graybar.name,
   '"last ordered from" is what the purchase order said, not what the vendor is called today');

// --- append-only, enforced ---------------------------------------------------
await throws(
  () => db.prepare('update purchase_history_lines set vendor_name = ? where id = ?').run('anything', hLine.id),
  /immutable/i,
  'a history row cannot be edited, even directly in the database',
);
await throws(
  () => db.prepare('delete from purchase_history_lines where id = ?').run(hLine.id),
  /append-only/i,
  'a history row cannot be deleted',
);

// --- the write point refuses a request that has not ended -------------------
//
// Migration 0033's INSERT policy enforces this in Postgres. The pilot store has
// no policies, so the rule lives in the layer both providers share — without it
// the two would disagree about what is writable, which the conformance suite
// exists to prevent.
{
  const inFlight = await S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'still in flight' });
  await S.submitRequest(ctx(), foreman, inFlight.id);
  const historyModule = await import(join(APP, 'purchasing', 'application', 'history.ts'));
  await refuses(
    () => historyModule.recordPurchaseHistory(ctx(), mike, inFlight.id, 'COMPLETED'),
    'history_before_terminal',
    'history cannot be written for a request that is still in flight',
  );
  await refuses(
    () => historyModule.recordPurchaseHistory(ctx(), mike, created.id, 'CANCELLED'),
    'history_before_terminal',
    'nor may it record a COMPLETED request as CANCELLED',
  );
  eq((await S.requestHistory(ctx(), mike, inFlight.id)).length, 0,
     'and the in-flight request has no history rows');
}

// --- writing it twice is a no-op --------------------------------------------
const rewrite = await ctx().history.record(afterRename, new Date(clock).toISOString());
eq(rewrite.inserted, 0, 'recording the same history again inserts nothing');
eq(rewrite.skipped, afterRename.length, 'and reports what it skipped rather than failing');

// --- derived intelligence never mutates history -----------------------------
const orgHistory = await S.purchaseHistory(ctx(), mike, { limit: 500 });
const snapshotBefore = JSON.stringify(orgHistory);
const firstPass = JSON.stringify([...summarizeByMaterial(orgHistory).entries()]);
const secondPass = JSON.stringify([...summarizeByMaterial(await S.purchaseHistory(ctx(), mike, { limit: 500 })).entries()]);
eq(firstPass, secondPass, 'recomputing derived intelligence twice gives the same answer');
eq(JSON.stringify(await S.purchaseHistory(ctx(), mike, { limit: 500 })), snapshotBefore,
   'and leaves every history row byte-identical, timestamps included');

const summary = summarizeByMaterial(orgHistory).get(hLine.normalizedDescription);
check(summary.priceSampleSize >= 1 && summary.averageUnitCostCents !== null,
      'the derived summary reports an average WITH its sample size');
eq(summary.lastVendorName, graybar.name, 'the derived summary quotes the snapshot, not the current name');

// --- cancellation and rejection are recorded, and cost nothing --------------
const rejectedHistory = await S.requestHistory(ctx(), mike, rejected.id);
check(rejectedHistory.length > 0, 'a REJECTED request is recorded in history — it is part of what happened');
eq(rejectedHistory[0].terminalState, 'REJECTED', 'with its terminal state');
eq(rejectedHistory[0].terminalReason, 'Twenty-five already on the shelf.', 'and the reason given, verbatim');
eq(rejectedHistory[0].orderedAt, null, 'a rejected request never reached a vendor');
eq(rejectedHistory[0].outcome, 'NOT_ORDERED', 'so its outcome is NOT_ORDERED');
check(!countsTowardPricing(rejectedHistory[0]), 'and it informs no price');
check(!countsTowardPurchaseFrequency(rejectedHistory[0]), 'and inflates no purchase-frequency count');
eq(leadTimeDays(rejectedHistory[0]), null, 'and reports no lead time — not a zero');

const cancelled = await S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'Ordered twice by mistake.' });
await S.submitRequest(ctx(), foreman, cancelled.id);
await S.cancelRequest(ctx(), foreman, cancelled.id, 'Duplicate of the earlier request.');
const cancelledHistory = await S.requestHistory(ctx(), mike, cancelled.id);
check(cancelledHistory.length > 0, 'a CANCELLED request is recorded too');
eq(cancelledHistory[0].terminalState, 'CANCELLED', 'with its terminal state');
eq(cancelledHistory[0].terminalReason, 'Duplicate of the earlier request.', 'and the reason');
check(!countsTowardPricing(cancelledHistory[0]), 'a cancellation that never reached a vendor informs no price');
check(cancelledHistory[0].requestedDescription && cancelledHistory[0].requestedQty > 0,
      'what was asked for is still preserved — demand is recorded even when nothing was bought');

// The old view's blind spot, stated as a test: neither of these requests ever
// became a purchase order, and both are nonetheless in the record.
check(
  [...rejectedHistory, ...cancelledHistory].every((r) => r.purchaseOrderId === null),
  'neither ever became a purchase order — the predecessor view could not see them at all',
);

console.log('--- migration parity (0016) ------------------------------------');

const { validate } = await import(join(ROOT, 'scripts', 'lib', 'validate-migration-0016.mjs'));
const parityProblems = await validate();
for (const p of parityProblems) bad(`migration parity: ${p}`);
check(parityProblems.length === 0, 'the SQL migration and the app agree on statuses, roles, transitions and tables');

console.log('--- attachments come back out again -----------------------------');

// THE DEFECT THIS PINS. Attachments were write-only: the bytes went into the
// row, three screens listed the filename, and no code path anywhere returned
// the file. A foreman photographing a packing slip was told the evidence was
// kept, and it was — unreadably. It survived because listing an attachment and
// serving one look identical from the screen.

const withFile = await S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'Panel photo attached.' });
const stored = await S.addAttachment(ctx(), foreman, withFile.id, {
  filename: 'packing-slip.jpg',
  contentType: 'image/jpeg',
  dataBase64: Buffer.from('not really a jpeg, but bytes are bytes').toString('base64'),
});

const fetched = await S.getAttachmentForDownload(ctx(), foreman, stored.id);
check(fetched !== null, 'an uploaded attachment can be read back at all');
eq(fetched?.filename, 'packing-slip.jpg', 'under the name it was uploaded with');
eq(fetched?.requestId, withFile.id, 'resolved to the request it belongs to');
eq(
  fetched?.bytes?.toString('utf8'),
  'not really a jpeg, but bytes are bytes',
  'and the bytes are the bytes that went in',
);
eq(fetched?.byteSize, fetched?.bytes?.byteLength, 'the reported size is the size actually served');

// The file carries the request's authorization, not its own. `sam` may raise
// requests and read their own; this one is not theirs.
check(
  (await S.getAttachmentForDownload(ctx(), users.sam, stored.id).catch(() => 'refused')) === 'refused',
  'somebody who may not read the request may not read its attachment either',
);
check(
  (await S.getAttachmentForDownload(ctx(), mike, stored.id)) !== null,
  'purchasing, who may read every request, may read the file',
);
eq(
  await S.getAttachmentForDownload(ctx(), mike, randomUUID()),
  null,
  'an unknown attachment id is null, not a throw and not somebody else\'s file',
);

// The name and the type came from whoever uploaded the file, and both end up
// in response headers. Neither is trusted on the way out.
const { safeContentType, safeFilename, contentDisposition } =
  await import(join(APP, 'server', 'file-response.ts'));

eq(safeContentType('image/jpeg'), 'image/jpeg', 'a photograph is served as a photograph');
eq(safeContentType('image/jpeg; charset=binary'), 'image/jpeg', 'parameters are dropped, not parsed');
eq(safeContentType('text/html'), 'application/octet-stream',
   'HTML is served as bytes — a script uploaded as an attachment must not run on PCC\'s origin');
eq(safeContentType('image/svg+xml'), 'application/octet-stream', 'nor SVG, which carries script too');
eq(safeContentType(null), 'application/octet-stream', 'and an unstated type is inert');

eq(safeFilename('../../etc/passwd'), 'passwd', 'a traversing name keeps only its last segment');
eq(safeFilename('C:\\Users\\jack\\slip.jpg'), 'slip.jpg', 'whichever kind of machine wrote it');
eq(safeFilename('slip".jpg'), 'slip.jpg', 'a quote cannot close the header early');
eq(safeFilename('..'), 'attachment', 'a name that is only dots is not a name');
eq(safeFilename(''), 'attachment', 'nor is an empty one');

check(contentDisposition('slip.jpg').startsWith('attachment;'),
      'files are always downloaded, never rendered in place');
check(contentDisposition('Reçu.jpg').includes("filename*=UTF-8''Re%C3%A7u.jpg"),
      'an accented name still arrives intact, in the RFC 6266 form');
check(!/[\r\n]/.test(contentDisposition('a\r\nX-Injected: 1.jpg')),
      'a newline in the filename cannot write its own header');

console.log('--- production records may not live in the source checkout ------');

// THE DEFECT THIS PINS, found by reading our own installation runbook as if for
// the first time. It said: clone to /srv/pcc, then put the data in
// /srv/pcc/data. Each half is reasonable; together they put the company's
// purchasing records inside a git working tree, where `git clean -xfd`, a
// re-clone, or a release that replaces the application directory deletes them —
// and the backups sitting beside them. None of those commands look destructive.
{
  const { resolveDatabaseLocation } = await import(
    join(APP, 'purchasing', 'infrastructure', 'sqlite', 'database-location.ts')
  );

  // A checkout at /srv/pcc, with a .git at its root, and the data below it.
  const insideCheckout = {
    fileExists: (p) => p === '/srv/pcc/data/pcc.sqlite',
    directoryExists: (p) => p.startsWith('/srv/pcc'),
    pathExists: (p) => p === '/srv/pcc/.git' || p.startsWith('/srv/pcc'),
  };
  const refused = resolveDatabaseLocation(
    { NODE_ENV: 'production', PCC_DATABASE_PATH: '/srv/pcc/data/pcc.sqlite' },
    insideCheckout, '/tmp/default.db',
  );
  check(refused.ok === false, 'production refuses a database inside a git working tree');
  check(/source checkout/.test(refused.message ?? ''), 'and says why, naming the checkout');
  check(/var\/lib\/pcc/.test(refused.message ?? ''), 'and offers a path that is not in one');

  // A worktree keeps `.git` as a FILE. Checking only for a directory would call
  // this safe.
  const worktree = {
    fileExists: (p) => p === '/srv/pcc/.git' || p === '/srv/pcc/data/pcc.sqlite',
    directoryExists: (p) => p.startsWith('/srv/pcc') && p !== '/srv/pcc/.git',
    pathExists: (p) => p === '/srv/pcc/.git' || (p.startsWith('/srv/pcc') && p !== '/srv/pcc/.git'),
  };
  check(
    resolveDatabaseLocation(
      { NODE_ENV: 'production', PCC_DATABASE_PATH: '/srv/pcc/data/pcc.sqlite' },
      worktree, '/tmp/default.db',
    ).ok === false,
    'a git WORKTREE checkout is refused too, where .git is a file',
  );

  // The correct layout: data on its own path, application wherever it likes.
  const separated = {
    fileExists: (p) => p === '/var/lib/pcc/pcc.sqlite',
    directoryExists: (p) => p === '/var/lib/pcc',
    pathExists: (p) => p === '/var/lib/pcc' || p === '/var/lib/pcc/pcc.sqlite',
  };
  const allowed = resolveDatabaseLocation(
    { NODE_ENV: 'production', PCC_DATABASE_PATH: '/var/lib/pcc/pcc.sqlite' },
    separated, '/tmp/default.db',
  );
  check(allowed.ok === true, 'a data path outside any checkout is accepted');

  // DEVELOPMENT IS UNTOUCHED. A laptop keeps its database inside the checkout
  // on purpose, and a dev server that refuses to boot over it is one nobody uses.
  check(
    resolveDatabaseLocation(
      { PCC_DATABASE_PATH: '/srv/pcc/data/pcc.sqlite' },
      insideCheckout, '/tmp/default.db',
    ).ok === true,
    'development still allows a database inside the checkout',
  );
}

console.log('--- the number is allocated at issuance, and only once -----------');

// WHEN A NUMBER BECOMES REAL. Viewing a request, refreshing the page or
// abandoning a draft must burn nothing: a gap in a supplier's sequence is a
// phone call, and a purchase order number cannot be un-issued.
{
  const draft = await S.createRequest(ctx(), mike, { ...baseDraft, reason: 'Allocation timing.' });
  await S.submitRequest(ctx(), mike, draft.id);
  const item = (await S.getRequestDetail(ctx(), mike, draft.id)).originalItems[0];
  await S.saveReview(ctx(), mike, draft.id, {
    lines: [{ requestItemId: item.id, usableStock: '0', approvedQty: '20', finalOrderQty: '20',
              vendorId: graybar.id, estimatedUnitCost: '5.00' }],
  });

  const counterFor = () =>
    db.prepare('select next_value from po_job_vendor_sequences where org_id = ? and job_number = ? and vendor_id = ?')
      .get(DEMO_ORG_ID, baseDraft.jobNumber, graybar.id)?.next_value ?? null;
  const beforeApproval = counterFor();

  // Reading the request, repeatedly, the way a browser does.
  await S.getRequestDetail(ctx(), mike, draft.id);
  await S.getRequestDetail(ctx(), mike, draft.id);
  await S.listRequests(ctx(), mike, {});
  eq(counterFor(), beforeApproval, 'looking at a request allocates nothing');

  // An UNAPPROVED request cannot have one at all, and the refusal must not
  // consume a number on the way out.
  await refuses(
    async () => S.generatePurchaseOrder(ctx(), mike, draft.id),
    'po_before_approval',
    'an unapproved request cannot produce a purchase order',
  );
  eq(counterFor(), beforeApproval, 'and the refusal burned no number');

  await S.decide(ctx(), mike, draft.id, 'APPROVE', { notes: 'Ready for its number.' });
  const generated = await S.generatePurchaseOrder(ctx(), mike, draft.id);
  const parsed = parsePoNumber(generated.poNumber);
  eq(parsed.jobNumber, baseDraft.jobNumber, 'the number carries the job it was raised for');
  eq(parsed.vendorCode, graybar.code, 'and the vendor it is going to');

  // ASKING TWICE. Idempotent, and it must not advance the counter — this is the
  // page-refresh case, and it is the difference between a gap and no gap.
  const after = counterFor();
  const again = await S.generatePurchaseOrder(ctx(), mike, draft.id);
  eq(again.poNumber, generated.poNumber, 'asking twice returns the same permanent number');
  check(again.reused === true, 'and says it was reused');
  eq(counterFor(), after, 'and burns no sequence value');

  // The components are captured ON THE ORDER, not left to a join.
  const orderRow = db.prepare('select * from purchase_orders where request_id = ?').get(draft.id);
  eq(orderRow.job_number, baseDraft.jobNumber, 'the order records the job number it was numbered from');
  eq(orderRow.vendor_code, graybar.code, 'and the vendor code');
  eq(Number(orderRow.sequence_value), parsed.sequence, 'and the sequence');

  // A JOB RENAMED AFTERWARDS. The job directory is editable; an issued purchase
  // order number is not.
  await ADMIN.updateJob(ctx(), admin, (await S.listJobs(ctx(), admin)).find((j) => String(j.job_number) === baseDraft.jobNumber).id,
                        { name: 'Fixture Job, renamed mid-flight' });
  eq(db.prepare('select po_number from purchase_orders where request_id = ?').get(draft.id).po_number,
     generated.poNumber, 'renaming the job does not renumber an issued purchase order');

  // THE SAME NUMBER EVERYWHERE. One canonical string, consumed by the PDF, the
  // vendor email and the screens — never rebuilt by any of them.
  const view = await S.purchaseOrderView(ctx(), orderRow.id);
  eq(view.purchaseOrder.poNumber, generated.poNumber, 'the purchase order view carries the canonical number');
  const documents = db.prepare('select * from purchase_order_documents where purchase_order_id = ?').all(orderRow.id);
  check(documents.some((d) => d.filename === `${generated.poNumber}.pdf`),
        'the stored PDF is named with the canonical number');
  await S.generateVendorEmailDraft(ctx(), mike, draft.id);
  const emailDraft = db.prepare('select * from purchase_email_drafts where request_id = ?').get(draft.id);
  check(emailDraft.subject.includes(generated.poNumber), 'the vendor email subject carries the canonical number');
  check(emailDraft.body.includes(generated.poNumber), 'and so does the body');
  eq(emailDraft.draft_key, `po:${generated.poNumber}:vendor`, 'and the draft is keyed by it');
}

console.log('--- a purchase order number survives a restart -------------------');

// The counters are rows, not process state. Reopening the database file — which
// is what a restart, a container replacement and a restore all are — must
// continue the sequence rather than begin it again.
{
  const RESTART_JOB = '3131';
  await take(RESTART_JOB, graybar);
  await take(RESTART_JOB, graybar);

  const reopened = openDatabase(dbPath);
  const reopenedCtx = S.context(reopened, nowIso);
  const next = await reopenedCtx.uow.run(() =>
    S.allocatePoNumber(reopenedCtx, { orgId: DEMO_ORG_ID, jobNumber: RESTART_JOB, vendorId: graybar.id, vendorCode: graybar.code }),
  );
  eq(next.sequenceValue, 3, 'a reopened database continues the pair rather than restarting it');
  eq(next.poNumber, `${RESTART_JOB}-${graybar.code}-3`, 'and the number reads accordingly');
  reopened.close();
}

console.log('--- upgrading a database numbered the old way --------------------');

// THE MIGRATION, ON A REAL FILE WITH REAL RECORDS IN IT.
//
// An installation created before this change carries `unique (org_id,
// sequence_value)` on purchase_orders — correct while one counter served the
// whole company, and fatal now: it refuses 1234-GRAYBAR-1 because
// 1234-COOPER-1 exists. SQLite cannot ALTER a constraint away, so the table is
// REBUILT, and a rebuild that silently dropped a row, a foreign key or an index
// would be far worse damage than the constraint staying.
//
// So the fixture is not a hand-written stub: this run's own database is copied,
// wound BACK to the old shape, and then migrated forward again. Everything the
// suite has put in it — orders, line items, documents, receipts, history — goes
// through the rebuild.
{
  const legacyPath = join(TMP, 'legacy-numbering.db');
  db.exec('pragma wal_checkpoint(TRUNCATE)');
  copyFileSync(dbPath, legacyPath);

  // --- wind it back --------------------------------------------------------
  {
    const old = new DatabaseSync(legacyPath);
    old.exec('pragma foreign_keys = OFF');
    const current = old.prepare("select sql from sqlite_master where type='table' and name='purchase_orders'").get().sql;
    const downgraded = current
      .replace('purchase_orders', 'purchase_orders_old')
      .replace(/unique \(org_id, job_number, vendor_id, sequence_value\)/i, 'unique (org_id, sequence_value)')
      .replace(/\n\s*vendor_code\s+text,/i, '\n');
    const columns = old.prepare('pragma table_info(purchase_orders)').all()
      .map((c) => String(c.name)).filter((c) => c !== 'vendor_code').map((c) => `"${c}"`).join(', ');
    old.exec('begin immediate');
    old.exec(downgraded);
    // A genuinely pre-0038 database had ONE counter for the whole company, so
    // its sequence values are globally unique — that is exactly what the
    // constraint being retired was expressing, and copying today's per-pair
    // values into it would violate it on the way in. Renumbering during the
    // copy is what makes this a faithful old database rather than a new one
    // wearing an old constraint.
    //
    // `po_number` is untouched: it is what the suppliers were sent, and it is
    // what the assertions below follow through the rebuild.
    const selected = old.prepare('pragma table_info(purchase_orders)').all()
      .map((c) => String(c.name)).filter((c) => c !== 'vendor_code')
      .map((c) => (c === 'sequence_value' ? 'row_number() over (order by created_at, id)' : `"${c}"`))
      .join(', ');
    old.exec(`insert into purchase_orders_old (${columns}) select ${selected} from purchase_orders`);
    old.exec('drop table purchase_orders');
    old.exec('alter table purchase_orders_old rename to purchase_orders');
    old.exec('drop table po_job_vendor_sequences');
    old.exec('drop index if exists vendors_org_code_idx');
    old.exec('alter table vendors drop column code');
    old.exec("update schema_meta set value = '0016-purchasing-control' where key = 'version'");
    old.exec('commit');
    old.close();
  }

  const beforeOrders = (() => {
    const probe = new DatabaseSync(legacyPath);
    const rows = probe.prepare('select id, po_number, sequence_value from purchase_orders order by po_number').all()
      .map((r) => ({ ...r }));
    probe.close();
    return rows;
  })();
  check(beforeOrders.length > 0, 'the downgraded database still has the purchase orders in it');

  // --- and forward again: openDatabase() runs the migration ----------------
  const upgraded = openDatabase(legacyPath);

  const uniques = upgraded.prepare('pragma index_list(purchase_orders)').all()
    .filter((i) => Number(i.unique))
    .map((i) => upgraded.prepare(`pragma index_info(${JSON.stringify(String(i.name))})`).all()
      .map((c) => String(c.name)).sort().join(','));
  check(!uniques.includes('org_id,sequence_value'), 'the global sequence uniqueness is gone after the upgrade');
  check(uniques.includes('job_number,org_id,sequence_value,vendor_id'),
        'and the per-pair uniqueness is in its place');

  // EVERY ORDER SURVIVED, CARRYING EXACTLY THE NUMBER IT WAS SENT WITH. This is
  // the whole point of the rebuild being careful: those numbers are on
  // suppliers' paperwork.
  const afterOrders = upgraded.prepare('select id, po_number, sequence_value from purchase_orders order by po_number').all();
  eq(afterOrders.map((r) => r.po_number), beforeOrders.map((r) => r.po_number),
     'every purchase order survived the rebuild with its number unchanged');
  eq(afterOrders.map((r) => Number(r.sequence_value)), beforeOrders.map((r) => Number(r.sequence_value)),
     'and its sequence value');

  // THE FENCE SURVIVED THE REBUILD. `drop table` takes a table's triggers with
  // it, and the migration recreates the table — so the permanence guard has to
  // be carried across deliberately. If it were not, every database that had
  // just been upgraded would be the one running unguarded.
  await throws(
    () => upgraded.prepare('update purchase_orders set po_number = ? where id = ?')
      .run('TAMPERED-WITH-1', afterOrders[0].id),
    /permanent/i,
    'the purchase order number is still permanent after the rebuild',
  );
  await throws(
    () => upgraded.prepare('delete from purchase_orders where id = ?').run(afterOrders[0].id),
    /already been issued/i,
    'and it still cannot be deleted',
  );

  // The rebuild runs with foreign keys off. Anything left dangling would be
  // silent damage that only shows up when somebody prints an order.
  eq(upgraded.prepare('pragma foreign_key_check').all().length, 0, 'the rebuild left no dangling reference');
  check(
    upgraded.prepare('select count(*) as n from purchase_order_items').get().n > 0,
    'the line items are still attached to their orders',
  );

  // Vendors that predate the code column have one now, derived from the name
  // and not invented.
  const codes = upgraded.prepare('select name, code from vendors').all();
  check(codes.every((v) => /^[A-Z0-9]+$/.test(String(v.code ?? ''))),
        'every existing vendor was given a code derived from its name');
  eq(new Set(codes.map((v) => v.code)).size, codes.length, 'and no two vendors share one');

  // A NUMBER CAN BE ISSUED IMMEDIATELY AFTER THE UPGRADE, on a pair that has
  // orders under the old scheme. The counter does not exist yet, so it starts
  // at 1 — which is correct, and is exactly the case §11 says an administrator
  // must review before go-live.
  const upgradedCtx = S.context(upgraded, nowIso);
  const upgradedVendor = upgraded.prepare('select * from vendors order by name limit 1').get();
  const issuedAfter = await upgradedCtx.uow.run(() =>
    S.allocatePoNumber(upgradedCtx, {
      orgId: DEMO_ORG_ID, jobNumber: '24-118', vendorId: upgradedVendor.id, vendorCode: upgradedVendor.code,
    }),
  );
  eq(issuedAfter.sequenceValue, 1, 'a pair with no counter yet starts at 1 after the upgrade');

  // Idempotent: migrating again must not rebuild, renumber or re-code anything.
  const again = openDatabase(legacyPath);
  eq(again.prepare('select count(*) as n from purchase_orders').get().n, afterOrders.length + 0,
     'running the migration again does not disturb the orders');
  eq(again.prepare('select code from vendors where id = ?').get(upgradedVendor.id).code, upgradedVendor.code,
     'and does not re-code a vendor');
  upgraded.close();
  again.close();
}

console.log('--- SCHEMA and an UPGRADED database agree on every column -------');

// THE SECOND HALF OF THE SAME TRAP, and the one that actually cost a working
// day. `create table if not exists` does not add a column to a table that
// already exists, so a column introduced in SCHEMA and nowhere else is present
// on every NEW database and absent from every existing one.
//
// It had already happened: `purchase_approvals.self_approved` went into SCHEMA
// without a matching ALTER, and every approval on a database older than it
// failed with "no column named self_approved" — a system that could accept a
// request and never turn it into a purchase order. The suite could not see it,
// because the suite builds each database from SCHEMA and therefore always has
// the column.
//
// So this compares the two directly: what SCHEMA declares against what an
// upgraded database actually holds. It fails for the NEXT column somebody adds
// without an ALTER, which is the only way to stop this recurring.
{
  const schemaSource = readFileSync(join(APP, 'purchasing', 'infrastructure', 'sqlite', 'database.ts'), 'utf8');
  const open = schemaSource.indexOf('const SCHEMA = `') + 'const SCHEMA = `'.length;
  const schemaText = schemaSource
    .slice(open, schemaSource.indexOf('`;', open))
    .replace(/^[ \t]*--[^\n]*$/gm, '');   // comments, which can mention column names

  // A database that predates everything: created bare, then migrated. Using the
  // suite's own upgraded fixture would only prove SCHEMA agrees with itself.
  const agreePath = join(TMP, 'column-parity.db');
  const fresh = openDatabase(agreePath);

  const missing = [];
  for (const table of schemaText.matchAll(/create table if not exists (\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const name = table[1];
    const declared = [...table[2].matchAll(/^\s{2}(\w+)\s+/gm)]
      .map((m) => m[1])
      .filter((c) => !['unique', 'check', 'primary', 'foreign', 'constraint'].includes(c.toLowerCase()));
    const actual = new Set((fresh.prepare(`pragma table_info(${name})`).all()).map((c) => String(c.name)));
    for (const column of declared) if (!actual.has(column)) missing.push(`${name}.${column}`);
  }
  eq(missing, [], 'every column SCHEMA declares exists after migration');

  // And the reverse direction, which is what actually bit: a column that exists
  // on a NEW database must also arrive on an OLD one. Drop one and re-migrate.
  fresh.close();
  const aged = new DatabaseSync(agreePath);
  aged.exec('alter table purchase_approvals drop column self_approved');
  check(!aged.prepare('pragma table_info(purchase_approvals)').all().some((c) => c.name === 'self_approved'),
        'the fixture is genuinely missing the column before re-migrating');
  aged.close();

  const remigrated = openDatabase(agreePath);
  check(remigrated.prepare('pragma table_info(purchase_approvals)').all().some((c) => c.name === 'self_approved'),
        'a column missing from an existing database is added by migration, not only by CREATE TABLE');
  remigrated.close();
}

console.log('--- a trigger definition that CHANGES actually lands ------------');

// THE TRAP THIS PINS, found by running the development database rather than the
// suite. Every fence in SCHEMA is `create trigger if not exists`, which is what
// makes migration idempotent — and means a trigger whose DEFINITION changes is
// never updated on a database that already has the old one.
//
// It bit the moment the permanence fence was taught to allow one transition it
// had previously refused: the old trigger was still there, rejected the
// migration's own backfill, and the database came up degraded with
// `/api/health` reporting the purchase order number as permanent. The suite
// passed throughout, because every database it builds is new.
{
  const stalePath = join(TMP, 'stale-trigger.db');
  const built = openDatabase(stalePath);
  built.close();

  // Put a DIFFERENT definition in, standing in for last release's version.
  const tampered = new DatabaseSync(stalePath);
  tampered.exec('drop trigger if exists purchase_orders_no_delete');
  tampered.exec(`create trigger purchase_orders_no_delete
                 before delete on purchase_orders
                 begin select raise(ABORT, 'a definition from an older release'); end`);
  tampered.close();

  const reopened = openDatabase(stalePath);
  const definition = reopened
    .prepare("select sql from sqlite_master where type = 'trigger' and name = 'purchase_orders_no_delete'")
    .get().sql;
  check(!definition.includes('older release'), 'a stale trigger definition is replaced, not left in place');
  check(definition.includes('already been issued'), 'and the current definition is what the database ends up holding');
  reopened.close();
}

console.log('--- the schema version says what the schema IS ------------------');

// THE DEFECT THIS PINS. `migrate()` wrote schema_meta.version only when the row
// was absent — correct on the database it created, wrong on every database it
// upgrades. /api/health answers 503 when that row disagrees with SCHEMA_VERSION,
// so the first release to bump the version would have migrated every
// installation correctly and then reported all of them unhealthy, forever, with
// nothing actually wrong. The upgrade path is documented and was untestable by
// reading the migration, because the migration works.

const { SCHEMA_VERSION } = await import(join(APP, 'purchasing', 'infrastructure', 'sqlite', 'database.ts'));
const upgradePath = join(TMP, 'upgrade.db');
const before = openDatabase(upgradePath);
before.prepare('update schema_meta set value = ? where key = ?').run('0001-ancient', 'version');
eq(
  before.prepare('select value from schema_meta where key = ?').get('version')?.value,
  '0001-ancient',
  'a database can be made to look like it was created by an older release',
);
before.close();

// Reopening runs the same idempotent migration a redeploy runs.
const after = openDatabase(upgradePath);
eq(
  after.prepare('select value from schema_meta where key = ?').get('version')?.value,
  SCHEMA_VERSION,
  'reopening an older database stamps the version it has now been migrated TO',
);
after.close();

// --- report -----------------------------------------------------------------

db.close();
rmSync(TMP, { recursive: true, force: true });

if (PROVIDER === 'deferred') {
  check(deferredCalls() > 0, 'the deferred provider actually served this run');
}

console.log('');
console.log(`checks: ${pass} passed, ${fail} failed  (provider: ${PROVIDER})`);
if (fail > 0) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
