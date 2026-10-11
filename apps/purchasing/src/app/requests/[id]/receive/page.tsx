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
import { pageTitle } from '../../../../purchasing/organization/identity.mjs';

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
    body: 'It has not been ordered yet, or it has already been closed. Your access is not the problem — open the order to see where it stands.',
  },
  cross_tenant: {
    title: 'That order belongs to another organization',
    body: 'It is not visible from this account.',
  },
};

export const dynamic = 'force-dynamic';
export const metadata = { title: pageTitle('Receiving') };

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
    // FINISHING THE JOB IS NOT A REFUSAL. Recording the last delivery moves the
    // order to RECEIVED, and the very next render of this page found it no
    // longer receivable — so the reward for signing for the pallet correctly
    // was a page headed "Not available" saying the order is not awaiting
    // delivery. A person standing at the tailgate reads that as "it did not
    // save" and records it again.
    //
    // The status already distinguishes the two cases. An order that has been
    // received is finished, and this says so.
    const done = ['RECEIVED', 'COMPLETED'].includes(detail.request.status);
    const refusal = done
      ? {
          title: 'Everything on this order has been received',
          body: 'Nothing is outstanding — there is nothing left to sign for. The receipts are on the order.',
        }
      : REFUSALS[availability.reason ?? ''] ?? {
          title: 'Receiving is not available for this order',
          body: availability.message ?? 'Open the order to see where it stands.',
        };
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <PageHeader
          title="Receiving"
          breadcrumb={[{ label: 'Receiving', href: '/receiving' }, { label: done ? 'Complete' : 'Not available' }]}
        />
        {/* A wrong status is information, not a warning about the person. */}
        <Alert tone={done ? 'success' : availability.reason === 'not_receivable' ? 'info' : 'warning'} title={refusal.title}>
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
