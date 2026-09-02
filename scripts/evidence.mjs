#!/usr/bin/env node
// AWE evidence CLI — the founder's interface to real-world evidence capture.
//
//   node scripts/evidence.mjs help
//
// Everything here is offline: no keys, no database, no network. Evidence lives
// as JSON files under evidence/ and is versioned by git.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  RECORD_TYPES, RECORD_TYPE_KEYS, THRESHOLDS, allFields, typeSpec, CONFIDENCE,
} from './lib/evidence/spec.mjs';
import { validateRecord } from './lib/evidence/validate.mjs';
import { buildFreeze, verifyFreeze } from './lib/evidence/freeze.mjs';
import { summarizeBaseline } from './lib/evidence/derive.mjs';
import { computeStatus } from './lib/evidence/status.mjs';
import { csvColumns, parseCSV, rowsToRecords } from './lib/evidence/csv.mjs';
import {
  loadRecords, loadFreezes, writeRecord, writeJSON, latestFreeze,
  freezePath, freezeVersionCount, RECORDS_DIR, EVIDENCE_DIR,
} from './lib/evidence/store.mjs';

const argv = process.argv.slice(2);
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };
const out = (s = '') => process.stdout.write(`${s}\n`);
const die = (m) => { process.stderr.write(`${C.r}error:${C.x} ${m}\n`); process.exit(1); };

