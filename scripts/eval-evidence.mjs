// Runner 6 — DETERMINISTIC evidence-layer eval.
//
// PURE OFFLINE by construction: no API keys, no model calls, no database, no
// network, no filesystem writes outside a temp dir. It tests the modules the
// CLI actually ships (scripts/lib/evidence/*.mjs), not copies of them.
//
// What this runner exists to protect: the evidence layer's job is to make it
// HARD to produce a flattering-but-false number. Every assertion below is a
// specific way that could go wrong.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRecord } from '../scripts/lib/evidence/validate.mjs';
import { buildFreeze, verifyFreeze, canonicalize, hashRecord } from '../scripts/lib/evidence/freeze.mjs';
import { summarizePOs, estimateAnnualClericalHours, summarizeBaseline } from '../scripts/lib/evidence/derive.mjs';
import { computeStatus } from '../scripts/lib/evidence/status.mjs';
import { parseCSV, rowsToRecords, csvColumns } from '../scripts/lib/evidence/csv.mjs';
import { THRESHOLDS, RECORD_TYPES, CONFIDENCE } from '../scripts/lib/evidence/spec.mjs';

let pass = 0; const failures = [];
const t = (name, fn) => {
  try { fn(); pass++; } catch (e) { failures.push(`${name}: ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const hasErr = (res, needle) => res.errors.some((e) => e.includes(needle));
const hasWarn = (res, needle) => res.warnings.some((w) => w.includes(needle));

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const MANIFEST = {
  record_id: 'lippolis-purchasing-2026',
  record_type: 'baseline_manifest',
  record_class: 'production',
  captured_by: 'Jack Daly',
  captured_at: '2026-09-02T12:00:00Z',
  baseline_id: 'lippolis-purchasing-2026',
  organization: 'Lippolis Electric',
  process_scope: 'Materials purchasing: need identified → PO written → order placed → PO filed.',
  window_start: '2026-01-01',
  window_end: '2026-06-30',
  declared_by: 'Jack Daly',
  declared_at: '2026-09-02T12:00:00Z',
  awe_production_start: '2026-08-01',
  inclusion_rule: 'Every paper PO in the 2026 binder dated in the window.',
  exclusion_rule: 'Anything AWE touched; anything from another company.',
  sampling_method: 'Every PO in the 2026 binder between the window dates, in binder order.',
  sampling_exhaustive: true,
  fields: {},
};

const doc = (v) => ({ value: v, confidence: 'documentary' });
const unk = () => ({ value: null, confidence: 'unknown' });

const po = (n, date, over = {}) => ({
  record_id: `po-${n}`,
  record_type: 'baseline_po',
  record_class: 'production',
  baseline_id: 'lippolis-purchasing-2026',
  captured_by: 'Jack Daly',
  captured_at: '2026-09-02T12:00:00Z',
  awe_involved: false,
  source_document: {
    kind: 'paper_purchase_order', identifier: `PO ${n}`,
    physical_location: 'Lippolis office 2026 binder', photographed: true, photo_ref: null,
  },
  fields: {
    po_number: doc(String(n)),
    po_date: doc(date),
    vendor: doc('Graybar'),
    job_reference: doc('STOCK'),
    requested_by: doc('M. Rivera'),
    line_item_count: doc(4),
    document_form: doc('handwritten_carbon'),
    amendments_on_face: doc(1),
    total_amount: doc(500),
    ...over,
  },
});

const TESTIMONY = {
  record_id: 'testimony-office-manager',
  record_type: 'baseline_testimony',
  record_class: 'production',
  baseline_id: 'lippolis-purchasing-2026',
  captured_by: 'Jack Daly',
  captured_at: '2026-09-02T12:00:00Z',
  respondent_role: 'Office manager',
  does_this_work_personally: true,
  fields: {
    touch_time_minutes_per_po: {
      value: 18, confidence: 'estimated', basis: 'she walked through a typical PO out loud',
      range: { low: 12, high: 30 },
    },
    people_involved_count: { value: 3, confidence: 'testimony', attributed_to: 'Office manager', stated_on: '2026-09-02' },
    po_volume_per_week: { value: 9, confidence: 'testimony', attributed_to: 'Office manager', stated_on: '2026-09-02' },
    calls_per_po: unk(), rework_rate_pct: unk(), delay_hours_need_to_order: unk(),
    lost_po_frequency: unk(), approver_absent_handling: unk(), filing_location: unk(), worst_part: unk(),
  },
};

const OBSERVATION = {
  record_id: 'obs-001',
  record_type: 'baseline_observation',
  record_class: 'production',
  baseline_id: 'lippolis-purchasing-2026',
  captured_by: 'Jack Daly',
  captured_at: '2026-09-02T12:00:00Z',
  observed_on: '2026-09-02',
  observer: 'Jack Daly',
  subject_role: 'Office manager',
  po_reference: 'PO 4501',
  subject_knew_observed: false,
  fields: {
    elapsed_minutes_total: { value: 46, confidence: 'observed', observed_at: '2026-09-02T09:00:00Z', observed_by: 'Jack Daly' },
    hands_on_minutes: { value: 17, confidence: 'observed', observed_at: '2026-09-02T09:00:00Z', observed_by: 'Jack Daly' },
    wait_minutes: { value: 25, confidence: 'observed', observed_at: '2026-09-02T09:00:00Z', observed_by: 'Jack Daly' },
    handoff_count: { value: 2, confidence: 'observed', observed_at: '2026-09-02T09:00:00Z', observed_by: 'Jack Daly' },
    steps: { value: ['need raised', 'PO written', 'approved', 'called vendor', 'filed'], confidence: 'observed', observed_at: '2026-09-02T09:00:00Z', observed_by: 'Jack Daly' },
    interruption_count: unk(), call_count: unk(), failures_seen: unk(),
  },
};

const ctx = { manifest: MANIFEST };

// ---------------------------------------------------------------------------
// 1. envelope + happy path
// ---------------------------------------------------------------------------

t('manifest validates', () => {
  const r = validateRecord(MANIFEST);
  assert(r.ok, r.errors.join('; '));
});

t('well-formed PO validates against its manifest', () => {
  const r = validateRecord(po(1, '2026-03-11'), ctx);
  assert(r.ok, r.errors.join('; '));
});

t('testimony and observation validate', () => {
  const a = validateRecord(TESTIMONY, ctx);
  const b = validateRecord(OBSERVATION, ctx);
  assert(a.ok, `testimony: ${a.errors.join('; ')}`);
  assert(b.ok, `observation: ${b.errors.join('; ')}`);
});

t('record with no author is rejected', () => {
  const bad = { ...po(1, '2026-03-11'), captured_by: '' };
  assert(hasErr(validateRecord(bad, ctx), 'captured_by'), 'expected captured_by error');
});

t('unknown record_type is rejected', () => {
  assert(!validateRecord({ record_id: 'x', record_type: 'nope', record_class: 'production' }).ok, 'accepted bogus type');
});

// ---------------------------------------------------------------------------
// 2. the claim contract — how a value is known can never be omitted
// ---------------------------------------------------------------------------

t('a bare value is not a claim', () => {
  const bad = po(1, '2026-03-11', { vendor: 'Graybar' });
  assert(hasErr(validateRecord(bad, ctx), 'must be a claim object'), 'bare value accepted');
});

t('a claim with no confidence is rejected', () => {
  const bad = po(1, '2026-03-11', { vendor: { value: 'Graybar' } });
  assert(hasErr(validateRecord(bad, ctx), 'missing "confidence"'), 'confidence-less claim accepted');
});

t('"derived" can never be hand-entered', () => {
  const bad = po(1, '2026-03-11', { line_item_count: { value: 4, confidence: 'derived' } });
  assert(hasErr(validateRecord(bad, ctx), 'never be hand-entered'), 'hand-entered derived accepted');
});

t('testimony cannot masquerade as documentary on a PO', () => {
  const bad = po(1, '2026-03-11', {
    vendor: { value: 'Graybar', confidence: 'testimony', attributed_to: 'foreman', stated_on: '2026-09-02' },
  });
  assert(hasErr(validateRecord(bad, ctx), 'is not allowed here'), 'testimony accepted on documentary field');
});

t('documentary claims require a source_document on the record', () => {
  const bad = { ...po(1, '2026-03-11') };
  delete bad.source_document;
  assert(hasErr(validateRecord(bad, ctx), 'source_document'), 'documentary without source accepted');
});

t('source_document must say where the paper physically is', () => {
  const bad = po(1, '2026-03-11');
  bad.source_document = { ...bad.source_document, physical_location: '' };
  assert(hasErr(validateRecord(bad, ctx), 'physical_location'), 'unlocatable source accepted');
});

t('estimate without a range is rejected', () => {
  const bad = structuredClone(TESTIMONY);
  bad.fields.touch_time_minutes_per_po = { value: 18, confidence: 'estimated', basis: 'gut' };
  assert(hasErr(validateRecord(bad, ctx), 'range'), 'point-estimate accepted as measurement');
});

t('estimate without a basis is rejected', () => {
  const bad = structuredClone(TESTIMONY);
  bad.fields.touch_time_minutes_per_po = { value: 18, confidence: 'estimated', range: { low: 12, high: 30 } };
  assert(hasErr(validateRecord(bad, ctx), 'basis'), 'basis-less estimate accepted');
});

t('estimate whose value falls outside its own range is rejected', () => {
  const bad = structuredClone(TESTIMONY);
  bad.fields.touch_time_minutes_per_po = { value: 99, confidence: 'estimated', basis: 'x', range: { low: 12, high: 30 } };
  assert(hasErr(validateRecord(bad, ctx), 'outside its own stated range'), 'out-of-range estimate accepted');
});

t('testimony requires attribution and a date', () => {
  const bad = structuredClone(TESTIMONY);
  bad.fields.people_involved_count = { value: 3, confidence: 'testimony' };
  const r = validateRecord(bad, ctx);
  assert(hasErr(r, 'attributed_to') && hasErr(r, 'stated_on'), 'unattributed testimony accepted');
});

t('observation requires observer and timestamp', () => {
  const bad = structuredClone(OBSERVATION);
  bad.fields.hands_on_minutes = { value: 17, confidence: 'observed' };
  const r = validateRecord(bad, ctx);
  assert(hasErr(r, 'observed_at') && hasErr(r, 'observed_by'), 'unattributed observation accepted');
});

// ---------------------------------------------------------------------------
// 3. negative evidence is preserved, never coerced
// ---------------------------------------------------------------------------

t('unknown is a valid, first-class answer', () => {
  const r = validateRecord(po(1, '2026-03-11', { total_amount: unk() }), ctx);
  assert(r.ok, r.errors.join('; '));
});

t('unknown with a value is rejected (no guessing under an unknown label)', () => {
  const bad = po(1, '2026-03-11', { total_amount: { value: 500, confidence: 'unknown' } });
  assert(hasErr(bad && validateRecord(bad, ctx), 'requires "value": null'), 'guess laundered as unknown');
});

t('a required field cannot simply be omitted', () => {
  const bad = po(1, '2026-03-11');
  delete bad.fields.vendor;
  assert(hasErr(validateRecord(bad, ctx), 'required'), 'silent omission accepted');
});

t('unknown coverage is reported, not filled in', () => {
  const s = summarizePOs([po(1, '2026-03-01', { total_amount: unk() }), po(2, '2026-03-02')]);
  assert(s.amount_coverage === '1/2', `expected 1/2 coverage, got ${s.amount_coverage}`);
  assert(s.amount_total === 500, 'unknown amount was treated as a number');
});

// ---------------------------------------------------------------------------
// 4. contamination — post-AWE work can never enter a pre-AWE baseline
// ---------------------------------------------------------------------------

t('a PO dated after AWE production start is rejected as contaminated', () => {
  const bad = po(9, '2026-08-15');
  const r = validateRecord(bad, { manifest: MANIFEST });
  assert(hasErr(r, 'CONTAMINATION'), 'post-AWE PO accepted into pre-AWE baseline');
});

t('a PO outside the declared window is rejected', () => {
  const r = validateRecord(po(9, '2025-12-01'), ctx);
  assert(hasErr(r, 'before the declared window start'), 'out-of-window PO accepted');
});

t('awe_involved=true is rejected outright', () => {
  const bad = { ...po(1, '2026-03-11'), awe_involved: true };
  assert(hasErr(validateRecord(bad, ctx), 'CONTAMINATED'), 'AWE-touched PO accepted');
});

t('awe_involved must be positively asserted, not left absent', () => {
  const bad = { ...po(1, '2026-03-11') };
  delete bad.awe_involved;
  assert(hasErr(validateRecord(bad, ctx), 'awe_involved'), 'missing contamination assertion accepted');
});

t('a manifest whose window overlaps AWE production is rejected', () => {
  const bad = { ...MANIFEST, window_end: '2026-09-01' };
  assert(hasErr(validateRecord(bad), 'may not overlap AWE production use'), 'overlapping window accepted');
});

// ---------------------------------------------------------------------------
// 5. freeze semantics
// ---------------------------------------------------------------------------

const RECS = [po(1, '2026-03-01'), po(2, '2026-04-01'), TESTIMONY, OBSERVATION];
const mkFreeze = (recs = RECS) => buildFreeze({
  baselineId: 'lippolis-purchasing-2026', manifest: MANIFEST, records: recs,
  frozenBy: 'Jack Daly', attestation: 'Faithful transcriptions of documents I handled.',
  frozenAt: '2026-09-02T13:00:00Z',
});

t('freeze is deterministic', () => {
  assert(mkFreeze().baseline_hash === mkFreeze().baseline_hash, 'hash not deterministic');
});

t('freeze is independent of record order', () => {
  const a = mkFreeze(RECS);
  const b = mkFreeze([...RECS].reverse());
  assert(a.baseline_hash === b.baseline_hash, 'hash depends on file ordering');
});

t('canonicalization ignores key order but not values', () => {
  assert(canonicalize({ a: 1, b: 2 }) === canonicalize({ b: 2, a: 1 }), 'key order changed hash');
  assert(canonicalize({ a: 1 }) !== canonicalize({ a: 2 }), 'value change did not change hash');
});

t('verify passes on untouched evidence', () => {
  const v = verifyFreeze(mkFreeze(), { manifest: MANIFEST, records: RECS });
  assert(v.ok, `drift on untouched evidence: ${JSON.stringify(v.drift)}`);
});

t('editing one value after freeze is detected and named', () => {
  const f = mkFreeze();
  const tampered = structuredClone(RECS);
  tampered[0].fields.total_amount = doc(999999);
  const v = verifyFreeze(f, { manifest: MANIFEST, records: tampered });
  assert(!v.ok, 'tamper not detected');
  assert(v.drift.some((d) => d.kind === 'record_modified' && d.record_id === 'po-1'), 'tampered record not named');
});

t('deleting a record after freeze is detected', () => {
  const v = verifyFreeze(mkFreeze(), { manifest: MANIFEST, records: RECS.slice(1) });
  assert(v.drift.some((d) => d.kind === 'record_missing'), 'deletion not detected');
});

t('adding a record after freeze is detected', () => {
  const v = verifyFreeze(mkFreeze(), { manifest: MANIFEST, records: [...RECS, po(3, '2026-05-01')] });
  assert(v.drift.some((d) => d.kind === 'record_added_after_freeze'), 'post-freeze addition not detected');
});

t('editing the manifest after freeze is detected', () => {
  const v = verifyFreeze(mkFreeze(), { manifest: { ...MANIFEST, window_end: '2026-07-30' }, records: RECS });
  assert(v.drift.some((d) => d.kind === 'manifest_modified'), 'manifest tamper not detected');
});

t('re-indenting a file does not change its hash', () => {
  const reparsed = JSON.parse(JSON.stringify(RECS[0], null, 4));
  assert(hashRecord(RECS[0]) === hashRecord(reparsed), 'formatting changed the hash');
});

t('an amendment chains to the prior hash instead of erasing it', () => {
  const first = mkFreeze();
  const amended = buildFreeze({
    baselineId: 'lippolis-purchasing-2026', manifest: MANIFEST, records: RECS,
    frozenBy: 'Jack Daly', attestation: 'x', frozenAt: '2026-09-03T13:00:00Z',
    priorHash: first.baseline_hash, amendmentReason: 'transcription error on PO 2',
  });
  assert(amended.prior_hash === first.baseline_hash, 'amendment does not reference the original');
  assert(amended.amendment_reason, 'amendment carries no reason');
});

// ---------------------------------------------------------------------------
// 6. derived metrics — estimates never get promoted to measurements
// ---------------------------------------------------------------------------

t('documentary summary computes span and rate from the paper', () => {
  const s = summarizePOs([po(1, '2026-03-01'), po(2, '2026-03-31')]);
  assert(s.span_days === 31, `expected 31 days, got ${s.span_days}`);
  assert(s.basis === 'documentary', 'summary not marked documentary');
});

t('rework is counted from documentary corrections on the page', () => {
  const s = summarizePOs([po(1, '2026-03-01', { amendments_on_face: doc(0) }), po(2, '2026-03-31', { amendments_on_face: doc(2) })]);
  assert(s.pos_with_amendments === 1 && s.pos_with_amendments_pct === 50, 'amendment stats wrong');
});

t('testimony-only touch time is flagged as estimate_propagated with a range', () => {
  const s = summarizePOs([po(1, '2026-03-01'), po(2, '2026-03-31')]);
  const h = estimateAnnualClericalHours({ poSummary: s, testimonies: [TESTIMONY], observations: [], samplingExhaustive: true });
  assert(h.available, h.reason);
  assert(h.basis === 'estimate_propagated', `expected estimate_propagated, got ${h.basis}`);
  assert(h.annual_clerical_hours_low < h.annual_clerical_hours_high, 'estimate collapsed to a point');
  assert(/not a measurement/i.test(h.caveat), 'estimate not caveated');
});

t('one observation is measured_thin, not measured', () => {
  const s = summarizePOs([po(1, '2026-03-01'), po(2, '2026-03-31')]);
  const h = estimateAnnualClericalHours({ poSummary: s, testimonies: [TESTIMONY], observations: [OBSERVATION], samplingExhaustive: true });
  assert(h.basis === 'measured_thin', `expected measured_thin, got ${h.basis}`);
  assert(h.touch_time_minutes_per_po === 17, 'observation did not override testimony');
  assert(/not a distribution/.test(h.caveat), 'thin sample not caveated');
});

t('three observations earn the "measured" basis', () => {
  const s = summarizePOs([po(1, '2026-03-01'), po(2, '2026-03-31')]);
  const obs = [14, 17, 22].map((m, i) => {
    const o = structuredClone(OBSERVATION);
    o.record_id = `obs-${i}`;
    o.fields.hands_on_minutes.value = m;
    return o;
  });
  const h = estimateAnnualClericalHours({ poSummary: s, testimonies: [TESTIMONY], observations: obs, samplingExhaustive: true });
  assert(h.basis === 'measured', `expected measured, got ${h.basis}`);
  assert(h.annual_clerical_hours_low < h.annual_clerical_hours_high, 'observed spread collapsed');
});

t('no touch-time evidence yields no number at all', () => {
  const h = estimateAnnualClericalHours({ poSummary: summarizePOs([po(1, '2026-03-01')]), testimonies: [], observations: [], samplingExhaustive: true });
  assert(!h.available, 'invented a clerical-hours figure with no evidence');
});

t('a non-exhaustive sample cannot yield a documentary PO volume', () => {
  // 13 POs pulled from a six-month binder says nothing about POs per week. Left
  // ungated this produces a confident, documentary-looking, badly wrong rate.
  const s = summarizePOs([po(1, '2026-01-09'), po(2, '2026-06-24')]);
  const h = estimateAnnualClericalHours({
    poSummary: s, testimonies: [], observations: [OBSERVATION], samplingExhaustive: false,
  });
  assert(!h.available, `derived a volume from a non-exhaustive sample: ${JSON.stringify(h)}`);
  assert(/sampling_exhaustive=false/.test(h.reason), 'reason does not name the cause');
});

t('a non-exhaustive sample falls back to testimony volume, labelled as such', () => {
  const s = summarizePOs([po(1, '2026-01-09'), po(2, '2026-06-24')]);
  const h = estimateAnnualClericalHours({
    poSummary: s, testimonies: [TESTIMONY], observations: [OBSERVATION], samplingExhaustive: false,
  });
  assert(h.available, h.reason);
  assert(h.volume_basis === 'estimate_propagated', 'testimony volume not labelled as an estimate');
  assert(h.pos_per_week === 9, `expected testimony volume 9, got ${h.pos_per_week}`);
  assert(h.basis === 'estimate_propagated', 'estimate-derived volume did not downgrade the overall basis');
});

t('summarizeBaseline suppresses pos_per_week when sampling is not exhaustive', () => {
  const sb = summarizeBaseline({
    manifest: { ...MANIFEST, sampling_exhaustive: false },
    pos: [po(1, '2026-01-09'), po(2, '2026-06-24')],
    testimonies: [TESTIMONY], observations: [],
  });
  assert(sb.documentary.pos_per_week === null, 'sample rate presented as the operating rate');
  assert(sb.documentary.sample_rate_over_span !== null, 'sample rate not retained for transparency');
  assert(/NOT DERIVABLE/.test(sb.documentary.pos_per_week_note), 'no explanation given');
});

t('a collapsed low/high range is flagged as missing uncertainty, not precision', () => {
  const s = summarizePOs([po(1, '2026-03-01'), po(2, '2026-03-31')]);
  const h = estimateAnnualClericalHours({
    poSummary: s, testimonies: [TESTIMONY], observations: [OBSERVATION], samplingExhaustive: false,
  });
  assert(h.range_is_point === true, 'point range not detected');
  assert(/NOT a precise figure/.test(h.range_note), 'point range not explained');
});

t('stated estimate ranges widen the derived range', () => {
  const s = summarizePOs([po(1, '2026-03-01'), po(2, '2026-03-31')]);
  const withRange = structuredClone(TESTIMONY);
  withRange.fields.po_volume_per_week = {
    value: 9, confidence: 'estimated', basis: 'her recollection of a normal week', range: { low: 6, high: 14 },
  };
  const h = estimateAnnualClericalHours({
    poSummary: s, testimonies: [withRange], observations: [], samplingExhaustive: false,
  });
  assert(h.range_is_point === false, 'stated uncertainty did not propagate');
  assert(h.annual_clerical_hours_low < h.annual_clerical_hours && h.annual_clerical_hours < h.annual_clerical_hours_high,
    `point estimate not bracketed: ${h.annual_clerical_hours_low}/${h.annual_clerical_hours}/${h.annual_clerical_hours_high}`);
});

// ---------------------------------------------------------------------------
// 7. status — rehearsal and invalid records can never raise readiness
// ---------------------------------------------------------------------------

const asLoaded = (recs) => recs.map((r, i) => ({ path: `/tmp/${i}.json`, record: r }));

t('empty evidence scores zero', () => {
  const st = computeStatus({ loaded: [], freezes: [] });
  assert(st.score.met === 0, 'nonzero score with no evidence');
});

t('rehearsal records are excluded from readiness', () => {
  const rehearsal = Array.from({ length: 20 }, (_, i) =>
    ({ ...po(100 + i, '2026-03-01'), record_class: 'rehearsal' }));
  const st = computeStatus({ loaded: asLoaded([MANIFEST, ...rehearsal]), freezes: [] });
  const pos = st.milestones[0].requirements.find((r) => r.id === 'pos');
  assert(pos.detail === `0/${THRESHOLDS.baseline_po_min}`, `rehearsal counted: ${pos.detail}`);
  assert(st.counts.excluded_non_production === 20, 'exclusions not reported');
});

t('synthetic records are excluded from readiness', () => {
  const synth = Array.from({ length: 20 }, (_, i) => ({ ...po(200 + i, '2026-03-01'), record_class: 'synthetic' }));
  const st = computeStatus({ loaded: asLoaded([MANIFEST, ...synth]), freezes: [] });
  assert(st.milestones[0].requirements.find((r) => r.id === 'pos').detail.startsWith('0/'), 'synthetic counted');
});

t('invalid records are excluded from readiness', () => {
  const invalid = Array.from({ length: 20 }, (_, i) => {
    const p = po(300 + i, '2026-03-01'); delete p.fields.vendor; return p;
  });
  const st = computeStatus({ loaded: asLoaded([MANIFEST, ...invalid]), freezes: [] });
  assert(st.milestones[0].requirements.find((r) => r.id === 'pos').detail.startsWith('0/'), 'invalid records counted');
  assert(st.counts.invalid === 20, 'invalid count not reported');
});

t('a file existing does not satisfy a requirement', () => {
  const st = computeStatus({ loaded: [{ path: '/tmp/x.json', parseError: 'bad json', record: null }], freezes: [] });
  assert(st.score.met === 0, 'unparseable file raised readiness');
  assert(st.counts.parse_errors === 1, 'parse error not reported');
});

t('a freeze receipt for an unknown baseline does not satisfy the frozen requirement', () => {
  const st = computeStatus({
    loaded: asLoaded([MANIFEST]),
    freezes: [{ path: '/tmp/f.json', freeze: { baseline_id: 'some-other-baseline', baseline_hash: 'x' } }],
  });
  assert(!st.milestones[0].requirements.find((r) => r.id === 'frozen').met, 'unrelated freeze counted');
});

t('a real, complete baseline does satisfy its requirements', () => {
  const pos = Array.from({ length: THRESHOLDS.baseline_po_min }, (_, i) =>
    po(400 + i, `2026-0${1 + (i % 5)}-1${i % 9}`));
  const st = computeStatus({
    loaded: asLoaded([MANIFEST, ...pos, TESTIMONY, OBSERVATION]),
    freezes: [{ path: '/tmp/f.json', freeze: { baseline_id: MANIFEST.baseline_id, baseline_hash: 'x' } }],
  });
  const m = st.milestones[0];
  assert(m.complete, `baseline milestone not complete: ${JSON.stringify(m.requirements.filter((r) => !r.met))}`);
});

t('span requirement rejects one lucky week', () => {
  const pos = Array.from({ length: THRESHOLDS.baseline_po_min }, (_, i) => po(500 + i, `2026-03-0${(i % 5) + 1}`));
  const st = computeStatus({ loaded: asLoaded([MANIFEST, ...pos]), freezes: [] });
  assert(!st.milestones[0].requirements.find((r) => r.id === 'span').met, 'a 5-day sample passed the span floor');
});

// ---------------------------------------------------------------------------
// 8. interviews / comprehension / story — bias is recorded, not hidden
// ---------------------------------------------------------------------------

const INTERVIEW = {
  record_id: 'int-001', record_type: 'interview', record_class: 'production',
  captured_by: 'Jack Daly', captured_at: '2026-09-02T12:00:00Z',
  interview_date: '2026-09-02', interviewer: 'Jack Daly', organization_type: 'electrical',
  interviewee_role: 'Owner', relationship: 'cold', medium: 'phone',
  consent_to_quote: true, recorded: false, pitched_before_asking: false,
  fields: {
    current_process: { value: 'Paper POs from the truck.', confidence: 'testimony', attributed_to: 'Owner', stated_on: '2026-09-02' },
    workflow_pain: { value: 'Chasing vendors.', confidence: 'testimony', attributed_to: 'Owner', stated_on: '2026-09-02' },
    current_alternatives: { value: 'QuickBooks + a legal pad.', confidence: 'testimony', attributed_to: 'Owner', stated_on: '2026-09-02' },
    delays_errors_rework: { value: 'Wrong part twice last month.', confidence: 'testimony', attributed_to: 'Owner', stated_on: '2026-09-02' },
    buyer: { value: 'Me', confidence: 'testimony', attributed_to: 'Owner', stated_on: '2026-09-02' },
    direct_quotes: { value: ['I am not paying for another app.'], confidence: 'testimony', attributed_to: 'Owner', stated_on: '2026-09-02' },
    disconfirming: { value: 'Says paper works fine for him.', confidence: 'testimony', attributed_to: 'Owner', stated_on: '2026-09-02' },
    uncertainty: { value: 'Unclear if he speaks for bigger shops.', confidence: 'testimony', attributed_to: 'Owner', stated_on: '2026-09-02' },
    frequency: unk(), severity: unk(), current_spend: unk(),
    willingness_to_change: unk(), commercial_reaction: unk(), unit_of_sale_clues: unk(),
  },
};

t('a well-run interview validates', () => {
  const r = validateRecord(INTERVIEW);
  assert(r.ok, r.errors.join('; '));
});

t('interview requires disconfirming evidence to be addressed', () => {
  const bad = structuredClone(INTERVIEW);
  delete bad.fields.disconfirming;
  assert(hasErr(validateRecord(bad), 'disconfirming'), 'interview with no disconfirming field accepted');
});

t('an interview with no disconfirming evidence is warned about', () => {
  const weak = structuredClone(INTERVIEW);
  weak.fields.disconfirming = unk();
  assert(hasWarn(validateRecord(weak), 'run as a pitch'), 'confirmation-only interview not flagged');
});

t('pitching before asking is recorded as contamination', () => {
  const led = { ...structuredClone(INTERVIEW), pitched_before_asking: true };
  assert(hasWarn(validateRecord(led), 'leading-question contaminated'), 'leading interview not flagged');
});

t('quoting someone without consent is an error', () => {
  const bad = { ...structuredClone(INTERVIEW), consent_to_quote: false };
  assert(hasErr(validateRecord(bad), 'without consent_to_quote'), 'unconsented quotes accepted');
});

t('friend interviews count but cannot carry the market claim alone', () => {
  const friends = Array.from({ length: 5 }, (_, i) =>
    ({ ...structuredClone(INTERVIEW), record_id: `int-f${i}`, relationship: 'family_or_friend' }));
  const st = computeStatus({ loaded: asLoaded(friends), freezes: [] });
  const m = st.milestones.find((x) => x.key === 'EXTERNAL_INTERVIEWS');
  assert(m.requirements.find((r) => r.id === 'count').met, 'friend interviews did not count at all');
  assert(!m.requirements.find((r) => r.id === 'cold').met, 'friend interviews satisfied the arms-length requirement');
});

const COMP = {
  record_id: 'comp-001', record_type: 'comprehension_test', record_class: 'production',
  captured_by: 'Jack Daly', captured_at: '2026-09-02T12:00:00Z',
  test_date: '2026-09-02', administered_by: 'Jack Daly', tester_role: 'Retail manager',
  tester_prior_exposure: 'none', artifact: 'one-paragraph description @ abc123',
  fields: {
    prompt_used: { value: 'Read this and tell me what it does.', confidence: 'observed', observed_at: '2026-09-02', observed_by: 'Jack Daly' },
    unaided_restatement: { value: 'Sounds like it does paperwork for contractors?', confidence: 'observed', observed_at: '2026-09-02', observed_by: 'Jack Daly' },
    identified_problem: { value: true, confidence: 'observed', observed_at: '2026-09-02', observed_by: 'Jack Daly' },
    identified_buyer: { value: false, confidence: 'observed', observed_at: '2026-09-02', observed_by: 'Jack Daly' },
    identified_mechanism: { value: false, confidence: 'observed', observed_at: '2026-09-02', observed_by: 'Jack Daly' },
    confusions: { value: ['did not know who buys it'], confidence: 'observed', observed_at: '2026-09-02', observed_by: 'Jack Daly' },
    verdict: { value: 'partial', confidence: 'observed', observed_at: '2026-09-02', observed_by: 'Jack Daly' },
    words_they_used: unk(),
  },
};

t('a comprehension test validates', () => {
  const r = validateRecord(COMP);
  assert(r.ok, r.errors.join('; '));
});

t('an already-briefed tester does not count toward comprehension', () => {
  const exposed = Array.from({ length: 5 }, (_, i) =>
    ({ ...structuredClone(COMP), record_id: `comp-e${i}`, tester_prior_exposure: 'deeply_familiar' }));
  const st = computeStatus({ loaded: asLoaded(exposed), freezes: [] });
  const m = st.milestones.find((x) => x.key === 'COMPREHENSION_TESTS');
  assert(!m.requirements[0].met, 'pre-briefed testers satisfied the comprehension requirement');
});

t('a comprehension test must record what confused them', () => {
  const bad = structuredClone(COMP);
  bad.fields.confusions = { value: [], confidence: 'observed', observed_at: '2026-09-02', observed_by: 'J' };
  assert(!validateRecord(bad).ok, 'empty confusions accepted');
});

const FACT = {
  record_id: 'fact-001', record_type: 'founder_story_fact', record_class: 'production',
  captured_by: 'Jack Daly', captured_at: '2026-09-02T12:00:00Z',
  fact_date: '2026-07-26', category: 'build',
  fields: {
    statement: { value: 'Applied migrations 0014 and 0015 to the live project.', confidence: 'observed', observed_at: '2026-07-26', observed_by: 'Jack Daly' },
    verifier: { value: 'Commit 334182c and the live schema drift check.', confidence: 'observed', observed_at: '2026-07-26', observed_by: 'Jack Daly' },
    verification_status: { value: 'verified', confidence: 'observed', observed_at: '2026-07-26', observed_by: 'Jack Daly' },
  },
};

t('a founder story fact validates and requires a verifier', () => {
  assert(validateRecord(FACT).ok, validateRecord(FACT).errors.join('; '));
  const bad = structuredClone(FACT);
  delete bad.fields.verifier;
  assert(hasErr(validateRecord(bad), 'verifier'), 'fact with no verifier accepted');
});

t('unverifiable facts are kept but do not count as verified', () => {
  const facts = Array.from({ length: 5 }, (_, i) => {
    const f = structuredClone(FACT); f.record_id = `fact-u${i}`;
    f.fields.verification_status.value = 'unverifiable'; return f;
  });
  const st = computeStatus({ loaded: asLoaded(facts), freezes: [] });
  const m = st.milestones.find((x) => x.key === 'FOUNDER_STORY');
  assert(m.requirements.find((r) => r.id === 'count').met, 'unverifiable facts were discarded');
  assert(!m.requirements.find((r) => r.id === 'verified').met, 'unverifiable facts counted as verified');
});

// ---------------------------------------------------------------------------
// 9. CSV bulk entry
// ---------------------------------------------------------------------------

t('csv round-trips into valid documentary records', () => {
  const cols = csvColumns();
  const row = cols.map((c) => ({
    po_number: '4417', po_date: '2026-03-11', vendor: 'Graybar', job_reference: 'STOCK',
    requested_by: 'M. Rivera', line_item_count: '4', document_form: 'handwritten_carbon',
    physical_location: 'Lippolis binder', photographed: 'Y', source_identifier: 'PO 4417',
  }[c] ?? '')).join(',');
  const { records, problems } = rowsToRecords(parseCSV(`${cols.join(',')}\n${row}\n`), {
    baselineId: 'lippolis-purchasing-2026', capturedBy: 'Jack Daly', capturedAt: '2026-09-02T12:00:00Z',
  });
  assert(records.length === 1, `expected 1 record, got ${records.length}: ${problems.join('; ')}`);
  const r = validateRecord(records[0], ctx);
  assert(r.ok, `imported record invalid: ${r.errors.join('; ')}`);
});

t('a blank csv cell becomes unknown, never zero', () => {
  const cols = csvColumns();
  const row = cols.map((c) => ({
    po_number: '4418', po_date: '2026-03-12', vendor: 'Graybar', job_reference: 'STOCK',
    requested_by: 'M. Rivera', line_item_count: '2', document_form: 'typed_printed',
    physical_location: 'binder', photographed: 'N',
  }[c] ?? '')).join(',');
  const { records } = rowsToRecords(parseCSV(`${cols.join(',')}\n${row}\n`), {
    baselineId: 'b', capturedBy: 'J', capturedAt: '2026-09-02T12:00:00Z',
  });
  assert(records[0].fields.total_amount.confidence === 'unknown', 'blank became a value');
  assert(records[0].fields.total_amount.value === null, 'blank became zero');
});

t('an unparseable number is flagged and imported as unknown, not zero', () => {
  const cols = csvColumns();
  const row = cols.map((c) => ({
    po_number: '4419', po_date: '2026-03-13', vendor: 'X', job_reference: 'STOCK',
    requested_by: 'Y', line_item_count: 'about four', document_form: 'other',
    physical_location: 'binder', photographed: 'N',
  }[c] ?? '')).join(',');
  const { records, problems } = rowsToRecords(parseCSV(`${cols.join(',')}\n${row}\n`), {
    baselineId: 'b', capturedBy: 'J', capturedAt: '2026-09-02T12:00:00Z',
  });
  assert(records[0].fields.line_item_count.confidence === 'unknown', 'garbage became a number');
  assert(problems.some((p) => p.includes('NOT as zero')), 'bad number not reported');
});

t('csv handles quoted cells containing commas', () => {
  const rows = parseCSV('a,b\n"Smith, John",2\n');
  assert(rows[1][0] === 'Smith, John' && rows[1][1] === '2', `bad parse: ${JSON.stringify(rows[1])}`);
});

t('csv import cannot smuggle in testimony or estimates', () => {
  const cols = csvColumns();
  const testimonyFields = ['touch_time_minutes_per_po', 'po_volume_per_week', 'rework_rate_pct'];
  for (const f of testimonyFields) {
    assert(!cols.includes(f), `${f} is importable via csv — estimates could be laundered as documentary`);
  }
});

// ---------------------------------------------------------------------------
// 10. spec coherence
// ---------------------------------------------------------------------------

t('every field allows a confidence class that exists', () => {
  for (const [tk, spec] of Object.entries(RECORD_TYPES)) {
    for (const d of spec.fields || []) {
      assert(Array.isArray(d.confidences) && d.confidences.length, `${tk}.${d.key}: no confidence classes`);
      for (const c of d.confidences) assert(CONFIDENCE[c], `${tk}.${d.key}: unknown class ${c}`);
      assert(!d.confidences.includes('derived'), `${tk}.${d.key}: derived is machine-only`);
    }
  }
});

t('every field type allows unknown, so absence is always recordable', () => {
  for (const [tk, spec] of Object.entries(RECORD_TYPES)) {
    for (const d of spec.fields || []) {
      assert(d.confidences.includes('unknown'), `${tk}.${d.key}: cannot record "unknown" — forces a guess`);
    }
  }
});

t('every enum field defines its values', () => {
  for (const [tk, spec] of Object.entries(RECORD_TYPES)) {
    for (const d of [...(spec.meta || []), ...(spec.fields || [])]) {
      if (d.kind === 'enum') assert(Array.isArray(d.values) && d.values.length, `${tk}.${d.key}: enum without values`);
    }
  }
});

// ---------------------------------------------------------------------------
// 11. source purity — the evidence layer must stay offline
// ---------------------------------------------------------------------------

t('evidence modules make no network or database calls', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('./lib/evidence/', import.meta.url).pathname;
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const banned of ['fetch(', 'supabase', 'SERVICE_ROLE', 'ANTHROPIC', 'https://api.']) {
      assert(!src.includes(banned), `${f} references ${banned} — the evidence layer must stay offline`);
    }
  }
});

// ---------------------------------------------------------------------------

if (failures.length) {
  process.stderr.write(`\n${failures.length} FAILURE(S):\n`);
  for (const f of failures) process.stderr.write(`  ✗ ${f}\n`);
  process.stderr.write(`\n${pass} passed, ${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write(`${pass} checks passed\n`);
