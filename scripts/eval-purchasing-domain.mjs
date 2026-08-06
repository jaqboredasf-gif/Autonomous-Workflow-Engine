// ---------------------------------------------------------------------------
// eval-purchasing-domain.mjs — UNIT tests for the Purchasing domain layer.
//
// No database, no filesystem, no clock, no app. It imports only
// apps/purchasing/src/purchasing/domain/** and asserts the rules that must hold
// regardless of how anything is stored or displayed:
//
//   * the six quantities stay distinct, and the derived ones are derived
//   * a request belongs to exactly one job
//   * the original request is frozen after submission
//   * purchasing fields are not expressible on a request
//   * vendor and cost are required to order, and an override records its reason
//   * the transition graph is closed and its preconditions bite
//   * every domain event names a known action and a known notification
//   * authorization denies for the right reason, in the right order
//
// The integration and end-to-end gates live in scripts/eval-purchasing.mjs;
// this file is the fast one — it fails in milliseconds when a rule is broken,
// and it names the rule rather than a symptom.
//
// Exit 0 iff every gate passes. Invoked by scripts/eval-purchasing-domain.sh.
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOMAIN = join(HERE, '..', 'apps', 'purchasing', 'src', 'purchasing', 'domain');

const E = await import(join(DOMAIN, 'entities.mjs'));
const { REQUEST_STATUSES, TRANSITIONS, TERMINAL_STATUSES, GUARD_REASONS, transitionGuard, canTransition, statusLabel } =
  await import(join(DOMAIN, 'status.mjs'));
const { authorize, permissionsFor, availableActions, PERMISSIONS, DENY_REASONS, REQUESTOR_FORBIDDEN_FIELDS } =
  await import(join(DOMAIN, 'roles.mjs'));
const N = await import(join(DOMAIN, 'numbers.mjs'));
const { domainEvent, events } = await import(join(DOMAIN, 'events.mjs'));
const { ACTIVITY_ACTIONS, NOTIFICATION_EVENTS, buildTimeline, describeActivity } =
  await import(join(DOMAIN, 'activity.mjs'));
const { EMAIL_DRAFT_TRANSITIONS, EXTERNAL_SEND_ENABLED, composeDraft, draftGuard, renderStoredTemplate } =
  await import(join(DOMAIN, 'email.mjs'));
const { validateRequestDraft, stripRequestorFields } = await import(join(DOMAIN, 'validation.mjs'));
const { isOverdue, summarize } = await import(join(DOMAIN, 'dashboard.mjs'));

let pass = 0;
let fail = 0;
const ok = () => { pass++; };
const bad = (m) => { console.log(`FAIL  ${m}`); fail++; };
const check = (cond, m) => (cond ? ok() : bad(m));
const eq = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/** Assert a DomainError with a specific reason. */
function refuses(fn, reason, m) {
  try {
    fn();
    bad(`${m} — expected refusal (${reason}) but it succeeded`);
  } catch (err) {
    if (err?.reason === reason) ok();
    else bad(`${m} — expected reason ${reason}, got ${err?.reason ?? err?.message}`);
  }
}

const K = 1000; // quantities are integer thousandths

console.log('--- value object: the six quantities ---------------------------');

const q = E.lineQuantities({ requested: 20 * K, observedStock: 6 * K, approved: 20 * K, finalOrder: 18 * K });
eq(q.requested, 20 * K, 'the requested quantity survives untouched');
eq(q.observedStock, 6 * K, 'the observed stock is its own number');
eq(q.approved, 20 * K, 'the approved quantity is its own number');
eq(q.suggested, 14 * K, 'the suggestion is approved minus stock');
eq(q.finalOrder, 18 * K, 'the final order quantity is its own number');
eq(q.stockApplied, 6 * K, 'six come off the shelf for the job');
eq(q.replenishment, 4 * K, 'four are ordered for stock, reported separately');
check(q.overridden, 'overriding the suggestion is visible as a fact');
check(Object.isFrozen(q), 'the quantities value object is immutable');

