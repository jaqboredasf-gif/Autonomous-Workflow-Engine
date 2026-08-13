// ---------------------------------------------------------------------------
// database-location.ts — WHICH FILE the purchasing records live in, decided
// once, out loud, and refusing to guess in production.
//
// THE FAILURE THIS EXISTS TO PREVENT
//
// `getDb()` used to read `PURCHASING_DB_PATH ?? <cwd>/.data/purchasing.db` and
// `mkdirSync(dirname, { recursive: true })` whatever came back. On a laptop
// that is a kindness. On a company server it is the most expensive bug this
// application could have:
//
//   * the volume is mounted at /data but the variable says /dat — the app
//     creates /dat/pcc.sqlite inside the container, migrates it, serves an
//     empty purchasing system, and the real database sits untouched on the
//     volume. Nothing errors. Everybody's requests are "gone".
//   * the variable is unset entirely — the database lands in the container's
//     working directory, which the next `docker run` throws away. The data is
//     not corrupted; it is deleted, silently, by a routine redeploy.
//
// Both look identical to the operator: the app is up, the health check is
// green, and the purchase orders are missing. So in production this module
// refuses to invent a location, refuses to create a directory nobody made, and
// refuses to create a NEW database unless somebody said this is the first run.
//
// PURE. It takes the environment and two questions about the filesystem, and
// returns a decision or an explanation. The caller does the opening. That is
// what makes the rules testable without a disk.
// ---------------------------------------------------------------------------

export type LocationProbe = {
  /** Does a file exist at this exact path? */
  fileExists(path: string): boolean;
  /** Does this directory exist? */
  directoryExists(path: string): boolean;
  /**
   * Does anything — file OR directory — exist at this path?
   *
   * Needed to spot a `.git`, which is a directory in an ordinary clone and a
   * FILE in a worktree or a submodule. Checking only for the directory would
   * declare a worktree checkout safe.
   */
  pathExists(path: string): boolean;
};

export type LocationDecision =
  | { ok: true; path: string; creating: boolean; createDirectory: boolean }
  | { ok: false; variable: string; message: string };

/**
 * PCC_DATABASE_PATH is the name the deployment documentation uses, because
 * "PCC" is what IT will be told they are running. PURCHASING_DB_PATH is the
 * name every existing script and test already sets, so it keeps working: this
 * is one setting with two spellings, not two settings.
 */
export const DATABASE_PATH_VARIABLES = ['PCC_DATABASE_PATH', 'PURCHASING_DB_PATH'] as const;

/** Set to 1 on the FIRST production start, to authorize creating the file. */
export const ALLOW_CREATE_VARIABLE = 'PCC_DATABASE_ALLOW_CREATE';

