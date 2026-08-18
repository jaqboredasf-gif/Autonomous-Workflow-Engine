// Download an uploaded attachment — the photograph of the packing slip, the
// picture of the panel a request was raised for.
//
// A transport shell, exactly like the document route beside it: session in, use
// case, bytes out. The authorization decision is
// queries.getAttachmentForDownload, which resolves the file to the request it
// belongs to and refuses anybody who may not read that request.
//
// Headers are built by server/file-response.ts rather than here, because the
// filename and the content type came from whoever uploaded the file and neither
// belongs in a header unexamined.
import { NextResponse } from 'next/server';

import { getAttachmentForDownload } from '../../../../purchasing/application/queries.ts';
import { currentActor, mustChangePassword, purchasingRequestContext } from '../../../../server/session.ts';
import { fileDownloadResponse } from '../../../../server/file-response.ts';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  if (!actor) return new NextResponse('Sign in first.', { status: 401 });
  // See the documents route: a redirect means nothing to a download, so the
  // same rule is stated as a refusal.
  if (mustChangePassword(actor)) {
    return new NextResponse('Change your password before using PCC.', { status: 403 });
  }

  let attachment;
  try {
    attachment = await getAttachmentForDownload(await purchasingRequestContext(), actor, id);
  } catch {
    // A refusal from the authorization check. Reported as 404, the same as an
    // unknown id: telling somebody a file exists but is not theirs confirms
    // the existence of a record they are not allowed to know about.
    return new NextResponse('Not found.', { status: 404 });
  }
  if (!attachment) return new NextResponse('Not found.', { status: 404 });

  return fileDownloadResponse(attachment);
}
