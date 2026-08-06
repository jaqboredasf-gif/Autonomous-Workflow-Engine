import { redirect } from 'next/navigation';

import { currentActor } from '../../../server/session.ts';
import { getDb } from '../../../server/db.ts';
import * as S from '../../../server/service.ts';
import NewRequestForm from '../../../components/NewRequestForm';

export const dynamic = 'force-dynamic';

export default async function NewRequestPage() {
  const actor = await currentActor();
  if (!actor) redirect('/signin');
  const ctx = S.context(getDb());

  return (
    <NewRequestForm
      actorName={actor.name}
      locations={S.listDeliveryLocations(ctx, actor).map((l: Record<string, unknown>) => ({
        id: String(l.id),
        name: String(l.name),
        kind: String(l.kind),
      }))}
      jobs={S.listJobs(ctx, actor).map((j: Record<string, unknown>) => ({
        number: String(j.job_number),
        name: String(j.name),
      }))}
    />
  );
}
