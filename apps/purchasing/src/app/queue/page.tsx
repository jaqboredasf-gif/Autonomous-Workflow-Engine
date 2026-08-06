/* eslint-disable @typescript-eslint/no-explicit-any */
// The workshop approval queue — Mike's and Rick's front door.
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { currentActor } from '../../server/session.ts';
import { getDb } from '../../server/db.ts';
import * as S from '../../server/service.ts';
import { Empty, Section, StatusBadge } from '../../components/ui';
import { isOverdue } from '../../domain/dashboard.mjs';
import { formatQty } from '../../domain/numbers.mjs';

export const dynamic = 'force-dynamic';

export default async function QueuePage() {
  const actor = await currentActor();
  if (!actor) redirect('/signin');

  let queue: any[] = [];
  try {
    queue = S.approvalQueue(S.context(getDb()), actor);
  } catch {
    return (
      <Section title="Workshop queue">
        <Empty>You do not have access to the workshop approval queue.</Empty>
      </Section>
    );
  }

  const now = new Date().toISOString();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Workshop approval queue</h1>
        <p className="mt-1 text-sm text-slate-600">
          {actor.isPrimaryApprover
            ? 'You are the primary approver.'
            : actor.isBackupApprover
              ? 'You are the authorized backup approver.'
              : 'You hold approval authority by grant.'}
        </p>
      </div>

      {queue.length === 0 ? (
        <Empty>Nothing waiting. Everything submitted has been decided.</Empty>
      ) : (
        <ul className="space-y-2">
          {queue.map((r) => (
            <li key={r.id}>
              <Link
                href={`/requests/${r.id}/review`}
                className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-slate-400"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-900">
                    {r.requestNumber} · job {r.jobNumber}
                  </span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="mt-1 text-xs text-slate-600">
                  {r.requestorName} · needs {formatQty(r.requestedQty)} unit(s) by {r.needByDate} at {r.needByTime}
                  {isOverdue(r, now) ? <span className="ml-2 font-medium text-rose-700">overdue</span> : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
