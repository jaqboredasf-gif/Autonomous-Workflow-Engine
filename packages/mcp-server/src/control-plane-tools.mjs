// ---------------------------------------------------------------------------
// control-plane-tools.mjs — the execution control plane as MCP tools.
//
// Before this file the control plane was reachable only from a local operator
// CLI, which meant the answer to "how does anything actually start a governed
// workflow?" was "a person runs a node script". These six tools make it a
// surface: an agent can discover which workflows a tenant may run, start one,
// watch it, see what a human is being asked to decide, resume it once they
// have, and cancel it.
//
// They reuse EVERYTHING the ten data tools already use — the same tenant gate
// (`resolveExecution`), the same descriptors (`defineTool`), the same run
// scaffolding, the same audit sinks, the same response mapping. The only new
// thing is what a body is handed: a control-plane service instead of a data
// port. That is why `runtime.mjs` grew a `needs` discriminator rather than a
// second execute function; a parallel MCP runtime would have been a second
// place for the tenant rule to be got wrong.
//
// ============================ WHY THERE IS NO WAY TO APPROVE ================
//
// `decide_approval` exists here and REFUSES, always. That is the feature, not a
// gap, and it is worth being exact about why.
//
// Doctrine G4 is "automation approves nothing". The control plane enforces it
// by refusing any approval whose `actor` is not 'human'. An MCP call is made by
// a model. The server cannot see a person behind it: there is no session, no
// credential, no signature — `resolveExecution` establishes WHICH TENANT a call
// is for, and nothing about WHO made it. So a `decide_approval` tool that
// accepted `actor: 'human'` as an argument would be an argument through which
// an agent asserts its own humanity, and G4 would be enforced everywhere except
// the one boundary an agent can reach.
//
// An operator flag would not fix it either. `AWE_ALLOW_MCP_APPROVALS=1` does
// not make the model a person; it makes the loophole configurable.
//
// So the refusal is unconditional and the useful half is exposed instead:
// `list_pending_approvals` lets an agent tell a human exactly what is waiting
// and why, which is the job it can legitimately do. The decision itself belongs
// to a surface that authenticates a person — today the web approval queue
// (`apps/web/src/lib/approval-queue.ts`), which already has capabilities and a
// signed-in user.
//
// THE FUTURE PATH, so this is a decision rather than an omission: the human
// surface mints a single-use, tenant-bound approval TOKEN, and the relay
// presents it here for verification. That is delegated authority a server can
// actually check. It needs a signing key and a token store, which means it
// needs the identity decisions this repo has deliberately not made yet
// (policy.mjs: "no identity provider, no session, no role assignment, no
// credential"). Until then, refusing is the only honest answer.
//
// `resume_run` IS exposed, and the distinction is the point: resuming is not
// approving. It executes what a human already authorized, and if no human has,
// the engine refuses it with `approval_required` — which the test suite pins.
// ---------------------------------------------------------------------------

import { z } from 'zod';

import { blocked, createEvent, defineTool, succeeded } from '../../awe-kernel/src/index.mjs';

const ORG_ARG = {
  org_id: z.string().optional().describe(
    'Tenant to act for. Required unless the server was launched with AWE_ORG_ID. Never inferred.',
  ),
};

function controlEvent(context, { tool, entity_id = null, payload = {} }) {
  return createEvent({
    event_type: `agent.control_${tool}`,
    entity_type: 'workflow_run',
    entity_id,
    org_id: context.org_id,
    occurred_at: context.started_at,
    payload: { tool, mode: context.mode, is_fixture: context.is_fixture, ...payload },
  });
}

