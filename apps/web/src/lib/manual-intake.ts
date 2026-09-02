// ---------------------------------------------------------------------------
// manual-intake.ts — the decidable logic behind "New Work Request".
//
// PURE, OFFLINE, DETERMINISTIC. No React, no Supabase client, no fetch, no
// clock (the caller passes `now`), no randomness. Same posture as
// approval-queue.ts: this decides what to OFFER and what payload to build; the
// authority is 0016's create_manual_work_request() plus RLS.
//
// WHAT THIS IS: a TEMPORARY production bootstrap. Email-first remains the MVP
// intake architecture (DECISION_LOG 2026-07-16, which named this bridge in the
// same decision). Graph inbound is blocked on Entra, and until it lands nothing
// can enter AWE in production at all.
//
// WHAT THIS IS NOT: an email. A manual request has NO email_messages row at
// all — 0016 makes work_requests.email_message_id nullable and constrains a
// manual row to carry none. Nothing is fabricated: no email row, no
// graph_message_id, no address, no fixture flag.
// ---------------------------------------------------------------------------

export interface ManualIntakeInput {
  bodyText: string;
  sourceReference: string;
  receivedAt: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  county?: string | null;
  zip?: string | null;
  urgency?: string | null;
  clientKey?: string | null;
}

/** work_requests.urgency (0011). 'emergency' here does NOT dispatch anyone. */
export const URGENCIES = ['standard', 'urgent', 'emergency'] as const;

/** Exactly the arguments create_manual_work_request() accepts. */
export interface ManualIntakeRpc {
  p_body_text: string;
  p_source_reference: string;
  p_received_at: string;
  p_customer_name: string | null;
  p_customer_email: string | null;
  p_customer_phone: string | null;
  p_customer_address: string | null;
  p_county: string | null;
  p_zip: string | null;
  p_urgency: string;
  p_client_key: string | null;
}

export const INTAKE_FIELD_ERRORS = [
  'missing_body_text',
  'missing_source_reference',
  'received_at_in_future',
  'invalid_received_at',
  'invalid_customer_email',
  'invalid_urgency',
  'not_authorized',
] as const;
export type IntakeFieldError = (typeof INTAKE_FIELD_ERRORS)[number];

export interface ManualIntakePlan {
  ok: boolean;
  errors: { field: string; reason: IntakeFieldError; detail: string }[];
  rpc: ManualIntakeRpc | null;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

// Only the two things that make a manual record meaningful are required. Every
// other field is optional on purpose: a phone request often arrives as a name
// and a problem, and forcing an operator to invent an address or a zip to get
// past a form is how fabricated data enters an evidence system.
export function planManualIntake({
  input,
  now,
  isAuthorized,
}: {
  input: ManualIntakeInput;
  now: string;
  isAuthorized: boolean;
}): ManualIntakePlan {
  const errors: ManualIntakePlan['errors'] = [];
  const fail = (field: string, reason: IntakeFieldError, detail: string) =>
    errors.push({ field, reason, detail });

  if (!isAuthorized) {
    fail('form', 'not_authorized', 'only an admin may create work requests');
  }

  const body = clean(input.bodyText);
  if (!body) {
    fail('bodyText', 'missing_body_text', 'record what the customer actually asked for');
  }

  const source = clean(input.sourceReference);
  if (!source) {
    fail('sourceReference', 'missing_source_reference',
      'record where this came from, e.g. "Phone call from 914-555-0134"');
  }

  // Default to now rather than rejecting: the common case is "this just came in".
  const receivedRaw = clean(input.receivedAt) ?? now;
  const received = Date.parse(receivedRaw);
  if (Number.isNaN(received)) {
    fail('receivedAt', 'invalid_received_at', 'not a valid date and time');
  } else if (received > Date.parse(now) + 60_000) {
    fail('receivedAt', 'received_at_in_future', 'a request cannot have arrived in the future');
  }

  // customer_email is the only address a reply could ever go to for a phone
  // request, so a malformed one is worse than a blank one.
  const email = clean(input.customerEmail);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail('customerEmail', 'invalid_customer_email',
      'this is the address any reply would go to — leave it blank rather than guessing');
  }

  const urgency = clean(input.urgency) ?? 'standard';
  if (!(URGENCIES as readonly string[]).includes(urgency)) {
    fail('urgency', 'invalid_urgency', `expected one of ${URGENCIES.join(', ')}`);
  }

  if (errors.length) return { ok: false, errors, rpc: null };

  return {
    ok: true,
    errors: [],
    rpc: {
      p_body_text: body as string,
      p_source_reference: source as string,
      p_received_at: new Date(received).toISOString(),
      p_customer_name: clean(input.customerName),
      p_customer_email: email,
      p_customer_phone: clean(input.customerPhone),
      p_customer_address: clean(input.customerAddress),
      p_county: clean(input.county),
      p_zip: clean(input.zip),
      p_urgency: urgency,
      p_client_key: clean(input.clientKey),
    },
  };
}

/**
 * After creation the page re-reads and confirms the request actually exists.
 * Same posture as verifyDecisionApplied: success is what the re-read says.
 */
export function verifyIntakeApplied({
  workRequestId,
  found,
}: {
  workRequestId: string | null;
  found: boolean;
}): { settled: boolean; message: string } {
  if (!workRequestId) {
    return { settled: false, message: 'no work request id was returned — nothing was created' };
  }
  if (!found) {
    return {
      settled: false,
      message: `request ${workRequestId} was reported created but could not be read back — reload and confirm before re-entering it`,
    };
  }
  return { settled: true, message: `Work request created (${workRequestId}).` };
}
