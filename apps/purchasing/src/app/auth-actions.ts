'use server';
// ---------------------------------------------------------------------------
// auth-actions.ts — sign in, sign out, request a password reset.
//
// These are the only actions that may be called without a session. Each one
// reports a coarse, non-enumerating error to the browser and the precise reason
// to the server log.
// ---------------------------------------------------------------------------

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { signIn, signOut, signInAsDemoUser, demoModeEnabled } from '../server/session.ts';
import { loadConfig } from '../purchasing/infrastructure/env.ts';
import { authAdapter } from '../purchasing/infrastructure/auth/index.ts';
import { getDb } from '../purchasing/infrastructure/sqlite/database.ts';
import { log } from '../purchasing/infrastructure/logging.ts';

export type SignInState = { error: string | null; pending?: boolean } | null;

export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const next = String(formData.get('next') ?? '');

  // The browser form runs server-side, so the client address comes from the
  // request headers rather than from anything the page could set.
  const source = (await headers()).get('x-forwarded-for')?.split(',')[0].trim()
    ?? (await headers()).get('x-real-ip')
    ?? null;

  const result = await signIn(email, password, next || undefined, source);
  if (result.ok) {
    log.info('auth.sign_in', { email, outcome: 'success' });
    redirect(result.redirectTo);
  }

  log.warn('auth.sign_in_failed', { email, reason: result.error });
  return { error: messageFor(result.error) };
}

function messageFor(error: string): string {
  switch (error) {
    case 'missing_fields':
      return 'Enter your email address and password.';
    case 'account_disabled':
      return 'This account has been disabled. Contact the office.';
    case 'too_many_attempts':
      // Deliberately does not say whether the address exists, and deliberately
      // does not print the exact number of seconds — a countdown is a tool for
      // whoever is guessing, and useless to somebody who mistyped.
      return 'Too many sign-in attempts. Wait a few minutes and try again.';
    case 'unavailable':
      return 'Sign-in is temporarily unavailable. Try again in a moment.';
    default:
      // One message for a wrong password AND an unknown address: which
      // addresses have accounts is not a stranger's business.
      return 'That email address and password do not match an account.';
  }
}

export async function signOutAction() {
  await signOut();
  redirect('/sign-in?signed_out=1');
}

export type ForgotPasswordState = { sent: boolean; token?: string | null; error?: string | null } | null;

export async function forgotPasswordAction(_prev: ForgotPasswordState, formData: FormData): Promise<ForgotPasswordState> {
  const email = String(formData.get('email') ?? '');
  if (!email.trim()) return { sent: false, error: 'Enter your email address.' };

  const config = loadConfig();
  const result = await authAdapter(getDb(), config).requestPasswordReset(email);
  log.info('auth.password_reset_requested', { email });

  // The pilot's provider has no mail transport, so it hands the token back for
  // an admin to pass on in person. Supabase sends the email itself and returns
  // no token — the screen says so either way.
  return { sent: true, token: config.authProvider === 'local' ? (result.token ?? null) : null };
}

export async function demoSignInAction(formData: FormData) {
  if (!demoModeEnabled()) redirect('/sign-in');
  const result = await signInAsDemoUser(String(formData.get('userId')));
  if (result.ok) redirect(result.redirectTo);
  redirect('/sign-in?error=demo_unavailable');
}
