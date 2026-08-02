# AWE-INT-101 — Migration identity resolution

```yaml
task_id: AWE-INT-101
objective: >-
  Produce a repository-grounded resolution plan for the three-way migration identity collision involving slot 0016 without modifying any migration.
capability: migration-identity
priority: P0
status: QUEUED
depends_on: none
blocked_by: none
allowed_scope: [docs/planning/MIGRATION_IDENTITY_RESOLUTION.md, context/VERIFIED_EVIDENCE.md, context/LATEST_AGENT_HANDOFF.md]
forbidden_actions: [any change under supabase/, checking out the m365 or phase-1 branches, guessing the canonical scheme]
packet_path: .awe/packets/AWE-INT-101/
assigned_role: Integrator
required_tests: [bash scripts/regression.sh --only=validate-migration-0014,validate-migration-0015]
completion_evidence: [docs/planning/MIGRATION_IDENTITY_RESOLUTION.md exists, git status --short supabase/ is empty]
handoff_path: context/LATEST_AGENT_HANDOFF.md
```

Two files claim ordinal `0016` and a third branch re-solves the same C1 fix under a Supabase timestamp scheme. ADR-0009 recorded two of the three. The undecided question — sequential ordinals or timestamp identities — determines the fix for all of them and must be ratified by a human, not guessed. See docs/integration/AWE_CONFLICT_REGISTER.md C-101.

## Compile the packet

```bash
npm run context:compile -- --objective "Produce a repository-grounded resolution plan for the three-way migration identity collision involving slot 0016 without modifying any migration." --task-id AWE-INT-101 --capability migration-identity --output .awe/packets/AWE-INT-101
```
