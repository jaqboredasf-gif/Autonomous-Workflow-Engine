/* eslint-disable @typescript-eslint/no-explicit-any */
// Screen 06 — receiving one order.
//
// The authority check is not cosmetic: `receiving.record` is assignment-scoped
// for field users — a foreman signs for his own job sites and nobody else's.
// The refusal below is the courtesy; recordReceipt() refuses again on the
// server with the record in hand, which is the control.
//
// BR-014: the refusal SAYS WHICH THING IS WRONG. One message covering "you may
// not do this" and "this order is not awaiting delivery" made every case look
// like a permissions problem, and sent people with full receipt authority off
// to ask for authority they already had. Nothing here tests who requested or
// approved the order, because that has never been a receiving question.
import { notFound } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../../server/session.ts';
import * as S from '../../../../server/service.ts';
import { receivingAvailability } from '../../../../purchasing/domain/roles.mjs';
import ReceiveForm from '../../../../components/ReceiveForm';
import { Alert, ButtonLink, PageHeader } from '../../../../components/pcc';

/** One explanation per reason, each true only of the case it names. */
const REFUSALS: Record<string, { title: string; body: string }> = {
  no_capability: {
    title: 'Recording receipts is not part of your access',
    body: 'Signing for deliveries is granted per person. An administrator can add it, or ask whoever receives at the shop counter to record this one.',
  },
  not_assigned: {
    title: 'This order is for a job site you are not assigned to',
    body: 'You can record receiving on your own job sites. If you are covering this one, the office can assign you to the job.',
  },
  not_receivable: {
    title: 'This order is not awaiting delivery',
    body: 'It has either already been received in full, or it has not been ordered yet. Your access is not the problem — open the order to see where it stands.',
  },
  cross_tenant: {
    title: 'That order belongs to another organization',
    body: 'It is not visible from this account.',
  },
};

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Receiving — Lippolis Purchasing' };

export default async function ReceivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAccess('/requests');

  let detail: any;
  try {
    detail = await S.getRequestDetail(await purchasingRequestContext(), actor, id);
  } catch {
    notFound();
  }

  // Asked of the same domain function the server enforces with, and given the
  // server-resolved job assignments — never anything the browser sent.
  const availability = receivingAvailability(actor, detail.request, {
    assignedJobNumbers: actor.assignedJobNumbers,
  });

  if (!availability.ok) {
    const refusal = REFUSALS[availability.reason ?? ''] ?? {
      title: 'Receiving is not available for this order',
      body: availability.message ?? 'Open the order to see where it stands.',
    };
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <PageHeader title="Receiving" breadcrumb={[{ label: 'Receiving', href: '/receiving' }, { label: 'Not available' }]} />
        {/* A wrong status is information, not a warning about the person. */}
        <Alert tone={availability.reason === 'not_receivable' ? 'info' : 'warning'} title={refusal.title}>
          {refusal.body}
        </Alert>
        <ButtonLink href={`/requests/${id}`} variant="secondary">
          Open the order instead
        </ButtonLink>
      </div>
    );
  }

  const r = detail.request;

  return (
    <ReceiveForm
      requestId={id}
      progress={detail.progress}
      receipts={detail.receipts}
      header={{
        poNumber: detail.purchaseOrder?.poNumber ?? null,
        requestNumber: r.requestNumber,
        jobNumber: r.jobNumber,
        vendorName: r.vendorName ?? null,
        status: r.status,
      }}
    />
  );
}
