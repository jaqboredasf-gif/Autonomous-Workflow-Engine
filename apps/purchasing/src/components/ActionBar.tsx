'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { inputClass } from './Field';
import { canGeneratePo, statusOnSubmit } from '@/lib/status';
import { usePurchasing } from '@/lib/store-context';
import type { PurchaseRequest } from '@/lib/types';

const primary =
  'rounded-md bg-blue-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-neutral-300';
const secondary =
  'rounded-md border border-neutral-300 bg-white px-3.5 py-2 text-sm font-semibold text-neutral-800 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:text-neutral-400';
const danger =
  'rounded-md border border-red-300 bg-white px-3.5 py-2 text-sm font-semibold text-red-700 hover:bg-red-50';

/**
 * Every button here is simulated. "Mark ordered" records that someone placed
 * the order by phone or counter pickup — it does not transmit anything.
 */
export default function ActionBar({ request }: { request: PurchaseRequest }) {
  const router = useRouter();
  const { state, transition, generatePo } = usePurchasing();
  const [closing, setClosing] = useState<'Rejected' | 'Canceled' | null>(null);
  const [reason, setReason] = useState('');

  const { status } = request;
  const readyToOrder = Boolean(request.poNumber);

  function submitForApproval() {
    const next = statusOnSubmit(request, state.settings);
    transition(
      request.id,
      next,
      next === 'Approved' ? 'Approved' : 'Submitted for approval',
      next === 'Approved' ? 'Auto-approved by the current approval settings' : undefined,
    );
  }

  function handleGeneratePo() {
    generatePo(request.id);
    router.push(`/requests/${request.id}/po`);
  }

  function confirmClose() {
    if (!closing) return;
    transition(
      request.id,
      closing,
      closing,
      reason.trim() || `${closing} without a stated reason`,
    );
    setClosing(null);
    setReason('');
  }

  return (
    <section className="no-print rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-neutral-900">Actions</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Simulated only — nothing is emailed, ordered, or sent to a supplier.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {status === 'Draft' && (
          <button type="button" onClick={submitForApproval} className={primary}>
            Submit request
          </button>
        )}

        {status === 'Pending Approval' && (
          <>
            <button
              type="button"
              onClick={() => transition(request.id, 'Approved', 'Approved')}
              className={primary}
            >
              Approve
            </button>
            <button type="button" onClick={() => setClosing('Rejected')} className={danger}>
              Reject
            </button>
          </>
        )}

        {canGeneratePo(request) && (
          <button type="button" onClick={handleGeneratePo} className={primary}>
            Generate PO
          </button>
        )}

        {request.poNumber && (
          <button
            type="button"
            onClick={() => router.push(`/requests/${request.id}/po`)}
            className={secondary}
          >
            View PO {request.poNumber}
          </button>
        )}

        <button
          type="button"
          onClick={() => router.push(`/requests/${request.id}/email`)}
          className={secondary}
        >
          Generate Email Draft
        </button>

        {status === 'Approved' && (
          <button
            type="button"
            disabled={!readyToOrder}
            title={readyToOrder ? undefined : 'Generate a PO number first'}
            onClick={() =>
              transition(request.id, 'Ordered', 'Marked ordered', 'Simulated — no order was placed')
            }
            className={primary}
          >
            Mark Ordered
          </button>
        )}

        {status === 'Ordered' && (
          <button
            type="button"
            onClick={() => transition(request.id, 'Received', 'Marked received')}
            className={primary}
          >
            Mark Received
          </button>
        )}

        {status === 'Received' && (
          <button
            type="button"
            onClick={() => transition(request.id, 'Completed', 'Completed')}
            className={primary}
          >
            Mark Completed
          </button>
        )}

        {['Draft', 'Pending Approval', 'Approved', 'Ordered'].includes(status) && (
          <button type="button" onClick={() => setClosing('Canceled')} className={danger}>
            Cancel request
          </button>
        )}
      </div>

      {status === 'Approved' && !readyToOrder && (
        <p className="mt-3 text-xs font-medium text-amber-700">
          A PO number is required before this can be marked ordered.
        </p>
      )}

      {closing && (
        <div className="mt-4 rounded-md border border-neutral-300 bg-neutral-50 p-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-600">
            Reason for {closing === 'Rejected' ? 'rejection' : 'cancellation'}
          </label>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={`mt-1.5 ${inputClass}`}
            placeholder="Recorded in the request history."
          />
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={confirmClose} className={danger}>
              Confirm {closing === 'Rejected' ? 'rejection' : 'cancellation'}
            </button>
            <button
              type="button"
              onClick={() => {
                setClosing(null);
                setReason('');
              }}
              className={secondary}
            >
              Never mind
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
