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
//                          approves as the authorized backup; self-approval is
//                          refused
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
//   * audit              — every meaningful action appears on the timeline
//   * tenancy            — another org's request is not found, not forbidden
//   * the §16 demo       — the whole scenario, end to end, in order
//
// Exit 0 iff every gate passes. Invoked by scripts/eval-purchasing.sh.
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = join(ROOT, 'apps', 'purchasing', 'src');

const { openDatabase, inTransaction } = await import(join(APP, 'server', 'db.ts'));
const { seed, DEMO_ORG_ID } = await import(join(APP, 'server', 'seed.ts'));
const S = await import(join(APP, 'server', 'service.ts'));
const { suggestedOrderQty, parseQty, formatQty, formatMoney, lineTotalCents, receiptGuard } =
  await import(join(APP, 'domain', 'numbers.mjs'));
const { REQUEST_STATUSES, TRANSITIONS, GUARD_REASONS, transitionGuard } =
  await import(join(APP, 'domain', 'status.mjs'));
const { PERMISSIONS, ROLES, authorize, permissionsFor } = await import(join(APP, 'domain', 'roles.mjs'));
const { validateRequestDraft } = await import(join(APP, 'domain', 'validation.mjs'));
const { EXTERNAL_SEND_ENABLED, EMAIL_TEMPLATE_TYPES, EMAIL_DRAFT_STATUSES } =
  await import(join(APP, 'domain', 'email.mjs'));
const { ACTIVITY_ACTIONS, NOTIFICATION_EVENTS, buildTimeline } = await import(join(APP, 'domain', 'activity.mjs'));
const { summarize, isOverdue } = await import(join(APP, 'domain', 'dashboard.mjs'));

// --- harness plumbing -------------------------------------------------------

