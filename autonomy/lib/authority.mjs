// ---------------------------------------------------------------------------
// authority.mjs — who may do this, decided before anyone does it.
//
//   MACHINE_EXECUTABLE       the machine may do it end to end, on an autonomy
//                            branch, ending in a draft PR
//   HUMAN_APPROVAL_REQUIRED  the machine may PREPARE it; a person must approve
//                            (L3 paths, product code under the 2026-08-12 freeze)
//   JACK_ACTION_REQUIRED     physical, stakeholder, strategic or evidence work
//                            that only Jack can do
//   EXTERNAL_DEPENDENCY      waiting on someone else
//   BLOCKED                  a known blocker closes it to everyone but a person
//                            resolving that blocker
//
// The machine's paths are checked with the SAME guard that will refuse the
// change later (guard.mjs), so classification and enforcement cannot disagree.
//
// Pure.
// ---------------------------------------------------------------------------

import { checkChange, matches } from './guard.mjs';

/** Product behaviour is frozen to evidence-driven change (DECISION_LOG 2026-08-12). */
export const PRODUCT_PATHS = Object.freeze(['apps/**', 'apps/purchasing/src/', 'capability/**']);

export function classify(finding, policy, blockers) {
  const a = finding.action;
  if (finding.blocker) {
    return { class: 'BLOCKED', why: `blocker ${finding.blocker} is ${blockers.find((b) => b.id === finding.blocker)?.autonomous_action}; only a person resolving it may act` };
  }
  if (a.actor === 'JACK') return { class: 'JACK_ACTION_REQUIRED', why: 'needs a person at Lippolis, a decision, or a review' };
  if (a.actor === 'EXTERNAL') return { class: 'EXTERNAL_DEPENDENCY', why: 'waiting on someone outside AWE' };
  if (a.kind === 'observe-only') return { class: 'MACHINE_EXECUTABLE', why: 'runs verification; changes nothing' };

  const violations = checkChange({ paths: a.touches, ref: `${policy.autonomy_branch_prefix}classify` }, policy, blockers);
  const blockerHits = violations.filter((v) => v.rule.startsWith('blocker:'));
  if (blockerHits.length) return { class: 'BLOCKED', why: blockerHits.map((v) => v.detail).join('; ') };
  const l3 = violations.filter((v) => v.rule === 'l3');
  const product = a.touches.filter((p) => PRODUCT_PATHS.some((g) => matches(p, g) || p.startsWith(g)));
  if (l3.length || product.length) {
    return { class: 'HUMAN_APPROVAL_REQUIRED',
      why: [...l3.map((v) => v.detail), ...product.map((p) => `${p} is product code; changes need evidence and approval (2026-08-12)`)].join('; ') };
  }
  return { class: 'MACHINE_EXECUTABLE', why: `every path it touches (${a.touches.join(', ')}) is outside L3, product code and open blockers` };
}
