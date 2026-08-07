/* eslint-disable @typescript-eslint/no-explicit-any */
import { notFound, redirect } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../../server/session.ts';
import * as S from '../../../../server/service.ts';
import ReviewForm from '../../../../components/ReviewForm';
import { Empty, Section } from '../../../../components/ui';
import { hasPermission } from '../../../../purchasing/domain/roles.mjs';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAccess('/requests');

  const ctx = await purchasingRequestContext();
  let detail: any;
  try {
    detail = await S.getRequestDetail(ctx, actor, id);
  } catch {
    notFound();
  }

  if (!hasPermission(actor, 'review.decide')) {
    return (
      <Section title="Workshop review">
        <Empty>Only the workshop approvers decide purchasing. You can follow this request from its detail page.</Empty>
      </Section>
    );
  }
  if (!['PENDING_WORKSHOP_REVIEW', 'RESUBMITTED'].includes(detail.request.status)) {
    return (
      <Section title="Workshop review">
        <Empty>This request is {detail.request.status.toLowerCase().replace(/_/g, ' ')} — it is not awaiting a decision.</Empty>
      </Section>
    );
  }

  const vendors = (await S.listVendors(ctx, actor)).map((v: Record<string, unknown>) => ({
    id: String(v.id),
    name: String(v.name),
  }));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">
        Review {detail.request.requestNumber} · job {detail.request.jobNumber}
      </h1>
      <ReviewForm
        request={detail.request}
        originalItems={detail.originalItems}
        reviewLines={detail.reviewLines}
        vendors={vendors}
      />
    </div>
  );
}
