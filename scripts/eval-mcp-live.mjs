// ---------------------------------------------------------------------------
// eval-mcp-live.mjs — Runner M-LIVE.
//
// The offline Runner M proves tenant confinement against a deterministic
// two-tenant port. This credential-gated companion proves the real Supabase
// adapter without adding a write path:
//
//   * all read-classified tools execute through executeTool/runWorkflow;
//   * every row returned by every underlying read method carries the bound
//     org_id (no tenant-free intermediate rows);
//   * all eight read methods are exercised;
//   * an unscoped, read-only oracle locates one real second-tenant job-site row,
//     then the ordinary bound tool proves that row is unreachable;
//   * asking the bound process to act for that second tenant is refused before
//     the data port is called.
//
// No row contents or tenant identifiers are printed. Provider failures are
// reported by code only. In particular, PostgREST 42501 means the table lacks
// an explicit Data API grant; that is setup drift, not an isolation verdict.
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';

import {
  KernelError, createGateRun, memoryArtifactSink, memoryAuditSink,
} from '../packages/awe-kernel/src/index.mjs';
import {
  DATA_PORT_METHODS, READ_DATA_PORT_METHODS, WRITE_DATA_PORT_METHODS,
  createSupabaseDataPort,
} from '../packages/mcp-server/src/data-port.mjs';
import { executeTool } from '../packages/mcp-server/src/runtime.mjs';
import { TOOLS } from '../packages/mcp-server/src/tools.mjs';

const run = createGateRun({ name: 'eval-mcp-live (Runner M-LIVE, read-only)' });
const { check, equal } = run;

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AWE_ORG_ID'];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (process.env.AWE_RUN_LIVE_MCP !== '1' || missing.length > 0) {
  console.error(
    `Runner M-LIVE refused: explicit opt-in and required environment are mandatory`
    + (missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''),
  );
  process.exit(2);
}

const orgId = process.env.AWE_ORG_ID;
const now = new Date().toISOString();
const oneHourLater = new Date(Date.parse(now) + 3.6e6).toISOString();
const client = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  },
);

const basePort = createSupabaseDataPort(client, { name: 'supabase-live-proof' });
const observations = {
  calls: [],
  rows: 0,
  missingOrg: [],
  wrongOrg: [],
  writeAttempts: [],
};

const observedPort = { name: 'observed-supabase-live-proof', live: true };
for (const method of DATA_PORT_METHODS) {
  observedPort[method] = async (args) => {
    observations.calls.push(method);
    if (WRITE_DATA_PORT_METHODS.includes(method)) {
      observations.writeAttempts.push(method);
      throw new KernelError(
        'not_supported',
        `Runner M-LIVE is read-only and refuses data-port method ${method}`,
        { method },
      );
    }
    const result = await basePort[method](args);
    const rows = Array.isArray(result) ? result : [result];
    for (const row of rows) {
      observations.rows += 1;
      if (row === null || typeof row !== 'object' || !Object.hasOwn(row, 'org_id')) {
        observations.missingOrg.push(method);
      } else if (row.org_id !== orgId) {
        observations.wrongOrg.push(method);
      }
    }
    return result;
  };
}
Object.freeze(observedPort);

const byName = Object.fromEntries(TOOLS.map((tool) => [tool.descriptor.name, tool]));
const readTools = TOOLS.filter((tool) => tool.descriptor.side_effect === 'read');
const inputs = {
  get_timesheets: { from: '2000-01-01', to: '2100-12-31' },
  get_flags: { days: 90 },
  get_hours_report: { from: '2000-01-01', to: '2100-12-31', group_by: 'employee' },
  list_job_sites: { include_inactive: true },
  list_employees: { include_inactive: true },
  get_schedule: { from: '2000-01-01', to: '2100-12-31', include_cancelled: true },
  check_territory: { county: '__awe_live_tenant_probe__' },
  find_best_worker: { when_start: now, when_end: oneHourLater },
};

