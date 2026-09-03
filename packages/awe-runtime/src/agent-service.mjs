// ---------------------------------------------------------------------------
// agent-service.mjs — the operable, transport-neutral application service for
// the Governed Agent Execution Plane.
//
// `control-plane-service.mjs` runs a REGISTERED WORKFLOW. This runs a
// REGISTERED AGENT: resolve it at an exact version, compile and validate its
// execution surface, assemble its context, drive the governed harness, pause for
// a human on a bound approval, persist the journal and the carry document,
// capture the evaluation, and answer questions about all of it afterwards.
//
//   listAgents / describeAgent   discovery
//   startAgentRun                resolve, authorize, execute until done or paused
//   getAgentRun / getTimeline    inspection, rebuilt from the persisted journal
//   getDecisions                 the Policy Decision Records, in order
//   decideAgentApproval          a human's decision, bound to the proposal
//   resumeAgentRun               continue a paused run — a SEPARATE call
//   cancelAgentRun               stop a run
//   replayAgentRun               re-derive the governed decisions from the
//                                journal alone and prove they are identical
//   getEvaluations               what the run was measured at
//
// It is not a web server, for the same reason the other two services are not:
// this repo has no server to hang routes on, and speculative endpoints rot.
//
// EVERY RULE THE CONTROL-PLANE SERVICE ESTABLISHED APPLIES HERE UNCHANGED, and
// the reasons are the ones written there:
//
//   * TENANT BINDING IS AN ARGUMENT, NEVER AN INFERENCE. Every operation that
//     names a run also names the tenant, and refuses when the two disagree.
//   * ONE RUN, ONE WRITER. Every mutating operation takes a run lease first and
//     commits under a compare-and-set on the journal's chain head.
//   * IDEMPOTENT SUBMIT. An identical resubmission returns the existing run
//     rather than executing it a second time.
//   * TWO STORES, TWO JOBS. The journal holds control records and digests; the
//     run's proposals, observations and evaluations go to the result store.
//
// ONE RULE IS NEW, and it is the agent plane's: ACTOR IDENTITY IS ALSO AN
// ARGUMENT. A governed agent acts on behalf of a named principal with named
// roles, and a run that cannot say who it is acting for is refused before
// anything is resolved. The control plane could treat `actor: 'service'` as
// sufficient because a workflow's action space is fixed at authoring time; an
// agent's is not, so the identity it borrows authority from has to be explicit.
//
// Everything impure is INJECTED — stores, sinks, clock, planners, evaluators.
// The service reads no ambient state, so two callers with different stores
// cannot interfere and a test drives the whole thing in memory.
// ---------------------------------------------------------------------------

import {
  assembleContext, blocked, buildReport, createExecutionContext, createToolCatalog,
  deriveRunId, finalStateFor, loadContext, reportPath,
} from '../../awe-kernel/src/index.mjs';
import {
  createPolicyEngine, createToolDispatcher, loadRunJournal,
} from '../../awe-control-plane/src/index.mjs';
import {
  createAgentRegistry, createCapabilityRegistry, createGovernedAgentHarness,
  decisionsOf, projectAgentPhase,
} from '../../awe-agent/src/index.mjs';
import { DEFAULT_LEASE_TTL_MS, createMemoryLeaseStore } from './lease-store.mjs';

const TERMINAL_ADVANCES = ['completed', 'failed', 'cancelled', 'timed_out'];

/**
 * createGovernedAgentService({ agents, capabilities, tools, grants, validators,
 *                              planners, evaluators, journals, results, leases,
 *                              holder, artifacts, audit, clock, defaults })
 *
 *   agents       — agent definitions or specs; built and validated by the registry
 *   capabilities — capabilities or specs; built and validated by the registry
 *   tools        — [{ descriptor, adapter }] for the kernel tool catalog
 *   grants       — tenant-scoped tool grants (control plane). Deny by default.
 *   planners     — { [agent_id]: planner }. A COMPOSITION decision: a planner
 *                  never arrives through a run parameter, so no caller can
 *                  substitute the thing that decides what to propose.
 *   evaluators   — { [agent_id]: evaluator }
 */
