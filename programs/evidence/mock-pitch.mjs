// ---------------------------------------------------------------------------
// mock-pitch.mjs — what a listener took away, which is not what the pitcher felt.
//
// THE REHEARSAL LADDER IN milestones.mjs already sets the rungs: three people
// who can restate it by September, one timed five-minute pitch by November,
// five mock pitches by April. Every rung is keyed to `narrative.mockPitches` —
// a number somebody types. This file is what turns that number into evidence.
//
// A MOCK PITCH THAT ONLY THE PITCHER SCORED IS NOT A MOCK PITCH. It is a
// rehearsal, which is a different and also useful thing, and counting it would
// let the narrative band rise from practising alone in a room. So a record with
// no listener-reported content is accepted, kept, and does NOT count toward
// `mockPitches`. `rehearsals` is what it counts toward, which is the demo
// dimension's word for the same activity.
//
// AND IT IS NEVER MARKET EVIDENCE. A listener who liked the pitch has said
// something about the pitch. Twenty of them say nothing whatever about whether
// contractors have this problem, and the temptation to let a well-received
// rehearsal stand in for a phone call to a stranger is the single most
// available self-deception in this project — it is fun, it is repeatable, and
// it produces enthusiasm on demand. Nothing in this file writes to any
// discovery fact, and a test asserts it.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

/** Who was listening. Same axis as the comprehension test, for the same reason. */
export const LISTENERS = Object.freeze([
  'STRANGER', 'ACQUAINTANCE', 'FAMILY', 'COLLEAGUE',
  'INDUSTRY_INSIDER',      // works in trades or construction
  'INVESTOR_OR_JUDGE',     // has scored pitches before
  'TECHNICAL',             // will ask how it works
  'AWE_INSIDER',
]);

/** How far they would go on what they heard. Ordinal, and deliberately short. */
export const TRUST = Object.freeze([
  'WOULD_NOT_BELIEVE',
  'SCEPTICAL',
  'BELIEVED_WITH_RESERVATIONS',
  'BELIEVED',
  'NOT_ASKED',
]);

export const DEMO_EFFECT = Object.freeze(['NOT_SHOWN', 'NO_CHANGE', 'CLARIFIED', 'CHANGED_THEIR_MIND', 'CONFUSED_THEM']);

/**
 * One mock pitch, from the listener's side.
 *
 * `whatTheyThoughtItWas` is asked BEFORE any correction and is the most
 * valuable field in the record: it is the pitch's comprehension test, run on
 * the whole four minutes rather than on one sentence.
 */
export function mockPitch({
  id, at, listener, listenerBackground, format = 'FULL',
  whatTheyThoughtItWas = null, whatTheyRemembered = [],
  confusingPoint = null, strongestPoint = null, skepticalQuestion = null,
  trust = 'NOT_ASKED', demoShown = false, demoEffect = 'NOT_SHOWN',
  selfScore = null, notes = null,
}) {
  if (!id || !at || !listener || !listenerBackground) {
    throw new Error('a mock pitch needs an id, a date, who listened and their background');
  }
  if (!LISTENERS.includes(listener)) throw new Error(`unknown listener ${JSON.stringify(listener)}. One of: ${LISTENERS.join(', ')}`);
  if (!TRUST.includes(trust)) throw new Error(`unknown trust level ${JSON.stringify(trust)}. One of: ${TRUST.join(', ')}`);
  if (!DEMO_EFFECT.includes(demoEffect)) throw new Error(`unknown demoEffect ${JSON.stringify(demoEffect)}. One of: ${DEMO_EFFECT.join(', ')}`);
  if (demoShown && demoEffect === 'NOT_SHOWN') {
    throw new Error(`mock pitch ${id} says a demonstration was shown and records no effect — ask them whether it changed anything`);
  }
  if (!demoShown && demoEffect !== 'NOT_SHOWN') {
    throw new Error(`mock pitch ${id} records a demonstration effect and says no demonstration was shown`);
  }

  // WHAT MAKES IT COUNT. Something the listener said, that the pitcher did not
  // choose. One field is enough; zero is a rehearsal.
  const listenerEvidence = [whatTheyThoughtItWas, confusingPoint, strongestPoint, skepticalQuestion]
    .filter((v) => v && String(v).trim()).length + (whatTheyRemembered.length ? 1 : 0);

  return Object.freeze({
    id, at, listener, listenerBackground, format,
    whatTheyThoughtItWas, whatTheyRemembered: Object.freeze([...whatTheyRemembered]),
    confusingPoint, strongestPoint, skepticalQuestion,
    trust, demoShown, demoEffect, selfScore, notes,
    listenerEvidence,
    countsAsMockPitch: listenerEvidence > 0 && listener !== 'AWE_INSIDER',
    // Kept and named, so the report can say why it did not count.
    why: listener === 'AWE_INSIDER'
      ? 'the listener is inside the project — this is a rehearsal, not a test'
      : listenerEvidence === 0
        ? 'nothing the listener said was recorded — this is a rehearsal, not a test'
        : null,
  });
}