eq(E.lineQuantities({ requested: 6 * K, observedStock: 20 * K }).suggested, 0, 'the suggestion never goes negative');
eq(E.lineQuantities({ requested: 20 * K }).approved, 20 * K, 'approved defaults to what the field asked for');
eq(E.lineQuantities({ requested: 20 * K, observedStock: 5 * K }).finalOrder, 15 * K, 'final defaults to the suggestion');
eq(
  E.lineQuantities({ requested: 20 * K, observedStock: 0, finalOrder: 20 * K, received: 12 * K }).outstanding,
  8 * K,
  'outstanding is what has not yet been accounted for',
);
eq(
  E.lineQuantities({ requested: 18 * K, observedStock: 0, finalOrder: 18 * K, received: 12 * K, damaged: 2 * K, writtenOff: 4 * K }).outstanding,
  0,
  'received, damaged and written off all resolve a line',
);
refuses(() => E.lineQuantities({ requested: -1 }), 'invalid_quantity', 'a negative quantity is refused');

eq(E.money(8640), 8640, 'money passes through as whole cents');
refuses(() => E.money(-1), 'invalid_money', 'negative money is refused');
refuses(() => E.money(10.5), 'invalid_money', 'fractional cents are refused');

console.log('--- entity: purchase request -----------------------------------');

const baseItems = [{ description: '2x4 LED troffer', requestedQty: 20 * K, unit: 'ea' }];
const spec = {
  orgId: 'org', requestNumber: 'PR-01001', jobNumber: '24-118', requestorId: 'dave',
  needByDate: '2026-08-07', needByTime: '07:00', deliveryLocationId: 'loc', items: baseItems,
};

const request = E.newPurchaseRequest(spec);
eq(request.status, 'DRAFT', 'a new request starts as a draft');
eq(request.items.length, 1, 'lines are carried onto the request');
eq(request.items[0].lineNo, 1, 'lines are numbered from one');
check(Object.isFrozen(request), 'the request entity is immutable');

refuses(() => E.newPurchaseRequest({ ...spec, jobNumber: '  ' }), 'job_number_required', 'a request needs a job number');
refuses(() => E.newPurchaseRequest({ ...spec, items: [] }), 'items_required', 'a request needs at least one item');
refuses(
  () => E.newPurchaseRequest({ ...spec, items: [...baseItems, { description: 'wire', requestedQty: K, unit: 'ft', jobNumber: '24-999' }] }),
  'multiple_job_numbers',
  'ONE REQUEST BELONGS TO ONE JOB',
);
refuses(
  () => E.newPurchaseRequest({ ...spec, items: [{ description: '', requestedQty: K, unit: 'ea' }] }),
  'line_incomplete',
  'a line needs a description',
);
refuses(
  () => E.newPurchaseRequest({ ...spec, items: [{ description: 'x', requestedQty: 0, unit: 'ea' }] }),
  'line_incomplete',
  'a line needs a quantity greater than zero',
);

console.log('--- invariant: the original is frozen after submission ---------');

for (const status of ['DRAFT', 'CLARIFICATION_REQUESTED']) {
  E.assertOriginalMutable({ status });
  ok();
}
for (const status of ['PENDING_WORKSHOP_REVIEW', 'APPROVED', 'PO_GENERATED', 'ORDERED', 'COMPLETED']) {
  refuses(() => E.assertOriginalMutable({ status }), 'original_frozen', `the original is read-only in ${status}`);
}

console.log('--- invariant: purchasing fields are not a requestor concern ----');

for (const field of REQUESTOR_FORBIDDEN_FIELDS) {
  refuses(() => E.assertNoPurchasingFields({ [field]: 1 }), 'purchasing_field_on_request', `a request may not carry ${field}`);
}
check(REQUESTOR_FORBIDDEN_FIELDS.includes('priority'), 'the removed Priority field is on the forbidden list');
const stripped = stripRequestorFields({ jobNumber: '24-118', vendor_id: 'v', items: [{ description: 'x', estimated_unit_cost_cents: 5 }] });
eq(stripped.rejected.sort(), ['items.estimated_unit_cost_cents', 'vendor_id'], 'stripping reports what it removed, nested lines included');
eq(stripped.cleaned.jobNumber, '24-118', 'stripping keeps what the requestor may say');

console.log('--- entity: workshop review line -------------------------------');