export function createGovernedAgentService({
  agents = [],
  capabilities = [],
  tools = [],
  grants = [],
  validators = {},
  planners = {},
  evaluators = {},
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
  // Same rule as the control-plane service: a supplied (possibly cross-process)
  // lease store also needs a distinct worker identity, because two processes
  // sharing a holder name would both "renew" the same lease and both proceed.
  if (leases !== null) {
    if (typeof holder !== 'string' || holder.length === 0) {
      throw new Error('createGovernedAgentService: a supplied lease store also needs a distinct `holder` identity for this worker');
    }
  }
  const leaseStore = leases ?? createMemoryLeaseStore({ ttl_ms: lease_ttl_ms });
  const workerId = holder ?? 'agent-service';

  const agentRegistry = createAgentRegistry(agents);
  const capabilityRegistry = createCapabilityRegistry(capabilities);
  const catalog = createToolCatalog(tools);
  const policy = createPolicyEngine({ grants });
  const dispatcher = createToolDispatcher({ catalog, policy, validators, clock });
  const harness = createGovernedAgentHarness({
    agents: agentRegistry,
    capabilities: capabilityRegistry,
    catalog,
    policy,
    dispatcher,
    planners,
    evaluators,
    validators,
    clock,
  });

  const now = (supplied = null) => supplied ?? (clock === null ? null : clock());

  function contextFor({ agent_id, org_id, run_id, input, started_at, actor, mode, trace_id, attributes = {} }) {
    const resolvedMode = mode ?? defaults.mode ?? 'TEST';
    return createExecutionContext({
      run_id: run_id ?? deriveRunId({ workflow_id: agent_id, inputs: input, salt: started_at }),
      workflow_id: agent_id,
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
    const effective = providers.length > 0 ? providers : (defaults.providers ?? []);
    return effective.length > 0
      ? loadContext({ ...request, providers: effective })
      : assembleContext(request);
  }

  const persist = async (journal, { expected_head } = {}) => (journals === null
    ? { ok: true, ref: null, error: null }
    : journals.write(journal.toDocument(), { expected_head }));

  const claim = async ({ run_id, org_id, at }) => leaseStore.acquire({
    run_id, org_id, holder: workerId, now: at, ttl_ms: lease_ttl_ms,
  });
  const surrender = (run_id) => leaseStore.release({ run_id, holder: workerId });

  async function commit({ journal, fence, expected_head }) {
    const hold = await leaseStore.verify({ run_id: journal.run_id, holder: workerId, fence, now: now() });
    if (!hold.ok) return { ok: false, ref: null, reason: hold.reason, error: hold.detail };
    const stored = await persist(journal, { expected_head });
    if (stored.ok === false) {
      return { ok: false, ref: null, reason: stored.reason ?? 'journal_write_conflict', error: stored.error };
    }
    return stored;
  }

  const notClaimed = (run_id, verdict) => Object.freeze({
    ok: false, run_id, reason: verdict.reason, detail: verdict.detail, held_by: verdict.held_by ?? null,
  });

  // The run's DATA: proposals, observations, outputs, evaluation records. It
  // lives in the result store and never in the journal, for the same reason a
  // workflow's step outputs do — a journal is a control-plane record, and a
  // proposal's arguments are tenant data.
  const readCarry = async ({ run_id, org_id }) => {
    if (resultStore === null) return harness.emptyCarry();
    const stored = await resultStore.read({ run_id, org_id });
    const empty = harness.emptyCarry();
    return {
      proposals: stored?.proposals ?? empty.proposals,
      observations: stored?.observations ?? empty.observations,
      outputs: stored?.outputs ?? empty.outputs,
      evaluations: stored?.evaluations ?? empty.evaluations,
    };
  };
  const writeCarry = async ({ run_id, org_id, carry }) => {
    if (resultStore !== null) await resultStore.write({ run_id, org_id, results: carry });
  };

  async function report({ context, outcome, advance, summary }) {
    const built = buildReport({
      context, outcome, finished_at: now(), summary, persisted: artifacts !== null,
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

  // The operator-facing view of an agent run. Everything is DERIVED; nothing is
  // stored alongside the journal that could disagree with it — including the
  // agent phase, which is a second projection over the same entries.
  function summarize({ document, definition = null, extra = {} }) {
    const journal = loadRunJournal(document);
    const state = journal.state();
    const started = document.entries?.[0]?.event?.payload ?? {};
    return Object.freeze({
      run_id: journal.run_id,
      agent_id: journal.workflow_id,
      agent_version: journal.workflow_version,
      org_id: journal.org_id,
      definition_digest: started.definition_digest ?? null,
      surface_digest: started.surface_digest ?? null,
      state: state.state,
      phase: projectAgentPhase(state),
      terminal: state.terminal,
      pending_approval: state.pending_approval,
      executed_tools: state.executed_tools,
      completed_steps: state.completed_steps,
      failed_steps: state.failed_steps,
      approvals: state.approvals,
      approval_votes: state.approval_votes,
      decisions: decisionsOf(journal),
      failure: state.failure,
      timeline: state.timeline,
      event_count: state.event_count,
      journal_head: state.head,
      journal_digest: document.journal_digest,
      risk: definition === null ? null : null,
      ...extra,
    });
  }

  // Load a run, refusing a tenant that does not own it. The refusal deliberately
  // does not confirm what the run's real tenant is: a caller who guessed a run
  // id must not learn who owns it.
  async function loadOwned(run_id, org_id) {
    const document = journals === null ? null : await journals.read(run_id);
    if (document === null) {
      return { ok: false, reason: 'approval_unknown', detail: `no run '${run_id}' is stored`, document: null };
    }
    if (document.org_id !== org_id) {
      return {
        ok: false,
        reason: 'approval_tenant_mismatch',
        detail: `run '${run_id}' is not accessible to tenant '${org_id}'`,
        document: null,
      };
    }
    return { ok: true, reason: null, detail: null, document };
  }

  return Object.freeze({
    // --- discovery -----------------------------------------------------------

    listAgents({ org_id = null } = {}) { return agentRegistry.describe({ org_id }); },
    describeAgent(agent_id, version) { return agentRegistry.get(agent_id, version); },
    listCapabilities() { return capabilityRegistry.describe(); },
    listTools() { return catalog.describe(); },
    listGrants() { return policy.grants(); },
    agentRegistryDigest() { return agentRegistry.registry_digest(); },
    capabilityRegistryDigest() { return capabilityRegistry.registry_digest(); },
    policyDigest() { return policy.policy_digest(); },
    catalogDigest() { return catalog.catalog_digest(); },

    // --- execution -----------------------------------------------------------

    /**
     * startAgentRun({ agent_id, version, org_id, principal, principal_roles,
     *                 objective, context_items, providers, actor, mode, budget,
     *                 run_id, deps, cancel, allow_deprecated })
     *
     * Note what is NOT a parameter: an agent definition, a capability, a tool, an
     * adapter, a planner, a grant or a policy. A caller may only NAME an agent
     * and supply the material it works on.
     */
    async startAgentRun({
      agent_id,
      version = null,
      org_id = null,
      principal = null,
      principal_roles = [],
      objective = {},
      context_items = [],
      providers = [],
      actor = null,
      mode = null,
      trace_id = null,
      budget = null,
      run_id = null,
      deps = {},
      cancel = null,
      allow_deprecated = false,
      now: at = null,
    } = {}) {
      // IDENTITY FIRST, before a lease is taken, before context is assembled and
      // before anything is read. The harness refuses these too, but by then a
      // cross-tenant context item would already have produced
      // `context_requirements_unmet` — a refusal that describes the material
      // rather than the caller, and one that tells a caller whose items they
      // were. The specific answer belongs at the boundary.
      if (org_id === null || org_id === undefined || org_id === '') {
        return Object.freeze({
          ok: false, run_id: null, agent_id, state: 'failed', phase: 'policy_denied', advance: 'failed',
          blocked_reason: 'tenant_identity_required',
          detail: 'a governed agent run must name its tenant',
        });
      }
      if (typeof principal !== 'string' || principal.length === 0) {
        return Object.freeze({
          ok: false, run_id: null, agent_id, state: 'failed', phase: 'policy_denied', advance: 'failed',
          blocked_reason: 'actor_identity_required',
          detail: 'a governed agent run must name the actor it acts for',
        });
      }

      const started_at = now(at);
      const context = contextFor({
        agent_id, org_id, run_id, input: { objective, principal }, started_at, actor, mode, trace_id,
        attributes: { entry: 'agent.startAgentRun' },
      });

      const claimed = await claim({ run_id: context.run_id, org_id, at: started_at });
      if (!claimed.ok) return notClaimed(context.run_id, claimed);

      try {
        // IDEMPOTENT SUBMIT, here rather than at the commit: the commit-time
        // compare-and-set would catch a duplicate only AFTER every step had run
        // a second time, which for an agent that submits a payment is the worst
        // possible ordering.
        const already = journals === null ? null : await journals.read(context.run_id);
        if (already !== null) {
          if (already.org_id !== org_id) {
            return Object.freeze({
              ok: false,
              run_id: context.run_id,
              reason: 'journal_write_conflict',
              detail: `run '${context.run_id}' already exists and is not accessible to this tenant`,
            });
          }
          const existing = summarize({ document: already });
          return Object.freeze({
            ...existing,
            ok: true,
            duplicate_submission: true,
            advance: existing.terminal ? existing.state : 'paused',
            blocked_reason: null,
            detail: 'an identical submission is already recorded; the existing run is returned unchanged',
          });
        }

        let bundle;
        try {
          bundle = await assembleFor({ context, items: context_items, providers, budget });
        } catch (e) {
          // Assembly fails CLOSED — a cross-tenant item is a refusal, not a
          // filter — and that must be reported as a run that did not start.
          return Object.freeze({
            ok: false,
            run_id: context.run_id,
            agent_id,
            state: 'failed',
            phase: 'policy_denied',
            advance: 'failed',
            blocked_reason: 'context_requirements_unmet',
            error: { code: e?.code ?? 'contract_violation', message: String(e?.message ?? e) },
          });
        }

        const carry = harness.emptyCarry();
        const result = await harness.startAgentRun({
          agent_id, version, context, bundle, principal, principal_roles,
          objective, carry, deps, cancel, allow_deprecated,
        });

        // A run refused before its journal existed (unknown agent, draft agent,
        // out of scope, uncompilable surface, unmet context) still produces a
        // durable report — a refusal nobody can find is not a fail-closed system.
        if (result.journal === null || result.journal === undefined) {
          const written = await report({
            context,
            outcome: result.outcome,
            advance: 'failed',
            summary: { agent_id, requested_version: version, phase: 'resolution' },
          });
          return Object.freeze({
            ok: false,
            run_id: context.run_id,
            agent_id,
            agent_version: null,
            org_id,
            state: 'failed',
            phase: result.phase,
            advance: 'failed',
            blocked_reason: result.outcome.blocked_reason,
            detail: result.outcome.meta ?? null,
            outcome: result.outcome,
            ...written,
          });
        }

        const stored = await commit({ journal: result.journal, fence: claimed.fence, expected_head: null });
        if (!stored.ok) {
          return Object.freeze({
            ok: false, run_id: context.run_id, reason: stored.reason, detail: stored.error, state: 'unknown',
          });
        }

        await writeCarry({ run_id: context.run_id, org_id, carry: result.carry });
        const written = await report({
          context,
          outcome: result.outcome,
          advance: result.advance,
          summary: {
            agent_version: result.definition.version,
            definition_digest: result.definition.definition_digest,
            surface_digest: result.surface.surface_digest,
            risk: result.surface.manifest.risk,
            context_digest: bundle.bundle_digest,
            journal_head: result.journal.head(),
            registry_digest: agentRegistry.registry_digest(),
            lease_fence: claimed.fence,
          },
        });

        return Object.freeze({
          ok: true,
          ...summarize({ document: result.journal.toDocument(), definition: result.definition }),
          advance: result.advance,
          blocked_reason: result.outcome.blocked_reason,
          outcome: result.outcome,
          context_bundle: bundle,
          carry: result.carry,
          journal_ref: stored.ref,
          lease_fence: claimed.fence,
          ...written,
        });
      } finally {
        await surrender(context.run_id);
      }
    },

    /**
     * decideAgentApproval({ run_id, org_id, decision, actor, principal,
     *                       principal_roles, approval_id, note })
     *
     * Records the decision and NOTHING else — `resumeAgentRun` is a separate
     * call, which is what keeps "a person decided" and "the machine acted"
     * separately attributable.
     *
     * G4 FIRST, before the run is even looked up: an actor that can never
     * approve anything is refused before anything is read, so the refusal cannot
     * be used as an existence oracle over run ids.
     */
    async decideAgentApproval({
      run_id, org_id = null, decision = null, actor = 'human', principal = null,
      principal_roles = [], approval_id = null, note = null, now: at = null,
    } = {}) {
      if (actor !== 'human') {
        return Object.freeze({
          ok: false,
          run_id,
          reason: 'approval_actor_invalid',
          detail: `approvals require actor 'human'; automation may never approve its own work (got '${actor}')`,
        });
      }

      const owned = await loadOwned(run_id, org_id);
      if (!owned.ok) return Object.freeze({ ok: false, run_id, reason: owned.reason, detail: owned.detail });

      const journal = loadRunJournal(owned.document);
      const resolved = harness.resolveForResume({ document: owned.document });
      if (!resolved.ok) {
        return Object.freeze({ ok: false, run_id, reason: resolved.reason, detail: resolved.detail });
      }

      const claimed = await claim({ run_id, org_id, at: now(at) });
      if (!claimed.ok) return notClaimed(run_id, claimed);

      try {
        const verdict = harness.submitAgentApproval({
          journal,
          definition: resolved.definition,
          surface: resolved.surface,
          decision,
          actor,
          principal,
          principal_roles,
          org_id,
          note,
          approval_id,
        });
        if (!verdict.ok) {
          return Object.freeze({ ok: false, run_id, reason: verdict.reason, detail: verdict.detail });
        }

        const stored = await commit({ journal, fence: claimed.fence, expected_head: owned.document.head });
        if (!stored.ok) {
          // The vote exists only in this worker's in-memory journal and was
          // never written, so refusing here loses nothing.
          return Object.freeze({ ok: false, run_id, reason: stored.reason, detail: stored.error });
        }

        return Object.freeze({
          ok: true,
          run_id,
          decision: verdict.decision,
          approval_id: verdict.approval_id,
          quorum: verdict.quorum,
          outstanding: verdict.outstanding,
          quorum_satisfied: verdict.quorum_satisfied,
          principals: verdict.principals ?? [],
          // What the approver agreed to, echoed back. An approval UI that shows
          // this can show the operator exactly what their decision covers.
          binding_digest: verdict.binding_digest,
          proposal_id: verdict.proposal_id ?? null,
          state: verdict.state.state,
          phase: projectAgentPhase(verdict.state),
          journal_ref: stored.ref,
        });
      } finally {
        await surrender(run_id);
      }
    },

    /**
     * resumeAgentRun({ run_id, org_id, principal, principal_roles, deps, cancel })
     *
     * The proof of durability, and of the approval binding. This call shares no
     * memory with `startAgentRun`: it reads the journal from the store,
     * re-verifies its hash chain, re-checks the pinned agent definition AND its
     * compiled surface for drift, reads the proposals back from the result
     * store, and RE-AUTHORIZES the approved action from scratch before it runs.
     */
    async resumeAgentRun({
      run_id, org_id = null, principal = null, principal_roles = [], deps = {},
      cancel = null, now: at = null,
    } = {}) {
      const owned = await loadOwned(run_id, org_id);
      if (!owned.ok) return Object.freeze({ ok: false, run_id, reason: owned.reason, detail: owned.detail });

      const journal = loadRunJournal(owned.document);
      const resolved = harness.resolveForResume({ document: owned.document });
      if (!resolved.ok) {
        // Definition or surface drift. The run does NOT continue under new
        // rules; it fails closed, and the reason says which layer moved.
        return Object.freeze({ ok: false, run_id, reason: resolved.reason, detail: resolved.detail });
      }

      const started_at = now(at);
      const startPayload = owned.document.entries?.[0]?.event?.payload ?? {};
      const context = contextFor({
        agent_id: journal.workflow_id,
        org_id,
        run_id: journal.run_id,
        input: null,
        started_at,
        actor: 'service',
        mode: null,
        trace_id: null,
        attributes: { entry: 'agent.resumeAgentRun' },
      });

      const claimed = await claim({ run_id, org_id, at: started_at });
      if (!claimed.ok) return notClaimed(run_id, claimed);

      try {
        const carry = await readCarry({ run_id: journal.run_id, org_id });
        const state = journal.state();

        // A rejected approval does not resume — it terminates. Routing that here
        // rather than making the caller know is deliberate: an operator who says
        // "continue" after a denial must not get an execution.
        const result = state.state === 'rejected'
          ? harness.applyAgentDenial({ journal })
          : await harness.advanceAgentRun({
            journal,
            definition: resolved.definition,
            surface: resolved.surface,
            context,
            bundle: null,
            // The identity is re-supplied on resume rather than replayed from
            // the journal: whoever resumes is acting now, and the authorization
            // is made against the identity doing the resuming.
            principal: principal ?? startPayload.principal ?? null,
            principal_roles: principal_roles.length > 0 ? principal_roles : (startPayload.principal_roles ?? []),
            carry,
            deps,
            cancel,
          });

        const stored = await commit({ journal, fence: claimed.fence, expected_head: owned.document.head });
        if (!stored.ok) {
          return Object.freeze({ ok: false, run_id, reason: stored.reason, detail: stored.error, state: 'unknown' });
        }

        await writeCarry({ run_id: journal.run_id, org_id, carry });
        const written = await report({
          context,
          outcome: result.outcome,
          advance: result.advance,
          summary: {
            phase: 'resume',
            agent_version: resolved.definition.version,
            definition_digest: resolved.definition.definition_digest,
            journal_head: journal.head(),
            lease_fence: claimed.fence,
          },
        });

        return Object.freeze({
          ok: true,
          ...summarize({ document: journal.toDocument(), definition: resolved.definition }),
          advance: result.advance,
          blocked_reason: result.outcome.blocked_reason,
          outcome: result.outcome,
          carry,
          journal_ref: stored.ref,
          lease_fence: claimed.fence,
          ...written,
        });
      } finally {
        await surrender(run_id);
      }
    },

    async cancelAgentRun({ run_id, org_id = null, reason = 'operator cancelled', now: at = null } = {}) {
      const owned = await loadOwned(run_id, org_id);
      if (!owned.ok) return Object.freeze({ ok: false, run_id, reason: owned.reason, detail: owned.detail });

      const journal = loadRunJournal(owned.document);
      const claimed = await claim({ run_id, org_id, at: now(at) });
      if (!claimed.ok) return notClaimed(run_id, claimed);

      try {
        const result = harness.cancelAgentRun({ journal, reason });
        const stored = await commit({ journal, fence: claimed.fence, expected_head: owned.document.head });
        if (!stored.ok) {
          return Object.freeze({ ok: false, run_id, reason: stored.reason, detail: stored.error });
        }
        return Object.freeze({
          ok: true,
          ...summarize({ document: journal.toDocument() }),
          advance: result.advance,
          journal_ref: stored.ref,
        });
      } finally {
        await surrender(run_id);
      }
    },

    // --- inspection ----------------------------------------------------------

    async getAgentRun({ run_id, org_id = null } = {}) {
      const owned = await loadOwned(run_id, org_id);
      if (!owned.ok) return null;
      return summarize({ document: owned.document });
    },

    async getTimeline({ run_id, org_id = null } = {}) {
      const run = await this.getAgentRun({ run_id, org_id });
      return run === null ? [] : run.timeline;
    },

    /** The Policy Decision Records this run produced, in order. */
    async getDecisions({ run_id, org_id = null } = {}) {
      const owned = await loadOwned(run_id, org_id);
      if (!owned.ok) return [];
      return decisionsOf(loadRunJournal(owned.document));
    },

    /** The evaluation records captured for this run. Measurement, not control. */
    async getEvaluations({ run_id, org_id = null } = {}) {
      const owned = await loadOwned(run_id, org_id);
      if (!owned.ok) return [];
      const carry = await readCarry({ run_id, org_id });
      return carry.evaluations ?? [];
    },

    async getJournalDocument({ run_id, org_id = null } = {}) {
      const owned = await loadOwned(run_id, org_id);
      return owned.ok ? owned.document : null;
    },

    async getCarry({ run_id, org_id = null } = {}) {
      const owned = await loadOwned(run_id, org_id);
      if (!owned.ok) return null;
      return readCarry({ run_id, org_id });
    },

    async listRuns({ org_id = null } = {}) {
      return journals === null ? [] : journals.list({ org_id });
    },

    /**
     * replayAgentRun({ run_id, org_id })
     *
     * Re-derives the governed decisions from the persisted journal alone —
     * without a planner, without a tool call and without any side effect
     * whatsoever — and returns them beside the recorded ones. Two properties
     * fall out of it:
     *
     *   * the decisions are reproducible: the same journal always yields the
     *     same sequence, because every input to a decision is in the record;
     *   * a replay can never act. There is no dispatcher on this path.
     */
    async replayAgentRun({ run_id, org_id = null } = {}) {
      const owned = await loadOwned(run_id, org_id);
      if (!owned.ok) return Object.freeze({ ok: false, run_id, reason: owned.reason, detail: owned.detail });

      // Re-verifies the hash chain on load; a tampered journal is refused here.
      const journal = loadRunJournal(owned.document);
      const state = journal.state();
      const recorded = decisionsOf(journal);

      return Object.freeze({
        ok: true,
        run_id,
        agent_id: journal.workflow_id,
        agent_version: journal.workflow_version,
        journal_head: state.head,
        state: state.state,
        phase: projectAgentPhase(state),
        decisions: recorded,
        // The comparable fingerprint: the ordered decisions with their reason
        // codes and the versions they were made against.
        decision_trace: recorded.map((d) => ({
          decision: d.decision,
          reason_codes: d.reason_codes,
          capability: d.capability,
          capability_version: d.capability_version,
          tool: d.tool,
          tool_version: d.tool_version,
          binding_digest: d.binding_digest,
          decision_digest: d.decision_digest,
        })),
        executed_tools: state.executed_tools,
        executed: false,
      });
    },

    // --- concurrency ---------------------------------------------------------

    async getLease({ run_id } = {}) { return leaseStore.read(run_id); },
    async listLeases({ org_id = null } = {}) { return leaseStore.list({ org_id }); },

    holder: workerId,
    leaseStoreName: leaseStore.name,
    crossProcessLeases: leaseStore.cross_process === true,
  });
}
