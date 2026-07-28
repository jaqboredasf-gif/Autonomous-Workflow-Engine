import { invariant } from '../../awe-kernel/src/index.mjs';
import { createMemoryLayer } from '../../awe-memory/src/index.mjs';

/**
 * Transport-free application service for long-lived memory.
 *
 * Surfaces inject manifests, a version store, retrieval adapters and a clock.
 * The service never selects a tenant, storage backend or vector provider.
 */
export function createMemoryService(options = {}) {
  const layer = createMemoryLayer(options);
  return Object.freeze({
    proposeWrite: (request) => layer.proposeWrite(request),
    commitWrite: (request) => layer.commitWrite(request),
    retrieve: (request) => layer.retrieve(request),
    replay(snapshot, request) {
      invariant(request !== null && typeof request === 'object', 'invalid_input', 'memory replay needs { org_id }', {});
      return layer.replay(snapshot, request);
    },
    expire: (request) => layer.expire(request),
    describe: () => layer.describe(),
  });
}
