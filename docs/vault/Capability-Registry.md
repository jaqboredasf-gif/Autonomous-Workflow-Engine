---
type: capability-registry
project: AWE
updated: 2026-08-03
---

# Capability Registry

| capability | kind | version | status | consumers |
|---|---|---|---|---|
| `awe_runtime.exits` | platform | 1 | live | all |
| `awe_runtime.workspace_root` | platform | 1 | live | awe_tegg |
| `awe_runtime.locking` | platform | 1 | live | awe_tegg |
| `awe_runtime.retention` | platform | 1 | live | awe_tegg |
| `awe_knowledge` | platform | 1 | live | awe_tegg |
| `awe_estimating.model` | platform | 1 | live | awe_tegg |
| `awe_estimating.evidence` | platform | 1 | live | awe_estimating |
| `awe_estimating.ratecard` | platform | 1 | live | awe_tegg |
| `awe_estimating.pricing` | platform | 1 | live | awe_tegg |
| `awe_estimating.confidence` | platform | 1 | live | awe_tegg |
| `awe_estimating.ScopeSource` | interface | 1 | live | awe_tegg |
| `scripts/_awe.sh` | platform | 1 | live | both launchers |
| `packaging/build_package.py` | platform pattern | 1 | live | TEGG package |
| `awe_tegg.scope_adapter` | adapter | 1 | live | — |
| `awe_tegg.documents` | adapter | 1 | live | — |
| `awe_tegg.findings` | adapter | 1 | live | — |

## Planned

| capability | milestone |
|---|---|
| `awe_estimating.approval` | 5 |
| `awe_estimating.proposal` | 6 |
| `awe_estimating.calibration` | 7 |
| AI assist interface (proposer only) | after 7 |
