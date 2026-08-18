'use client';
// ---------------------------------------------------------------------------
// change-password/page.tsx — replace a password somebody else chose.
//
// Deliberately the plainest screen in PCC. It is met by a person who has just
// been handed a password on a piece of paper and wants to get to work, and by
// somebody voluntarily changing a password they already know. Three boxes, one
// button, one sentence saying why they are here.
//
// This screen is not the enforcement. routeDecision() refuses every other route
// while the flag is set and every server action refuses too — this is only the
// way out.
// ---------------------------------------------------------------------------
import { useActionState } from 'react';

import { changePasswordAction, signOutAction, type ChangePasswordState } from '../auth-actions.ts';

const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-3 text-base shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500';

export default function ChangePasswordPage() {
  const [state, formAction, pending] = useActionState<ChangePasswordState, FormData>(changePasswordAction, null);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold text-slate-900">Choose your own password</h1>
        <p className="mb-6 text-sm text-slate-600">
          The password you signed in with was set for you, so somebody else knows it. Pick one only you
          know before using PCC.
        </p>

        <form action={formAction} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <label htmlFor="currentPassword" className="mb-1 block text-sm font-medium text-slate-800">
              The password you just used
            </label>
            <input
              id="currentPassword"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="newPassword" className="mb-1 block text-sm font-medium text-slate-800">
              Your new password
            </label>
            <input
              id="newPassword"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-slate-500">At least 10 characters.</p>
          </div>

          <div>
            <label htmlFor="confirmPassword" className="mb-1 block text-sm font-medium text-slate-800">
              Type it again
            </label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              className={inputClass}
            />
          </div>

          {state?.error ? (
            <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
              {state.error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-slate-900 px-4 py-3 text-base font-medium text-white disabled:opacity-60"
          >
            {pending ? 'Saving…' : 'Save my password'}
          </button>
        </form>

        {/* Always a way out. Somebody who cannot complete this needs to be able
            to leave and telephone the office, not be held on one screen. */}
        <form action={signOutAction} className="mt-4 text-center">
          <button type="submit" className="text-sm text-slate-600 underline underline-offset-2 hover:text-slate-900">
            Sign out instead
          </button>
        </form>
      </div>
    </div>
  );
}
