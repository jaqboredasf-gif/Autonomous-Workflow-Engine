// ---------------------------------------------------------------------------
// cycle.mjs — one supervised improvement cycle, as a record a later AWE can read.
//
// OBSERVE → INSPECT → PRIORITIZE → PLAN → BUILD → VERIFY → EVALUATE → REPORT → RECORD
//
// The record is the substrate for learning later, so it keeps what was
// believed (finding, score, authority, expected impact) next to what happened
// (diff, verification, verdict, human disposition, measured impact). Nothing
// here learns. It only makes sure there will be something true to learn from.
//
// THE LEDGER. autonomy/cycles/ledger.jsonl holds one line per finished cycle:
// the sha256 of that cycle's record file and of the line before it. Editing an
// old record, or a line, breaks every hash after it, and verifyLedger() says
// where. It is tamper-evident, not tamper-proof: git history is the backstop.
//
// Phases, in order. A cycle may stop at DECIDED (nothing qualifies) or at
// EVALUATED (REJECT with no attempts left); it always reaches FINISHED.
//
// Pure: no clock, no I/O.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export const PHASES = Object.freeze(['OBSERVED', 'DECIDED', 'DISPATCHED', 'COLLECTED', 'PUSHED', 'EVALUATED', 'PR_OPENED', 'FINISHED']);

/** JSON with sorted keys, so the same record always hashes the same. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const hashOf = (value) => sha256(canonical(value));

/** c20261011T143000Z-555c882: sortable, unique per second and commit, and a valid branch name. */
export function newCycleId(nowIso, head) {
  return `c${nowIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${head.slice(0, 7)}`;
}

export function advance(record, phase, at) {
  const from = PHASES.indexOf(record.phase);
  const to = PHASES.indexOf(phase);
  if (to < 0) throw new Error(`unknown phase ${phase}`);
  if (to <= from) throw new Error(`cycle ${record.cycle_id} is ${record.phase}; it cannot go back to ${phase}`);
  return { ...record, phase, timeline: [...record.timeline, { phase, at }] };
}

/** One ledger line for a finished record, chained to the line before it. */
export function ledgerEntry(record, recordText, prev) {
  const entry = {
    cycle_id: record.cycle_id,
    finished_at: record.finished_at,
    observed_commit: record.observed.commit,
    selected: record.decision?.selected ?? null,
    outcome: record.outcome?.status ?? null,
    verdict: record.evaluation?.verdict ?? null,
    branch: record.build?.branch ?? null,
    head: record.build?.head ?? null,
    pr: record.pr?.url ?? null,
    record_sha256: sha256(recordText),
    prev_sha256: prev?.entry_sha256 ?? null,
  };
  return { ...entry, entry_sha256: hashOf(entry) };
}

/** Every break in the chain, with the line it is on. `records` maps cycle_id → record file text. */
export function verifyLedger(entries, records = {}) {
  const problems = [];
  entries.forEach((e, i) => {
    const { entry_sha256, ...rest } = e;
    if (hashOf(rest) !== entry_sha256) problems.push(`line ${i + 1} (${e.cycle_id}): the line was edited`);
    const prev = i ? entries[i - 1].entry_sha256 : null;
    if (e.prev_sha256 !== prev) problems.push(`line ${i + 1} (${e.cycle_id}): does not follow line ${i}`);
    if (e.cycle_id in records && sha256(records[e.cycle_id]) !== e.record_sha256) problems.push(`line ${i + 1} (${e.cycle_id}): the record file was edited`);
  });
  return problems;
}

/** What the cycle says it expected, kept beside what was later measured. */
export function expectedImpact(finding) {
  if (!finding) return null;
  return {
    claims: finding.claims ?? [],
    north_star: finding.priority?.breakdown?.north_star?.[1] ?? null,
    value: finding.factors?.value?.[1] ?? null,
    unlock: finding.factors?.unlock?.[1] ?? null,
  };
}

const list = (xs) => (xs?.length ? xs.map((x) => `- ${x}`).join('\n') : '- none');

/** The Captain Brief: what a person needs, in the order they need it. */
export function renderBrief(r) {
  const d = r.decision ?? {};
  const sel = d.selected_finding;
  const ev = r.evaluation;
  const lines = [
    `# Captain Brief — cycle ${r.cycle_id}`,
    '',
    `**Outcome: ${r.outcome?.status ?? r.phase}**${ev ? ` · evaluator verdict **${ev.verdict}**` : ''}${r.pr?.url ? ` · draft PR ${r.pr.url}` : ''}`,
    '',
    '## What AWE observed',
    `- commit \`${r.observed.commit.slice(0, 12)}\` on \`${r.observed.branch}\`; engineering **${r.observed.engineering}** (verification source: ${r.observed.verification_source ?? 'none'}; CI ${r.observed.ci?.status ?? 'n/a'})`,
    `- North Star gate ${r.observed.gate ?? '?'}; ${r.observed.days_to_deadline ?? '?'} days to the IIC evidence deadline; baseline ${r.observed.baseline}`,
    `- install readiness ${r.observed.install_readiness}; ${r.observed.open_autonomy_prs} other autonomy PR(s) awaiting review`,
    '',
    '## Highest-leverage constraint',
    d.top ? `- **${d.top.id}** (score ${d.top.score}, ${d.top.authority}): ${d.top.finding}` : '- none found',
    '',
    '## What AWE selected, and why it had authority',
    sel ? `- **${sel.id}** (score ${sel.score}): ${sel.finding}\n- authority: ${sel.authority.class} — ${sel.authority.why}` : `- nothing: ${d.headline}`,
    ...(d.reasons?.length ? ['- decision reasons:', ...d.reasons.map((x) => `  - ${x}`)] : []),
    '',
    '## What it changed',
    r.build ? `- branch \`${r.build.branch}\` from \`${r.build.base.slice(0, 12)}\` → head \`${r.build.head?.slice(0, 12) ?? '—'}\`; attempt ${r.build.attempts} of ${r.package?.max_attempts}` : '- nothing',
    ...(r.build?.changes ?? []).map((c) => `  - ${c.status} ${c.path} (+${c.added_count} −${c.removed_count})`),
    '',
    '## Verification and evaluation',
    ...(ev ? ev.checks.map((c) => `- ${c.status === 'PASS' ? '✅' : c.status === 'FAIL' ? '❌' : '❔'} **${c.id}** — ${c.detail}`) : ['- not evaluated']),
    ev ? `\n**Evaluator verdict: ${ev.verdict}.** The Builder cannot override it, and ACCEPT is not a merge: a person decides that.` : '',
    '',
    '## Expected North Star impact',
    r.impact?.expected ? `- claims: ${r.impact.expected.claims.join(', ') || 'none'}\n- ${r.impact.expected.north_star ?? ''}\n- value: ${r.impact.expected.value ?? '—'}\n- unlock: ${r.impact.expected.unlock ?? '—'}` : '- none',
    '',
    '## Actual measured impact',
    `- **${r.impact?.actual?.status ?? 'UNKNOWN'}** — ${r.impact?.actual?.why ?? 'nothing has been measured'}`,
    '',
    '## Risks and findings remaining',
    list(r.remaining),
    '',
    '## What Jack must do',
    list(r.jack),
    '',
    '## Recommended next action',
    `- ${r.next ?? '—'}`,
    '',
    `<sub>Record: autonomy/cycles/${r.cycle_id}.json · inputs: ${Object.entries(r.inputs ?? {}).map(([k, v]) => `${k} ${String(v).slice(0, 12)}`).join(', ')}</sub>`,
  ];
  return lines.join('\n') + '\n';
}