const original = { id: 'item-1', lineNo: 1, description: 'troffer', unit: 'ea', requestedQty: 20 * K };
const line = E.reviewLine({
  original, observedStock: 6 * K, approved: 20 * K, finalOrder: 18 * K,
  vendorId: 'graybar', unitCostCents: 8640,
});
eq(line.original.requestedQty, 20 * K, 'the review carries the original line, unchanged');
eq(line.quantities.suggested, 14 * K, 'the review computes the suggestion');
eq(line.lineTotalCents, 155_520, '18 x $86.40 = $1,555.20, exactly');
eq(line.overrideReason, 'workshop override', 'an override without a stated reason still records one');
eq(
  E.reviewLine({ original, observedStock: 6 * K, approved: 20 * K, finalOrder: 14 * K, vendorId: 'v', unitCostCents: 1 }).overrideReason,
  null,
  'accepting the suggestion is not an override',
);
refuses(
  () => E.reviewLine({ original, observedStock: 0, finalOrder: 20 * K, unitCostCents: 100 }),
  'vendor_required',
  'a line being ordered needs a vendor',
);
refuses(
  () => E.reviewLine({ original, observedStock: 0, finalOrder: 20 * K, vendorId: 'v' }),
  'cost_required',
  'a line being ordered needs an estimated unit cost',
);
check(
  E.reviewLine({ original, observedStock: 25 * K, approved: 20 * K }).quantities.finalOrder === 0,
  'a line fully covered by stock orders nothing and needs no vendor',
);

console.log('--- entity: approval readiness and the purchase order -----------');

const ready = [line];
const { ordering, vendorIds } = E.assertReviewReadyForApproval(ready);
eq(ordering.length, 1, 'the ordering lines are identified');
eq(E.assertSingleVendor(vendorIds), 'graybar', 'one vendor, one purchase order');
refuses(() => E.assertReviewReadyForApproval([]), 'nothing_to_order', 'approving nothing is refused');
refuses(() => E.assertSingleVendor(['a', 'b']), 'single_vendor_required', 'two vendors on one PO is refused');
refuses(() => E.assertSingleVendor([null]), 'single_vendor_required', 'a missing vendor is refused');

const order = E.purchaseOrderFromReview({
  request: { id: 'r1', orgId: 'org', jobNumber: '24-118', deliveryLocationId: 'loc', deliveryMethod: 'DELIVERY', needByDate: '2026-08-07', needByTime: '07:00' },
  lines: ready, poNumber: 'LE-52901', sequenceValue: 52901, vendorId: 'graybar', approverId: 'mike', generatedBy: 'mike',
});
eq(order.estimatedTotalCents, 155_520, 'the order total is the sum of its line totals');
eq(order.items.length, 1, 'only lines being ordered reach the purchase order');
eq(order.items[0].orderQty, 18 * K, 'the order carries the FINAL quantity, not the requested one');
eq(order.jobNumber, '24-118', 'the order carries the job number');

console.log('--- invariant: completion needs every line resolved -------------');

const openProgress = [{ outstandingQty: 6 * K }, { outstandingQty: 0 }];
eq(E.outstandingLines(openProgress).length, 1, 'an unresolved line is outstanding');
refuses(() => E.assertFullyResolved(openProgress), 'lines_outstanding', 'completion is refused while a line is open');
E.assertFullyResolved([{ outstandingQty: 0 }]);
ok();

console.log('--- state transitions ------------------------------------------');

const facts = { hasReview: true, hasPurchaseOrder: true, hasReviewedEmailDraft: true, hasReceipt: true, outstandingLines: 0 };
let legal = 0;
for (const from of REQUEST_STATUSES) {
  for (const to of REQUEST_STATUSES) {
    const expected = (TRANSITIONS[from] ?? []).includes(to);
    if (canTransition(from, to) !== expected) bad(`the graph disagrees with itself on ${from} -> ${to}`);
    else if (expected) legal++;
    const guard = transitionGuard(from, to, facts);
    if (expected && !guard.ok) bad(`${from} -> ${to} is legal but the guard refused it (${guard.reason})`);
    if (!expected && guard.ok) bad(`${from} -> ${to} is illegal but the guard allowed it`);
  }
}
ok();
check(legal > 0 && legal < REQUEST_STATUSES.length ** 2, `the graph is closed, not total (${legal} legal edges)`);
for (const terminal of TERMINAL_STATUSES) {
  eq(TRANSITIONS[terminal], [], `${terminal} is terminal`);
  eq(transitionGuard(terminal, 'DRAFT', facts).reason, 'terminal_status', `nothing follows ${terminal}`);
}

