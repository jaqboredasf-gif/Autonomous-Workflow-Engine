// ---------------------------------------------------------------------------
// outbound-draft.mjs  (Task B3 — outbound DRAFT generation, and only drafting)
//
// PURE, OFFLINE, DETERMINISTIC. Builds the text of a customer-/crew-facing
// message and runs it through the approval gate. Every result is a DRAFT or a
// BLOCK — there is no code path in this module, or reachable from it, that
// transmits anything.
//
// HARD BOUNDARIES (enforced by having zero of the machinery):
//   * No network / fetch / Graph / SMTP / n8n. The only import is the pure
//     routing engine (scripts/lib/approval-matrix.mjs).
//   * No clock, no randomness — draft_key and body text are a deterministic
//     function of the inputs, so re-running is idempotent by construction.
//   * No send, no "queue for delivery", no mailbox write. Producing a draft ends
//     the machine's authority; a human decides next (record_approval), and a
//     human physically sends (mark_message_sent is a ledger entry after the fact).
//
// Safety rules encoded here, not prompted:
//   * REQUIREMENTS: "System never sends electrical troubleshooting instructions
//     to customers" — every rendered body is scanned, and a match blocks the
//     draft with 'forbidden_content'. Inbound email text is untrusted data, so
//     the scan covers interpolated customer content too.
//   * TEST mode: recipients must be @example.invalid and rows must be fixtures.
//   * No invented prices (REQUIREMENTS): templates never fabricate an amount;
//     amount_cents is passed in or absent.
//
// Contract + rationale: docs/testing/APPROVAL_MATRIX.md
// ---------------------------------------------------------------------------

import {
  route, authorizeAction, enforceTestMode, resolveMode, FIXTURE_EMAIL_DOMAIN,
} from './approval-matrix.mjs';

export const ENGINE_VERSION = 'b3-draft-1';

// Content we never send to a customer, regardless of who asked for it. Biased
// toward false positives: a blocked draft costs a human rewrite, a sent
// troubleshooting instruction is a safety failure (same bias as the emergency
// keyword net in 0011).
const FORBIDDEN_CONTENT = [
  /\breset (the )?(breaker|panel|gfci|outlet)/i,
  /\bflip (the )?(breaker|switch)\b/i,
  /\bturn (the )?(power|breaker|panel) (back )?on\b/i,
  /\bunscrew\b/i,
  /\breplace the (fuse|outlet|breaker|wire|wiring)\b/i,
  /\brewire\b/i,
  /\bstrip the wire/i,
  /\btouch (the )?(wire|wiring|panel|bus bar)/i,
  /\byou (can|should) (safely )?(try|test|check) the (panel|breaker|wiring|outlet)/i,
];

// --- Templates --------------------------------------------------------------
//
// Each template declares the context fields it REQUIRES. A missing field is a
// draft-build failure (blocked, human queue) — never a draft with a hole in it.
// Bodies are deliberately plain and short: v1 drafts are a starting point a human
// edits, and the edit is the evidence the ADR slice measures.

