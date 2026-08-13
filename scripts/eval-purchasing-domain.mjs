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
// The two halves of numbering: what purchasing owns (vendor codes, the job
// sanitizer, where a counter starts) and what ONE ORGANIZATION owns (the shape
// of the identifier), which now lives behind the strategy seam. Merged into one
// namespace here because these assertions predate the split and test both.
const PO = {
  ...(await import(join(DOMAIN, 'po-number.mjs'))),
  ...(await import(join(DOMAIN, '..', 'organization', 'po-numbering.mjs'))),
};
const { domainEvent, events } = await import(join(DOMAIN, 'events.mjs'));
const { ACTIVITY_ACTIONS, NOTIFICATION_EVENTS, buildTimeline, describeActivity } =
  await import(join(DOMAIN, 'activity.mjs'));
const { EXTERNAL_SEND_ENABLED, composeDraft, renderStoredTemplate } =
  await import(join(DOMAIN, 'email.mjs'));
// The draft state machine now runs on the AWE engine; its rules are asserted
// through the engine's own decide() rather than a second guard function.
const { EMAIL_DRAFT_WORKFLOW } = await import(join(DOMAIN, 'email-workflow.mjs'));
const { decide: decideDraft } = await import(join(HERE, '..', 'packages', 'workflow', 'src', 'index.mjs'));
const draftDecide = (from, to, facts = {}) => {
  const action = Object.values(EMAIL_DRAFT_WORKFLOW.actions).find((a) => a.to === to)?.name ?? to;
  return decideDraft({ workflow: EMAIL_DRAFT_WORKFLOW, action, from, facts, can: () => true });
};
const { validateRequestDraft, stripRequestorFields } = await import(join(DOMAIN, 'validation.mjs'));
const { isOverdue, summarize, purchasingStatus, receivingStatus, vendorActivity, recentPurchaseOrders } =
  await import(join(DOMAIN, 'dashboard.mjs'));
const H = await import(join(DOMAIN, 'history.mjs'));

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
  lines: ready, poNumber: '24-118-GRAYBAR-1', sequenceValue: 1, vendorId: 'graybar', vendorCode: 'GRAYBAR',
  approverId: 'mike', generatedBy: 'mike',
});
eq(order.estimatedTotalCents, 155_520, 'the order total is the sum of its line totals');
eq(order.items.length, 1, 'only lines being ordered reach the purchase order');
eq(order.items[0].orderQty, 18 * K, 'the order carries the FINAL quantity, not the requested one');
eq(order.jobNumber, '24-118', 'the order carries the job number');
eq(order.vendorCode, 'GRAYBAR', 'and the vendor code the number was built from');

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
// BR-011: approval authority supersedes requester identity. The person the
// company authorized to buy may decide the request they raised — that is what
// the authority is. A requestor still cannot, because they never held it.
eq(
  authorize(mike, 'review.decide', { request: { ...queued, requestorId: 'mike', createdBy: 'mike' } }).ok,
  true,
  'AN AUTHORIZED PURCHASER CAN APPROVE THEIR OWN REQUEST',
);
eq(
  authorize(dave, 'review.decide', { request: { ...queued, requestorId: 'dave', createdBy: 'dave' } }).reason,
  'missing_permission',
  'a request-only user cannot approve their own request either',
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

// Facts now travel with the question: approving needs a saved workshop review,
// and the screen must not offer what the server would refuse.
const offered = availableActions(mike, queued, { facts: { hasReview: true } });
check(offered.includes('approve') && offered.includes('review'), 'the queue offers the workshop what it may do');
check(!availableActions(dave, queued, { facts: { hasReview: true } }).includes('approve'), 'the UI offers a requestor nothing it would refuse');
check(availableActions(mike, { ...queued, status: 'APPROVED' }, { facts: {} }).includes('generate_po'), 'an approved request offers the PO');
check(!availableActions(mike, { ...queued, status: 'REJECTED' }, { facts: {} }).includes('generate_po'),
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
  events.poGenerated(sample, { id: 'po', poNumber: '24-118-GRAYBAR-1', vendorId: 'v', estimatedTotalCents: 1, items: [] }),
  events.emailDraftGenerated('r1', { id: 'd', templateKey: 'VENDOR_PURCHASE_ORDER', to: [] }, '24-118-GRAYBAR-1'),
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
  { id: '3', at: '2026-08-03T13:05:00Z', seq: 10, action: 'po.generated', actorName: 'Mike', newValues: { poNumber: '24-118-GRAYBAR-1' } },
]);
eq(timeline.map((t) => t.id), ['1', '2', '3'], 'the timeline orders by time then sequence, numerically');
check(timeline[1].changes.some((c) => c.field === 'status'), 'a recorded change appears as a field diff');
check(timeline.every((t) => t.description.length > 0), 'every entry renders a human sentence');
check(describeActivity({ action: 'po.generated', actorName: 'Mike', details: { poNumber: '24-118-GRAYBAR-1' } }).includes('24-118-GRAYBAR-1'),
      'the PO number appears in its own timeline line');

console.log('--- email: draft-only ------------------------------------------');

check(EXTERNAL_SEND_ENABLED === false, 'external sending is off at the source');
eq(draftDecide('GENERATED', 'SENT', {}).reason, 'illegal_transition', 'a draft cannot jump to sent');
eq(draftDecide('APPROVED_TO_SEND', 'SENT', { reviewedBy: null, markedBy: 'mike' }).reason, 'missing_evidence',
   'sending is unreachable without a recorded review');
eq(draftDecide('APPROVED_TO_SEND', 'SENT', { reviewedBy: 'mike', markedBy: null }).reason, 'missing_evidence',
   'marking sent requires the human who sent it');
eq(draftDecide('APPROVED_TO_SEND', 'SENT', { reviewedBy: 'mike', markedBy: 'mike' }).ok, true,
   'a reviewed, approved draft can be recorded as sent by hand');
eq(EMAIL_DRAFT_WORKFLOW.actionsFrom('SENT').map((a) => a.name), [], 'sent is terminal');
check(!('send' in composeDraft), 'composition has no send path');

const draft = composeDraft('VENDOR_PURCHASE_ORDER', {
  org: { name: 'Lippolis Electric', phone: '(914) 555-0100' },
  purchaseOrder: { poNumber: '24-118-GRAYBAR-1', estimatedTotalCents: 155_520 },
  request: { requestNumber: 'PR-01001', jobNumber: '24-118', needByDate: '2026-08-07', needByTime: '07:00', deliveryMethod: 'DELIVERY', deliveryLocationName: 'Job site', requestorName: 'Dave' },
  vendorContact: { name: 'Angela' },
  items: [{ description: 'troffer', finalOrderQty: 18 * K, unit: 'ea', estimatedUnitCostCents: 8640 }],
  to: ['orders@example.invalid'], draftKey: 'po:24-118-GRAYBAR-1:vendor', sender: { name: 'Mike' },
});
check(draft.subject.includes('24-118-GRAYBAR-1'), 'the vendor subject carries the PO number');
check(draft.body.includes('24-118') && draft.body.includes('2026-08-07') && draft.body.includes('07:00'),
      'the vendor body carries the job number and the need-by moment');
check(draft.body.includes('$1,555.20'), 'the vendor body carries the exact total');
eq(draft.status, 'GENERATED', 'a composed draft starts as GENERATED');
eq(draft.externalSendEnabled, false, 'a composed draft records that sending is disabled');

