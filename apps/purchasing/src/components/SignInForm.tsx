'use client';
// ---------------------------------------------------------------------------
// SignInForm — the front door (screen 01).
//
// Mobile-first: a foreman opens this on a phone in a parking lot. One column,
// large targets, real input types so the phone shows the right keyboard, and
// autocomplete hints so a password manager can fill it.
//
// Accessibility: a real <form> with a submit button (Enter works), labels tied
// to inputs, the error announced through aria-live and referenced by
// aria-describedby, and focus never trapped.
//
// AUTHENTICATION IS NOT AUTHORIZATION. Signing in proves who somebody is; what
// they may then open is decided per route by routeDecision() and per record by
// authorize(). A person with a valid company password and no roles reaches
// /unauthorized, not a workspace — see the "no account" note below, which says
// so in the interface rather than leaving it as a surprise.
// ---------------------------------------------------------------------------

import { useActionState } from 'react';
import Link from 'next/link';

import { signInAction, demoSignInAction, type SignInState } from '../app/auth-actions.ts';
import { buttonStyle } from './pcc/Button';
import { Alert } from './pcc/Feedback';
import { loginStrings, type Lang } from './pcc/login-strings';

const controlClass =
  'h-12 w-full rounded-md border border-line-strong bg-surface px-3 text-base text-ink shadow-sm ' +
  'focus:border-action focus:outline-none focus:ring-1 focus:ring-action';

export default function SignInForm({
  next,
  notice,
  demo,
  lang = 'en',
}: {
  next: string;
  notice: string | null;
  demo: Array<{ id: string; name: string; email: string; roles: string[] }> | null;
  lang?: Lang;
}) {
  const [state, formAction, pending] = useActionState<SignInState, FormData>(signInAction, null);
  const t = loginStrings(lang);

  const otherLang: Lang = lang === 'es' ? 'en' : 'es';
  const switchHref = `/sign-in?lang=${otherLang}${next ? `&next=${encodeURIComponent(next)}` : ''}`;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-action text-lg font-semibold text-white">
            LE
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{t.company}</h1>
          <p className="mt-1 text-sm text-muted">{t.product}</p>
        </header>

        {notice ? (
          <Alert tone="info" className="mb-4">
            {notice}
          </Alert>
        ) : null}

        <form action={formAction} className="space-y-4 rounded-xl border border-line bg-surface p-6 shadow-card">
          <input type="hidden" name="next" value={next} />

          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-ink-soft">
              {t.email}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
              aria-describedby={state?.error ? 'sign-in-error' : undefined}
              className={controlClass}
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-ink-soft">
              {t.password}
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              aria-describedby={state?.error ? 'sign-in-error' : undefined}
              className={controlClass}
            />
          </div>

          {state?.error ? (
            <p
              id="sign-in-error"
              role="alert"
              aria-live="polite"
              className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm font-medium text-danger"
            >
              {state.error}
            </p>
          ) : null}

          <button type="submit" disabled={pending} className={buttonStyle('primary', 'l', 'w-full')}>
            {pending ? (
              <>
                <span
                  aria-hidden="true"
                  className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                />
                {t.signingIn}
              </>
            ) : (
              t.signIn
            )}
          </button>

          <p className="text-center text-sm">
            <Link href="/forgot-password" className="text-action underline-offset-2 hover:underline">
              {t.forgot}
            </Link>
          </p>
        </form>

        {/* The unauthorized-account state, stated up front. A company email
            address is not an authorization: somebody has to invite it. */}
        <div className="mt-4 rounded-lg border border-line bg-surface/60 px-4 py-3 text-center">
          <p className="text-xs font-semibold text-ink-soft">{t.noAccount}</p>
          <p className="mt-0.5 text-xs text-muted">{t.noAccountBody}</p>
        </div>

        <p className="mt-4 text-center">
          <Link
            href={switchHref}
            hrefLang={otherLang}
            aria-label={t.switchLabel}
            className="text-sm text-muted underline underline-offset-2 hover:text-ink"
          >
            {t.switchTo}
          </Link>
        </p>

        {demo ? (
          <section className="mt-6 rounded-xl border border-dashed border-warning/60 bg-warning-bg p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-warning">Developer demo mode</h2>
            <p className="mt-1 text-xs text-ink-soft">
              PURCHASING_DEMO_MODE=1 is set. These buttons skip the password. Refused in production.
            </p>
            <ul className="mt-3 space-y-1">
              {demo.map((u) => (
                <li key={u.id}>
                  <form action={demoSignInAction}>
                    <input type="hidden" name="userId" value={u.id} />
                    <button
                      type="submit"
                      className="w-full rounded-md border border-warning/40 bg-surface px-3 py-2 text-left text-sm text-ink-soft hover:border-warning"
                    >
                      {u.name} <span className="text-xs text-muted">· {u.roles.join(', ')}</span>
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
