// ---------------------------------------------------------------------------
// organization.mjs — what has AWE done for this organization?
//
// One question, across every capability deployed there, and the honest answer
// is usually "some of it is measurable and some of it is not". This module
// exists to make that sentence structural rather than a caveat somebody
// remembers to add.
//
// THE FAILURE IT IS BUILT AGAINST. Two capabilities run at Lippolis. One has a
// measured baseline; the other does not. Sum what is measurable, call it "total
// value returned", and the number is arithmetically correct and materially
// false: it describes one capability while being labelled with the
// organization's name. Every reader will take it as the whole.
//
// So a combined total is produced ONLY over capabilities that can be measured,
// it always carries the list of capabilities it excluded and why, and the
// renderer cannot print the total without printing the exclusions. A capability
// with no baseline does not contribute zero — it contributes an entry in
// `capabilitiesNotMeasurable`, which is a different fact.
//
// WHERE THE EVIDENCE CAME FROM IS PART OF THE QUESTION. This view is the one a
// customer or an investor is shown, so it is the one most worth attacking: the
// deployment rehearsal builds the production artifact, starts it with the real
// company name and the real organization id, and drives real purchases through
// it. Its records are the right SHAPE and describe nothing that happened.
//
// The command-line reader already refuses a database that has not declared
// itself production. That is a gate on one caller. Here it is structural: the
// environment the evidence came from is a REQUIRED argument, and anything that
// is not `production` produces a view whose every value figure is UNAVAILABLE
// and which says NOT EVIDENCE in its first line. The counts survive, because
// "the rehearsal ran 38 executions" is a true and useful sentence; the money
// and the hours do not, because those are the sentences somebody quotes.
//
// WHAT THIS MODULE DOES NOT DO, on purpose:
//   · it does not sum across capabilities that price overlapping human work.
//     `assertNoOverlap()` in baseline.mjs already refuses that at the source,
//     and this calls it before totalling anything.
//   · it does not know what a purchase order or a site visit is. It composes
//     `aggregate()` per capability and adds nothing capability-specific. If a
//     purchasing word ever appears in this file, the generalization claim is
//     false and the file is the evidence.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { assertNoOverlap } from './baseline.mjs';
import { aggregate } from './ledger.mjs';
import { present, sum, unavailable, weakestOf } from './provenance.mjs';

/**
 * Every capability that produced a record in the period, in the order they
 * first appear. Derived rather than configured: a capability that ran is in the
 * report whether or not anybody remembered to list it.
 */
export function capabilitiesIn(records) {
  return [...new Set(records.map((r) => r.capability))];
}

/**
 * The organization view.
 *
 * @param {object} spec
 * @param {string} spec.orgId
 * @param {string} spec.environment      where the records came from. REQUIRED.
 *                                       Only 'production' yields value figures.
 * @param {string} [spec.orgName]
 * @param {Array}  spec.records          ExecutionRecords from every capability
 * @param {Array}  spec.baselines
 * @param {Array}  spec.touchStandards
 * @param {string} spec.from
 * @param {string} spec.to
 * @param {object} [spec.overheads]      keyed by capability id; period costs
 * @param {object} [spec.labels]         capability id -> human label
 */
