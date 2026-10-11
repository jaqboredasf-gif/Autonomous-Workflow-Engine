// ---------------------------------------------------------------------------
// attestations.mjs — what a person has told the repository, and nothing more.
//
// Some North Star evidence cannot be produced by an agent: whether PCC is
// installed at Lippolis, whether the baseline was taken before the first real
// purchase, what the hosted database looks like today. Before this, there was
// nowhere for that knowledge to live, so "not done", "done but not written down"
// and "nobody asked" all looked the same.
//
// Four states, deliberately not interchangeable:
//   UNKNOWN           no attestation, and no record the repository can see
//   HUMAN_VERIFIED    a named person attested it is true, on a date
//   HUMAN_REFUTED     a named person checked and it is NOT true
//   MACHINE_VERIFIED  a record in the repository establishes it; only possible
//                     for a fact whose catalog entry names a machine_check
//
// THE ONE RULE: nothing here can produce HUMAN_VERIFIED except a record in
// autonomy/attestations.jsonl, and nothing in the repository writes that file
// except scripts/awe-attest.mjs, which refuses to run without a person at a
// terminal. An agent may read the state; it may not create it.
//
// Records are append-only. The latest valid record for a fact wins, so a
// correction is a new line with a reason, never an edit.
//
// Pure: no clock, no I/O.
// ---------------------------------------------------------------------------

export const ATTESTED = Object.freeze(['verified', 'refuted']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems with one attestation record, as strings. A record with problems is ignored, and reported. */
export function validateRecord(rec, catalog) {
  const errors = [];
  const ids = new Set(catalog.facts.map((f) => f.id));
  if (!rec || typeof rec !== 'object') return ['not an object'];
  if (!ids.has(rec.fact)) errors.push(`unknown fact "${rec.fact}"`);
  if (!ISO_DATE.test(rec.date ?? '')) errors.push('date must be YYYY-MM-DD (the day it became true or was checked)');
  if (!rec.attested_by || !String(rec.attested_by).trim()) errors.push('attested_by is required: a named person');
  if (!ATTESTED.includes(rec.status)) errors.push(`status must be one of ${ATTESTED.join(', ')}`);
  if (rec.via !== 'awe-attest') errors.push('not written by scripts/awe-attest.mjs');
  return errors;
}

/** Parse attestations.jsonl text into { records, rejected }. Blank lines are fine. */
export function parseLedger(text, catalog) {
  const records = [];
  const rejected = [];
  for (const [i, line] of String(text ?? '').split('\n').entries()) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { rejected.push({ line: i + 1, errors: ['not valid JSON'] }); continue; }
    const errors = validateRecord(rec, catalog);
    if (errors.length) rejected.push({ line: i + 1, fact: rec?.fact ?? null, errors });
    else records.push({ ...rec, line: i + 1 });
  }
  return { records, rejected };
}

/**
 * The state of every catalog fact.
 *   machine: { [machine_check name]: { ok: boolean, detail } } (precomputed by the caller)
 * A human attestation outranks a machine check, because a person can refute what
 * a record suggests. A machine check is never consulted for a fact without one.
 */
export function resolveFacts(catalog, records, machine = {}) {
  return catalog.facts.map((f) => {
    const mine = records.filter((r) => r.fact === f.id);
    const latest = mine[mine.length - 1];
    if (latest) {
      return { id: f.id, statement: f.statement, required_before: f.required_before ?? null,
        state: latest.status === 'verified' ? 'HUMAN_VERIFIED' : 'HUMAN_REFUTED',
        attested_by: latest.attested_by, date: latest.date, evidence: latest.evidence ?? null,
        note: latest.note ?? null, history: mine.length };
    }
    const check = f.machine_check ? machine[f.machine_check] : null;
    if (check?.ok) {
      return { id: f.id, statement: f.statement, required_before: f.required_before ?? null,
        state: 'MACHINE_VERIFIED', machine_check: f.machine_check, detail: check.detail };
    }
    return { id: f.id, statement: f.statement, required_before: f.required_before ?? null,
      state: 'UNKNOWN', evidence_hint: f.evidence_hint ?? null,
      machine_check: f.machine_check ?? null, machine_detail: check?.detail ?? null };
  });
}

export const BASELINE_FACT = 'baseline_captured_before_first_transaction';
export const BASELINE_BANNER = 'BASELINE REQUIRED BEFORE FIRST REAL PCC TRANSACTION';

/**
 * The baseline gate. OPEN (warning in force) until a person attests the
 * baseline was captured. Supporting signals (frozen baseline files) are
 * reported, never used to close it, because a frozen file says the baseline
 * exists, not that it predates the first real purchase. Only a person at
 * Lippolis knows that.
 */
export function baselineGate(resolved, { frozenBaselines = 0 } = {}) {
  const fact = resolved.find((f) => f.id === BASELINE_FACT);
  const attested = fact?.state === 'HUMAN_VERIFIED';
  const warnings = [];
  if (attested && frozenBaselines === 0) {
    warnings.push('attested as captured, but no frozen baseline exists under proof/baselines/frozen/; run npm run baseline:freeze');
  }
  if (!attested && frozenBaselines > 0) {
    warnings.push(`${frozenBaselines} frozen baseline(s) exist, but nobody has attested they were captured BEFORE the first real purchase`);
  }
  return {
    status: attested ? 'CLEARED' : 'OPEN',
    banner: attested ? null : BASELINE_BANNER,
    fact: BASELINE_FACT,
    state: fact?.state ?? 'UNKNOWN',
    attested_by: fact?.attested_by ?? null,
    date: fact?.date ?? null,
    frozen_baselines: frozenBaselines,
    warnings,
    how_to_clear: attested ? null
      : 'Capture the baseline at Lippolis (docs/proof/BASELINE_DAY.md), freeze it (npm run baseline:freeze), then attest it yourself: npm run attest',
  };
}
