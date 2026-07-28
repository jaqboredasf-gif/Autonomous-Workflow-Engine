// The Memory Layer has one dependency seam: the deterministic AWE kernel.
// Keeping the import in one module makes the layering rule mechanically visible.
export {
  CONTEXT_ITEM_KINDS,
  CONTEXT_SENSITIVITIES,
  canonicalClone,
  createContextItem,
  deepFreeze,
  digest,
  invariant,
  isInstant,
  isPlainObject,
  instantEpochSeconds,
  redact,
  sensitivityRank,
} from '../../awe-kernel/src/index.mjs';