export function organizationValue({
  orgId, orgName = orgId, environment, records, baselines, touchStandards, from, to,
  overheads = {}, labels = {},
}) {
  if (!orgId) throw new Error('an organization view must name the organization it is about');

  // NO DEFAULT, deliberately. A default of 'production' would make every
  // forgetful caller produce quotable figures from whatever it was handed, and
  // a default of 'unstamped' would silently blank a real report. The caller
  // knows where its records came from; it has to say.
  if (!environment) {
    throw new Error(
      'an organization view must state the environment its records came from — ' +
      'a rehearsal database carries the real company name and the real organization id, ' +
      'so nothing about the records themselves can establish it');
  }
  const admissible = environment === 'production';
  /** Why a figure is withheld. One sentence, used everywhere a figure would be. */
  const inadmissible = (unit) => unavailable(unit,
    `${orgId}: these records come from a "${environment}" environment, not production — ` +
    'they describe work that did not happen and carry no value');

  for (const r of records) {
    if (r.orgId !== orgId) {
      throw new Error(`tenant violation: organization view for ${orgId} was handed execution ${r.id} belonging to ${r.orgId}`);
    }
  }

  // Two capabilities pricing the same human work would each return it. Refused
  // before anything is totalled, not reported afterwards.
  assertNoOverlap(baselines.filter((b) => b.orgId === orgId));

  const capabilities = capabilitiesIn(records).map((capability) => {
    const ledger = aggregate({
      orgId, records, baselines, touchStandards, from, to,
      capability, overheads: overheads[capability] ?? [],
    });
    const objectives = ledger.objectiveResults;
    const achieved = objectives.ACHIEVED ?? 0;
    const testable = achieved + (objectives.NOT_ACHIEVED ?? 0);
    const completed = ledger.executionOutcomes.COMPLETED ?? 0;

    return Object.freeze({
      id: capability,
      label: labels[capability] ?? capability,
      executions: ledger.considered,
      unitsOfWork: ledger.unitsOfWork,
      // RELIABILITY IS ABOUT THE RUN, NOT THE RESULT. Kept beside objective
      // success and never merged with it: a workflow can complete every time
      // and achieve the objective half the time, and those are two different
      // conversations with a customer.
      reliability: ledger.unitsOfWork ? completed / ledger.unitsOfWork : null,
      objectiveSuccess: {
        achieved, notAchieved: objectives.NOT_ACHIEVED ?? 0,
        unknown: objectives.UNKNOWN ?? 0, notApplicable: objectives.NOT_APPLICABLE ?? 0,
        testable, rate: testable ? achieved / testable : null,
      },
      humanInterventions: ledger.humanTouches,
      // BLANKED WHEN THE EVIDENCE IS NOT PRODUCTION, at this level too. A gate
      // that only covers the organization total is porous: the per-capability
      // figures are right there, and they are what a slide quotes.
      hoursReturned: admissible ? ledger.grossHoursReturned : inadmissible('hours'),
      netHoursReturned: admissible ? ledger.netHoursReturned : inadmissible('hours'),
      unvaluedHumanMinutes: admissible ? ledger.unvaluedHumanMinutes : inadmissible('minutes'),
      cycle: admissible ? ledger.cycle
        : Object.freeze({ ...ledger.cycle, savedMedianHours: null }),
      labourValueCents: admissible ? ledger.labourValueCents : inadmissible('cents'),
      claimedCents: admissible ? ledger.claimedCents : inadmissible('cents'),
      confidence: admissible ? ledger.confidence
        : Object.freeze({ level: 'NONE', reasons: Object.freeze([`evidence came from a "${environment}" environment`]) }),
      coverage: ledger.coverage,
      excluded: ledger.excluded,
      baselinesUsed: ledger.baselinesUsed,
      measurable: admissible && ledger.grossHoursReturned.known,
      ledger,
    });
  });

  const measurable = capabilities.filter((c) => c.measurable);
  const notMeasurable = capabilities.filter((c) => !c.measurable).map((c) => Object.freeze({
    capability: c.id,
    label: c.label,
    executions: c.executions,
    // The reason is the ledger's own exclusion codes, so it stays true when the
    // ledger's rules change. NOT the quantity's basis: that says "nothing
    // measurable in range", which is the symptom and reads to a customer like
    // "nothing happened". The codes say which of the several different things
    // was missing, and a reader can act on the difference — an unpriced touch
    // standard is a morning's work, an unmeasured baseline is a time study.
    because: admissible ? whyNotMeasurable(c) : c.hoursReturned.basis,
  }));

  // THE TOTAL, over what can be totalled — and it is never presented alone.
  const hoursReturned = !admissible
    ? inadmissible('hours')
    : measurable.length
      ? sum(measurable.map((c) => c.hoursReturned), {
          unit: 'hours',
          basis: `${orgId}: human hours returned across ${measurable.length} measurable capability/capabilities, ${from} to ${to}`,
        })
      : unavailable('hours', `${orgId}: no capability has a measured baseline, so no organization total exists`);

  const labourValueCents = !admissible
    ? inadmissible('cents')
    : measurable.length
      ? sum(measurable.map((c) => c.labourValueCents), {
          unit: 'cents',
          basis: `${orgId}: labour value of time returned, ${from} to ${to}`,
        })
      : unavailable('cents', `${orgId}: nothing measurable to value`);

  const claimedCents = admissible
    ? sum(capabilities.map((c) => c.claimedCents), {
        unit: 'cents',
        basis: `${orgId}: money claimed by attributed business outcomes, ${from} to ${to}`,
      })
    : inadmissible('cents');

  const executions = capabilities.reduce((t, c) => t + c.executions, 0);
  const unitsOfWork = capabilities.reduce((t, c) => t + c.unitsOfWork, 0);
  const interventions = capabilities.reduce((t, c) => t + c.humanInterventions, 0);
  const completed = capabilities.reduce((t, c) => t + (c.ledger.executionOutcomes.COMPLETED ?? 0), 0);
  const achieved = capabilities.reduce((t, c) => t + c.objectiveSuccess.achieved, 0);
  const testable = capabilities.reduce((t, c) => t + c.objectiveSuccess.testable, 0);

  return Object.freeze({
    organization: { id: orgId, name: orgName },
    period: { from, to },

    // Stated, not implied. A consumer that forgets to check `admissible` still
    // finds UNAVAILABLE in every figure it tries to print.
    evidence: Object.freeze({ environment, admissible }),
    capabilities: Object.freeze(capabilities),

    // Counts are safe to add across capabilities: an execution is an execution
    // whatever ran it, and nobody can double-count a count that is already
    // deduplicated per unit of work by the ledger.
    executions,
    unitsOfWork,
    humanInterventions: interventions,
    reliability: unitsOfWork ? completed / unitsOfWork : null,
    objectiveSuccess: { achieved, testable, rate: testable ? achieved / testable : null },

    // Value is NOT safe to add blindly, which is what the next three fields are
    // about.
    hoursReturned,
    labourValueCents,
    claimedCents,
    capabilitiesMeasured: Object.freeze(measurable.map((c) => c.id)),
    capabilitiesNotMeasurable: Object.freeze(notMeasurable),

    // The organization's confidence is its weakest measurable capability's.
    // A strong purchasing figure beside a weak one is not "moderately strong".
    confidence: !admissible
      ? Object.freeze({ level: 'NONE', reasons: Object.freeze([
          `evidence came from a "${environment}" environment, not production`]) })
      : measurable.length
      ? measurable.reduce(
          (worst, c) => (CONFIDENCE_ORDER.indexOf(c.confidence.level) < CONFIDENCE_ORDER.indexOf(worst.level) ? c.confidence : worst),
          measurable[0].confidence)
      : Object.freeze({ level: 'NONE', reasons: Object.freeze(['no capability has a measured baseline']) }),
    evidenceGrade: measurable.length
      ? weakestOf(measurable.map((c) => c.hoursReturned.provenance))
      : 'UNAVAILABLE',
  });
}

