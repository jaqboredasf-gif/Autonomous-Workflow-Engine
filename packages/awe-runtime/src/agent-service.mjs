import { invariant } from '../../awe-kernel/src/index.mjs';
import { createAgentRuntime } from '../../awe-agent-runtime/src/index.mjs';

/**
 * Application-service surface for autonomous runs.
 *
 * CLI workers, MCP tools, scheduled jobs and future HTTP routes call this
 * service rather than owning an agent loop. The underlying runtime stays
 * transport-free and receives every provider/effect boundary by injection.
 */
export function createAgentService(options = {}) {
  const runtime = createAgentRuntime(options);
  return Object.freeze({
    submit: (request) => runtime.run(request),
    replay: (transcript) => runtime.replay(transcript),
    inspect(request) {
      invariant(request !== null && typeof request === 'object', 'invalid_input', 'inspect needs { run_id, org_id }', {});
      return runtime.inspect(request);
    },
    list(request) {
      invariant(request !== null && typeof request === 'object', 'invalid_input', 'list needs { org_id }', {});
      return runtime.list(request);
    },
    describe: () => runtime.describe(),
  });
}