eq(transitionGuard('PENDING_WORKSHOP_REVIEW', 'APPROVED', { hasReview: false }).reason, 'review_incomplete',
   'approval requires a completed review');
eq(transitionGuard('APPROVED', 'ORDERED', facts).reason, 'illegal_transition',
   'a request cannot skip the PO and the email');
eq(transitionGuard('APPROVED', 'PO_GENERATED', { ...facts, hasReview: true }).ok, true, 'an approved request may produce a PO');
eq(transitionGuard('PO_GENERATED', 'EMAIL_DRAFTED', { ...facts, hasPurchaseOrder: false }).reason, 'email_before_po',
   'A VENDOR EMAIL REQUIRES A GENERATED PO');
eq(transitionGuard('EMAIL_DRAFTED', 'ORDERED', { ...facts, hasReviewedEmailDraft: false }).reason, 'order_before_email_review',
   'the vendor email must be reviewed by a human before the order is placed');
eq(transitionGuard('ORDERED', 'RECEIVED', { ...facts, hasReceipt: false }).reason, 'receipt_missing',
   'receiving requires a recorded receipt');
eq(transitionGuard('PARTIALLY_RECEIVED', 'RECEIVED', { ...facts, outstandingLines: 2 }).reason, 'lines_outstanding',
   'a request with open lines cannot be received');
eq(transitionGuard('RECEIVED', 'COMPLETED', { ...facts, outstandingLines: 1 }).reason, 'lines_outstanding',
   'COMPLETION REQUIRES ALL ORDERED QUANTITIES RESOLVED');
eq(transitionGuard('PARTIALLY_RECEIVED', 'PARTIALLY_RECEIVED', facts).ok, true,
   'RECEIVING MAY OCCUR IN MULTIPLE PARTIAL EVENTS');
eq(transitionGuard('NOPE', 'DRAFT', facts).reason, 'unknown_status', 'an unknown status is refused');
check(
  new Set(REQUEST_STATUSES.flatMap((f) => REQUEST_STATUSES.map((t) => transitionGuard(f, t, {}).reason)).filter(Boolean))
    .size <= GUARD_REASONS.length,
  'every refusal comes from the closed guard vocabulary',
);
check(statusLabel('PENDING_WORKSHOP_REVIEW') === 'Pending Workshop Review', 'statuses render as human labels');

console.log('--- authorization ----------------------------------------------');

const dave = { id: 'dave', orgId: 'org', roles: ['REQUESTOR'], canApprove: false, isActive: true };
const karen = { id: 'karen', orgId: 'org', roles: ['OFFICE'], canApprove: false, isActive: true };
const tom = { id: 'tom', orgId: 'org', roles: ['OFFICE'], canApprove: true, isActive: true };
const mike = { id: 'mike', orgId: 'org', roles: ['WORKSHOP_APPROVER'], canApprove: true, isActive: true };
const admin = { id: 'admin', orgId: 'org', roles: ['ADMIN'], canApprove: true, isActive: true };
const queued = { id: 'r1', orgId: 'org', requestorId: 'dave', createdBy: 'dave', status: 'PENDING_WORKSHOP_REVIEW' };

eq(authorize(null, 'request.create').reason, 'no_session', 'no session, no action');
eq(authorize({ ...dave, isActive: false }, 'request.create').reason, 'inactive_user', 'a deactivated user acts on nothing');
eq(authorize(dave, 'not.a.permission').reason, 'unknown_permission', 'an unknown permission is refused, not assumed');
eq(authorize(dave, 'review.decide', { request: queued }).reason, 'missing_permission', 'A REQUESTOR CANNOT APPROVE');
eq(authorize(dave, 'review.set_vendor', { request: queued }).reason, 'missing_permission', 'VENDOR IS A WORKSHOP DECISION');
eq(authorize(dave, 'review.set_cost', { request: queued }).reason, 'missing_permission', 'COST IS A WORKSHOP DECISION');
eq(authorize(dave, 'review.record_stock', { request: queued }).reason, 'missing_permission', 'STOCK IS A WORKSHOP DECISION');
eq(authorize(karen, 'review.decide', { request: queued }).reason, 'missing_permission',
   'office cannot approve without an explicit grant');
