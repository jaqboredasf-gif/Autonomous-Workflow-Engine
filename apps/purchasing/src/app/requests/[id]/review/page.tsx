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

  // A refusal, not a message. Every other unauthorized area of the
  // application redirects to /unauthorized, which tells the person what they
  // CAN open; rendering a 200 here made "you may not do this" look like a
  // page that had merely failed to load its contents.
  if (!hasPermission(actor, 'review.decide')) redirect('/unauthorized');
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
  const materialHistory = await S.reviewMaterialHistory(ctx, actor, id);

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
        materialHistory={materialHistory}
      />
    </div>
  );
}
