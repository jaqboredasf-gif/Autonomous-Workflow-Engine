# @exattime/m365 — Microsoft 365 Integration Plane

Provider-bound, workflow-neutral. This package knows Microsoft Graph and knows
nothing about work requests, invoices or scheduling — swapping the provider means
rewriting `adapters/`, the two gateways and `normalize.ts`, and nothing else.

Zero dependencies. Strict TypeScript, run directly by Node (type stripping), so
the tests exercise the modules that ship.

```
contracts.ts      the seam: CapabilityRequest/Result, ContextItem, EvidenceRecord
capabilities.ts   the catalog — 7 capabilities, no send at any version
allowlist.ts      explicit resources + the AWE↔Microsoft tenant binding
scopes.ts         spec ⊆ declared ⊆ granted, with forbidden scopes named
gateway.ts        MicrosoftGraphGateway (transport seam)
fake-graph.ts     deterministic offline provider, fidelity: 'synthetic'
http-gateway.ts   real Graph, disabled by default, refuses transmit paths
credentials.ts    env-only credential provider; presence, never values
subscriptions.ts  lifecycle state machine
notifications.ts  validation + at-least-once deduplication
executor.ts       every gate, every retry bound, every evidence row
handlers.ts       capability -> adapter binding
adapters/         mail · teams · document · identity
normalize.ts      Graph message -> ContextItem -> email_messages row
evidence.ts       hash-chained audit trail
persistence.ts    the rows this slice would write (migration 0016)
pipeline.ts       the first proof slice, orchestration only
```

## Use it

```bash
bash scripts/eval-m365.sh                      # Runner 6: offline, deterministic
node scripts/lib/validate-migration-0016.mjs   # schema/engine parity lint
npx tsc -p packages/m365/tsconfig.json         # strict typecheck
bash scripts/m365-live-smoke.sh                # opt-in; BLOCKED without credentials
```

## Read next

- `docs/architecture/M365_INTEGRATION_PLANE.md` — architecture, gates, capability catalog
- `docs/integrations/M365_ENTRA_CONFIGURATION.md` — what IT must provide
- `docs/integrations/BLOCKED_LIVE_PROOF.md` — what is still missing for a live proof
