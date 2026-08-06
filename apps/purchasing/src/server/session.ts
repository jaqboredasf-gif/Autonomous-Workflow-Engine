// ---------------------------------------------------------------------------
// session.ts — who the server says you are, and what you may open.
//
// The pilot's identity picker is gone. A session now exists only because a
// credential provider verified an email and password (AuthPort), and the cookie
// that carries it is signed, expiring and httpOnly. On every request the server:
//
//   1. verifies the cookie's signature and expiry (never the browser's claim)
//   2. loads the user FROM THE DATABASE — roles, org, active flag, assignments
//   3. applies routeDecision() for the path being opened
//
// Step 2 is why a stolen-then-revoked account stops working immediately: the
// cookie says who, the database says whether, and the database wins.
//
// The demo identity picker survives behind PURCHASING_DEMO_MODE=1, refused in
// production by validateEnvironment(). It is a developer convenience, not a
// sign-in path.
// ---------------------------------------------------------------------------

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { getDb } from '../purchasing/infrastructure/sqlite/database.ts';
import { seed } from '../purchasing/infrastructure/seed.ts';
import { purchasingContext } from '../purchasing/composition.ts';
import { loadConfig } from '../purchasing/infrastructure/env.ts';
import { authAdapter } from '../purchasing/infrastructure/auth/index.ts';
import {
  SESSION_COOKIE, newSessionPayload, signSession, verifySession,
} from '../purchasing/infrastructure/auth/session-token.ts';
import { identityAdapter } from '../purchasing/infrastructure/adapters.ts';
import { routeDecision, defaultWorkspaceFor } from '../purchasing/domain/workspaces.mjs';
import type { Actor } from '../purchasing/application/ports.ts';

export type { Actor };

function database() {
  const db = getDb();
  seed(db);
  return db;
}

/** The composed purchasing context for one request. */
export function purchasingRequestContext() {
  return purchasingContext(database());
}

/**
 * The signed-in user, or null. Verifies the cookie, then re-reads the person
 * from the database — a session is a claim, not a fact.
 */
export async function currentActor(): Promise<Actor | null> {
  const config = loadConfig();
  const store = await cookies();
  const verified = await verifySession(store.get(SESSION_COOKIE)?.value, config.sessionSecret);
  if (!verified.valid) return null;

  const actor = identityAdapter(database()).load(verified.payload.uid);
  if (!actor || !actor.isActive) return null;
  return actor;
}

/** Why there is no session — so the UI can say "expired" rather than "denied". */
export async function sessionState(): Promise<'valid' | 'missing' | 'expired' | 'invalid'> {
  const config = loadConfig();
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const verified = await verifySession(token, config.sessionSecret);
  if (verified.valid) return 'valid';
  if (verified.reason === 'missing') return 'missing';
  if (verified.reason === 'expired') return 'expired';
  return 'invalid';
}

/**
 * THE page guard. Every protected page calls it first. The middleware already
 * refused unauthenticated traffic; this repeats the decision with the real user
 * loaded, because a middleware can be misconfigured and a page must not assume.
 */
export async function requireAccess(pathname: string): Promise<Actor> {
  const actor = await currentActor();
  const decision = routeDecision(actor, pathname);
  if (!decision.allow) {
    if (decision.reason === 'no_session') {
      const state = await sessionState();
      redirect(state === 'expired' ? '/session-expired' : `/sign-in?next=${encodeURIComponent(pathname)}`);
    }
    redirect(decision.redirect);
  }
  return actor as Actor;
}

/** Where this person belongs after signing in. */
export async function defaultWorkspace(): Promise<string> {
  const actor = await currentActor();
  return actor ? defaultWorkspaceFor(actor) : '/sign-in';
}

// --- sign in / out ----------------------------------------------------------

export type SignInOutcome =
  | { ok: true; redirectTo: string }
  | { ok: false; error: 'invalid_credentials' | 'account_disabled' | 'unavailable' | 'missing_fields' };

/**
 * Verify credentials and start a session. The error vocabulary is deliberately
 * coarse for the browser: a wrong password and an unknown address both report
 * `invalid_credentials`, because telling a stranger which addresses have
 * accounts is a favour to the wrong person.
 */
export async function signIn(email: string, password: string, next?: string): Promise<SignInOutcome> {
  if (!email?.trim() || !password) return { ok: false, error: 'missing_fields' };

  const config = loadConfig();
  const db = database();
  const result = await authAdapter(db, config).signIn(email, password);
  if (!result.ok) return { ok: false, error: result.reason };

  const actor = identityAdapter(db).load(result.userId);
  if (!actor || !actor.isActive) return { ok: false, error: 'account_disabled' };

  const token = await signSession(
    newSessionPayload(actor.id, config.authProvider, config.sessionTtlSeconds),
    config.sessionSecret,
  );
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    maxAge: config.sessionTtlSeconds,
  });

  // Only ever redirect INSIDE this application: an open redirect on a sign-in
  // form is a phishing primitive.
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;
  return { ok: true, redirectTo: safeNext ?? defaultWorkspaceFor(actor) };
}

export async function signOut() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

// --- developer demo mode ----------------------------------------------------

/** Is the demo identity picker available? False in production, always. */
export function demoModeEnabled(): boolean {
  return loadConfig().demoMode;
}

/** The demo picker's options. Refused unless demo mode is explicitly on. */
export function demoAccounts() {
  if (!demoModeEnabled()) return [];
  const db = database();
  const rows = db
    .prepare('select id, full_name, email, is_active from users where is_active = 1 order by full_name')
    .all() as Array<Record<string, unknown>>;
  return rows.map((u) => ({
    id: String(u.id),
    name: String(u.full_name),
    email: String(u.email),
    roles: (db.prepare('select role_key from user_roles where user_id = ?').all(u.id as string) as Array<{ role_key: string }>)
      .map((r) => r.role_key),
  }));
}

/** Start a session as a demo account, without a password. Developer tool only. */
export async function signInAsDemoUser(userId: string): Promise<SignInOutcome> {
  if (!demoModeEnabled()) return { ok: false, error: 'invalid_credentials' };
  const config = loadConfig();
  const actor = identityAdapter(database()).load(userId);
  if (!actor || !actor.isActive) return { ok: false, error: 'account_disabled' };

  const token = await signSession(
    newSessionPayload(actor.id, 'local', config.sessionTtlSeconds),
    config.sessionSecret,
  );
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProduction, path: '/', maxAge: config.sessionTtlSeconds,
  });
  return { ok: true, redirectTo: defaultWorkspaceFor(actor) };
}
