# AWE-INT-103 — Docker and database replay

```yaml
task_id: AWE-INT-103
objective: >-
  Replay migrations 0001 through 0016 against an empty PostgreSQL in an isolated container and confirm the chain applies from scratch.
capability: database-replay
priority: P1
status: QUEUED
depends_on: AWE-INT-101
blocked_by: Docker daemon not running; WSL2 has no distribution
allowed_scope: [C:/AWE/evidence/, docs/integration/]
forbidden_actions: [pointing any replay at a shared remote or production database, supabase db push, using real credentials]
packet_path: .awe/packets/AWE-INT-103/
assigned_role: Verifier
required_tests: [the eight credential-gated db-kind suites, against the local container only]
completion_evidence: [a saved replay transcript, every failure recorded rather than worked around]
handoff_path: context/LATEST_AGENT_HANDOFF.md
```

Blocked until Docker Desktop is launched once so it can create its docker-desktop WSL distribution. Until then every db-kind suite stays LIVE_BLOCKED and applied-migration state stays UNKNOWN.

## Compile the packet

```bash
npm run context:compile -- --objective "Replay migrations 0001 through 0016 against an empty PostgreSQL in an isolated container and confirm the chain applies from scratch." --task-id AWE-INT-103 --capability database-replay --output .awe/packets/AWE-INT-103
```
