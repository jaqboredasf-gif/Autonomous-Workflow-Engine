-- ---------------------------------------------------------------------------
-- 0022 — withdraw two permissions that read like reads and are not.
--
-- `order.track` is checked by exactly one thing: updateTracking(), which WRITES
-- a carrier and a tracking number onto a purchase. Migration 0016 granted it to
-- ACCOUNTING and FOREMAN on the assumption that "track" meant "see tracking".
--
-- It does not, and the consequences differ by role:
--   * ACCOUNTING is the read-only role. Its whole value is that it cannot alter
--     what it audits; holding a write permission contradicts that outright.
--   * FOREMAN signs for what arrives. Entering a carrier and tracking number is
--     the purchaser's clerical act, and a field user editing it can quietly
--     break the link between a shipment and its paperwork.
--
-- Both roles still SEE tracking: reads are scoped by organization, not by this
-- permission. Nothing about their day changes.
--
-- Append-only on purpose. 0016 is left exactly as it was applied, so any
-- environment that ran it converges by running this rather than by having
-- history rewritten underneath it.
-- ---------------------------------------------------------------------------

delete from purchasing_role_permissions
 where role in ('ACCOUNTING', 'FOREMAN')
   and permission = 'order.track';
