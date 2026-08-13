// Download a stored purchase-order document.
//
// The route is a transport shell: session in, use case, bytes out. The
// authorization decision lives in the application layer with every other one
// (queries.getDocumentForDownload), not in this file.
import { NextResponse } from 'next/server';

import { getDocumentForDownload } from '../../../../purchasing/application/queries.ts';
import { currentActor, purchasingRequestContext } from '../../../../server/session.ts';
import { fileDownloadResponse } from '../../../../server/file-response.ts';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  if (!actor) return new NextResponse('Sign in first.', { status: 401 });

  let document;
  try {
    document = await getDocumentForDownload(await purchasingRequestContext(), actor, id);
  } catch {
    return new NextResponse('Not found.', { status: 404 });
  }
  if (!document) return new NextResponse('Not found.', { status: 404 });

  // Shared with the attachment route. These filenames are PCC's own and the
  // type is always application/pdf, so nothing here is currently dangerous —
  // but two download routes with two header policies is how one of them drifts.
  return fileDownloadResponse(document);
}
