// ---------------------------------------------------------------------------
// postgres/journal-store.mjs — the durable run journal.
//
// This is the successor `journal-store.mjs` names in its own header, and the
// difference is one sentence long: its compare-and-set is read-compare-rename
// and "a sufficiently unlucky pair of writers can still interleave inside the
// window"; this one's is a `SELECT ... FOR UPDATE` inside a single SQL function,
// so the window does not exist. Two workers committing to the same run reach the
// same row lock, one proceeds, the other reads the winner's head and is refused.
//
// WHAT THIS ADAPTER DOES NOT DO, deliberately:
//   * it does not decide anything. Transitions, the chain and the projection are
//     `awe-control-plane/src/journal.mjs` and stay there.
//   * it does not trust the database. Every document that comes back is put
//     through `loadRunJournal`, which re-derives the document digest and
//     re-verifies every link of the hash chain. A row edited in place by
//     somebody with a psql prompt fails HERE, before it can be resumed.
//   * it does not widen access. A store bound to a tenant refuses to read, write
//     or list anything else, and says the same thing for "no such run" as for
//     "not your run".
//
// TENANT BINDING IS A CONSTRUCTION ARGUMENT.
//   createPostgresJournalStore({ executor, org_id: 'org_a' })  tenant-bound
//   createPostgresJournalStore({ executor })                   operator view
// The second is for an operator CLI reading one machine's own runs, and it is
// the same distinction `listWorkflows({ org_id })` already draws. Anything
// serving more than one tenant passes the tenant.
//
// EVERY METHOD IS ASYNC. See ADR-0010: the store port became "T or Promise<T>"
// because no database client is synchronous, and `await` on a plain value is a
// no-op, so the memory and file stores did not change at all.
// ---------------------------------------------------------------------------

import { KernelError } from '../../../awe-kernel/src/index.mjs';
import { loadRunJournal } from '../../../awe-control-plane/src/index.mjs';
import { assertExecutor } from './executor.mjs';

const SCHEMA = 'awe.run_journal/v1';

/**
 * The read-side gate. Everything the database returns passes through here
 * before it is a domain object, and anything that does not survive is a
 * `contract_violation` rather than a value the control plane then acts on.
 *
 * `loadRunJournal` is the expensive part and it is not skipped: a journal whose
 * digest or chain does not verify is precisely the case this exists to catch,
 * and catching it at the store means the caller never sees a half-trustworthy
 * history it might resume.
 */
function validateDocument(payload, { run_id, org_id }) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new KernelError('contract_violation', `journal store returned a non-object for run '${run_id}'`, { run_id });
  }
  if (payload.schema !== SCHEMA) {
    throw new KernelError('contract_violation', `journal store returned schema '${payload.schema}' for run '${run_id}'`, { run_id });
  }
  if (payload.run_id !== run_id) {
    throw new KernelError('contract_violation', `journal store returned run '${payload.run_id}' when asked for '${run_id}'`, { run_id, returned: payload.run_id });
  }
  // Belt and braces over the SQL filter. The function already refuses to return
  // another tenant's run; this refuses to ACCEPT one, so a future change to
  // either side alone cannot open a cross-tenant read.
  if (org_id !== null && payload.org_id !== org_id) {
    throw new KernelError('contract_violation', `journal store returned tenant '${payload.org_id}' for a store bound to '${org_id}'`, { run_id });
  }
  // Digest, then the whole chain. Throws contract_violation on any tampering.
  loadRunJournal(payload);
  return payload;
}

export function createPostgresJournalStore({ executor, org_id = null } = {}) {
  assertExecutor(executor, 'createPostgresJournalStore');

  return Object.freeze({
    kind: 'journal_store',
    name: 'postgres',
    durable: true,
    cross_process: true,
    org_id,

    /**
     * write(document, { expected_head })
     *
     * The three-way compare-and-set is unchanged from the in-memory contract and
     * is implemented by `awe_journal_write`:
     *   undefined — no check (a caller that has not opted in)
     *   null      — the run must NOT already be stored
     *   '<digest>'— the stored head must be exactly this
     *
     * A conflict comes back as DATA. An infrastructure failure comes back as a
     * thrown `StoreUnavailableError`, and the difference matters: the first means
     * "somebody else got there first, re-read and decide"; the second means "we
     * do not know whether anything happened", and a caller that treated them
     * alike would retry a payment instruction on a dead socket.
     */
    async write(document, { expected_head } = {}) {
      if (document === null || typeof document !== 'object') {
        throw new KernelError('invalid_input', 'a journal write needs a journal document', {});
      }
      if (org_id !== null && document.org_id !== org_id) {
        return Object.freeze({
          ok: false,
          ref: null,
          reason: 'journal_write_conflict',
          error: `run '${document.run_id}' belongs to another tenant`,
          conflict: { expected: expected_head ?? null, actual: null },
        });
      }
      const payload = { document };
      // Key PRESENCE is the signal, exactly as in the memory store: an absent
      // `expected_head` means no check, an explicit null means "must not exist".
      if (expected_head !== undefined) payload.expected_head = expected_head;

      const result = await executor.call('awe_journal_write', payload);
      if (result === null || typeof result !== 'object') {
        throw new KernelError('contract_violation', 'awe_journal_write returned no verdict', { run_id: document.run_id });
      }
      return Object.freeze({
        ok: result.ok === true,
        ref: result.ref ?? null,
        reason: result.reason ?? null,
        error: result.error ?? null,
        ...(result.conflict ? { conflict: result.conflict } : {}),
      });
    },

    /**
     * read(run_id, { org_id }) -> document | null
     *
     * The per-call tenant is intersected with the store's binding rather than
     * replacing it, so a bound store can never be talked into reading somebody
     * else's run by an argument.
     */
    async read(run_id, { org_id: callerOrg = null } = {}) {
      const tenant = org_id ?? callerOrg;
      if (org_id !== null && callerOrg !== null && callerOrg !== org_id) return null;
      const payload = await executor.call('awe_journal_read', {
        run_id,
        ...(tenant === null ? {} : { org_id: tenant }),
      });
      return validateDocument(payload, { run_id, org_id: tenant });
    },

    /** list({ org_id }) -> run ids, sorted, for this tenant only. */
    async list({ org_id: callerOrg = null } = {}) {
      const tenant = org_id ?? callerOrg;
      const rows = await executor.call('awe_journal_list', tenant === null ? {} : { org_id: tenant });
      if (!Array.isArray(rows)) {
        throw new KernelError('contract_violation', 'awe_journal_list returned a non-array', {});
      }
      return rows;
    },
  });
}
