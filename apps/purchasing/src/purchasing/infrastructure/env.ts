// ---------------------------------------------------------------------------
// env.ts — configuration, validated once, in one place.
//
// Reading `process.env` anywhere else is how a deployment discovers at 4pm that
// a variable was misspelled. Everything the application needs is declared here,
// with its default, and `validateEnvironment()` is called by the health check
// and by the production build check so a broken configuration fails loudly and
// early rather than quietly and late.
//
// See .env.example for the file this expects.
// ---------------------------------------------------------------------------

export type AuthProvider = 'local' | 'supabase';
export type PersistenceProvider = 'local' | 'supabase';

export type AppConfig = {
  authProvider: AuthProvider;
  /** Which purchasing repositories are bound. See composition.ts. */
  persistenceProvider: PersistenceProvider;
  appBaseUrl: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  demoMode: boolean;
  isProduction: boolean;
  databasePath: string;
  supabase: {
    url: string | null;
    anonKey: string | null;
    serviceRoleKey: string | null;
    redirectUrl: string | null;
  };
  email: {
    externalSendEnabled: false;
  };
  storage: {
    driver: 'inline' | 'supabase';
    bucket: string;
  };
};

const DEV_SESSION_SECRET = 'purchasing-pilot-development-secret-not-for-production';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isProduction = env.NODE_ENV === 'production';
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? null;
  const supabaseAnon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? null;

  // Provider selection is explicit when set, and otherwise inferred from
  // whether Supabase is actually configured. Inferring UP (to supabase) only
  // when both URL and key exist means a half-configured deployment runs on the
  // local provider instead of failing every sign-in with a null client.
  const declared = env.AUTH_PROVIDER as AuthProvider | undefined;
  const authProvider: AuthProvider = declared ?? (supabaseUrl && supabaseAnon ? 'supabase' : 'local');

  // Persistence does NOT infer itself from the presence of Supabase keys the
  // way auth does: switching where the company's purchasing records live is a
  // deliberate act, and a stray environment variable must not perform it.
  const persistenceProvider: PersistenceProvider =
    (env.PURCHASING_PERSISTENCE as PersistenceProvider) ?? 'local';

  return {
    authProvider,
    persistenceProvider,
    appBaseUrl: env.APP_BASE_URL ?? 'http://localhost:3000',
    sessionSecret: env.SESSION_SECRET ?? DEV_SESSION_SECRET,
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 60 * 60 * 12),
    // The demo identity picker is a DEVELOPER tool. It is off unless asked for,
    // and it is refused outright in production (see validateEnvironment).
    demoMode: env.PURCHASING_DEMO_MODE === '1' && !isProduction,
    isProduction,
    databasePath: env.PURCHASING_DB_PATH ?? '',
    supabase: {
      url: supabaseUrl,
      anonKey: supabaseAnon,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? null,
      redirectUrl: env.AUTH_REDIRECT_URL ?? null,
    },
    email: { externalSendEnabled: false },
    storage: {
      driver: (env.STORAGE_DRIVER as 'inline' | 'supabase') ?? 'inline',
      bucket: env.STORAGE_BUCKET ?? 'purchasing',
    },
  };
}

export type EnvProblem = { level: 'error' | 'warning'; variable: string; message: string };

/**
 * Check the configuration makes sense for the environment it is running in.
 * Errors block a production start; warnings are things a pilot can live with.
 */
export function validateEnvironment(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  problems: EnvProblem[];
  config: AppConfig;
} {
  const config = loadConfig(env);
  const problems: EnvProblem[] = [];
  const error = (variable: string, message: string) => problems.push({ level: 'error', variable, message });
  const warn = (variable: string, message: string) => problems.push({ level: 'warning', variable, message });

  if (config.isProduction && config.sessionSecret === DEV_SESSION_SECRET) {
    error('SESSION_SECRET', 'a production deployment must set its own session secret');
  }
  if (config.sessionSecret.length < 32) {
    (config.isProduction ? error : warn)('SESSION_SECRET', 'the session secret should be at least 32 characters');
  }
  if (env.PURCHASING_DEMO_MODE === '1' && config.isProduction) {
    error('PURCHASING_DEMO_MODE', 'demo identity selection is refused in production');
  }
  if (config.authProvider === 'supabase') {
    if (!config.supabase.url) error('NEXT_PUBLIC_SUPABASE_URL', 'required when AUTH_PROVIDER=supabase');
    if (!config.supabase.anonKey) error('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'required when AUTH_PROVIDER=supabase');
    if (!config.supabase.serviceRoleKey) {
      warn('SUPABASE_SERVICE_ROLE_KEY', 'admin invites and password resets need the service role key');
    }
    if (!config.supabase.redirectUrl) {
      warn('AUTH_REDIRECT_URL', 'password-reset emails need a redirect URL Supabase is allowed to send to');
    }
  }
  if (config.persistenceProvider === 'supabase') {
    if (!config.supabase.url) error('NEXT_PUBLIC_SUPABASE_URL', 'required when PURCHASING_PERSISTENCE=supabase');
    if (!config.supabase.anonKey) error('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'required when PURCHASING_PERSISTENCE=supabase');
    // The Supabase context is request-scoped: it is built per request from the
    // caller's verified access token, which is what makes row level security
    // apply to THEM. Every condition below is a precondition for that token
    // existing. Without one, the app would fall back to querying anonymously,
    // RLS would refuse everything, and the failure would surface as an empty
    // page rather than a misconfiguration. Fail here instead.
    if (config.authProvider !== 'supabase') {
      error('PURCHASING_PERSISTENCE', 'Supabase persistence requires AUTH_PROVIDER=supabase (the caller\'s token scopes every query)');
    }
    // The demo identity picker selects a user WITHOUT a password, so it mints
    // no access token. Combined with Supabase persistence it would produce
    // signed-in-looking sessions that can read nothing — or, worse, invite a
    // later "fix" that hands them a privileged client.
    if (config.demoMode) {
      error('PURCHASING_DEMO_MODE', 'demo identity selection cannot be combined with Supabase persistence (it mints no access token)');
    }
    if (config.sessionSecret === DEV_SESSION_SECRET) {
      error('SESSION_SECRET', 'Supabase persistence requires a real session secret: the session cookie carries the access token');
    }
  }
  if (config.authProvider === 'local' && config.isProduction) {
    warn('AUTH_PROVIDER', 'the local credential provider is intended for the pilot; production should use Supabase Auth');
  }
  if (config.storage.driver === 'inline' && config.isProduction) {
    warn('STORAGE_DRIVER', 'inline attachment storage keeps files in the database; production should use Supabase Storage');
  }
  if (!config.appBaseUrl.startsWith('http')) {
    error('APP_BASE_URL', 'must be an absolute URL');
  }

  return { ok: !problems.some((p) => p.level === 'error'), problems, config };
}
