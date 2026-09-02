// IIC evidence status — readiness computed ONLY from records that (a) parse,
// (b) validate with zero errors, and (c) are record_class "production".
//
// The three ways a status report normally becomes a lie, and how each is blocked:
//   * a document existing counts as evidence      -> only validated RECORDS count
//   * rehearsal/demo data leaking into readiness  -> record_class filter, applied first
//   * a milestone "mostly met" rounding up        -> requirements are pass/fail, integers only
//
// Pure over its inputs; the caller does the file reading.

import { MILESTONES, MILESTONE_KEYS, THRESHOLDS, COUNTABLE_RECORD_CLASS } from './spec.mjs';
import { validateRecord } from './validate.mjs';

const DAY_MS = 86_400_000;
const val = (r, k) => {
  const c = r.fields?.[k];
  return c && c.confidence !== 'unknown' ? c.value : null;
};

const FILTERS = {
  // A comprehension test only tests comprehension if the tester had not already
  // been talked through it.
  unexposed: (r) => ['none', 'heard_the_name'].includes(r.tester_prior_exposure),
  // Friends agreeing with you is not market evidence.
  arms_length: (r) => ['cold', 'warm_intro'].includes(r.relationship),
  verified: (r) => val(r, 'verification_status') === 'verified',
};

export function computeStatus({ loaded, freezes }) {
  const parseErrors = loaded.filter((l) => l.parseError);
  const records = loaded.filter((l) => l.record).map((l) => ({ ...l }));

  // Manifests are needed as validation context for baseline_po contamination checks.
  const manifests = new Map();
  for (const { record } of records) {
    if (record.record_type === 'baseline_manifest') manifests.set(record.baseline_id, record);
  }

  const validated = records.map((entry) => {
    const ctx = entry.record.baseline_id ? { manifest: manifests.get(entry.record.baseline_id) } : {};
    const result = validateRecord(entry.record, ctx);
    return { ...entry, ...result };
  });

  const invalid = validated.filter((v) => !v.ok);
  const valid = validated.filter((v) => v.ok);
  const excluded = valid.filter((v) => v.record.record_class !== COUNTABLE_RECORD_CLASS);
  const counting = valid.filter((v) => v.record.record_class === COUNTABLE_RECORD_CLASS).map((v) => v.record);

  const byType = (t) => counting.filter((r) => r.record_type === t);

  // --- custom requirement evaluators --------------------------------------
  const custom = {
    baseline_span: () => {
      const pos = byType('baseline_po');
      const dates = pos.map((p) => val(p, 'po_date')).filter(Boolean).sort();
      if (dates.length < 2) return { met: false, detail: 'need >= 2 dated POs' };
      const span = Math.round((Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / DAY_MS) + 1;
      return {
        met: span >= THRESHOLDS.baseline_span_days_min,
        detail: `${span} days (${dates[0]} → ${dates[dates.length - 1]})`,
      };
    },
    baseline_frozen: () => {
      const ids = [...manifests.keys()];
      const frozen = freezes.filter((f) => f.freeze && ids.includes(f.freeze.baseline_id));
      if (!frozen.length) return { met: false, detail: 'no freeze receipt' };
      return { met: true, detail: `${frozen.length} freeze receipt(s)` };
    },
  };

  const milestones = MILESTONE_KEYS.map((key) => {
    const m = MILESTONES[key];
    const reqs = m.requirements.map((req) => {
      if (req.custom) {
        const r = custom[req.custom]();
        return { id: req.id, text: req.text, met: r.met, detail: r.detail };
      }
      let pool = byType(req.type);
      if (req.filter) pool = pool.filter(FILTERS[req.filter]);
      const have = pool.length;
      return { id: req.id, text: req.text, met: have >= req.min, detail: `${have}/${req.min}` };
    });
    const met = reqs.filter((r) => r.met).length;
    return { key, label: m.label, requirements: reqs, met, total: reqs.length, complete: met === reqs.length };
  });

  const met = milestones.reduce((a, m) => a + m.met, 0);
  const total = milestones.reduce((a, m) => a + m.total, 0);

  return {
    milestones,
    score: { met, total },
    counts: {
      files: loaded.length,
      parse_errors: parseErrors.length,
      invalid: invalid.length,
      valid: valid.length,
      counting: counting.length,
      excluded_non_production: excluded.length,
    },
    parseErrors,
    invalid,
    excluded,
    warnings: valid.flatMap((v) => v.warnings.map((w) => ({ path: v.path, warning: w }))),
  };
}
