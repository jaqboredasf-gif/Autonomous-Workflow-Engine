// ---------------------------------------------------------------------------
// service.mjs — the AWE platform service.
//
// The kernel is pure and knows nothing about where things are stored; the MCP
// server is one transport. Between them there has to be a layer that owns the
// composition — "given a tool name, an input and a tenant, run it, persist it,
// and let me ask about it afterwards" — or every new surface re-implements the
// same eight steps and drifts.
//
// This is that layer, and it is deliberately NOT a web server. There is no
// HTTP, no route, no framework and no port binding, because this repo has no
// server to hang them on yet and speculative endpoints rot. What exists is the
// set of typed operations an app server, a CLI worker, a scheduled job or a
// queue consumer would each need:
//
//   submitRun          — run a registered tool, end to end, through the kernel
//   getRunOutcome      — the outcome envelope and final state of a run
//   getRunReport       — the durable artifact for a run
//   getAuditEvents     — the sanitized audit trail for a run
//   assembleRunContext — build a context bundle without executing anything
//   compactRunContext  — compact a bundle and produce a resumable checkpoint
//   resumeRun          — restore a checkpoint into a new run's context
//   listTools          — the discovery view of the tool catalog
//
// Everything impure is INJECTED: the artifact sink, the audit sink, the clock,
// the environment. The service reads no ambient state, so two callers with
// different sinks do not interfere, and a test drives the whole thing in memory.
//
// ADR-0002 boundary, restated because this is where it would be most tempting
// to cross: `submitRun` executes what it is asked to execute. It does not
// decide whether the caller MAY execute it. There is no actor check, no
// capability lookup, no per-tenant allow-list and no approval gate here. When
// ADR-0002 is ratified, the decision point is a single call added at the top of
// `submitRun`; until then, inventing one would be inventing policy.
// ---------------------------------------------------------------------------

import {
  assembleContext, assertContextBundle, compactContext, createCheckpoint,
  createExecutionContext, createToolCatalog, deriveRunId, loadContext,
  restoreCheckpoint, runWorkflow,
} from '../../awe-kernel/src/index.mjs';

/**
 * createPlatformService({ tools, artifacts, audit, clock, defaults })
 *
 *   tools     — [{ descriptor, adapter }]  the execution adapters this service
 *               can run. `adapter(input, { context, bundle, deps })` returns an
 *               outcome envelope.
 *   artifacts — ArtifactSink | null      durable run reports
 *   audit     — AuditSink | null         sanitized audit events
 *   checkpoints — DocumentSink | null    resumable context checkpoints
 *   clock     — () => ISO instant. Injected, not read: the kernel has none, and
 *               a service that reads the system clock cannot be replayed.
 *   defaults  — { budget, mode, actor } applied when a call does not say.
 */
