/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// supabase-auth.ts — the production credential provider.
//
// Supabase Auth owns the credentials; the purchasing database owns the person.
// The link is `users.auth_user_id` (added by migration 0017): sign-in returns a
// Supabase auth user id, and this adapter resolves it to the application user
// whose roles and org actually decide what happens next. No password, token or
// refresh token is ever written to a purchasing table.
//
// STATUS: written and wired, NOT executed. This environment has no Supabase
// project, no CLI and no credentials, so nothing here has run against a live
// instance — see the README's remaining-gaps section. It activates when
// AUTH_PROVIDER=supabase and the URL and keys are present; until then the local
// provider serves and every acceptance test runs against that.
//
// Two clients, on purpose:
//   * the ANON client verifies the password. It has no elevated rights, so a
//     stolen anon key cannot mint sessions for other people.
//   * the SERVICE ROLE client is used only for administrative acts an admin
//     already authorized (invite, disable, force reset). It is never
//     constructed in the browser and never with a user's input as its identity.
// ---------------------------------------------------------------------------

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { DatabaseSync } from 'node:sqlite';

import type { AuthPort, AuthResult } from '../../application/ports.ts';
import type { AppConfig } from '../env.ts';

export function supabaseAuthAdapter(db: DatabaseSync, config: AppConfig): AuthPort {
  const anon = (): SupabaseClient => {
    if (!config.supabase.url || !config.supabase.anonKey) {
      throw new Error('Supabase auth is selected but NEXT_PUBLIC_SUPABASE_URL / ANON_KEY are not set');
    }
    return createClient(config.supabase.url, config.supabase.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  };

  const serviceRole = (): SupabaseClient => {
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
      throw new Error('this operation needs SUPABASE_SERVICE_ROLE_KEY');
    }
    return createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  };

  /** Supabase auth user -> the application user whose roles decide things. */
  const applicationUserFor = (authUserId: string, email: string) =>
    (db.prepare('select id, is_active from users where auth_user_id = ? or lower(email) = lower(?)')
      .get(authUserId, email) as any) ?? null;

  return {
    provider: 'supabase',

    async signIn(email: string, password: string): Promise<AuthResult> {
      if (!email?.trim() || !password) return { ok: false, reason: 'invalid_credentials' };

      let response;
      try {
        response = await anon().auth.signInWithPassword({ email: email.trim(), password });
      } catch {
        // The provider being unreachable is not "wrong password", and telling a
        // user their credentials are wrong when the network is down wastes an
        // afternoon of support.
        return { ok: false, reason: 'unavailable' };
      }
      if (response.error || !response.data?.user) return { ok: false, reason: 'invalid_credentials' };

      const user = applicationUserFor(response.data.user.id, email);
      if (!user) return { ok: false, reason: 'invalid_credentials' };
      if (!user.is_active) return { ok: false, reason: 'account_disabled' };

      // Bind the two identities the first time we see them together, so the
      // lookup stops depending on the email address matching.
      db.prepare('update users set auth_user_id = ? where id = ? and auth_user_id is null')
        .run(response.data.user.id, user.id);

      return { ok: true, userId: user.id };
    },

    async requestPasswordReset(email: string) {
      try {
        await anon().auth.resetPasswordForEmail(email.trim(), {
          redirectTo: config.supabase.redirectUrl ?? `${config.appBaseUrl}/reset-password`,
        });
      } catch {
        // Reported as success either way: whether an address has an account is
        // not something an unauthenticated form should reveal.
      }
      return { ok: true };
    },

    async resetPassword() {
      // Supabase completes a reset through its own redirect + token exchange in
      // the browser, not through this server. Routing it here would mean
      // handling someone else's recovery token, which this app should never
      // hold. /reset-password performs the exchange client-side.
      return { ok: false, reason: 'handled_by_provider' as const };
    },

    async setPassword(userId: string, password: string) {
      const user = db.prepare('select auth_user_id, email from users where id = ?').get(userId) as any;
      const client = serviceRole();
      if (user?.auth_user_id) {
        const { error } = await client.auth.admin.updateUserById(user.auth_user_id, { password });
        if (error) throw new Error(`Supabase could not set the password: ${error.message}`);
        return;
      }
      const { data, error } = await client.auth.admin.createUser({
        email: user.email,
        password,
        email_confirm: true,
      });
      if (error) throw new Error(`Supabase could not create the account: ${error.message}`);
      db.prepare('update users set auth_user_id = ? where id = ?').run(data.user.id, userId);
    },

    async setDisabled(userId: string, disabled: boolean) {
      const user = db.prepare('select auth_user_id from users where id = ?').get(userId) as any;
      if (!user?.auth_user_id) return;
      // `ban_duration: 'none'` lifts a ban; a long duration is Supabase's way of
      // disabling an account without deleting its history.
      const { error } = await serviceRole().auth.admin.updateUserById(user.auth_user_id, {
        ban_duration: disabled ? '876000h' : 'none',
      } as any);
      if (error) throw new Error(`Supabase could not change the account state: ${error.message}`);
    },
  };
}
