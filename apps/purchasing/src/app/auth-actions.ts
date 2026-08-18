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

import { signIn, signOut, signInAsDemoUser, demoModeEnabled, currentActor, renewSession } from '../server/session.ts';
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

// NO `token` FIELD, DELIBERATELY, AND IT MUST NOT COME BACK.
//
// This state is returned to an UNAUTHENTICATED browser. It used to carry the
// reset token for the local provider, which meant anybody who could reach the
// sign-in page could read a live credential for anybody else's account — the
// administrator's included — by typing their address. See local-auth.ts.
//
// The type is the guard: with nowhere to put a token, the action cannot leak
// one by accident, and an eval asserts this file never reads `.token`.
export type ForgotPasswordState = { sent: boolean; error?: string | null } | null;

export async function forgotPasswordAction(_prev: ForgotPasswordState, formData: FormData): Promise<ForgotPasswordState> {
  const email = String(formData.get('email') ?? '');
  if (!email.trim()) return { sent: false, error: 'Enter your email address.' };

  const config = loadConfig();
  await authAdapter(getDb(), config).requestPasswordReset(email);
  // The precise outcome goes to the server log, where the people who operate
  // PCC can see it and a stranger cannot.
  log.info('auth.password_reset_requested', { email, provider: config.authProvider });

  // ONE ANSWER, WHETHER OR NOT THE ADDRESS EXISTS. Same shape, same words, same
  // work: which addresses have accounts here is not a stranger's business, and
  // a response that varies is an answer to that question.
  return { sent: true };
}

export type ChangePasswordState = { error: string | null } | null;

/**
 * Replace a password with one only its holder knows.
 *
 * NOT IN actions.ts, and that is the point: every action in that file is
 * refused while a change is outstanding, and this is the one thing such a
 * person must be able to do. It is also the only place `changeOwnPassword` is
 * called, so the flag is cleared exactly when somebody proves they know the
 * current password and picks a different one.
 *
 * Nothing here is returned to the browser but a message, and nothing is logged
 * but the outcome. Neither password appears in either.
 */
export async function changePasswordAction(_prev: ChangePasswordState, formData: FormData): Promise<ChangePasswordState> {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');

  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  const confirmPassword = String(formData.get('confirmPassword') ?? '');

  if (!currentPassword || !newPassword) return { error: 'Fill in every box.' };
  if (newPassword !== confirmPassword) return { error: 'The two new passwords do not match.' };

  const config = loadConfig();
  const result = await authAdapter(getDb(), config).changeOwnPassword(actor.id, currentPassword, newPassword);

  if (!result.ok) {
    log.warn('auth.password_change_failed', { userId: actor.id, reason: result.reason });
    switch (result.reason) {
      case 'weak_password':
        return { error: 'Your new password must be at least 10 characters.' };
      case 'same_password':
        return { error: 'Choose a password different from the one you were given.' };
      case 'unsupported':
        return { error: 'This sign-in provider manages passwords elsewhere. Ask an administrator.' };
      default:
        return { error: 'That current password is not right.' };
    }
  }

  log.info('auth.password_changed', { userId: actor.id });

  // A FRESH SESSION COOKIE. There is no server-side session store to revoke —
  // the cookie is a signed, expiring assertion — so the nearest honest thing is
  // to reissue this browser's cookie on the credential changing. Any other
  // browser holding an old cookie is already governed by the flag, which is
  // re-read from the database on every request.
  await renewSession(actor.id);

  redirect('/?password_changed=1');
}

export async function demoSignInAction(formData: FormData) {
  if (!demoModeEnabled()) redirect('/sign-in');
  const result = await signInAsDemoUser(String(formData.get('userId')));
  if (result.ok) redirect(result.redirectTo);
  redirect('/sign-in?error=demo_unavailable');
}
