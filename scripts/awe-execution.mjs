#!/usr/bin/env node

import {
  createInMemoryExecutionRepository,
  createSequenceIdentifiers,
} from '../packages/awe-execution/src/index.mjs';
import {
  OPERATIONS_ORG,
  createDurableExecutionService,
  createDurableOperationsExecutor,
  createSyntheticEffectAdapter,
} from '../packages/awe-runtime/src/index.mjs';
import { createSteppingClock } from '../packages/awe-runtime/src/clock.mjs';

function options(argv) {
  const result = { command: argv[2] ?? 'demo', json: false, polls: 1 };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === '--json') result.json = true;
    else if (argv[index] === '--polls') {
      result.polls = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else throw new Error(`unknown argument '${argv[index]}'`);
  }
  if (!Number.isInteger(result.polls) || result.polls < 1 || result.polls > 100) {
    throw new Error('--polls must be an integer from 1 to 100');
  }
  return result;
}

function composition() {
  const clock = createSteppingClock({
    start: '2026-07-28T15:00:00.000Z',
    tick_ms: 5,
  });
  const repository = createInMemoryExecutionRepository();
  const ids = createSequenceIdentifiers({ prefix: 'durable_demo' });
  const service = createDurableExecutionService({ repository, clock, ids });
  return { clock, repository, ids, service };
}

async function demo() {
  const { clock, repository, service } = composition();
  const effectAdapter = createSyntheticEffectAdapter();
  const accepted = service.acceptJob({
    kind: 'agent',
    org_id: OPERATIONS_ORG,
    agent_id: 'operations_investigator',
    agent_version: '1.0.0',
    idempotency_key: 'durable-demo:case-1042',
    payload: { case_id: 'case_1042', synthetic: true },
    required_capabilities: ['agent'],
    priority_class: 'urgent',
  });
  const workerA = service.registerWorker({
    worker_id: 'worker_a',
    org_id: OPERATIONS_ORG,
    capabilities: ['agent'],
  });
  const executorA = createDurableOperationsExecutor({ clock, effectAdapter });
  const first = await service.createWorker({ worker: workerA, executor: executorA }).pollOnce();
  const paused = service.inspect({ run_id: accepted.run.run_id, org_id: OPERATIONS_ORG });

  service.signalApproval({
    wake_id: paused.wake.wake_id,
    org_id: OPERATIONS_ORG,
    action_digest: paused.wake.action_digest,
    decision: 'approve',
    actor: 'human',
    principal: 'operator_alex',
    principal_roles: ['operations_owner'],
  });
  service.tick({ org_id: OPERATIONS_ORG });

  // A new executor and worker represent the first runtime process terminating.
  // The only shared implementation is the fake provider adapter, whose stable
  // idempotency behavior models a provider that honors its key.
  const workerB = service.registerWorker({
    worker_id: 'worker_b',
    org_id: OPERATIONS_ORG,
    capabilities: ['agent'],
  });
  const executorB = createDurableOperationsExecutor({ clock, effectAdapter });
  const second = await service.createWorker({ worker: workerB, executor: executorB }).pollOnce();
  const completed = service.inspect({ run_id: accepted.run.run_id, org_id: OPERATIONS_ORG });
  const replay = service.replay({
    run_id: accepted.run.run_id,
    org_id: OPERATIONS_ORG,
    mode: 'control_decision_replay',
  });

  return {
    schema: 'awe.durable_execution_demo/v1',
    verdict: completed.run.state === 'completed'
      && effectAdapter.metrics().unique_effects === 1
      && replay.tools_invoked === 0
      && replay.models_invoked === 0
      ? 'PASS'
      : 'FAIL',
    run_id: completed.run.run_id,
    first_worker: first.status,
    paused_state: paused.run.state,
    checkpoint_id: paused.checkpoint.checkpoint_id,
    memory_snapshot_refs: paused.checkpoint.memory_snapshot_refs,
    approval_action_digest: paused.wake.action_digest,
    second_worker: second.status,
    final_state: completed.run.state,
    attempts: completed.attempts.length,
    effect_receipts: completed.effects,
    effect_adapter_calls: effectAdapter.metrics().calls.length,
    replay,
    event_count: completed.events.length,
    repository_digest: repository.snapshot().snapshot_digest,
  };
}

async function workerCommand(polls) {
  const { clock, service } = composition();
  const effectAdapter = createSyntheticEffectAdapter();
  const accepted = service.acceptJob({
    kind: 'agent',
    org_id: OPERATIONS_ORG,
    agent_id: 'operations_investigator',
    agent_version: '1.0.0',
    idempotency_key: 'bounded-worker:case-1042',
    payload: { case_id: 'case_1042', synthetic: true },
    required_capabilities: ['agent'],
  });
  const worker = service.registerWorker({
    worker_id: 'reference_worker',
    org_id: OPERATIONS_ORG,
    capabilities: ['agent'],
  });
  const runtime = service.createWorker({
    worker,
    executor: createDurableOperationsExecutor({ clock, effectAdapter }),
  });
  const results = [];
  for (let index = 0; index < polls; index += 1) results.push(await runtime.pollOnce());
  runtime.stop();
  return {
    schema: 'awe.bounded_worker_run/v1',
    run_id: accepted.run.run_id,
    polls,
    results: results.map((entry) => entry.status),
    worker_status: runtime.status(),
    final_state: service.inspect({ run_id: accepted.run.run_id, org_id: OPERATIONS_ORG }).run.state,
  };
}

function render(value) {
  console.log(`AWE Durable Execution Plane: ${value.verdict ?? 'bounded worker'}`);
  console.log(`run: ${value.run_id}`);
  if (value.paused_state) console.log(`pause: ${value.paused_state} at ${value.checkpoint_id}`);
  if (value.final_state) console.log(`final: ${value.final_state}`);
  if (value.effect_adapter_calls !== undefined) console.log(`external effect adapter calls: ${value.effect_adapter_calls}`);
  if (value.replay) console.log(`replay: ${value.replay.classification}, tools=${value.replay.tools_invoked}, models=${value.replay.models_invoked}`);
  if (value.results) console.log(`poll results: ${value.results.join(', ')}`);
}

const parsed = options(process.argv);
const output = parsed.command === 'demo'
  ? await demo()
  : parsed.command === 'worker'
    ? await workerCommand(parsed.polls)
    : parsed.command === 'describe'
      ? composition().service.describe()
      : (() => { throw new Error(`unknown command '${parsed.command}'`); })();

if (parsed.json) console.log(JSON.stringify(output, null, 2));
else render(output);
