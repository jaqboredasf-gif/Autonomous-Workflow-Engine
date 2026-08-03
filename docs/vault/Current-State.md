---
type: current-state
project: TEGG / AWE
updated: 2026-08-03
status: pilot-ready
---

# Current State

## What exists today

**AWE has four packages.** Three are platform; one is a customer capability.

| package | kind | what it does |
|---|---|---|
| `awe_runtime` | platform | exit-code contract, run-artifact retention, single-run locking, installation anchoring |
| `awe_knowledge` | platform | what an automation believes about an external system, with trust, evidence, contradiction and repair |
| `awe_estimating` | platform | scope → priced estimate, with provenance on every number and confidence that explains itself |
| `awe_tegg` | customer | the TEGG capability: two read-only operations and the scope adapter |

## TEGG capability status

Two operations, both live-proven against `tegg2.teggpro.com`:

- **`visit-findings`** — reads one completed site visit end to end: retrieves the
  Standard IR Report and Equipment Item Problems Report, extracts the equipment
  problems, carries the technician's recommendations through with citations,
  prices the outstanding work, scores confidence, and writes a reviewable page.
  13 steps, ~100 seconds, read-only.
- **`documentation-read`** — lists completed site visits. Kept because it is a
  cheap way to confirm the tool can still see the portal.

**Distribution is solved.** A sanitized 109-file package installs from a zip via
double-clickable `.command` files, stores credentials in the macOS Keychain, and
has been validated from a clean room outside the repository.

## What is blocked, and on what

| blocked | needs |
|---|---|
| real pricing | somebody who owns the numbers to fill `config/ratecard.yaml` and set `placeholder: false` |
| calibration / backtesting | 5–10 completed jobs with boss estimate, Accubid estimate, quoted amount, and actual where known |
| a second-machine claim | an actual second person on an actual second machine |

## What is deliberately not built

- **No AI is wired in.** The seam exists (`EvidenceClass.AI_PROPOSAL`, which
  cannot price until confirmed) and is unused. Deterministic first.
- **No customer sending.** Proposal and email drafting are milestone 6 and will
  produce drafts requiring explicit approval. Nothing sends.