const stored = renderStoredTemplate(
  { subject: 'PO {{purchaseOrder.poNumber}}', body: 'Job {{request.jobNumber}}\n{{itemsTable}}\nTotal {{purchaseOrder.estimatedTotal}}\n{{unknown.placeholder}}' },
  { purchaseOrder: { poNumber: '24-118-GRAYBAR-1', estimatedTotalCents: 155_520 }, request: { jobNumber: '24-118' }, items: [{ description: 'troffer', finalOrderQty: 18 * K, unit: 'ea' }] },
);
check(stored.subject === 'PO 24-118-GRAYBAR-1', 'stored templates fill scalar placeholders');
check(stored.body.includes('troffer') && stored.body.includes('$1,555.20'), 'stored templates fill the table and the money');
check(stored.body.includes('\n\n') || !stored.body.includes('{{'), 'an unknown placeholder renders empty rather than throwing');

console.log('--- purchase order numbers: job + vendor + sequence -------------');

// `refuses` above reads DomainError.reason; these are plain Errors, because a
// malformed purchase order number is a programming fault rather than a rule a
// user broke. So the message is what there is to assert on.
const rejects = (fn, pattern, m) => {
  try {
    fn();
    bad(`${m} — expected it to throw but it returned`);
  } catch (err) {
    if (pattern.test(String(err?.message ?? ''))) ok();
    else bad(`${m} — expected /${pattern.source}/, got ${err?.message}`);
  }
};

// THE RULE, from Mike and Paul: 1234-COOPER-1, 1234-COOPER-2, 1234-GRAYBAR-1,
// 5678-COOPER-1. This section is the FORMAT and the two normalizations; the
// counting itself is the database's and is proven in eval-purchasing.mjs.

eq(PO.formatPoNumber({ jobNumber: '1234', vendorCode: 'COOPER', sequence: 1 }), '1234-COOPER-1',
   "the stakeholders' first example");
eq(PO.formatPoNumber({ jobNumber: '1234', vendorCode: 'COOPER', sequence: 2 }), '1234-COOPER-2', 'their second');
eq(PO.formatPoNumber({ jobNumber: '1234', vendorCode: 'GRAYBAR', sequence: 1 }), '1234-GRAYBAR-1',
   'a different vendor on the same job');
eq(PO.formatPoNumber({ jobNumber: '5678', vendorCode: 'COOPER', sequence: 1 }), '5678-COOPER-1',
   'the same vendor on a different job');

// NO ZERO-PADDING. The examples came from the people who write these by hand
// and they are unpadded; inventing padding would invent a format.
eq(PO.formatPoNumber({ jobNumber: '1234', vendorCode: 'COOPER', sequence: 12 }), '1234-COOPER-12',
   'a two-digit sequence is not padded');
eq(PO.FIRST_SEQUENCE, 1, 'a pair starts at one');

rejects(() => PO.formatPoNumber({ jobNumber: '', vendorCode: 'COOPER', sequence: 1 }), /job number/i,
        'a number cannot be built without a job');
rejects(() => PO.formatPoNumber({ jobNumber: '1234', vendorCode: '', sequence: 1 }), /vendor code/i,
        'nor without a vendor code');
rejects(() => PO.formatPoNumber({ jobNumber: '1234', vendorCode: 'COOP-ER', sequence: 1 }), /vendor code/i,
        'nor with a vendor code containing the separator');
rejects(() => PO.formatPoNumber({ jobNumber: '1234', vendorCode: 'COOPER', sequence: 0 }), /sequence/i,
        'nor with a sequence below one');

// THE VENDOR CODE. Derived from the display name, never abbreviated: an
// abbreviation this module invented would be a name nobody at the company chose,
// printed on a supplier's paperwork.
eq(PO.normalizeVendorCode('Cooper'), 'COOPER', 'a one-word vendor name is its own code');
eq(PO.normalizeVendorCode('Cooper Electric Supply Co.'), 'COOPERELECTRICSUPPLYCO',
   'spaces and punctuation are removed rather than abbreviated');
eq(PO.normalizeVendorCode('Rexel & Sons'), 'REXELANDSONS', 'an ampersand is spelled out');
eq(PO.normalizeVendorCode('Nuñez Supply'), 'NUNEZSUPPLY', 'an accent is folded, not dropped with its letter');
eq(PO.normalizeVendorCode('Graybar-Electric'), 'GRAYBARELECTRIC',
   'a hyphen is removed — it is the separator, and a code containing one would break the number');
check(PO.normalizeVendorCode('A'.repeat(50)).length === PO.VENDOR_CODE_MAX, 'a very long name is bounded');

// Collisions are made VISIBLE rather than resolved by inventing a second
// abbreviation: COOPER2 is legible as "the second Cooper", and the office can
// go and give it a proper code.
eq(PO.assignVendorCode('Cooper', []), 'COOPER', 'the first vendor of a name gets the plain code');
eq(PO.assignVendorCode('Cooper', ['COOPER']), 'COOPER2', 'a second one is suffixed');
eq(PO.assignVendorCode('Cooper', ['COOPER', 'COOPER2']), 'COOPER3', 'and a third');
eq(PO.assignVendorCode('Cooper', ['COOPER']), 'COOPER2', 'and the derivation is deterministic — running it twice agrees');
eq(PO.assignVendorCode('!!!', []), 'VENDOR', 'a name with nothing usable in it still yields a code');

// THE JOB SEGMENT. Lippolis job numbers already contain a hyphen (24-118) and
// that hyphen is theirs — it stays.
eq(PO.normalizeJobSegment('24-118'), '24-118', "the office's own hyphen is preserved");
eq(PO.normalizeJobSegment(' 24-118 '), '24-118', 'surrounding whitespace is not part of a job number');
eq(PO.normalizeJobSegment('24 118'), '24118', 'a space inside one is removed');
eq(PO.normalizeJobSegment('24--118'), '24-118', 'a doubled separator is collapsed');
eq(PO.normalizeJobSegment('-24-118-'), '24-118', 'and it cannot start or end with the separator');

// PARSING BACK. The job may contain hyphens and the vendor code may not, so the
// identifier is split from the RIGHT and the job takes what is left.
eq(PO.parsePoNumber('1234-COOPER-1'), { jobNumber: '1234', vendorCode: 'COOPER', sequence: 1 },
   'a number parses back into its three components');
eq(PO.parsePoNumber('24-118-GRAYBAR-7'), { jobNumber: '24-118', vendorCode: 'GRAYBAR', sequence: 7 },
   'and so does one whose job number contains the separator');
eq(PO.parsePoNumber('24-118-graybar-7'), { jobNumber: '24-118', vendorCode: 'GRAYBAR', sequence: 7 },
   'parsing is case-insensitive — a person typed this');
check(PO.parsePoNumber('LE-52901') === null, 'a number from the retired global scheme does not parse as one of these');
check(PO.parsePoNumber('1234-COOPER-x') === null, 'a non-numeric sequence is not a purchase order number');
check(PO.parsePoNumber('1234-COOPER') === null, 'nor is a number with a component missing');
check(PO.parsePoNumber('') === null, 'nor is nothing at all');

// Round trip, on the shapes that actually occur.
for (const [job, code, seq] of [['1234', 'COOPER', 1], ['24-118', 'GRAYBARELECTRIC', 42], ['9', 'A', 1]]) {
  const text = PO.formatPoNumber({ jobNumber: job, vendorCode: code, sequence: seq });
  eq(PO.parsePoNumber(text), { jobNumber: job, vendorCode: code, sequence: seq }, `${text} survives a round trip`);
}

// A CODE AN ADMINISTRATOR TYPED has to be told why it is not acceptable.
check(PO.validateVendorCode('COOPER').ok, 'a plain code is accepted');
eq(PO.validateVendorCode(' cooper ').value, 'COOPER', 'and is normalized to upper case');
check(!PO.validateVendorCode('').ok, 'an empty code is refused');
check(!PO.validateVendorCode('CO-OP').ok, 'a code containing the separator is refused');
check(!PO.validateVendorCode('CO OP').ok, 'a code containing a space is refused');
check(!PO.validateVendorCode('A'.repeat(40)).ok, 'an over-long code is refused');

