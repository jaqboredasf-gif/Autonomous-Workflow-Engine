// ---------------------------------------------------------------------------
// runner-report.mjs — persist a deterministic runner's own result as a durable
// run-report artifact.
//
// Every offline runner already produces a machine-readable summary
// (`createGateRun().summary()` — suite, pass, fail, failures, coverage, digest)
// and then throws it away at process exit. This turns that summary into the same
// artifact any other AWE run produces, through the same scaffolding: an
// execution context, an outcome envelope, a report, an artifact sink.
//
// It exists so that "a suite ran and here is exactly what it decided" is a file
// a human or a later job can read, and so that the artifact path is exercised by
// every regression run rather than only by its own tests.
//
// Opt out with `AWE_ARTIFACTS=off` (a read-only checkout, a sandbox with no
// writable tree). Opting out is reported, never silent.
//
// OFFLINE: filesystem only. No network, no database, no credentials.
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createExecutionContext, failed, runWorkflow, succeeded,
} from '../../packages/awe-kernel/src/index.mjs';
import { DEFAULT_ARTIFACT_ROOT, createFileArtifactSink } from './artifact-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

export const RUNNER_WORKFLOW_PREFIX = 'runner_';

/**
 * persistSuiteReport(gateReport, { workflowId, root, now })
 *
 * `gateReport` is the object `createGateRun().summary()` returns.
 * Returns `{ skipped, ok, ref, final_state, error }` — always, never throws.
 */
export async function persistSuiteReport(gateReport, {
  workflowId,
  root = join(ROOT, DEFAULT_ARTIFACT_ROOT),
  now = null,
} = {}) {
  if (process.env.AWE_ARTIFACTS === 'off') {
    return { skipped: true, ok: false, ref: null, final_state: null, error: null };
  }

  try {
    // A runner is a fixture-mode, service-actor run with no tenant: it reads no
    // tenant data and writes none, so binding it to an org would be a fiction.
    const startedAt = now ?? new Date().toISOString();
    const context = createExecutionContext({
      // Keyed by the result digest, so a re-run that decided the same thing
      // rewrites its own artifact instead of accumulating near-duplicates, and a
      // run that decided something different gets its own file.
      run_id: `${gateReport.suite.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${gateReport.digest}`,
      workflow_id: `${RUNNER_WORKFLOW_PREFIX}${workflowId}`,
      org_id: null,
      actor: 'service',
      mode: 'TEST',
      is_fixture: true,
      started_at: startedAt,
      attributes: { suite: gateReport.suite },
    });

    const summary = {
      suite: gateReport.suite,
      pass: gateReport.pass,
      fail: gateReport.fail,
      fixtures: gateReport.fixtures,
      coverage: gateReport.coverage,
      // Bounded: a report is evidence, not a second copy of the console.
      failures: (gateReport.failures ?? []).slice(0, 50),
      result_digest: gateReport.digest,
    };

    const result = await runWorkflow({
      context,
      artifacts: createFileArtifactSink({ root }),
      summary,
      finished_at: new Date().toISOString(),
      body: () => (gateReport.fail === 0
        ? succeeded({ pass: gateReport.pass, fail: 0 }, {
          audit: [{ step: 'gate_run', ok: true, detail: `${gateReport.pass} checks passed` }],
        })
        : failed('verify_failed', `${gateReport.fail} gate(s) failed`, {
          audit: [{ step: 'gate_run', ok: false, detail: `${gateReport.fail} of ${gateReport.pass + gateReport.fail} checks failed` }],
        })),
    });

    return {
      skipped: false,
      ok: result.artifact?.ok === true,
      ref: result.artifact?.ref ?? null,
      final_state: result.final_state,
      error: result.artifact?.error ?? null,
    };
  } catch (e) {
    return { skipped: false, ok: false, ref: null, final_state: null, error: String(e?.message ?? e) };
  }
}
