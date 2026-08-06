import { redirect } from 'next/navigation';

import { currentActor, demoModeEnabled, demoAccounts } from '../../server/session.ts';
import { defaultWorkspaceFor } from '../../purchasing/domain/workspaces.mjs';
import SignInForm from '../../components/SignInForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in — Lippolis Purchasing' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; signed_out?: string }>;
}) {
  const params = await searchParams;

  // Already signed in? Don't show a login form — send them to their work.
  const actor = await currentActor();
  if (actor) redirect(defaultWorkspaceFor(actor));

  return (
    <SignInForm
      next={params.next ?? ''}
      notice={
        params.signed_out
          ? 'You have been signed out.'
          : params.error === 'account_disabled'
            ? 'This account has been disabled. Contact the office.'
            : null
      }
      demo={demoModeEnabled() ? demoAccounts() : null}
    />
  );
}
