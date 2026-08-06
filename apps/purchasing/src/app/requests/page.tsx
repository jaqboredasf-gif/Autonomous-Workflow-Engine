import { redirect } from 'next/navigation';
import Link from 'next/link';

import { currentActor } from '../../server/session.ts';
import { getDb } from '../../server/db.ts';
import * as S from '../../server/service.ts';
import RequestTable from '../../components/RequestTable';
import { Section } from '../../components/ui';
import { hasPermission } from '../../domain/roles.mjs';

export const dynamic = 'force-dynamic';

export default async function RequestsPage() {
  const actor = await currentActor();
  if (!actor) redirect('/signin');
  const requests = S.listRequests(S.context(getDb()), actor);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">
          {hasPermission(actor, 'request.read.all') ? 'All requests' : 'My requests'}
        </h1>
        <Link href="/requests/new" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white">
          New request
        </Link>
      </div>
      <Section title="Requests" subtitle="Everything you are allowed to see.">
        <RequestTable requests={requests} now={new Date().toISOString()} />
      </Section>
    </div>
  );
}
