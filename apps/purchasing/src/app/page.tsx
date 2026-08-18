// The root only routes: it decides where this person belongs and sends them.
import { redirect } from 'next/navigation';

import { currentActor, mustChangePassword } from '../server/session.ts';
import { defaultWorkspaceFor } from '../purchasing/domain/workspaces.mjs';

export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');
  // Straight to the password screen rather than via a workspace that would
  // bounce them here anyway. One hop, not two — and the root is deliberately
  // reachable while the requirement stands, so this is where it is answered.
  redirect(mustChangePassword(actor) ? '/change-password' : defaultWorkspaceFor(actor));
}
