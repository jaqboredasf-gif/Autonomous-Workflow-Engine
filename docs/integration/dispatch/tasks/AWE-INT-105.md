# AWE-INT-105 — n8n export recovery

```yaml
task_id: AWE-INT-105
objective: >-
  Export every n8n workflow read-only, index them, and diff both WF8 variants without activating anything.
capability: n8n-adapter
priority: P0
status: QUEUED
depends_on: none
blocked_by: n8n instance access
allowed_scope: [C:/AWE/exports/n8n/, docs/integration/]
forbidden_actions: [activating publishing executing or modifying any workflow, using a real recipient, any external send]
packet_path: .awe/packets/AWE-INT-105/
assigned_role: Scout
required_tests: [none — this task produces exports, not code]
completion_evidence: [an export index with id, name, active state, credential references (never values), webhooks, external-send nodes and approval gates]
handoff_path: context/LATEST_AGENT_HANDOFF.md
```

WF8 exists as a live ungated workflow (e0d2b551) and a hardened draft (22d83e67). A live ungated workflow can produce side effects no platform policy governs, and no export of it exists anywhere. Highest operational risk in the programme. See C-107.

## Compile the packet

```bash
npm run context:compile -- --objective "Export every n8n workflow read-only, index them, and diff both WF8 variants without activating anything." --task-id AWE-INT-105 --capability n8n-adapter --output .awe/packets/AWE-INT-105
```