// LINING A PAIR UP WITH THE PAPER BOOK. Either the last one issued or the next
// one — both are things a person knows — and exactly one of them.
eq(PO.planSequenceInitialization({ lastIssuedSequence: 3 }).nextValue, 4,
   'the last issued number means the next one is one higher');
eq(PO.planSequenceInitialization({ nextSequence: 4 }).nextValue, 4, 'or the next number is given directly');
eq(PO.planSequenceInitialization({ lastIssuedSequence: 0 }).nextValue, 1,
   'a pair whose paper sequence has issued nothing starts at one');
check(!PO.planSequenceInitialization({}).ok, 'saying neither is refused');
check(!PO.planSequenceInitialization({ lastIssuedSequence: 3, nextSequence: 9 }).ok, 'saying both is refused');
check(!PO.planSequenceInitialization({ nextSequence: 0 }).ok, 'zero is not a next number');
check(!PO.planSequenceInitialization({ nextSequence: 'four' }).ok, 'nor is a word');
check(!PO.planSequenceInitialization({ lastIssuedSequence: -1 }).ok, 'nor is a negative last number');

// NEVER BACKWARDS OVER WHAT PCC ITSELF HAS ISSUED. That number is already on a
// supplier's paperwork.
eq(PO.planSequenceInitialization({ nextSequence: 6, issuedSequence: 5 }).nextValue, 6,
   'a starting point above everything issued is allowed');
eq(PO.planSequenceInitialization({ nextSequence: 5, issuedSequence: 5 }).reason, 'sequence_rewind',
   'a starting point ON an issued number is refused');
eq(PO.planSequenceInitialization({ nextSequence: 2, issuedSequence: 5 }).reason, 'sequence_rewind',
   'and so is one below it');
check(PO.planSequenceInitialization({ nextSequence: 5, issuedSequence: 5 }).message.includes('6'),
      'and the refusal says what the smallest acceptable number is');

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

console.log('--- catalog normalization (history substrate) ------------------');

const C = await import(join(DOMAIN, 'catalog.mjs'));

// The point of normalization: the same item, typed by four people on four days,
// collapses to one key — so a catalog, autocomplete and ranking are possible
// later without reprocessing history that was never captured.
const SAME = ['2x4 LED Troffer 4000K', '2X4 led troffer, 4000k', '2 x 4  LED   Troffer (4000K)', '2x4 LED troffer 4000K!'];
const key = C.normalizeDescription(SAME[0]);
for (const variant of SAME) {
  eq(C.normalizeDescription(variant), key, `"${variant}" normalizes to the same key`);
}

// ...and things that are genuinely different stay different. A normalizer that
// over-collapses is worse than none: it merges 3500K into 4000K silently.
check(!C.isSameItem('2x4 LED troffer 4000K', '2x4 LED troffer 3500K'), 'a different colour temperature is a different item');
check(!C.isSameItem('1/2 in EMT conduit', '3/4 in EMT conduit'), 'a different size is a different item');

// DECISION: word order is NOT normalized away. Sorting the tokens would make
// "1/2 to 3/4 reducer" and "3/4 to 1/2 reducer" the same entry, and those are
// two different fittings. A reordered description therefore produces a second
// catalog entry — which a human can merge later with the evidence in front of
// them. Over-collapsing is the more expensive mistake: it is silent.
check(!C.isSameItem('1/2 to 3/4 reducer', '3/4 to 1/2 reducer'),
      'word order is preserved — a reducer is directional');
check(!C.isSameItem('LED troffer 2x4', '2x4 LED troffer'),
      'a reordered description is a separate entry rather than a silent merge');
check(C.isSameItem('1/2 in EMT conduit', '1/2 IN emt Conduit'), 'case and spacing do not make a different item');
check(C.isSameItem('Válvula de bola', 'Valvula de bola'), 'accents fold — the interface will be Spanish as well as English');
eq(C.normalizeDescription('   '), '', 'an empty description has no key rather than a blank one');
eq(C.normalizeDescription(null), '', 'a missing description does not throw');

// Fractions and decimals carry meaning in a materials description and survive.
check(C.normalizeDescription('1/2 in EMT').includes('1/2'), 'a fraction survives normalization');
check(C.normalizeDescription('#12 THHN 500 ft').includes('500'), 'a quantity in the text survives');

const entry = C.catalogKeyFor({ orgId: 'org-a', description: '  2x4 LED Troffer 4000K ', unit: 'ea', vendorId: 'v1' });
eq(entry.orgId, 'org-a', 'a catalog entry belongs to an organization');
eq(entry.canonicalDescription, '2x4 LED Troffer 4000K', 'the canonical form keeps what the person actually typed');
eq(entry.normalizedDescription, key, 'the entry is keyed on the normalized form');
eq(entry.normalizerVersion, C.NORMALIZER_VERSION, 'the entry records which rules produced it');
eq(C.catalogKeyFor({ orgId: 'o', description: '' }), null, 'nothing to match on is not a catalog entry');

// Cross-tenant: the same item in two organizations is two entries, and the
// organization is part of the key rather than a filter applied afterwards.
const a = C.catalogKeyFor({ orgId: 'org-a', description: '2x4 LED troffer' });
const b = C.catalogKeyFor({ orgId: 'org-b', description: '2x4 LED troffer' });
eq(a.normalizedDescription, b.normalizedDescription, 'two organizations can buy the same thing');
check(a.orgId !== b.orgId, 'and their catalog entries are still separate rows');

// The fields history must preserve for the future features to be possible.
for (const field of ['orgId', 'normalizedDescription', 'description', 'quantity', 'unit',
                     'vendorId', 'jobNumber', 'estimatedUnitCostCents', 'actualUnitCostCents',
                     'receivedQty', 'orderedAt']) {
  check(C.HISTORY_FIELDS.includes(field), `history preserves ${field}`);
}

// --- autocomplete order: exact, alias, frequent, recent --------------------
//
// The handoff states this priority, and it is the whole difference between an
// autocomplete people trust and one they fight. Ranking lives in the domain so
// that a future QuickBooks or spreadsheet adapter cannot quietly reorder it.
{
  const entry = (over) => ({
    canonicalDescription: '', normalizedDescription: '', aliases: [], catalogNumber: null,
    timesRequested: 0, lastRequestedAt: null, isActive: true, ...over,
  });
  const exact = entry({
    canonicalDescription: 'MC cable', normalizedDescription: C.normalizeDescription('MC cable'),
    timesRequested: 1, lastRequestedAt: '2026-01-01T00:00:00Z',
  });
  const aliased = entry({
    canonicalDescription: 'Metal clad cable 12/2', normalizedDescription: C.normalizeDescription('Metal clad cable 12/2'),
    aliases: ['MC cable'], timesRequested: 5, lastRequestedAt: '2026-08-01T00:00:00Z',
  });
  const frequent = entry({
    canonicalDescription: 'MC cable 12/3 250ft', normalizedDescription: C.normalizeDescription('MC cable 12/3 250ft'),
    timesRequested: 90, lastRequestedAt: '2026-02-01T00:00:00Z',
  });
  const recent = entry({
    canonicalDescription: 'MC cable 10/2 coil', normalizedDescription: C.normalizeDescription('MC cable 10/2 coil'),
    timesRequested: 2, lastRequestedAt: '2026-08-09T00:00:00Z',
  });

  const ranked = C.rankMaterialMatches([recent, frequent, aliased, exact], 'MC cable', 8);
  eq(ranked[0].canonicalDescription, 'MC cable', 'autocomplete 1: an exact match wins, however rarely it is bought');
  eq(ranked[1].canonicalDescription, 'Metal clad cable 12/2', "autocomplete 2: the organization's own alias comes next");
  eq(ranked[2].canonicalDescription, 'MC cable 12/3 250ft', 'autocomplete 3: then what is bought most often');
  eq(ranked[3].canonicalDescription, 'MC cable 10/2 coil', 'autocomplete 4: then what was bought most recently');
  eq(C.rankMaterialMatches([recent, frequent], 'MC cable', 1).length, 1, 'the limit is honoured');
  eq(C.rankMaterialMatches([], 'anything').length, 0, 'an empty catalogue suggests nothing');

  // A part number is an identifier, not prose: typing it lands on that part
  // rather than on the popular thing whose description contains it.
  const byNumber = entry({ canonicalDescription: 'Breaker 20A', catalogNumber: 'QO120', timesRequested: 0 });
  const popular = entry({ canonicalDescription: 'QO120 breaker assortment', normalizedDescription: C.normalizeDescription('QO120 breaker assortment'), timesRequested: 400 });
  eq(C.rankMaterialMatches([popular, byNumber], 'QO120')[0].canonicalDescription, 'Breaker 20A',
     'an exact catalogue number beats a popular description that merely contains it');
}

