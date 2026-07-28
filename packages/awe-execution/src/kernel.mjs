// The execution package has one dependency seam. Provider/storage/runtime
// implementations remain above this package.
export {
  canonicalClone,
  canonicalJson,
  createEvent,
  deepFreeze,
  digest,
  invariant,
  isInstant,
  isPlainObject,
  redact,
} from '../../awe-kernel/src/index.mjs';
