// Email draft composition.
//
// This module returns STRINGS. It has no transport, no SMTP, no API client and
// no ability to send anything. The only outward affordance in the app is a
// `mailto:` link the user clicks, which opens their own mail client with the
// draft pre-filled — and even then nothing leaves until the user presses send.

import { formatDate, formatMoney } from './format';
import type { Job, PurchaseRequest, Vendor } from './types';

export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
  attachmentLabel: string;
}

export function buildEmailDraft(
  request: PurchaseRequest,
  vendor: Vendor | undefined,
  job: Job | undefined,
  requestorName: string,
): EmailDraft {
  const po = request.poNumber ?? '(PO not yet generated)';
  const jobLabel = job ? `${job.number} — ${job.name}` : '(job not found)';

  const lines = request.lines
    .map((l) => {
      const stock = l.stockNumber ? ` [${l.stockNumber}]` : '';
      return `  ${l.quantity} ${l.unit}  ${l.description}${stock}`;
    })
    .join('\n');

  const body = [
    `${vendor?.contact.name ?? 'Supplier'},`,
    '',
    `Please see the material order below for ${jobLabel}.`,
    '',
    `PO Number:      ${po}`,
    `Job:            ${jobLabel}`,
    `Job Address:    ${job?.address ?? '(address not found)'}`,
    `Needed By:      ${request.neededBy ? formatDate(request.neededBy) : 'ASAP — please advise'}`,
    `Priority:       ${request.priority}`,
    `Estimated Cost: ${formatMoney(request.estimatedCost)}`,
    '',
    'Material:',
    lines || '  (no material lines)',
    '',
    request.notes ? `Notes: ${request.notes}` : 'Notes: none',
    '',
    'Please confirm pricing, availability, and delivery date before shipping.',
    '',
    'Thank you,',
    requestorName,
    'Lippolis Electric',
  ].join('\n');

  return {
    to: vendor?.contact.email ?? 'supplier@example.test',
    subject: `Lippolis Electric — PO ${po} — Job ${job?.number ?? 'TBD'}`,
    body,
    attachmentLabel: `${po}.pdf (attachment placeholder — generate the PO and print to PDF)`,
  };
}

/**
 * Builds a mailto: URL. Opening it hands the draft to the user's mail client;
 * it does not send. Long bodies can exceed client URL limits, which is why the
 * page also offers copy-to-clipboard.
 */
export function buildMailtoHref(draft: EmailDraft): string {
  const params = new URLSearchParams({ subject: draft.subject, body: draft.body });
  return `mailto:${draft.to}?${params.toString().replace(/\+/g, '%20')}`;
}

export function draftToClipboardText(draft: EmailDraft): string {
  return [`To: ${draft.to}`, `Subject: ${draft.subject}`, '', draft.body].join('\n');
}