console.log('--- material import (the authoritative spreadsheet) ------------');

const MI = await import(join(DOMAIN, 'material-import.mjs'));

// Header mapping tolerates how people actually label columns.
{
  const { mapping } = MI.mapColumns(['Material ID', 'Description', 'Mfr. Part #', 'UOM', 'Preferred Vendor']);
  eq(mapping.materialId, 0, 'an ID column is recognised');
  eq(mapping.canonicalDescription, 1, 'the description column is recognised');
  eq(mapping.manufacturerPartNumber, 2, 'punctuation and spacing in a header do not matter');
  eq(mapping.unit, 3, 'UOM is a unit column');
  eq(mapping.preferredVendor, 4, 'a preferred vendor column is recognised');

  const missing = MI.normalizeMaterialImport([['Thing', 'Qty'], ['a', '1']]);
  eq(missing.records.length, 0, 'without a description column nothing is imported');
  eq(missing.problems[0].code, 'no_description_column', 'and the reason is stated rather than guessed at');
}

// Units collapse to one vocabulary so quantities can be compared.
eq(MI.normalizeUnit('Each'), 'EA', 'each is EA');
eq(MI.normalizeUnit('ft.'), 'FT', 'a trailing period does not make a new unit');
eq(MI.normalizeUnit(''), null, 'a blank unit is unknown, not a default');
eq(MI.parseMoneyCents('$1,250.50'), 125_050, 'money survives currency symbols and separators');
eq(MI.parseMoneyCents(''), null, 'an empty price is unknown rather than free');
eq(MI.parseMoneyCents('call for pricing'), null, 'an unreadable price is unknown rather than zero');

// A description containing a comma must not shift every column after it.
{
  const rows = MI.parseDelimited('Description,Unit\n"Cable, 12/2, 250ft",EA\n');
  eq(rows[1][0], 'Cable, 12/2, 250ft', 'a quoted comma stays inside its field');
  eq(rows[1][1], 'EA', 'and the next column is still the next column');
}

// The whole normalization, on a sheet with the problems real sheets have.
{
  const table = [
    ['Material ID', 'Description', 'Aliases', 'UOM', 'Category', 'Last Price', 'Active', 'Notes'],
    ['M-1', '2x4 LED Troffer 4000K', 'troffer; 2x4 led', 'Each', 'Lighting', '$89.50', 'Yes', 'ignored'],
    ['M-2', '  ', 'nothing', 'EA', 'Lighting', '', 'Yes', ''],
    ['M-3', '2X4 led troffer, 4000k', '', 'ea', 'Lighting', '90', 'Yes', ''],
    ['M-4', '1/2 in EMT conduit', 'half inch emt', 'FT', 'Conduit', '', 'No', ''],
    ['', '', '', '', '', '', '', ''],
  ];
  const out = MI.normalizeMaterialImport(table);
  eq(out.records.length, 2, 'two real materials are imported');
  eq(out.records[0].aliases.length, 2, 'aliases split on the separators people actually use');
  eq(out.records[0].unit, 'EA', 'units are normalized on the way in');
  eq(out.records[0].lastUnitCostCents, 8_950, 'the last price is captured as cents');
  eq(out.records[1].active, false, 'an inactive row is imported as inactive rather than dropped');
  eq(out.problems.find((p) => p.code === 'missing_description').row, 3,
     'a row with no description is reported with its SPREADSHEET row number');
  eq(out.problems.find((p) => p.code === 'duplicate_material').row, 4,
     'a re-typed duplicate is reported rather than silently merged or double-imported');
  check(out.problems.find((p) => p.code === 'duplicate_material').message.includes('row 2'),
        'and the duplicate names the row it collides with, so the sheet can be fixed');
  check(out.unmappedColumns.some((c) => c.header === 'Notes'),
        'an unrecognised column is reported — a column nobody mapped is how an import silently loses data');
  eq(MI.normalizeMaterialImport([]).records.length, 0, 'an empty sheet imports nothing and does not throw');
}

console.log('--- internationalization seam ----------------------------------');

// The product will ship English and Spanish. Identifiers are never translated;
// display text is a key the presentation layer resolves. The domain must not
// be the place English lives.
const { statusMessageKey } = await import(join(DOMAIN, 'status.mjs'));
const { activityMessage } = await import(join(DOMAIN, 'activity.mjs'));

eq(statusMessageKey('PENDING_WORKSHOP_REVIEW'), 'purchasing.status.PENDING_WORKSHOP_REVIEW',
   'a status resolves to a translation key, not a sentence');
check(REQUEST_STATUSES.every((s) => statusMessageKey(s).startsWith('purchasing.status.')),
      'every status has a translation key');

const message = activityMessage({ action: 'po.generated', actorName: 'Mike', details: { poNumber: '24-118-GRAYBAR-1' } });
eq(message.key, 'purchasing.activity.po.generated', 'a timeline entry resolves to a key');
eq(message.params.poNumber, '24-118-GRAYBAR-1', 'with the values to interpolate, rather than a built sentence');
eq(message.params.actor, 'Mike', 'including who did it');
check(ACTIVITY_ACTIONS.every((a) => activityMessage({ action: a }).key.startsWith('purchasing.activity.')),
      'every recorded action has a translation key');

console.log('--- immutable history: the rules both providers share ----------');

// domain/history.mjs decides what a history row SAYS. Both providers only write
// it, so every rule that could differ between them is checked here.

// --- the outcome vocabulary, and its precedence -----------------------------
// An exception outranks a completion: a line fully received WITH a damaged unit
// is a line something went wrong on, and that is what a reader needs to see.
// The quantities beside it still say exactly how much of each.
eq(H.receiptOutcome({ orderedQty: 0, receivedQty: 0 }), 'NOT_ORDERED',
   'a line that never became an order line is NOT_ORDERED');
eq(H.receiptOutcome({ orderedQty: 10 * K, receivedQty: 10 * K }), 'RECEIVED', 'everything arrived');
eq(H.receiptOutcome({ orderedQty: 10 * K, receivedQty: 4 * K }), 'PARTIALLY_RECEIVED', 'some of it arrived');
eq(H.receiptOutcome({ orderedQty: 10 * K, receivedQty: 0 }), 'NOT_RECEIVED', 'none of it arrived');
eq(H.receiptOutcome({ orderedQty: 10 * K, receivedQty: 6 * K, backorderedQty: 4 * K }), 'BACKORDERED',
   'an outstanding backorder is what the reader needs first');
eq(H.receiptOutcome({ orderedQty: 10 * K, receivedQty: 9 * K, damagedQty: 1 * K }), 'DAMAGED',
   'damage outranks the fact that the rest arrived');
eq(H.receiptOutcome({ orderedQty: 10 * K, receivedQty: 9 * K, damagedQty: 1 * K, writtenOffQty: 1 * K }), 'WRITTEN_OFF',
   'a write-off outranks damage');
