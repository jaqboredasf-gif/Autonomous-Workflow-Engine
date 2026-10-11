/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// client.ts — how the Supabase provider gets a database handle, and whose
// authority it carries.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a request's queries run as the CALLER,
// not as the service role. RLS is the tenant boundary in production, and a
// service-role client bypasses RLS entirely — a single accidental service-role
// read is a cross-tenant leak that no application code would notice.
//
// So there are two factories and they are not interchangeable:
//
//   requestClient(accessToken)  the caller's JWT, RLS applies. Everything the
//                               application does goes through this.
//   privilegedClient()          the service role, RLS bypassed. Administrative
//                               acts only (invite, disable, force reset), each
//                               one already authorized by the application, and
//                               NEVER constructed from a user-supplied id
//                               without that check having happened first.
//
// Clients are request-scoped on purpose. A module-level client shared across
// requests would carry one user's JWT into another user's request — the exact
// bug the local provider's singleton makes impossible and a remote one invites.
// ---------------------------------------------------------------------------

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { AppConfig } from '../env.ts';

export type SupabaseHandles = {
  /** Runs as the signed-in user. RLS applies. */
  db: SupabaseClient;
  /** Runs as the service role. Only for acts the application already authorized. */
  privileged: () => SupabaseClient;
  /** The organization the caller belongs to, resolved server-side. */
  orgId: string;
};

function requireConfig(config: AppConfig) {
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw new Error(
      'the Supabase provider needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY',
    );
  }
  return { url: config.supabase.url, anonKey: config.supabase.anonKey };
}

/**
 * A client that acts as the caller. The access token comes from the verified
 * session on the server — never from a header the browser controls.
 */
export function requestClient(config: AppConfig, accessToken: string | null): SupabaseClient {
  const { url, anonKey } = requireConfig(config);
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {},
  });
}

/**
 * A client that bypasses RLS. Constructing it is a decision, so it is a
 * function rather than a field: reading `handles.privileged` does nothing until
 * something calls it, and every call site is greppable.
 */
export function privilegedClient(config: AppConfig): SupabaseClient {
  const { url } = requireConfig(config);
  if (!config.supabase.serviceRoleKey) {
    throw new Error('this operation needs SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * PostgREST errors carry a code and a message. Translate the ones the domain
 * has an opinion about into the same `reason` vocabulary the local provider
 * throws, so a use case cannot tell which provider refused it.
 */
export function translateError(error: any, context: string): Error {
  const err: any = new Error(`${context}: ${error?.message ?? 'unknown database error'}`);
  switch (error?.code) {
    case '23505': // unique_violation
      err.reason = 'duplicate';
      break;
    case '23503': // foreign_key_violation
      err.reason = 'missing_reference';
      break;
    case '23514': // check_violation — a domain invariant the database also holds
      err.reason = 'invariant_violation';
      break;
    case '42501': // insufficient_privilege — RLS refused
    case 'PGRST301':
      err.reason = 'forbidden';
      break;
    case 'PGRST116': // no rows where exactly one was required
      err.reason = 'not_found';
      break;
    default:
      err.reason = 'persistence_failure';
  }
  // Never surface the raw Postgres detail to a user; the reason is the contract
  // and the message is for the log.
  err.detail = error?.details ?? null;
  return err;
}

/** Unwrap a PostgREST result or throw a translated error. */
export function unwrap<T>(result: { data: T; error: any }, context: string): T {
  if (result.error) throw translateError(result.error, context);
  return result.data;
}
