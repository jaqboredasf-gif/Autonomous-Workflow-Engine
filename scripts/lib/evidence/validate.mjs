// Evidence validator — pure, offline, deterministic. No I/O, no clock, no network.
//
// Given a record object, returns { ok, errors[], warnings[] }. Errors block a
// freeze and stop a record counting toward IIC status. Warnings never block —
// they are how the repo tells Jack his evidence is weak without silently
// discarding it.

import {
  CONFIDENCE, RECORD_CLASSES, RECORD_TYPES, typeSpec, allFields,
} from './spec.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkKind(kind, value, opts = {}) {
  switch (kind) {
    case 'string':
    case 'text':
      return typeof value === 'string' && value.trim() !== ''
        ? null : 'must be a non-empty string';
    case 'date':
      return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))
        ? null : 'must be a YYYY-MM-DD date';
    case 'datetime':
      return typeof value === 'string' && ISO_DATETIME.test(value) && !Number.isNaN(Date.parse(value))
        ? null : 'must be an ISO datetime with timezone (e.g. 2026-09-02T14:00:00Z)';
    case 'integer':
      return Number.isInteger(value) && value >= 0 ? null : 'must be a non-negative integer';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? null : 'must be a non-negative number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'enum':
      return opts.values.includes(value)
        ? null : `must be one of: ${opts.values.join(', ')}`;
    case 'list':
      return Array.isArray(value) && value.length > 0
        && value.every((x) => typeof x === 'string' && x.trim() !== '')
        ? null : 'must be a non-empty array of non-empty strings';
    default:
      return `unknown field kind ${kind}`;
  }
}

// A claim is the unit of evidence: a value plus HOW it is known.
function validateClaim(def, claim, record, errors, warnings) {
  const at = `fields.${def.key}`;

  if (!isPlainObject(claim)) {
    errors.push(`${at}: must be a claim object {"value": ..., "confidence": "..."}, not a bare value`);
    return;
  }
  const { confidence } = claim;
  if (!confidence) {
    errors.push(`${at}: missing "confidence" — every value must say how it is known`);
    return;
  }
  const cls = CONFIDENCE[confidence];
  if (!cls) {
    errors.push(`${at}: confidence "${confidence}" is not a recognized class (${Object.keys(CONFIDENCE).join(', ')})`);
    return;
  }
  if (cls.machine_only) {
    errors.push(`${at}: confidence "derived" may never be hand-entered — only AWE produces derived values`);
    return;
  }
  if (def.confidences && !def.confidences.includes(confidence)) {
    errors.push(`${at}: confidence "${confidence}" is not allowed here (allowed: ${def.confidences.join(', ')}). `
      + 'This boundary is what keeps documentary facts and human estimates from blurring together.');
    return;
  }

  // unknown: value must be null, and nothing else is required. Absence preserved.
  if (confidence === 'unknown') {
    if (claim.value !== null && claim.value !== undefined) {
      errors.push(`${at}: confidence "unknown" requires "value": null — do not record a guess as unknown`);
    }
    return;
  }

  if (claim.value === null || claim.value === undefined) {
    errors.push(`${at}: confidence "${confidence}" requires a value (use confidence "unknown" if you do not have one)`);
    return;
  }
  const kindErr = checkKind(def.kind, claim.value, def);
  if (kindErr) errors.push(`${at}: value ${kindErr}`);

  // Per-class companion requirements.
  for (const need of cls.requires_claim) {
    if (need === 'range') {
      const r = claim.range;
      if (!isPlainObject(r) || typeof r.low !== 'number' || typeof r.high !== 'number') {
        errors.push(`${at}: an estimate requires "range": {"low": n, "high": n} — a point guess may not be presented as a measurement`);
      } else if (r.low > r.high) {
        errors.push(`${at}: range.low must be <= range.high`);
      } else {
        if (typeof claim.value === 'number' && (claim.value < r.low || claim.value > r.high)) {
          errors.push(`${at}: value ${claim.value} lies outside its own stated range ${r.low}–${r.high}`);
        }
        if (r.low === r.high) {
          warnings.push(`${at}: estimate range is zero-width — a real estimate has uncertainty`);
        }
      }
      continue;
    }
    if (need === 'observed_at' || need === 'stated_on') {
      const v = claim[need];
      const okDate = typeof v === 'string' && (ISO_DATE.test(v) || ISO_DATETIME.test(v));
      if (!okDate) errors.push(`${at}: confidence "${confidence}" requires "${need}" as a date or ISO datetime`);
      continue;
    }
    if (typeof claim[need] !== 'string' || claim[need].trim() === '') {
      errors.push(`${at}: confidence "${confidence}" requires "${need}"`);
    }
  }

  // Record-level requirements implied by the class (e.g. documentary needs a source document).
  for (const need of cls.requires_record) {
    if (!isPlainObject(record[need])) {
      errors.push(`${at}: confidence "documentary" requires the record to carry "${need}" identifying the artifact it was copied from`);
    }
  }
}