run.section('read tool coverage');
equal(readTools.length, 8, 'the live proof covers the complete read-classified tool surface');
equal(
  readTools.map((tool) => tool.descriptor.name).sort(),
  Object.keys(inputs).sort(),
  'every read tool has an explicit live-safe probe input',
);

const results = new Map();
for (const tool of readTools) {
  const result = await executeTool({
    tool,
    input: inputs[tool.descriptor.name],
    deps: {
      port: observedPort,
      env: { AWE_MODE: 'LIVE', AWE_ORG_ID: orgId },
      now,
      artifacts: memoryArtifactSink({ name: `m-live-${tool.descriptor.name}` }),
      audit: memoryAuditSink({ name: `m-live-${tool.descriptor.name}` }),
    },
  });
  results.set(tool.descriptor.name, result);
  const providerCode = result.outcome.meta?.error_details?.code ?? null;
  check(
    result.outcome.status === 'ok',
    `${tool.descriptor.name} completed through LIVE kernel path`
      + ` (status=${result.outcome.status}, code=${result.outcome.error?.code ?? 'none'}, provider=${providerCode ?? 'none'})`,
  );
  if (result.outcome.status === 'ok') {
    equal(result.final_state, 'completed', `${tool.descriptor.name} terminates completed`);
    equal(result.outcome.meta.org_id, orgId, `${tool.descriptor.name} outcome retains the process tenant binding`);
    equal(result.outcome.meta.mode, 'LIVE', `${tool.descriptor.name} outcome is labelled LIVE`);
  }
}

run.section('row-level tenant boundary');
run.sameSet(
  observations.calls,
  READ_DATA_PORT_METHODS,
  'the read tools collectively exercise every read method on the data port',
);
equal(observations.missingOrg, [], 'every live data-port row carries org_id');
equal(observations.wrongOrg, [], 'every live data-port row belongs to the bound tenant');
equal(observations.writeAttempts, [], 'no read-classified tool attempted a write method');
console.log(`source rows inspected: ${observations.rows}`);

run.section('non-vacuous cross-tenant negative');
const oracle = await client
  .from('job_sites')
  .select('id, org_id')
  .neq('org_id', orgId)
  .order('org_id')
  .order('id')
  .limit(1);

if (oracle.error) {
  check(false, `second-tenant oracle query succeeded (provider=${oracle.error.code ?? 'unknown'}; 42501 means a missing Data API grant)`);
} else {
  const sentinel = oracle.data?.[0] ?? null;
  check(sentinel !== null, 'live project contains a second-tenant job-site sentinel');

  if (sentinel !== null) {
    const sites = results.get('list_job_sites')?.outcome?.data?.job_sites ?? [];
    check(
      !sites.some((site) => String(site.id) === String(sentinel.id)),
      'the bound list_job_sites tool cannot return the second-tenant sentinel',
    );

    const callsBefore = observations.calls.length;
    const refused = await executeTool({
      tool: byName.list_job_sites,
      input: { org_id: sentinel.org_id, include_inactive: true },
      deps: {
        port: observedPort,
        env: { AWE_MODE: 'LIVE', AWE_ORG_ID: orgId },
        now,
        artifacts: memoryArtifactSink({ name: 'm-live-negative' }),
        audit: memoryAuditSink({ name: 'm-live-negative' }),
      },
    });
    equal(refused.outcome.status, 'blocked', 'a cross-tenant tool request is refused');
    equal(refused.outcome.blocked_reason, 'tenant_mismatch', 'the refusal is machine-classified as tenant_mismatch');
    equal(observations.calls.length, callsBefore, 'the cross-tenant refusal happens before any data-port call');
  }
}

console.log('--- Runner M-LIVE gates ---');
const report = run.summary();
if (report.fail > 0) console.log(`failures:\n  ${report.failures.join('\n  ')}`);
process.exit(run.exitCode);
