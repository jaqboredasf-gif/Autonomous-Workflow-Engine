# AWE-INT-104 — MacBook artifact preservation

```yaml
task_id: AWE-INT-104
objective: >-
  Bring the Obsidian vault, environment-file shape and saved test evidence under protection and confirm no local-only branch exists.
capability: artifact-preservation
priority: P0
status: QUEUED
depends_on: none
blocked_by: MacBook access
allowed_scope: [C:/AWE/vault/, apps/web/.env.example, packages/mcp-server/.env.example, packages/m365/.env.example]
forbidden_actions: [committing any real .env, key or token — key names only]
packet_path: .awe/packets/AWE-INT-104/
assigned_role: Scout
required_tests: [node scripts/validate-context.mjs]
completion_evidence: [vault copied, key-name-only templates exist, git branch -vv output recorded]
handoff_path: context/LATEST_AGENT_HANDOFF.md
```

The vault has zero hits across all twelve remote branches, so Git protects none of it. Real .env files are correctly gitignored, but that also means the shape of the live configuration exists only on one laptop.

## Compile the packet

```bash
npm run context:compile -- --objective "Bring the Obsidian vault, environment-file shape and saved test evidence under protection and confirm no local-only branch exists." --task-id AWE-INT-104 --capability artifact-preservation --output .awe/packets/AWE-INT-104
```
