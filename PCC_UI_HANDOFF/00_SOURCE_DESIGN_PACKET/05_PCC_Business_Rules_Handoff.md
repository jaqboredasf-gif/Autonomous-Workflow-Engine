# PCC Business Rules Handoff

This artifact intentionally starts the bridge between product design and the separate PCC constitutional/business-rules session.

Already established implementation-facing rules:

- BR-001 — Requests remain editable in the purchasing workspace until fully received, subject to authority and audit rules.
- BR-002 — Only authorized purchasing personnel approve purchases.
- BR-003 — A foreman assigned to the destination job may confirm physical receipt at that job.
- BR-004 — Purchasing staff may confirm receipt where they personally verify delivery.
- BR-005 — Every purchase order belongs to exactly one job number.
- BR-006 — Changing status to Email Drafted or Ordered must not remove the order from the operational queue.
- BR-007 — Line items may be received independently; a PO is not Received until all required items are accounted for.
- BR-008 — Major actions create an audit record including actor, action, timestamp, previous state, and new state.
- BR-009 — Submitted purchasing records are not hard-deleted through normal use; they are cancelled or archived.
- BR-010 — Vendor email workflow is directly accessible from the PO detail view.

Recommended next rule families for the separate laws/constitution session:
Authority, approvals, editing, cancellation, price variance, vendor substitution, partial receiving, damaged/wrong materials, evidence requirements, financial visibility, audit retention, notification responsibility, delegation, overrides, and amendments.
