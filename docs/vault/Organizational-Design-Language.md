---
type: design-language
project: AWE
updated: 2026-08-03
---

# Organizational Design Language

Words that mean something specific here. Using them loosely costs precision.

| term | meaning |
|---|---|
| **capability** | a thing AWE can do, packaged so a second project reuses it without editing |
| **adapter** | the only place customer-specific knowledge lives; translates a domain into a platform interface |
| **provenance** | where a value came from, specific enough to find again |
| **evidence class** | report, technician, configuration, historical, human — plus AI proposal, which is not evidence |
| **may-price** | whether a value is allowed to become money |
| **confirmation** | promoting an AI proposal to something that may price, recording who |
| **vocabulary contract** | the tokens an adapter emits must be tokens the rate card knows; drift makes every estimate silently unpriced |
| **source absence** | a fact the source genuinely does not contain — stated as an assumption, never inferred |
| **clarification** | a question asked instead of guessing; *blocking* if it stops pricing |
| **ancillary** | a job-level cost (mobilization, permits) — priced, but not a finding |
| **work rule** | the config row mapping work + asset to effort and materials |
| **template card** | a rate card marked `placeholder: true`; prices, but the money is not real |
| **unpriced-with-reason** | an item deliberately left without a number, and the reason attached |
| **not ready** | exit 4 — nothing attempted, nothing contacted, nothing changed |
| **knowledge record** | what an automation believes about an external system, with trust and evidence |
| **contradiction** | the live system disagreeing with a stored belief; triggers bounded repair |
| **bounded discovery** | read-only rediscovery inside a hard action and time budget |
| **run ledger** | the durable record of one run; a step is written when verified, not when attempted |
| **clean room** | validation using only what a coworker receives, outside the repository |
