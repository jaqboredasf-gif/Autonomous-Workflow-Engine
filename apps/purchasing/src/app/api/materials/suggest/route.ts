// Material autocomplete.
//
// A read endpoint, authorized like any other: the caller is resolved from the
// server-side session, requireAccess() applies the route guard, and
// suggestMaterials() applies the permission check again with the actor loaded.
// The browser sends a query string and nothing else — no organization id, no
// user id — because it is not trusted with either.
import { NextResponse } from 'next/server';

import { requireAccess, purchasingRequestContext } from '../../../../server/session.ts';
import { suggestMaterials } from '../../../../purchasing/application/queries.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const actor = await requireAccess('/api/materials/suggest');
  const query = new URL(request.url).searchParams.get('q') ?? '';

  try {
    const ctx = await purchasingRequestContext();
    const entries = await suggestMaterials(ctx, actor, query, 8);
    return NextResponse.json({
      // Only what the control needs. The cost history and vendor relationship
      // stay on the server: a requester does not price the job.
      items: entries.map((e) => ({
        id: e.catalogItemId,
        key: e.normalizedDescription,
        description: e.canonicalDescription,
        unit: e.defaultUnit,
        catalogNumber: e.catalogNumber,
        timesRequested: e.timesRequested,
        completedOrderCount: e.completedOrderCount,
        commonQuantity: e.commonQuantity,
        lastOrderedAt: e.lastOrderedAt,
      })),
    });
  } catch {
    // A suggestion failing must never block raising a request. The form falls
    // back to free text, which the domain accepts by design.
    return NextResponse.json({ items: [] });
  }
}
