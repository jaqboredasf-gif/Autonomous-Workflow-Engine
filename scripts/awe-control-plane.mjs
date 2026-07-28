#!/usr/bin/env node
// ---------------------------------------------------------------------------
// awe-control-plane.mjs — the operator entry point for the execution control
// plane.
//
// One executable, five subcommands, each of which is a SEPARATE PROCESS
// invocation. That matters: `start` pauses the run for a human and exits; the
// process dies; `approve` and `resume` are run afterwards by a process that
// shares no memory with it and rebuilds everything from the journal and result
// stores on disk. Pause/resume across separate application-service calls is
// therefore demonstrated rather than asserted.
//
//   node scripts/awe-control-plane.mjs workflows
//   node scripts/awe-control-plane.mjs start   [--org ID] [--version REQ]
//   node scripts/awe-control-plane.mjs show    --run RUN_ID [--org ID]
//   node scripts/awe-control-plane.mjs approve --run RUN_ID --by NAME --role ROLE [--reject]
//   node scripts/awe-control-plane.mjs resume  --run RUN_ID [--org ID]
//   node scripts/awe-control-plane.mjs demo                # all of the above, in-process
//
// SAFETY. Everything this command can reach is synthetic:
//   * mode is TEST and the policy engine refuses LIVE outright;
//   * the only tools registered are the six in-memory reference adapters;
//   * there is no network client, no database, no credential and no send path;
//   * artifacts are written under `artifacts/control-plane/` (git-ignored),
//     never to a shared or remote location.
// ---------------------------------------------------------------------------

import { memoryArtifactSink } from '../packages/awe-kernel/src/index.mjs';
import {
  createControlPlaneService, createFileAuditSink, createFileJournalStore,
  createFileLeaseStore, createFileResultStore, createSteppingClock,
} from '../packages/awe-runtime/src/index.mjs';
import {
  REFERENCE_ORG, createSyntheticLedger, invoiceIntakeManifest, referenceContextItems,
  referenceGrants, referenceTools, referenceValidators, tenantPolicyManifest,
} from '../packages/awe-runtime/src/reference/invoice-intake.mjs';

// Where this operator's runs are persisted. Honours `AWE_ARTIFACT_ROOT` like
// the MCP server does, and takes `--root` for a one-off — a demo that could
// only ever write into the repo could not be run twice against different state,
// and could not be run at all by someone who should not be writing there.
const ROOT = process.env.AWE_ARTIFACT_ROOT
  ? `${process.env.AWE_ARTIFACT_ROOT}/control-plane`
  : 'artifacts/control-plane';

// --- argument parsing --------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(arg);
  }
  return out;
}

// --- composition -------------------------------------------------------------

// The ledger is process-local, so a `resume` in a new process starts with an
// empty one. That is honest: in a real deployment the ledger is a table, and
// what survives a process boundary is the journal (control) and the result
// store (data) — exactly the two things this command persists.
function buildService({ start = '2026-07-28T09:00:00.000Z', ledger = createSyntheticLedger() } = {}) {
  const clock = createSteppingClock({ start, tick_ms: 10 });
  const service = createControlPlaneService({
    manifests: [invoiceIntakeManifest(), tenantPolicyManifest()],
    tools: referenceTools({ ledger, advance: clock.advance }),
    grants: referenceGrants(),
    validators: referenceValidators(),
    journals: createFileJournalStore({ root: ROOT }),
    results: createFileResultStore({ root: ROOT }),
    // A FILE lease store and a per-process holder, so two operators running
    // `resume` against the same root genuinely exclude each other rather than
    // both advancing the run. This is the composition the memory default is
    // explicitly not: see lease-store.mjs on what each store guarantees.
    leases: createFileLeaseStore({ root: ROOT }),
    holder: `cli_${process.pid}`,
    artifacts: memoryArtifactSink(),
    audit: createFileAuditSink({ root: ROOT }),
    clock,
  });
  return { service, clock, ledger };
}

// --- operator rendering ------------------------------------------------------

const line = (label, value) => console.log(`${label.padEnd(20)} ${value}`);

/**
 * A refusal that never produced a run — no lease, a tenant that does not own
 * the run, a colliding run id. It has a reason and a detail and nothing else,
 * so rendering it through `renderRun` used to crash on the first absent field
 * and hide the actual answer behind a TypeError.
 */
function renderRefusal(result, { title = 'RUN' } = {}) {
  console.log(`\n=== ${title} — REFUSED ===`);
  line('run id', result.run_id ?? '-');
  line('reason', result.reason ?? result.blocked_reason ?? 'unknown');
  line('detail', result.detail ?? '-');
  if (result.held_by) line('held by', result.held_by);
  console.log(`\nVERDICT: REFUSED (${result.reason ?? result.blocked_reason ?? 'unknown'})\n`);
}

