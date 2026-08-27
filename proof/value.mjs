// ---------------------------------------------------------------------------
// value.mjs — what one execution was worth, and the refusals that keep that
// honest.
//
// THE DEEP MODULE. Everything difficult about economic claims is inside here:
// the tenant check, the baseline binding, the objective gate, the touch
// arithmetic, the labour/elapsed separation, the grade degradation. The
// interface is one function.
//
//     valueOf(record, { baselines, touchStandards })  ->  Valuation
//
// A consumer — a dashboard, AXIS, a case study, a customer report — calls that
// and reads fields. None of them may compute an hour or a dollar, and none of
// them needs to know that a purchase request is a purchase request.
//
// THE ARITHMETIC, and why each term is there
//
//     human minutes returned
//        = baseline human handling for one unit of work
//        − human minutes actually spent operating AWE on this unit
//
// with three gates in front of it, in this order:
//
//   1. SAME ORGANIZATION. A baseline belonging to another tenant is a hard
//      throw, not a mismatch warning. Metrics that can cross a tenant boundary
//      are a security defect wearing a reporting costume.
//
//   2. THE BASELINE THAT WAS IN FORCE. Bound by the execution's start instant,
//      not by "the current one". A baseline written in March cannot value work
//      done in January; that is retroactive justification.
//
//   3. THE OBJECTIVE ACTUALLY HAPPENED. This is the gate that does most of the
//      work, and it is the one most systems do not have:
//
//        ACHIEVED       -> baseline minutes were genuinely displaced.
//        NOT_APPLICABLE -> the workflow correctly did not produce the outcome
//                          (a declined purchase). Excluded from the saving; its
//                          human cost is still reported by the ledger.
//        NOT_ACHIEVED  -> nothing was displaced. A human still has to do the
//                         whole job, so the minutes spent on AWE are a NET
//                         COST and the figure is NEGATIVE. Not zero, and not
//                         excluded from the total.
//        UNKNOWN       -> UNAVAILABLE. Not zero, not optimistic, not deferred
//                         to a later reconciliation that never runs. A purchase
//                         that has not arrived has not saved anybody anything
//                         yet, and the ledger simply reports how many
//                         executions are in this state.
//
// WHAT IS DELIBERATELY NOT IN THE ARITHMETIC
//
//   * elapsed time. `record.cycle` exists and this module reads it only for the
//     cycle-time comparison, which produces hours of ELAPSED improvement and is
//     never converted to labour or to money. Machine time is not labour.
//   * anything about how many steps AWE performed. A workflow with forty
//     automated steps and one with two are worth the same if they displace the
//     same human minutes.
//   * revenue, unless somebody recorded a business outcome saying so, with
//     evidence and an attribution grade. Execution success creates no revenue
//     claim on its own.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { baselineHandlingMinutes, touchMinutes, versionInForce } from './baseline.mjs';
import { chargeableTouches } from './execution.mjs';
import {
  derive, present, quantity, source, sum, toHours, unavailable, weakestOf,
} from './provenance.mjs';

/**
 * Why an execution could not be valued. A closed vocabulary, because "not
 * valued" with no reason is indistinguishable from a bug, and the ledger prints
 * these counts beside every total so a reader can see what the total is missing.
 */
export const EXCLUSION_REASONS = Object.freeze([
  'no_baseline_in_force',
  'baseline_not_measured',
  'objective_unknown',
  'objective_not_applicable',
  'touches_not_priced',
]);

/**
 * How much human time this execution actually consumed.
 *
 * Per touch, an observed duration beats the standard. That ordering is the
 * upgrade path: the day a dwell-time instrument starts filling
 * `observedMinutes`, this figure becomes MEASURED with no change anywhere else.
 */
