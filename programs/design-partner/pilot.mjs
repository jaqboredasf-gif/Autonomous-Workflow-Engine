// ---------------------------------------------------------------------------
// pilot.mjs — the smallest external pilot worth offering, and how long it took.
//
// TWO THINGS LIVE HERE because they are the same decision seen from two ends:
// what we promise a design partner, and what it costs us to deliver it.
//
// WHY THE PILOT IS SMALL. AWE is a workflow-engine ambition and Company #2 is
// the first business outside Lippolis to see any of it. Offering the vision
// makes the pilot unfalsifiable — there is no version of "did it work" that a
// disappointed founder cannot argue with — and it makes the deployment large
// enough that a failure anywhere reads as a failure everywhere. One painful
// workflow, one measure, one exit date.
//
// PURE: no clock, no randomness, no I/O. Elapsed time is computed from
// timestamps the caller supplies, never from `Date.now()`, so the measurement
// is reproducible and a rehearsal cannot accidentally record real dates.
// ---------------------------------------------------------------------------

/**
 * THE PILOT, as it would be described to a partner.
 *
 * Every entry is grounded in what the repository can do today. Nothing here is
 * aspirational: `OUT` exists so that the things AWE will eventually do are
 * written down as excluded rather than implied as included.
 */
export const PURCHASING_MATERIALS_PILOT = Object.freeze({
  id: 'purchasing-materials',
  name: 'Material requests, purchase orders and receiving',

  // ONE WORKFLOW, END TO END. The value is in it being complete: a pilot that
  // stops at "approved" leaves the office keeping the paper record anyway,
  // which is the exact pain it was supposed to remove.
  in: Object.freeze([
    'a request raised by field or yard staff, against a job, with a need-by date',
    'stock on hand recorded, and the order quantity derived from it',
    'an approval decision, by whoever this organization says may make it',
    'a purchase order, numbered by this organization\'s own rule, as a PDF',
    'a vendor email DRAFTED for a person to review, edit and send themselves',
    'the order marked placed, then received — in full or in part',
    'completion, which writes immutable history',
    'an audit trail of every one of those acts, and who performed it',
    'the dashboards and reports built on those records',
  ]),

  // WHAT WE ARE NOT DOING, said out loud. Each of these is a real thing a
  // contractor may ask for on the first call, and each answer is "not in this
  // pilot" rather than "no".
  out: Object.freeze([
    { item: 'sending vendor email automatically', why: 'a person reviews every message; the schema enforces it' },
    { item: 'importing open purchase orders or in-flight requests', why: 'the pilot starts on NEW requests; existing orders finish wherever they live now' },
    { item: 'single sign-on', why: 'local accounts for the pilot. Recorded as a want, not promised' },
    { item: 'a custom printed purchase order form', why: 'the standard form carries their letterhead. A custom layout is a day, after the pilot proves the workflow' },
    { item: 'accounting or ERP integration', why: 'accounting reads the AP packet the pilot already produces' },
    { item: 'inventory management', why: 'stock on hand is recorded at the moment of a decision, not tracked as a balance' },
    { item: 'multi-step or value-threshold approval', why: 'role-based approval only. A threshold rule is capability work' },
    { item: 'mobile applications', why: 'the web application works on a phone browser. There is no app' },
    { item: 'a different purchasing lifecycle', why: 'quote-before-order, or blanket orders, is a different capability. This is a QUALIFYING question, not a build' },
  ]),

  // WHAT ONLY THEY CAN TELL US. The technical discovery agenda.
  requiredFromCustomer: Object.freeze([
    'legal name, address and telephone number as they should print on a purchase order',
    'who raises requests, who decides what to buy, who places orders, who signs for deliveries',
    'how purchase orders are numbered today, and the last number issued per scope',
    'their supplier list, with a short code for each',
    'their open jobs, and who is assigned to which',
    'where it will run, and who restarts it when it stops',
    'their timezone',
  ]),

  // ONE MEASURE, agreed before deployment. A pilot whose success is defined
  // afterwards is defined by whoever is unhappiest.
  successMeasure: 'the office stops keeping a parallel record of what was ordered — because PCC is the record',

  // WHAT IT IS COMPARED AGAINST. Frozen BEFORE production records start, or
  // the comparison is unfalsifiable.
  baseline: Object.freeze({
    what: 'how the old process actually worked: the steps, who touched each one, and how long it took',
    when: 'collected and FROZEN before the first production request',
    whose: 'CUSTOMER — only they can produce their own old numbers',
    ifAbsent: 'the pilot may still run and still be useful. It cannot produce a case study.',
  }),

  productionWindow: '30 days of real use, opened only after health verification passes',
  supportBoundary: Object.freeze([
    'business hours, by email, from AWE — for the application',
    'their MSP or IT owns the host, the network, the certificate and the restart',
    'no on-call, no SLA, and it says so in writing',
  ]),
  exitCriteria: Object.freeze([
    'thirty days elapsed, OR',
    'the application owner asks to stop — at any time, for any reason, with no argument',
    'on exit: accounts disabled, evidence preserved, credentials revoked. See offboarding.',
  ]),
});

