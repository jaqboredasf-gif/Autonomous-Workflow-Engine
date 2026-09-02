// Derived metrics — everything the repository can compute for Jack so he does
// not have to, and nothing it cannot compute honestly.
//
// The hard rule enforced here: a number computed from documentary claims and a
// number computed from a human's estimate are DIFFERENT KINDS OF NUMBER and are
// never mixed into one figure without saying so. Every derived metric carries a
// `basis` of 'documentary' | 'estimate_propagated', and estimate-propagated
// metrics carry a low/high range inherited from the estimate they came from.
//
// Pure and offline: no I/O, no clock, no network.

const num = (r, k) => {
  const c = r.fields?.[k];
  return c && c.confidence !== 'unknown' && typeof c.value === 'number' ? c.value : null;
};
const val = (r, k) => {
  const c = r.fields?.[k];
  return c && c.confidence !== 'unknown' ? c.value : null;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

const DAY_MS = 86_400_000;

/**
 * Documentary summary of a set of baseline_po records.
 * Every figure here is traceable to a piece of paper.
 */
export function summarizePOs(pos) {
  if (!pos.length) return { record_count: 0 };

  const dates = pos.map((p) => val(p, 'po_date')).filter(Boolean).sort();
  const first = dates[0] ?? null;
  const last = dates[dates.length - 1] ?? null;
  const spanDays = first && last
    ? Math.round((Date.parse(last) - Date.parse(first)) / DAY_MS) + 1
    : null;

  const vendors = pos.map((p) => val(p, 'vendor')).filter(Boolean);
  const vendorCounts = {};
  for (const v of vendors) vendorCounts[v] = (vendorCounts[v] || 0) + 1;
  const vendorRanked = Object.entries(vendorCounts).sort((a, b) => b[1] - a[1]);

  const amounts = pos.map((p) => num(p, 'total_amount')).filter((x) => x !== null);
  const lineItems = pos.map((p) => num(p, 'line_item_count')).filter((x) => x !== null);
  const amendments = pos.map((p) => num(p, 'amendments_on_face')).filter((x) => x !== null);

  const jobRefs = pos.map((p) => val(p, 'job_reference')).filter(Boolean);
  const stockCount = jobRefs.filter((j) => String(j).trim().toUpperCase() === 'STOCK').length;

  const approvalMarks = pos.map((p) => val(p, 'approval_marking')).filter(Boolean);
  const approved = approvalMarks.filter((m) => m === 'signature' || m === 'initials' || m === 'stamp').length;

  const weeks = spanDays ? spanDays / 7 : null;

  // Per-field documentary coverage: how much of the paper was actually readable.
  const coverage = {};
  const fieldKeys = new Set();
  for (const p of pos) for (const k of Object.keys(p.fields || {})) fieldKeys.add(k);
  for (const k of fieldKeys) {
    const present = pos.filter((p) => p.fields?.[k] && p.fields[k].confidence !== 'unknown').length;
    coverage[k] = { present, of: pos.length, pct: round((present / pos.length) * 100, 1) };
  }

  return {
    basis: 'documentary',
    record_count: pos.length,
    date_first: first,
    date_last: last,
    span_days: spanDays,
    pos_per_week: weeks ? round(pos.length / weeks, 2) : null,
    vendor_count: vendorRanked.length,
    vendor_top: vendorRanked[0] ? { vendor: vendorRanked[0][0], count: vendorRanked[0][1], share_pct: round((vendorRanked[0][1] / pos.length) * 100, 1) } : null,
    line_items_total: lineItems.length ? lineItems.reduce((a, b) => a + b, 0) : null,
    line_items_mean: round(mean(lineItems)),
    line_items_coverage: `${lineItems.length}/${pos.length}`,
    amount_total: amounts.length ? round(amounts.reduce((a, b) => a + b, 0)) : null,
    amount_mean: round(mean(amounts)),
    amount_coverage: `${amounts.length}/${pos.length}`,
    amendments_total: amendments.length ? amendments.reduce((a, b) => a + b, 0) : null,
    amendments_mean: round(mean(amendments)),
    pos_with_amendments: amendments.filter((a) => a > 0).length,
    pos_with_amendments_pct: amendments.length ? round((amendments.filter((a) => a > 0).length / amendments.length) * 100, 1) : null,
    stock_vs_job: { stock: stockCount, job: jobRefs.length - stockCount },
    approval_marked_pct: approvalMarks.length ? round((approved / approvalMarks.length) * 100, 1) : null,
    approval_marking_coverage: `${approvalMarks.length}/${pos.length}`,
    field_coverage: coverage,
  };
}

/**
 * The clerical-hours figure. This is the number the whole case study turns on,
 * so it is deliberately the most heavily caveated thing in the codebase.
 *
 * Preference order for touch time:
 *   1. direct observation  -> basis 'observed'   (measured)
 *   2. testimony/estimate  -> basis 'estimate_propagated' (carries a range)
 * PO volume comes from the documentary sample where possible, never from memory.
 */
export function estimateAnnualClericalHours({ poSummary, testimonies = [], observations = [], samplingExhaustive = false }) {
  const obsHands = observations.map((o) => num(o, 'hands_on_minutes')).filter((x) => x !== null);

  let minutes = null; let minutesLow = null; let minutesHigh = null; let basis = null; let source = null;

  if (obsHands.length) {
    minutes = mean(obsHands);
    minutesLow = Math.min(...obsHands);
    minutesHigh = Math.max(...obsHands);
    basis = 'observed';
    source = `${obsHands.length} direct observation(s)`;
    if (obsHands.length < 3) {
      basis = 'observed_thin';
    }
  } else {
    const claims = testimonies.map((t) => t.fields?.touch_time_minutes_per_po)
      .filter((c) => c && c.confidence !== 'unknown' && typeof c.value === 'number');
    if (!claims.length) {
      return { available: false, reason: 'no touch-time evidence: capture a baseline_observation or baseline_testimony first' };
    }
    minutes = mean(claims.map((c) => c.value));
    minutesLow = Math.min(...claims.map((c) => (c.range ? c.range.low : c.value)));
    minutesHigh = Math.max(...claims.map((c) => (c.range ? c.range.high : c.value)));
    basis = 'estimate_propagated';
    source = `${claims.length} testimony/estimate claim(s)`;
  }

  // Volume. The subtle trap this guards against: dividing a SAMPLE of POs by the
  // span of days they cover yields a rate that is only meaningful if the sample
  // is every PO in that span. Thirteen POs pulled from a six-month binder would
  // otherwise produce a confident, documentary-looking, badly wrong "POs per
  // week". Volume therefore comes from the documentary sample ONLY when the
  // manifest positively declares the sampling exhaustive.
  let perWeek = null;
  let perWeekLow = null;
  let perWeekHigh = null;
  let volumeBasis = null;
  if (samplingExhaustive && poSummary?.pos_per_week != null) {
    perWeek = poSummary.pos_per_week;
    perWeekLow = perWeek;
    perWeekHigh = perWeek;
    volumeBasis = 'documentary';
  } else {
    const vClaims = testimonies.map((x) => x.fields?.po_volume_per_week)
      .filter((c) => c && c.confidence !== 'unknown' && typeof c.value === 'number');
    const t = vClaims.map((c) => c.value);
    if (!t.length) {
      return {
        available: false,
        reason: poSummary?.pos_per_week != null && !samplingExhaustive
          ? 'PO volume is not derivable: the baseline manifest declares sampling_exhaustive=false, so the '
            + 'sample rate is not the company rate. Capture po_volume_per_week as testimony, or transcribe '
            + 'every PO in the window and set sampling_exhaustive=true.'
          : 'no PO volume evidence: need an exhaustive documentary sample, or testimony',
      };
    }
    perWeek = mean(t);
    perWeekLow = Math.min(...vClaims.map((c) => (c.range ? c.range.low : c.value)));
    perWeekHigh = Math.max(...vClaims.map((c) => (c.range ? c.range.high : c.value)));
    volumeBasis = 'estimate_propagated';
  }

  const hours = (v, m) => round((v * 52 * m) / 60, 1);
  const hoursLow = hours(perWeekLow, minutesLow);
  const hoursHigh = hours(perWeekHigh, minutesHigh);
  // low === high means every input was a single point. That is not precision, it
  // is missing uncertainty, and presenting it as a range would imply otherwise.
  const rangeIsPoint = hoursLow === hoursHigh;
  // Three honest levels, never two. A single stopwatch run IS a measurement, but
  // annualizing off one sample is not the same claim as annualizing off several,
  // and neither is the same as annualizing off someone's recollection.
  let combinedBasis;
  if (basis === 'observed' && volumeBasis === 'documentary') combinedBasis = 'measured';
  else if (basis === 'observed_thin' && volumeBasis === 'documentary') combinedBasis = 'measured_thin';
  else combinedBasis = 'estimate_propagated';

  return {
    available: true,
    basis: combinedBasis,
    touch_time_minutes_per_po: round(minutes),
    touch_time_basis: basis,
    touch_time_source: source,
    pos_per_week: round(perWeek),
    volume_basis: volumeBasis,
    annual_pos: Math.round(perWeek * 52),
    annual_clerical_hours: hours(perWeek, minutes),
    annual_clerical_hours_low: hoursLow,
    annual_clerical_hours_high: hoursHigh,
    range_is_point: rangeIsPoint,
    range_note: rangeIsPoint
      ? 'Low and high are equal because every input was a single point with no stated '
        + 'uncertainty. This is NOT a precise figure — it is a figure whose uncertainty was '
        + 'never captured. Record touch time and PO volume as "estimated" with ranges, or take '
        + 'more observations, before quoting it.'
      : null,
    caveat: {
      measured:
        'Touch time measured by direct observation; volume from the documentary sample. '
        + 'Still an annualization of a limited sample — say so when you present it.',
      measured_thin:
        `Touch time measured, but from only ${obsHands.length} observation(s). One stopwatch run is a `
        + 'measurement, not a distribution. Present the range and the sample size together, '
        + 'and get to 3+ observations before this number carries a headline.',
      estimate_propagated:
        'CONTAINS PROPAGATED HUMAN ESTIMATES. This is not a measurement. It must be presented '
        + 'with its low/high range and never as a single headline number.',
    }[combinedBasis],
    observation_count: obsHands.length,
  };
}

export function summarizeBaseline({ manifest, pos, testimonies, observations }) {
  const poSummary = summarizePOs(pos);
  const samplingExhaustive = manifest?.sampling_exhaustive === true;
  return {
    baseline_id: manifest?.baseline_id ?? null,
    sampling_exhaustive: samplingExhaustive,
    documentary: {
      ...poSummary,
      // Only a rate over an exhaustive sample is the company's rate.
      pos_per_week: samplingExhaustive ? poSummary.pos_per_week : null,
      pos_per_week_note: samplingExhaustive
        ? 'sample is exhaustive over the window, so this is the operating rate'
        : 'NOT DERIVABLE: sampling_exhaustive=false — this sample\'s rate is not the company\'s rate',
      sample_rate_over_span: poSummary.pos_per_week,
    },
    testimony_count: testimonies.length,
    observation_count: observations.length,
    clerical_hours: estimateAnnualClericalHours({ poSummary, testimonies, observations, samplingExhaustive }),
  };
}