let pass = 0;
let fail = 0;
const failures = [];
const ok = () => { pass++; };
const bad = (m) => { failures.push(m); console.log(`FAIL  ${m}`); fail++; };
const check = (cond, m) => (cond ? ok() : bad(m));
const eq = (actual, expected, m) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), `${m} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);

/** Assert that `fn` throws a ServiceError whose reason is `reason`. */
function refuses(fn, reason, m) {
  try {
    fn();
    bad(`${m} — expected refusal (${reason}) but it succeeded`);
  } catch (err) {
    if (err?.reason === reason) ok();
    else bad(`${m} — expected reason ${reason}, got ${err?.reason ?? err?.message}`);
  }
}

/** Assert that `fn` throws at all, with a message matching `pattern`. */
function throws(fn, pattern, m) {
  try {
    fn();
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

const ctx = () => S.context(db, tick());

const users = Object.fromEntries(
  db.prepare('select id, email from users').all().map((u) => [u.email.split('@')[0], S.loadActor(db, u.id)]),
);
const mike = users.mike;
const rick = users.rick;
const foreman = users.dave;
const office = users.karen;
const officeApprover = users.tom;
const admin = users.admin;

const locations = S.listDeliveryLocations(ctx(), foreman);
const jobsite = locations.find((l) => l.kind === 'JOBSITE');
const vendors = S.listVendors(ctx(), mike);
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
eq(ROLES, ['REQUESTOR', 'OFFICE', 'WORKSHOP_APPROVER', 'ADMIN'], 'the four spec roles exist');
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

const created = S.createRequest(ctx(), foreman, {
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

S.submitRequest(ctx(), foreman, created.id);
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status,
   'PENDING_WORKSHOP_REVIEW', 'a submitted request enters the workshop queue');

refuses(
  () => S.submitRequest(ctx(), foreman, created.id),
  'request_locked',
  'a requestor cannot touch a request once the workshop owns it',
);
refuses(() => S.approvalQueue(ctx(), foreman), 'missing_permission', 'a requestor cannot open the approval queue');
check(S.approvalQueue(ctx(), mike).some((r) => r.id === created.id), "Mike's queue contains the request");
check(S.approvalQueue(ctx(), rick).some((r) => r.id === created.id), "Rick's queue contains the request too");

console.log('--- requestor cannot make purchasing decisions ------------------');

refuses(
  () => S.saveReview(ctx(), foreman, created.id, { lines: [] }),
  'missing_permission',
  'a requestor cannot record workshop stock',
);
refuses(
  () => S.decide(ctx(), foreman, created.id, 'APPROVE'),
  'missing_permission',
  'a requestor cannot approve a request',
);
refuses(
  () => S.decide(ctx(), office, created.id, 'APPROVE'),
  'missing_permission',
  'an office user without the grant cannot approve',
);
check(
  permissionsFor(officeApprover).includes('review.decide'),
  'an office user WITH the approval grant carries review.decide',
);
refuses(
  () => S.generatePurchaseOrder(ctx(), foreman, created.id),
  'missing_permission',
  'a requestor cannot generate a purchase order',
);

console.log('--- workshop review: the quantity algebra ----------------------');

eq(suggestedOrderQty(20_000, 6_000), 14_000, 'suggested = approved - stock');
eq(suggestedOrderQty(6_000, 20_000), 0, 'the suggestion never goes negative');
eq(suggestedOrderQty(0, 0), 0, 'nothing needed, nothing suggested');

const item = S.getRequestDetail(ctx(), mike, created.id).originalItems[0];
S.saveReview(ctx(), mike, created.id, {
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

const reviewed = S.getRequestDetail(ctx(), mike, created.id);
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

refuses(
  () => S.generatePurchaseOrder(ctx(), mike, created.id),
  'po_before_approval',
  'an unapproved request cannot produce a purchase order',
);

S.decide(ctx(), mike, created.id, 'APPROVE', { notes: 'Ordering 18 to leave four on the shelf.' });
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

const po = S.generatePurchaseOrder(ctx(), mike, created.id);
check(/^LE-\d{5}$/.test(po.poNumber), `the PO number is formatted (${po.poNumber})`);
eq(po.poNumber, 'LE-52901', 'the first PO number comes from the configured sequence');
const poRow = db.prepare('select * from purchase_orders where request_id = ?').get(created.id);
eq(Number(poRow.estimated_total_cents), 155_520, 'the PO carries the estimated total');
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'PO_GENERATED', 'the request moves to PO_GENERATED');

const doc = db.prepare('select * from purchase_order_documents where purchase_order_id = ?').get(poRow.id);
check(Boolean(doc), 'a document is stored with the purchase order');
const pdfBytes = Buffer.from(doc.data_base64, 'base64');
check(pdfBytes.subarray(0, 5).toString() === '%PDF-', 'the stored document is a real PDF');
check(pdfBytes.includes(Buffer.from('LE-52901')), 'the PDF contains the PO number');
check(pdfBytes.includes(Buffer.from('24-118')), 'the PDF contains the job number');
check(pdfBytes.includes(Buffer.from('Graybar')), 'the PDF contains the vendor');
check(pdfBytes.includes(Buffer.from('$1,555.20')), 'the PDF contains the total');
check(doc.sha256.length === 64, 'the document is hashed for evidence');
writeFileSync(join(TMP, 'sample-po.pdf'), pdfBytes);

const regenerated = S.generatePurchaseOrder(ctx(), mike, created.id);
eq(regenerated.poNumber, po.poNumber, 'regenerating returns the same permanent PO number');
eq(
  db.prepare('select next_value from po_number_sequences where org_id = ?').get(DEMO_ORG_ID).next_value,
  52902,
  'a reused PO does not burn a sequence number',
);

console.log('--- vendor email draft -----------------------------------------');

const draft = S.generateVendorEmailDraft(ctx(), mike, created.id);
const draftRow = db.prepare('select * from purchase_email_drafts where id = ?').get(draft.id);
eq(draftRow.status, 'GENERATED', 'the draft starts as GENERATED');
eq(Number(draftRow.external_send_enabled), 0, 'the draft records that sending is disabled');
check(draftRow.subject.includes('LE-52901'), 'the subject carries the PO number');
check(draftRow.body.includes('24-118'), 'the body carries the job number');
check(draftRow.body.includes('2026-08-07'), 'the body carries the need-by date');
check(draftRow.body.includes('07:00'), 'the body carries the need-by time');
check(JSON.parse(draftRow.attachments)[0].filename === 'LE-52901.pdf', 'the PO PDF is attached');
check(JSON.parse(draftRow.to_addrs)[0].endsWith('@example.invalid'), 'the recipient is a fixture address');
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'EMAIL_DRAFTED', 'the request moves to EMAIL_DRAFTED');

refuses(
  () => S.advanceEmailDraft(ctx(), mike, draft.id, 'SENT'),
  'illegal_transition',
  'a draft cannot jump straight to sent',
);
S.advanceEmailDraft(ctx(), mike, draft.id, 'REVIEWED');
refuses(
  () => S.updateEmailDraft(ctx(), mike, draft.id, { body: 'rewritten after review' }),
  'draft_frozen',
  'a reviewed draft is frozen — the review refers to those words',
);
S.advanceEmailDraft(ctx(), mike, draft.id, 'APPROVED_TO_SEND');
S.advanceEmailDraft(ctx(), mike, draft.id, 'SENT');
eq(db.prepare('select status from purchase_email_drafts where id = ?').get(draft.id).status, 'SENT',
   'a human can record that they sent it themselves');

console.log('--- ordering, tracking, receiving ------------------------------');

S.markOrdered(ctx(), mike, created.id, { notes: 'Called it in to the counter.' });
S.updateTracking(ctx(), office, created.id, { trackingNumber: '1Z999AA10123456784', carrier: 'UPS', expectedArrivalDate: '2026-08-06' });
eq(db.prepare('select tracking_number from purchase_requests where id = ?').get(created.id).tracking_number,
   '1Z999AA10123456784', 'office can add tracking');

const poItem = db.prepare('select * from purchase_order_items where purchase_order_id = ?').get(poRow.id);

refuses(
  () => S.recordReceipt(ctx(), mike, created.id, {
    receivedDate: '2026-08-05',
    lines: [{ purchaseOrderItemId: poItem.id, receivedQty: '19' }],
  }),
  'over_receipt',
  'receiving more than was ordered needs an explicit override',
);

const partial = S.recordReceipt(ctx(), mike, created.id, {
  receivedDate: '2026-08-05',
  packingSlipNumber: 'PS-88213',
  lines: [{ purchaseOrderItemId: poItem.id, receivedQty: '12' }],
});
eq(partial.outstandingLines, 1, 'a partial receipt leaves the line outstanding');
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'PARTIALLY_RECEIVED',
   'the request moves to PARTIALLY_RECEIVED');

refuses(
  () => S.completeRequest(ctx(), mike, created.id),
  'illegal_transition',
  'a partially received request cannot be completed',
);

const final = S.recordReceipt(ctx(), mike, created.id, {
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

S.completeRequest(ctx(), mike, created.id, 'Foreman collected the balance.');
eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'COMPLETED', 'the request completes');

console.log('--- over-receipt override --------------------------------------');

eq(receiptGuard({ orderedQty: 18_000, alreadyReceivedQty: 0, incomingQty: 19_000 }).reason, 'over_receipt',
   'over-receipt is refused by default');
check(receiptGuard({ orderedQty: 18_000, alreadyReceivedQty: 0, incomingQty: 19_000, override: true }).ok,
      'an explicit override accepts a small over-receipt');
eq(receiptGuard({ orderedQty: 18_000, alreadyReceivedQty: 0, incomingQty: 100_000, override: true }).reason,
   'over_receipt_hard_limit', 'even an override refuses an obvious data-entry error');

console.log('--- activity timeline ------------------------------------------');

const detail = S.getRequestDetail(ctx(), mike, created.id);
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

const rejected = S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'Second run of fixtures.' });
S.submitRequest(ctx(), foreman, rejected.id);
refuses(
  () => S.decide(ctx(), mike, rejected.id, 'REJECT'),
  'reason_required',
  'a rejection must record a reason',
);
S.saveReview(ctx(), mike, rejected.id, {
  lines: [{
    requestItemId: S.getRequestDetail(ctx(), mike, rejected.id).originalItems[0].id,
    usableStock: '25', approvedQty: '20', finalOrderQty: '0',
  }],
});
S.decide(ctx(), mike, rejected.id, 'REJECT', { reason: 'Twenty-five already on the shelf.' });
refuses(
  () => S.generatePurchaseOrder(ctx(), mike, rejected.id),
  'po_before_approval',
  'a rejected request cannot generate a purchase order',
);
refuses(
  () => S.decide(ctx(), rick, rejected.id, 'APPROVE'),
  'not_in_review',
  'a rejected request cannot be approved afterwards',
);

console.log('--- clarification path + Rick as backup approver ----------------');

const clarify = S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'Panel feeders.' });
S.submitRequest(ctx(), foreman, clarify.id);
S.decide(ctx(), rick, clarify.id, 'CLARIFY', { question: 'Which floor is this for?' });
eq(db.prepare('select status from purchase_requests where id = ?').get(clarify.id).status, 'CLARIFICATION_REQUESTED',
   'Rick can send a request back for clarification');
refuses(
  () => S.answerClarification(ctx(), office, clarify.id, 'Third floor'),
  'not_owner',
  'only the requestor answers their own clarification',
);
S.answerClarification(ctx(), foreman, clarify.id, 'Third floor, east side.');
eq(db.prepare('select status from purchase_requests where id = ?').get(clarify.id).status, 'PENDING_WORKSHOP_REVIEW',
   'an answered clarification returns to the queue');

const clarifyItem = S.getRequestDetail(ctx(), rick, clarify.id).originalItems[0];
S.saveReview(ctx(), rick, clarify.id, {
  lines: [{ requestItemId: clarifyItem.id, usableStock: '0', approvedQty: '20', finalOrderQty: '20',
            vendorId: graybar.id, estimatedUnitCost: '86.40' }],
});
S.decide(ctx(), rick, clarify.id, 'APPROVE', { notes: 'Backup approver.' });
eq(db.prepare('select status from purchase_requests where id = ?').get(clarify.id).status, 'APPROVED',
   'Rick can approve as the authorized backup');
const rickPo = S.generatePurchaseOrder(ctx(), rick, clarify.id);
eq(rickPo.poNumber, 'LE-52902', 'the next PO number is issued in sequence');

console.log('--- office approver grant --------------------------------------');

const officeReq = S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'Wire for the same job.' });
S.submitRequest(ctx(), foreman, officeReq.id);
const officeItem = S.getRequestDetail(ctx(), officeApprover, officeReq.id).originalItems[0];
S.saveReview(ctx(), officeApprover, officeReq.id, {
  lines: [{ requestItemId: officeItem.id, usableStock: '2', approvedQty: '20', finalOrderQty: '18',
            vendorId: graybar.id, estimatedUnitCost: '10.00' }],
});
S.decide(ctx(), officeApprover, officeReq.id, 'APPROVE', { notes: 'Granted approval authority.' });
eq(db.prepare('select status from purchase_requests where id = ?').get(officeReq.id).status, 'APPROVED',
   'an office user with an explicit grant can approve');

console.log('--- self-approval ----------------------------------------------');

const mikesOwn = S.createRequest(ctx(), mike, { ...baseDraft, reason: 'Workshop restock.' });
S.submitRequest(ctx(), mike, mikesOwn.id);
refuses(
  () => S.decide(ctx(), mike, mikesOwn.id, 'APPROVE'),
  'self_approval',
  'nobody decides on the request they raised',
);
S.saveReview(ctx(), rick, mikesOwn.id, {
  lines: [{ requestItemId: S.getRequestDetail(ctx(), rick, mikesOwn.id).originalItems[0].id,
            usableStock: '0', approvedQty: '20', finalOrderQty: '20', vendorId: graybar.id, estimatedUnitCost: '5.00' }],
});
S.decide(ctx(), rick, mikesOwn.id, 'APPROVE');
eq(db.prepare('select status from purchase_requests where id = ?').get(mikesOwn.id).status, 'APPROVED',
   "but the other approver can decide on their colleague's request");

console.log('--- tenant isolation + unauthorized access ---------------------');

const otherOrg = randomUUID();
const otherUser = randomUUID();
const nowIso = tick();
db.prepare('insert into orgs (id, name, created_at, updated_at) values (?,?,?,?)').run(otherOrg, 'Another Contractor LLC', nowIso, nowIso);
db.prepare('insert into users (id, org_id, full_name, email, is_active, can_approve, created_at, updated_at) values (?,?,?,?,1,1,?,?)')
  .run(otherUser, otherOrg, 'Someone Else', 'else@example.invalid', nowIso, nowIso);
db.prepare('insert into user_roles (user_id, role_key, granted_at) values (?,?,?)').run(otherUser, 'ADMIN', nowIso);
const stranger = S.loadActor(db, otherUser);

refuses(() => S.getRequestDetail(ctx(), stranger, created.id), 'not_found', "another org's request is not found");
refuses(() => S.decide(ctx(), stranger, clarify.id, 'APPROVE'), 'not_found', "another org's request cannot be approved");
check(S.listRequests(ctx(), stranger).length === 0, 'another org sees no requests');
check(
  authorize({ id: 'x', orgId: 'A', roles: ['ADMIN'], canApprove: true, isActive: true }, 'review.decide',
            { request: { id: 'r', orgId: 'B', status: 'PENDING_WORKSHOP_REVIEW' } }).reason === 'cross_tenant',
  'the tenant check fires before the role check',
);

const foremanView = S.listRequests(ctx(), foreman);
check(foremanView.every((r) => r.requestorId === foreman.id), 'a requestor sees only their own requests');
check(S.listRequests(ctx(), office).length > foremanView.length, 'office sees all requests');
refuses(
  () => S.getRequestDetail(ctx(), users.sam, created.id),
  'not_owner',
  "a field worker cannot open someone else's request",
);
refuses(() => S.auditLog(ctx(), foreman), 'missing_permission', 'a requestor cannot read the audit log');
check(S.auditLog(ctx(), admin).length > 0, 'an admin can read the audit log');
check(
  db.prepare("select count(*) c from purchase_activity_log where action = 'authz.denied'").get().c > 0,
  'refusals are recorded, not merely refused',
);

console.log('--- dashboard --------------------------------------------------');

const all = S.listRequests(ctx(), office);
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

console.log('--- PO numbering under real concurrency ------------------------');

// Eight worker threads, one database file, one sequence. If the allocation is
// not transactional, this produces a duplicate; nothing else in the harness
// would catch it.
const WORKERS = 8;
const workerSource = `
import { workerData, parentPort } from 'node:worker_threads';
const { openDatabase, inTransaction } = await import(workerData.dbModule);
const S = await import(workerData.serviceModule);
const db = openDatabase(workerData.dbPath);
const ctx = S.context(db, new Date().toISOString());
const out = [];
for (let i = 0; i < workerData.iterations; i++) {
  out.push(inTransaction(db, () => S.allocatePoNumber(ctx, workerData.orgId)).poNumber);
}
parentPort.postMessage(out);
`;
const workerFile = join(TMP, 'po-worker.mjs');
writeFileSync(workerFile, workerSource);

const results = await Promise.all(
  Array.from({ length: WORKERS }, () =>
    new Promise((resolve, reject) => {
      const w = new Worker(workerFile, {
        workerData: {
          dbPath,
          orgId: DEMO_ORG_ID,
          iterations: 5,
          dbModule: join(APP, 'server', 'db.ts'),
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
const seqAfter = db.prepare('select next_value from po_number_sequences where org_id = ?').get(DEMO_ORG_ID).next_value;
eq(
  issued.map((p) => Number(p.replace('LE-', ''))).sort((a, b) => b - a)[0] + 1,
  Number(seqAfter),
  'the sequence advanced exactly once per issued number',
);
throws(
  () => db.prepare('insert into purchase_orders (id, org_id, request_id, po_number, sequence_value, vendor_id, job_number, approver_id, delivery_location_id, delivery_method, need_by_date, need_by_time, generated_at, generated_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), DEMO_ORG_ID, clarify.id, 'LE-52901', 99999, graybar.id, '24-118', mike.id, jobsite.id, 'DELIVERY', '2026-08-07', '07:00', nowIso, mike.id, nowIso, nowIso),
  /UNIQUE/i,
  'the database itself refuses a duplicate PO number',
);

console.log('--- email cannot outrun the purchase order ---------------------');

const noPo = S.createRequest(ctx(), foreman, { ...baseDraft, reason: 'Third run.' });
refuses(
  () => S.generateVendorEmailDraft(ctx(), mike, noPo.id),
  'email_before_po',
  'a vendor email cannot be drafted without a purchase order',
);

console.log('--- migration parity (0016) ------------------------------------');

const { validate } = await import(join(ROOT, 'scripts', 'lib', 'validate-migration-0016.mjs'));
const parityProblems = await validate();
for (const p of parityProblems) bad(`migration parity: ${p}`);
check(parityProblems.length === 0, 'the SQL migration and the app agree on statuses, roles, transitions and tables');

// --- report -----------------------------------------------------------------

db.close();
rmSync(TMP, { recursive: true, force: true });

console.log('');
console.log(`checks: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
