# Data Model

Rules (from approved spec): UUID PKs, created_at/updated_at, org_id + RLS on every table, migrations only, no destructive migrations without explicit approval.

## Existing (live, migrations 0001–0010)

orgs, org_settings, users (roles worker/foreman/admin, skills[]), crews, job_sites, cost_codes, time_entries (immutable punches, geofence flags, offline idempotency), time_entry_audits, timecard_corrections, pay_periods, payroll_exports, shifts, service_areas, leads, completion_reports, integration_events (n8n contract).

## Planned — Workstream B (new tables)

### email_messages (ingestion layer — isolated from routing)
- id, org_id, direction (inbound/outbound), mailbox, graph_message_id (nullable — null for fixtures), from_addr, to_addrs, subject, body_text, body_html, attachments jsonb, received_at, raw immutable, is_fixture bool
- Immutability guard: no updates to body/from/subject after insert (audit requirement).

### work_requests
- id, org_id, email_message_id FK, customer_name/email/phone/address, lat/lng (geocoded, nullable), classification (emergency|service_call|estimate_job|out_of_territory|unknown), confidence numeric, classification_reasoning text, property_type (commercial|residential|unknown), urgency (emergency|urgent|standard), status (new|escalated|awaiting_approval|scheduled|declined|converted|closed), territory_result jsonb (matched rule, distance), assigned_to FK users
- Emergency rows: status forced 'escalated', auto-scheduling forbidden by trigger.

### emergency_contacts / escalation_rules (configurable — contact + channel unconfirmed)
- emergency_contacts: id, org_id, user_id/free-form name, channel (sms|call|email|teams), address, priority order, active
- Escalation: on emergency classification emit event; n8n delivers via configured channel.

### outbound_messages + approval matrix
- message_policies: id, org_id, message_type, mode (draft|auto), approver_role, confidence_threshold, escalation_rule, active — **data-driven so types graduate draft→auto without rebuild**
- outbound_messages: id, org_id, work_request_id FK, message_type, body draft, status (draft|approved|sent|rejected|failed), approved_by, sent_at, graph_message_id (nullable), audit fields

### price_book (placeholders only — no invented real prices)
- price_items: id, org_id, kind (labor_rate|material|markup|overhead|tax|contingency), name, unit, amount numeric NULLABLE, source text NOT NULL, last_updated_at NOT NULL, verified bool default false

### estimates / proposals / change_orders
- estimates: id, org_id, work_request_id, estimator_id, status (draft|internal_review|approved|rejected|sent|customer_approved|customer_rejected), pricing_complete bool (computed — blocks send when false), totals
- estimate_line_items: estimate_id, price_item_id nullable, description, qty, unit_amount, source
- change_orders: job-linked, approved_by, amount, status

### customers / jobs (thin v1)
- customers: id, org_id, name, emails[], phones[], billing address, default_rate_tier [ASSUMPTION: per-customer rates may exist — discovery]
- jobs: id, org_id, customer_id, job_site_id, origin work_request_id, billing_type (fixed_price|time_and_materials), status, proposal/estimate link

### invoices (model now, integrate later)
- invoices: id, org_id, job_id, billing_type, status (draft|review|approved|sent|void), subtotal/tax/total, source jsonb (fixed: proposal+change_orders refs; T&M: time_entry ids + material refs), reviewed_by, quickbooks_ref nullable [integration unconfirmed]
- invoice_line_items

## Event types to add (integration_events)
request.received, request.classified, request.emergency_escalated, request.auto_declined, message.draft_created, message.approved, message.sent, estimate.internal_review, estimate.approved, proposal.sent, proposal.customer_approved, invoice.drafted, invoice.approved
