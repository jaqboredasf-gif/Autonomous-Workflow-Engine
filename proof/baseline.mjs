// ---------------------------------------------------------------------------
// baseline.mjs — what the work cost before AWE, and what it costs during.
//
// AWE cannot honestly claim improvement without knowing the previous state.
// This module is the governed record of that previous state, and of the only
// other figure the arithmetic needs: how long a human spends on one interaction
// with AWE itself.
//
// Both live here because they are the same concept seen twice — the price, in
// human minutes, of one step of a process. The BASELINE prices the steps of the
// old manual process. The TOUCH STANDARD prices the steps of the new one. Hours
// returned is the difference, and it is meaningless unless both sides were
// obtained the same way and can say so.
//
// WHY A TOUCH STANDARD EXISTS AT ALL — stated plainly, because it is the
// weakest joint in the whole design and hiding it would be the failure mode
// this module is built to prevent:
//
//   PCC records WHEN a human acted. It does not record HOW LONG they spent.
//   `purchase_activity_log` has `actor_id`, `action`, `at`, `seq` and no
//   duration column, because none of the work that built it needed one.
//
// So "observed human handling under AWE" is, today, a COUNT of interactions
// multiplied by a per-interaction duration. That product is at best ESTIMATED
// and this module makes it impossible to record it as anything better: a touch
// standard obtained by asking somebody is SELF_REPORTED, and a derived total
// grades at its weakest input. A stopwatch reading over a real user promotes it
// to MEASURED for that one action and no others.
//
// The alternative — instrumenting dwell time in the browser — is a real option
// and a better one. It is not built, so it is not claimed. See
// `docs/proof/BASELINE_METHODOLOGY.md`.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { PROVENANCE_GRADES, quantity, source, sum, weakestOf } from './provenance.mjs';

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

/**
 * One step of the process as humans performed it before AWE.
 *
 * `minutes` is the human handling time for ONE occurrence of the step — the
 * time a person is occupied, not the elapsed time between steps. Somebody
 * waiting two days for a vendor to reply is not working for two days, and a
 * baseline that counts elapsed time is the single fastest way to manufacture
 * an ROI figure nobody can defend.
 */
export function baselineStep({ id, label, minutes, provenance, sources = [], performedBy = null, note = null }) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(id))) throw new Error(`baseline step id must be snake_case: ${id}`);
  if (!PROVENANCE_GRADES.includes(provenance)) throw new Error(`unknown provenance grade: ${provenance}`);
  const q = quantity({
    value: provenance === 'UNAVAILABLE' ? null : minutes,
    unit: 'minutes',
    provenance,
    sources,
    basis: `baseline step "${label}": human handling time per occurrence`,
  });
  return Object.freeze({ id, label, minutes: q, performedBy, note });
}

/**
 * A named, versioned, organization-bound statement of the old process.
 *
 * VERSIONED because baselines drift. A business that reorganises its purchasing
 * desk has a different old process, and value measured against the previous
 * version is not comparable. An execution binds to the version in force when it
 * started (see `versionInForce`), and an aggregate spanning two versions
 * reports both rather than blending them.
 *
 * `coversSteps` names, in the CAPABILITY's own vocabulary, which parts of the
 * work this baseline claims. Two baselines for one organization that claim the
 * same step is the double-counting failure, and `assertNoOverlap` refuses it.
 */
