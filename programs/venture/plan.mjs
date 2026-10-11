// ---------------------------------------------------------------------------
// plan.mjs — the loop, closed.
//
//   BUSINESS CLAIM -> REQUIRED EVIDENCE -> CURRENT EVIDENCE -> PROOF GAP
//   -> STAGE GATE -> HIGHEST-LEVERAGE ACTION -> EXECUTION -> VERIFIED RESULT
//   -> UPDATED READINESS
//
// Everything left of "highest-leverage action" is claims.mjs and gates.mjs.
// This file is the arrow from a gap to an action, and the whole design problem
// is that there is more than one right answer at a time: the thing to BUILD and
// the thing a founder should DO this week are usually different, they do not
// compete for the same hours, and a planner that returns one of them silently
// tells somebody to stop doing the other.
//
// So the answer is one action PER TRACK. Never a ranked list of twelve, which
// is a backlog wearing a hat.
//
// NO PROBABILITY OF WINNING. Nothing here estimates a likelihood of winning the
// Iona Innovation Challenge, and the temptation to produce one should be
// resisted every time it recurs. A number like "63% ready" is unfalsifiable,
// moves for reasons nobody can trace, and becomes the thing people optimise.
// What this reports instead is: which gate, which evidence is missing, and what
// single action removes the most of it. Every one of those is checkable.
//
// THE RANKING, in full, because a planner nobody can argue with is a planner
// nobody trusts:
//
//   1. Gate first. A claim serving the CURRENT gate outranks every claim
//      serving a later one, whatever its leverage. Evidence collected out of
//      order is usually evidence collected twice.
//   2. Then leverage = (1 + unblocked claims it unlocks) / cost, the same shape
//      the readiness scorecard uses, so the two cannot rank things differently
//      for different reasons.
//   3. Then the weaker grade, because moving UNAVAILABLE to anything is worth
//      more than polishing INFERRED.
//
// AND TWO REFUSALS, which do most of the useful work:
//
//   · A claim whose prerequisites have no evidence is never recommended. It is
//     reported as blocked, with what blocks it.
//   · An EXTERNAL claim is never an action. Nobody at AWE can move it by
//     working harder, and putting it in front of somebody as a task is how a
//     plan starts lying.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { assessClaims, weakestGrade, GRADES } from './claims.mjs';
import { assessGates, currentGate, nextGate, gateOf } from './gates.mjs';

const COST_RANK = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3 });
const GRADE_RANK = new Map(GRADES.map((g, i) => [g, i]));

/**
 * The whole plan, from one set of facts.
 *
 * Facts come from programs/iic-2027/derive.mjs and nowhere else. This function
 * measures nothing; if it did, there would be two answers to every question it
 * reports on.
 */
