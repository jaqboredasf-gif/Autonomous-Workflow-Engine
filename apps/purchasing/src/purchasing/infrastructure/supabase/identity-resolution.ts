/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// identity-resolution.ts — who the caller is, and which tenant they are in,
// answered by Postgres.
//
// THE RULE THIS FILE ENFORCES: the organization is never something the browser
// sends. It is read from an ACTIVE membership row, using the CALLER'S OWN
// token, so the same row level security that governs their data governs the
// answer to "which tenant are you".
//
// The lookup works because `purchasing_org_memberships` has a policy allowing
// `user_id = auth.uid()` — a person can always see their own membership. Once
// that resolves, `current_org_id()` returns the same organization and every
// other policy falls into place.
//
// No service-role client appears here. If it did, a bug in this file would be a
// cross-tenant leak rather than a failed request.
// ---------------------------------------------------------------------------

import type { Actor } from '../../application/ports.ts';
import type { AppConfig } from '../env.ts';
import { requestClient } from './client.ts';
import { TABLES, toActor } from './mappers.ts';

export type ResolvedIdentity =
  | { ok: true; actor: Actor; orgId: string }
  | { ok: false; reason: 'invalid_session' | 'no_membership' | 'account_disabled' };

/**
 * Resolve an access token into an application identity.
 *
 * @param accessToken the caller's Supabase access token, from the httpOnly
 *   session cookie — never from a header or body the browser controls.
 */
export async function resolveSupabaseActor(
  config: AppConfig,
  accessToken: string | null,
): Promise<ResolvedIdentity> {
  if (!accessToken) return { ok: false, reason: 'invalid_session' };

  const db = requestClient(config, accessToken);

  // 1. Does the token still identify anyone? Supabase validates the signature
  //    and expiry; a revoked or expired token fails here, not later.
  const { data: authUser, error: authError } = await db.auth.getUser(accessToken);
  if (authError || !authUser?.user) return { ok: false, reason: 'invalid_session' };
  const authId = authUser.user.id;

  // 2. Which organization? From membership, as the caller, never from input.
  const { data: membership } = await db
    .from(TABLES.memberships)
    .select('org_id, status, is_primary')
    .eq('user_id', authId)
    .eq('status', 'ACTIVE')
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!membership?.org_id) {
    // Authenticated, but a member of nothing. That is not an error in the
    // credential — it is a person who has not been invited, or whose
    // membership was suspended. Either way they see nothing.
    return { ok: false, reason: 'no_membership' };
  }

  // 3. The application profile. `users.id` IS the auth id (migration 0001 gives
  //    the column no default and current_org_id() matches on it).
  const { data: user } = await db.from(TABLES.users).select('*').eq('id', authId).maybeSingle();
  if (!user) return { ok: false, reason: 'no_membership' };
  if (!(user as any).is_active) return { ok: false, reason: 'account_disabled' };

  const [{ data: roles }, { data: jobs }] = await Promise.all([
    db.from(TABLES.userRoles).select('role').eq('user_id', authId).order('role'),
    db.from(TABLES.jobAssignments).select('job_number').eq('user_id', authId).order('job_number'),
  ]);

  const orgId = String((membership as any).org_id);

  const actor = toActor(
    user,
    ((roles ?? []) as any[]).map((r) => r.role as string),
    ((jobs ?? []) as any[]).map((j) => j.job_number as string),
  );

  // ONE source of truth for the tenant.
  //
  // toActor() takes the organization from `users.org_id`; the repository layer
  // is scoped by the MEMBERSHIP organization. Those are two different columns,
  // and they can disagree — a person moved between organizations, a stale
  // profile row, a membership suspended in one place and granted in another.
  // When they disagree, application queries would filter by one while row level
  // security enforced the other: at best empty pages, at worst a filter that
  // does not match what the database is actually willing to return.
  //
  // Membership wins, because membership is what current_org_id() reads and
  // therefore what every policy in the database agrees with.
  return { ok: true, orgId, actor: { ...actor, orgId } };
}