const CONFIDENCE_ORDER = ['NONE', 'LOW', 'MODERATE', 'HIGH'];

// The ledger's exclusion codes, in English. Anything the ledger can refuse to
// value has an entry; an unrecognised code is printed raw rather than dropped,
// because a silently missing reason is how a capability disappears from a
// report without anybody noticing.
const EXCLUSION_REASONS = Object.freeze({
  no_baseline_in_force: 'no baseline was in force when the work ran',
  baseline_not_measured: 'the baseline for this work has not been measured',
  touches_not_priced: 'the human actions taken have not been priced by a touch standard',
  objective_unknown: 'the objective has not been tested yet',
  objective_not_applicable: 'the work has no objective that can be tested',
});

function whyNotMeasurable(c) {
  const codes = Object.entries(c.excluded);
  if (codes.length === 0) return c.hoursReturned.basis;
  const total = codes.reduce((t, [, n]) => t + n, 0);
  const parts = codes
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${n} because ${EXCLUSION_REASONS[code] ?? code}`);
  return `${total} of ${c.unitsOfWork} unit(s) of work returned no value figure: ${parts.join('; ')}`;
}

/**
 * The organization view as text.
 *
 * The exclusions are printed with the total, not after it and not optionally.
 * A caller cannot render the number without rendering what it leaves out.
 */
export function render(view) {
  const L = [];
  const pct = (r) => (r === null ? 'not measurable' : `${Math.round(r * 100)}%`);
  const hrs = (q) => (q.known ? `${present(q)} h  [${q.provenance}]` : 'NOT MEASURABLE');
  const money = (q) => (q.known ? `$${(present(q) / 100).toFixed(2)}  [${q.provenance}]` : 'NOT MEASURABLE');

  // FIRST, BEFORE ANYTHING QUOTABLE. Somebody screenshotting the top of this
  // must not be able to crop the caveat off the bottom.
  if (!view.evidence.admissible) {
    L.push('='.repeat(72));
    L.push(`NOT EVIDENCE — these records come from a "${view.evidence.environment}" environment.`);
    L.push('The counts below are real; they describe work that did not happen. Do not quote them.');
    L.push('='.repeat(72));
    L.push('');
  }

  L.push(view.organization.name.toUpperCase());
  L.push(`${view.period.from.slice(0, 10)} to ${view.period.to.slice(0, 10)}`);
  L.push('');

  for (const c of view.capabilities) {
    L.push(`${c.label}`);
    L.push(`  executions            ${c.executions}${c.unitsOfWork !== c.executions ? ` (${c.unitsOfWork} units of work)` : ''}`);
    L.push(`  objective success     ${c.objectiveSuccess.achieved} / ${c.objectiveSuccess.testable} testable  (${pct(c.objectiveSuccess.rate)})`);
    if (c.objectiveSuccess.unknown) L.push(`    not yet testable    ${c.objectiveSuccess.unknown}`);
    L.push(`  reliability           ${pct(c.reliability)}`);
    L.push(`  human interventions   ${c.humanInterventions}`);
    L.push(`  human hours returned  ${hrs(c.hoursReturned)}`);
    L.push(`  cycle time (median)   ${c.cycle.observedMedianHours === null ? 'no data' : `${c.cycle.observedMedianHours.toFixed(1)} h`} over ${c.cycle.observedSamples} sample(s)`);
    L.push(`  cycle time saved      ${c.cycle.savedMedianHours === null ? 'NOT MEASURABLE' : `${c.cycle.savedMedianHours.toFixed(1)} h`}`);
    L.push(`  economic value        ${money(c.labourValueCents)}`);
    L.push(`  evidence confidence   ${c.confidence.level}`);
    L.push('');
  }

  L.push('TOTAL VERIFIED VALUE');
  L.push(`  executions            ${view.executions}`);
  L.push(`  units of work         ${view.unitsOfWork}`);
  L.push(`  objective success     ${view.objectiveSuccess.achieved} / ${view.objectiveSuccess.testable} testable  (${pct(view.objectiveSuccess.rate)})`);
  L.push(`  reliability           ${pct(view.reliability)}`);
  L.push(`  human interventions   ${view.humanInterventions}`);
  L.push(`  human hours returned  ${hrs(view.hoursReturned)}`);
  L.push(`  money saved/created   ${money(view.claimedCents)}`);
  L.push(`  evidence confidence   ${view.confidence.level}`);
  for (const r of view.confidence.reasons) L.push(`      · ${r}`);

  // NOT OPTIONAL. The total above describes only the capabilities named here.
  L.push('');
  if (view.capabilitiesMeasured.length) {
    L.push(`  the total covers      ${view.capabilitiesMeasured.join(', ')}`);
  } else {
    L.push('  the total covers      NOTHING — no capability has a measured baseline');
  }
  if (view.capabilitiesNotMeasurable.length) {
    L.push(`  and EXCLUDES:`);
    for (const c of view.capabilitiesNotMeasurable) {
      L.push(`      · ${c.label} — ${c.executions} execution(s), no value figure`);
      L.push(`        ${c.because}`);
    }
  }
  return L.join('\n');
}
