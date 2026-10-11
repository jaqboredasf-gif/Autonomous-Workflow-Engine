// ---------------------------------------------------------------------------
// blockers.mjs — what exactly prevents this organization going live.
//
// THE QUESTION THIS ANSWERS, and the reason it exists: at the end of PCC's
// development the honest answer to "what is stopping us?" was one hostname, and
// producing that answer took a person reading several documents. It should be a
// function of the manifest.
//
// NOT EVERY UNKNOWN BLOCKS, and treating them alike is what makes a blocker list
// worthless. A missing runtime version stops the build. A missing hostname does
// not — you can build, install, start and test on an IP address, and only
// go-live genuinely needs the name. So each field names the earliest phase it
// blocks, and the report is per phase.
//
// The four phases are the real decision points of the PCC deployment, in order:
//
//   REQUIRED_BEFORE_BUILD    cannot produce an artifact
//   REQUIRED_BEFORE_DEPLOY   cannot install it on the machine
//   REQUIRED_BEFORE_GO_LIVE  cannot let real users on it
//   NON_BLOCKING             wanted, not load-bearing
// ---------------------------------------------------------------------------

import { isKnown } from './facts.mjs';
import { FIELDS, resolve } from './manifest.mjs';
import { ownerFor } from './responsibilities.mjs';

export const BLOCKER_PHASES = [
  'REQUIRED_BEFORE_BUILD',
  'REQUIRED_BEFORE_DEPLOY',
  'REQUIRED_BEFORE_GO_LIVE',
  'NON_BLOCKING',
];

/** Phases in order, so "everything blocking at or before X" is expressible. */
const PHASE_ORDER = { REQUIRED_BEFORE_BUILD: 0, REQUIRED_BEFORE_DEPLOY: 1, REQUIRED_BEFORE_GO_LIVE: 2, NON_BLOCKING: 99 };

/**
 * Every unresolved fact that blocks something, with who can clear it.
 *
 * A field blocks when it is UNKNOWN and its phase is not NON_BLOCKING. Fields
 * classed `optional` still appear if they carry a blocking phase — "optional"
 * describes whether the application needs a value, and the phase describes
 * whether the deployment can proceed without one. PCC's reverse proxy is
 * optional to the software and required before go-live.
 */
export function blockers(manifest) {
  const facts = resolve(manifest);
  const out = [];

  for (const [path, spec] of Object.entries(FIELDS)) {
    if (spec.blocks === 'NON_BLOCKING') continue;
    const fact = facts[path];
    if (isKnown(fact)) continue;
    out.push({
      path,
      phase: spec.blocks,
      owner: ownerFor(manifest, spec),
      why: spec.desc || 'required by the deployment contract',
      reason: fact?.reason ?? 'not established',
    });
  }

  out.sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || a.path.localeCompare(b.path));
  return out;
}

/** Only what blocks a given phase. */
export function blockersForPhase(manifest, phase) {
  return blockers(manifest).filter((b) => b.phase === phase);
}

/**
 * Everything standing between the deployment and a phase — that phase and every
 * earlier one, because you cannot go live on something you could not deploy.
 */
export function blockersUpTo(manifest, phase) {
  const limit = PHASE_ORDER[phase];
  return blockers(manifest).filter((b) => PHASE_ORDER[b.phase] <= limit);
}

/** Can the deployment pass this phase on what is currently known? */
export function canPass(manifest, phase) {
  return blockersUpTo(manifest, phase).length === 0;
}

/**
 * The furthest phase this deployment could reach today.
 *
 * Reports what KNOWLEDGE permits, not what has been done — evidence.mjs decides
 * what has actually happened. Both are needed: a deployment can be fully
 * specified and not yet built, or built and missing the hostname it needs to go
 * live, and confusing those two produces a status nobody trusts.
 */
export function furthestReachablePhase(manifest) {
  if (!canPass(manifest, 'REQUIRED_BEFORE_BUILD')) return 'BLOCKED_BEFORE_BUILD';
  if (!canPass(manifest, 'REQUIRED_BEFORE_DEPLOY')) return 'BUILD_ONLY';
  if (!canPass(manifest, 'REQUIRED_BEFORE_GO_LIVE')) return 'DEPLOY_ONLY';
  return 'GO_LIVE';
}

/** A short human summary. The sentence somebody actually wants. */
export function summarize(manifest) {
  const all = blockers(manifest);
  if (!all.length) return 'Nothing unresolved blocks this deployment.';
  const byPhase = new Map();
  for (const b of all) byPhase.set(b.phase, (byPhase.get(b.phase) ?? 0) + 1);
  const parts = [...byPhase].map(([phase, n]) => `${n} before ${phase.replace('REQUIRED_BEFORE_', '').toLowerCase()}`);
  const owners = [...new Set(all.map((b) => b.owner))].join(', ');
  return `${all.length} unresolved: ${parts.join(', ')}. Owned by: ${owners}.`;
}