const TEMPLATES = {
  out_of_territory_decline: {
    required: ['customer_name', 'customer_email', 'service_location'],
    subject: (c) => `Re: your electrical service request (${c.service_location})`,
    body: (c) => [
      `Hello ${c.customer_name},`,
      '',
      `Thank you for contacting us about electrical work at ${c.service_location}.`,
      'Unfortunately that location falls outside the area we currently serve, so we',
      'are not able to take on this job.',
      '',
      'We appreciate you thinking of us and wish you a quick resolution.',
    ].join('\n'),
  },

  service_call_confirmation: {
    required: ['customer_name', 'customer_email', 'service_location'],
    subject: (c) => `Your service call request — ${c.service_location}`,
    body: (c) => [
      `Hello ${c.customer_name},`,
      '',
      `We received your request for electrical service at ${c.service_location} and`,
      'have it in our schedule queue. A member of our office will confirm the visit',
      'window with you shortly.',
      '',
      'If anything about the situation changes, please reply to this message.',
    ].join('\n'),
  },

  missing_info_request: {
    required: ['customer_name', 'customer_email', 'missing_fields'],
    subject: () => 'A few details needed for your service request',
    body: (c) => [
      `Hello ${c.customer_name},`,
      '',
      'Thank you for your request. To move it forward we need a little more',
      'information:',
      '',
      ...asList(c.missing_fields).map((f) => `  - ${f}`),
      '',
      'Reply to this message with those details and we will pick it up from there.',
    ].join('\n'),
  },

  scheduling_confirmation: {
    required: ['customer_name', 'customer_email', 'service_location', 'scheduled_window'],
    subject: (c) => `Scheduled: electrical work at ${c.service_location}`,
    body: (c) => [
      `Hello ${c.customer_name},`,
      '',
      `Your electrical work at ${c.service_location} is scheduled for`,
      `${c.scheduled_window}.`,
      '',
      'Please reply if that window does not work and we will find another.',
    ].join('\n'),
  },

  completion_notice: {
    required: ['customer_name', 'customer_email', 'service_location'],
    subject: (c) => `Work completed — ${c.service_location}`,
    body: (c) => [
      `Hello ${c.customer_name},`,
      '',
      `Our crew has completed the electrical work at ${c.service_location}.`,
      'A summary of the visit is on file with our office.',
      '',
      'If anything looks unfinished, reply here and we will follow up.',
    ].join('\n'),
  },

  crew_dispatch: {
    required: ['crew_contact_name', 'crew_contact_email', 'service_location', 'scheduled_window'],
    subject: (c) => `Dispatch: ${c.service_location} (${c.scheduled_window})`,
    body: (c) => [
      `${c.crew_contact_name},`,
      '',
      `Assignment: ${c.service_location}`,
      `Window: ${c.scheduled_window}`,
      '',
      'Details are on the job record. Confirm receipt with the office.',
    ].join('\n'),
  },

  estimate_proposal: {
    required: ['customer_name', 'customer_email', 'service_location', 'scope_summary'],
    subject: (c) => `Proposal for electrical work — ${c.service_location}`,
    body: (c) => [
      `Hello ${c.customer_name},`,
      '',
      `Please find our proposal for the following work at ${c.service_location}:`,
      '',
      `  ${c.scope_summary}`,
      '',
      'Pricing detail is attached to the proposal record. Reply with any questions.',
    ].join('\n'),
  },

  change_order: {
    required: ['customer_name', 'customer_email', 'service_location', 'scope_summary'],
    subject: (c) => `Change order for review — ${c.service_location}`,
    body: (c) => [
      `Hello ${c.customer_name},`,
      '',
      'While performing the approved work our crew identified additional scope:',
      '',
      `  ${c.scope_summary}`,
      '',
      'This change requires your written approval before we proceed.',
    ].join('\n'),
  },

  final_invoice: {
    required: ['customer_name', 'customer_email', 'invoice_reference'],
    subject: (c) => `Invoice ${c.invoice_reference}`,
    body: (c) => [
      `Hello ${c.customer_name},`,
      '',
      `Invoice ${c.invoice_reference} for the completed electrical work is ready.`,
      'The invoice itself is issued from our accounting system.',
      '',
      'Thank you for your business.',
    ].join('\n'),
  },

  uncertain_flagged: {
    required: ['customer_name', 'customer_email'],
    subject: () => 'We received your message',
    body: (c) => [
      `Hello ${c.customer_name},`,
      '',
      'Thank you for reaching out. Your message is with our office for review and',
      'someone will get back to you directly.',
    ].join('\n'),
  },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES);

function asList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// --- Draft key --------------------------------------------------------------