eq(authorize(tom, 'review.decide', { request: queued }).ok, true, 'office WITH the grant can approve');
eq(authorize(mike, 'review.decide', { request: queued }).ok, true, 'the workshop approver can approve');
eq(
  authorize(mike, 'review.decide', { request: { ...queued, requestorId: 'mike', createdBy: 'mike' } }).reason,
  'self_approval',
  'A REQUESTOR CANNOT APPROVE THEIR OWN REQUEST',
);
eq(
  authorize(mike, 'review.decide', {
    request: { ...queued, requestorId: 'mike', createdBy: 'mike' },
    settings: { allowSelfApproval: true },
  }).ok,
  true,
  'a one-approver shop can allow self-approval explicitly',
);
eq(
  authorize(admin, 'review.decide', { request: { ...queued, orgId: 'other-org' } }).reason,
  'cross_tenant',
  'the tenant check fires before the role check, even for an admin',
);
eq(
  authorize(karen, 'request.respond_clarification', { request: queued }).reason,
  'not_owner',
  'only the requestor answers their own clarification',
);
eq(authorize(dave, 'request.submit', { request: queued }).reason, 'request_locked',
   'a requestor cannot touch a request once the workshop owns it');
check(permissionsFor(admin).length === PERMISSIONS.length, 'an admin holds every permission');
check(!permissionsFor(dave).includes('po.generate'), 'a requestor cannot generate a purchase order');
check(new Set(DENY_REASONS).size === DENY_REASONS.length, 'the denial vocabulary has no duplicates');

const offered = availableActions(mike, queued, {});
check(offered.includes('approve') && offered.includes('review'), 'the queue offers the workshop what it may do');
check(!availableActions(dave, queued, {}).includes('approve'), 'the UI offers a requestor nothing it would refuse');
check(availableActions(mike, { ...queued, status: 'APPROVED' }, {}).includes('generate_po'), 'an approved request offers the PO');
check(!availableActions(mike, { ...queued, status: 'REJECTED' }, {}).includes('generate_po'),
      'A REJECTED REQUEST NEVER OFFERS A PO');

console.log('--- domain events ----------------------------------------------');

check(domainEvent({ action: 'request.created', entityType: 'purchase_request' }).action === 'request.created',
      'a domain event carries its action');
let threw = false;
try { domainEvent({ action: 'nope.invented', entityType: 'x' }); } catch { threw = true; }
check(threw, 'an invented activity action is refused at construction');
threw = false;
try { domainEvent({ action: 'request.created', entityType: 'x', notify: 'nope.invented' }); } catch { threw = true; }
check(threw, 'an invented notification event is refused at construction');

const sample = {
  id: 'r1', orgId: 'org', requestNumber: 'PR-01001', status: 'PENDING_WORKSHOP_REVIEW', jobNumber: '24-118',
  needByDate: '2026-08-07', needByTime: '07:00',
};
const built = [
  events.requestCreated(sample), events.requestSubmitted(sample), events.awaitingReview(sample),
  events.approved(sample, [], 'ok'), events.rejected(sample, 'no'), events.clarificationRequested(sample, 'which floor?'),
  events.poGenerated(sample, { id: 'po', poNumber: 'LE-52901', vendorId: 'v', estimatedTotalCents: 1, items: [] }),
  events.emailDraftGenerated('r1', { id: 'd', templateKey: 'VENDOR_PURCHASE_ORDER', to: [] }, 'LE-52901'),
  events.orderPlaced(sample, null), events.receiptPartial('r1', 'rc', 1), events.receiptCompleted('r1', 'rc', '2026-08-06'),
  events.materialReady('r1'), events.requestCompleted(sample, null), events.requestCancelled(sample, 'why'),
];
check(built.every((e) => ACTIVITY_ACTIONS.includes(e.action)), 'EVERY IMPORTANT TRANSITION EMITS AN AUDITABLE EVENT');
check(built.filter((e) => e.notify).every((e) => NOTIFICATION_EVENTS.includes(e.notify)),
      'every notification an event asks for is in the contract');
check(built.every((e) => Object.isFrozen(e)), 'events are immutable once built');