function validateMeta(def, value, errors) {
  const at = def.key;
  if (value === null || value === undefined) {
    if (def.required && !def.nullable) errors.push(`${at}: required`);
    return;
  }
  const kindErr = checkKind(def.kind, value, def);
  if (kindErr) errors.push(`${at}: ${kindErr}`);
}

/**
 * Validate one evidence record.
 * @param {object} record
 * @param {{ manifest?: object }} [ctx] baseline manifest, for contamination checks
 */
export function validateRecord(record, ctx = {}) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(record)) return { ok: false, errors: ['record must be a JSON object'], warnings };

  // --- envelope ------------------------------------------------------------
  if (typeof record.record_id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(record.record_id || '')) {
    errors.push('record_id: required, letters/digits/._- only');
  }
  if (!RECORD_TYPES[record.record_type]) {
    return { ok: false, errors: [...errors, `record_type: must be one of ${Object.keys(RECORD_TYPES).join(', ')}`], warnings };
  }
  if (!RECORD_CLASSES.includes(record.record_class)) {
    errors.push(`record_class: must be one of ${RECORD_CLASSES.join(', ')} `
      + '("production" is the ONLY class that counts toward IIC status)');
  }
  if (typeof record.captured_by !== 'string' || !record.captured_by.trim()) {
    errors.push('captured_by: required — evidence with no author is not evidence');
  }
  if (typeof record.captured_at !== 'string' || !ISO_DATETIME.test(record.captured_at)) {
    errors.push('captured_at: required ISO datetime with timezone');
  }

  const spec = typeSpec(record.record_type);

  // --- meta fields ---------------------------------------------------------
  for (const def of spec.meta || []) validateMeta(def, record[def.key], errors);

  // --- claim fields --------------------------------------------------------
  const fields = record.fields ?? {};
  if (!isPlainObject(fields)) {
    errors.push('fields: must be an object of claims');
  } else {
    const known = new Set((spec.fields || []).map((d) => d.key));
    for (const k of Object.keys(fields)) {
      if (!known.has(k)) errors.push(`fields.${k}: not a field of ${record.record_type}`);
    }
    for (const def of spec.fields || []) {
      const claim = fields[def.key];
      if (claim === undefined) {
        if (def.required) {
          errors.push(`fields.${def.key}: required (${def.label}). `
            + 'If you did not capture it, record it explicitly as {"value": null, "confidence": "unknown"}.');
        }
        continue;
      }
      validateClaim(def, claim, record, errors, warnings);
    }
  }

  // --- source document (documentary provenance) ----------------------------
  if (isPlainObject(record.source_document)) {
    const sd = record.source_document;
    if (typeof sd.kind !== 'string' || !sd.kind.trim()) errors.push('source_document.kind: required');
    if (typeof sd.identifier !== 'string' || !sd.identifier.trim()) errors.push('source_document.identifier: required');
    if (typeof sd.physical_location !== 'string' || !sd.physical_location.trim()) {
      errors.push('source_document.physical_location: required — a document nobody can go back and re-read is not verifiable');
    }
    if (sd.photographed !== true) {
      warnings.push('source_document: not photographed. A photo is what lets a skeptic re-check your transcription later.');
    }
  }

  // --- per-type integrity rules -------------------------------------------
  applyTypeRules(record, ctx, errors, warnings);

  return { ok: errors.length === 0, errors, warnings };
}

function claimValue(record, key) {
  const c = record.fields?.[key];
  return isPlainObject(c) ? c.value : undefined;
}

