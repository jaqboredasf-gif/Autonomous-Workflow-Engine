---
type: capability-specifications
project: AWE
updated: 2026-08-03
---

# Capability Specifications

## `awe_estimating` — v1

**Purpose.** Turn scope into a defensible priced estimate for any workflow.

**Inputs.** A `ScopeSource` implementation (or `list[ScopeItem]`), and a
`RateCard` loaded from YAML.

**Outputs.** `PricingResult` — an `Estimate` with priced lines, adjustments,
range, open questions, assumptions; plus unmatched vocabulary.

**Interfaces.**
- `ScopeSource` — `scope_items() -> list[ScopeItem]`, `context() -> dict[str,str]`
- `RateCard.load(path)` / `validate` / `validate_for_production`
- `price(source, card) -> PricingResult`
- `assess_confidence(estimate, rules) -> ConfidenceReport`

**Dependencies.** PyYAML. Nothing else. No network, no AI, no workflow imports.

**Validation.** 88 tests. Live-verified through TEGG on a real visit.

**Known limitations.**
- Quantity comes from the adapter; the engine cannot infer it.
- Overtime rules are modelled but not applied.
- Equipment and subcontractor lines are modelled but not yet produced.
- No historical calibration (milestone 7).

**Future consumers.** Any trade or service business quoting from an inspection,
survey, ticket or site visit. The engine is industry-agnostic; only the adapter
and the rate card change.

**Suggested platform location.** `awe/platform/estimating/`.

---

## `awe_runtime` — v1

**Purpose.** What every AWE capability needs and none should own a copy of.

**Modules.**
- `exits` — the five-code contract (0 ok, 1 failed, 2 usage, 3 needs-human,
  4 not-ready)
- `workspace_root` — installation anchoring; refuses to run from outside it
- `locking` — one run at a time, with stale-lock takeover
- `retention` — run-artifact lifecycle; never sweeps automatically

**Validation.** 33 tests, plus shell-level tests for the launcher preamble.

**Known limitations.** Locking is per-installation, not cross-machine.

**Future consumers.** Every capability.

**Suggested platform location.** `awe/platform/runtime/`.

---

## `awe_tegg.scope_adapter` — v1 (customer-specific)

**Purpose.** Translate TEGG inspection recommendations into estimating scope.

**Inputs.** `RecommendationSet`. **Outputs.** `list[ScopeItem]` + context.

**Interface implemented.** `awe_estimating.ScopeSource`.

**Known limitations.** Quantity is always 1, stated as an assumption, with
prose scanned for plural hints that raise a question.

**Suggested platform location.** Stays in the workflow package — permanently.
This is the model for every future adapter.