check(H.RECEIPT_OUTCOMES.length === 7, 'the outcome vocabulary is closed');

// --- cancellation and rejection: the policy, as executable rules ------------
const orderedLine = {
  terminalState: 'COMPLETED', orderedAt: '2026-08-05T10:00:00.000Z', receivedAt: '2026-08-08T10:00:00.000Z',
  orderedQty: 10 * K, estimatedUnitCostCents: 8640, actualUnitCostCents: null, vendorName: 'Graybar',
};
const rejectedLine = { terminalState: 'REJECTED', orderedAt: null, orderedQty: 0, estimatedUnitCostCents: 8640 };
const cancelledBeforeOrder = { terminalState: 'CANCELLED', orderedAt: null, orderedQty: 5 * K, estimatedUnitCostCents: 100 };
const cancelledAfterOrder = {
  terminalState: 'CANCELLED', orderedAt: '2026-08-05T10:00:00.000Z', receivedAt: null,
  orderedQty: 5 * K, estimatedUnitCostCents: 12_000,
};

check(H.countsTowardPricing(orderedLine), 'a completed order informs price');
check(!H.countsTowardPricing(rejectedLine), 'a REJECTED request never reached a vendor, so it informs no price');
check(!H.countsTowardPricing(cancelledBeforeOrder),
      'a cancellation before the order was placed informs no price either');
check(H.countsTowardPricing(cancelledAfterOrder),
      'a cancellation AFTER the order was placed is real price evidence — the money was committed');
check(!H.countsTowardPricing({ ...orderedLine, estimatedUnitCostCents: null, actualUnitCostCents: null }),
      'a line with no price at all informs no price');
check(!H.countsTowardPurchaseFrequency(rejectedLine) && !H.countsTowardPurchaseFrequency(cancelledBeforeOrder),
      'neither inflates a purchase-frequency count');
check(H.countsTowardDemand(rejectedLine), 'but both are still DEMAND — somebody asked for the material');
eq(H.evidencedUnitCostCents({ estimatedUnitCostCents: 8640, actualUnitCostCents: 9000 }), 9000,
   'the invoice wins over the estimate when both are known');
eq(H.evidencedUnitCostCents({ estimatedUnitCostCents: null, actualUnitCostCents: null }), null,
   'and unknown stays unknown, never 0');

// --- lead time is reported only where it is measurable ----------------------
eq(H.leadTimeDays(orderedLine), 3, 'lead time is ordered-to-received in whole days');
eq(H.leadTimeDays(cancelledAfterOrder), null, 'a line that never arrived reports NO lead time — not a zero');
eq(H.leadTimeDays(rejectedLine), null, 'nor does one that was never ordered');
eq(H.leadTimeDays({ orderedAt: '2026-08-08T10:00:00.000Z', receivedAt: '2026-08-05T10:00:00.000Z' }), null,
   'and an impossible interval reports nothing rather than a negative number');

// --- building a row ---------------------------------------------------------
const historyInput = {
  request: {
    id: 'req-1', orgId: 'org-1', requestNumber: 'PR-01001', jobNumber: '24-118', requestorId: 'u-dave',
    approverId: 'u-mike', createdAt: '2026-08-03T13:00:00.000Z', orderedAt: '2026-08-05T10:00:00.000Z',
    receivedAt: '2026-08-08T10:00:00.000Z', completedAt: '2026-08-08T12:00:00.000Z',
  },
  requestItems: [{ id: 'ri-1', lineNo: 1, description: '2x4 LED Troffer 4000K', requestedQty: 20 * K, unit: 'ea' }],
  reviewLines: [{ requestItemId: 'ri-1', vendorId: 'v-1', vendorName: 'IGNORED WHEN ORDERED', estimatedUnitCostCents: 1 }],
  order: { id: 'po-1', poNumber: '24-118-GRAYBAR-1', vendorId: 'v-1', generatedAt: '2026-08-04T09:00:00.000Z' },
  orderItems: [{
    id: 'oi-1', request_item_id: 'ri-1', description: '2x4 LED Troffer 4000K', substitute_description: null,
    normalized_description: '2x4 led troffer 4000k', catalog_item_id: 'cat-1', order_qty: 18 * K, unit: 'ea',
    unit_cost_cents: 8640, line_total_cents: 155_520, actual_unit_cost_cents: null,
  }],
  progress: [{ requestItemId: 'ri-1', receivedQty: 18 * K, damagedQty: 0, backorderedQty: 0, writtenOffQty: 0 }],
  vendor: { id: 'v-1', name: 'Graybar Electric' },
  job: { id: 'job-1', jobNumber: '24-118' },
  requestor: { id: 'u-dave', name: 'Dave Foreman' },
  approver: { id: 'u-mike', name: 'Mike Purchaser' },
  terminalState: 'COMPLETED', terminalReason: null,
  recordedAt: '2026-08-08T12:00:00.000Z', recordedBy: 'u-mike',
};

const historyRow = H.buildHistoryLines(historyInput);
eq(historyRow.length, 1, 'one row per request line');
for (const field of H.HISTORY_LINE_FIELDS) {
  check(field in historyRow[0], `the historyRow row carries ${field}`);
}
eq(historyRow[0].vendorName, 'Graybar Electric', 'the vendor name is snapshotted from the order, not the review');
eq(historyRow[0].requestedQty, 20 * K, 'what was asked for is preserved');
eq(historyRow[0].orderedQty, 18 * K, 'and what was actually ordered is a different number, also preserved');
eq(historyRow[0].outcome, 'RECEIVED', 'the outcome is classified from the quantities');
eq(historyRow[0].normalizedDescription, '2x4 led troffer 4000k',
   'the matching key is the one the line was MATCHED under, not one recomputed now');
eq(historyRow[0].normalizerVersion, 1, 'and the normalizer version in force is recorded beside it');
eq(historyRow[0].poGeneratedAt, '2026-08-04T09:00:00.000Z', 'PO generation is kept');
eq(historyRow[0].orderedAt, '2026-08-05T10:00:00.000Z', 'separately from when the order was actually placed');

// PURE: same input, same output, and the input is not touched.
const inputBefore = JSON.stringify(historyInput);
eq(JSON.stringify(H.buildHistoryLines(historyInput)), JSON.stringify(historyRow), 'building twice gives the same rows');
eq(JSON.stringify(historyInput), inputBefore, 'and building does not mutate what it was given');

// A line the workshop filled from stock never became an order line, and is
// still part of what happened.
const fromStock = H.buildHistoryLines({
  ...historyInput,
  requestItems: [...historyInput.requestItems, { id: 'ri-2', lineNo: 2, description: 'wire nuts', requestedQty: 5 * K, unit: 'box' }],
  reviewLines: [...historyInput.reviewLines,
                { requestItemId: 'ri-2', vendorId: 'v-9', vendorName: 'Workshop shelf', estimatedUnitCostCents: 500 }],
});
eq(fromStock.length, 2, 'a line filled entirely from stock still gets a history row');
eq(fromStock[1].outcome, 'NOT_ORDERED', 'and reads as NOT_ORDERED');
eq(fromStock[1].orderedDescription, null, 'with no ordered description, because it was never ordered');
// The request HAS a purchase order — for its other line. Naming that vendor
// here would claim this material came from them, which it did not.
eq(fromStock[1].vendorName, 'Workshop shelf',
   'a line that never became an order line records the vendor the workshop had chosen, not the order\'s vendor');
eq(fromStock[0].vendorName, 'Graybar Electric', 'while the ordered line on the same request names the vendor it came from');

