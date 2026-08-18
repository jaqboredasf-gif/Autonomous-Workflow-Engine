/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// local-auth.ts — a real email + password provider for the pilot.
//
// WHY THIS EXISTS: production should authenticate with Supabase Auth (the
// adapter beside this one). But the pilot has to run on a workshop PC with no
// Supabase project, and "no credentials" must not mean "no authentication" —
// the previous pilot sign-in was identity selection, which is not a control.
//
// This is a credential store, NOT part of the purchasing domain:
//   * passwords live in `auth_identities`, a provider table, never in
//     purchase_* tables. The purchasing tables reference a user id and nothing
//     else, exactly as they will when Supabase owns credentials.
//   * passwords are never stored. scrypt(N=16384, r=8, p=1) with a 16-byte
//     random salt per identity, verified in constant time.
//   * a disabled identity fails sign-in with the same shape as a wrong
//     password, and the reason is reported to the server, not the browser.
//
// Node's crypto only — no dependency, nothing to keep patched.
// ---------------------------------------------------------------------------

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { AuthPort, AuthResult } from '../../application/ports.ts';

// The one definition of how a password is stored. `scripts/pcc-reset-admin.mjs`
// writes credentials this module has to be able to verify, so it repeats these
// parameters — and an eval signs in with a password that script wrote, which is
// what keeps the two from drifting apart silently.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function localAuthAdapter(db: DatabaseSync): AuthPort {
  const findIdentity = (email: string) =>
    db.prepare('select * from auth_identities where lower(email) = lower(?)').get(email.trim()) as any;

  return {
    provider: 'local',

    async signIn(email: string, password: string): Promise<AuthResult> {
      if (!email?.trim() || !password) return { ok: false, reason: 'invalid_credentials' };
      const identity = findIdentity(email);

      // Always do the work, even when the identity is missing: a fast "no such
      // user" and a slow "wrong password" is a user-enumeration oracle.
      const hash = identity?.password_hash ?? 'f'.repeat(128);
      const salt = identity?.salt ?? 'deadbeefdeadbeefdeadbeefdeadbeef';
      const matches = verifyPassword(password, hash, salt);

      if (!identity || !matches) return { ok: false, reason: 'invalid_credentials' };

      const user = db.prepare('select id, is_active from users where id = ?').get(identity.user_id) as any;
      if (!user) return { ok: false, reason: 'invalid_credentials' };
      if (identity.disabled || !user.is_active) return { ok: false, reason: 'account_disabled' };

      db.prepare('update auth_identities set last_sign_in_at = ? where user_id = ?')
        .run(new Date().toISOString(), identity.user_id);
      return { ok: true, userId: identity.user_id };
    },

    // THIS PROVIDER ISSUES NO RESET TOKEN, AND THAT IS THE FIX.
    //
    // It used to mint one on any anonymous request and hand it back to the
    // caller, which put it on the screen of whoever typed the address — a live
    // 30-minute credential for somebody else's account, handed to a stranger.
    // Worse, it was returned ONLY when the address existed, so it also answered
    // the question the uniform failure message above exists to refuse: whether
    // an address has an account here.
    //
    // Nothing consumed it either. There is no reset-password page: the whole
    // token path was surface with no use, and the working recovery route is,
    // and was, an administrator setting a new password in Administration
    // (`setPassword`, below) — or, when nobody can sign in at all,
    // `scripts/pcc-reset-admin.mjs` run on the server by whoever holds shell
    // access.
    //
    // So: no token is minted, no row is written, and an anonymous caller
    // learns nothing. `resetPassword` below is left intact and correct for the
    // day a token is issued deliberately — by an administrator, to a person
    // they can identify — but nothing issues one today.
    async requestPasswordReset(_email: string) {
      return { ok: true };
    },

    async resetPassword(token: string, newPassword: string) {
      if (!newPassword || newPassword.length < 10) {
        return { ok: false, reason: 'weak_password' as const };
      }
      const identity = db.prepare('select * from auth_identities where reset_token = ?').get(token) as any;
      if (!identity) return { ok: false, reason: 'invalid_token' as const };
      if (!identity.reset_expires_at || identity.reset_expires_at < new Date().toISOString()) {
        return { ok: false, reason: 'expired_token' as const };
      }
      const { hash, salt } = hashPassword(newPassword);
      db.prepare(
        `update auth_identities
            set password_hash = ?, salt = ?, reset_token = null, reset_expires_at = null, updated_at = ?
          where user_id = ?`,
      ).run(hash, salt, new Date().toISOString(), identity.user_id);
      return { ok: true };
    },

    async setPassword(userId: string, password: string) {
      const { hash, salt } = hashPassword(password);
      const now = new Date().toISOString();
      const existing = db.prepare('select user_id from auth_identities where user_id = ?').get(userId) as any;
      if (existing) {
        db.prepare('update auth_identities set password_hash = ?, salt = ?, updated_at = ? where user_id = ?')
          .run(hash, salt, now, userId);
        return;
      }
      const user = db.prepare('select email from users where id = ?').get(userId) as any;
      db.prepare(
        `insert into auth_identities (user_id, email, password_hash, salt, disabled, created_at, updated_at)
         values (?,?,?,?,0,?,?)`,
      ).run(userId, user.email, hash, salt, now, now);
    },

    async setDisabled(userId: string, disabled: boolean) {
      db.prepare('update auth_identities set disabled = ?, updated_at = ? where user_id = ?')
        .run(disabled ? 1 : 0, new Date().toISOString(), userId);
    },
  };
}
