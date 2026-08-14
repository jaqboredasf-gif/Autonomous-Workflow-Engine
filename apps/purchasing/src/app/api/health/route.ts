// Health endpoint: is this deployment configured, migrated and able to read?
//
// Public on purpose — a load balancer cannot sign in. It therefore reports
// STATUS, never configuration values: which variables are wrong, never what
// they contain, and never a path, a key, a hostname or a row.
//
// It answers the three questions a monitoring system asks, separately, because
// they have different remedies:
//
//   process      the app is alive and serving (implied by getting a response)
//   environment  the configuration it needs was loaded and makes sense
//   database     the store it was pointed at can actually be read
//
// It also answers "WHICH BUILD IS THIS?", because an operator comparing a
// production instance against a fix cannot otherwise tell, and guessing from a
// file date is how the wrong image gets blamed. `release` is whatever the
// deployment procedure put in PCC_RELEASE — a tag, a commit, a build number.
// UNSET IS REPORTED AS null, never invented: an installation nobody stamped is
// an installation nobody can identify, and saying so is the useful answer.
//
// 200 when all three hold, 503 otherwise, so a proxy can drain an instance
// that started against the wrong volume instead of serving from it.
import { NextResponse } from 'next/server';

import { validateEnvironment } from '../../../purchasing/infrastructure/env.ts';
import { getDb, SCHEMA_VERSION } from '../../../purchasing/infrastructure/sqlite/database.ts';

export const dynamic = 'force-dynamic';

export async function GET() {
  const env = validateEnvironment();
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  checks.environment = {
    ok: env.ok,
    detail: env.problems.length
      ? env.problems.map((p) => `${p.level}: ${p.variable} — ${p.message}`).join('; ')
      : undefined,
  };

  if (env.config.persistenceProvider === 'supabase') {
    // The Supabase path is queried with the CALLER's token, and this endpoint
    // has no caller. Reporting on a connection it cannot make would be a check
    // that is always green or always red, and neither is information. Say what
    // is actually known: which store the deployment is pointed at.
    checks.database = { ok: true, detail: 'supabase persistence — reachability is checked per request, with the caller\'s token' };
  } else {
    try {
      const db = getDb();
      const row = db.prepare('select value from schema_meta where key = ?').get('version') as
        | { value?: string }
        | undefined;
      const applied = row?.value ?? 'none';
      // A real read, not just an open: an empty or half-written file opens fine.
      db.prepare('select count(*) as n from orgs').get();
      checks.database = { ok: true };
      checks.migrations = {
        ok: applied === SCHEMA_VERSION,
        detail: applied === SCHEMA_VERSION ? undefined : `schema ${applied}, expected ${SCHEMA_VERSION}`,
      };
    } catch (err) {
      // The message here comes from database-location.ts when the path is
      // wrong, and it names the variable rather than the path — the operator
      // needs to know WHICH setting, and a monitoring system does not need to
      // learn the filesystem layout.
      checks.database = { ok: false, detail: (err as Error).message };
      checks.migrations = { ok: false, detail: 'database unavailable' };
    }
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    {
      status: ok ? 'ok' : 'degraded',
      release: (process.env.PCC_RELEASE ?? '').trim() || null,
      schema: SCHEMA_VERSION,
      poNumbering: env.config.poNumbering || null,
      authProvider: env.config.authProvider,
      persistence: env.config.persistenceProvider,
      checks,
    },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