// What an MCP caller is told about a run. Deliberately NOT the whole summary:
// the full projection carries every tool invocation with its idempotency keys
// and input digests, which is an operator's view, not a caller's. A caller
// needs to know where the run is, what it is waiting for, and how to find the
// evidence.
function runView(run) {
  return {
    run_id: run.run_id,
    workflow_id: run.workflow_id,
    workflow_version: run.workflow_version,
    state: run.state,
    terminal: run.terminal,
    risk: run.risk,
    completed_steps: run.completed_steps.map((s) => s.step_id),
    failed_steps: run.failed_steps.map((s) => ({ step_id: s.step_id, reason: s.reason })),
    pending_approval: run.pending_approval === null ? null : {
      approval_id: run.pending_approval.approval_id,
      step_id: run.pending_approval.step_id,
      tool: run.pending_approval.tool,
      side_effect: run.pending_approval.side_effect,
      approver_roles: run.pending_approval.approver_roles,
      quorum: run.pending_approval.quorum,
      outstanding: run.pending_approval.outstanding,
      approved_by: run.pending_approval.votes
        .filter((v) => v.decision === 'approve')
        .map((v) => v.principal),
    },
    failure: run.failure,
    event_count: run.event_count,
    journal_head: run.journal_head,
  };
}

// A refusal from the control-plane service, turned into an outcome envelope.
// The service already answers with a registered reason, so this adds nothing
// but the envelope — which is exactly what it should add.
const refuse = (verdict, { tool, detail = null }) => blocked(verdict.reason, {
  audit: [{ step: tool, ok: false, detail: detail ?? verdict.detail }],
  meta: { detail: detail ?? verdict.detail, run_id: verdict.run_id ?? null },
});

// --- 1. list_workflows -------------------------------------------------------

export const listWorkflows = {
  needs: 'control_plane',
  descriptor: defineTool({
    name: 'list_workflows',
    workflow_id: 'mcp_list_workflows',
    description:
      'List the governed workflows this tenant is permitted to run, with their version, risk class, '
      + 'promotion status and required tools. Only promoted, in-scope workflows can actually be started.',
    input_schema: 'awe.list_workflows.input/v1',
    output_schema: 'awe.workflow_catalog/v1',
    side_effect: 'read',
    requires_tenant: true,
  }),
  inputSchema: { ...ORG_ARG },
  async body(_input, { context, control }) {
    // The tenant is ALWAYS passed, which is what makes the catalogue filtered
    // and strips other tenants' allow-lists out of the result.
    const workflows = control.listWorkflows({ org_id: context.org_id });
    return succeeded(
      { workflows, count: workflows.length, registry_digest: control.registryDigest() },
      { audit: [{ step: 'list_workflows', ok: true, detail: `${workflows.length} in scope for this tenant` }] },
    );
  },
};

// --- 2. start_workflow_run ---------------------------------------------------

export const startWorkflowRun = {
  needs: 'control_plane',
  descriptor: defineTool({
    name: 'start_workflow_run',
    workflow_id: 'mcp_start_workflow_run',
    description:
      'Start a run of a registered workflow for this tenant. The run executes until it completes, fails, '
      + 'or reaches a step that requires human approval — at which point it PAUSES and returns its pending '
      + 'approval. Nothing consequential happens without that approval.',
    input_schema: 'awe.start_workflow_run.input/v1',
    output_schema: 'awe.run_view/v1',
    // Declared at the top of the scale because a workflow's own steps may be:
    // this tool is as consequential as the most consequential thing it can
    // start, and understating that in the descriptor would misinform every
    // future authorization decision built on it.
    side_effect: 'external',
    requires_tenant: true,
  }),
  inputSchema: {
    ...ORG_ARG,
    workflow_id: z.string().describe('Workflow to run, as listed by list_workflows'),
    version: z.string().optional().describe("Version requirement: '1.4.2' (pinned) or '^1.4.2' (same major)"),
    input: z.record(z.string(), z.unknown()).optional().describe('Workflow input'),
  },
  async body({ workflow_id, version = null, input = {} }, { context, control }) {
    const started = await control.startRun({
      workflow_id,
      version,
      org_id: context.org_id,
      input,
      // No context is passed from here on purpose. A workflow's context comes
      // from the providers its service was composed with, so an MCP caller
      // cannot supply the material the workflow is meant to be grounded in.
      // The run is attributed to the agent that asked for it. It is NOT
      // attributed to a person, which is what keeps the approval gate's
      // `actor: 'human'` check meaningful downstream.
      actor: 'service',
      mode: context.mode,
      trace_id: context.run_id,
    });

    if (started.ok === false) {
      return refuse(started, { tool: 'start_workflow_run' });
    }
    if (started.blocked_reason !== null && started.blocked_reason !== undefined && started.state === 'failed') {
      return blocked(started.blocked_reason, {
        audit: [{ step: 'start_workflow_run', ok: false, detail: started.detail?.detail ?? null }],
        meta: { run_id: started.run_id, workflow_id },
      });
    }

    return succeeded(runView(started), {
      audit: [{ step: 'start_workflow_run', ok: true, detail: `run ${started.run_id} is ${started.state}` }],
      events: [controlEvent(context, {
        tool: 'start_workflow_run',
        entity_id: started.run_id,
        // The run id and the state, never the workflow's data — the same rule
        // the journal follows.
        payload: { workflow_id, workflow_version: started.workflow_version, state: started.state },
      })],
    });
  },
};

