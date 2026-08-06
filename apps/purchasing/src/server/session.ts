// ---------------------------------------------------------------------------
// session.ts — who the server thinks you are.
//
// The pilot has no password store and no identity provider: the workshop PC and
// the foremen's phones are on the company's own devices, and standing up SSO is
// not what milestone 1 is for. What it DOES have is a real server-side session:
// the actor is read from an httpOnly cookie on the server, and every service
// call takes that actor. A client cannot claim to be Mike by editing a form
// field, only by signing in as Mike.
//
// THE GAP, STATED PLAINLY: signing in requires no secret, so this is
// identification, not authentication. Anyone who can reach the app can pick any
// user. That is acceptable on a closed pilot and NOT acceptable in production —
// swap this module for Supabase Auth (the schema and every policy in
// 0016_purchasing_control.sql are already written against auth.uid()) before the
// app is reachable from outside the shop. Nothing else has to change: service.ts
// only ever receives an Actor.
// ---------------------------------------------------------------------------

import { cookies } from 'next/headers';

import { getDb } from './db.ts';
import { loadActor, type Actor } from './service.ts';
import { seed } from './seed.ts';

const COOKIE = 'purchasing_uid';

export async function currentActor(): Promise<Actor | null> {
  const db = getDb();
  seed(db);
  const store = await cookies();
  const id = store.get(COOKIE)?.value;
  if (!id) return null;
  return loadActor(db, id);
}

export async function requireActor(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) throw new Error('not signed in');
  return actor;
}

export async function signIn(userId: string) {
  const store = await cookies();
  store.set(COOKIE, userId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
}

export async function signOut() {
  const store = await cookies();
  store.delete(COOKIE);
}

/** The sign-in picker's options. Not a user directory — a pilot convenience. */
export function signInOptions() {
  const db = getDb();
  seed(db);
  const rows = db
    .prepare('select id, full_name, email, is_primary_approver, is_backup_approver, can_approve from users order by full_name')
    .all() as Array<Record<string, unknown>>;
  return rows.map((u) => ({
    id: String(u.id),
    name: String(u.full_name),
    email: String(u.email),
    isPrimaryApprover: Boolean(u.is_primary_approver),
    isBackupApprover: Boolean(u.is_backup_approver),
    canApprove: Boolean(u.can_approve),
    roles: (db.prepare('select role_key from user_roles where user_id = ?').all(u.id as string) as Array<{ role_key: string }>)
      .map((r) => r.role_key),
  }));
}
