// ---------------------------------------------------------------------------
// instrumentation.ts — the preflight, run once, before anything is served.
//
// Next calls register() when the server process starts, for `next dev`, for
// `next start` and for the standalone build. That makes it the one place a
// deployment can be checked BEFORE it is reachable, which is the difference
// between an operator reading a refusal in `docker logs` and a purchaser
// discovering the problem on the first request.
//
// WHAT IT REFUSES TO START WITH, in production:
//
//   * a configuration validateEnvironment() calls an error — no session
//     secret, no numbering rule, demo mode on, Supabase persistence without
//     Supabase auth
//   * a database location that would silently become the WRONG database:
//     unset, relative, in a directory nobody mounted, or a file that does not
//     exist on a start nobody said was the first one
//
// IN THAT ORDER, AND THE ORDER IS THE POINT. Configuration is checked and
// refused BEFORE the database is opened, so "nothing has been written" is a
// true statement rather than a comforting one. Anything reported after that
// line has a database behind it and says so.
//
// Both exit non-zero rather than degrading. A container that exits is a
// container the operator sees restarting; a container that starts against an
// empty database looks healthy and loses a fortnight of purchase orders.
//
// In DEVELOPMENT it only reports. Nobody's records are at stake on a laptop,
// and a dev server that refuses to boot over a warning is a dev server people
// route around.
// ---------------------------------------------------------------------------

export async function register() {
  // Only the Node.js server runtime has a filesystem or a process to exit.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { validateEnvironment } = await import('./purchasing/infrastructure/env.ts');
  const { databaseLocation, getDb } = await import('./purchasing/infrastructure/sqlite/database.ts');
  const { bootstrapDatabase } = await import('./purchasing/infrastructure/bootstrap.ts');

  const env = validateEnvironment();
  const isProduction = env.config.isProduction;
  const fatal: string[] = [];

  for (const problem of env.problems) {
    const line = `${problem.variable}: ${problem.message}`;
    if (problem.level === 'error') {
      fatal.push(line);
      console.error(`[pcc] configuration error — ${line}`);
    } else {
      console.warn(`[pcc] configuration warning — ${line}`);
    }
  }

  // REFUSE BEFORE TOUCHING THE DATABASE, not after.
  //
  // This block used to sit at the bottom, below the database open. A production
  // start with a bad variable therefore CREATED the company's database, ran
  // every migration and created the bootstrap administrator — and then printed
  // "Nothing has been written", which was false. An operator who mistyped a
  // variable was told to fix it and start again, with a database already on
  // disk holding an account whose password was in the environment they were
  // about to change.
  //
  // A configuration error is knowable without opening anything, so it is
  // answered without opening anything.
  if (fatal.length && isProduction) {
    console.error(
      `[pcc] refusing to start: ${fatal.length} configuration problem(s) above. ` +
        'Nothing has been written — the database was not opened. Fix the environment and start again.',
    );
    process.exit(1);
  }

  // The database question is only PCC's to answer when PCC owns the file.
  // Under Supabase persistence the store is somebody else's server and its
  // reachability is a per-request fact, not a startup one.
  let databaseOpened = false;
  if (env.config.persistenceProvider === 'local') {
    const location = databaseLocation();
    if (!location.ok) {
      fatal.push(`${location.variable}: ${location.message}`);
      console.error(`[pcc] database location error — ${location.variable}: ${location.message}`);
    } else {
      // Creating the company's database is a once-in-a-deployment event and it
      // should appear in the log that way, so an operator who sees it on the
      // SECOND deploy knows immediately that the volume is not mounted.
      console.log(
        location.creating
          ? '[pcc] creating a NEW purchasing database — this should happen exactly once, on first install'
          : '[pcc] opening the existing purchasing database',
      );
      try {
        // OPEN IT HERE, not on the first request. This runs the migrations
        // (idempotent by construction) and bootstraps an empty database, so a
        // file that cannot be read, a schema that cannot be applied or a
        // volume mounted read-only is a startup failure an operator sees in
        // `docker logs` — rather than a 500 the first purchaser meets.
        // Set BEFORE the call, not after: if getDb() throws, the file was
        // still reached — it is the open that failed, not the path — and that
        // sends an operator to permissions rather than to the mount.
        databaseOpened = true;
        const db = getDb();
        const result = bootstrapDatabase(db);
        for (const note of result.notes) console.warn(`[pcc] ${note}`);
        if (result.noCredentials) {
          // NOT fatal. A running installation nobody can sign into is fixed by
          // setting two variables and restarting; refusing to start would take
          // away the health endpoint that tells IT the rest is fine.
          console.warn(
            '[pcc] this database has no enabled sign-in credentials — nobody can sign in. ' +
              'Set PCC_BOOTSTRAP_ADMIN_EMAIL and PCC_BOOTSTRAP_ADMIN_PASSWORD and restart.',
          );
        }
      } catch (err) {
        fatal.push(`database: ${(err as Error).message}`);
        console.error(`[pcc] the database could not be opened — ${(err as Error).message}`);
      }
    }
  }

  // The database half, and the two halves of THAT are said differently too.
  //
  // A location error is decided from the path alone — nothing was opened. An
  // error from getDb()/bootstrap means the file WAS opened and the schema or
  // the permissions are the problem, which is a different thing to go and look
  // at. Telling an operator "the database was reached" when the directory does
  // not exist sends them to the wrong place.
  if (fatal.length && isProduction) {
    console.error(
      databaseOpened
        ? `[pcc] refusing to start: ${fatal.length} problem(s) above. The database was opened but could not be used as configured — check permissions and the schema. Fix it and start again.`
        : `[pcc] refusing to start: ${fatal.length} problem(s) above. Nothing has been written — no database was opened. Fix the path or the environment and start again.`,
    );
    process.exit(1);
  }

  // The deliberate choices, stated once, so an operator reading `docker logs`
  // can confirm the deployment is the one that was intended — and so the two
  // facts that used to be permanent warnings (local credentials, attachments in
  // the database) appear where they belong: as configuration, not as a scold.
  console.log(
    `[pcc] ready — auth: ${env.config.authProvider}, persistence: ${env.config.persistenceProvider}, ` +
      `attachments: ${env.config.storage.driver}, mode: ${isProduction ? 'production' : 'development'}`,
  );
}
