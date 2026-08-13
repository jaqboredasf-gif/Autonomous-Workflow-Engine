/* eslint-disable @typescript-eslint/no-explicit-any */
// The field workspace. Phone-first: this is what a foreman opens standing in a
// parking lot, so it is one column of large targets and no table.
import Link from 'next/link';

import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import { StatusBadge, Empty } from '../../components/ui';
import { nextStepFor } from '../../components/pcc';
import { isOverdue } from '../../purchasing/domain/dashboard.mjs';
import { statusLabel } from '../../purchasing/domain/status.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'My requests — Lippolis Purchasing' };

export default async function MyRequestsPage() {
  const actor = await requireAccess('/my-requests');
  const ctx = await purchasingRequestContext();
  const requests = (await S.listRequests(ctx, actor)).filter(
    (r: any) => r.requestorId === actor.id || r.createdBy === actor.id,
  );
  const now = new Date().toISOString();

  const open = requests.filter((r: any) => !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(r.status));
  const closed = requests.filter((r: any) => ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(r.status));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">My requests</h1>
        <Link
          href="/requests/new"
          className="rounded-md bg-slate-900 px-4 py-3 text-base font-medium text-white shadow-sm"
        >
          New request
        </Link>
      </div>

      {requests.some((r: any) => r.status === 'CLARIFICATION_REQUESTED') ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          The workshop has asked you a question. Open the request marked{' '}
          <strong>{statusLabel('CLARIFICATION_REQUESTED')}</strong> to answer it.
        </div>
      ) : null}

      {open.length === 0 ? (
        <Empty>Nothing open. Raise a request and it goes straight to the workshop queue.</Empty>
      ) : (
        <ul className="space-y-3">
          {open.map((r: any) => (
            <li key={r.id}>
              <Link
                href={`/requests/${r.id}`}
                className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm active:border-slate-400"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-base font-medium text-slate-900">{r.requestNumber}</span>
                  <StatusBadge status={r.status} />
                </div>
                {/* WHO HAS IT. A status badge tells a requester the name of a
                    state; it does not tell him whether anybody is dealing with
                    his cable. This does, in a sentence, and it is the line he
                    opened the page to read. */}
                <div className="mt-1 text-sm font-medium text-slate-800">{nextStepFor(r).waitingOn}</div>
                <div className="mt-1 text-sm text-slate-600">
                  {r.deliveryLocationKind === 'WORKSHOP' ? 'To the workshop' : `Job ${r.jobNumber}`}
                </div>
                <div className="mt-1 text-sm text-slate-600">
                  Needed {r.needByDate} at {r.needByTime}
                  {isOverdue(r, now) ? <span className="ml-2 font-medium text-rose-700">overdue</span> : null}
                </div>
                {r.poNumber ? <div className="mt-1 text-xs text-slate-500">PO {r.poNumber}</div> : null}
                {r.expectedArrivalDate ? (
                  <div className="mt-1 text-xs text-slate-500">Expected {r.expectedArrivalDate}</div>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {closed.length ? (
        <details className="rounded-lg border border-slate-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-800">
            Finished requests ({closed.length})
          </summary>
          <ul className="mt-3 space-y-2">
            {closed.map((r: any) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                <Link href={`/requests/${r.id}`} className="text-slate-800 underline underline-offset-2">
                  {r.requestNumber} · job {r.jobNumber}
                </Link>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
