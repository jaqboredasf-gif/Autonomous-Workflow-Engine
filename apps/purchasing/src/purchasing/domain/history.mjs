// ---------------------------------------------------------------------------
// history.mjs — BR-012 / BR-013 derived intelligence over immutable evidence.
//
// PURE. Persistence supplies tenant-scoped snapshot rows; these functions
// count, sort and average them. They never mutate a row, never consult current
// vendor/material/job names, and never treat a configured default vendor as an
// observed vendor.
// ---------------------------------------------------------------------------

const effectivePrice = (line) => line.actualUnitPriceCents ?? line.estimatedUnitPriceCents ?? null;

function ordered(lines) {
  return [...lines].sort((a, b) =>
    String(b.orderedAt ?? '').localeCompare(String(a.orderedAt ?? '')) ||
    String(b.id ?? '').localeCompare(String(a.id ?? '')),
  );
}

function mean(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (!present.length) return null;
  return Math.round(present.reduce((total, value) => total + Number(value), 0) / present.length);
}

function mode(values) {
  if (!values.length) return null;
  const counts = new Map();
  for (const value of values) counts.set(Number(value), (counts.get(Number(value)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

function leadTimeHours(line) {
  if (!line.orderedAt || !line.receivedAt) return null;
  const elapsed = Date.parse(line.receivedAt) - Date.parse(line.orderedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed / 3_600_000 : null;
}

/** Material facts observed in completed purchases only. */
export function deriveMaterialIntelligence(lines = []) {
  const groups = new Map();
  for (const line of lines) {
    const key = String(line.normalizedDescription ?? '');
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([normalizedDescription, group]) => {
    const recent = ordered(group);
    const latest = recent[0];
    const recentPrices = recent.map(effectivePrice).filter((price) => price !== null).slice(0, 10);
    return {
      orgId: latest.orgId,
      normalizedDescription,
      lastDescriptionSnapshot: latest.materialDescriptionSnapshot,
      lastVendorId: latest.vendorId,
      lastVendorNameSnapshot: latest.vendorNameSnapshot,
      lastVendorPartNumberSnapshot: latest.vendorPartNumberSnapshot ?? null,
      lastOrderedAt: latest.orderedAt,
      lastUnitPriceCents: effectivePrice(latest),
      recentAverageUnitPriceCents: mean(recentPrices),
      recentPriceSampleSize: recentPrices.length,
      commonQuantity: mode(group.map((line) => line.quantityOrdered)),
      completedLineCount: group.length,
      completedOrderCount: new Set(group.map((line) => line.purchaseOrderId)).size,
    };
  });
}

/** Vendor/material facts. Observed use is not configured preference. */
export function deriveVendorMaterialIntelligence(lines = []) {
  const groups = new Map();
  for (const line of lines) {
    const key = `${line.vendorId}\u0000${line.normalizedDescription}`;
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const recent = ordered(group);
    const latest = recent[0];
    const recentPrices = recent.map(effectivePrice).filter((price) => price !== null).slice(0, 10);
    const leadTimes = group.map(leadTimeHours).filter((hours) => hours !== null);
    return {
      orgId: latest.orgId,
      vendorId: latest.vendorId,
      vendorNameSnapshot: latest.vendorNameSnapshot,
      normalizedDescription: latest.normalizedDescription,
      materialDescriptionSnapshot: latest.materialDescriptionSnapshot,
      lastVendorPartNumberSnapshot: latest.vendorPartNumberSnapshot ?? null,
      commonQuantity: mode(group.map((line) => line.quantityOrdered)),
      completedOrderCount: new Set(group.map((line) => line.purchaseOrderId)).size,
      lastOrderedAt: latest.orderedAt,
      lastUnitPriceCents: effectivePrice(latest),
      recentAverageUnitPriceCents: mean(recentPrices),
      recentPriceSampleSize: recentPrices.length,
      observedLeadTimeHours: leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : null,
      leadTimeSampleSize: leadTimes.length,
    };
  });
}

/**
 * Evidence-only vendor suggestions for one material.
 *
 * There is deliberately no score and no "preferred" flag: a larger completed
 * sample sorts first, recency breaks a tie, and vendor id makes the result
 * deterministic. A configured relationship is not an observation and never
 * enters this function.
 */
export function rankObservedVendors(lines = [], normalizedDescription = '') {
  return deriveVendorMaterialIntelligence(
    lines.filter((line) => line.normalizedDescription === normalizedDescription),
  ).sort((a, b) =>
    b.completedOrderCount - a.completedOrderCount ||
    String(b.lastOrderedAt ?? '').localeCompare(String(a.lastOrderedAt ?? '')) ||
    String(a.vendorId).localeCompare(String(b.vendorId)),
  );
}

/** Vendor facts, without a fabricated score or preference claim. */
export function deriveVendorIntelligence(lines = []) {
  const groups = new Map();
  for (const line of lines) {
    const group = groups.get(line.vendorId) ?? [];
    group.push(line);
    groups.set(line.vendorId, group);
  }

  return [...groups.values()].map((group) => {
    const recent = ordered(group);
    const latest = recent[0];
    const leadTimes = group.map(leadTimeHours).filter((hours) => hours !== null);
    return {
      orgId: latest.orgId,
      vendorId: latest.vendorId,
      vendorNameSnapshot: latest.vendorNameSnapshot,
      completedOrderCount: new Set(group.map((line) => line.purchaseOrderId)).size,
      lastOrderedAt: latest.orderedAt,
      purchasedMaterials: [...new Set(group.map((line) => line.materialDescriptionSnapshot))].sort(),
      observedLeadTimeHours: leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : null,
      leadTimeSampleSize: leadTimes.length,
    };
  });
}
