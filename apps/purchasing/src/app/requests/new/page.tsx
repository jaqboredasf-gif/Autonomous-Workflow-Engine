import { requireAccess, purchasingRequestContext } from '../../../server/session.ts';
import * as S from '../../../server/service.ts';
import NewRequestForm from '../../../components/NewRequestForm';
import { pageTitle, terminology } from '../../../purchasing/organization/identity.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: pageTitle('New request') };

export default async function NewRequestPage() {
  const actor = await requireAccess('/requests/new');
  const ctx = await purchasingRequestContext();

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

  // THE ORGANIZATION'S POLICY, read where the form is built rather than assumed
  // inside it. `defaultFulfilmentDays` null means the organization has stated no
  // expectation, and the date field starts blank — the behaviour the form has
  // always had.
  const settings = await ctx.reference.settings(actor.orgId);
  const nowIso = new Date().toISOString();
  const defaultNeedByDate = settings.defaultFulfilmentDays == null
    ? ''
    : new Date(Date.parse(nowIso) + settings.defaultFulfilmentDays * 86400000).toISOString().slice(0, 10);

  return (
    <NewRequestForm
      actorName={actor.name}
      now={nowIso}
      defaultNeedByDate={defaultNeedByDate}
      defaultNeedByTime={settings.defaultNeedByTime}
      stockLocationLabel={terminology().stockLocation}
      vendors={vendors}
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
