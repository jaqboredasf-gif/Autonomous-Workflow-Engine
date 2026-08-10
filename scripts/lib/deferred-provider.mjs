// ---------------------------------------------------------------------------
// deferred-provider.mjs — a provider that answers LATER.
//
// WHY THIS EXISTS
// The local repositories are async in signature but resolve in the same tick,
// so a missing `await` is invisible: the value is already there by the time
// anything looks at it. Against Supabase it will not be, and the failure will
// be a promise rendered as `[object Promise]` or an undefined field in
// production rather than a red test here.
//
// This wraps a composed purchasing context so every repository and port method
// resolves on a LATER macrotask. Nothing else changes. Run the existing
// integration suite through it and any call site that forgot to await stops
// working — which is the point.
//
// It is a test instrument, not a provider anyone ships.
// ---------------------------------------------------------------------------

/** The context members that represent persistence or an external boundary. */
const DEFERRED_MEMBERS = [
  'requests', 'reviews', 'approvals', 'orders', 'drafts', 'receipts', 'inventory',
  'reference', 'catalog', 'history', 'poNumbers', 'identity', 'audit', 'notifications', 'documents',
  'attachments', 'auth',
];

/** Members that are computation, not persistence: they stay immediate. */
const IMMEDIATE_MEMBERS = ['clock', 'renderer', 'email', 'uow'];

const later = () => new Promise((resolve) => setImmediate(resolve));

function deferObject(target, onCall) {
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop);
      if (typeof value !== 'function') return value;
      return async (...args) => {
        // Yield to the macrotask queue BEFORE doing the work, so anything that
        // used the result without awaiting is holding a pending promise.
        await later();
        onCall?.(prop);
        return value.apply(obj, args);
      };
    },
  });
}

/**
 * Wrap a composed context so persistence answers on a later tick.
 *
 * @param {object} ctx a PurchasingContext
 * @returns {{context: object, calls: () => number}}
 */
export function deferContext(ctx) {
  let calls = 0;
  const deferred = { ...ctx };

  for (const member of DEFERRED_MEMBERS) {
    if (!ctx[member]) continue;
    deferred[member] = deferObject(ctx[member], () => { calls += 1; });
  }
  for (const member of IMMEDIATE_MEMBERS) {
    if (ctx[member]) deferred[member] = ctx[member];
  }

  // The unit of work must still wrap the ORIGINAL work, and its callback now
  // awaits deferred repositories — which is exactly the interleaving hazard the
  // local implementation serializes against. Keeping the real one here means
  // the serialization is under test too.
  deferred.uow = ctx.uow;

  return { context: deferred, calls: () => calls };
}
