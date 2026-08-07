/* eslint-disable @typescript-eslint/no-explicit-any */
// Screen 06 — receiving one order.
//
// The authority check is not cosmetic: `detail.actions` comes from
// availableActions(), which for `receiving.record` is assignment-scoped — a
// foreman may sign for his own job sites and nobody else's. The refusal below
// is the courtesy; recordReceipt() refuses again on the server with the record
// in hand, which is the control.
import { notFound } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../../server/session.ts';
import * as S from '../../../../server/service.ts';
import ReceiveForm from '../../../../components/ReceiveForm';
import { Alert, ButtonLink, PageHeader } from '../../../../components/pcc';

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

  if (!detail.actions.includes('receive')) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <PageHeader title="Receiving" breadcrumb={[{ label: 'Receiving', href: '/receiving' }, { label: 'Not available' }]} />
        <Alert tone="warning" title="You cannot record receiving on this order">
          Either it is not awaiting delivery, or it is on a job you are not assigned to. If that is wrong, the office
          can assign you to the job.
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
