'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// Receiving. Nothing here assumes the whole order turned up at once: each line
// records what actually arrived, what was damaged, what is backordered, and
// what is being written off — and the request only reaches RECEIVED when every
// line is accounted for.
import { useActionState } from 'react';

import { recordReceiptAction } from '../app/actions.ts';
import { formatQty } from '../purchasing/domain/numbers.mjs';
import { Field, Section, buttonClass, inputClass } from './ui';

export default function ReceiveForm({
  requestId,
  progress,
  receipts,
}: {
  requestId: string;
  progress: any[];
  receipts: any[];
}) {
  const [state, formAction, pending] = useActionState(recordReceiptAction, null as any);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="requestId" value={requestId} />

      {state && state.ok === false ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{state.error}</div>
      ) : null}
      {state && state.ok ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          Receipt recorded. {state.data?.outstandingLines ? `${state.data.outstandingLines} line(s) still outstanding.` : 'Everything is accounted for.'}
        </div>
      ) : null}

      <Section title="This delivery">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Date received" required>
            <input type="date" name="receivedDate" className={inputClass} defaultValue={new Date().toISOString().slice(0, 10)} />
          </Field>
          <Field label="Packing slip number">
            <input name="packingSlipNumber" className={inputClass} />
          </Field>
          <Field label="Receiving notes">
            <input name="receiptNotes" className={inputClass} />
          </Field>
        </div>
      </Section>

      <Section title="Lines" subtitle="Enter only what arrived this time. Partial deliveries are expected.">
        <div className="space-y-3">
          {progress.map((p) => (
            <div key={p.purchaseOrderItemId} className="rounded-md border border-slate-200 p-3">
              <input type="hidden" name="receiptPoItemId" value={p.purchaseOrderItemId} />
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-slate-900">{p.description}</span>
                <span className="text-xs text-slate-600">
                  ordered {formatQty(p.finalOrderQty)} {p.unit} · received {formatQty(p.receivedQty)} · outstanding{' '}
                  <strong className={p.outstandingQty > 0 ? 'text-amber-700' : 'text-emerald-700'}>
                    {formatQty(p.outstandingQty)}
                  </strong>
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Field label="Received now">
                  <input name="receiptReceivedQty" className={inputClass} inputMode="decimal" defaultValue="" />
                </Field>
                <Field label="Damaged">
                  <input name="receiptDamagedQty" className={inputClass} inputMode="decimal" defaultValue="" />
                </Field>
                <Field label="Backordered">
                  <input name="receiptBackorderedQty" className={inputClass} inputMode="decimal" defaultValue="" />
                </Field>
                <Field label="Written off" hint="Short-shipped and not coming.">
                  <input name="receiptWrittenOffQty" className={inputClass} inputMode="decimal" defaultValue="" />
                </Field>
                <Field label="Over-receipt reason" hint="Required to accept more than ordered.">
                  <input name="receiptOverrideReason" className={inputClass} />
                </Field>
              </div>
              <div className="mt-2">
                <Field label="Line notes">
                  <input name="receiptLineNotes" className={inputClass} />
                </Field>
              </div>
            </div>
          ))}
        </div>
        <button className={`${buttonClass} mt-4`} disabled={pending}>
          {pending ? 'Recording…' : 'Record receipt'}
        </button>
      </Section>

      {receipts.length ? (
        <Section title="Previous receipts">
          <ul className="space-y-1 text-sm text-slate-700">
            {receipts.map((r: any) => (
              <li key={r.id}>
                {r.receivedDate}
                {r.packingSlipNumber ? ` · packing slip ${r.packingSlipNumber}` : ''}
                {r.isFinal ? ' · final' : ' · partial'}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </form>
  );
}
