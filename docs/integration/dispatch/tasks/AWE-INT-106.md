# AWE-INT-106 — Supabase state verification

```yaml
task_id: AWE-INT-106
objective: >-
  Identify the AWE Supabase project and list its applied migrations, comparing them against the sixteen tracked files.
capability: supabase-verification
priority: P1
status: QUEUED
depends_on: none
blocked_by: Supabase project identity unknown
allowed_scope: [docs/integration/AWE_EVIDENCE_LEDGER.md]
forbidden_actions: [applying or reverting any migration, writing to any remote database, recording a key or connection string in any file]
packet_path: .awe/packets/AWE-INT-106/
assigned_role: Verifier
required_tests: [none — read-only inspection]
completion_evidence: [applied-migration listing captured, drift against tracked files documented]
handoff_path: context/LATEST_AGENT_HANDOFF.md
```

Turns C-108 from UNKNOWN into a fact. Until it runs, every statement about which migrations are live is unsupported.

## Compile the packet

```bash
npm run context:compile -- --objective "Identify the AWE Supabase project and list its applied migrations, comparing them against the sixteen tracked files." --task-id AWE-INT-106 --capability supabase-verification --output .awe/packets/AWE-INT-106
```