const timeline = buildTimeline([
  { id: '2', at: '2026-08-03T13:05:00Z', seq: 2, action: 'decision.approved', actorName: 'Mike', previousValues: { status: 'PENDING_WORKSHOP_REVIEW' }, newValues: { status: 'APPROVED' } },
  { id: '1', at: '2026-08-03T13:00:00Z', seq: 1, action: 'request.created', actorName: 'Dave' },
  { id: '3', at: '2026-08-03T13:05:00Z', seq: 10, action: 'po.generated', actorName: 'Mike', newValues: { poNumber: 'LE-52901' } },
]);
eq(timeline.map((t) => t.id), ['1', '2', '3'], 'the timeline orders by time then sequence, numerically');
check(timeline[1].changes.some((c) => c.field === 'status'), 'a recorded change appears as a field diff');
check(timeline.every((t) => t.description.length > 0), 'every entry renders a human sentence');
check(describeActivity({ action: 'po.generated', actorName: 'Mike', details: { poNumber: 'LE-52901' } }).includes('LE-52901'),
      'the PO number appears in its own timeline line');

console.log('--- email: draft-only ------------------------------------------');

check(EXTERNAL_SEND_ENABLED === false, 'external sending is off at the source');
eq(draftGuard('GENERATED', 'SENT', {}).reason, 'illegal_transition', 'a draft cannot jump to sent');
eq(draftGuard('APPROVED_TO_SEND', 'SENT', { reviewedBy: null, markedBy: 'mike' }).reason, 'unreviewed',
   'sending is unreachable without a recorded review');
eq(draftGuard('APPROVED_TO_SEND', 'SENT', { reviewedBy: 'mike', markedBy: null }).reason, 'no_actor',
   'marking sent requires the human who sent it');
eq(draftGuard('APPROVED_TO_SEND', 'SENT', { reviewedBy: 'mike', markedBy: 'mike' }).ok, true,
   'a reviewed, approved draft can be recorded as sent by hand');
eq(EMAIL_DRAFT_TRANSITIONS.SENT, [], 'sent is terminal');
check(!('send' in composeDraft), 'composition has no send path');

const draft = composeDraft('VENDOR_PURCHASE_ORDER', {
  org: { name: 'Lippolis Electric', phone: '(914) 555-0100' },
  purchaseOrder: { poNumber: 'LE-52901', estimatedTotalCents: 155_520 },
  request: { requestNumber: 'PR-01001', jobNumber: '24-118', needByDate: '2026-08-07', needByTime: '07:00', deliveryMethod: 'DELIVERY', deliveryLocationName: 'Job site', requestorName: 'Dave' },
  vendorContact: { name: 'Angela' },
  items: [{ description: 'troffer', finalOrderQty: 18 * K, unit: 'ea', estimatedUnitCostCents: 8640 }],
  to: ['orders@example.invalid'], draftKey: 'po:LE-52901:vendor', sender: { name: 'Mike' },
});
check(draft.subject.includes('LE-52901'), 'the vendor subject carries the PO number');
check(draft.body.includes('24-118') && draft.body.includes('2026-08-07') && draft.body.includes('07:00'),
      'the vendor body carries the job number and the need-by moment');
check(draft.body.includes('$1,555.20'), 'the vendor body carries the exact total');
eq(draft.status, 'GENERATED', 'a composed draft starts as GENERATED');
eq(draft.externalSendEnabled, false, 'a composed draft records that sending is disabled');

const stored = renderStoredTemplate(
  { subject: 'PO {{purchaseOrder.poNumber}}', body: 'Job {{request.jobNumber}}\n{{itemsTable}}\nTotal {{purchaseOrder.estimatedTotal}}\n{{unknown.placeholder}}' },
  { purchaseOrder: { poNumber: 'LE-52901', estimatedTotalCents: 155_520 }, request: { jobNumber: '24-118' }, items: [{ description: 'troffer', finalOrderQty: 18 * K, unit: 'ea' }] },
);
check(stored.subject === 'PO LE-52901', 'stored templates fill scalar placeholders');
check(stored.body.includes('troffer') && stored.body.includes('$1,555.20'), 'stored templates fill the table and the money');
check(stored.body.includes('\n\n') || !stored.body.includes('{{'), 'an unknown placeholder renders empty rather than throwing');

console.log('--- numbers ----------------------------------------------------');