export function createPlatformService({
  tools = [],
  artifacts = null,
  audit = null,
  checkpoints = null,
  clock = null,
  defaults = {},
} = {}) {
  const catalog = createToolCatalog(tools);

  // Runs are indexed in memory by run_id so `getRunOutcome` and
  // `getAuditEvents` can answer without a database. This is a process-local
  // index over durable artifacts, NOT a store: the artifact sink holds the
  // record of truth, and a restarted process re-reads it from there. The
  // database-backed successor is ADR-0002.
  const runs = new Map();

  const nowOr = (supplied) => supplied ?? (clock === null ? null : clock());

  function contextFor({ workflow_id, org_id, input = null, run_id = null, mode = null, actor = null, started_at = null, trace_id = null, attributes = {} }) {
    const resolvedMode = mode ?? defaults.mode ?? 'TEST';
    return createExecutionContext({
      run_id: run_id ?? deriveRunId({ workflow_id, inputs: input, salt: started_at }),
      workflow_id,
      org_id,
      actor: actor ?? defaults.actor ?? 'service',
      mode: resolvedMode,
      // Bound to the mode rather than settable: a LIVE run marked as a fixture
      // would let every fixture-only guard wave real data through.
      is_fixture: resolvedMode !== 'LIVE',
      started_at,
      trace_id,
      attributes,
    });
  }

  return Object.freeze({
    // --- discovery -----------------------------------------------------------

    listTools() { return catalog.describe(); },
    describeTool(name) { return catalog.descriptor(name); },
    catalogDigest() { return catalog.catalog_digest(); },

    // --- context -------------------------------------------------------------

    /**
     * assembleRunContext({ workflow_id, org_id, items, providers, budget, ... })
     *   -> Promise<Execution Context Bundle>
     *
     * Assembly without execution: what a caller uses to inspect, cache or
     * checkpoint a context before deciding to spend a run on it.
     */
    async assembleRunContext({ workflow_id, org_id, items = [], providers = [], now = null, ...options }) {
      const started_at = nowOr(now);
      const context = contextFor({ workflow_id, org_id, input: items, started_at, ...options });
      const budget = options.budget ?? defaults.budget ?? {};
      return providers.length > 0
        ? loadContext({ context, providers, items, budget, assembled_at: started_at, ...options })
        : assembleContext({ context, items, budget, assembled_at: started_at, ...options });
    },

    compactRunContext(bundle, options = {}) {
      assertContextBundle(bundle, { at: 'compactRunContext' });
      return compactContext(bundle, options);
    },

    /**
     * checkpointRunContext(bundle, { now }) -> checkpoint
     *
     * The durable, resumable form. Persisted through the same artifact sink as
     * a run report when one is configured, so an unattended run that stops has
     * left its context somewhere a later run can read it.
     */
    async checkpointRunContext(bundle, { now = null, persist = true } = {}) {
      const checkpoint = createCheckpoint(bundle, { created_at: nowOr(now) });
      // Written through `checkpoints`, NOT through `artifacts`: an ArtifactSink's
      // contract is a run report (it serializes one, and asserts the schema), and
      // a checkpoint is a different document with a different schema. Sharing the
      // sink would mean one of the two lost its contract check.
      const path = `${bundle.workflow_id}/checkpoints/${checkpoint.checkpoint_id}.json`;
      const stored = persist && checkpoints !== null
        ? await checkpoints.write(checkpoint, { path })
        : null;
      return { checkpoint, path, artifact: stored };
    },

    resumeContext(checkpoint, { workflow_id, org_id, now = null, ...options }) {
      const context = contextFor({ workflow_id, org_id, started_at: nowOr(now), ...options });
      return restoreCheckpoint(checkpoint, { context });
    },

    // --- execution -----------------------------------------------------------

    /**
     * submitRun({ tool, input, org_id, mode, providers, contextBundle, deps, now })
     *   -> Promise<{ run_id, final_state, outcome, report, context_bundle }>
     *
     * The single entry point every future surface shares. It fails closed in
     * three places before the adapter is reached: an unknown tool is
     * `not_supported`, a tenant-requiring tool with no `org_id` is refused by
     * the execution context, and a LIVE run with no tenant is refused by the
     * kernel outright.
     */
    async submitRun({
      tool,
      input = {},
      org_id = null,
      mode = null,
      actor = null,
      trace_id = null,
      providers = [],
      contextBundle = null,
      deps = {},
      now = null,
      run_id = null,
    } = {}) {
      // Throws `not_supported` for an unregistered name — a refusal, never a
      // silent no-op.
      const entry = catalog.get(tool);
      const started_at = nowOr(now);

      const context = contextFor({
        workflow_id: entry.descriptor.workflow_id,
        org_id,
        input,
        run_id,
        mode,
        actor,
        trace_id,
        started_at,
        attributes: { tool: entry.descriptor.name, tool_version: entry.descriptor.version },
      });

      const result = await runWorkflow({
        context,
        body: (ctx, { bundle }) => entry.adapter(input, { context: ctx, bundle, deps }),
        contextBundle,
        contextProviders: providers.length > 0 ? providers : null,
        contextRequest: { assembled_at: started_at, budget: defaults.budget ?? {} },
        artifacts,
        audit,
        finished_at: started_at,
        summary: {
          tool: entry.descriptor.name,
          tool_version: entry.descriptor.version,
          side_effect: entry.descriptor.side_effect,
          descriptor_digest: entry.descriptor.descriptor_digest,
          context_digest: contextBundle?.bundle_digest ?? null,
        },
      });

      runs.set(context.run_id, { ...result, tool: entry.descriptor.name });
      return { run_id: context.run_id, ...result };
    },

    // --- inspection ----------------------------------------------------------

    getRunOutcome(run_id) {
      const run = runs.get(run_id);
      return run === undefined ? null : {
        run_id,
        tool: run.tool,
        status: run.outcome.status,
        final_state: run.final_state,
        blocked_reason: run.outcome.blocked_reason,
        error: run.outcome.error,
        meta: run.outcome.meta,
      };
    },

    getRunReport(run_id) { return runs.get(run_id)?.report ?? null; },
    getRunContext(run_id) { return runs.get(run_id)?.context_bundle ?? null; },
    getArtifactRef(run_id) {
      const artifact = runs.get(run_id)?.artifact ?? null;
      return artifact?.ok ? artifact.ref : null;
    },

    // The audit trail as the sink received it. Sourced from the run's outcome
    // rather than from the sink, so a caller gets the same events whether or not
    // the sink is queryable.
    getAuditEvents(run_id) { return runs.get(run_id)?.outcome.events ?? []; },

    listRuns() { return [...runs.keys()].sort(); },
  });
}
