import { redirect } from 'next/navigation';

import { currentActor, demoModeEnabled, demoAccounts } from '../../server/session.ts';
import { defaultWorkspaceFor } from '../../purchasing/domain/workspaces.mjs';
import SignInForm from '../../components/SignInForm';
import { loginStrings, normalizeLang } from '../../components/pcc/login-strings';
import { pageTitle } from '../../purchasing/organization/identity.mjs';
import { branding } from '../../purchasing/organization/identity.mjs';

export const dynamic = 'force-dynamic';

export const metadata = { title: pageTitle('Sign in') };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; signed_out?: string; lang?: string }>;
}) {
  const params = await searchParams;

  // Already signed in? Don't show a login form — send them to their work.
  const actor = await currentActor();
  if (actor) redirect(defaultWorkspaceFor(actor));

  const lang = normalizeLang(params.lang);
  const t = loginStrings(lang);

  return (
    <SignInForm
      lang={lang}
      next={params.next ?? ''}
      notice={
        params.signed_out ? t.signedOut : params.error === 'account_disabled' ? t.disabled : null
      }
      demo={demoModeEnabled() ? demoAccounts() : null}
      brand={(() => {
        const b = branding();
        return { shortName: b.shortName, logoSrc: b.logo?.src ?? null, logoFallbackSrc: b.logo?.fallbackSrc ?? null };
      })()}
    />
  );
}