export function defineBaseline({
  id, version, orgId, process: processName, description,
  effectiveFrom, effectiveTo = null,
  steps, coversSteps, unitOfWork,
  labourRateCentsPerHour = null, labourRateProvenance = 'UNAVAILABLE', labourRateSources = [],
  cycleHours = null, cycleProvenance = 'UNAVAILABLE', cycleSources = [],
  reviewedBy = null, reviewedAt = null,
}) {
  if (!id || !version || !orgId) throw new Error('a baseline needs an id, a version and an orgId');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error(`baseline ${id} has no steps`);
  if (!Array.isArray(coversSteps) || coversSteps.length === 0) {
    throw new Error(`baseline ${id} must name the work it covers — an unbounded baseline cannot be checked for overlap`);
  }
  if (!effectiveFrom) throw new Error(`baseline ${id} needs effectiveFrom — a baseline with no date cannot be bound to an execution`);
  if (!unitOfWork) throw new Error(`baseline ${id} needs a unitOfWork — "19 minutes" per WHAT`);

  const seen = new Set();
  for (const s of steps) {
    if (seen.has(s.id)) throw new Error(`baseline ${id} repeats step ${s.id}`);
    seen.add(s.id);
  }

  const labourRate = quantity({
    value: labourRateProvenance === 'UNAVAILABLE' ? null : labourRateCentsPerHour,
    unit: 'cents',
    provenance: labourRateProvenance,
    sources: labourRateSources,
    basis: `fully-loaded labour rate for ${processName} at ${orgId}, per hour`,
  });

  // Elapsed time the OLD process took, end to end. A different question from
  // the handling total above and recorded separately: a process can take four
  // days of elapsed time and nineteen minutes of anybody's attention, and
  // improving one says nothing about the other.
  const cycle = quantity({
    value: cycleProvenance === 'UNAVAILABLE' ? null : cycleHours,
    unit: 'hours',
    provenance: cycleProvenance,
    sources: cycleSources,
    basis: `elapsed time for ${processName} at ${orgId} before AWE, per ${unitOfWork}`,
  });

  return Object.freeze({
    id, version, orgId, process: processName, description,
    effectiveFrom, effectiveTo,
    steps: Object.freeze([...steps]),
    coversSteps: Object.freeze([...coversSteps]),
    unitOfWork,
    labourRate,
    cycle,
    reviewedBy, reviewedAt,
    key: `${orgId}:${id}:${version}`,
  });
}

/**
 * Total human handling time for one unit of work under the old process.
 *
 * A baseline whose steps are all UNAVAILABLE totals to UNAVAILABLE, not zero,
 * and every downstream figure that depends on it becomes unavailable too. That
 * cascade is the intended behaviour: an organization that has not measured its
 * old process gets no hours-returned figure at all until it does. There is no
 * default, no placeholder and no industry average.
 */
export function baselineHandlingMinutes(baseline) {
  const known = baseline.steps.filter((s) => s.minutes.known);
  if (known.length === 0) {
    return quantity({
      value: null, unit: 'minutes', provenance: 'UNAVAILABLE',
      basis: `baseline ${baseline.key}: no step has been measured, so the old process has no total`,
    });
  }
  if (known.length < baseline.steps.length) {
    const missing = baseline.steps.filter((s) => !s.minutes.known).map((s) => s.id);
    // A PARTIAL baseline is refused rather than under-reported. Summing the
    // known steps would produce a smaller old-process cost, which makes AWE
    // look WORSE — but it is still a wrong number presented as a right one, and
    // the direction of an error is not what makes it acceptable.
    return quantity({
      value: null, unit: 'minutes', provenance: 'UNAVAILABLE',
      basis: `baseline ${baseline.key}: ${missing.length} step(s) not measured (${missing.join(', ')}) — a partial baseline is not a baseline`,
    });
  }
  return sum(known.map((s) => s.minutes), {
    unit: 'minutes',
    basis: `baseline ${baseline.key}: total human handling per ${baseline.unitOfWork}`,
  });
}

/** The grade of the whole baseline: its weakest step. */
export function baselineGrade(baseline) {
  return weakestOf(baseline.steps.map((s) => s.minutes.provenance));
}

/**
 * Which version of a baseline governed a given moment.
 *
 * Returns null rather than the nearest match. An execution that started before
 * any baseline existed has no baseline, and valuing it against one written
 * afterwards is retroactive justification, not measurement.
 */
export function versionInForce(baselines, { orgId, id, at }) {
  const candidates = baselines.filter((b) =>
    b.orgId === orgId && b.id === id &&
    String(b.effectiveFrom) <= String(at) &&
    (b.effectiveTo === null || String(at) < String(b.effectiveTo)));
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom))).at(-1);
}

