// The root only routes: it decides where this person belongs and sends them.
import { redirect } from 'next/navigation';

import { currentActor } from '../server/session.ts';
import { defaultWorkspaceFor } from '../purchasing/domain/workspaces.mjs';

export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const actor = await currentActor();
  redirect(actor ? defaultWorkspaceFor(actor) : '/sign-in');
}
