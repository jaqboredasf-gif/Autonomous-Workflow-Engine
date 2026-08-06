// Health endpoint: is this deployment configured, migrated and able to read?
//
// Public on purpose — a load balancer cannot sign in. It therefore reports
// STATUS, never configuration values: which variables are wrong, never what
// they contain.
import { NextResponse } from 'next/server';

import { validateEnvironment } from '../../../purchasing/infrastructure/env.ts';
import { getDb, SCHEMA_VERSION } from '../../../purchasing/infrastructure/sqlite/database.ts';

export const dynamic = 'force-dynamic';

export async function GET() {
  const env = validateEnvironment();
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  checks.environment = {
    ok: env.ok,
    detail: env.problems.length ? env.problems.map((p) => `${p.level}: ${p.variable} — ${p.message}`).join('; ') : undefined,
  };

  try {
    const db = getDb();
    const row = db.prepare('select value from schema_meta where key = ?').get('version') as { value?: string } | undefined;
    const applied = row?.value ?? 'none';
    checks.database = { ok: true };
    checks.migrations = {
      ok: applied === SCHEMA_VERSION,
      detail: applied === SCHEMA_VERSION ? undefined : `schema ${applied}, expected ${SCHEMA_VERSION}`,
    };
  } catch (err) {
    checks.database = { ok: false, detail: (err as Error).message };
    checks.migrations = { ok: false, detail: 'database unavailable' };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    { status: ok ? 'ok' : 'degraded', authProvider: env.config.authProvider, checks },
    { status: ok ? 200 : 503 },
  );
}
