// ---------------------------------------------------------------------------
// control-plane-service.mjs — the operable, transport-neutral application
// service for the AWE execution control plane.
//
// `service.mjs` (the platform service) runs ONE registered tool through the
// kernel. This runs a REGISTERED WORKFLOW: resolve it, authorize it, assemble
// and validate its context, walk its steps through the controlled tool
// boundary, stop for a human, persist the journal, and answer questions about
// it afterwards.
//
// It is not a web server, for the same reason `service.mjs` is not: this repo
// has no server to hang routes on, and speculative endpoints rot. What exists
// is the set of typed operations any surface would call —
//
//   listWorkflows / describeWorkflow  discovery
//   startRun                          resolve, authorize, execute until done or paused
//   getRun / getTimeline              inspection, rebuilt from the persisted journal
//   decideApproval                    a human's decision, recorded
//   resumeRun                         continue a paused run — a SEPARATE call
//   cancelRun                         stop a run and compensate
//
// TENANT BINDING IS AN ARGUMENT, NEVER AN INFERENCE. Every operation that names
// a run also names the tenant, and refuses when the two disagree. This is the
// same rule the MCP surface was fixed to follow (no `orgs limit 1`), applied
// here at the point where it matters most: a resume is a privileged operation
// on someone else's run.
//
// Everything impure is INJECTED — sinks, journal store, clock. The service
// reads no ambient state, so two callers with different stores cannot interfere
// and a test drives the whole thing in memory.
// ---------------------------------------------------------------------------

import {
  assembleContext, buildReport, createExecutionContext, createToolCatalog,
  deriveRunId, finalStateFor, loadContext, reportPath,
} from '../../awe-kernel/src/index.mjs';
import {
  createPolicyEngine, createRunEngine, createToolDispatcher, createWorkflowRegistry,
  loadRunJournal,
} from '../../awe-control-plane/src/index.mjs';

const TERMINAL_ADVANCES = ['completed', 'failed', 'cancelled', 'timed_out'];

/**
 * createControlPlaneService({ manifests, tools, grants, validators, journals,
 *                             artifacts, audit, clock, defaults })
 *
 *   manifests  — workflow manifests or specs; built and validated by the registry
 *   tools      — [{ descriptor, adapter }] for the kernel tool catalog
 *   grants     — tenant-scoped tool grants (policy.mjs). Deny by default.
 *   validators — schema reference -> validator function
 *   journals   — journal store (journal-store.mjs)
 *   artifacts  — ArtifactSink for durable run reports
 *   audit      — AuditSink for sanitized audit events
 *   clock      — () => ISO instant. Injected: the control plane has none.
 */