export function plan(facts = {}) {
  const claims = assessClaims(facts);
  const gates = assessGates(facts, claims);
  const gate = currentGate(gates);
  const next = nextGate(gates);
  const byId = new Map(claims.map((c) => [c.id, c]));

  // THE CANDIDATE SET, and everything excluded from it is excluded on purpose:
  //
  //   already MEASURED     nothing to gain
  //   blockedBy non-empty  a prerequisite has no evidence; working on it is
  //                        wasted motion, and the plan says what to do instead
  //   not actionable       earned as a consequence, not built
  //   EXTERNAL             nobody at AWE can move it by working harder
  //
  // The EXTERNAL exclusion is stated HERE rather than left to `pick()` filtering
  // by track. A mutation test found that version unreachable — deleting the rule
  // changed nothing, because pick() is only ever called with the two internal
  // tracks — and a rule that cannot be broken cannot be relied on either. The
  // candidate set is exported so the rule is checkable rather than incidental.
  const movable = claims.filter((c) =>
    c.grade !== 'MEASURED' &&
    c.blockedBy.length === 0 &&
    c.actionable &&
    c.track !== 'EXTERNAL');

  const ranked = movable
    .map((c) => {
      const unlocks = c.unlocks.filter((u) => (byId.get(u)?.grade ?? 'UNAVAILABLE') !== 'MEASURED').length;
      return {
        ...c,
        unlocks_n: unlocks,
        gate: gateOf(c.id),
        leverage: (1 + unlocks) / COST_RANK[c.cost],
      };
    })
    .sort((a, b) =>
      a.gate - b.gate ||
      b.leverage - a.leverage ||
      GRADE_RANK.get(b.grade) - GRADE_RANK.get(a.grade) ||
      a.id.localeCompare(b.id));

  const pick = (track) => {
    const top = ranked.find((c) => c.track === track);
    if (!top) return null;
    const runnerUp = ranked.find((c) => c.track === track && c.id !== top.id);
    return Object.freeze({
      claim: top.id,
      statement: top.claim,
      gate: top.gate,
      grade: top.grade,
      because: top.because,
      cost: top.cost,
      unlocks: top.unlocks_n,
      action: top.nextAction,
      missing: top.missing,
      thenNext: runnerUp ? Object.freeze({ claim: runnerUp.id, action: runnerUp.nextAction }) : null,
    });
  };

  const engineering = pick('ENGINEERING');
  const founder = pick('FOUNDER');

  // WHAT NOT TO BUILD YET, derived rather than listed. Two kinds, and the
  // second is the one that costs a small company its year:
  //
  //   BLOCKED  — the evidence cannot be collected yet, whatever we build.
  //   PREMATURE — buildable, and it belongs to a gate we have not reached. This
  //               is where a pitch deck, a dashboard and a third proof
  //               abstraction all live, and every one of them feels productive.
  const currentN = gate?.n ?? Number.POSITIVE_INFINITY;

  // Anything recommended on any track is, by definition, not something to
  // avoid. Without this the plan listed the founder's own next conversation
  // under "do not build yet", which is the kind of contradiction that gets a
  // planning tool closed and never reopened.
  const recommended = new Set([engineering, founder]
    .flatMap((h) => (h ? [h.claim, h.thenNext?.claim] : []))
    .filter(Boolean));

  const notYet = Object.freeze([
    ...claims
      .filter((c) => c.blockedBy.length > 0 && c.grade !== 'MEASURED' && !recommended.has(c.id))
      .map((c) => Object.freeze({
        claim: c.id, kind: 'BLOCKED',
        because: `waiting on ${c.blockedBy.join(' and ')} — no amount of building moves it`,
      })),
    // PREMATURE APPLIES TO ENGINEERING ONLY. Gate order exists to stop us
    // BUILDING out of sequence: engineering hours are the scarce thing and
    // spending them on gate 3 while gate 1 is open is the classic failure.
    // Founder work is deliberately out of gate order — a conversation this week
    // costs no engineering hours and its evidence takes months to accumulate,
    // so starting it early is correct rather than premature.
    // Earned, not built. Naming them here is what stops somebody deciding that
    // "AWE produces measurable value" is an engineering problem.
    ...claims
      .filter((c) => !c.actionable && c.blockedBy.length === 0 && c.grade !== 'MEASURED')
      .map((c) => Object.freeze({
        claim: c.id, kind: 'CONSEQUENCE',
        because: `${c.because} — earned when the evidence arrives, not by building`,
      })),
    ...claims
      .filter((c) => c.actionable && c.track === 'ENGINEERING' && c.blockedBy.length === 0 &&
        c.grade !== 'MEASURED' && gateOf(c.id) > currentN + 1 && !recommended.has(c.id))
      .map((c) => Object.freeze({
        claim: c.id, kind: 'PREMATURE',
        because: `engineering for gate ${gateOf(c.id)} while gate ${currentN} is open`,
      })),
  ]);

  const withEvidence = claims.filter((c) => c.grade !== 'UNAVAILABLE');
  const strongest = [...withEvidence].sort((a, b) =>
    GRADE_RANK.get(a.grade) - GRADE_RANK.get(b.grade) || a.id.localeCompare(b.id))[0] ?? null;
  const weakest = [...claims].sort((a, b) =>
    GRADE_RANK.get(b.grade) - GRADE_RANK.get(a.grade) ||
    gateOf(a.id) - gateOf(b.id) || a.id.localeCompare(b.id))[0] ?? null;

  return Object.freeze({
    claims: Object.freeze(claims),
    gates: Object.freeze(gates),
    // Everything that could have been recommended, in the order it was ranked.
    // Exported so the exclusions above are testable rather than trusted.
    candidates: Object.freeze(ranked.map((c) => Object.freeze({
      claim: c.id, track: c.track, gate: c.gate, grade: c.grade,
      cost: c.cost, unlocks: c.unlocks_n, leverage: c.leverage,
    }))),
    currentGate: gate,
    nextGate: next,
    // The gap: everything the CURRENT gate is missing, in one list, because
    // that is the list somebody is actually working from.
    proofGap: Object.freeze(gate
      ? [
        ...gate.requirements.filter((r) => !r.met).map((r) => Object.freeze({
          kind: 'REQUIREMENT', id: r.id, what: r.what, detail: r.detail,
        })),
        ...gate.unsupportedClaims.map((id) => Object.freeze({
          kind: 'CLAIM', id, what: byId.get(id).claim, detail: byId.get(id).because,
        })),
      ]
      : []),
    highestLeverage: engineering,
    founderHighestLeverage: founder,
    // Named, never actionable. Somebody still has to chase them; they are not
    // engineering work and pretending otherwise is how a plan starts lying.
    externalBlockers: Object.freeze(claims
      .filter((c) => c.track === 'EXTERNAL' && c.grade !== 'MEASURED')
      .map((c) => Object.freeze({ claim: c.id, because: c.because, missing: c.missing }))),
    notYet,
    strongestEvidence: strongest && Object.freeze({ claim: strongest.id, grade: strongest.grade, because: strongest.because }),
    weakestEvidence: weakest && Object.freeze({ claim: weakest.id, grade: weakest.grade, because: weakest.because }),
    overallGrade: weakestGrade(claims),
  });
}

