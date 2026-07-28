#!/usr/bin/env node
// Offline operator/example CLI for the Agent Runtime. It reaches fixture
// adapters only; there is no provider, database, credential or production mode.

import {
  createOperationsAgentFixture, createSteppingClock, operationsRunRequest,
} from '../packages/awe-runtime/src/index.mjs';

const command = process.argv[2] ?? 'demo';
if (!['demo', 'describe'].includes(command)) {
  process.stderr.write('usage: node scripts/awe-agent-runtime.mjs [demo|describe]\n');
  process.exit(2);
}

const { service, calls } = createOperationsAgentFixture({
  clock: createSteppingClock(),
});

if (command === 'describe') {
  process.stdout.write(`${JSON.stringify(service.describe(), null, 2)}\n`);
  process.exit(0);
}

const result = await service.submit(operationsRunRequest());
const replay = service.replay(result.transcript);
process.stdout.write(`${JSON.stringify({
  schema: 'awe.agent_runtime_demo/v1',
  status: result.outcome.status,
  final_state: result.final_state,
  result: result.outcome.data?.result ?? null,
  agent: result.outcome.data?.agent ?? null,
  budgets: result.projection.counts,
  tool_calls: calls.map((call) => ({ tool: call.tool, org_id: call.org_id })),
  transcript: {
    entry_count: result.transcript.entry_count,
    head_digest: result.transcript.head_digest,
    transcript_digest: result.transcript.transcript_digest,
  },
  replay,
  persisted: result.persistence.ok,
}, null, 2)}\n`);
