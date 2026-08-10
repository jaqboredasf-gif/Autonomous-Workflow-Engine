import { requireAccess, purchasingRequestContext } from '../../../server/session.ts';
import * as S from '../../../server/service.ts';
import NewRequestForm from '../../../components/NewRequestForm';
import { hasPermission } from '../../../purchasing/domain/roles.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'New request — Lippolis Purchasing' };

export default async function NewRequestPage() {
  const actor = await requireAccess('/requests/new');
  const ctx = await purchasingRequestContext();
  const locations = (await S.listDeliveryLocations(ctx, actor)).map((l: Record<string, unknown>) => ({
    id: String(l.id),
    name: String(l.name),
    kind: String(l.kind),
  }));
  const jobs = (await S.listJobs(ctx, actor)).map((j: Record<string, unknown>) => ({
    number: String(j.job_number),
    name: String(j.name),
  }));

  // The vendor list is offered as a SUGGESTION source only. A requester
  // naming a supplier does not select one — see withVendorSuggestion() in
  // actions.ts and REQUESTOR_FORBIDDEN_FIELDS in domain/roles.mjs.
  let vendors: Array<{ id: string; name: string }> = [];
  try {
    vendors = (await S.listVendors(ctx, actor)).map((v: Record<string, unknown>) => ({
      id: String(v.id),
      name: String(v.name),
    }));
  } catch {
    vendors = [];
  }

  return (
    <NewRequestForm
      actorName={actor.name}
      now={new Date().toISOString()}
      vendors={vendors}
      locations={locations}
      jobs={jobs}
      canConfigure={hasPermission(actor, 'admin.locations')}
    />
  );
}