/**
 * Deterministic idempotency key. Fixtures use the reserved 'fixture:' namespace,
 * exactly like email_messages.graph_message_id and approval_drafts.draft_key.
 * Same (mode, request, type) => same key => a second create is a duplicate.
 */
export function draftKeyFor({ messageType, workRequestKey, mode = 'TEST' }) {
  const base = `${messageType}:${workRequestKey}`;
  return mode === 'TEST' ? `fixture:${base}` : base;
}

// --- Draft building ---------------------------------------------------------

/**
 * buildDraft({messageType, context}) -> {ok, draft|null, error|null, missing[]}
 *
 * Never partially succeeds: either every required field was present and the
 * rendered draft is complete, or ok=false and nothing is produced.
 */
export function buildDraft({ messageType, context = {} } = {}) {
  const tpl = TEMPLATES[messageType];
  if (!tpl) {
    return { ok: false, draft: null, error: `no template for message type '${messageType}'`, missing: [] };
  }

  const missing = tpl.required.filter((f) => {
    const v = context[f];
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    return String(v).trim() === '';
  });
  if (missing.length > 0) {
    return {
      ok: false,
      draft: null,
      error: `missing required field(s): ${missing.join(', ')}`,
      missing,
    };
  }

  let subject, body;
  try {
    subject = tpl.subject(context);
    body = tpl.body(context);
  } catch (e) {
    // A throwing template is a build failure, not an exception that escapes into
    // the runner: drafting failure has to be a clean, blockable state.
    return { ok: false, draft: null, error: `template render failed: ${e.message}`, missing: [] };
  }

  const recipient = context.crew_contact_email ?? context.customer_email;
  return {
    ok: true,
    error: null,
    missing: [],
    draft: {
      message_type: messageType,
      subject,
      body_text: body,
      to_addrs: [recipient],
      cc_addrs: [],
      bcc_addrs: [],
      attachments: [],
      // status is stated explicitly and is the ONLY value this module can produce.
      status: 'draft',
      model_meta: { template: messageType, engine: ENGINE_VERSION, deterministic: true },
    },
  };
}

/**
 * scanForbiddenContent(text) -> string[] of matched forbidden patterns.
 * Applied to subject + body of every built draft, including interpolated
 * customer text (which is untrusted input, not instructions).
 */
export function scanForbiddenContent(text) {
  const s = String(text ?? '');
  return FORBIDDEN_CONTENT.filter((re) => re.test(s)).map((re) => re.source);
}

// --- The gate ---------------------------------------------------------------

/**
 * prepareOutbound({action, policies, messageType, context, amountCents,
 *                  unavailableRoles, workRequestKey, existingDraftKeys,
 *                  isFixture, env}) -> result
 *
 * The single entry point every outbound action must pass through. Returns:
 *   {
 *     ok,               // true only when a complete, routed draft was produced
 *     status,           // 'draft' | 'blocked'
 *     blocked_reason,   // null when ok
 *     persist,          // 'draft_row' | 'blocked_row' | 'none'  (what to write)
 *     draft,            // the draft object, or null
 *     routing,          // the route() decision (null when refused before routing)
 *     draft_key,
 *     events,           // event types the DB will emit for this outcome
 *     audit             // ordered list of gate decisions, for the audit trail
 *   }
 *
 * Fail-closed ordering (deterministic):
 *   1. action authorization   -> 'unauthorized_external_action'  (persist: none)
 *   2. duplicate draft_key    -> 'duplicate_draft'               (persist: none)
 *   3. template build         -> 'draft_build_failed'            (persist: none)
 *   4. forbidden content      -> 'forbidden_content'             (persist: none)
 *   5. TEST-mode safety       -> 'test_mode_violation'           (persist: none)
 *   6. matrix routing         -> route reason                    (persist: blocked_row)
 *
 * Steps 1-5 are refusals BEFORE any row is written (nothing unsafe reaches the
 * database). Step 6 writes a `blocked` row on purpose: an unroutable message is
 * a real operational fact a human must see in the queue.
 */
