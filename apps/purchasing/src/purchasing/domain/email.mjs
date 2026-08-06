// ---------------------------------------------------------------------------
// email.mjs — email templates, draft composition, and the send gate.
//
// THIS MODULE CANNOT SEND MAIL AND NEITHER CAN ANYTHING THAT IMPORTS IT.
// There is no transport in this repository's purchasing module: no SMTP, no
// Graph, no fetch. `markDraftSent()` records that a HUMAN copied an approved
// draft into their own mail client and sent it — a ledger entry, not a
// transmission. Same discipline as migration 0015's mark_message_sent().
//
// Draft statuses mirror 0015's outbound_messages so the two can converge later:
//   GENERATED -> REVIEWED -> APPROVED_TO_SEND -> SENT
//   any non-terminal -> CANCELLED | FAILED
//
// PURE: templates are string functions of their arguments.
// ---------------------------------------------------------------------------

import { formatMoney, formatQty } from './numbers.mjs';

export const EMAIL_TEMPLATE_TYPES = [
  'APPROVAL_REQUEST',
  'VENDOR_PURCHASE_ORDER',
  'CLARIFICATION_REQUEST',
  'REJECTION_NOTICE',
  'ORDER_FOLLOW_UP',
  'MATERIAL_READY_NOTICE',
];

export const EMAIL_DRAFT_STATUSES = [
  'GENERATED',
  'REVIEWED',
  'APPROVED_TO_SEND',
  'SENT',
  'CANCELLED',
  'FAILED',
];

export const EMAIL_DRAFT_TRANSITIONS = {
  GENERATED: ['REVIEWED', 'CANCELLED', 'FAILED'],
  REVIEWED: ['APPROVED_TO_SEND', 'CANCELLED', 'FAILED'],
  APPROVED_TO_SEND: ['SENT', 'CANCELLED', 'FAILED'],
  SENT: [],
  CANCELLED: [],
  FAILED: [],
};

/**
 * Global kill switch. External sending stays disabled until an org explicitly
 * configures it AND a human approves each draft. The pilot ships `false` and
 * there is no code path that would use `true` — the flag exists so the
 * intention is inspectable, not so it can be flipped on quietly.
 */
export const EXTERNAL_SEND_ENABLED = false;

/** Recipient domain reserved for fixtures/tests. Nothing may leave to it. */
export const FIXTURE_EMAIL_DOMAIN = 'example.invalid';

export function isFixtureRecipient(addr) {
  return String(addr ?? '').toLowerCase().endsWith(`@${FIXTURE_EMAIL_DOMAIN}`);
}