export function observedHumanMinutes(record, standard) {
  const touches = chargeableTouches(record);
  if (touches.length === 0) {
    // A genuinely untouched execution. Zero, and MEASURED — the audit log
    // recording no human rows IS the measurement, and this is the one place a
    // zero is a fact rather than a missing value.
    return quantity({
      value: 0, unit: 'minutes', provenance: 'MEASURED',
      sources: [source({ kind: 'SYSTEM_RECORD', ref: `${record.capability} audit trail for ${record.id}: no human actor rows` })],
      basis: 'no human touched this execution',
    });
  }
  const per = touches.map((t) => {
    if (t.observedMinutes !== null) {
      return quantity({
        value: t.observedMinutes, unit: 'minutes', provenance: 'MEASURED',
        sources: [source({ kind: 'OBSERVED_TIMING', ref: `${record.id}:${t.action}@${t.at}` })],
        basis: `observed duration of one "${t.action}" interaction`,
      });
    }
    return touchMinutes(standard, t.action);
  });

  // One unpriced interaction makes the whole figure unknown. Skipping it would
  // UNDER-count time spent, which OVER-states hours returned — the error that
  // flatters us, and therefore the one to refuse loudest.
  const unpriced = touches.filter((t, i) => !per[i].known);
  if (unpriced.length) {
    return quantity({
      value: null, unit: 'minutes', provenance: 'UNAVAILABLE',
      basis: `${unpriced.length} interaction(s) have no priced duration (${[...new Set(unpriced.map((t) => t.action))].join(', ')}) — unpriced human work is unknown, not free`,
    });
  }

  return sum(per, {
    unit: 'minutes',
    basis: `human minutes spent operating ${record.capability} on ${record.scopeKey}`,
  });
}

/**
 * Cycle-time comparison: elapsed before vs elapsed now.
 *
 * Reported as hours and as a ratio, both graded. Never converted into labour or
 * money anywhere in this system.
 */
export function cycleImprovement(record, baseline) {
  const observed = record.cycle?.elapsed ?? unavailable('hours', 'no elapsed time recorded for this execution');
  const before = baseline.cycle;
  const savedHours = derive({ before, observed }, ({ before: b, observed: o }) => b - o, {
    unit: 'hours',
    basis: `elapsed time saved on ${record.scopeKey}: ${baseline.key} cycle minus observed cycle`,
  });
  const ratio = derive({ before, observed }, ({ before: b, observed: o }) => (b === 0 ? NaN : (b - o) / b), {
    unit: 'ratio',
    basis: `proportional cycle-time reduction on ${record.scopeKey}`,
  });
  return { before, observed, savedHours, ratio };
}

/**
 * Value one execution.
 *
 * @param {object} record          an ExecutionRecord
 * @param {object} deps
 * @param {Array}  deps.baselines  every baseline version known
 * @param {Array}  deps.touchStandards every touch standard version known
 * @returns {object} Valuation — always returned, never thrown for missing
 *                   evidence. Missing evidence is a RESULT (unavailable, with a
 *                   reason), because an ROI system whose gaps throw is an ROI
 *                   system somebody wraps in a try/catch that swallows them.
 *                   It DOES throw for tenant violations, which are not gaps.
 */