export const PILOTS = Object.freeze({ [PURCHASING_MATERIALS_PILOT.id]: PURCHASING_MATERIALS_PILOT });

// ---------------------------------------------------------------------------
// TIME TO DEPLOY.
//
// THE COMPANY METRIC. Not "how long did it take" but WHOSE TIME IT WAS, because
// the only number that has to fall is the engineering one. A deployment that
// takes three weeks because a customer's IT department is slow is a scheduling
// fact; one that takes three weeks because Jack was writing code is a product
// fact, and conflating them hides the only trend that matters.
//
//   FOUNDER_CONFIG     Jack answering the dossier, writing profiles, running
//                      the gate. Should be hours, and should stay hours.
//   ENGINEERING        source changes required for THIS organization.
//                      THE TARGET IS ZERO. Any value above zero is the number
//                      to attack, and it is reported separately so it cannot
//                      hide inside a larger total.
//   CUSTOMER_WAIT      waiting on the customer for facts, data or a decision.
//   IT_WAIT            waiting on their IT, MSP or hosting provider.
//
// A REHEARSAL MAY NOT BE REPORTED AS A DEPLOYMENT. `environment` is required
// and anything but 'production' produces a record whose every figure is labelled
// REHEARSAL — for the same reason the proof layer refuses rehearsal records as
// evidence. The mechanics of a synthetic setup are worth measuring; they are not
// worth quoting.
// ---------------------------------------------------------------------------

export const TIME_CATEGORIES = Object.freeze(['FOUNDER_CONFIG', 'ENGINEERING', 'CUSTOMER_WAIT', 'IT_WAIT']);

/** One period of work or waiting, attributed. */
export function definePeriod({ category, hours, note = null }) {
  if (!TIME_CATEGORIES.includes(category)) {
    throw new Error(`unknown time category ${JSON.stringify(category)} — one of: ${TIME_CATEGORIES.join(', ')}`);
  }
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0) throw new Error(`a period needs a non-negative number of hours (got ${JSON.stringify(hours)})`);
  return Object.freeze({ category, hours: h, note });
}

/**
 * Time from design-partner commitment to a working pilot.
 *
 * @param {object} spec
 * @param {string} spec.orgId
 * @param {string} spec.environment      'production' | 'rehearsal'. REQUIRED.
 * @param {string} spec.committedAt      ISO date the partner said yes
 * @param {string} [spec.liveAt]         ISO date the first real request was raised
 * @param {Array}  spec.periods          definePeriod() results
 */