function renderRun(run, { title = 'RUN' } = {}) {
  // Every mutating operation can answer with a refusal instead of a run. One
  // check here rather than at each of the five call sites.
  if (run === null || run === undefined || run.ok === false || run.timeline === undefined) {
    renderRefusal(run ?? {}, { title });
    return;
  }
  console.log(`\n=== ${title} ===`);
  line('run id', run.run_id);
  if (run.duplicate_submission === true) {
    line('duplicate', 'an identical submission was already recorded — the existing run is shown');
  }
  line('workflow', `${run.workflow_id} v${run.workflow_version}`);
  line('manifest digest', run.manifest_digest ?? '-');
  line('tenant', run.org_id);
  line('risk / promotion', `${run.risk ?? '-'} / ${run.promotion_status ?? '-'}`);
  line('state', `${run.state}${run.terminal ? ' (terminal)' : ''}`);
  line('advance', run.advance ?? '-');
  line('final state', run.final_state ?? '-');
  if (run.blocked_reason) line('blocked reason', run.blocked_reason);

  console.log('\n-- pending approval --');
  if (run.pending_approval === null || run.pending_approval === undefined) {
    console.log('  (none)');
  } else {
    const a = run.pending_approval;
    console.log(`  ${a.approval_id}  step='${a.step_id}'  tool='${a.tool}' (${a.side_effect})`);
    console.log(`  approver roles: ${a.approver_roles.join(', ')}  quorum: ${a.quorum}`);
  }

  console.log('\n-- executed tools (through the controlled boundary) --');
  if (run.executed_tools.length === 0) console.log('  (none)');
  for (const t of run.executed_tools) {
    console.log(`  ${String(t.seq).padStart(3)}  ${t.step_id.padEnd(16)} ${t.tool}@${t.tool_version} [${t.side_effect}] idem=${t.idempotency_key.slice(0, 12)}${t.replayed ? ' REPLAYED' : ''}`);
  }

  if (run.compensations.length > 0) {
    console.log('\n-- compensations --');
    for (const c of run.compensations) console.log(`  ${c.step_id} -> ${c.compensates ?? '(marker)'} : ${c.status}`);
  }

  console.log('\n-- event timeline (append-only, hash-chained) --');
  for (const e of run.timeline) {
    const where = e.step_id === null ? '' : `step='${e.step_id}'`;
    console.log(`  ${String(e.seq).padStart(3)}  ${(e.occurred_at ?? '-').padEnd(26)} ${e.event_type.padEnd(24)} ${where.padEnd(24)} ${e.detail ?? ''}`);
  }
  line('\nevent count', run.event_count);
  line('journal head', run.journal_head);
  line('journal digest', run.journal_digest);

  const verdict = run.state === 'completed' ? 'COMPLETED'
    : run.state === 'paused' ? 'PAUSED — awaiting human approval'
      : run.state === 'failed' ? `FAILED (${run.failure?.reason ?? run.blocked_reason ?? 'unknown'})`
        : run.state.toUpperCase();
  console.log(`\nVERDICT: ${verdict}\n`);
}

// --- subcommands -------------------------------------------------------------

async function cmdWorkflows() {
  const { service } = buildService();
  console.log('=== REGISTERED WORKFLOWS ===');
  for (const w of service.listWorkflows()) {
    console.log(`  ${w.workflow_id}@${w.version}  risk=${w.risk}  promotion=${w.promotion_status}  steps=${w.step_count}`);
    console.log(`    tenants: ${w.tenant_scope.mode === 'any_tenant' ? 'any' : w.tenant_scope.org_ids.join(', ')}`);
    console.log(`    tools:   ${w.required_tools.join(', ')}`);
    if (w.dependencies.length > 0) console.log(`    depends: ${w.dependencies.join(', ')}`);
  }
  console.log('\n=== REGISTERED TOOLS ===');
  for (const t of service.listTools()) {
    console.log(`  ${t.name}@${t.version}  [${t.side_effect}]  lifecycle=${t.lifecycle}  tenant_scoped=${t.requires_tenant}`);
  }
  console.log('\n=== TENANT GRANTS (deny by default) ===');
  for (const g of service.listGrants()) {
    console.log(`  ${g.org_id}  ${g.workflow_id}  ${g.tool}@${g.version}  ceiling=${g.max_side_effect}`);
  }
  console.log(`\nregistry_digest=${service.registryDigest()}  policy_digest=${service.policyDigest()}  catalog_digest=${service.catalogDigest()}`);
  return 0;
}

async function cmdStart(args) {
  const org_id = args.org ?? REFERENCE_ORG;
  const { service } = buildService();
  const run = await service.startRun({
    workflow_id: 'invoice_intake_approval',
    version: args.version ?? '^1.2.0',
    org_id,
    context_items: referenceContextItems({ org_id }),
  });
  renderRun(run, { title: 'START' });
  if (run.pending_approval) {
    console.log('Next (a SEPARATE process, sharing no memory with this one):');
    console.log(`  node scripts/awe-control-plane.mjs approve --run ${run.run_id} --by jack --role owner`);
    console.log(`  node scripts/awe-control-plane.mjs resume  --run ${run.run_id}`);
  }
  return run.state === 'failed' ? 1 : 0;
}

