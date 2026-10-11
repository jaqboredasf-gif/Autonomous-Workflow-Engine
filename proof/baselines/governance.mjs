// ---------------------------------------------------------------------------
// governance.mjs — which baseline governs Case Study #001, and what stops it
// changing once the production results are in.
//
// THE FAILURE THIS EXISTS AGAINST, stated plainly because it is the one a judge
// will probe: the baseline says nineteen minutes, the production results come
// back thinner than hoped, and somebody re-reads the observation sheet and
// decides the tracking step was "obviously understated". Every step of that is
// sincere. The result is a baseline chosen, in part, by the answer it produces.
//
// DESIGN IT TWICE.
//
//   REJECTED — a `frozen: true` flag in the observation file. It is a boolean
//   anybody can flip, it records nothing about WHAT was frozen, and a later
//   edit to the observations beneath it leaves the flag looking just as true.
//   It would provide the appearance of governance and none of the substance,
//   which is worse than nothing because it would stop anybody asking.
//
//   CHOSEN — a content-addressed snapshot. Freezing writes a record carrying
//   the whole observation set, a digest of it, the derived handling time, the
//   grade, who established it and when. The live observation file may go on
//   changing; the frozen record is what governs. Any divergence between them is
//   DETECTABLE rather than forbidden, which is the right shape: a baseline must
//   be correctable — somebody will find a transcription error — and a
//   correction must be a visible, reasoned, versioned act rather than an edit.
//
// This mirrors deployment/APPROVED_RELEASE.md, where a person signs and the
// code reads. Same idea, same reason: the repository cannot approve itself.
//
// AMENDMENTS ARE VERSIONED, NEVER OVERWRITTEN. v2 supersedes v1, names its
// reason, and v1 stays on disk. A reader can therefore see that the baseline
// moved, when, by how much and why — which is the only thing that makes a
// correction distinguishable from a convenience.
//
// PURE: no clock, no randomness, no I/O. The caller loads and writes files.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/**
 * A stable digest of the EVIDENCE, and only the evidence.
 *
 * Deliberately excludes commentary — `_README`, notes, the reviewer's name —
 * so that fixing a typo in a comment does not read as tampering with a
 * measurement, and changing a measurement always does.
 *
 * Keys are sorted, so a re-serialisation with different key order is the same
 * evidence and hashes the same.
 */
export function digestOf(doc) {
  const evidence = {
    steps: Object.fromEntries(Object.entries(doc.steps ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([id, s]) => [id, {
        appliesToShare: s.appliesToShare ?? 1,
        observations: (s.observations ?? []).map(canonical).sort(cmp),
      }])),
    cycle: (doc.cycle?.observations ?? []).map(canonical).sort(cmp),
    labourRate: doc.labourRate?.centsPerHour ?? null,
  };
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

/** One observation, reduced to the fields that are evidence. */
function canonical(o) {
  return {
    minutes: o.seconds !== undefined && o.seconds !== null ? o.seconds / 60 : (o.minutes ?? null),
    method: o.method ?? null,
    observedBy: o.observedBy ?? null,
    at: o.at ?? null,
    ref: o.ref ?? null,
    raisedAt: o.raisedAt ?? null,
    receivedAt: o.receivedAt ?? null,
  };
}
const cmp = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));

/**
 * Freeze a baseline: the record that will govern Case Study #001.
 *
 * @param {object} spec
 * @param {object} spec.doc             the observation file, as loaded
 * @param {object} spec.baseline        the built baseline
 * @param {object} spec.handlingMinutes the derived total, as a quantity
 * @param {string} spec.establishedBy   a person. Not "the system".
 * @param {string} spec.at              when it was established, ISO
 * @param {string} spec.opensAt         when the production observation window opens
 * @param {number} [spec.version]
 * @param {string} [spec.supersedes]
 * @param {string} [spec.reason]        REQUIRED when superseding
 */
