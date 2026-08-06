'use client';
// ---------------------------------------------------------------------------
// SignInForm — the front door.
//
// Mobile-first: a foreman opens this on a phone in a parking lot. One column,
// large targets, real input types so the phone shows the right keyboard, and
// autocomplete hints so a password manager can fill it.
//
// Accessibility: a real <form> with a submit button (Enter works), labels tied
// to inputs, the error announced through aria-live and referenced by
// aria-describedby, and focus never trapped.
// ---------------------------------------------------------------------------

import { useActionState } from 'react';
import Link from 'next/link';

import { signInAction, demoSignInAction, type SignInState } from '../app/auth-actions.ts';

export default function SignInForm({
  next,
  notice,
  demo,
}: {
  next: string;
  notice: string | null;
  demo: Array<{ id: string; name: string; email: string; roles: string[] }> | null;
}) {
  const [state, formAction, pending] = useActionState<SignInState, FormData>(signInAction, null);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-slate-900 text-lg font-semibold text-white">
            LE
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Lippolis Electric</h1>
          <p className="mt-1 text-sm text-slate-600">Purchasing Control Center</p>
        </header>

        {notice ? (
          <p className="mb-4 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700" role="status">
            {notice}
          </p>
        ) : null}

        <form action={formAction} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <input type="hidden" name="next" value={next} />

          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-800">
              Email
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
              className="w-full rounded-md border border-slate-300 px-3 py-3 text-base text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-800">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              aria-describedby={state?.error ? 'sign-in-error' : undefined}
              className="w-full rounded-md border border-slate-300 px-3 py-3 text-base text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>

          {state?.error ? (
            <p
              id="sign-in-error"
              role="alert"
              aria-live="polite"
              className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900"
            >
              {state.error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className="flex w-full items-center justify-center rounded-md bg-slate-900 px-4 py-3 text-base font-medium text-white shadow-sm transition hover:bg-slate-700 disabled:opacity-60"
          >
            {pending ? (
              <>
                <span
                  aria-hidden="true"
                  className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                />
                Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </button>

          <p className="text-center text-sm">
            <Link href="/forgot-password" className="text-slate-600 underline underline-offset-2 hover:text-slate-900">
              Forgot your password?
            </Link>
          </p>
        </form>

        {demo ? (
          <section className="mt-6 rounded-xl border border-dashed border-amber-400 bg-amber-50 p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-900">
              Developer demo mode
            </h2>
            <p className="mt-1 text-xs text-amber-900">
              PURCHASING_DEMO_MODE=1 is set. These buttons skip the password. Refused in production.
            </p>
            <ul className="mt-3 space-y-1">
              {demo.map((u) => (
                <li key={u.id}>
                  <form action={demoSignInAction}>
                    <input type="hidden" name="userId" value={u.id} />
                    <button
                      type="submit"
                      className="w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-left text-sm text-slate-800 hover:border-amber-500"
                    >
                      {u.name} <span className="text-xs text-slate-500">· {u.roles.join(', ')}</span>
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