// --- 3. get_run --------------------------------------------------------------

export const getRun = {
  needs: 'control_plane',
  descriptor: defineTool({
    name: 'get_run',
    workflow_id: 'mcp_get_run',
    description:
      'Inspect a workflow run: its state, which steps completed, what failed, and what human decision '
      + 'it is waiting for. Rebuilt from the run\'s append-only journal, so it cannot report a state the '
      + 'history does not support.',
    input_schema: 'awe.get_run.input/v1',
    output_schema: 'awe.run_view/v1',
    side_effect: 'read',
    requires_tenant: true,
  }),
  inputSchema: { ...ORG_ARG, run_id: z.string().describe('The run to inspect') },
  async body({ run_id }, { context, control }) {
    const run = control.getRun({ run_id, org_id: context.org_id });
    if (run === null) {
      // One answer for "no such run" and "not your run". A caller that guessed
      // a run id must not be able to tell which of the two it hit, or the
      // refusal becomes an existence oracle over other tenants' run ids.
      return blocked('ambiguous_match', {
        audit: [{ step: 'get_run', ok: false, detail: 'no such run for this tenant' }],
        meta: { detail: `no run '${run_id}' is accessible to this tenant` },
      });
    }
    return succeeded(runView(run), {
      audit: [{ step: 'get_run', ok: true, detail: `run is ${run.state}` }],
    });
  },
};

// --- 4. list_pending_approvals ----------------------------------------------

export const listPendingApprovals = {
  needs: 'control_plane',
  descriptor: defineTool({
    name: 'list_pending_approvals',
    workflow_id: 'mcp_list_pending_approvals',
    description:
      'List this tenant\'s runs that are waiting for a human decision, with the step, the tool, how '
      + 'consequential it is, which roles may decide, and how many approvals are still outstanding. '
      + 'Use this to tell a person what needs their attention — this surface cannot decide for them.',
    input_schema: 'awe.list_pending_approvals.input/v1',
    output_schema: 'awe.pending_approval_list/v1',
    side_effect: 'read',
    requires_tenant: true,
  }),
  inputSchema: { ...ORG_ARG },
  async body(_input, { context, control }) {
    const pending = control.listRuns()
      .map((run_id) => control.getRun({ run_id, org_id: context.org_id }))
      // `getRun` returns null for another tenant's run, so the tenant filter is
      // the same guard the single-run read uses rather than a second one.
      .filter((run) => run !== null && run.pending_approval !== null)
      .map((run) => ({
        run_id: run.run_id,
        workflow_id: run.workflow_id,
        risk: run.risk,
        ...runView(run).pending_approval,
      }));

    return succeeded(
      { pending, count: pending.length, decide_at: 'the human approval surface — this surface cannot approve' },
      { audit: [{ step: 'list_pending_approvals', ok: true, detail: `${pending.length} awaiting a human` }] },
    );
  },
};

// --- 5. resume_run -----------------------------------------------------------

