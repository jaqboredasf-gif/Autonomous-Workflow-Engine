'use client';
// ---------------------------------------------------------------------------
// PaperActions — the two outputs the pilot said actually matter.
//
// The purchaser keeps a paper PO and attaches the vendor's receipt to it, and
// he sends the order to the vendor himself. So printing and copying are not
// conveniences at the edge of the product; they are the product's output, and
// they get real buttons rather than a "Download PDF" link in a corner.
//
// Client components for one reason each: window.print() and the clipboard.
// Neither does any thinking — no data, no decisions, no formatting rules.
// ---------------------------------------------------------------------------
import { useState } from 'react';

import { Button } from './Button';

/** Opens the browser's print dialog on the sheet the page already renders. */
export function PrintButton({ label = 'Print PO' }: { label?: string }) {
  return (
    <Button type="button" size="l" onClick={() => window.print()} className="no-print">
      {label}
    </Button>
  );
}

/**
 * Copy the vendor email to the clipboard.
 *
 * Copy rather than send: this application has no mail transport by design
 * (`external_send_enabled` is pinned false by a CHECK constraint), and the
 * purchaser wants to send from his own mailbox anyway — his signature, his
 * sent-items, his relationship with the vendor. So the useful act is putting
 * the text where he can paste it.
 *
 * The textarea underneath is not a fallback nobody sees: clipboard access can
 * be refused by the browser, and a copy button that silently does nothing is
 * worse than no button. He can always select the text himself.
 */
export function CopyEmailButton({ subject, body }: { subject: string; body: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = `Subject: ${subject}\n\n${body}`;

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState('copied');
            setTimeout(() => setState('idle'), 2500);
          } catch {
            setState('failed');
          }
        }}
      >
        Copy email
      </Button>
      {/* role=status so the confirmation is announced, not only coloured. */}
      <span role="status" className="text-sm text-muted">
        {state === 'copied' ? 'Copied — paste it into your mail app.' : null}
        {state === 'failed' ? 'Could not copy. Select the text below instead.' : null}
      </span>
    </span>
  );
}

/** A mailto: link, pre-filled. Opens whatever mail app the machine uses. */
export function MailtoLink({ to, subject, body }: { to?: string | null; subject: string; body: string }) {
  const href = `mailto:${to ?? ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <a
      href={href}
      className="inline-flex items-center rounded-md border border-line px-3 py-2 text-sm font-medium text-ink hover:border-accent"
    >
      Open in mail app
    </a>
  );
}
