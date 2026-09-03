// ---------------------------------------------------------------------------
// store-selection.mjs — which durable store a surface gets, decided in ONE place.
//
// Without this, every caller that wanted a durable run would grow its own
// three-way `if`, and the three would drift: one would default to Postgres, one
// would fall back to memory when a URL was missing, and the one that fell back
// would be the one running the payment workflow.
//
// THREE BACKENDS, and the differences are guarantees, not preferences:
//
//   memory    single process. No durability at all. Correct for unit tests and
//             for a one-shot CLI; a lie for anything with two workers.
//   file      survives a process exit. Cross-process exclusion for the FIRST
//             acquisition of a lease (atomic `open(wx)`), but expired-lease
//             takeover and the journal compare-and-set are read-then-write.
//   postgres  durable and genuinely atomic. Row locks and conditional updates,
//             so no window exists for two writers to both win.
//
// THE DEFAULT IS `memory`, AND IT IS THE SAFE DEFAULT rather than the timid one.
// A caller that has configured nothing gets a store that makes no durability
// claim and cannot be mistaken for one. The dangerous default would be silently
// falling back to memory when Postgres was ASKED FOR and unavailable — a worker
// would then run happily with no cross-process exclusion and no record. So:
// asking for `postgres` without an executor is a THROW, never a downgrade.
//
// `AWE_STORE_BACKEND` is read only when a caller passes no explicit backend, and
// only through the `env` argument, which the caller supplies. This module reads
// no ambient `process.env` of its own.
// ---------------------------------------------------------------------------

import { createFileJournalStore, createMemoryJournalStore } from './journal-store.mjs';
import { DEFAULT_LEASE_TTL_MS, createFileLeaseStore, createMemoryLeaseStore } from './lease-store.mjs';
import { createFileResultStore, createMemoryResultStore } from './result-store.mjs';
import { createPostgresJournalStore } from './postgres/journal-store.mjs';
import { createPostgresLeaseStore } from './postgres/lease-store.mjs';
import { createPostgresResultStore } from './postgres/result-store.mjs';

export const STORE_BACKENDS = Object.freeze(['memory', 'file', 'postgres']);

const GUARANTEES = Object.freeze({
  memory: Object.freeze({ durable: false, cross_process: false, atomic_takeover: false }),
  file: Object.freeze({ durable: true, cross_process: true, atomic_takeover: false }),
  postgres: Object.freeze({ durable: true, cross_process: true, atomic_takeover: true }),
});

/**
 * selectStores({ backend, executor, org_id, root, ttl_ms, env })
 *   -> { backend, journals, leases, results, guarantees }
 *
 * The returned object is what a caller spreads into `createControlPlaneService`.
 * `guarantees` travels with it so a surface can REPORT what it actually has
 * rather than what its README claims — `crossProcessLeases` on the service is
 * already derived from the store, and this is the same idea one level up.
 */
export function selectStores({
  backend = null,
  executor = null,
  org_id = null,
  root = 'artifacts',
  ttl_ms = DEFAULT_LEASE_TTL_MS,
  env = {},
} = {}) {
  const chosen = backend ?? env.AWE_STORE_BACKEND ?? 'memory';

  if (!STORE_BACKENDS.includes(chosen)) {
    throw new Error(
      `selectStores: unknown store backend '${chosen}' — expected one of ${STORE_BACKENDS.join(', ')}`,
    );
  }

  if (chosen === 'postgres' && executor === null) {
    // The one refusal that matters. Downgrading here would hand a worker the
    // in-memory store while it believed it had a durable one, and the failure
    // would surface as a duplicated side effect rather than as a missing config.
    throw new Error(
      'selectStores: backend \'postgres\' needs an injected executor (createSupabaseRpcExecutor or a conformance transport). '
      + 'It will not silently fall back to an in-memory store — see ADR-0010.',
    );
  }

  if (chosen === 'postgres') {
    return Object.freeze({
      backend: chosen,
      guarantees: GUARANTEES.postgres,
      journals: createPostgresJournalStore({ executor, org_id }),
      leases: createPostgresLeaseStore({ executor, ttl_ms, org_id }),
      results: createPostgresResultStore({ executor, org_id }),
    });
  }

  if (chosen === 'file') {
    return Object.freeze({
      backend: chosen,
      guarantees: GUARANTEES.file,
      journals: createFileJournalStore({ root }),
      leases: createFileLeaseStore({ root, ttl_ms }),
      results: createFileResultStore({ root }),
    });
  }

  return Object.freeze({
    backend: chosen,
    guarantees: GUARANTEES.memory,
    journals: createMemoryJournalStore(),
    leases: createMemoryLeaseStore({ ttl_ms }),
    results: createMemoryResultStore(),
  });
}