export const resumeRun = {
  needs: 'control_plane',
  descriptor: defineTool({
    name: 'resume_run',
    workflow_id: 'mcp_resume_run',
    description:
      'Continue a run that was paused. If the required human approvals have been recorded the run '
      + 'proceeds; if they have not, it is refused and stays paused. Resuming is not approving.',
    input_schema: 'awe.resume_run.input/v1',
    output_schema: 'awe.run_view/v1',
    side_effect: 'external',
    requires_tenant: true,
  }),
  inputSchema: { ...ORG_ARG, run_id: z.string().describe('The paused run to continue') },
  async body({ run_id }, { context, control }) {
    const resumed = await control.resumeRun({ run_id, org_id: context.org_id });
    if (resumed.ok === false) return refuse(resumed, { tool: 'resume_run' });

    // A run that is still waiting for its quorum comes back `paused` with
    // `approval_required`. That is a refusal, and it is reported as one — an
    // agent that read "ok" here would tell a person the work was done.
    if (resumed.advance === 'paused') {
      return blocked('approval_required', {
        audit: [{ step: 'resume_run', ok: false, detail: 'the run is still waiting for a human decision' }],
        meta: { run_id, detail: 'the run is still waiting for a human decision', outstanding: resumed.pending_approval?.outstanding ?? null },
      });
    }

    return succeeded(runView(resumed), {
      audit: [{ step: 'resume_run', ok: true, detail: `run ${run_id} is ${resumed.state}` }],
      events: [controlEvent(context, {
        tool: 'resume_run', entity_id: run_id, payload: { state: resumed.state, advance: resumed.advance },
      })],
    });
  },
};

// --- 6. decide_approval — present, and refuses ------------------------------

export const decideApproval = {
  needs: 'control_plane',
  descriptor: defineTool({
    name: 'decide_approval',
    workflow_id: 'mcp_decide_approval',
    description:
      'REFUSED ON THIS SURFACE. Approvals must be made by an authenticated person, and an MCP call '
      + 'carries no evidence of one — so this tool always refuses, whatever it is passed. Use '
      + 'list_pending_approvals to show a human what is waiting; they decide on the human approval surface.',
    input_schema: 'awe.decide_approval.input/v1',
    output_schema: 'awe.refusal/v1',
    side_effect: 'external',
    requires_tenant: true,
  }),
  inputSchema: {
    ...ORG_ARG,
    run_id: z.string().describe('The run whose approval is pending'),
    decision: z.enum(['approve', 'reject']).describe('The decision — refused regardless of value'),
  },
  async body({ run_id, decision }, { context, control }) {
    // The refusal is computed by the SAME rule the control plane uses, by
    // actually submitting with this surface's real actor, rather than by
    // returning a hard-coded string. If G4 were ever relaxed in the engine this
    // tool would relax with it and the test below would catch that in one step,
    // which a hard-coded refusal could not.
    const verdict = await control.decideApproval({
      run_id,
      org_id: context.org_id,
      decision,
      // The truth: the caller is the service. There is no argument on this tool
      // through which it can claim otherwise, which is the whole design.
      actor: 'service',
      principal: 'mcp_client',
      principal_roles: [],
    });

    return blocked(verdict.reason ?? 'approval_actor_invalid', {
      audit: [{ step: 'decide_approval', ok: false, detail: verdict.detail ?? 'automation may never approve' }],
      meta: {
        run_id,
        detail: 'approvals require an authenticated human; this surface cannot provide one. '
          + 'Show the pending approval to a person and have them decide on the human approval surface.',
      },
    });
  },
};

/**
 * The control-plane tool set. Kept separate from `TOOLS` in `tools.mjs` because
 * the two need different injected boundaries, and joined by the server: a
 * process with no control-plane service registers only the data tools, and one
 * with no data port registers only these.
 */
export const CONTROL_PLANE_TOOLS = [
  listWorkflows,
  startWorkflowRun,
  getRun,
  listPendingApprovals,
  resumeRun,
  decideApproval,
];
