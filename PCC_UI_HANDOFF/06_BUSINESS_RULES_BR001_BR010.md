# PCC Business Rules BR-001 — BR-010

BR-001 — Active requests remain visible/editable in the purchasing workspace until fully received, subject to authority and audit restrictions.

BR-002 — Only authorized purchasing personnel can approve purchasing requests.

BR-003 — A foreman assigned/authorized for the destination job may confirm physical receipt at that job.

BR-004 — Authorized purchasing personnel may confirm receipt when they personally verify delivery.

BR-005 — Every purchase order belongs to exactly one job number.

BR-006 — Changing an order to Email Drafted or Ordered must not remove it from the operational purchasing queue.

BR-007 — Line items can be received independently. A PO must not become Received until all required items are accounted for.

BR-008 — Major actions create an audit event containing actor, action, timestamp, previous state, and new state where applicable.

BR-009 — Submitted purchasing records are not hard-deleted through normal workflow. Use cancel/archive semantics.

BR-010 — Vendor email drafting/access must be directly available from the purchase order workflow without requiring navigation back to the originating request.
