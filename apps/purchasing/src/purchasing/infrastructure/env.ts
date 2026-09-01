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
  /**
   * Which PO numbering rule this installation performs — the id in the
   * organization profile's `purchasing.po_numbering`.
   *
   * REQUIRED IN PRODUCTION, DEFAULTED IN DEVELOPMENT.
   *
   * A production installation must STATE the rule it numbers by. Inheriting one
   * organization's rule by silence is how a second company ends up sending a
   * supplier purchase orders numbered in a shape nobody at that company chose —
   * and unlike most misconfiguration, it is discovered on an invoice months
   * later, by which point the missing decision has become operational data.
   *
   * Outside production the default is Lippolis's real rule, because a developer
   * running the fixture is running Lippolis's installation and every test in
   * this repository asserts their numbers.
   */
  poNumbering: string;
  /** The organization's PO-number separator. Lippolis: '-'. */
  poSeparator: string;
  appBaseUrl: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  demoMode: boolean;
  isProduction: boolean;
  /**
   * Whether the session cookie carries `Secure`.
   *
   * DERIVED FROM THE ADDRESS PEOPLE TYPE, NOT FROM NODE_ENV. It used to be
   * `isProduction`, which is a statement about the build and not about the
   * connection, and the two disagree in exactly one deployment: production
   * served over plain HTTP. There the browser is told to keep a cookie it may
   * only send back over HTTPS, so it never sends it back — sign-in appears to
   * succeed and lands on the sign-in page again, forever, for everybody.
   *
   * Nothing catches that. Configuration is valid, `/api/health` is 200, the log
   * says ready. The first thing anyone knows is Mike unable to sign in on the
   * morning of go-live, with every check green.
   *
   * So the flag follows the scheme of APP_BASE_URL — https means Secure, and
   * plain HTTP means the cookie works — and running production over plain HTTP
   * at all has to be stated with PCC_ALLOW_INSECURE_HTTP. See
   * validateEnvironment: unstated, it is refused rather than downgraded.
   */
  cookieSecure: boolean;
  /** Whether IT has explicitly accepted serving production over plain HTTP. */
  allowInsecureHttp: boolean;
  // NO databasePath HERE, deliberately. It used to sit in this object reading
  // PURCHASING_DB_PATH alone — while the deployment documentation, the
  // Dockerfile and the compose file all set PCC_DATABASE_PATH, and nothing
  // read this field at all. A configuration object holding a stale answer that
  // nobody asks is worse than no answer: the next person to need the database
  // path finds it here, uses it, and gets an empty string on every real server.
  // WHERE THE DATABASE LIVES IS DECIDED IN ONE PLACE —
  // infrastructure/sqlite/database-location.ts — which understands both
  // spellings and refuses to guess in production. Ask it.
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

import { IMPLEMENTED_IDS, ALLOWED_SEPARATORS, PO_NUMBER_SEPARATOR } from '../organization/po-numbering.mjs';

const DEV_SESSION_SECRET = 'purchasing-pilot-development-secret-not-for-production';
/** The development address. Production must replace it — see validateEnvironment. */
const DEFAULT_APP_BASE_URL = 'http://localhost:3000';

/**
 * The numbering rule a NON-production start assumes. Lippolis's real one, not a
 * generic placeholder: a developer running this repository is running their
 * fixture, and every test here asserts their purchase order numbers.
 */
