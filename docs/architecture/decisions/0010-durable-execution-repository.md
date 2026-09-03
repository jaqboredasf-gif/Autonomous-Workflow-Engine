# ADR-0010 — The durable execution repository: four tables, eleven functions, one asynchronous port

**Status:** Accepted (2026-07-28) for the repository and the adapter. The
migration itself is **written, validated against a real PostgreSQL 17, and NOT
APPLIED** to the live project — that remains a human-gated action, as with 0016.

## Context

`packages/awe-runtime/src/{journal,lease,result}-store.mjs` each end their header
with the same promise: *"the successor is a table, and it is ADR-0002."* Three
things forced the promise to be kept now rather than later.

**1. The existing stores document their own holes.** `journal-store.mjs`: the
file compare-and-set "is read-compare-rename, so a sufficiently unlucky pair of
writers can still interleave inside the window." `lease-store.mjs`: "TAKING OVER
AN EXPIRED LEASE IS NOT ATOMIC… Two workers can both observe the same expired
lease and both rename, and the second rename wins." Both are true, both are
honestly stated, and both are unfixable on a filesystem.

**2. Nothing held the stores to a contract.** Each implementation was exercised
only incidentally, through the control-plane service. That let a real defect sit
in plain sight: `result-store.mjs` tenant-checked the READ and not the WRITE, so
a second tenant writing the same derived run id replaced the first tenant's step
outputs. Nothing caught it because the service never writes results for a run it
does not own — an invariant that holds until something else calls the store.

**3. The environment changed.** `scripts/lib/validate-migration-0015.mjs` opens
with "this environment has no psql / supabase CLI / docker". Docker is now
present with a local `postgres:17` image, which turns a class of question from
unanswerable into routine: *does `FOR UPDATE` actually serialize two writers, or
does it merely look like it does?*

## Decision

### D1 — Four tables, and no `state` column

`awe_run_journals` (identity, tenant, chain head), `awe_run_journal_entries`
(the append-only hash-chained history), `awe_run_leases`, `awe_run_results`.

**Run state is not stored anywhere.** `journal.mjs` says "there is no stored
`state` column anywhere in this package for it to disagree with", and the
database is not an exception to that. A `state` column would be indexable,
convenient, and free to contradict the history it was derived from. State stays a
projection of the entries, computed on every read, in one place.

The direct cost is accepted and named: **there is no efficient "claim the next
runnable run" query**, because there is no column to index for it. Nothing in the
runtime pulls work that way today. When something does, the answer is a
projection table maintained *by* the event log with its own consistency
story — not a mutable status field on the run.

### D2 — The database supplies atomicity, never rules

Every state transition, the hash chain, the projection, and
claim/renew/steal/expire/fence stay pure in `awe-control-plane/src/{journal,lease}.mjs`.
The SQL adds exactly one thing: a compare-and-set two concurrent workers cannot
both win.

- `awe_journal_write` takes the row lock, applies the same three-way
  `expected_head` semantics the in-memory store already had, and appends only
  entries beyond the stored count.
- `awe_lease_acquire` is handed a lease record `evaluateClaim` already decided,
  plus the fence the caller read, and answers only *did that decision win*.

The SQL does assert two SAFETY invariants, which is different from restating a
rule: a live lease cannot be taken from another holder, and an appended entry
must chain to the stored head. Those must hold whatever a caller believes.

### D3 — Eleven functions are the entire surface

The adapter knows one method: `call(fn, payload)`. No SQL, no table name, no
column, no connection string crosses that line. Consequences:

- `@exattime/awe-runtime` still depends on **no database driver** and holds no
  credential, no URL and no connection. The transport is injected, like the
  clock and the artifact sink.
- The same adapter runs over PostgREST in a deployment and over `psql` in a
  container during conformance, so the code under test is the code that ships.
- **ADR-0002's Path C is now demonstrated rather than planned.** Every function
  is `SECURITY DEFINER` with `search_path = ''`, `EXECUTE` revoked from `PUBLIC`
  before it is granted to anything. The conformance suite creates a role holding
  *only* `EXECUTE` on the eleven — no `SELECT`, no `INSERT`, no table privilege —
  and the adapter passes its entire contract as that role while being refused
  every direct table access. Path C needs a credential, not a redesign.

### D4 — RLS on, zero client policies

The G2 shape 0009 uses for `integration_events` and 0016 had to restore after 16
undeclared policies were found live. An `authenticated` user who can `INSERT`
into `awe_run_journal_entries` can forge an approval. If a browser surface ever
needs to see a run, that is a narrow, role-gated, **read-only** policy in a new
migration with its own review.

Append-only is enforced by trigger, not by adapter discipline: `UPDATE` and
`DELETE` on a journal entry are refused **for a superuser**, and the suite proves
it by trying.

### D5 — `org_id` is `text` and does not reference `orgs`

The control plane's tenant identifier is an opaque string from the kernel
execution context; `org_synthetic_alpha` is a real, first-class one. A `uuid`
foreign key to `orgs` would couple the execution substrate to one product's
tenant table and make the reference workflow unrunnable.

Cross-tenant *references* are still impossible: an entry carries `(run_id,
org_id)` and is bound to its run by a composite foreign key. Mapping control-plane
tenant ids to `orgs.id` is a separate concern and is not invented here.

### D6 — The store port becomes `T | Promise<T>`, and the service reads become async