export function canTransitionDraft(from, to) {
  return (EMAIL_DRAFT_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The send gate. Called before any status change on a draft.
 * @returns {{ok:boolean, reason:string|null, message:string|null}}
 */
export function draftGuard(from, to, ctx = {}) {
  if (!EMAIL_DRAFT_STATUSES.includes(from) || !EMAIL_DRAFT_STATUSES.includes(to)) {
    return { ok: false, reason: 'unknown_status', message: `unknown draft status ${from} -> ${to}` };
  }
  if (!canTransitionDraft(from, to)) {
    return { ok: false, reason: 'illegal_transition', message: `illegal draft transition ${from} -> ${to}` };
  }
  if (to === 'SENT' && !ctx.reviewedBy) {
    return { ok: false, reason: 'unreviewed', message: 'a draft cannot be marked sent without a recorded human review' };
  }
  if (to === 'SENT' && !ctx.markedBy) {
    return { ok: false, reason: 'no_actor', message: 'marking sent requires the human who sent it' };
  }
  return { ok: true, reason: null, message: null };
}

export const DRAFT_GUARD_REASONS = ['unknown_status', 'illegal_transition', 'unreviewed', 'no_actor'];

// --- Templates -------------------------------------------------------------
//
// Each template is a function (ctx) => {subject, body}. Org-specific wording
// lives in the email_templates table; these are the built-in defaults and the
// contract the stored templates must satisfy (same placeholders).

const line = (s = '') => s;

// Money renders as money — unless it is already a string, which is how seed.ts
// derives the editable templates (a marker in, a {{placeholder}} out).
const money = (v) => (typeof v === 'string' ? v : formatMoney(v));

export function orderTable(items) {
  // A string passes straight through: that is how the admin-editable templates
  // are derived from these defaults (seed.ts renders them with a marker in
  // place of the items, which becomes the {{itemsTable}} placeholder).
  if (typeof items === 'string') return items;
  const rows = (items ?? []).map((i, idx) => {
    const qty = formatQty(i.finalOrderQty ?? i.qty ?? 0);
    const cost = i.estimatedUnitCostCents ? `  @ ${formatMoney(i.estimatedUnitCostCents)}` : '';
    return `  ${idx + 1}. ${qty} ${i.unit ?? 'ea'}  ${i.description}${i.substituteFor ? ` (substitute for ${i.substituteFor})` : ''}${cost}`;
  });
  return rows.join('\n');
}

export const TEMPLATES = {
  APPROVAL_REQUEST: (ctx) => ({
    subject: `Purchase request ${ctx.request.requestNumber} needs workshop review — job ${ctx.request.jobNumber}`,
    body: [
      `${ctx.approverName ?? 'Workshop'},`,
      '',
      `${ctx.request.requestorName} submitted a purchase request for job ${ctx.request.jobNumber}.`,
      `Needed by ${ctx.request.needByDate} at ${ctx.request.needByTime}, ${ctx.request.deliveryLocationName}.`,
      '',
      'Requested:',
      orderTable(ctx.items),
      '',
      ctx.request.reason ? `Reason: ${ctx.request.reason}` : '',
      '',
      `Review it here: ${ctx.links?.review ?? '(purchasing app) Workshop queue'}`,
    ].filter(line).join('\n'),
  }),

  VENDOR_PURCHASE_ORDER: (ctx) => ({
    subject: `Purchase Order ${ctx.purchaseOrder.poNumber} — ${ctx.org.name} — job ${ctx.request.jobNumber}`,
    body: [
      `${ctx.vendorContact?.name ?? 'Hello'},`,
      '',
      `Please supply the following against purchase order ${ctx.purchaseOrder.poNumber}.`,
      '',
      `Purchase order: ${ctx.purchaseOrder.poNumber}`,
      `Job number:     ${ctx.request.jobNumber}`,
      `Needed by:      ${ctx.request.needByDate} at ${ctx.request.needByTime}`,
      `${ctx.request.deliveryMethod === 'PICKUP' ? 'Pickup from' : 'Deliver to'}: ${ctx.request.deliveryLocationName}`,
      ctx.request.deliveryAddress ? `                ${ctx.request.deliveryAddress}` : '',
      '',
      'Order:',
      orderTable(ctx.items),
      '',
      `Estimated total: ${money(ctx.purchaseOrder.estimatedTotalCents)}`,
      '',
      'Please confirm receipt of this order, the price, and the expected delivery or',
      'pickup date. The signed purchase order is attached as a PDF.',
      '',
      `${ctx.sender?.name ?? ''}`,
      `${ctx.org.name}`,
      ctx.org.phone ?? '',
    ].filter(line).join('\n'),
  }),

  CLARIFICATION_REQUEST: (ctx) => ({
    subject: `Question on your purchase request ${ctx.request.requestNumber} — job ${ctx.request.jobNumber}`,
    body: [
      `${ctx.request.requestorName},`,
      '',
      `Before this goes out I need one thing cleared up on request ${ctx.request.requestNumber}:`,
      '',
      `  ${ctx.question}`,
      '',
      'Reply in the purchasing app and it comes straight back to the workshop queue.',
      '',
      `${ctx.sender?.name ?? ''}`,
    ].filter(line).join('\n'),
  }),

  REJECTION_NOTICE: (ctx) => ({
    subject: `Purchase request ${ctx.request.requestNumber} was not approved`,
    body: [
      `${ctx.request.requestorName},`,
      '',
      `Request ${ctx.request.requestNumber} for job ${ctx.request.jobNumber} was not approved.`,
      '',
      `Reason: ${ctx.reason}`,
      '',
      'If the job still needs this material, raise a new request with the corrected',
      'information — this one stays on file as it was submitted.',
      '',
      `${ctx.sender?.name ?? ''}`,
    ].filter(line).join('\n'),
  }),

  ORDER_FOLLOW_UP: (ctx) => ({
    subject: `Status check — PO ${ctx.purchaseOrder.poNumber} — job ${ctx.request.jobNumber}`,
    body: [
      `${ctx.vendorContact?.name ?? 'Hello'},`,
      '',
      `Checking on purchase order ${ctx.purchaseOrder.poNumber}, placed ${ctx.purchaseOrder.orderedAt ?? ''}.`,
      `We need this material by ${ctx.request.needByDate} at ${ctx.request.needByTime}.`,
      '',
      'Could you confirm:',
      '  - the order is booked and the pricing stands',
      '  - the shipment or pickup date',
      '  - a tracking number, if it has shipped',
      '',
      'Outstanding:',
      orderTable(ctx.items),
      '',
      `${ctx.sender?.name ?? ''}`,
      `${ctx.org.name}`,
    ].filter(line).join('\n'),
  }),

  MATERIAL_READY_NOTICE: (ctx) => ({
    subject: `Material ready for job ${ctx.request.jobNumber} — request ${ctx.request.requestNumber}`,
    body: [
      `${ctx.request.requestorName},`,
      '',
      `The material on request ${ctx.request.requestNumber} is ${ctx.request.deliveryMethod === 'PICKUP' ? 'ready for pickup at' : 'delivered to'} ${ctx.request.deliveryLocationName}.`,
      '',
      'Received:',
      orderTable(ctx.items),
      '',
      ctx.shortNote ? `Note: ${ctx.shortNote}` : '',
      '',
      `${ctx.sender?.name ?? ''}`,
    ].filter(line).join('\n'),
  }),
};

/**
 * Compose a draft. Returns the draft record fields — it does NOT persist and it
 * does NOT send. `draftKey` is the idempotency contract: composing the same
 * message twice yields the same key, and the store refuses the second row
 * (23505 idiom from 0015).
 *
 * @param {string} type
 * @param {any} ctx
 * @param {{template?: {subject: string, body: string} | null}} [options]
 */
export function composeDraft(type, ctx, { template = null } = {}) {
  if (!EMAIL_TEMPLATE_TYPES.includes(type)) {
    throw new Error(`unknown email template type: ${type}`);
  }
  const rendered = template
    ? renderStoredTemplate(template, ctx)
    : TEMPLATES[type](ctx);

  const to = dedupe(ctx.to ?? []);
  return {
    type,
    status: 'GENERATED',
    subject: rendered.subject,
    body: rendered.body,
    to,
    cc: dedupe(ctx.cc ?? []),
    attachments: ctx.attachments ?? [],
    draftKey: ctx.draftKey,
    senderId: ctx.sender?.id ?? null,
    externalSendEnabled: EXTERNAL_SEND_ENABLED,
  };
}

/**
 * Stored (admin-editable) templates are plain text with {{placeholders}}.
 * Unknown placeholders render as empty string rather than throwing — a
 * half-rendered draft a human can fix beats a 500 in the middle of the workshop.
 */
export function renderStoredTemplate(template, ctx) {
  const flat = flatten(ctx);
  // Derived placeholders: the rendered order table, and money already formatted
  // (a template author writes {{purchaseOrder.estimatedTotal}}, not cents).
  flat.itemsTable = orderTable(ctx.items);
  flat['purchaseOrder.estimatedTotal'] = money(ctx.purchaseOrder?.estimatedTotalCents ?? 0);
  const fill = (s) => String(s ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = flat[key];
    return v === undefined || v === null ? '' : String(v);
  });
  return { subject: fill(template.subject), body: fill(template.body) };
}

export function templatePlaceholders(template) {
  const found = new Set();
  const scan = (s) => {
    for (const m of String(s ?? '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) found.add(m[1]);
  };
  scan(template.subject);
  scan(template.body);
  return [...found].sort();
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function dedupe(list) {
  return [...new Set((list ?? []).filter(Boolean).map((s) => String(s).trim()))];
}