export function timeToDeploy({ orgId, environment, committedAt, liveAt = null, periods = [] }) {
  if (!orgId) throw new Error('a time-to-deploy record must name the organization');
  if (!environment) {
    throw new Error(
      'a time-to-deploy record must state which environment it describes. ' +
        'A rehearsal measures setup mechanics and is not a deployment; omitting this is how one becomes the other.',
    );
  }
  if (!committedAt) throw new Error('a time-to-deploy record needs the date the partner committed');

  const isProduction = environment === 'production';
  const byCategory = Object.fromEntries(TIME_CATEGORIES.map((c) => [c, 0]));
  for (const p of periods) byCategory[p.category] += p.hours;
  const totalHours = TIME_CATEGORIES.reduce((n, c) => n + byCategory[c], 0);

  const elapsedDays = liveAt
    ? Math.round((Date.parse(liveAt) - Date.parse(committedAt)) / 86_400_000)
    : null;

  return Object.freeze({
    orgId,
    environment,
    // The label a reader cannot miss, on the object rather than in a caveat.
    label: isProduction ? 'DEPLOYMENT' : 'REHEARSAL — setup mechanics only, not a customer deployment',
    admissible: isProduction,
    committedAt,
    liveAt,
    live: Boolean(liveAt),
    elapsedDays,
    hoursByCategory: Object.freeze(byCategory),
    totalHours,

    // THE NUMBER THE COMPANY IS TRYING TO DRIVE TO ZERO, surfaced alone.
    customEngineeringHours: byCategory.ENGINEERING,
    zeroEngineering: byCategory.ENGINEERING === 0,

    // AWE's own time, separated from everybody else's waiting. This is the part
    // we control and therefore the part we are accountable for.
    aweHours: byCategory.FOUNDER_CONFIG + byCategory.ENGINEERING,
    waitingHours: byCategory.CUSTOMER_WAIT + byCategory.IT_WAIT,

    periods: Object.freeze([...periods]),
    summary: `${orgId} (${isProduction ? 'production' : 'REHEARSAL'}): ` +
      `${byCategory.ENGINEERING}h custom engineering, ${byCategory.FOUNDER_CONFIG}h founder configuration, ` +
      `${byCategory.CUSTOMER_WAIT}h waiting on the customer, ${byCategory.IT_WAIT}h waiting on IT` +
      (elapsedDays === null ? '; not live' : `; live after ${elapsedDays} days`),
  });
}

/**
 * The measured second-organization REHEARSAL.
 *
 * NOT A CUSTOMER DEPLOYMENT, and labelled so by construction. What it honestly
 * records is the mechanical cost of standing up an organization once the
 * dossier exists — and the one figure worth having: the source changes required
 * FOR NORTHGATE SPECIFICALLY, which is zero.
 *
 * ENGINEERING IS ZERO AND THAT CLAIM IS NARROW. Considerable code changed to
 * make a second organization possible AT ALL — the vendor-sequence numbering
 * rule, the role vocabulary, the page titles, the brand. None of it was
 * Northgate-specific: every change removed a Lippolis assumption from the
 * product, and Customer #3 inherits all of it. That is the distinction the
 * metric exists to draw, and scripts/eval-second-customer.mjs is what makes it
 * checkable rather than asserted.
 */
export const NORTHGATE_REHEARSAL = timeToDeploy({
  orgId: 'org-002-trades',
  environment: 'rehearsal',
  committedAt: '2026-09-01',
  liveAt: '2026-09-01',
  periods: [
    definePeriod({ category: 'FOUNDER_CONFIG', hours: 1,
      note: 'answering the dossier, writing the authorization profile and the manifest, running the gate' }),
    definePeriod({ category: 'ENGINEERING', hours: 0,
      note: 'no source change was required FOR NORTHGATE. Product-level extraction is not counted here — it is not per-organization cost' }),
    definePeriod({ category: 'CUSTOMER_WAIT', hours: 0, note: 'synthetic: there is no customer to wait for' }),
    definePeriod({ category: 'IT_WAIT', hours: 0, note: 'synthetic: there is no IT department to wait for' }),
  ],
});
