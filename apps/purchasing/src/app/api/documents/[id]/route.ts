/* eslint-disable @typescript-eslint/no-explicit-any */
// Download a stored purchase-order document.
//
// Authorization is not skipped because this is "just a file": the caller must
// be signed in, must be able to read the request the document belongs to, and
// the document must be in their organization. Files are records too.
import { NextResponse } from 'next/server';

import { getDb } from '../../../../server/db.ts';
import * as S from '../../../../server/service.ts';
import { currentActor } from '../../../../server/session.ts';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  if (!actor) return new NextResponse('Sign in first.', { status: 401 });

  const db = getDb();
  const doc = db
    .prepare(
      `select d.*, po.request_id, po.org_id
         from purchase_order_documents d
         join purchase_orders po on po.id = d.purchase_order_id
        where d.id = ?`,
    )
    .get(id) as any;
  if (!doc || doc.org_id !== actor.orgId) return new NextResponse('Not found.', { status: 404 });

  try {
    S.getRequestDetail(S.context(db), actor, doc.request_id);
  } catch {
    return new NextResponse('Not found.', { status: 404 });
  }

  return new NextResponse(Buffer.from(doc.data_base64, 'base64'), {
    headers: {
      'Content-Type': doc.content_type,
      'Content-Disposition': `attachment; filename="${doc.filename}"`,
      'Content-Length': String(doc.byte_size),
    },
  });
}
