// /email-drafts/:id — the canonical link to a vendor email draft.
import { notFound, redirect } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../server/session.ts';

export const dynamic = 'force-dynamic';

export default async function EmailDraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAccess('/email-drafts');
  const ctx = purchasingRequestContext();

  const draft = ctx.drafts.findById(id);
  if (!draft || draft.orgId !== actor.orgId) notFound();
  redirect(`/requests/${draft.requestId}/email`);
}