const DEV_PO_NUMBERING = 'job-vendor-sequence';

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

  const appBaseUrl = env.APP_BASE_URL ?? DEFAULT_APP_BASE_URL;
  const servedOverHttps = /^https:\/\//i.test(appBaseUrl);
  const allowInsecureHttp = (env.PCC_ALLOW_INSECURE_HTTP ?? '').trim() === '1';

  return {
    authProvider,
    persistenceProvider,
    // Empty in production when unset — validateEnvironment() reports it and
    // the composition root refuses to build an allocator without a rule.
    poNumbering: (env.PCC_PO_NUMBERING ?? '').trim() || (isProduction ? '' : DEV_PO_NUMBERING),
    // The organization's separator, owned by the numbering strategy. Unset means
    // Lippolis's hyphen, which is what every installation to date declares — an
    // organization that uses another character states it, and one this build
    // will not print is refused rather than substituted (`requireSeparator`).
    //
    // SET-BUT-BLANK IS NOT UNSET. This was `(env.PCC_PO_SEPARATOR ?? '').trim()
    // || PO_NUMBER_SEPARATOR`, which quietly turned `PCC_PO_SEPARATOR=" "` into
    // a hyphen — the exact substitution the validation below exists to refuse,
    // performed one line before it could run. A variable that is present is
    // honoured as written and validated as written; only an ABSENT variable
    // defaults.
    poSeparator: env.PCC_PO_SEPARATOR === undefined ? PO_NUMBER_SEPARATOR : env.PCC_PO_SEPARATOR,
    appBaseUrl,
    // A cookie the browser will actually send back. `Secure` is right whenever
    // the connection is HTTPS and is a total sign-in outage when it is not, so
    // it follows the scheme rather than the build mode.
    cookieSecure: servedOverHttps,
    allowInsecureHttp,
    sessionSecret: env.SESSION_SECRET ?? DEV_SESSION_SECRET,
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 60 * 60 * 12),
    // The demo identity picker is a DEVELOPER tool. It is off unless asked for,
    // and it is refused outright in production (see validateEnvironment).
    demoMode: env.PURCHASING_DEMO_MODE === '1' && !isProduction,
    isProduction,
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
  // APP_BASE_URL IS NOT OPTIONAL IN PRODUCTION.
  //
  // Its default is http://localhost:3000, which is right on a developer's
  // machine and is developer-machine coupling anywhere else: it is the address
  // password-reset links are built from and the origin session cookies are
  // scoped against. Unset, a production deployment ran happily and pointed its
  // links at a host that only exists on somebody's laptop — the preflight
  // caught it, the application did not, and the preflight is a separate command
  // an operator can skip.
  //
  // Checked against the DEFAULT rather than for emptiness, because the default
  // is what a missing variable actually produces here.
  if (config.isProduction && config.appBaseUrl === DEFAULT_APP_BASE_URL) {
    error('APP_BASE_URL', 'a production deployment must state its own address — this is the hostname reset links and session cookies use');
  }
  if (config.isProduction && !/^https?:\/\//.test(config.appBaseUrl)) {
    error('APP_BASE_URL', 'must be an absolute URL, e.g. https://purchasing.example.internal');
  }

  // PLAIN HTTP IN PRODUCTION IS A DECISION, NOT AN OVERSIGHT.
  //
  // This is the failure that would have met everybody on the first morning. A
  // production deployment served over http:// used to set `Secure` on the
  // session cookie anyway — because the flag was read off NODE_ENV, which
  // describes the build and not the connection. The browser accepts the cookie
  // and then declines to send it back over HTTP, so every sign-in succeeds and
  // lands on the sign-in page again. For everybody. Permanently.
  //
  // Nothing anywhere catches it: the configuration is valid, /api/health is
  // 200, the log says ready. The only symptom is Mike unable to get in, with
  // every check green — which is a call to the developer, and the developer is
  // the person this whole phase exists to remove.
  //
  // Now the cookie follows the scheme, so PCC over plain HTTP WORKS. But it
  // works with a session cookie crossing the network in clear text, which is a
  // security decision that belongs to Lippolis IT and not to a default. So it
  // must be said out loud, once, in the environment file.
  if (config.isProduction && /^http:\/\//i.test(config.appBaseUrl)) {
    if (!config.allowInsecureHttp) {
      error(
        'APP_BASE_URL',
        `${config.appBaseUrl} is plain HTTP. Session cookies would cross the network unencrypted, so this must be ` +
          'deliberate: put PCC (unchanged) behind a reverse proxy that terminates HTTPS and set APP_BASE_URL to the ' +
          'https:// address — or, to run without TLS on a trusted internal network, set PCC_ALLOW_INSECURE_HTTP=1 ' +
          'to record that decision.',
      );
    } else {
      warn(
        'PCC_ALLOW_INSECURE_HTTP',
        'serving production over plain HTTP by explicit configuration — session cookies are not encrypted in ' +
          'transit. Correct only on a trusted internal network, and worth revisiting once TLS is available.',
      );
    }
  }

  // The opposite mistake, and it is quieter: TLS is in place, the address is
  // https, and somebody left the acknowledgement behind in the environment file
  // from the days before it was. It changes nothing today — the flag only
  // relaxes the check above — but it is a stale statement about the deployment,
  // and the next person to read the file will believe it.
  if (config.isProduction && config.allowInsecureHttp && /^https:\/\//i.test(config.appBaseUrl)) {
    warn(
      'PCC_ALLOW_INSECURE_HTTP',
      `set, but APP_BASE_URL is already https (${config.appBaseUrl}). It has no effect — remove it so the ` +
        'environment file stops claiming this deployment runs without TLS.',
    );
  }

  // HOW THIS COMPANY NUMBERS ITS PURCHASE ORDERS IS NOT A DEFAULT.
  //
  // Outside production this falls back to Lippolis's rule, because that is
  // whose fixture a developer is running. In production it must be stated: an
  // installation that inherits a numbering rule by silence sends a supplier
  // paperwork numbered in a shape nobody at that company chose. Both failures
  // are errors rather than warnings, because the alternative to stopping is
  // issuing purchase orders — and a purchase order number cannot be withdrawn.
  if (config.isProduction && !config.poNumbering) {
    error('PCC_PO_NUMBERING', `a production deployment must state how it numbers purchase orders — one of: ${IMPLEMENTED_IDS.join(', ')}`);
  } else if (config.poNumbering && !IMPLEMENTED_IDS.includes(config.poNumbering)) {
    error('PCC_PO_NUMBERING', `"${config.poNumbering}" is not a numbering rule this build can perform. Implemented: ${IMPLEMENTED_IDS.join(', ')}. Implement it in organization/po-numbering.mjs — purchasing will not approximate it.`);
  }

  // A separator this build will not put in an identifier stops startup. The
  // alternative is issuing purchase orders whose numbers do not match the book
  // the office reconciles against, and those cannot be withdrawn either.
  if (!ALLOWED_SEPARATORS.includes(config.poSeparator)) {
    error('PCC_PO_SEPARATOR', `"${config.poSeparator}" is not a separator this build will put in a purchase order number. Allowed: ${ALLOWED_SEPARATORS.map((c) => JSON.stringify(c)).join(', ')}.`);
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
  // NEITHER OF THE NEXT TWO IS A WARNING ANY MORE, and that is a correction
  // rather than a relaxation.
  //
  // They used to say production "should" use Supabase Auth and Supabase
  // Storage. Both fire on a correctly configured Lippolis pilot, which runs on
  // the local credential store and inline attachments ON PURPOSE — the choices
  // are recorded in docs/deployment/PCC_PRODUCTION_ARCHITECTURE.md §4 and §6,
  // and identity is an open question for IT rather than a setting we are
  // waiting for somebody to correct.
  //
  // A warning that appears on every start of a correct deployment is worse than
  // no warning: it teaches whoever reads `docker logs` that the warnings in
  // this application are noise, and the next one — the one that matters — is
  // read the same way. So these are stated as facts, at info level, in the
  // startup summary the preflight already prints.
  //
  // If the day comes that inline storage is genuinely wrong here, the honest
  // signal is a size threshold on the database, not a permanent scold.
  if (!config.appBaseUrl.startsWith('http')) {
    error('APP_BASE_URL', 'must be an absolute URL');
  }

  return { ok: !problems.some((p) => p.level === 'error'), problems, config };
}
