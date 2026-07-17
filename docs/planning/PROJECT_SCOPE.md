# Project Scope — Lippolis Electric Field-Service OS

Last updated: 2026-07-16. Owner: Jack Daly. Approver: boss (owner).

## Business problem

1. Lippolis Electric pays for ExakTime (time tracking, GPS job-site validation, payroll prep). Goal: replace it with an in-house system and cancel the subscription.
2. The owner manually reads, triages, forwards, and answers every incoming work-request email, and manually drives the request → schedule → dispatch → invoice pipeline. Goal: automate the pipeline (boss's written scope, 2026-07-16 email) with conservative human approval gates.

## Two workstreams

### Workstream A — ExakTime replacement (mostly built)
Mobile punch app (offline-capable, GPS + photo), server-side geofencing, crew punch, timesheet approve → lock, timecard corrections with immutable originals, payroll draft math, admin dashboard. **Cutover criterion (decided): 2 consecutive pay periods where Exattime totals match ExakTime, run in parallel. ExakTime remains the fallback until then.**

### Workstream B — Work-request → invoice automation (boss's scope, new build)
Pipeline per boss's email:

1. Inbound work-request email → territory check
   - Out of territory → automatic polite decline (the ONLY auto-send in v1)
   - In territory → classify
2. Classify: **emergency** (new required branch) | **service call** (1 electrician, <1 day, basic material) | **estimate job** (larger)
3. Service call → capture Commercial/Residential + urgency → schedule next available matching Service electrician → draft confirmation email w/ standard pricing → calendar entry → draft dispatch notification
4. Estimate job → capture Commercial/Residential + urgency → route to next available qualified Estimator; if drawings/info sufficient, prepare estimate without site visit → internal approval → format proposal → draft to customer → on customer approval, schedule qualified crew → confirmation → calendar → dispatch draft
5. On completion of any calendar job → generate invoice → human review → send (never autonomous in v1)

## MVP (version 1) definition

Smallest useful version, buildable now without Microsoft Graph or QuickBooks access:

- Intake data spine (email storage + work-request records) fed by **test email fixtures** (Graph swap-in later; ingestion layer isolated from classification/routing)
- Classification: emergency / service call / estimate / out-of-territory, with confidence scores
- Emergency branch: flag urgent, halt auto-scheduling, escalate to configurable contact, require human response, audit reasoning — **required MVP feature**
- Territory gate using definite service-territory rules (real territory data still needed; current rows are SAMPLE)
- Approval system: outbound message drafts + approval matrix, per-type draft/auto toggle without rebuild
- Link approved service calls into existing scheduling (shifts) + dispatch drafts
- Placeholder pricing structure + estimate records (no real prices invented; incomplete pricing flagged)
- Invoice data model supporting fixed-price AND time-and-materials (integration deferred)

## Explicitly out of scope for MVP

- Automated drawing-based estimating (deferred until pricing data + approval rules reliable)
- Autonomous sending of anything except high-confidence out-of-territory declines
- Autonomous final invoices (never in v1)
- QuickBooks integration (deferred — see INTEGRATIONS.md recommendation)
- Dispatch Pilot evaluation
- Live Microsoft Graph mail/calendar (blocked on Entra app registration)

## Future improvements (parking lot — do not build silently)

- Drawing-based auto-estimating
- Per-message-type graduation from draft to auto-send
- Outgoing invoice email processing
- Excel import/export tooling
- Customer portal
