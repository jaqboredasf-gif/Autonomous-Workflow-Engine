'use client';
import { useActionState } from 'react';
import Link from 'next/link';

import { forgotPasswordAction, type ForgotPasswordState } from '../auth-actions.ts';

export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState<ForgotPasswordState, FormData>(forgotPasswordAction, null);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold text-slate-900">Reset your password</h1>
        <p className="mb-6 text-sm text-slate-600">
          Enter the email address you sign in with and we will let the office know.
        </p>

        {/*
          THE SAME PANEL FOR EVERY ADDRESS. It used to print a reset code here
          whenever the address happened to have an account, which handed a live
          credential — and the answer to "does this person have an account" — to
          whoever typed it. Recovery is an administrator setting a new password;
          nothing on this screen is a way in.
        */}
        {state?.sent ? (
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm" role="status">
            <p className="text-sm text-slate-800">
              If that address has an account, the office can set a new password for it.
            </p>
            <p className="text-sm text-slate-600">
              Ask an administrator — Administration → Users → <span className="font-medium">Reset access</span>. They
              will give you a temporary password to sign in with.
            </p>
            <Link href="/sign-in" className="block text-sm text-slate-700 underline underline-offset-2">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form action={formAction} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
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
                required
                className="w-full rounded-md border border-slate-300 px-3 py-3 text-base shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
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
              {pending ? 'Sending…' : 'Request a password reset'}
            </button>
            <p className="text-center text-sm">
              <Link href="/sign-in" className="text-slate-600 underline underline-offset-2 hover:text-slate-900">
                Back to sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