export function createControlPlaneService({
  manifests = [],
  tools = [],
  grants = [],
  validators = {},
  journals = null,
  results: resultStore = null,
  artifacts = null,
  audit = null,
  clock = null,
  defaults = {},
} = {}) {
  const registry = createWorkflowRegistry(manifests);
  const catalog = createToolCatalog(tools);
  const policy = createPolicyEngine({ grants });
  const dispatcher = createToolDispatcher({ catalog, policy, validators, clock });
  const engine = createRunEngine({ registry, dispatcher, policy, clock });

  const now = (supplied = null) => supplied ?? (clock === null ? null : clock());

  function contextFor({ workflow_id, org_id, run_id, input, started_at, actor, mode, trace_id, attributes = {} }) {
    // TEST is the fail-closed default everywhere in this repo, and the control
    // plane's policy engine refuses LIVE outright regardless.
    const resolvedMode = mode ?? defaults.mode ?? 'TEST';
    return createExecutionContext({
      run_id: run_id ?? deriveRunId({ workflow_id, inputs: input, salt: started_at }),
      workflow_id,
      org_id,
      actor: actor ?? defaults.actor ?? 'service',
      mode: resolvedMode,
      is_fixture: resolvedMode !== 'LIVE',
      started_at,
      trace_id,
      attributes,
    });
  }

  async function assembleFor({ context, items, providers, budget }) {
    const request = {
      context,
      items,
      budget: budget ?? defaults.budget ?? {},
      assembled_at: context.started_at,
    };
    return providers.length > 0
      ? loadContext({ ...request, providers })
      : assembleContext(request);
  }

  function persist(journal) {
    if (journals === null) return { ok: true, ref: null, error: null };
    return journals.write(journal.toDocument());
  }

  // Step outputs go to the DATA store, never to the journal. Two stores, two
  // jobs — see result-store.mjs for why this is a boundary and not duplication.
  const readResults = ({ run_id, org_id }) => (resultStore === null ? {} : resultStore.read({ run_id, org_id }));
  const writeResults = ({ run_id, org_id, results }) => {
    if (resultStore !== null) resultStore.write({ run_id, org_id, results });
  };

  // A run report for the CURRENT state of a run. Built from the projection, so
  // it can never claim a state the journal does not support.
  async function report({ context, outcome, advance, summary }) {
    const built = buildReport({
      context,
      outcome,
      finished_at: now(),
      summary,
      persisted: artifacts !== null,
    });
    let artifact = null;
    if (artifacts !== null) artifact = await artifacts.write(built, { path: reportPath(built) });
    if (audit !== null) await audit.emit(outcome.events ?? [], context);
    return {
      report: built,
      artifact,
      final_state: TERMINAL_ADVANCES.includes(advance)
        ? finalStateFor(outcome.status, { persisted: artifact === null || artifact.ok })
        : 'paused',
    };
  }

  // The operator-facing view of a run. Everything here is derived; nothing is
  // stored alongside the journal that could disagree with it.
  function summarize({ document, manifest, extra = {} }) {
    const journal = loadRunJournal(document);
    const state = journal.state();
    return Object.freeze({
      run_id: journal.run_id,
      workflow_id: journal.workflow_id,
      workflow_version: journal.workflow_version,
      org_id: journal.org_id,
      manifest_digest: manifest?.manifest_digest ?? null,
      risk: manifest?.risk ?? null,
      promotion_status: manifest?.promotion?.status ?? null,
      state: state.state,
      terminal: state.terminal,
      pending_approval: state.pending_approval,
      executed_tools: state.executed_tools,
      completed_steps: state.completed_steps,
      failed_steps: state.failed_steps,
      compensations: state.compensations,
      approvals: state.approvals,
      failure: state.failure,
      timeline: state.timeline,
      event_count: state.event_count,
      journal_head: state.head,
      journal_digest: document.journal_digest,
      ...extra,
    });
  }

  // Load a run, refusing a tenant that does not own it. This is the guard that
  // makes `resumeRun` and `decideApproval` safe to expose.
  function loadOwned(run_id, org_id, { at }) {
    const document = journals === null ? null : journals.read(run_id);
    if (document === null) {
      return { ok: false, reason: 'approval_unknown', detail: `no run '${run_id}' is stored`, document: null };
    }
    if (document.org_id !== org_id) {
      // The refusal deliberately does NOT confirm what the run's real tenant is:
      // a caller who guessed a run id should not learn who owns it.
      return {
        ok: false,
        reason: 'approval_tenant_mismatch',
        detail: `run '${run_id}' is not accessible to tenant '${org_id}'`,
        document: null,
        at,
      };
    }
    return { ok: true, reason: null, detail: null, document };
  }

  function manifestOf(document) {
    return registry.get(document.workflow_id, document.workflow_version);
  }

  return Object.freeze({
    // --- discovery -----------------------------------------------------------

    listWorkflows() { return registry.describe(); },
    describeWorkflow(workflow_id, version) { return registry.get(workflow_id, version); },
    listTools() { return catalog.describe(); },
    listGrants() { return policy.grants(); },
    registryDigest() { return registry.registry_digest(); },
    policyDigest() { return policy.policy_digest(); },
    catalogDigest() { return catalog.catalog_digest(); },

    // --- execution -----------------------------------------------------------

    /**
     * startRun({ workflow_id, version, org_id, input, context_items, providers,
     *            actor, mode, budget, run_id, deps, cancel })
     *
     * Note what is NOT a parameter: a workflow definition, a step list, a tool
     * list, or an adapter. A caller may only NAME a workflow; everything
     * executable comes from the registry and the catalog this service was
     * constructed with.
     */
    async startRun({
      workflow_id,
      version = null,
      org_id = null,
      input = {},
      context_items = [],
      providers = [],
      actor = null,
      mode = null,
      trace_id = null,
      budget = null,
      run_id = null,
      deps = {},
      cancel = null,
      now: at = null,
    } = {}) {
      const started_at = now(at);
      const context = contextFor({
        workflow_id, org_id, run_id, input, started_at, actor, mode, trace_id,
        attributes: { entry: 'control_plane.startRun' },
      });

      // Assembly can fail closed (a cross-tenant item is a refusal, not a
      // filter), and that must be reported as a run that did not start rather
      // than as an exception escaping the service.
      let bundle;
      try {
        bundle = await assembleFor({ context, items: context_items, providers, budget });
      } catch (e) {
        return Object.freeze({
          run_id: context.run_id,
          workflow_id,
          state: 'failed',
          advance: 'failed',
          outcome: null,
          error: { code: e?.code ?? 'contract_violation', message: String(e?.message ?? e) },
          blocked_reason: 'context_requirements_unmet',
        });
      }

      const stepResults = {};
      const result = await engine.startRun({
        workflow_id, version, context, bundle, deps, cancel, results: stepResults,
      });

      // A run refused before its journal existed (unknown workflow, unpromoted,
      // out of scope, unmet context) still produces a durable report — a
      // refusal nobody can find is not a fail-closed system.
      if (result.journal === null || result.journal === undefined) {
        const written = await report({
          context,
          outcome: result.outcome,
          advance: 'failed',
          summary: {
            workflow_id, requested_version: version, phase: 'resolution',
            resolution_reason: result.resolution?.reason ?? null,
          },
        });
        return Object.freeze({
          run_id: context.run_id,
          workflow_id,
          workflow_version: null,
          org_id,
          state: 'failed',
          advance: 'failed',
          blocked_reason: result.outcome.blocked_reason,
          detail: result.outcome.meta ?? null,
          resolution: result.resolution ?? null,
          outcome: result.outcome,
          ...written,
        });
      }

      const stored = persist(result.journal);
      writeResults({ run_id: context.run_id, org_id, results: stepResults });
      const written = await report({
        context,
        outcome: result.outcome,
        advance: result.advance,
        summary: {
          workflow_version: result.manifest.version,
          manifest_digest: result.manifest.manifest_digest,
          risk: result.manifest.risk,
          context_digest: bundle.bundle_digest,
          journal_head: result.journal.head(),
          registry_digest: registry.registry_digest(),
        },
      });

      return Object.freeze({
        ...summarize({ document: result.journal.toDocument(), manifest: result.manifest }),
        advance: result.advance,
        blocked_reason: result.outcome.blocked_reason,
        outcome: result.outcome,
        context_bundle: bundle,
        journal_ref: stored.ref,
        ...written,
      });
    },

    /**
     * decideApproval({ run_id, org_id, decision, actor, principal,
     *                  principal_roles, approval_id, note })
     *
     * Records the decision and NOTHING else. The run is not continued here:
     * `resumeRun` is a separate call, made by whoever is willing to spend the
     * time, which is what keeps "a person decided" and "the machine acted"
     * separately attributable.
     */
    async decideApproval({
      run_id, org_id = null, decision = null, actor = 'human', principal = null,
      principal_roles = [], approval_id = null, note = null,
    } = {}) {
      const owned = loadOwned(run_id, org_id, { at: 'decideApproval' });
      if (!owned.ok) return Object.freeze({ ok: false, run_id, ...owned, document: undefined });

      const journal = loadRunJournal(owned.document);
      const manifest = manifestOf(owned.document);
      if (manifest === null) {
        return Object.freeze({
          ok: false, run_id,
          reason: 'workflow_version_unknown',
          detail: `workflow '${owned.document.workflow_id}' v${owned.document.workflow_version} is no longer registered`,
        });
      }

      const verdict = engine.submitApproval({
        journal, manifest, decision, actor, principal, principal_roles, org_id, note, approval_id,
      });
      if (!verdict.ok) {
        return Object.freeze({ ok: false, run_id, reason: verdict.reason, detail: verdict.detail });
      }

      const stored = persist(journal);
      return Object.freeze({
        ok: true,
        run_id,
        decision: verdict.decision,
        approval_id: verdict.approval_id,
        step_id: verdict.step_id,
        state: verdict.state.state,
        journal_ref: stored.ref,
      });
    },

    /**
     * resumeRun({ run_id, org_id, deps, cancel })
     *
     * The proof of durability: this call shares no memory with `startRun`. It
     * reads the journal from the store, re-verifies its hash chain, projects
     * the state, rebuilds the dispatcher's effect memory from the recorded
     * invocations, and continues.
     */
    async resumeRun({ run_id, org_id = null, deps = {}, cancel = null, now: at = null } = {}) {
      const owned = loadOwned(run_id, org_id, { at: 'resumeRun' });
      if (!owned.ok) return Object.freeze({ ok: false, run_id, ...owned, document: undefined });

      const journal = loadRunJournal(owned.document);
      const manifest = manifestOf(owned.document);
      if (manifest === null) {
        return Object.freeze({
          ok: false, run_id,
          reason: 'workflow_version_unknown',
          detail: `workflow '${owned.document.workflow_id}' v${owned.document.workflow_version} is no longer registered`,
        });
      }

      const started_at = now(at);
      const context = contextFor({
        workflow_id: journal.workflow_id,
        org_id,
        run_id: journal.run_id,
        input: null,
        started_at,
        actor: 'service',
        mode: null,
        trace_id: null,
        attributes: { entry: 'control_plane.resumeRun' },
      });

      const state = journal.state();
      // Seeded from the DATA store, not from the journal: this process shares
      // no memory with the one that paused, and the journal holds only digests.
      const stepResults = readResults({ run_id: journal.run_id, org_id });

      // A rejected approval does not resume — it rolls back. Routing that here
      // rather than making the caller know is deliberate: an operator who says
      // "continue" after a denial must not get an execution.
      const result = state.state === 'rejected'
        ? await engine.applyDenial({ journal, manifest, context, deps, results: stepResults })
        : await engine.advanceRun({ journal, manifest, context, deps, cancel, results: stepResults });

      const stored = persist(journal);
      writeResults({ run_id: journal.run_id, org_id, results: stepResults });
      const written = await report({
        context,
        outcome: result.outcome,
        advance: result.advance,
        summary: {
          phase: 'resume',
          workflow_version: manifest.version,
          manifest_digest: manifest.manifest_digest,
          journal_head: journal.head(),
        },
      });

      return Object.freeze({
        ok: true,
        ...summarize({ document: journal.toDocument(), manifest }),
        advance: result.advance,
        blocked_reason: result.outcome.blocked_reason,
        outcome: result.outcome,
        journal_ref: stored.ref,
        ...written,
      });
    },

    async cancelRun({ run_id, org_id = null, reason = 'operator cancelled', deps = {}, now: at = null } = {}) {
      const owned = loadOwned(run_id, org_id, { at: 'cancelRun' });
      if (!owned.ok) return Object.freeze({ ok: false, run_id, ...owned, document: undefined });

      const journal = loadRunJournal(owned.document);
      const manifest = manifestOf(owned.document);
      const context = contextFor({
        workflow_id: journal.workflow_id,
        org_id,
        run_id: journal.run_id,
        input: null,
        started_at: now(at),
        actor: 'human',
        mode: null,
        trace_id: null,
        attributes: { entry: 'control_plane.cancelRun' },
      });

      // Seeded from the DATA store for the same reason a resume is: the
      // compensators need the outputs of the steps they are undoing, and a
      // cancellation that cannot roll back is a cancellation that leaves the
      // tenant half-applied.
      const stepResults = readResults({ run_id: journal.run_id, org_id });
      const result = await engine.cancelRun({ journal, manifest, context, deps, reason, results: stepResults });
      const stored = persist(journal);
      return Object.freeze({
        ok: true,
        ...summarize({ document: journal.toDocument(), manifest }),
        advance: result.advance,
        journal_ref: stored.ref,
      });
    },

    // --- inspection ----------------------------------------------------------

    getRun({ run_id, org_id = null } = {}) {
      const owned = loadOwned(run_id, org_id, { at: 'getRun' });
      if (!owned.ok) return null;
      return summarize({ document: owned.document, manifest: manifestOf(owned.document) });
    },

    getTimeline({ run_id, org_id = null } = {}) {
      const run = this.getRun({ run_id, org_id });
      return run === null ? [] : run.timeline;
    },

    getJournalDocument({ run_id, org_id = null } = {}) {
      const owned = loadOwned(run_id, org_id, { at: 'getJournalDocument' });
      return owned.ok ? owned.document : null;
    },

    listRuns() { return journals === null ? [] : journals.list(); },
  });
}
