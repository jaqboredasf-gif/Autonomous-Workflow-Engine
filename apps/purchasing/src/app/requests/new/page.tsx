import { redirect } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../server/session.ts';
import * as S from '../../../server/service.ts';
import NewRequestForm from '../../../components/NewRequestForm';

export const dynamic = 'force-dynamic';

export default async function NewRequestPage() {
  const actor = await requireAccess('/requests/new');
  const ctx = await purchasingRequestContext();

  return (
    <NewRequestForm
      actorName={actor.name}
      locations={(await S.listDeliveryLocations(ctx, actor)).map((l: Record<string, unknown>) => ({
        id: String(l.id),
        name: String(l.name),
        kind: String(l.kind),
      }))}
      jobs={(await S.listJobs(ctx, actor)).map((j: Record<string, unknown>) => ({
        number: String(j.job_number),
        name: String(j.name),
      }))}
    />
  );
}