function flag(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const nowISO = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// ---------------------------------------------------------------------------
// loading + validation
// ---------------------------------------------------------------------------

function loadAll() {
  const loaded = loadRecords();
  const manifests = new Map();
  for (const l of loaded) {
    if (l.record?.record_type === 'baseline_manifest') manifests.set(l.record.baseline_id, l.record);
  }
  return { loaded, manifests };
}

function validated() {
  const { loaded, manifests } = loadAll();
  return loaded.map((l) => {
    if (!l.record) return { ...l, ok: false, errors: [`JSON parse error: ${l.parseError}`], warnings: [] };
    const ctx = l.record.baseline_id ? { manifest: manifests.get(l.record.baseline_id) } : {};
    return { ...l, ...validateRecord(l.record, ctx) };
  });
}

const rel = (p) => p.replace(`${process.cwd()}/`, '');

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function cmdHelp() {
  out(`${C.b}AWE evidence CLI${C.x} — capture real-world evidence for the IIC campaign.

${C.b}Status${C.x}
  node scripts/evidence.mjs status                 IIC evidence status (real records only)

${C.b}Capture${C.x}
  node scripts/evidence.mjs new <record_type>      write a blank template with prompts
  node scripts/evidence.mjs questions <type>       print what to ASK / LOOK FOR
  node scripts/evidence.mjs types                  list record types

${C.b}Lippolis baseline${C.x}
  node scripts/evidence.mjs baseline sheet         printable paper capture sheet (15 POs)
  node scripts/evidence.mjs baseline csv           CSV header for typing POs in bulk
  node scripts/evidence.mjs baseline import <csv> --baseline <id> --by "Name"
  node scripts/evidence.mjs baseline summary [--baseline <id>]
  node scripts/evidence.mjs validate               validate every record on disk
  node scripts/evidence.mjs freeze <baseline_id> --by "Name" --attest "..."
  node scripts/evidence.mjs verify [baseline_id]   detect drift since freeze

${C.b}Observation window${C.x}
  node scripts/evidence.mjs window start --baseline <id> --by "Name" --commit <sha> --approval <id>
  node scripts/evidence.mjs window status

Record types: ${RECORD_TYPE_KEYS.join(', ')}
Protocol: evidence/PROTOCOL.md`);
}

function cmdTypes() {
  for (const k of RECORD_TYPE_KEYS) {
    const s = RECORD_TYPES[k];
    out(`${C.b}${k}${C.x}  ${C.d}[${s.milestone}]${C.x}`);
    out(`  ${s.summary.replace(/\s+/g, ' ')}\n`);
  }
}

function cmdQuestions() {
  const t = argv[1];
  if (!RECORD_TYPES[t]) die(`unknown type "${t || ''}". One of: ${RECORD_TYPE_KEYS.join(', ')}`);
  const s = typeSpec(t);
  out(`${C.b}${s.label}${C.x}\n${s.summary}\n`);
  out(`${C.b}Context to record about the encounter itself${C.x}`);
  for (const d of s.meta || []) {
    out(`  ${d.required ? '*' : ' '} ${C.b}${d.key}${C.x} — ${d.label}${d.values ? `  ${C.d}(${d.values.join(' | ')})${C.x}` : ''}`);
    if (d.ask) out(`      ${C.y}${d.ask}${C.x}`);
  }
  out(`\n${C.b}What to ask / look for${C.x}`);
  for (const d of s.fields || []) {
    out(`  ${d.required ? '*' : ' '} ${C.b}${d.key}${C.x} — ${d.label}${d.values ? `  ${C.d}(${d.values.join(' | ')})${C.x}` : ''}`);
    out(`      ${C.d}confidence allowed: ${d.confidences.join(', ')}${C.x}`);
    if (d.ask) out(`      ${C.y}“${d.ask}”${C.x}`);
  }
  out(`\n${C.d}* = required. Anything you did not capture must be recorded explicitly as`);
  out(`  {"value": null, "confidence": "unknown"} — never guessed, never omitted.${C.x}`);
}

function blankClaim(d) {
  const conf = d.confidences[0];
  const c = { value: null, confidence: 'unknown' };
  const extra = CONFIDENCE[conf]?.requires_claim || [];
  return Object.keys(c).length && extra.length
    ? { ...c, _hint: `set confidence to "${conf}" and add: ${extra.join(', ')}` }
    : c;
}

function cmdNew() {
  const t = argv[1];
  if (!RECORD_TYPES[t]) die(`unknown type "${t || ''}". One of: ${RECORD_TYPE_KEYS.join(', ')}`);
  const s = typeSpec(t);
  const id = flag('id') || `${t}-REPLACE-ME`;
  const rec = {
    record_id: id,
    record_type: t,
    record_class: flag('class', 'production'),
    captured_by: flag('by', 'REPLACE-ME'),
    captured_at: nowISO(),
  };
  for (const d of s.meta || []) rec[d.key] = null;
  if (t === 'baseline_po') {
    rec.awe_involved = false;
    rec.source_document = { kind: 'paper_purchase_order', identifier: null, physical_location: null, photographed: false, photo_ref: null };
  }
  rec.fields = {};
  for (const d of s.fields || []) rec.fields[d.key] = blankClaim(d);
  rec.notes = '';

  // Default to writing the file. Making the founder create directories and
  // manage shell redirects before capturing a single fact is exactly the kind of
  // friction that stops evidence from ever being collected.
  if (flag('stdout')) {
    out(JSON.stringify(rec, null, 2));
    return;
  }
  const path = writeRecord(rec);
  out(`${C.g}created${C.x} ${rel(path)}`);
  out(`\nNext:`);
  out(`  1. open it and fill in every null`);
  out(`  2. ${C.b}node scripts/evidence.mjs questions ${t}${C.x}   ${C.d}— what each field means / what to ask${C.x}`);
  out(`  3. ${C.b}node scripts/evidence.mjs validate${C.x}`);
  out(`\n${C.d}Anything you did not capture stays {"value": null, "confidence": "unknown"} — never guessed.${C.x}`);
  if (id.includes('REPLACE-ME')) {
    out(`${C.y}Pass --id <something> to name the record; this one is a placeholder.${C.x}`);
  }
}

// --- baseline: paper sheet -------------------------------------------------

function cmdBaselineSheet() {
  const s = typeSpec('baseline_po');
  const line = '-'.repeat(72);
  out(`LIPPOLIS PRE-AWE PURCHASING BASELINE — PO CAPTURE SHEET`);
  out(`Target: ${THRESHOLDS.baseline_po_target} POs (hard floor ${THRESHOLDS.baseline_po_min}), spanning >= ${THRESHOLDS.baseline_span_days_min} days.`);
  out(`EVERY field below must be readable OFF THE PAGE. If you have to ask a person,`);
  out(`it is not documentary — it belongs on the testimony sheet instead.`);
  out(line);
  for (let i = 1; i <= THRESHOLDS.baseline_po_target; i++) {
    out(`\nPO #${String(i).padStart(2, '0')}`);
    for (const d of s.fields) {
      const hint = d.values ? ` (${d.values.join('/')})` : '';
      out(`  ${(d.label + hint).padEnd(56, '.')} ______________`);
    }
    out(`  Photographed? (Y/N) .................................... ______________`);
    out(`  Anything unreadable — note it: ________________________________________`);
  }
  out(`\n${line}`);
  out(`Signed (transcriber): __________________________  Date: ______________`);
  out(`I attest these are faithful transcriptions of documents I physically handled.`);
}

// --- baseline: CSV ---------------------------------------------------------

function cmdBaselineCsv() {
  const cols = csvColumns();
  out(cols.join(','));
  out(cols.map((c) => {
    if (c === 'po_number') return '4417';
    if (c === 'po_date') return '2026-03-11';
    if (c === 'vendor') return 'Graybar';
    if (c === 'job_reference') return 'STOCK';
    if (c === 'requested_by') return 'M. Rivera';
    if (c === 'line_item_count') return '4';
    if (c === 'document_form') return 'handwritten_carbon';
    if (c === 'photographed') return 'Y';
    if (c === 'physical_location') return 'Lippolis office 2026 PO binder';
    if (c === 'source_identifier') return 'PO 4417';
    return '';
  }).join(','));
  process.stderr.write(`\n${C.d}Row 2 is an EXAMPLE — delete it. Leave a cell blank for anything you could not`
    + `\nread; blank imports as {"value": null, "confidence": "unknown"}, never as a guess.${C.x}\n`);
}

function cmdBaselineImport() {
  const file = argv[2];
  const baselineId = flag('baseline');
  const by = flag('by');
  if (!file || !existsSync(file)) die('usage: baseline import <file.csv> --baseline <id> --by "Name"');
  if (!baselineId) die('--baseline <id> is required (must match a baseline_manifest)');
  if (!by || by === true) die('--by "Your Name" is required — evidence with no author is not evidence');

  const rows = parseCSV(readFileSync(file, 'utf8'));
  const { records, problems } = rowsToRecords(rows, {
    baselineId, capturedBy: by, capturedAt: nowISO(),
  });

  for (const p of problems) out(`${C.y}note:${C.x} ${p}`);
  if (!records.length) die('no rows imported');

  const written = records.map((r) => writeRecord(r));
  out(`${C.g}imported${C.x} ${written.length} baseline_po record(s) into evidence/records/baseline_po/`);
  out(`\nNow run: ${C.b}node scripts/evidence.mjs validate${C.x}`);
}

// --- validate --------------------------------------------------------------

function cmdValidate() {
  const results = validated();
  if (!results.length) {
    out(`${C.y}no evidence records found${C.x} under evidence/records/.`);
    out(`Start with: node scripts/evidence.mjs new baseline_manifest`);
    return 0;
  }
  let bad = 0; let warnCount = 0;
  for (const r of results) {
    if (!r.ok) {
      bad++;
      out(`${C.r}FAIL${C.x} ${rel(r.path)}`);
      for (const e of r.errors) out(`     ${C.r}·${C.x} ${e}`);
    } else if (r.warnings.length) {
      out(`${C.y}WARN${C.x} ${rel(r.path)}`);
      for (const w of r.warnings) out(`     ${C.y}·${C.x} ${w}`);
      warnCount += r.warnings.length;
    } else {
      out(`${C.g}ok  ${C.x} ${rel(r.path)}`);
    }
  }
  out(`\n${results.length} record(s): ${C.g}${results.length - bad} valid${C.x}, `
    + `${bad ? C.r : ''}${bad} invalid${C.x}, ${warnCount} warning(s).`);
  if (warnCount) out(`${C.d}Warnings never block a freeze. They mark evidence that is real but weak.${C.x}`);
  return bad ? 1 : 0;
}

// --- baseline summary ------------------------------------------------------

function baselineParts(baselineId) {
  const results = validated().filter((r) => r.ok && r.record.record_class === 'production');
  const forId = (t) => results.map((r) => r.record)
    .filter((r) => r.record_type === t && (!baselineId || r.baseline_id === baselineId));
  const manifests = forId('baseline_manifest');
  return {
    manifest: manifests[0] || null,
    manifestCount: manifests.length,
    pos: forId('baseline_po'),
    testimonies: forId('baseline_testimony'),
    observations: forId('baseline_observation'),
  };
}

function cmdBaselineSummary() {
  const id = flag('baseline');
  const p = baselineParts(id);
  if (!p.manifest) die(`no valid production baseline_manifest${id ? ` for "${id}"` : ''}. Run: node scripts/evidence.mjs new baseline_manifest`);
  const s = summarizeBaseline(p);
  out(`${C.b}Baseline ${s.baseline_id}${C.x}  ${C.d}(${p.manifest.organization})${C.x}`);
  out(`${C.d}Scope: ${p.manifest.process_scope}${C.x}`);
  out(`${C.d}Window: ${p.manifest.window_start} → ${p.manifest.window_end}; AWE production start: ${p.manifest.awe_production_start ?? 'not yet'}${C.x}\n`);
  out(`${C.b}Documentary (traceable to paper)${C.x}`);
  out(JSON.stringify(s.documentary, null, 2));
  out(`\n${C.b}Human evidence${C.x}: ${s.testimony_count} testimony, ${s.observation_count} observation`);
  out(`\n${C.b}Clerical hours (the case-study number)${C.x}`);
  out(JSON.stringify(s.clerical_hours, null, 2));
  if (s.clerical_hours.available && s.clerical_hours.basis === 'estimate_propagated') {
    out(`\n${C.y}This figure contains propagated human estimates. Present it with its range, never alone.${C.x}`);
  } else if (s.clerical_hours.available && s.clerical_hours.basis === 'measured_thin') {
    out(`\n${C.y}Measured, but from a thin sample. Present the sample size alongside the number.${C.x}`);
  } else if (!s.clerical_hours.available) {
    out(`\n${C.y}No clerical-hours figure is available, and none will be invented.${C.x}`);
  }
  if (!s.sampling_exhaustive) {
    out(`\n${C.d}sampling_exhaustive=false: PO volume is taken from testimony, not from the sample rate.${C.x}`);
  }
  return 0;
}

// --- freeze / verify -------------------------------------------------------

function cmdFreeze() {
  const id = argv[1];
  const by = flag('by');
  const attest = flag('attest');
  const amend = flag('amend');
  if (!id) die('usage: freeze <baseline_id> --by "Name" --attest "..."');
  if (!by || by === true) die('--by "Your Name" is required');
  if (!attest || attest === true) {
    die('--attest "..." is required. State, in your own words, that these records are '
      + 'faithful transcriptions of documents you physically handled. A freeze is an attestation, not a button.');
  }

  const p = baselineParts(id);
  if (!p.manifest) die(`no valid production baseline_manifest for "${id}"`);

  // A freeze must never certify records that do not validate.
  const failing = validated().filter((r) => !r.ok && r.record?.baseline_id === id);
  if (failing.length) {
    out(`${C.r}refusing to freeze:${C.x} ${failing.length} record(s) in this baseline do not validate.`);
    for (const f of failing) out(`  ${rel(f.path)}: ${f.errors[0]}`);
    out(`\nRun: node scripts/evidence.mjs validate`);
    return 1;
  }

  // Evidentiary floors.
  const s = summarizeBaseline(p);
  const gates = [
    [p.pos.length >= THRESHOLDS.baseline_po_min, `>= ${THRESHOLDS.baseline_po_min} documentary POs`, `${p.pos.length}`],
    [(s.documentary.span_days ?? 0) >= THRESHOLDS.baseline_span_days_min, `sample spans >= ${THRESHOLDS.baseline_span_days_min} days`, `${s.documentary.span_days ?? 0} days`],
    [p.testimonies.length >= THRESHOLDS.baseline_testimony_min, `>= ${THRESHOLDS.baseline_testimony_min} testimony record`, `${p.testimonies.length}`],
    [p.observations.length >= THRESHOLDS.baseline_observation_min, `>= ${THRESHOLDS.baseline_observation_min} direct observation`, `${p.observations.length}`],
  ];
  const unmet = gates.filter(([ok]) => !ok);
  if (unmet.length) {
    out(`${C.r}refusing to freeze:${C.x} evidentiary floor not met.`);
    for (const [ok, what, have] of gates) out(`  ${ok ? `${C.g}✓${C.x}` : `${C.r}✗${C.x}`} ${what} — have ${have}`);
    out(`\n${C.d}These floors exist so the baseline cannot be dismissed as one lucky week.${C.x}`);
    return 1;
  }

  const prior = latestFreeze(id);
  if (prior && !amend) {
    out(`${C.r}refusing to freeze:${C.x} baseline "${id}" is already frozen (${prior.frozen_at}).`);
    out(`  hash: ${prior.baseline_hash}`);
    out(`\nA frozen baseline is never overwritten. To record a correction:`);
    out(`  node scripts/evidence.mjs freeze ${id} --by "Name" --attest "..." --amend "why this correction is necessary"`);
    out(`${C.d}The amendment chains to the prior hash; the original receipt stays on disk.${C.x}`);
    return 1;
  }

  const records = [...p.pos, ...p.testimonies, ...p.observations];
  const freeze = buildFreeze({
    baselineId: id,
    manifest: p.manifest,
    records,
    frozenBy: by,
    attestation: attest,
    frozenAt: nowISO(),
    priorHash: prior ? prior.baseline_hash : null,
    amendmentReason: amend && amend !== true ? amend : null,
  });

  const version = freezeVersionCount(id) + 1;
  const path = writeJSON(freezePath(id, version), freeze);
  out(`${C.g}FROZEN${C.x} ${id} v${version}`);
  out(`  records: ${freeze.record_count}  (${p.pos.length} PO, ${p.testimonies.length} testimony, ${p.observations.length} observation)`);
  out(`  hash:    ${freeze.baseline_hash}`);
  if (prior) out(`  amends:  ${prior.baseline_hash}`);
  out(`  receipt: ${rel(path)}`);
  out(`\n${C.b}Commit this receipt now${C.x} — an uncommitted freeze proves nothing about when it happened.`);
  out(`  git add evidence && git commit -m "evidence: freeze baseline ${id} v${version}"`);
  return 0;
}

function cmdVerify() {
  const only = argv[1];
  const freezes = loadFreezes().map((f) => f.freeze).filter(Boolean)
    .filter((f) => !only || f.baseline_id === only);
  if (!freezes.length) { out(`${C.y}no freeze receipts found${C.x}`); return 0; }

  let bad = 0;
  for (const f of freezes) {
    const p = baselineParts(f.baseline_id);
    if (!p.manifest) { out(`${C.r}FAIL${C.x} ${f.baseline_id}: manifest missing or invalid`); bad++; continue; }
    const records = [...p.pos, ...p.testimonies, ...p.observations];
    const v = verifyFreeze(f, { manifest: p.manifest, records });
    if (v.ok) {
      out(`${C.g}INTACT${C.x} ${f.baseline_id} (${f.record_count} records, frozen ${f.frozen_at})`);
      out(`       ${f.baseline_hash}`);
    } else {
      bad++;
      out(`${C.r}DRIFT${C.x}  ${f.baseline_id} — frozen evidence has changed since ${f.frozen_at}`);
      for (const d of v.drift) out(`       ${C.r}·${C.x} ${d.kind}: ${d.record_id}`);
      out(`       expected ${v.expected_hash}`);
      out(`       actual   ${v.actual_hash}`);
      out(`       ${C.d}Do NOT silently re-freeze. Either restore the records (git) or record an --amend.${C.x}`);
    }
  }
  return bad ? 1 : 0;
}

// --- observation window ----------------------------------------------------

function cmdWindow() {
  const sub = argv[1];
  if (sub === 'status') {
    const wins = validated().filter((r) => r.ok && r.record.record_type === 'observation_window').map((r) => r.record);
    if (!wins.length) { out(`${C.y}no observation windows declared${C.x}`); return 0; }
    for (const w of wins) {
      const open = !w.ended_at;
      const days = Math.round((Date.now() - Date.parse(w.started_at)) / 86400000);
      out(`${open ? C.g : C.d}${open ? 'OPEN' : 'CLOSED'}${C.x} ${w.window_id} vs baseline ${w.baseline_id}`);
      out(`  started ${w.started_at}${open ? ` (${days} days ago)` : ` → ${w.ended_at}`}`);
      out(`  commit ${w.commit_sha}, approval ${w.release_approval_id}`);
    }
    return 0;
  }

  if (sub !== 'start') die('usage: window start --baseline <id> --by "Name" --commit <sha> --approval <record_id>');

  const baselineId = flag('baseline');
  const by = flag('by');
  const commit = flag('commit');
  const approval = flag('approval');
  if (!baselineId || !by || by === true || !commit || !approval) {
    die('window start requires --baseline <id> --by "Name" --commit <sha> --approval <release_approval record_id>');
  }

  // Gate 1: the baseline must be frozen, or the comparison is retrofittable.
  const freeze = latestFreeze(baselineId);
  if (!freeze) {
    out(`${C.r}refusing to start:${C.x} baseline "${baselineId}" is not frozen.`);
    out(`A production window measured against an unfrozen baseline proves nothing —`);
    out(`the "before" numbers could still move after you see the "after" numbers.`);
    out(`\n  node scripts/evidence.mjs freeze ${baselineId} --by "Name" --attest "..."`);
    return 1;
  }

  // Gate 2: a real human must have authorized production use.
  const approvals = validated().filter((r) => r.ok && r.record.record_type === 'release_approval'
    && r.record.record_class === 'production');
  const found = approvals.find((r) => r.record.record_id === approval);
  if (!found) {
    out(`${C.r}refusing to start:${C.x} no valid production release_approval with record_id "${approval}".`);
    out(`Without a named human authorizing production use, this is a REHEARSAL, not production.`);
    out(`\n  node scripts/evidence.mjs new release_approval --id ${approval}`);
    return 1;
  }

  const verifyRc = (() => {
    const p = baselineParts(baselineId);
    const v = verifyFreeze(freeze, { manifest: p.manifest, records: [...p.pos, ...p.testimonies, ...p.observations] });
    return v.ok;
  })();
  if (!verifyRc) {
    out(`${C.r}refusing to start:${C.x} frozen baseline "${baselineId}" fails verification (drift).`);
    out(`  node scripts/evidence.mjs verify ${baselineId}`);
    return 1;
  }

  const id = flag('id') || `window-${baselineId}-${nowISO().slice(0, 10)}`;
  const rec = {
    record_id: id,
    record_type: 'observation_window',
    record_class: 'production',
    captured_by: by,
    captured_at: nowISO(),
    window_id: id,
    baseline_id: baselineId,
    baseline_freeze_hash: freeze.baseline_hash,
    release_approval_id: approval,
    started_at: nowISO(),
    ended_at: null,
    declared_by: by,
    commit_sha: String(commit),
    fields: {
      metrics_declared: { value: null, confidence: 'unknown' },
      success_definition: { value: null, confidence: 'unknown' },
      failure_definition: { value: null, confidence: 'unknown' },
    },
    notes: '',
  };
  const path = writeRecord(rec);
  out(`${C.g}window scaffolded${C.x} ${rel(path)}`);
  out(`  baseline ${baselineId} @ ${freeze.baseline_hash.slice(0, 16)}…`);
  out(`\n${C.y}NOT VALID YET.${C.x} You must fill in metrics_declared, success_definition and`);
  out(`failure_definition ${C.b}before${C.x} the window carries any weight — declaring what counts`);
  out(`as success after you have seen the results is how case studies become worthless.`);
  out(`\n  node scripts/evidence.mjs questions observation_window`);
  out(`  node scripts/evidence.mjs validate`);
  return 0;
}

// --- status ----------------------------------------------------------------

function cmdStatus() {
  const { loaded } = loadAll();
  const st = computeStatus({ loaded, freezes: loadFreezes() });

  out(`${C.b}IIC EVIDENCE STATUS${C.x}  ${C.d}(computed from validated production records only)${C.x}\n`);
  for (const m of st.milestones) {
    const head = m.complete ? `${C.g}COMPLETE${C.x}` : `${C.y}${m.met}/${m.total}${C.x}     `;
    out(`${head} ${C.b}${m.label}${C.x}`);
    for (const r of m.requirements) {
      out(`   ${r.met ? `${C.g}✓${C.x}` : `${C.r}✗${C.x}`} ${r.text} ${C.d}— ${r.detail}${C.x}`);
    }
    out('');
  }
  out(`${C.b}Evidence requirements met: ${st.score.met}/${st.score.total}${C.x}\n`);

  const c = st.counts;
  out(`${C.d}files=${c.files}  counting=${c.counting}  invalid=${c.invalid}  `
    + `parse_errors=${c.parse_errors}  excluded_non_production=${c.excluded_non_production}${C.x}`);

  if (c.excluded_non_production) {
    out(`\n${C.y}${c.excluded_non_production} valid record(s) excluded${C.x} for not being record_class "production" `
      + `(rehearsal/synthetic). This is deliberate: rehearsal activity can never raise IIC readiness.`);
  }
  if (c.invalid) {
    out(`\n${C.r}${c.invalid} record(s) do not validate and are NOT counted:${C.x}`);
    for (const i of st.invalid.slice(0, 10)) out(`  ${rel(i.path)}: ${i.errors[0]}`);
    out(`  ${C.d}node scripts/evidence.mjs validate${C.x}`);
  }
  if (st.warnings.length) {
    out(`\n${C.y}${st.warnings.length} warning(s) on counted evidence${C.x} ${C.d}(counted, but weak — see validate)${C.x}`);
  }
  if (c.files === 0) {
    out(`\n${C.b}Nothing captured yet.${C.x} The bottleneck is not this repository.`);
    out(`Start here:  ${C.b}node scripts/evidence.mjs baseline sheet${C.x}   (print it, take it to Lippolis)`);
  }
  return 0;
}

// ---------------------------------------------------------------------------

const cmd = argv[0];
let rc = 0;
try {
  mkdirSync(RECORDS_DIR, { recursive: true });
  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h': cmdHelp(); break;
    case 'types': cmdTypes(); break;
    case 'questions': cmdQuestions(); break;
    case 'new': cmdNew(); break;
    case 'validate': rc = cmdValidate(); break;
    case 'freeze': rc = cmdFreeze(); break;
    case 'verify': rc = cmdVerify(); break;
    case 'status': rc = cmdStatus(); break;
    case 'window': rc = cmdWindow(); break;
    case 'baseline': {
      const sub = argv[1];
      if (sub === 'sheet') cmdBaselineSheet();
      else if (sub === 'csv') cmdBaselineCsv();
      else if (sub === 'import') cmdBaselineImport();
      else if (sub === 'summary') rc = cmdBaselineSummary();
      else die('baseline: one of sheet | csv | import | summary');
      break;
    }
    default: die(`unknown command "${cmd}". Try: node scripts/evidence.mjs help`);
  }
} catch (e) {
  die(e.stack || e.message);
}
process.exit(rc);