// A substitute is a different item and history must be able to see that.
const substituted = H.buildHistoryLines({
  ...historyInput,
  orderItems: [{ ...historyInput.orderItems[0], substitute_description: 'Lithonia 2x4 4000K' }],
});
eq(substituted[0].requestedDescription, '2x4 LED Troffer 4000K', 'what was asked for');
eq(substituted[0].orderedDescription, 'Lithonia 2x4 4000K', 'and what was actually bought instead');

refuses(() => H.buildHistoryLines({ ...historyInput, terminalState: 'ORDERED' }), 'history_before_terminal',
        'history cannot be written for a request that has not ended');
refuses(() => H.buildHistoryLines({ ...historyInput, request: null }), 'history_without_request',
        'nor without the request it describes');
eq(H.HISTORY_TERMINAL_STATES.length, 3, 'there are exactly three states history is written in');

// --- the derived read model -------------------------------------------------
const summary = H.summarizeMaterial([
  { ...orderedLine, normalizedDescription: 'troffer', orderedAt: '2026-08-05T10:00:00.000Z', estimatedUnitCostCents: 8000 },
  { ...orderedLine, normalizedDescription: 'troffer', orderedAt: '2026-08-09T10:00:00.000Z',
    receivedAt: '2026-08-12T10:00:00.000Z', estimatedUnitCostCents: 9000, vendorId: 'v-2', vendorName: 'Rexel' },
  { ...rejectedLine, normalizedDescription: 'troffer' },
]);
eq(summary.timesPurchased, 2, 'only ordered lines are purchases');
eq(summary.timesRequested, 3, 'but every line is demand');
eq(summary.lastVendorName, 'Rexel', 'the last vendor is the most recently ORDERED one');
eq(summary.averageUnitCostCents, 8500, 'the average is over priced, ordered lines only');
eq(summary.priceSampleSize, 2, 'and it is reported with its sample size — an average of one is not a trend');
eq(summary.averageLeadTimeDays, 3, 'lead time averages only the measurable lines');
eq(summary.leadTimeSampleSize, 2, 'with its own sample size');
eq(H.summarizeMaterial([]).averageUnitCostCents, null, 'no observations means no number, never 0');

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

// --- the dashboard's operational panels ------------------------------------
//
// The rule these guard is "never fabricate analytics". Each function may only
// count, sum or sort what it was handed, so the tests that matter most are the
// EMPTY ones: given nothing, a panel must produce nothing rather than a
// confident zero-shaped story.
{
  const NOW = '2026-08-06T12:00:00Z';
  const fleet = [
    { id: 'a', requestNumber: 'PR-1', jobNumber: '24-118', status: 'PENDING_WORKSHOP_REVIEW', estimatedTotalCents: 0 },
    { id: 'b', requestNumber: 'PR-2', jobNumber: '24-118', status: 'APPROVED', estimatedTotalCents: 50_000 },
    { id: 'c', requestNumber: 'PR-3', jobNumber: '25-007', status: 'ORDERED', poNumber: 'LE-00003',
      vendorId: 'v-gray', vendorName: 'Graybar', estimatedTotalCents: 120_000,
      orderedAt: '2026-08-03T09:00:00Z', needByDate: '2026-08-01', needByTime: '07:00' },
    { id: 'd', requestNumber: 'PR-4', jobNumber: '25-007', status: 'PARTIALLY_RECEIVED', poNumber: 'LE-00004',
      vendorId: 'v-gray', vendorName: 'Graybar', estimatedTotalCents: 30_000,
      orderedAt: '2026-08-05T09:00:00Z', needByDate: '2026-08-20', needByTime: '07:00' },
    { id: 'e', requestNumber: 'PR-5', jobNumber: '25-007', status: 'COMPLETED', poNumber: 'LE-00005',
      vendorId: 'v-city', vendorName: 'City Electric', estimatedTotalCents: 9_000,
      orderedAt: '2026-08-01T09:00:00Z', receivedAt: '2026-08-04T10:00:00Z' },
    { id: 'f', requestNumber: 'PR-6', jobNumber: '25-007', status: 'DRAFT', estimatedTotalCents: 0 },
  ];

  const pipeline = purchasingStatus(fleet);
  eq(pipeline.some((s) => s.key === 'CLOSED' || s.key === 'DRAFTS'), false,
     'purchasing status shows work in flight, not the closed and drafted piles');
  eq(pipeline.find((s) => s.key === 'NEEDS_REVIEW').count, 1, 'the needs-review stage counts the queue');
  eq(pipeline.find((s) => s.key === 'READY_TO_ORDER').valueCents, 50_000,
     'each stage sums the money sitting in it');
  eq(Math.round(pipeline.reduce((t, s) => t + s.share, 0)), 1,
     'the shares are of this panel\'s own total, so they add to one');
  eq(purchasingStatus([]).every((s) => s.count === 0 && s.share === 0), true,
     'an empty request list yields empty stages, not a divide-by-zero');

  const rec = receivingStatus(fleet, NOW);
  eq(rec.awaiting, 1, 'receiving counts what is on its way');
  eq(rec.awaitingValueCents, 120_000, 'and what it is worth');
  eq(rec.partiallyReceived, 1, 'receiving counts what arrived incomplete');
  eq(rec.overdueArrivals, 1, 'a late arrival is ordered material whose need-by has passed');
  eq(rec.receivedThisMonth, 1, 'received-this-month is counted by the month it landed');
  eq(receivingStatus([], NOW).awaiting, 0, 'receiving status of nothing is zero, and says so');

  const byVendor = vendorActivity(fleet, 5);
  eq(byVendor.length, 2, 'only vendors that appear on a real request are listed');
  eq(byVendor[0].vendorName, 'Graybar', 'the vendor with the most open work sorts first');
  eq(byVendor[0].openOrders, 2, 'open orders counts the open ones');
  eq(byVendor[0].openValueCents, 150_000, 'open value sums only the open ones');
  eq(byVendor[0].lastOrderedAt, '2026-08-05T09:00:00Z', 'last ordered is the most recent order, not the first');
  eq(vendorActivity([]).length, 0, 'no requests means no vendor rows — not a placeholder vendor');
  eq(vendorActivity([{ id: 'x', status: 'DRAFT' }]).length, 0,
     'a request with no vendor yet does not become a vendor called nothing');

  const pos = recentPurchaseOrders(fleet, 6);
  eq(pos.length, 3, 'recent POs are the ones actually placed with a vendor');
  eq(pos[0].poNumber, 'LE-00004', 'most recently ordered first');
  eq(pos.some((p) => p.poNumber === undefined || p.poNumber === null), false,
     'nothing without a PO number reaches the recent-PO list');
  eq(recentPurchaseOrders(fleet, 2).length, 2, 'the limit is honoured');
  eq(recentPurchaseOrders([]).length, 0, 'no orders means an empty list, not a sample row');
}