/**
 * The facts the narrative and demo dimensions read.
 *
 * TWO NUMBERS FROM ONE PILE, and keeping them apart is the whole job:
 * `mockPitches` is how many times a person told us something, `rehearsals` is
 * how many times it was delivered out loud. The second is larger and easier and
 * moves a different band.
 */
export function mockPitchFacts(pitches) {
  const counted = pitches.filter((p) => p.countsAsMockPitch);
  return Object.freeze({
    mockPitches: counted.length,
    rehearsals: pitches.length,
    listenersWhoUnderstood: counted.filter((p) => p.whatTheyThoughtItWas).length,
    demoChangedUnderstanding: counted.filter((p) => p.demoEffect === 'CLARIFIED' || p.demoEffect === 'CHANGED_THEIR_MIND').length,
    demoConfused: counted.filter((p) => p.demoEffect === 'CONFUSED_THEM').length,
  });
}

/**
 * What the listeners have taught us, pooled.
 *
 * REPEATED CONFUSION IS THE OUTPUT. One person losing the thread at the proof
 * beat is a person; three people losing it at the same beat is a beat that is
 * wrong, and that is the only finding here worth changing a deck for.
 */
export function mockPitchLearning(pitches) {
  const counted = pitches.filter((p) => p.countsAsMockPitch);
  const pool = (pick) => {
    const m = new Map();
    for (const p of counted) {
      const v = pick(p);
      if (!v) continue;
      const k = String(v).trim().toLowerCase();
      const e = m.get(k) ?? { text: String(v).trim(), listeners: [] };
      e.listeners.push(p.id);
      m.set(k, e);
    }
    return [...m.values()]
      .map((e) => Object.freeze({ text: e.text, count: e.listeners.length, pitches: Object.freeze([...e.listeners]) }))
      .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  };

  const trustRank = new Map(TRUST.map((t, i) => [t, i]));
  const asked = counted.filter((p) => p.trust !== 'NOT_ASKED');

  return Object.freeze({
    confusing: pool((p) => p.confusingPoint),
    strongest: pool((p) => p.strongestPoint),
    questions: pool((p) => p.skepticalQuestion),
    remembered: pool((p) => p.whatTheyRemembered.join('; ')),
    trustAsked: asked.length,
    // The worst answer anybody gave, because the pitch has to survive the most
    // sceptical person in the room, not the average of them.
    lowestTrust: asked.length
      ? asked.map((p) => p.trust).reduce((w, t) => (trustRank.get(t) < trustRank.get(w) ? t : w))
      : 'NOT_ASKED',
    // Repeated across listeners, which is the only kind worth acting on.
    repeatedConfusion: Object.freeze(pool((p) => p.confusingPoint).filter((r) => r.count >= 2)),
  });
}
