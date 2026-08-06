/* eslint-disable @typescript-eslint/no-explicit-any */
import { notFound, redirect } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../../server/session.ts';
import * as S from '../../../../server/service.ts';
import ReceiveForm from '../../../../components/ReceiveForm';
import { Empty, Section } from '../../../../components/ui';

export const dynamic = 'force-dynamic';

export default async function ReceivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAccess('/requests');

  let detail: any;
  try {
    detail = await S.getRequestDetail(purchasingRequestContext(), actor, id);
  } catch {
    notFound();
  }

  if (!detail.actions.includes('receive')) {
    return (
      <Section title="Receiving">
        <Empty>This request is not awaiting delivery, or you are not authorized to record receiving.</Empty>
      </Section>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">
        Receiving · {detail.request.requestNumber} · PO {detail.purchaseOrder?.poNumber}
      </h1>
      <ReceiveForm requestId={id} progress={detail.progress} receipts={detail.receipts} />
    </div>
  );
}
