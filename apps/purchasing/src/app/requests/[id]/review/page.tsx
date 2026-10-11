/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../../server/session.ts';
import * as S from '../../../../server/service.ts';
import StockCheckForm from '../../../../components/StockCheckForm';
import ReviewForm from '../../../../components/ReviewForm';
import { Empty, Section } from '../../../../components/ui';
import { hasPermission } from '../../../../purchasing/domain/roles.mjs';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  // THE SIMPLE PATH IS THE DEFAULT. StockCheckForm asks for one number per line
  // and ends in one button. The full nine-field review is still here, one link
  // away, because the office genuinely uses vendor, cost and arrival — and
  // because rejecting or asking a question needs somewhere to live.
  const params2 = await searchParams;
  const full = params2?.view === 'full';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">
          {detail.request.requestNumber} · job {detail.request.jobNumber}
        </h1>
        <p className="text-sm text-muted">
          {detail.request.requestorName} · needed {detail.request.needByDate}
        </p>
      </div>

      {full ? (
        <>
          <Link href={`/requests/${id}/review`} className="inline-block text-sm text-accent underline">
            ← Back to the simple view
          </Link>
          <ReviewForm
            request={detail.request}
            originalItems={detail.originalItems}
            reviewLines={detail.reviewLines}
            vendors={vendors}
          />
        </>
      ) : (
        <>
          <StockCheckForm
            request={detail.request}
            items={detail.originalItems}
            reviewLines={detail.reviewLines}
            vendors={vendors}
          />
          <Link href={`/requests/${id}/review?view=full`} className="inline-block text-sm text-muted underline">
            Reject, ask a question, or use the full review form
          </Link>
        </>
      )}
    </div>
  );
}