/**
 * Refuse two baselines that claim the same work for the same organization at
 * the same time.
 *
 * Without this, a purchasing baseline and a future "office admin" baseline can
 * both claim "PO preparation" and the ledger will bank those minutes twice.
 * Overlapping capabilities claiming the same savings is the most plausible way
 * a genuinely well-built system produces a fraudulent total.
 */
export function assertNoOverlap(baselines) {
  const problems = [];
  for (let i = 0; i < baselines.length; i++) {
    for (let j = i + 1; j < baselines.length; j++) {
      const a = baselines[i];
      const b = baselines[j];
      if (a.orgId !== b.orgId) continue;
      if (a.id === b.id) continue;                       // versions of one baseline
      const overlapsInTime =
        (b.effectiveTo === null || String(a.effectiveFrom) < String(b.effectiveTo)) &&
        (a.effectiveTo === null || String(b.effectiveFrom) < String(a.effectiveTo));
      if (!overlapsInTime) continue;
      const shared = a.coversSteps.filter((s) => b.coversSteps.includes(s));
      if (shared.length) {
        problems.push({ orgId: a.orgId, a: a.key, b: b.key, sharedWork: shared });
      }
    }
  }
  if (problems.length) {
    const first = problems[0];
    throw new Error(
      `baselines ${first.a} and ${first.b} both claim ${first.sharedWork.join(', ')} for ${first.orgId} — ` +
      'the same human work cannot be returned twice');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Touch standards — the cost of the new process
// ---------------------------------------------------------------------------

/**
 * How long one human interaction with AWE takes, by the action the audit log
 * records.
 *
 * Keyed by the capability's OWN action vocabulary — for PCC that is
 * `ACTIVITY_ACTIONS` in `domain/activity.mjs` — so the standard and the
 * evidence line up on the same word, and an action nobody has priced is
 * detected rather than assumed free.
 */
export function defineTouchStandard({ id, version, orgId, capability, effectiveFrom, effectiveTo = null, actions, defaultMinutes = null }) {
  if (!id || !version || !orgId || !capability) throw new Error('a touch standard needs id, version, orgId and capability');
  if (!effectiveFrom) throw new Error(`touch standard ${id} needs effectiveFrom`);
  const table = new Map();
  for (const [action, spec] of Object.entries(actions)) {
    table.set(action, quantity({
      value: spec.provenance === 'UNAVAILABLE' ? null : spec.minutes,
      unit: 'minutes',
      provenance: spec.provenance,
      sources: spec.sources ?? [],
      basis: `human minutes for one "${action}" interaction with ${capability}`,
    }));
  }
  return Object.freeze({
    id, version, orgId, capability, effectiveFrom, effectiveTo,
    actions: table,
    /**
     * What an action nobody priced costs.
     *
     * NULL by default, and null means UNAVAILABLE, which propagates. Defaulting
     * an unpriced interaction to zero would mean every new feature silently
     * increases measured savings the moment it ships, which is precisely
     * backwards.
     */
    defaultMinutes,
    key: `${orgId}:${id}:${version}`,
  });
}

/** What one recorded interaction cost a human. Unknown actions are UNAVAILABLE. */
export function touchMinutes(standard, action) {
  const known = standard.actions.get(action);
  if (known) return known;
  if (standard.defaultMinutes === null) {
    return quantity({
      value: null, unit: 'minutes', provenance: 'UNAVAILABLE',
      basis: `"${action}" has no entry in touch standard ${standard.key} — an unpriced interaction is unknown, not free`,
    });
  }
  return quantity({
    value: standard.defaultMinutes, unit: 'minutes', provenance: 'INFERRED',
    sources: [source({ kind: 'DERIVED', ref: `${standard.key} default` })],
    basis: `"${action}" is not individually priced; the standard's default applies`,
  });
}

/** Which actions the capability can emit that the standard has not priced. */
export function unpricedActions(standard, knownActions) {
  return knownActions.filter((a) => !standard.actions.has(a));
}