export function valueOf(record, { baselines, touchStandards }) {
  const baseline = versionInForce(baselines, {
    orgId: record.orgId, id: record.baselineId, at: record.startedAt,
  });

  // --- gate 1: tenant isolation -------------------------------------------
  // Checked against every candidate, not just the selected one, so a baseline
  // from another organization cannot be silently passed over and later picked
  // up by a caller that filtered differently.
  for (const b of baselines) {
    if (b.id === record.baselineId && b.orgId !== record.orgId) {
      throw new Error(
        `tenant violation: execution ${record.id} belongs to ${record.orgId} but baseline ${b.key} belongs to ${b.orgId}`);
    }
  }

  const base = {
    executionId: record.id,
    orgId: record.orgId,
    capability: record.capability,
    workflow: record.workflow,
    scopeKey: record.scopeKey,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    executionOutcome: record.executionOutcome,
    executionSucceeded: record.executionSucceeded,
    objectiveResult: record.objectiveResult,
    objective: record.objective,
    outcomes: record.outcomes,
    humanTouchCount: record.humanTouches.length,
    retries: record.retries,
  };

  if (!baseline) {
    return frozen({
      ...base,
      baselineKey: null,
      valued: false,
      excludedBecause: 'no_baseline_in_force',
      baselineMinutes: unavailable('minutes', `no version of baseline "${record.baselineId}" was in force at ${record.startedAt}`),
      observedMinutes: unavailable('minutes', 'not computed: no baseline'),
      minutesReturned: unavailable('minutes', `no version of baseline "${record.baselineId}" was in force at ${record.startedAt}`),
      hoursReturned: unavailable('hours', `no version of baseline "${record.baselineId}" was in force at ${record.startedAt}`),
      labourValueCents: unavailable('cents', 'not computed: no baseline'),
      // The AWE-era elapsed time IS measured even when nothing can be valued,
      // and dropping it here would discard a real observation because a
      // different one is missing. Only the comparison is unavailable.
      cycle: {
        before: unavailable('hours', 'no baseline in force'),
        observed: record.cycle?.elapsed ?? unavailable('hours', 'no elapsed time recorded for this execution'),
        savedHours: unavailable('hours', 'no baseline in force, so there is nothing to compare against'),
        ratio: unavailable('ratio', 'no baseline in force, so there is nothing to compare against'),
      },
      claims: [],
    });
  }

  const standard = pickStandard(touchStandards, record);
  const baselineMinutes = baselineHandlingMinutes(baseline);
  const observedMinutes = standard
    ? observedHumanMinutes(record, standard)
    : unavailable('minutes', `no touch standard in force for ${record.capability} at ${record.startedAt}`);

  const { minutesReturned, excludedBecause } = returnedMinutes({
    record, baseline, baselineMinutes, observedMinutes,
  });
  const hoursReturned = toHours(minutesReturned);
  const labourValueCents = derive(
    { hours: hoursReturned, rate: baseline.labourRate },
    ({ hours, rate }) => hours * rate,
    {
      unit: 'cents',
      basis: `labour value of time returned on ${record.scopeKey}, at the ${baseline.orgId} loaded rate`,
    },
  );

  return frozen({
    ...base,
    baselineKey: baseline.key,
    touchStandardKey: standard?.key ?? null,
    valued: minutesReturned.known,
    excludedBecause,
    baselineMinutes,
    observedMinutes,
    minutesReturned,
    hoursReturned,
    labourValueCents,
    cycle: cycleImprovement(record, baseline),
    // Money that is NOT labour — protected, avoided, created, accelerated.
    // Only ever what a business outcome explicitly claimed, with evidence.
    claims: valueClaims(record),
  });
}

function pickStandard(touchStandards, record) {
  const all = touchStandards ?? [];
  const forCapability = all.filter((s) => s.capability === record.capability);
  const mine = forCapability.filter((s) => s.orgId === record.orgId);
  const foreign = forCapability.filter((s) => s.orgId !== record.orgId);

  // A foreign standard sitting BESIDE this organization's own is a widened
  // query, and is filtered out below. A foreign standard that is the ONLY one
  // for this capability is a tenant boundary about to be crossed, and only a
  // throw is safe: skipping it would leave the execution unpriced, which reads
  // as missing evidence rather than as a leak somebody nearly caused.
  if (mine.length === 0 && foreign.length > 0) {
    throw new Error(
      `tenant violation: execution ${record.id} belongs to ${record.orgId} but the only touch standard for ` +
      `${record.capability} belongs to ${foreign[0].orgId}`);
  }

  const at = String(record.startedAt);
  const candidates = mine.filter((s) =>
    String(s.effectiveFrom) <= at && (s.effectiveTo === null || at < String(s.effectiveTo)));
  return candidates.sort((a, b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom))).at(-1) ?? null;
}

/**
 * The objective gate, expressed as arithmetic rather than as a policy comment.
 */
