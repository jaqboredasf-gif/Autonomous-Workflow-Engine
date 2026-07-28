# AWE Memory Layer

**Status:** implemented and verified offline.
**Scope:** synthetic TEST data only; no database, vector provider, model
provider, migration, credential, deployment, or production configuration.

## Purpose

The Memory Layer is AWE's durable-contract boundary for facts that must survive
one agent run. It does not add an ambient global memory to the model. It makes
every long-lived fact an explicit, tenant-bound, versioned record with
provenance and retention, and makes every retrieval a replayable data record.

```
@exattime/awe-kernel
  Context Items · canonical digests · tenant execution context
                         ▲
                         │
@exattime/awe-memory
  manifests · records · write proposals · version store
  retrieval adapters · snapshots · context materialization
                         ▲
                         │
@exattime/awe-runtime
  Memory Service
                         ▲
                         │
      Agent Runtime · MCP · web · workers · scheduler · n8n
```

The package imports only the kernel. It contains no network client, filesystem
access, ambient clock, database driver, vector SDK, model SDK, environment
access, or dependency on the Agent Runtime. Storage, lexical/vector retrieval,
and time are injected.

## Contracts

| Contract | Schema |
|---|---|
| Memory Manifest | `awe.memory_manifest/v1` |
| Memory Record | `awe.memory_record/v1` |
| Write Proposal | `awe.memory_write_proposal/v1` |
| Write Authorization | `awe.memory_write_authorization/v1` |
| Retrieval Query | `awe.memory_query/v1` |
| Retrieval Snapshot | `awe.memory_retrieval_snapshot/v1` |

All public documents use closed key sets, runtime validation, canonical
serialization, content digests, and immutable returned values.

## Memory manifests

A manifest versions the operating contract for one memory collection:

- exact tenant scope;
- lifecycle (`draft`, `active`, `deprecated`, or `retired`);
- Context Item kind, source, trust, priority, and sensitivity ceiling;
- write mode and named approver roles;
- permitted retention classes and maximum TTL;
- provider-neutral retrieval profile, result ceiling, and score floor.

There is deliberately no automatic write mode. A manifest either disables
writes or requires a human approval. An agent may narrow this contract by not
using memory; it cannot widen tenant scope, retention, sensitivity, retrieval,
or write authority.

## Records and provenance

A record is immutable and uses an integer version chain. Version one
supersedes nothing; every later version must supersede exactly its immediate
predecessor. The in-memory reference store uses optimistic comparison-and-swap,
so two proposals made against one version cannot silently overwrite each other.

Every record carries:

- `memory_id`, `record_id`, `version`, and `org_id`;
- redacted content plus a separate content digest;
- sensitivity and retention class;
- creation and optional expiry instants;
- closed provenance (`source_type`, `source_ref`, `run_id`, `captured_at`,
  and actor);
- predecessor version, metadata, and a complete record digest.

The reference retention classes are `ephemeral`, `standard`, and `legal_hold`.
Legal holds cannot expire. Other classes require an expiry inside the
manifest's TTL ceiling. Expired records are unavailable to reads and retrieval.

## Write path

```
candidate fact
     │
     ▼
validate manifest + tenant + sensitivity + retention
     │
     ▼
immutable proposal (no write)
     │
     ▼
control-plane write tool
     │
     ├── no valid human approval ──► blocked, adapter not called
     │
     ▼
authorization bound to proposal digest, tenant, principal and role
     │
     ▼
optimistic version commit
```

`proposeWrite()` never persists. `commitWrite()` requires a human authorization
whose digest binding, tenant, actor, decision, principal, and role satisfy the
manifest. Runner Y also places the commit behind the existing controlled tool
dispatcher and proves the adapter is not reached before the existing approval
engine accepts the decision.

Authentication remains the responsibility of the calling surface. The
authorization document is evidence consumed after that surface and the control
plane have authenticated and evaluated the human; it is not an identity
provider.

## Retrieval and replay

Retrieval profiles are names such as `lexical_default`, never vendor names.
An adapter declares only `lexical` or `vector` and implements:

```
search({ validated query, tenant-filtered candidate records })
  -> [{ record_id, version, score }]
```

The layer validates that every hit references a supplied candidate, refuses
duplicates and invalid scores, applies the manifest's minimum score and maximum
result count, and imposes a deterministic total order.

The resulting retrieval snapshot contains the validated query, manifest and
adapter identity, context labels, ranked scores, and exact immutable record
versions. It is self-contained run data. Replay verifies its digest and tenant,
then recreates the exact Context Items without calling a retrieval adapter or a
memory store. This intentionally duplicates the selected bodies into the
snapshot: a digest-only snapshot cannot replay after retention expires the
source record.

Snapshot bodies belong in the tenant-bound data record, not in a control-plane
journal or audit event. Control evidence should carry only the snapshot digest.

## Context integration

Every retrieval hit becomes a normal `awe.context_item`:

- the manifest chooses an existing Context Item kind and source;
- the record's tenant and sensitivity are preserved;
- retrieval never promotes trust;
- provenance pins record, query, and snapshot digests;
- metadata records profile kind, score, rank, retention class, and expiry.

The caller passes these items to the existing Context Engine or Agent Runtime.
No memory-specific prompt format or provider behavior exists.

## Storage adapters

`defineMemoryStore()` validates a storage-neutral contract:

- `write(record, { expected_version })`;
- `read({ org_id, memory_id, record_id, version })`;
- `latest({ org_id, memory_id, record_id })`;
- `list({ org_id, memory_id, as_of })`;
- `expire({ org_id, memory_id, as_of })`.

The shipped implementation is in-memory and tenant-checked. A future durable
adapter may map the same documents to Postgres, object storage, a search engine,
or a vector system, but no such backend is selected by this milestone.

## Verification

Runner Y (`bash scripts/eval-memory.sh`) covers:

- closed manifests and digests;
- lifecycle/version/tenant registry resolution;
- immutable record chains, redaction, provenance, and retention;
- optimistic conflicts and tenant-safe store reads;
- deterministic lexical retrieval and an injected vector adapter;
- adapter output validation;
- standard Context Item materialization;
- exact self-contained replay with no adapter/store call;
- snapshot tamper and cross-tenant refusal;
- disabled, unauthorized, wrong-role, stale, and approved writes;
- controlled-dispatch proof that the write adapter is unreachable pre-approval;
- layering and source-purity lints;
- the complete memory refusal vocabulary.

## Known limitations

- The reference store is process-local and not durable.
- The optimistic version contract is ready for a durable adapter, but no
  distributed transaction or lease is included.
- Retrieval snapshots deliberately contain selected memory bodies and therefore
  need the same tenant-bound encryption, access, and retention controls as run
  data.
- Expiry is explicit (`expire()` or `as_of` filtering); no scheduler is shipped.
- Lexical retrieval is a deterministic reference implementation, not a ranking
  quality claim.
- Vector indexing, embedding generation, hybrid search, reranking, and provider
  failover remain adapter concerns.
- No memory compaction, consolidation, contradiction resolution, or
  cross-collection query planner exists yet.

## Migration and live-state note

No migration is required or included. `supabase/` is untouched. The repository
and live migration histories already documented elsewhere remain unresolved,
so a durable RLS-backed adapter must not be deployed until those histories and
the applicable ADRs agree.