eq(N.parseQty('12.5').value, 12_500, 'quantities parse to exact thousandths');
eq(N.parseQty('12.5555').ok, false, 'more than three decimals is refused, not rounded');
eq(N.parseQty('-1').ok, false, 'a negative quantity is refused at the edge');
eq(N.formatQty(12_500), '12.5', 'quantities render without trailing zeros');
eq(N.parseMoney('$1,086.40').value, 108_640, 'money parses through the characters people type');
eq(N.parseMoney('10.999').ok, false, 'a third decimal on money is refused');
eq(N.formatMoney(155_520), '$1,555.20', 'money renders with separators');
eq(N.lineTotalCents(8640, 18 * K), 155_520, 'no float touches a line total');
eq(N.lineTotalCents(333, 3 * K), 999, 'exact multiplication, no drift');
eq(N.suggestedOrderQty(20 * K, 6 * K), 14 * K, 'suggested = approved - stock');
eq(N.suggestedOrderQty(6 * K, 20 * K), 0, 'SUGGESTED ORDER QUANTITY CANNOT BE NEGATIVE');
eq(N.receiptGuard({ orderedQty: 18 * K, alreadyReceivedQty: 12 * K, incomingQty: 6 * K }).ok, true, 'the balance closes a line');
eq(N.receiptGuard({ orderedQty: 18 * K, alreadyReceivedQty: 12 * K, incomingQty: 8 * K }).reason, 'over_receipt',
   'over-receipt is refused by default');
eq(N.receiptGuard({ orderedQty: 18 * K, alreadyReceivedQty: 0, incomingQty: 19 * K, override: true }).ok, true,
   'an explicit override accepts a small over-receipt');
eq(N.receiptGuard({ orderedQty: 18 * K, alreadyReceivedQty: 0, incomingQty: 100 * K, override: true }).reason,
   'over_receipt_hard_limit', 'even an override refuses an obvious typo');
eq(N.receiptGuard({ orderedQty: 18 * K, alreadyReceivedQty: 0, incomingQty: 0 }).reason, 'non_positive',
   'a zero receipt is not a receipt');

console.log('--- intake validation + dashboard ------------------------------');

const draftInput = {
  jobNumber: '24-118', needByDate: '2026-08-07', needByTime: '07:00', deliveryLocationId: 'loc',
  reason: 'rough-in', items: [{ description: 'troffer', qty: '20', unit: 'ea' }],
};
check(validateRequestDraft(draftInput).ok, 'a complete draft validates');
for (const [patch, code] of [
  [{ jobNumber: '' }, 'job_number_required'],
  [{ needByDate: '' }, 'need_by_date_required'],
  [{ needByTime: '' }, 'need_by_time_required'],
  [{ needByTime: '25:00' }, 'need_by_time_invalid'],
  [{ needByDate: '2026-13-45' }, 'need_by_date_invalid'],
  [{ deliveryLocationId: '' }, 'delivery_location_required'],
  [{ items: [] }, 'items_required'],
]) {
  check(validateRequestDraft({ ...draftInput, ...patch }).errors.some((e) => e.code === code),
        `intake refuses: ${code}`);
}

eq(isOverdue({ status: 'ORDERED', needByDate: '2026-08-06', needByTime: '07:00' }, '2026-08-06T06:59:00'), false,
   'a request is not overdue one minute before its need-by moment');
eq(isOverdue({ status: 'ORDERED', needByDate: '2026-08-06', needByTime: '07:00' }, '2026-08-06T07:01:00'), true,
   'it is overdue one minute after');
eq(isOverdue({ status: 'COMPLETED', needByDate: '2026-01-01', needByTime: '07:00' }, '2026-08-06T07:01:00'), false,
   'a completed request is never overdue');
const cards = summarize(
  [
    { status: 'PENDING_WORKSHOP_REVIEW', needByDate: '2026-08-09', needByTime: '07:00' },
    { status: 'ORDERED', needByDate: '2026-08-01', needByTime: '07:00', estimatedTotalCents: 155_520 },
    { status: 'COMPLETED', receivedAt: '2026-08-04T10:00:00Z', needByDate: '2026-08-01', needByTime: '07:00' },
  ],
  '2026-08-06T12:00:00Z',
);
eq(cards.pending_workshop_review, 1, 'the queue card counts the queue');
eq(cards.open_orders, 1, 'the open-order card counts open orders');
eq(cards.overdue_orders, 1, 'the overdue card counts the late open order only');
eq(cards.open_order_value_cents, 155_520, 'open order value sums the open orders');
eq(cards.received_this_month, 1, 'received-this-month counts by the month it arrived');

console.log('');
console.log(`domain checks: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
