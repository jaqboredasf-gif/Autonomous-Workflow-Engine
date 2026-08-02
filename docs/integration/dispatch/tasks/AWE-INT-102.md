# AWE-INT-102 — Microsoft 365 reconciliation

```yaml
task_id: AWE-INT-102
objective: >-
  Compare the durable-execution branch with the Microsoft 365 integration branch and identify merge risks without merging either branch.
capability: m365-reconciliation
priority: P1
status: QUEUED
depends_on: AWE-INT-101
blocked_by: none
allowed_scope: [docs/integration/AWE_MERGE_RISK_REPORT.md, docs/architecture/]
forbidden_actions: [merging, rebasing or cherry-picking either branch, checking out the m365 branch, resolving scripts/regression.sh by picking a side]
packet_path: .awe/packets/AWE-INT-102/
assigned_role: Integrator
required_tests: [bash scripts/regression.sh --kinds=unit,offline,static]
completion_evidence: [a design document naming the chosen layering and the suites to register, no branch modified]
handoff_path: context/LATEST_AGENT_HANDOFF.md
```

The m365 branch is +1 from main and carries none of the six awe-* packages, so its policy, evidence and credential handling are parallel implementations rather than reuse. 70 files vs 162, 5 overlapping paths, 3 conflicts. This is architectural reconciliation, not a merge. See C-102.

## Compile the packet

```bash
npm run context:compile -- --objective "Compare the durable-execution branch with the Microsoft 365 integration branch and identify merge risks without merging either branch." --task-id AWE-INT-102 --capability m365-reconciliation --output .awe/packets/AWE-INT-102
```