async function cmdShow(args) {
  const { service } = buildService();
  const run = service.getRun({ run_id: args.run, org_id: args.org ?? REFERENCE_ORG });
  if (run === null) { console.error(`no run '${args.run}' for that tenant`); return 1; }
  renderRun(run, { title: 'SHOW' });
  return 0;
}

async function cmdApprove(args) {
  const { service } = buildService();
  const decided = await service.decideApproval({
    run_id: args.run,
    org_id: args.org ?? REFERENCE_ORG,
    decision: args.reject ? 'reject' : 'approve',
    // Doctrine G4: the CLI records a HUMAN's decision. There is no flag that
    // makes this 'service', and the policy engine would refuse it if there were.
    actor: 'human',
    principal: args.by ?? null,
    principal_roles: args.role ? [args.role] : [],
    note: args.note ?? null,
  });
  console.log(JSON.stringify(decided, null, 2));
  return decided.ok ? 0 : 1;
}

async function cmdResume(args) {
  const { service } = buildService();
  const run = await service.resumeRun({ run_id: args.run, org_id: args.org ?? REFERENCE_ORG });
  if (run.ok === false) { console.error(JSON.stringify(run, null, 2)); return 1; }
  renderRun(run, { title: 'RESUME' });
  return run.state === 'completed' ? 0 : 1;
}

// The whole slice in one process, for a single reproducible command. Uses the
// same service and the same three calls the subcommands make.
async function cmdDemo(args = {}) {
  const ledger = createSyntheticLedger();
  // A run id is derived from the workflow, the inputs and the START INSTANT, so
  // a demo pinned to one instant produces the same run id every time — and now
  // that an identical submission is recognised as a duplicate, the second run
  // of the demo would replay the first one's journal and execute nothing. Each
  // invocation therefore gets its own instant unless `--start` pins one, which
  // is what a reproducible investigation wants.
  const start = typeof args.start === 'string' ? args.start : new Date().toISOString();
  const { service } = buildService({ ledger, start });

  console.log('### 1. discovery');
  await cmdWorkflows();

  console.log('\n### 2. start — resolve, authorize, validate context, run low-risk steps, pause on the consequential one');
  const started = await service.startRun({
    workflow_id: 'invoice_intake_approval',
    version: '^1.2.0',
    org_id: REFERENCE_ORG,
    context_items: referenceContextItems(),
  });
  renderRun(started, { title: 'START' });

  console.log('### 3. a service actor tries to approve its own work (doctrine G4)');
  const selfApproval = await service.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'service', principal: 'automation', principal_roles: ['owner'],
  });
  console.log(`   refused: ok=${selfApproval.ok} reason=${selfApproval.reason}`);

  console.log('\n### 4. another tenant tries to approve');
  const wrongTenant = await service.decideApproval({
    run_id: started.run_id, org_id: 'org_synthetic_beta', decision: 'approve',
    actor: 'human', principal: 'mallory', principal_roles: ['owner'],
  });
  console.log(`   refused: ok=${wrongTenant.ok} reason=${wrongTenant.reason}`);

  console.log('\n### 5. the named human approves');
  const decided = await service.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'human', principal: 'jack', principal_roles: ['owner'], note: 'PO-7741 matches',
  });
  console.log(`   ${JSON.stringify(decided)}`);

  console.log('\n### 6. resume — a separate service call');
  const resumed = await service.resumeRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  renderRun(resumed, { title: 'RESUME' });

  console.log('### 7. the synthetic ledger (the only "outside world" that exists)');
  console.log(`   drafts:       ${JSON.stringify(ledger.drafts())}`);
  console.log(`   instructions: ${JSON.stringify(ledger.instructions())}`);

  console.log('\n### 8. audit reconstruction — state rebuilt from the persisted journal alone');
  const rebuilt = service.getRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  console.log(`   state='${rebuilt.state}' events=${rebuilt.event_count} head=${rebuilt.journal_head}`);
  console.log(`   matches the in-memory projection: ${rebuilt.journal_head === resumed.journal_head}`);

  return resumed.state === 'completed' ? 0 : 1;
}

// --- main --------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'demo';

const COMMANDS = {
  workflows: cmdWorkflows,
  start: cmdStart,
  show: cmdShow,
  approve: cmdApprove,
  resume: cmdResume,
  demo: cmdDemo,
};

const handler = COMMANDS[command];
if (handler === undefined) {
  console.error(`unknown command '${command}'. Known: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(2);
}

try {
  process.exit(await handler(args));
} catch (e) {
  console.error(`control plane error [${e?.code ?? 'unknown'}]: ${e?.message ?? e}`);
  process.exit(1);
}