export function resolveDatabaseLocation(
  env: NodeJS.ProcessEnv,
  probe: LocationProbe,
  defaultPath: string,
): LocationDecision {
  const isProduction = env.NODE_ENV === 'production';
  const configured = (env.PCC_DATABASE_PATH ?? env.PURCHASING_DB_PATH ?? '').trim();

  // `:memory:` is a test instruction, not a location. It never touches a disk
  // and there is nothing to protect.
  if (configured === ':memory:') return { ok: true, path: configured, creating: true, createDirectory: false };

  if (!isProduction) {
    // DEVELOPMENT keeps the old behaviour exactly: a default location, and a
    // directory made on demand. Nothing here is worth protecting from, and a
    // laptop that refuses to start is a laptop nobody develops on.
    return { ok: true, path: configured || defaultPath, creating: true, createDirectory: true };
  }

  // --- production, from here down -----------------------------------------

  if (!configured) {
    return {
      ok: false,
      variable: DATABASE_PATH_VARIABLES[0],
      message:
        'set PCC_DATABASE_PATH to the database file on the persistent volume (for example /data/pcc.sqlite). ' +
        'Refusing to default to a path inside the container, because the records written there disappear with it.',
    };
  }

  if (!isAbsolute(configured)) {
    return {
      ok: false,
      variable: DATABASE_PATH_VARIABLES[0],
      message:
        `PCC_DATABASE_PATH must be an absolute path; got "${configured}". ` +
        'A relative path resolves against the working directory, which is not a promise the container keeps.',
    };
  }

  const directory = parentOf(configured);
  if (!probe.directoryExists(directory)) {
    return {
      ok: false,
      variable: DATABASE_PATH_VARIABLES[0],
      message:
        `the directory ${directory} does not exist. It is where the persistent volume should be mounted — ` +
        'creating it here would put the database inside the container instead, where a redeploy deletes it. ' +
        'Mount the volume, or correct the path.',
    };
  }

  // THE RECORDS MUST NOT LIVE INSIDE THE SOURCE CHECKOUT.
  //
  // This one was found by reading our own installation runbook as if for the
  // first time. It said: clone the repository to /srv/pcc, then put the data in
  // /srv/pcc/data. Both halves are reasonable; together they put the company's
  // purchasing records inside a git working tree, where the ordinary vocabulary
  // of deploying software destroys them:
  //
  //   git clean -xfd          removes untracked files — that is the database
  //   rm -rf /srv/pcc         the obvious way to "reinstall from scratch"
  //   re-clone over the top   what somebody does when a checkout goes wrong
  //   a release script that replaces the application directory
  //
  // None of those look destructive. Each one is, and the backups directory
  // usually sits beside the database, so the same command takes the recovery
  // path with it.
  //
  // A DEPLOYMENT SHOULD NOT DEPEND ON EVERYBODY REMEMBERING THIS, so production
  // refuses the layout outright. Development is untouched: a laptop keeps its
  // database in the checkout on purpose, and nothing there is anybody's record.
  const enclosingRepository = repositoryAbove(configured, probe);
  if (enclosingRepository) {
    return {
      ok: false,
      variable: DATABASE_PATH_VARIABLES[0],
      message:
        `${configured} is inside the source checkout at ${enclosingRepository}. The purchasing records must not ` +
        'live in a git working tree: `git clean -xfd`, a re-clone, or replacing the application directory during ' +
        'a release would delete them, and the backups beside them. Put the data on its own path — ' +
        '/var/lib/pcc/pcc.sqlite, or a mounted volume — and keep the application directory disposable.',
    };
  }

  const exists = probe.fileExists(configured);
  if (!exists && env[ALLOW_CREATE_VARIABLE] !== '1') {
    return {
      ok: false,
      variable: ALLOW_CREATE_VARIABLE,
      message:
        `no database at ${configured}, and this is a production start. If this really is the first run, ` +
        `set ${ALLOW_CREATE_VARIABLE}=1 once to create it. If it is not, the volume is not mounted where ` +
        'this application is looking, and starting would serve an empty purchasing system beside the real one.',
    };
  }

  // Opening an EXISTING database still runs the migrations, which are written
  // to be idempotent (`create table if not exists`, guarded column adds). That
  // is the safe direction: a restart against a live database changes nothing.
  return { ok: true, path: configured, creating: !exists, createDirectory: false };
}

/**
 * The nearest ancestor directory that is a git working tree, or null.
 *
 * Walks UPWARDS from the database's own directory, because the dangerous
 * arrangement is a data directory nested somewhere below a checkout root —
 * /srv/pcc/data when the clone is at /srv/pcc — and the marker is at the top.
 *
 * `.git` is checked with pathExists rather than directoryExists because it is a
 * FILE in a worktree or a submodule, and those are checkouts too.
 */
function repositoryAbove(databasePath: string, probe: LocationProbe): string | null {
  let directory = parentOf(databasePath);
  // Bounded rather than `while (true)`: a malformed path must not spin.
  for (let depth = 0; depth < 40; depth++) {
    if (probe.pathExists(joinPath(directory, '.git'))) return directory;
    const parent = parentOf(directory);
    if (parent === directory) return null; // reached the root
    directory = parent;
  }
  return null;
}

/** node:path without importing it, so this module stays trivially testable. */
function joinPath(directory: string, name: string) {
  return directory.endsWith('/') || directory.endsWith('\\') ? `${directory}${name}` : `${directory}/${name}`;
}

function isAbsolute(path: string) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function parentOf(path: string) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut < 0) return '.';
  if (cut === 0) return '/';
  return path.slice(0, cut);
}