// ===========================================================================
console.log('--- trends and analytics, from the immutable record ------------');
{
  const A = await import(join(DOMAIN, 'dashboard.mjs'));

  eq(A.monthsEnding('2026-01', 3), ['2025-11', '2025-12', '2026-01'], 'the window rolls back over a year boundary');
  eq(A.monthsEnding('bad', 3), [], 'an unparseable month yields no window rather than today');
  eq(A.median([3, 1, 2]), 2, 'the median is the middle value');
  eq(A.median([1, 2, 3, 4]), 2.5 === 2.5 ? 3 : 0, 'an even sample rounds the midpoint');
  eq(A.median([]), null, 'no samples is null, never zero — zero would read as instant');

  const line = (over = {}) => ({
    orderedAt: '2026-01-05T10:00:00Z', orderedQty: 2, requestedAt: '2026-01-01T10:00:00Z',
    estimatedLineTotalCents: 1000, ...over,
  });

  // RULE 1 — a month with nothing in it is not a zero.
  const trend = A.spendTrend([line()], { endMonth: '2026-02', months: 3 });
  eq(trend.length, 3, 'the trend covers the whole window');
  eq(trend.map((m) => m.month), ['2025-12', '2026-01', '2026-02'], 'oldest first');
  eq(trend[1].hasData, true, 'the month with purchases has data');
  eq(trend[0].hasData, false, 'a month with no purchases reports no data...');
  eq(trend[0].totalCents, 0, '...and a zero total the chart must not draw as a value');

  // RULE 2 — unknown is not zero.
  const unpriced = A.spendTrend([line({ estimatedLineTotalCents: null, actualLineTotalCents: null })],
    { endMonth: '2026-01', months: 1 });
  eq(unpriced[0].unpriced, 1, 'a line with no price is counted as unpriced');
  eq(unpriced[0].totalCents, 0, 'and contributes nothing to spend rather than a zero price');
  eq(A.spendTrend([line({ actualLineTotalCents: 5000 })], { endMonth: '2026-01', months: 1 })[0].totalCents, 5000,
     'the invoice wins over the estimate when there is one');

  // RULE 3 — only what was actually ordered is a purchase.
  eq(A.spendTrend([line({ orderedAt: null })], { endMonth: '2026-01', months: 1 })[0].hasData, false,
     'a line that never reached a vendor is not spend');
  eq(A.spendTrend([line({ orderedQty: 0 })], { endMonth: '2026-01', months: 1 })[0].hasData, false,
     'nor is a line ordered in zero quantity');

  eq(A.volumeTrend([line()], { endMonth: '2026-01', months: 1 })[0].lines, 1, 'volume counts ordered lines');

  // Cycle time: a stage with no completed examples reports null.
  const cycles = A.cycleTimes([line({ receivedAt: '2026-01-09T10:00:00Z' })]);
  eq(cycles.requestToOrder.medianDays, 4, 'request to order is measured in whole days');
  eq(cycles.orderToDelivery.medianDays, 4, 'order to delivery likewise');
  eq(cycles.requestToDelivery.samples, 1, 'the sample size travels with the median');
  eq(A.cycleTimes([line()]).orderToDelivery.medianDays, null,
     'a line that never arrived reports no delivery time — not a zero');

  // On-time: only finished, dated lines can answer.
  const delivered = line({ receivedAt: '2026-01-09T18:00:00Z' });
  eq(A.onTimeDelivery([delivered], () => '2026-01-09').onTime, 1,
     'arriving on the day it was needed is on time, whatever the hour');
  eq(A.onTimeDelivery([delivered], () => '2026-01-08').late, 1, 'arriving the day after is late');
  eq(A.onTimeDelivery([delivered], () => null).measured, 0, 'a line with no need-by cannot be measured');
  eq(A.onTimeDelivery([line()], () => '2026-01-09').measured, 0,
     'a line still outstanding is not counted late — it has not finished');
  eq(A.onTimeDelivery([], () => '2026-01-09').rate, null,
     'nothing measured is null, not a perfect score');
}

// ===========================================================================
console.log("--- today's board and the by-day graph -------------------------");
{
  const A = await import(join(DOMAIN, 'dashboard.mjs'));
  const NOW = '2026-08-11T12:00:00Z';
  const r = (over = {}) => ({ status: 'SUBMITTED', submittedAt: '2026-08-11T09:00:00Z', needByDate: '2026-08-30', ...over });

  const board = A.todayBoard([
    r(),
    r({ status: 'PENDING_WORKSHOP_REVIEW', submittedAt: '2026-08-04T09:00:00Z' }),
    r({ status: 'ORDERED', needByDate: '2026-08-11' }),
    r({ status: 'ORDERED', needByDate: '2026-08-01' }),
    r({ status: 'COMPLETED', completedAt: '2026-08-11T11:00:00Z' }),
    r({ status: 'COMPLETED', completedAt: '2026-08-01T11:00:00Z' }),
  ], NOW);

  // Waiting is NOT time-boxed: Friday's request still needs him on Monday.
  eq(board.counts.waiting, 2, "last week's unanswered request still counts as waiting");
  eq(board.counts.arrivedToday, 5, 'arrived-today counts everything that came in today, whatever its status now');
  eq(board.counts.dueToday, 2, 'due-today includes the already-late one — later is more urgent, not less');
  eq(board.counts.finishedToday, 1, 'finished-today excludes what finished last week');
  eq(board.waiting.length, 2, 'the board carries the rows, not only the counts');
  eq(A.todayBoard([], NOW).counts, { waiting: 0, arrivedToday: 0, finishedToday: 0, dueToday: 0 },
     'an empty shop reports zeros rather than throwing');

  const days = A.dailyActivity([
    r(),
    r({ submittedAt: '2026-08-09T09:00:00Z', orderedAt: '2026-08-11T10:00:00Z' }),
  ], NOW, 3);
  eq(days.length, 3, 'the window is the requested number of days');
  eq(days.map((d) => d.day), ['2026-08-09', '2026-08-10', '2026-08-11'], 'oldest first, today last');
  eq(days[2].isToday, true, 'today is marked so the chart can weight it');
  eq(days[0].raised, 1, 'a request counts on the day it was raised');
  // Unlike the spend trend, a quiet day here is a real zero: "nobody asked for
  // anything" is a fact, where "no price recorded" is an absence.
  eq(days[1].raised, 0, 'a day with no requests is a genuine zero, not a gap');
  eq(days[2].ordered, 1, 'orders placed are counted on their own day');
  eq(A.dailyActivity([], 'not-a-date', 7), [], 'an unparseable clock yields no window rather than today');

  eq(A.ACTIVITY_RANGES.map((x) => x.key), ['today', '7d', '30d'], 'the ranges are today-first');
  eq(A.activityRange('today').days, 1, 'today is one day');
  eq(A.activityRange('nonsense').key, '7d', 'an unknown range falls back to a week, not to nothing');
}

// ===========================================================================
console.log('--- how many times somebody may guess ---------------------------');
{
  const T = await import(join(DOMAIN, 'throttle.mjs'));
  const NOW = 1_800_000_000;
  const fails = (n, at = NOW) => Array.from({ length: n }, () => at);

  eq(T.attemptDecision([], NOW).allowed, true, 'a first attempt is allowed');
  eq(T.attemptDecision(fails(T.MAX_FAILURES - 1), NOW).allowed, true, 'so is the last one under the limit');
  eq(T.attemptDecision(fails(T.MAX_FAILURES), NOW).allowed, false, 'the limit locks the key');

  // The lock runs from the NEWEST failure, so guessing while locked extends it.
  const locked = T.attemptDecision(fails(T.MAX_FAILURES), NOW);
  eq(locked.retryAfterSeconds, T.LOCK_SECONDS, 'and reports how long to wait');
  const kept = T.attemptDecision([...fails(T.MAX_FAILURES), NOW + 60], NOW + 60);
  check(kept.retryAfterSeconds === T.LOCK_SECONDS,
    'guessing again while locked restarts the wait rather than running it down');

  // Failures age out of the window.
  const old = fails(T.MAX_FAILURES, NOW - T.WINDOW_SECONDS - 1);
  eq(T.attemptDecision(old, NOW).allowed, true, 'failures older than the window do not count');
  eq(T.withinWindow(old, NOW).length, 0, 'and are dropped from what the store keeps');

  // The source budget is looser than the account budget — one office IP is
  // shared — but still bounded.
  check(T.MAX_SOURCE_FAILURES > T.MAX_FAILURES,
    'a shared address gets more room than a single account');
  eq(T.attemptDecision(fails(T.MAX_FAILURES + 1), NOW, T.MAX_SOURCE_FAILURES).allowed, true,
    'a few bad attempts from an office do not lock the office out');
  eq(T.attemptDecision(fails(T.MAX_SOURCE_FAILURES), NOW, T.MAX_SOURCE_FAILURES).allowed, false,
    'but a spray from one address is stopped');

  // Recording is bounded: an unbounded array is a memory leak with an attacker
  // holding the pen.
  let list = [];
  for (let i = 0; i < 200; i++) list = T.recordFailure(list, NOW);
  check(list.length <= 64, 'the failure list is capped', `${list.length}`);
  eq(T.recordFailure([], NOW).length, 1, 'a failure is recorded');

  // One account, however it is spelled.
  const a = T.throttleKeys(' Mike@Lippolis.test ', '1.2.3.4');
  const b = T.throttleKeys('mike@lippolis.test', '5.6.7.8');
  eq(a.account, b.account, 'case and padding do not buy a second budget');
  check(a.source !== b.source, 'but a different source is a different budget');
}