/** The plan as text. One page, and the first line is the answer. */
export function render(p) {
  const L = [];
  const rule = '='.repeat(72);
  L.push('AWE — PROOF-DRIVEN VENTURE PLAN');
  L.push(rule);
  L.push('');

  if (p.currentGate) {
    L.push(`CURRENT GATE   ${p.currentGate.n}. ${p.currentGate.name}`);
    L.push(`               ${p.currentGate.question}`);
    L.push(`NEXT GATE      ${p.nextGate ? `${p.nextGate.n}. ${p.nextGate.name}` : '— this is the last one'}`);
  } else {
    L.push('CURRENT GATE   every gate is passed. Check the facts before believing that.');
  }
  L.push('');

  L.push('WHAT THIS GATE IS MISSING');
  if (!p.proofGap.length) L.push('  nothing.');
  for (const g of p.proofGap) {
    L.push(`  · [${g.kind}] ${g.what}`);
    L.push(`      ${g.detail}`);
  }
  L.push('');

  const act = (title, hl) => {
    L.push(title);
    if (!hl) { L.push('  nothing movable on this track.'); L.push(''); return; }
    L.push(`  ${hl.action}`);
    L.push('');
    L.push(`  claim: ${hl.statement}  (gate ${hl.gate}, ${hl.grade}, ${hl.cost.toLowerCase()} cost` +
      (hl.unlocks ? `, unlocks ${hl.unlocks}` : '') + ')');
    L.push(`  today: ${hl.because}`);
    if (hl.thenNext) L.push(`  then:  ${hl.thenNext.action}`);
    L.push('');
  };
  act('HIGHEST-LEVERAGE ACTION — engineering', p.highestLeverage);
  act('PARALLEL — founder, this week, needs nobody\'s permission', p.founderHighestLeverage);

  if (p.externalBlockers.length) {
    L.push('WAITING ON SOMEBODY ELSE (not work — chase, do not build)');
    for (const b of p.externalBlockers) L.push(`  · ${b.claim} — ${b.because}`);
    L.push('');
  }

  L.push(`STRONGEST EVIDENCE   ${p.strongestEvidence ? `${p.strongestEvidence.claim} [${p.strongestEvidence.grade}] — ${p.strongestEvidence.because}` : 'none'}`);
  L.push(`WEAKEST EVIDENCE     ${p.weakestEvidence ? `${p.weakestEvidence.claim} [${p.weakestEvidence.grade}] — ${p.weakestEvidence.because}` : 'none'}`);
  L.push('');

  L.push('DO NOT BUILD YET');
  if (!p.notYet.length) L.push('  nothing is out of order.');
  for (const n of p.notYet) L.push(`  · ${n.claim} — ${n.because}`);
  L.push('');

  L.push('THE TWELVE CLAIMS');
  for (const c of p.claims) {
    L.push(`  ${c.grade.padEnd(14)} ${c.id}`);
    L.push(`                 ${c.because}`);
  }
  L.push('');
  L.push(rule);
  L.push('No probability of winning is computed. Gates, gaps and one action per track.');
  return L.join('\n');
}
