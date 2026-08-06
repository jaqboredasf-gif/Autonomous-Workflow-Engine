// Download a stored purchase-order document.
//
// The route is a transport shell: session in, use case, bytes out. The
// authorization decision lives in the application layer with every other one
// (queries.getDocumentForDownload), not in this file.
import { NextResponse } from 'next/server';

import { getDocumentForDownload } from '../../../../purchasing/application/queries.ts';
import { currentActor, purchasingRequestContext } from '../../../../server/session.ts';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  if (!actor) return new NextResponse('Sign in first.', { status: 401 });

  let document;
  try {
    document = await getDocumentForDownload(purchasingRequestContext(), actor, id);
  } catch {
    return new NextResponse('Not found.', { status: 404 });
  }
  if (!document) return new NextResponse('Not found.', { status: 404 });

  return new NextResponse(document.bytes, {
    headers: {
      'Content-Type': document.contentType,
      'Content-Disposition': `attachment; filename="${document.filename}"`,
      'Content-Length': String(document.byteSize),
    },
  });
}