// ===========================================================================
console.log('--- the attention queue: ranked by rule, not by feeling ---------');
{
  const A = await import(join(DOMAIN, 'dashboard.mjs'));
  const NOW = '2026-08-11T12:00:00Z';
  const r = (over = {}) => ({
    id: over.id ?? Math.random().toString(36).slice(2),
    requestNumber: 'PR-00001',
    status: 'SUBMITTED',
    submittedAt: '2026-08-11T09:00:00Z',
    needByDate: '2026-08-30',
    ...over,
  });

  // --- which band, and only one band ---------------------------------------
  eq(A.attentionBand(r({ status: 'ORDERED', needByDate: '2026-08-01' }), NOW), 'OVERDUE',
     'an ordered request past its need-by is overdue, not merely on order');
  eq(A.attentionBand(r({ needByDate: '2026-08-11' }), NOW), 'DUE_TODAY',
     'due today and not ordered is the purchaser\'s to fix today');
  eq(A.attentionBand(r({ status: 'ORDERED', needByDate: '2026-08-11' }), NOW), 'ARRIVING',
     'due today but ALREADY ordered is the vendor\'s to deliver, so it ranks lower');
  eq(A.attentionBand(r(), NOW), 'NEW', 'an unanswered request is new work');
  eq(A.attentionBand(r({ status: 'PARTIALLY_RECEIVED' }), NOW), 'PART_RECEIVED',
     'a part-received order is its own kind of open');
  eq(A.attentionBand(r({ status: 'PO_GENERATED' }), NOW), 'IN_FLIGHT', 'everything else in flight');
  for (const status of ['COMPLETED', 'CANCELLED', 'REJECTED', 'DRAFT']) {
    eq(A.attentionBand(r({ status }), NOW), null, `a ${status} request needs nobody's attention`);
  }

  // --- the ordering ---------------------------------------------------------
  const queue = A.attentionQueue([
    r({ id: 'inflight', status: 'PO_GENERATED' }),
    r({ id: 'new-late', submittedAt: '2026-08-04T09:00:00Z' }),
    r({ id: 'overdue', status: 'ORDERED', needByDate: '2026-08-01' }),
    r({ id: 'arriving', status: 'ORDERED', needByDate: '2026-08-20' }),
    r({ id: 'due', needByDate: '2026-08-11' }),
    r({ id: 'part', status: 'PARTIALLY_RECEIVED', needByDate: '2026-08-25' }),
    r({ id: 'done', status: 'COMPLETED' }),
  ], NOW, { limit: 10 });

  eq(queue.items.map((i) => i.request.id), ['overdue', 'due', 'new-late', 'arriving', 'part', 'inflight'],
     'the bands rank in the documented order and terminal work is absent');
  eq(queue.total, 6, 'the total counts what is open, not what is shown');
  eq(A.attentionQueue([], NOW).items.length, 0, 'an empty shop produces an empty list rather than throwing');

  // Within a band: soonest need-by, then longest wait. Determinism is the
  // point — two renders must not disagree about what to do first.
  const sameBand = A.attentionQueue([
    r({ id: 'later', needByDate: '2026-08-20' }),
    r({ id: 'sooner', needByDate: '2026-08-12' }),
    r({ id: 'sooner-older', needByDate: '2026-08-12', submittedAt: '2026-08-01T09:00:00Z' }),
    r({ id: 'undated', needByDate: null }),
  ], NOW, { limit: 10 });
  eq(sameBand.items.map((i) => i.request.id), ['sooner-older', 'sooner', 'later', 'undated'],
     'soonest first, oldest wins a tie, and an undated request sorts last rather than first');

  // The list is bounded but honest about it.
  const many = A.attentionQueue(Array.from({ length: 20 }, (_, i) => r({ id: `x${i}` })), NOW, { limit: 3 });
  eq(many.items.length, 3, 'the dashboard renders a bounded list');
  eq(many.total, 20, 'and reports how much it is not showing');

  // --- the verb -------------------------------------------------------------
  const asPurchaser = { canReview: true, canReceive: true };
  eq(A.attentionAction(r({ id: 'a', status: 'PENDING_WORKSHOP_REVIEW' }), asPurchaser).label, 'Review request',
     'a new request offers the review');
  eq(A.attentionAction(r({ id: 'a', status: 'EMAIL_DRAFTED' }), asPurchaser).label, 'Mark ordered',
     'a drafted email offers the ordering');
  eq(A.attentionAction(r({ id: 'a', status: 'ORDERED' }), asPurchaser).label, 'Confirm receipt',
     'an ordered request offers the receipt');
  eq(A.attentionAction(r({ id: 'a', status: 'ORDERED' }), { canReceive: false }).label, 'View order',
     'somebody who may not receive is offered the record instead of a button that would be refused');
  eq(A.attentionAction(r({ id: 'a', status: 'PENDING_WORKSHOP_REVIEW' }), {}).label, 'Open',
     'and a reader with no purchasing rights is simply shown it');
  eq(A.attentionAction(r({ id: 'a', status: 'ORDERED' }), asPurchaser).href, '/requests/a/receive',
     'the action carries where it goes');
}

// ===========================================================================
console.log("--- today's workload, as the donut's slices ---------------------");
{
  const A = await import(join(DOMAIN, 'dashboard.mjs'));
  const NOW = '2026-08-11T12:00:00Z';
  const r = (over = {}) => ({ status: 'SUBMITTED', needByDate: '2026-08-30', ...over });

  const w = A.workloadToday([
    r(), r({ status: 'PENDING_WORKSHOP_REVIEW' }),
    r({ status: 'APPROVED' }), r({ status: 'PO_GENERATED' }), r({ status: 'EMAIL_DRAFTED' }),
    r({ status: 'ORDERED' }),
    r({ status: 'PARTIALLY_RECEIVED' }),
    r({ status: 'RECEIVED', receivedAt: '2026-08-11T10:00:00Z' }),
    r({ status: 'COMPLETED', completedAt: '2026-08-01T10:00:00Z' }),
  ], NOW);

  const by = Object.fromEntries(w.slices.map((s) => [s.key, s.count]));
  eq(by.NEW, 2, 'new requests are the ones awaiting a decision');
  eq(by.TO_ORDER, 3, 'approved, PO generated and email drafted are all still to order');
  eq(by.ORDERED, 1, 'on order');
  eq(by.PART_RECEIVED, 1, 'part received');
  eq(by.RECEIVED_TODAY, 1, "received TODAY excludes what was received a fortnight ago");
  eq(w.total, 8, 'the total is the sum of the slices, and excludes older completions');

  // A category with nothing in it is a zero, not a missing slice: "none today"
  // and "no such thing" are different statements.
  const quiet = A.workloadToday([], NOW);
  eq(quiet.total, 0, 'a quiet morning totals zero');
  eq(quiet.slices.length, 5, 'and still names all five categories');
  check(quiet.slices.every((s) => s.count === 0), 'each at zero');
  check(quiet.slices.every((s) => typeof s.href === 'string'), 'every slice can be opened');
}

console.log('');
console.log(`domain checks: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