export function prepareOutbound({
  action = 'create_draft',
  policies,
  messageType,
  context = {},
  amountCents = null,
  unavailableRoles = [],
  workRequestKey,
  existingDraftKeys = [],
  isFixture = true,
  env = {},
} = {}) {
  const mode = resolveMode(env);
  const audit = [];
  const key = draftKeyFor({
    messageType,
    workRequestKey: workRequestKey ?? context.work_request_key ?? 'unkeyed',
    mode,
  });

  const refuse = (reason, detail) => {
    audit.push({ step: reason, ok: false, detail });
    return {
      ok: false, status: 'blocked', blocked_reason: reason, persist: 'none',
      draft: null, routing: null, draft_key: key, mode, events: [], audit,
    };
  };

  // 1. Is this action even in the registry?
  const authz = authorizeAction(action, { mode });
  audit.push({ step: 'authorize_action', ok: authz.allowed, detail: action });
  if (!authz.allowed) {
    return {
      ok: false, status: 'blocked', blocked_reason: 'unauthorized_external_action',
      persist: 'none', draft: null, routing: null, draft_key: key, mode, events: [], audit,
    };
  }

  // 2. Idempotency / duplicate prevention.
  const known = new Set(Array.isArray(existingDraftKeys) ? existingDraftKeys : []);
  if (known.has(key)) return refuse('duplicate_draft', key);
  audit.push({ step: 'duplicate_check', ok: true, detail: key });

  // 3. Build the draft.
  const built = buildDraft({ messageType, context });
  audit.push({ step: 'build_draft', ok: built.ok, detail: built.error });
  if (!built.ok) return refuse('draft_build_failed', built.error);

  // 4. Content safety (never send troubleshooting advice).
  const hits = scanForbiddenContent(`${built.draft.subject}\n${built.draft.body_text}`);
  audit.push({ step: 'content_scan', ok: hits.length === 0, detail: hits.join(' | ') || null });
  if (hits.length > 0) return refuse('forbidden_content', hits.join(' | '));

  // 5. TEST-mode safety.
  const test = enforceTestMode({ recipients: built.draft.to_addrs, isFixture, mode });
  audit.push({ step: 'test_mode', ok: test.ok, detail: test.violations.join('; ') || null });
  if (!test.ok) return refuse('test_mode_violation', test.violations.join('; '));

  // 6. Route through the matrix.
  const routing = route({ policies, messageType, amountCents, unavailableRoles });
  audit.push({ step: 'route', ok: !routing.blocked, detail: routing.blocked_reason });
  if (routing.blocked) {
    return {
      ok: false,
      status: 'blocked',
      blocked_reason: routing.blocked_reason,
      // An unroutable message IS written, as a blocked row, so it surfaces in the
      // queue instead of disappearing.
      persist: 'blocked_row',
      draft: { ...built.draft, status: 'blocked', amount_cents: amountCents },
      routing,
      draft_key: key,
      mode,
      events: ['message.blocked'],
      audit,
    };
  }

  const events = ['message.draft_created'];
  if (routing.escalated) events.push('message.escalated');

  return {
    ok: true,
    status: 'draft',
    blocked_reason: null,
    persist: 'draft_row',
    draft: {
      ...built.draft,
      amount_cents: amountCents,
      assigned_approver_role: routing.approver_role,
      routing_path: routing.routing_path,
      escalated: routing.escalated,
      escalation_reason: routing.escalation_reason,
      policy_id: routing.policy_id,
      draft_key: key,
      is_fixture: isFixture,
      // Restated for the avoidance of doubt: drafting never yields authority to send.
      requires_human_approval: true,
      send_capability: false,
    },
    routing,
    draft_key: key,
    mode,
    events,
    audit,
  };
}

export { FIXTURE_EMAIL_DOMAIN };
