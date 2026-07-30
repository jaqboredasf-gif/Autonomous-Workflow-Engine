// ---------------------------------------------------------------------------
// adapters/identity.ts — MicrosoftIdentityAdapter.
//
// Resolves a Microsoft principal to a stable id + display name, so evidence
// records name a durable directory object rather than an email address that can
// be reassigned. Read-only, one user at a time, under User.ReadBasic.All — there
// is no directory enumeration route here and no group/membership access.
// ---------------------------------------------------------------------------

import type { MicrosoftGraphGateway } from '../gateway.ts';
import type { AdapterCallContext } from './mail.ts';
import type { AdapterResult } from './types.ts';
import { failureFromResponse } from './types.ts';

export interface ResolvedIdentity {
  readonly directoryObjectId: string;
  readonly userPrincipalName: string;
  readonly displayName: string;
}

export interface MicrosoftIdentityAdapter {
  resolve(ctx: AdapterCallContext, userPrincipalName: string): Promise<AdapterResult<ResolvedIdentity>>;
}

export function createIdentityAdapter(gateway: MicrosoftGraphGateway): MicrosoftIdentityAdapter {
  return {
    async resolve(ctx, userPrincipalName) {
      const res = await gateway.execute<{ id?: string; userPrincipalName?: string; displayName?: string }>({
        method: 'GET',
        path: `/users/${encodeURIComponent(userPrincipalName)}`,
        query: { $select: 'id,userPrincipalName,displayName' },
        scopes: ctx.scopes,
        correlationId: ctx.correlationId,
        idempotencyKey: ctx.idempotencyKey,
        timeoutMs: ctx.timeoutMs,
      });
      if (!res.ok || !res.body?.id) return failureFromResponse(res);
      return {
        ok: true,
        microsoftResourceIds: { directoryObjectId: res.body.id },
        raw: res.body,
        data: {
          directoryObjectId: res.body.id,
          userPrincipalName: res.body.userPrincipalName ?? userPrincipalName,
          displayName: res.body.displayName ?? userPrincipalName,
        },
      };
    },
  };
}