function returnedMinutes({ record, baseline, baselineMinutes, observedMinutes }) {
  if (record.objectiveResult === 'NOT_APPLICABLE') {
    // The workflow ran and the right answer was "no". The baseline prices a
    // completed unit of work, so there is nothing here to compare against —
    // but the human minutes were spent, and `ledger.mjs` reports them under
    // `unvaluedHumanMinutes` rather than letting a decline read as free.
    return {
      excludedBecause: 'objective_not_applicable',
      minutesReturned: quantity({
        value: null, unit: 'minutes', provenance: 'UNAVAILABLE',
        basis: `${record.scopeKey}: the objective did not apply to this unit of work, and the baseline prices a completed one`,
      }),
    };
  }
  if (record.objectiveResult === 'UNKNOWN') {
    return {
      excludedBecause: 'objective_unknown',
      minutesReturned: quantity({
        value: null, unit: 'minutes', provenance: 'UNAVAILABLE',
        basis: `${record.scopeKey}: whether the objective was achieved is not yet known, so no human time can be claimed as returned`,
      }),
    };
  }

  if (record.objectiveResult === 'NOT_ACHIEVED') {
    // The old process still has to happen. Nothing was displaced, and the
    // minutes spent operating AWE are a real cost carried into the total.
    if (!observedMinutes.known) {
      return {
        excludedBecause: 'touches_not_priced',
        minutesReturned: quantity({
          value: null, unit: 'minutes', provenance: 'UNAVAILABLE',
          basis: `${record.scopeKey}: the objective was not achieved and the cost of the attempt is not priced`,
        }),
      };
    }
    return {
      excludedBecause: null,
      minutesReturned: quantity({
        value: -observedMinutes.value,
        unit: 'minutes',
        provenance: observedMinutes.provenance,
        sources: [...observedMinutes.sources],
        basis: `${record.scopeKey}: the objective was NOT achieved, so no baseline work was displaced — the human minutes spent are a net cost`,
      }),
    };
  }

  if (!baselineMinutes.known) {
    return {
      excludedBecause: 'baseline_not_measured',
      minutesReturned: quantity({
        value: null, unit: 'minutes', provenance: 'UNAVAILABLE',
        basis: baselineMinutes.basis,
      }),
    };
  }
  if (!observedMinutes.known) {
    return {
      excludedBecause: 'touches_not_priced',
      minutesReturned: quantity({
        value: null, unit: 'minutes', provenance: 'UNAVAILABLE',
        basis: observedMinutes.basis,
      }),
    };
  }

  return {
    excludedBecause: null,
    minutesReturned: quantity({
      value: baselineMinutes.value - observedMinutes.value,
      unit: 'minutes',
      provenance: weakestOf([baselineMinutes.provenance, observedMinutes.provenance]),
      sources: [...baselineMinutes.sources, ...observedMinutes.sources],
      basis: `${record.scopeKey}: ${baseline.key} handling time (${present(baselineMinutes)} min) minus human minutes spent under AWE (${present(observedMinutes)} min)`,
    }),
  };
}

/**
 * Money claims that do not come from labour.
 *
 * Read from recorded business outcomes only. There is no path from "the
 * execution succeeded" to a dollar here, and that absence is the design.
 * `attribution: 'CORRELATION_ONLY'` claims are returned but flagged, so a
 * report can show them separately rather than a caller deciding to include
 * them silently.
 */
export function valueClaims(record) {
  const out = [];
  for (const o of record.outcomes ?? []) {
    for (const c of o.claims ?? []) {
      out.push(Object.freeze({
        outcome: o.name,
        kind: c.kind,
        amount: c.amount,
        attribution: o.attribution,
        countsTowardTotal: o.attribution !== 'CORRELATION_ONLY' && c.amount.known,
      }));
    }
  }
  return Object.freeze(out);
}

function frozen(v) {
  return Object.freeze(v);
}

/**
 * The money kinds a business outcome may claim. Separate from labour value,
 * which is computed; these are asserted with evidence.
 */
export const CLAIM_KINDS = Object.freeze([
  'MONEY_SAVED',        // an expense that is now smaller
  'MONEY_PROTECTED',    // a loss that would have occurred and did not
  'REVENUE_CREATED',    // income that exists because of this
  'REVENUE_ACCELERATED',// income that arrived earlier
  'COST_AVOIDED',       // a cost never incurred
]);

export function valueClaim({ kind, amountCents, provenance, sources = [], basis }) {
  if (!CLAIM_KINDS.includes(kind)) throw new Error(`unknown claim kind: ${kind}`);
  return Object.freeze({
    kind,
    amount: quantity({
      value: provenance === 'UNAVAILABLE' ? null : amountCents,
      unit: 'cents', provenance, sources, basis,
    }),
  });
}
