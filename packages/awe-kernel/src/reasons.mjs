// ---------------------------------------------------------------------------
// reasons.mjs — the blocked-reason registry.
//
// Fail-closed is the platform's default: when a workflow refuses to act it must
// say WHY, using a value from a fixed vocabulary, never free text. Those
// vocabularies already exist per module (route/gate reasons in the approval
// matrix, guard reasons in the approval queue, and one per future workflow) and
// they leak into SQL, into the UI, and into evidence reports.
//
// The registry makes the union checkable:
//   * one reason string never means two different things in two namespaces
//     (that is a `vocabulary_conflict`) unless it is DECLARED shared;
//   * a reason emitted by any workflow is a member of some vocabulary
//     (otherwise `unknown_reason`);
//   * coverage gates can ask "which reasons has no fixture ever produced?".
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { KernelError, invariant } from './errors.mjs';

const REASON_PATTERN = /^[a-z][a-z0-9_]*$/;

export function isValidReason(reason) {
  return typeof reason === 'string' && REASON_PATTERN.test(reason) && reason.length <= 64;
}

export function createReasonRegistry({ shared = [] } = {}) {
  // reason -> Set(namespace); namespace -> ordered reason list.
  const owners = new Map();
  const namespaces = new Map();
  const sharedReasons = new Set(shared);

  for (const r of sharedReasons) {
    invariant(isValidReason(r), 'invalid_input', `shared reason '${r}' is not snake_case`, { reason: r });
  }

  function register(namespace, reasons) {
    invariant(
      typeof namespace === 'string' && namespace.length > 0,
      'invalid_input', 'namespace must be a non-empty string', { namespace },
    );
    invariant(
      !namespaces.has(namespace),
      'vocabulary_conflict', `namespace '${namespace}' is already registered`, { namespace },
    );
    invariant(Array.isArray(reasons), 'invalid_input', `reasons for '${namespace}' must be an array`, { namespace });

    const local = [];
    for (const reason of reasons) {
      invariant(
        isValidReason(reason),
        'invalid_input', `reason '${reason}' in '${namespace}' must be snake_case, <= 64 chars`,
        { namespace, reason },
      );
      invariant(
        !local.includes(reason),
        'vocabulary_conflict', `reason '${reason}' is listed twice in '${namespace}'`,
        { namespace, reason },
      );

      const existing = owners.get(reason);
      if (existing && !sharedReasons.has(reason)) {
        throw new KernelError(
          'vocabulary_conflict',
          `reason '${reason}' is claimed by both '${[...existing].join(', ')}' and '${namespace}'. `
          + 'Either rename one, or declare it shared when constructing the registry.',
          { reason, namespaces: [...existing, namespace] },
        );
      }
      if (existing) existing.add(namespace);
      else owners.set(reason, new Set([namespace]));
      local.push(reason);
    }
    namespaces.set(namespace, Object.freeze(local));
    return local;
  }

  function has(reason) {
    return owners.has(reason);
  }

  // Membership guard for anything about to be reported as a blocked reason.
  function assert(reason, context = {}) {
    invariant(
      owners.has(reason),
      'unknown_reason',
      `blocked reason '${reason}' is not in any registered vocabulary`,
      { reason, ...context, known: all() },
    );
    return reason;
  }

  function namespacesOf(reason) {
    return [...(owners.get(reason) ?? [])].sort();
  }

  function all() {
    return [...owners.keys()].sort();
  }

  function ofNamespace(namespace) {
    const list = namespaces.get(namespace);
    invariant(list !== undefined, 'invalid_input', `namespace '${namespace}' is not registered`, { namespace });
    return list;
  }

  function listNamespaces() {
    return [...namespaces.keys()].sort();
  }

  // Reasons registered but never exercised — the input to a coverage gate.
  function uncovered(seen) {
    const seenSet = seen instanceof Set ? seen : new Set(seen ?? []);
    return all().filter((r) => !seenSet.has(r));
  }

  // Reasons that legitimately live in more than one namespace, for reporting.
  function sharedInUse() {
    return all().filter((r) => owners.get(r).size > 1);
  }

  return Object.freeze({
    register, has, assert, all, ofNamespace, listNamespaces,
    namespacesOf, uncovered, sharedInUse,
  });
}
