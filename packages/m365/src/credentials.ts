// ---------------------------------------------------------------------------
// credentials.ts — MicrosoftCredentialProvider.
//
// Credentials enter this process from the environment and nowhere else. The
// repo rule (AGENT_HARNESS §5) is absolute: "the model never sees credentials,
// URLs with tokens, or raw provider auth", and `.env*` is gitignored except
// `.env.example`.
//
// Consequences encoded here:
//   * No secret is ever returned by a describe/report path — only presence.
//   * `describe()` is the shape every diagnostic and the BLOCKED_LIVE_PROOF
//     report uses, and it cannot leak because the secret is not in the type.
//   * Absent credentials produce a BlockedLiveProofError naming the exact
//     missing variables. They never degrade into a fabricated success.
// ---------------------------------------------------------------------------

import { BlockedLiveProofError } from './contracts.ts';

export interface MicrosoftCredentials {
  readonly microsoftTenantId: string;
  readonly clientId: string;
  /** Client secret or certificate assertion. NEVER logged, hashed or returned. */
  readonly clientSecret: string;
  readonly authority: string;
}

export interface CredentialAvailability {
  readonly available: boolean;
  readonly missing: readonly string[];
  readonly microsoftTenantId: string | null;
  readonly clientId: string | null;
  /** Presence only. The value never leaves this module. */
  readonly clientSecretPresent: boolean;
  readonly liveSmokeEnabled: boolean;
}

export interface MicrosoftCredentialProvider {
  describe(): CredentialAvailability;
  /** Throws BlockedLiveProofError when anything required is missing. */
  get(): MicrosoftCredentials;
}

export const CREDENTIAL_ENV_VARS = [
  'M365_TENANT_ID',
  'M365_CLIENT_ID',
  'M365_CLIENT_SECRET',
] as const;

/** Live calls need credentials AND a deliberate opt-in. Either alone is not enough. */
export const LIVE_SMOKE_ENV_VAR = 'M365_LIVE_SMOKE';

export function createEnvCredentialProvider(
  env: Record<string, string | undefined>,
): MicrosoftCredentialProvider {
  const read = (k: string): string | null => {
    const v = env[k];
    return v != null && v.trim() !== '' ? v : null;
  };

  const describe = (): CredentialAvailability => {
    const missing = CREDENTIAL_ENV_VARS.filter((k) => read(k) === null);
    return {
      available: missing.length === 0,
      missing,
      microsoftTenantId: read('M365_TENANT_ID'),
      clientId: read('M365_CLIENT_ID'),
      clientSecretPresent: read('M365_CLIENT_SECRET') !== null,
      liveSmokeEnabled: env[LIVE_SMOKE_ENV_VAR] === '1',
    };
  };

  return {
    describe,
    get(): MicrosoftCredentials {
      const d = describe();
      if (!d.available) throw new BlockedLiveProofError(d.missing);
      return {
        microsoftTenantId: d.microsoftTenantId as string,
        clientId: d.clientId as string,
        clientSecret: read('M365_CLIENT_SECRET') as string,
        authority: env.M365_AUTHORITY ?? 'https://login.microsoftonline.com',
      };
    },
  };
}

/**
 * A provider that has nothing and says so. Used by every deterministic test, so
 * the tests physically cannot reach a live tenant even if an env var leaks into
 * the runner's environment.
 */
export function createNullCredentialProvider(): MicrosoftCredentialProvider {
  const d: CredentialAvailability = {
    available: false,
    missing: [...CREDENTIAL_ENV_VARS],
    microsoftTenantId: null,
    clientId: null,
    clientSecretPresent: false,
    liveSmokeEnabled: false,
  };
  return {
    describe: () => d,
    get(): MicrosoftCredentials {
      throw new BlockedLiveProofError(d.missing);
    },
  };
}