export function freeze({
  doc, baseline, handlingMinutes, establishedBy, at, opensAt,
  version = 1, supersedes = null, reason = null,
}) {
  if (!establishedBy) {
    throw new Error('a frozen baseline must name the person who established it — "the system" cannot vouch for an observation');
  }
  if (!at) throw new Error('a frozen baseline must say when it was established');
  if (!opensAt) {
    throw new Error(
      'a frozen baseline must say when the production observation window opens — ' +
      'without it, nothing decides which purchases are eligible for the case study');
  }
  if (at > opensAt) {
    throw new Error(
      `the observation window opens at ${opensAt}, before the baseline was established at ${at}. ` +
      'A baseline cannot govern work that predates it, so purchases in that gap would be unvaluable.');
  }
  if (supersedes && !reason) {
    throw new Error(
      `version ${version} supersedes ${supersedes} and gives no reason. ` +
      'An unexplained amendment to a baseline is indistinguishable from a convenient one.');
  }
  if (!handlingMinutes?.known) {
    throw new Error(
      'this baseline has no handling time, so there is nothing to freeze. ' +
      'Any step still UNAVAILABLE makes the whole baseline unavailable.');
  }

  return Object.freeze({
    baselineId: baseline.id,
    orgId: baseline.orgId,
    capability: 'purchasing',
    version,
    supersedes,
    reason,

    establishedBy,
    establishedAt: at,

    // WHAT WAS FROZEN. The digest is what makes a later edit visible; the
    // observation set is what makes the digest checkable by somebody who does
    // not trust it.
    evidenceDigest: digestOf(doc),
    observations: doc,

    // WHAT IT CAME OUT AS, recorded so a reader can recompute it.
    handlingMinutes: handlingMinutes.value,
    handlingGrade: handlingMinutes.provenance,
    stepGrades: Object.fromEntries(baseline.steps.map((s) => [s.id, s.minutes.provenance])),
    labourRateCentsPerHour: baseline.labourRate?.known ? baseline.labourRate.value : null,
    labourRateGrade: baseline.labourRate?.provenance ?? 'UNAVAILABLE',

    // THE START LINE. Purchases before this are not eligible for Case Study
    // #001, and purchases after it cannot quietly leave.
    observationWindow: Object.freeze({
      opensAt,
      governingBaselineVersion: version,
      inclusionRule: 'every purchase request this organization raised in this capability on or after opensAt, whatever became of it',
      denominatorRule: 'counted at the source; a case study whose population does not reconcile is NOT_READY',
    }),
  });
}

/**
 * Which frozen record governs, and has the evidence moved under it?
 *
 * `drifted` is not an error. It means somebody has changed the observations
 * since the baseline was frozen, and the case study is still being computed
 * against the frozen figures. That is exactly the situation a reader must be
 * told about, and exactly the situation a `frozen: true` flag would hide.
 */
export function governing(frozenRecords, liveDoc = null) {
  if (!frozenRecords.length) {
    return Object.freeze({
      established: false,
      record: null,
      drifted: false,
      because: 'no baseline has been frozen — nothing governs Case Study #001 yet',
    });
  }
  const superseded = new Set(frozenRecords.map((r) => r.supersedes).filter(Boolean));
  const live = frozenRecords.filter((r) => !superseded.has(String(r.version)) && !superseded.has(r.version));
  const record = [...live].sort((a, b) => b.version - a.version)[0] ?? frozenRecords.at(-1);

  const drifted = liveDoc !== null && digestOf(liveDoc) !== record.evidenceDigest;
  return Object.freeze({
    established: true,
    record,
    drifted,
    because: drifted
      ? `the observation file has changed since baseline v${record.version} was frozen on ` +
        `${record.establishedAt}. The case study is computed against the FROZEN evidence. ` +
        'If the change is a correction, freeze an amendment with a reason; if it is a mistake, revert it.'
      : `baseline v${record.version}, frozen ${record.establishedAt} by ${record.establishedBy}`,
    history: Object.freeze([...frozenRecords].sort((a, b) => a.version - b.version).map((r) => Object.freeze({
      version: r.version,
      at: r.establishedAt,
      by: r.establishedBy,
      handlingMinutes: r.handlingMinutes,
      grade: r.handlingGrade,
      reason: r.reason,
    }))),
  });
}

/**
 * Is this execution inside the observation window?
 *
 * The window is a property of the FROZEN baseline, not of the command line, so
 * a narrower `--from` cannot quietly shrink the population and a wider one
 * cannot quietly pull in purchases the baseline never governed.
 */
export function eligible(record, startedAt) {
  if (!record) return { ok: false, because: 'no frozen baseline, so no window is open' };
  if (String(startedAt) < String(record.observationWindow.opensAt)) {
    return {
      ok: false,
      because: `started ${startedAt}, before the observation window opened at ${record.observationWindow.opensAt}`,
    };
  }
  return { ok: true, because: null };
}
