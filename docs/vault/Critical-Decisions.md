---
type: critical-decisions
project: TEGG / AWE
updated: 2026-08-03
---

# Critical Decisions

Each entry: the decision, why, and what it costs.

## D-1 · Deterministic spine first; AI seam defined but unwired

**Decision.** Build pricing, validation, approval and audit deterministically.
Define where AI plugs in; do not wire it.

**Why.** Pricing that varies run to run cannot gate an approval or be defended
to a customer. An LLM also adds an API dependency, cost and a testing problem.

**Cost.** Scope extraction is thinner than an AI-assisted version would be —
quantity and effort come from configuration and questions rather than
inference.

## D-2 · A model's suggestion is not evidence

**Decision.** `EvidenceClass.AI_PROPOSAL` sits outside the five real classes and
**cannot price anything** until configuration, a comparable job, or a named
person confirms it. `Provenance.confirm()` is the only crossing and records who.

**Why.** A proposal presented with the same confidence as a measurement is how
an estimating tool becomes dangerous.

## D-3 · Money comes only from approved configuration

**Decision.** No fallback rate, no default hourly figure, no sensible-looking
constant anywhere in the engine.

**Why.** The moment one exists it becomes the number that quietly prices a job
nobody checked.

**Cost.** More configuration up front, and more questions on a first run.

## D-4 · Prefer a stated gap to a plausible number

**Decision.** Work the rate card does not cover produces a clarification naming
what is missing; the estimate still ships with that item unpriced.

**Why.** A tool that refuses everything until every gap closes gets abandoned.
One that fills gaps quietly produces numbers nobody can defend.

## D-5 · Money is Decimal; floats are refused at construction

**Why.** `Decimal(0.1)` is `0.1000000000000000055`, and it reaches an estimate
via `json.load`.

## D-6 · Totals are computed, never stored

**Why.** A stored total can disagree with its own lines, and the first time it
does is the last time anybody trusts the document.

## D-7 · Two-tier configuration validation

**Decision.** `validate_for_production` is stricter than `validate`.

**Why.** A template announces itself. The dangerous state is a card **claiming**
to be production while carrying handed-down values.

## D-8 · Prose is never vocabulary

**Decision.** Adapters emit tokens (`work_type`, `asset_type`); sentences stay
sentences. No fallback from token to prose.

**Why.** The fallback turned a technician's whole sentence into a work type and
asked the reader what it "involved".

## D-9 · One estimating engine, not two

**Decision.** `awe_tegg/estimate.py` was deleted on migration, not kept.

**Why.** Two sources of truth for the same number is the trap this project has
been removing everywhere else.

## D-10 · Extract to platform only after a capability proves the shape

**Why.** Building `awe_estimating` inside TEGG would have guaranteed TEGG-shaped
assumptions. `awe_runtime`'s docstring records what is deliberately *not* in it.

## D-11 · Never sweep evidence automatically

**Decision.** `runs --prune` is the only thing that deletes. Never on a
schedule, never as a side effect.

**Why.** Deleting the evidence for a result somebody is about to defend is
worse than a full disk.
