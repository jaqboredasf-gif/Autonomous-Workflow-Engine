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
// ONE RUN, ONE WRITER. Every operation that MUTATES a run — start, decide,
// resume, cancel — takes a run lease first and commits under a compare-and-set
// on the journal's chain head. Without it, two workers resuming the same paused
// run would both load the same journal, both execute the consequential step,
// and both write a history that is internally valid; the tenant would see one
// approval and two payments. The lease is what makes "append-only" imply
// "single-writer" rather than merely coexist with it. See `lease-store.mjs` for
// what each store implementation actually guarantees.
//
// Everything impure is INJECTED — sinks, journal store, clock. The service
// reads no ambient state, so two callers with different stores cannot interfere
// and a test drives the whole thing in memory.
// ---------------------------------------------------------------------------

import {
  assembleContext, blocked, buildReport, createExecutionContext, createToolCatalog,
  deriveRunId, finalStateFor, loadContext, reportPath,
} from '../../awe-kernel/src/index.mjs';
import {
  createPolicyEngine, createRunEngine, createToolDispatcher, createWorkflowRegistry,
  loadRunJournal, tenantInScope,
} from '../../awe-control-plane/src/index.mjs';
import { DEFAULT_LEASE_TTL_MS, createMemoryLeaseStore } from './lease-store.mjs';

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
  leases = null,
  holder = null,
  lease_ttl_ms = DEFAULT_LEASE_TTL_MS,
  artifacts = null,
  audit = null,
  clock = null,
  defaults = {},
} = {}) {
  // A lease store is never optional — a service with no exclusion at all would
  // make the single-writer guarantee depend on the caller remembering to ask
  // for it. What IS optional is whether that exclusion crosses processes, and
  // the default (memory) does not. A caller that supplies a real store must
  // therefore also supply a worker identity: two processes sharing the default
  // holder name would both "renew" the same lease and both proceed, which is
  // precisely the bug this is here to prevent, so it is refused rather than
  // defaulted.
  if (leases !== null) {
    if (typeof holder !== 'string' || holder.length === 0) {
      throw new Error('createControlPlaneService: a supplied lease store also needs a distinct `holder` identity for this worker');
    }
  }
  const leaseStore = leases ?? createMemoryLeaseStore({ ttl_ms: lease_ttl_ms });
  const workerId = holder ?? 'service';

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
    // WHERE a workflow's context comes from is a composition decision, not a
    // caller's. `defaults.providers` is what lets a surface start a run without
    // being handed the tenant's policy documents to pass through — an MCP
    // caller that supplied its own context items would be supplying the very
    // material the workflow is supposed to be grounded in.
    const effective = providers.length > 0 ? providers : (defaults.providers ?? []);
    return effective.length > 0
      ? loadContext({ ...request, providers: effective })
      : assembleContext(request);
  }

  function persist(journal, { expected_head } = {}) {
    if (journals === null) return { ok: true, ref: null, error: null };
    return journals.write(journal.toDocument(), { expected_head });
  }

  // --- the single-writer boundary -------------------------------------------

  /**
   * claim() — take the run before touching it. A refusal is DATA ("someone else
   * has it"), which is a normal outcome for a worker pulling from a queue, not
   * an error.
   */
  function claim({ run_id, org_id, at }) {
    return leaseStore.acquire({ run_id, org_id, holder: workerId, now: at, ttl_ms: lease_ttl_ms });
  }

  const surrender = (run_id) => leaseStore.release({ run_id, holder: workerId });

  /**
   * commit() — the write, gated twice. `verify` catches a lease that lapsed
   * while this worker was doing the work (its successor now holds the run); the
   * store's head check catches the same thing one layer down, in case the lease
   * was renewed by a clock skew but the journal moved on anyway.
   *
   * Both checks happen AFTER the steps ran, so neither can undo a side effect
   * that has already landed. That is not a gap in this function — it is why the
   * lease is taken BEFORE the work rather than after it. These two are the
   * backstop that keeps a lapsed worker from corrupting the history on its way
   * out.
   */
  function commit({ journal, fence, expected_head }) {
    const hold = leaseStore.verify({ run_id: journal.run_id, holder: workerId, fence, now: now() });
    if (!hold.ok) {
      return { ok: false, ref: null, reason: hold.reason, error: hold.detail };
    }
    const stored = persist(journal, { expected_head });
    if (stored.ok === false) {
      return { ok: false, ref: null, reason: stored.reason ?? 'journal_write_conflict', error: stored.error };
    }
    return stored;
  }

  // The shape every mutating operation returns when it never got the run.
  const notClaimed = (run_id, claimVerdict) => Object.freeze({
    ok: false,
    run_id,
    reason: claimVerdict.reason,
    detail: claimVerdict.detail,
    held_by: claimVerdict.held_by ?? null,
  });

  /**
   * The far worse case: the work ran and the commit was refused. The steps that
   * already executed cannot be recalled from here, so the ONE thing this must
   * not do is stay quiet. A durable report is written naming the refusal, which
   * is what an operator reconciling a double-execution will look for.
   */
  async function lostMidRun({ context, run_id, org_id, stored, phase }) {
    const outcome = blocked(stored.reason, {
      audit: [{ step: `commit_${phase}`, ok: false, detail: stored.error }],
      meta: { run_id, org_id, holder: workerId, phase },
    });
    const written = await report({ context, outcome, advance: 'failed', summary: { phase: `${phase}_commit_refused` } });
    return Object.freeze({
      ok: false,
      run_id,
      reason: stored.reason,
      detail: stored.error,
      state: 'unknown',
      advance: 'failed',
      blocked_reason: stored.reason,
      outcome,
      ...written,
    });
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
      approval_votes: state.approval_votes,
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

    /**
     * listWorkflows({ org_id })
     *
     * With no tenant this is the OPERATOR view — every registered workflow,
     * including each one's tenant allow-list. That is the right answer for a
     * local operator CLI and the wrong one for a multi-tenant surface, so
     * naming a tenant does two things: it filters to what that tenant may
     * actually run, and it REMOVES `tenant_scope` from the result. A catalogue
     * that told tenant A which orgs are in tenant B's allow-list would be a
     * customer list, handed out by a discovery endpoint.
     */
    listWorkflows({ org_id = null } = {}) {
      const all = registry.describe();
      if (org_id === null) return all;
      return all
        .filter((w) => {
          const manifest = registry.get(w.workflow_id, w.version);
          return manifest !== null && tenantInScope(manifest, org_id);
        })
        .map(({ tenant_scope, ...rest }) => ({ ...rest, tenant_scope: tenant_scope.mode }));
    },
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

      // The claim comes before ANY work. Run ids are derived from the workflow,
      // the inputs and the start instant, so two identical submissions landing
      // on two workers collide here — which makes this the same mechanism that
      // stops a duplicate submission, not just a duplicate resume.
      const claimed = claim({ run_id: context.run_id, org_id, at: started_at });
      if (!claimed.ok) return notClaimed(context.run_id, claimed);

      try {
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

        // `expected_head: null` — this run must not already be stored. A second
        // worker that somehow got past the lease and started the same run id
        // finds its create refused rather than silently replacing a history.
        const stored = commit({ journal: result.journal, fence: claimed.fence, expected_head: null });
        if (!stored.ok) return lostMidRun({ context, run_id: context.run_id, org_id, stored, phase: 'start' });

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
            lease_fence: claimed.fence,
          },
        });

        return Object.freeze({
          ...summarize({ document: result.journal.toDocument(), manifest: result.manifest }),
          advance: result.advance,
          blocked_reason: result.outcome.blocked_reason,
          outcome: result.outcome,
          context_bundle: bundle,
          journal_ref: stored.ref,
          lease_fence: claimed.fence,
          ...written,
        });
      } finally {
        // Released whatever happened. A worker that threw must not strand the
        // run for the whole TTL — expiry is the safety net for a process that
        // died, not the normal path for one that merely failed.
        surrender(context.run_id);
      }
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
      principal_roles = [], approval_id = null, note = null, now: at = null,
    } = {}) {
      // G4 FIRST, before the run is even looked up.
      //
      // `policy.mjs` states that "automation approves nothing" is checked before
      // every other approval rule, and the engine honours that — but the engine
      // is reached only after `loadOwned`, so a service actor submitting a
      // guessed run id used to be told `approval_unknown` (this run does not
      // exist / is not yours) instead of `approval_actor_invalid`. Two problems
      // in one: the refusal a caller sees depended on a fact it should not
      // learn, making this an existence oracle over run ids, and the doctrine
      // rule that is supposed to be unconditional was conditional on the lookup
      // succeeding. An actor that can never approve anything is refused before
      // anything is read.
      if (actor !== 'human') {
        return Object.freeze({
          ok: false,
          run_id,
          reason: 'approval_actor_invalid',
          detail: `approvals require actor 'human'; automation may never approve its own work (got '${actor}')`,
        });
      }

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

      // Recording a vote appends to the journal, so it is a WRITE and takes the
      // lease like any other. Two approvers deciding at the same instant on a
      // quorum-of-two run would otherwise each append to their own copy of the
      // history and the second write would erase the first vote — turning the
      // quorum into a gate that one person can satisfy by racing.
      const claimed = claim({ run_id, org_id, at: now(at) });
      if (!claimed.ok) return notClaimed(run_id, claimed);

      try {
        const verdict = engine.submitApproval({
          journal, manifest, decision, actor, principal, principal_roles, org_id, note, approval_id,
        });
        if (!verdict.ok) {
          return Object.freeze({ ok: false, run_id, reason: verdict.reason, detail: verdict.detail });
        }

        const stored = commit({ journal, fence: claimed.fence, expected_head: owned.document.head });
        if (!stored.ok) {
          // The vote exists only in this worker's in-memory journal and was
          // never written, so refusing here loses nothing: the approver retries
          // against the current history. This is the one commit refusal in the
          // service with no side effect behind it.
          return Object.freeze({
            ok: false, run_id, reason: stored.reason, detail: stored.error, decision: verdict.decision,
          });
        }

        return Object.freeze({
          ok: true,
          run_id,
          decision: verdict.decision,
          approval_id: verdict.approval_id,
          step_id: verdict.step_id,
          // A caller that does not read these will simply try to resume and be
          // told the run is still paused — the gate is enforced by the engine, not
          // by the caller's cooperation. They exist so an operator surface can say
          // "1 of 2 approvals recorded" instead of "nothing happened".
          quorum: verdict.quorum,
          outstanding: verdict.outstanding,
          quorum_satisfied: verdict.quorum_satisfied,
          principals: verdict.principals,
          state: verdict.state.state,
          journal_ref: stored.ref,
        });
      } finally {
        surrender(run_id);
      }
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

      // THE race this whole mechanism exists for. Two operators, or one operator
      // and a scheduled worker, both told to continue an approved run: without
      // the claim they both load the same journal, both dispatch the payment
      // instruction, and both write a valid-looking history.
      const claimed = claim({ run_id, org_id, at: started_at });
      if (!claimed.ok) return notClaimed(run_id, claimed);

      try {
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

        const stored = commit({ journal, fence: claimed.fence, expected_head: owned.document.head });
        if (!stored.ok) return lostMidRun({ context, run_id, org_id, stored, phase: 'resume' });

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
            lease_fence: claimed.fence,
          },
        });

        return Object.freeze({
          ok: true,
          ...summarize({ document: journal.toDocument(), manifest }),
          advance: result.advance,
          blocked_reason: result.outcome.blocked_reason,
          outcome: result.outcome,
          journal_ref: stored.ref,
          lease_fence: claimed.fence,
          ...written,
        });
      } finally {
        surrender(run_id);
      }
    },

    async cancelRun({ run_id, org_id = null, reason = 'operator cancelled', deps = {}, now: at = null } = {}) {
      const owned = loadOwned(run_id, org_id, { at: 'cancelRun' });
      if (!owned.ok) return Object.freeze({ ok: false, run_id, ...owned, document: undefined });

      const journal = loadRunJournal(owned.document);
      const manifest = manifestOf(owned.document);
      const started_at = now(at);
      const context = contextFor({
        workflow_id: journal.workflow_id,
        org_id,
        run_id: journal.run_id,
        input: null,
        started_at,
        actor: 'human',
        mode: null,
        trace_id: null,
        attributes: { entry: 'control_plane.cancelRun' },
      });

      // A cancellation RUNS the compensators, so it is as consequential as a
      // resume and takes the lease on the same terms. Cancelling a run another
      // worker is mid-step on is exactly how a compensator ends up undoing a
      // step that is about to be re-applied.
      const claimed = claim({ run_id, org_id, at: started_at });
      if (!claimed.ok) return notClaimed(run_id, claimed);

      try {
        // Seeded from the DATA store for the same reason a resume is: the
        // compensators need the outputs of the steps they are undoing, and a
        // cancellation that cannot roll back is a cancellation that leaves the
        // tenant half-applied.
        const stepResults = readResults({ run_id: journal.run_id, org_id });
        const result = await engine.cancelRun({ journal, manifest, context, deps, reason, results: stepResults });
        const stored = commit({ journal, fence: claimed.fence, expected_head: owned.document.head });
        if (!stored.ok) return lostMidRun({ context, run_id, org_id, stored, phase: 'cancel' });

        return Object.freeze({
          ok: true,
          ...summarize({ document: journal.toDocument(), manifest }),
          advance: result.advance,
          journal_ref: stored.ref,
          lease_fence: claimed.fence,
        });
      } finally {
        surrender(run_id);
      }
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

    // --- concurrency ---------------------------------------------------------

    /** Who, if anyone, currently holds this run. Read-only; takes nothing. */
    getLease({ run_id } = {}) { return leaseStore.read(run_id); },

    listLeases() { return leaseStore.list(); },

    /**
     * expireLeases({ now }) — which runs were abandoned, and by whom.
     *
     * It reports and changes nothing, because nothing needs changing: an
     * expired lease is ALREADY claimable (`evaluateClaim` compares the deadline
     * rather than trusting the record's existence), and deleting the record
     * would reset its fence and hand a suspended worker a valid fence again.
     * This is a monitoring call, not a repair.
     */
    expireLeases({ now: at = null } = {}) { return leaseStore.expire({ now: now(at) }); },

    /** The worker identity every write in this process is attributed to. */
    holder: workerId,
    leaseStoreName: leaseStore.name,
    crossProcessLeases: leaseStore.cross_process === true,
  });
}
