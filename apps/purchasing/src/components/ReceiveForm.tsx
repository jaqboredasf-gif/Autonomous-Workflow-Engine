'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Screen 06 — Receiving. MOBILE-FIRST.
//
// This is operated on a phone, outdoors, possibly in gloves, by somebody
// standing next to a pallet. One column, 48px controls, the PO and job pinned
// to the top so they never have to scroll up to check what they are signing
// for, and one large confirm at the bottom.
//
// PARTIAL RECEIVING IS THE NORMAL CASE, not an exception. Each line records
// what actually arrived this time; the request only becomes RECEIVED when
// every line is accounted for, and that decision is the SERVER's
// (transitionGuard's `lines_outstanding`), not this form's. Nothing here can
// close a PO early, whatever is typed.
// ---------------------------------------------------------------------------
import { useActionState } from 'react';

import { recordReceiptAction } from '../app/actions.ts';
import { formatQty } from '../purchasing/domain/numbers.mjs';
import { Alert, Button, ButtonLink, Panel, PhotoUpload, ReceivingItem, StatusBadge, TextInput } from './pcc';

export default function ReceiveForm({
  requestId,
  progress,
  receipts,
  header,
}: {
  requestId: string;
  progress: any[];
  receipts: any[];
  header: { poNumber: string | null; requestNumber: string; jobNumber: string; vendorName: string | null; status: string };
}) {
  const [state, formAction, pending] = useActionState(recordReceiptAction, null as any);

  const outstandingLines = progress.filter((p: any) => Number(p.outstandingQty ?? 0) > 0).length;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={formAction} className="mx-auto max-w-2xl space-y-4 pb-28">
      <input type="hidden" name="requestId" value={requestId} />

      {/* Identity, pinned. On a phone this is the thing a person checks twice. */}
      <div className="sticky top-14 z-10 -mx-4 border-b border-line bg-surface px-4 py-3 shadow-sm sm:mx-0 sm:rounded-lg sm:border">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-lg font-semibold text-ink">{header.poNumber ?? header.requestNumber}</p>
            <p className="text-sm text-muted">
              Job {header.jobNumber}
              {header.vendorName ? ` · ${header.vendorName}` : ''}
            </p>
          </div>
          <StatusBadge status={header.status} />
        </div>
      </div>

      {state && state.ok === false ? <Alert tone="danger" title={state.error} /> : null}
      {state && state.ok ? (
        <Alert
          tone={state.data?.outstandingLines ? 'warning' : 'success'}
          title={state.data?.outstandingLines ? 'Partial receipt recorded' : 'Receipt recorded'}
          actions={
            <ButtonLink href={`/requests/${requestId}`} variant="secondary">
              Back to the order
            </ButtonLink>
          }
        >
          {state.data?.outstandingLines
            ? `${state.data.outstandingLines} line(s) are still outstanding. This order stays open until they are accounted for.`
            : 'Everything is accounted for.'}
        </Alert>
      ) : null}

      {outstandingLines === 0 ? (
        <Alert tone="success" title="Nothing outstanding">
          Every line on this order has been accounted for.
        </Alert>
      ) : null}

      <Panel title="This delivery" bodyClassName="space-y-3 p-4">
        <TextInput label="Date received" type="date" name="receivedDate" required defaultValue={today} controlSize="l" />
        <TextInput label="Packing slip number" name="packingSlipNumber" controlSize="l" inputMode="text" />
        <TextInput label="Notes about this delivery" name="receiptNotes" controlSize="l" />
      </Panel>

      <div>
        <h2 className="mb-2 text-base font-semibold text-ink">
          What arrived <span className="font-normal text-muted">({progress.length} lines)</span>
        </h2>
        <ul className="space-y-3">
          {progress.map((line: any, index: number) => (
            <ReceivingItem key={line.purchaseOrderItemId} line={line} index={index} />
          ))}
        </ul>
      </div>

      <Panel title="Evidence" subtitle="A photo now is worth an argument later." bodyClassName="space-y-3 p-4">
        <PhotoUpload name="receiptPhotos" label="Take a photo" size="l" hint="The pallet, the damage, the slip." />
        <div className="pt-1">
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Delivery slip or document</span>
          {/* A separate control so the camera one stays a single tap. */}
          <PhotoUpload name="receiptDocuments" label="Attach a file" size="l" hint="PDF or photo of the packing slip." />
        </div>
      </Panel>

      {receipts.length ? (
        <Panel title="Earlier receipts" bodyClassName="p-4">
          <ul className="space-y-1 text-sm text-ink-soft">
            {receipts.map((r: any) => (
              <li key={r.id}>
                {r.receivedDate}
                {r.packingSlipNumber ? ` · packing slip ${r.packingSlipNumber}` : ''}
                {r.isFinal ? ' · final' : ' · partial'}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* The confirm bar. Fixed to the bottom of the viewport so it is always
          within thumb reach, whatever the length of the order. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface px-4 py-3 shadow-pop">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <div className="min-w-0 flex-1 text-xs text-muted">
            {outstandingLines > 0
              ? `${outstandingLines} of ${progress.length} lines outstanding. A partial receipt keeps this order open.`
              : 'All lines accounted for.'}
          </div>
          <Button type="submit" size="l" disabled={pending} className="min-w-40">
            {pending ? 'Recording…' : 'Record receipt'}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Total still owed on this order, for the page heading. */
export function outstandingSummary(progress: any[]) {
  const qty = progress.reduce((t, p) => t + Number(p.outstandingQty ?? 0), 0);
  return formatQty(qty);
}
