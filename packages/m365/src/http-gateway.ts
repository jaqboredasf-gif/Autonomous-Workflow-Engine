// ---------------------------------------------------------------------------
// http-gateway.ts — the REAL Microsoft Graph transport. Disabled by default.
//
// Constructing this gateway requires, simultaneously:
//   * complete credentials (M365_TENANT_ID / M365_CLIENT_ID / M365_CLIENT_SECRET),
//   * an explicit opt-in (M365_LIVE_SMOKE=1),
//   * a granted-scope set that passes the configuration audit in scopes.ts.
//
// Missing any of them throws BlockedLiveProofError. It never degrades into a
// fake, and the fake never claims to be this — `fidelity` is a literal in both.
// That is the mechanism behind "never fabricate live Microsoft results".
//
// It is also deliberately incapable of a send: the gateway refuses any path
// containing `/sendMail` or ending in `/send`, regardless of what an adapter
// asks for. Belt, braces, and a second pair of braces.
// ---------------------------------------------------------------------------

import type { GraphRequest, GraphResponse, MicrosoftGraphGateway } from './gateway.ts';
import type { MicrosoftCredentialProvider } from './credentials.ts';
import { LIVE_SMOKE_ENV_VAR } from './credentials.ts';
import { BlockedLiveProofError } from './contracts.ts';
import { auditGrantedScopes } from './scopes.ts';

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/** Paths this transport refuses to issue, whatever the caller intended. */
const FORBIDDEN_PATH_PATTERNS = [/\/sendMail\b/i, /\/send$/i, /\/reply\b/i, /\/forward\b/i];

export interface HttpGatewayOptions {
  readonly credentials: MicrosoftCredentialProvider;
  readonly grantedScopes: readonly string[];
  readonly env: Record<string, string | undefined>;
  /** Injected for testability; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error_description?: string;
}

export function createHttpGraphGateway(options: HttpGatewayOptions): MicrosoftGraphGateway {
  const availability = options.credentials.describe();
  const blockers: string[] = [...availability.missing];
  if (options.env[LIVE_SMOKE_ENV_VAR] !== '1') blockers.push(`${LIVE_SMOKE_ENV_VAR}=1 (explicit live opt-in)`);
  const scopeAudit = auditGrantedScopes(options.grantedScopes);
  if (!scopeAudit.ok) blockers.push(...scopeAudit.problems.map((p) => `granted scope refused: ${p}`));
  if (blockers.length > 0) throw new BlockedLiveProofError(blockers);

  const creds = options.credentials.get();
  const doFetch = options.fetchImpl ?? fetch;
  let cachedToken: { value: string; expiresAtMs: number } | null = null;

  const token = async (): Promise<string> => {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAtMs - 60_000 > now) return cachedToken.value;

    const url = `${creds.authority}/${creds.microsoftTenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      // App-only: the granted application permissions ARE the scope set. We never
      // request `.default` against a tenant we are not bound to.
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json()) as TokenResponse;
    if (!res.ok || !json.access_token) {
      // The error description can contain the tenant and app id but never the
      // secret; still, only the status is surfaced upward.
      throw new BlockedLiveProofError([`token request failed with HTTP ${res.status}`]);
    }
    cachedToken = { value: json.access_token, expiresAtMs: now + (json.expires_in ?? 3600) * 1000 };
    return cachedToken.value;
  };

  return {
    fidelity: 'live',

    async execute<T>(request: GraphRequest): Promise<GraphResponse<T>> {
      if (FORBIDDEN_PATH_PATTERNS.some((re) => re.test(request.path))) {
        throw new Error(`refused: '${request.path}' is a transmit path and this gateway never transmits`);
      }

      const query = request.query
        ? `?${new URLSearchParams(request.query as Record<string, string>).toString()}`
        : '';
      const url = `${GRAPH_BASE_URL}${request.path}${query}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const res = await doFetch(url, {
          method: request.method,
          headers: {
            authorization: `Bearer ${await token()}`,
            'content-type': 'application/json',
            // Graph honours this for POST de-duplication on supported routes.
            'client-request-id': request.correlationId,
            ...(request.headers ?? {}),
          },
          body: request.body != null ? JSON.stringify(request.body) : undefined,
          signal: controller.signal,
        });

        const text = await res.text();
        let body: unknown = null;
        try { body = text.length > 0 ? JSON.parse(text) : null; } catch { body = null; }

        const retryAfter = res.headers.get('retry-after');
        return {
          status: res.status,
          ok: res.ok,
          body: (res.ok ? body : null) as T | null,
          headers: Object.fromEntries(res.headers.entries()),
          fidelity: 'live',
          requestId: res.headers.get('request-id'),
          retryAfterSeconds: retryAfter != null ? Number(retryAfter) : null,
          ...(res.ok ? {} : { error: (body as { error?: unknown } | null)?.error ?? { code: String(res.status) } }),
        } as GraphResponse<T>;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