function applyTypeRules(record, ctx, errors, warnings) {
  const t = record.record_type;

  if (t === 'baseline_manifest') {
    if (record.window_start && record.window_end && record.window_start > record.window_end) {
      errors.push('window_start must be on or before window_end');
    }
    if (record.awe_production_start && record.window_end
        && record.window_end >= record.awe_production_start) {
      errors.push(`window_end (${record.window_end}) is on or after awe_production_start `
        + `(${record.awe_production_start}) — a pre-AWE baseline window may not overlap AWE production use`);
    }
    if (record.declared_at && record.window_end
        && record.declared_at.slice(0, 10) < record.window_end) {
      warnings.push('declared_at precedes window_end — scope was declared before the window closed; make sure records were not selected after the fact');
    }
  }

  if (t === 'baseline_po') {
    const poDate = claimValue(record, 'po_date');
    const m = ctx.manifest;
    if (!record.source_document) {
      errors.push('baseline_po: source_document is required — every documentary PO must name the physical artifact it came from');
    }
    if (record.awe_involved === true) {
      errors.push('baseline_po: awe_involved is true — this PO is CONTAMINATED and cannot sit in a pre-AWE baseline');
    }
    if (typeof record.awe_involved !== 'boolean') {
      errors.push('baseline_po: awe_involved (true/false) is required — you must positively assert this PO predates AWE');
    }
    if (poDate && m) {
      if (m.window_start && poDate < m.window_start) {
        errors.push(`baseline_po: po_date ${poDate} is before the declared window start ${m.window_start}`);
      }
      if (m.window_end && poDate > m.window_end) {
        errors.push(`baseline_po: po_date ${poDate} is after the declared window end ${m.window_end}`);
      }
      if (m.awe_production_start && poDate >= m.awe_production_start) {
        errors.push(`baseline_po: po_date ${poDate} is on/after AWE production start ${m.awe_production_start} `
          + '— CONTAMINATION: this is not a pre-AWE purchase order');
      }
    }
    if (poDate && !m) {
      warnings.push('baseline_po: no manifest supplied, so window and contamination rules were not checked');
    }
    const needed = claimValue(record, 'needed_by_date');
    if (poDate && needed && needed < poDate) {
      warnings.push(`baseline_po: needed_by_date ${needed} precedes po_date ${poDate} — check the transcription`);
    }
    if (claimValue(record, 'legibility') === 'poor') {
      warnings.push('baseline_po: legibility is poor — transcription confidence is reduced; consider excluding or flagging in the case study');
    }
  }

  if (t === 'baseline_testimony') {
    if (record.does_this_work_personally === false) {
      warnings.push('baseline_testimony: respondent does not personally do this work — second-hand testimony is materially weaker evidence');
    }
  }

  if (t === 'baseline_observation') {
    const total = claimValue(record, 'elapsed_minutes_total');
    const hands = claimValue(record, 'hands_on_minutes');
    const wait = claimValue(record, 'wait_minutes');
    if (typeof total === 'number' && typeof hands === 'number' && hands > total) {
      errors.push('baseline_observation: hands_on_minutes exceeds elapsed_minutes_total');
    }
    if (typeof total === 'number' && typeof hands === 'number' && typeof wait === 'number'
        && hands + wait > total + 1e-9) {
      errors.push('baseline_observation: hands_on_minutes + wait_minutes exceeds elapsed_minutes_total');
    }
    if (record.subject_knew_observed === true) {
      warnings.push('baseline_observation: subject knew they were timed — observer effect likely inflates measured speed');
    }
  }

  if (t === 'interview') {
    if (record.pitched_before_asking === true) {
      warnings.push('interview: AWE was described before asking about their process — pain and commercial answers from this interview are leading-question contaminated');
    }
    if (record.relationship === 'family_or_friend') {
      warnings.push('interview: family/friend interview — counts, but cannot carry the market claim on its own');
    }
    if (record.consent_to_quote === false) {
      const q = claimValue(record, 'direct_quotes');
      if (Array.isArray(q) && q.length) {
        errors.push('interview: direct_quotes recorded without consent_to_quote — remove the quotes or obtain consent');
      }
    }
    const dis = record.fields?.disconfirming;
    if (isPlainObject(dis) && dis.confidence === 'unknown') {
      warnings.push('interview: no disconfirming evidence captured — an interview that only confirms your hopes was probably run as a pitch');
    }
  }

  if (t === 'comprehension_test') {
    if (['discussed_before', 'deeply_familiar'].includes(record.tester_prior_exposure)) {
      warnings.push(`comprehension_test: tester prior exposure is "${record.tester_prior_exposure}" — this does NOT count toward the 5 required unexposed tests`);
    }
    const conf = record.fields?.confusions;
    if (isPlainObject(conf) && Array.isArray(conf.value) && conf.value.length === 0) {
      errors.push('comprehension_test: confusions must not be empty — if there were genuinely none, say so as a string entry');
    }
  }

  if (t === 'founder_story_fact') {
    if (claimValue(record, 'verification_status') === 'unverifiable') {
      warnings.push('founder_story_fact: unverifiable — retained as a fact of record, but it will not count toward the verified-facts requirement');
    }
  }

  if (t === 'release_approval') {
    if (record.form === 'verbal_unwitnessed') {
      warnings.push('release_approval: unwitnessed verbal approval is the weakest form — get it in a text or email; it takes one minute and it is the difference between a claim and a record');
    }
  }

  if (t === 'observation_window') {
    if (record.ended_at && record.started_at && record.ended_at < record.started_at) {
      errors.push('observation_window: ended_at precedes started_at');
    }
  }
}

export function validateAll(records, ctx = {}) {
  return records.map((r) => ({ record: r, ...validateRecord(r, ctx) }));
}
