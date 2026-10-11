// ---------------------------------------------------------------------------
// po-number-strategy.mjs — the ONE seam between purchasing and how a particular
// organization names a purchase order.
//
// WHAT THIS IS. Two questions, answered by the organization rather than by
// purchasing:
//
//   sequenceScope(scope)  what does the counter count WITHIN?
//                         Lippolis counts within (job, vendor). A business that
//                         counts per vendor, or per organization, says so here
//                         and nothing else changes.
//
//   format(components)    what does the finished identifier look like?
//
// WHAT THIS IS NOT, deliberately: a template language, a token syntax, a rule
// builder, an expression evaluator, a plugin loader, or a numbering "engine". A
// strategy is two functions. Every mechanism beyond that is a thing somebody
// has to debug on a Friday afternoon, and no organization has asked for one.
//
// WHAT STAYS ON THIS SIDE OF THE SEAM — and is not negotiable:
//
//   * ALLOCATION. The sequence value comes from the database, inside the
//     transaction that writes the order. A strategy is handed a number; it
//     never picks one. Two people pressing Approve in the same second is the
//     whole reason, and no amount of care in application code fixes it.
//   * UNIQUENESS. The unique constraints on (org, po_number) and on
//     (org, job, vendor, sequence) are the truth. A strategy that formats two
//     different allocations to the same string will be refused by the database,
//     which is the correct outcome.
//   * IMMUTABILITY. An issued number is permanent, enforced by trigger.
//
// AND WHAT MUST NEVER HAPPEN. If an organization has no numbering strategy, the
// answer is an error, at provisioning or at startup. It is NOT `TEMP-001`, not
// `UNKNOWN`, not a UUID. A placeholder purchase order number is not a smaller
// problem than a failure to start — it is a bigger one, because it gets printed,
// emailed to a supplier, and typed onto an invoice before anybody notices that
// the organization's numbering rule was never actually established. Missing
// policy stays visibly missing.
// ---------------------------------------------------------------------------

/**
 * Declare one organization's numbering rule.
 *
 * `id` is the name the organization profile uses — `purchasing.po_numbering` in
 * `capability/purchasing/profile.mjs`. The two are the same vocabulary on
 * purpose: the profile says which rule, this says what the rule is.
 *
 * Validated at construction, like an authorization profile, because the moment
 * to discover that a rule is malformed is while writing it — not while somebody
 * is trying to raise a purchase order.
 */
export function definePoNumberStrategy({ id, sequenceScope, format }) {
  const problems = [];
  if (typeof id !== 'string' || !id.trim()) problems.push('a numbering strategy must have an id, matching the organization profile\'s purchasing.po_numbering');
  if (typeof sequenceScope !== 'function') problems.push('a numbering strategy must say what its sequence counts within (sequenceScope)');
  if (typeof format !== 'function') problems.push('a numbering strategy must say how a number is written (format)');
  if (problems.length) throw new Error(`invalid PO numbering strategy:\n  ${problems.join('\n  ')}`);

  return Object.freeze({ id: id.trim(), sequenceScope, format });
}

/**
 * The strategy, or a refusal naming what is missing.
 *
 * Called by the allocator before it touches the counter, so an organization
 * without a numbering rule consumes no sequence value and issues no order.
 */
export function requirePoNumberStrategy(strategy, orgId) {
  if (strategy && typeof strategy.format === 'function' && typeof strategy.sequenceScope === 'function') return strategy;
  const err = new Error(
    `no purchase order numbering strategy is configured${orgId ? ` for organization ${orgId}` : ''}. ` +
      'Purchasing cannot invent one: declare the organization\'s rule in its profile ' +
      '(purchasing.po_numbering) and implement it in organization/po-numbering.mjs.',
  );
  err.reason = 'po_numbering_unconfigured';
  throw err;
}

/**
 * Where a sequence counts. Returns the counter's key.
 *
 * `jobKey` may be empty — a rule that does not count per job says so by leaving
 * it out, and the counter row is then keyed on the vendor alone. `vendorKey`
 * may not be empty, because the counter table is keyed on a real vendor.
 */
export function sequenceKeyFor(strategy, scope) {
  const key = requirePoNumberStrategy(strategy, scope?.orgId).sequenceScope(scope);
  const jobKey = key?.jobKey === undefined || key?.jobKey === null ? '' : String(key.jobKey);
  const vendorKey = String(key?.vendorKey ?? '');
  if (!vendorKey) {
    const err = new Error(`numbering strategy ${strategy.id} produced no vendor key for the sequence counter`);
    err.reason = 'po_sequence_scope_invalid';
    throw err;
  }
  return { jobKey, vendorKey };
}

/**
 * The finished number, or a refusal.
 *
 * The output is checked rather than trusted. A strategy that returns nothing
 * usable must not be allowed to hand a blank or an "undefined" to a supplier —
 * the allocation is inside a transaction, so throwing here rolls the consumed
 * sequence value back.
 */
export function poNumberFrom(strategy, components) {
  const value = requirePoNumberStrategy(strategy, components?.orgId).format(components);
  if (typeof value !== 'string' || !value.trim()) {
    const err = new Error(
      `numbering strategy ${strategy.id} produced no purchase order number for ` +
        `job ${JSON.stringify(components?.jobNumber)} / vendor ${JSON.stringify(components?.vendorCode)} / sequence ${components?.sequence}`,
    );
    err.reason = 'po_number_not_produced';
    throw err;
  }
  return value.trim();
}