**This is a port change, and it needed evidence.** The conformance suite provided
it: no database client is synchronous, and a synchronous `read()` is a promise
that the store is a `Map`.

The change is the minimum that works. The service `await`s every store call;
`await` on a plain value is a no-op, so the memory and file stores did not change
at all. `getRun`, `getTimeline`, `getJournalDocument`, `listRuns`, `getLease`,
`listLeases` and `expireLeases` became `async`. Every existing caller was already
inside an `async` function, so the cost was `await` at eleven call sites across
`mcp-server`, the operator CLI and Runner P. Runner P went from 564 to 568
assertions, all passing.

`listRuns`, `listLeases` and `expireLeases` also gained an optional `org_id`, so
a multi-tenant surface pushes the tenant DOWN to the store instead of listing
every run id in the database and filtering in JavaScript.

### D7 — `selectStores` is the only place a backend is chosen, and the default is `memory`

Asking for `postgres` without an executor **throws**. It does not fall back.
A silent downgrade would leave a worker running with no cross-process exclusion
while believing it had some, and the failure would surface as a duplicated
payment rather than as a missing environment variable.

### D8 — The service takes an UNBOUND journal store

A tenant-bound store filters reads, which would collapse `approval_tenant_mismatch`
into `approval_unknown` and remove `startRun`'s ability to tell "your identical
resubmission" from "another tenant already derived this run id". The service is
multi-tenant and checks the tenant itself on every operation. Binding is for a
single-tenant surface, where the distinction cannot arise.

## Alternatives considered

- **A `state` column with an index, for work-queue scanning.** Rejected: it is
  the one thing `journal.mjs` says must not exist, and the need is hypothetical.
  Named as a non-goal instead of half-built.
- **Restating the lease rules in SQL** so a claim is one round trip. Rejected: a
  second source of truth for the fence, drifting from the first the day either
  changes. The read-decide-conditional-write costs one extra round trip and keeps
  one implementation of the rules.
- **Reassembling the lease record from typed columns on read.** Rejected after
  it was nearly shipped: `assertRunLease` re-derives the digest over the record's
  own bytes, so a single `...:00Z` rendered back as `...:00.000Z` fails its own
  digest and takes the run down. The record is stored verbatim in `lease_record`
  *and* in typed columns, with check constraints making it impossible for the two
  to disagree.
- **Keeping the ports synchronous** and giving the Postgres adapter a
  synchronous transport. Rejected: it would work only for `psql` in a container
  and never for PostgREST, i.e. it would work only in the test.
- **A static SQL lint, as for 0014 and 0015.** Rejected as insufficient rather
  than wrong. A lint cannot answer whether eight parallel writers produce one
  winner. The lints stay for the migrations they cover; 0017 is validated by
  application to a real server.

## Consequences

**Operationally exact:**
- No new credential. A deployment injects an existing `supabase-js` client into
  `createSupabaseRpcExecutor`. `AWE_STORE_BACKEND` is read only through an
  explicitly passed `env`, never ambiently.
- Runner D (`scripts/eval-durable-store.sh`) is registered as an `offline` suite:
  it declares no credentials, contacts no live project, and creates and destroys
  its own container. Without Docker it runs the conformance half and reports the
  database gates as SKIP — loudly, with a closing NOTE, because a suite that
  quietly drops its hardest half is worse than one that fails.
- Runner D costs roughly 60-90s wall time when Docker is present.

**Defects this work found and fixed:**
1. The result stores' unchecked cross-tenant WRITE (all three implementations).
2. The journal stores replaced the whole document, so a writer at the current
   head could commit a REWRITTEN prefix and the chain would still verify. Both
   in-process stores now refuse a shrink or a rewrite.
3. `awe_journal_write`'s create path was not serialized — `SELECT … FOR UPDATE`
   locks nothing when the row does not exist, so eight parallel creators all
   passed the compare-and-set and seven hit a unique-violation *error* instead of
   an orderly refusal. Found by the parallel race, not by review. Fixed with
   `ON CONFLICT DO NOTHING` and a re-decision against the winner's row.
4. `cancelRun` was left with an unawaited `claim()` during the port change; a
   promise is truthy, so every cancellation would have reported "not claimed".
   Caught by Runner P immediately.

**Security impact:**
- Execution history is unreachable from a browser session: RLS on, no policy, no
  table grant to `anon` or `authenticated`, and `EXECUTE` on none of the eleven.
- Append-only survives a superuser.
- The service role still bypasses RLS (ADR-0002 stands), so tenant safety in the
  adapter is code-enforced — and now conformance-enforced, on every store,
  including the two that had a hole.

## Reversal strategy

`scripts/rollback-migration-0017.sql` drops the eleven functions, then the tables
child-first, then the trigger guards, with no `CASCADE` anywhere and
post-conditions that abort if anything remains. Verified on a real server:
applied, rolled back, replayed, and 0017 re-applied on top. It is **destructive of
execution history** — dump the four tables first.

Reverting the *code* is `selectStores({ backend: 'memory' })`, which is already
the default. The async port change is not reverted; it costs nothing to the
in-process stores.

## Related

ADR-0002 (conditions 1, 2 and 4 — explicit tenant binding, no hard-coded refs,
Path C as the documented successor) · migration 0016 (why zero client policies) ·
migration 0009 (the G2 service-role-only shape) · Runner D · Runner P.
