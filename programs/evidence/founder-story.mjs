// ---------------------------------------------------------------------------
// founder-story.mjs — the five facts nobody in this repository witnessed.
//
// programs/iic-2027/founder-story.md lists them and deliberately leaves them
// blank: role, period, the specific incident, whether the first system was
// built while employed, and the relationship today. They are the one part of a
// pitch a judge cannot check, which is exactly why they must be the part that
// would survive checking.
//
// SO THIS FILE HOLDS A FORM, NOT A STORY. Each field is either confirmed by
// Jack with a date, or it is absent. There is no default, no placeholder, and
// no `false` with an excuse — the same rule facts.mjs applies to declarations,
// for the same reason: three months later a placeholder is indistinguishable
// from an answer.
//
// AND IT SCORES NOTHING. No readiness band moves when this is filled in, and
// none should: the founder story earns its place by making the problem
// credible, and the published rubric has no team criterion. What it does move
// is `mustNotSay` — until the incident is confirmed, telling it on stage is
// prohibited, and the evidence snapshot says so in those words.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

/**
 * The five, with what a good answer looks like.
 *
 * `whyItMatters` is not decoration. Each of these is asked for a reason, and a
 * field whose reason is not written down gets filled in with whatever sounds
 * best.
 */
export const FIELDS = Object.freeze([
  {
    id: 'role',
    ask: 'What did you actually do at the business, in the words the business would use?',
    whyItMatters: 'A judge who hears "I worked in construction" and later learns it was two summers has stopped believing the rest of the pitch, not this sentence.',
  },
  {
    id: 'period',
    ask: 'When, and for how long?',
    whyItMatters: 'Proximity is the claim. Its size is the first thing anybody checks.',
  },
  {
    id: 'incident',
    ask: 'One request, one day, one thing that went wrong, and what it cost. Not a category.',
    whyItMatters: 'A story needs one Tuesday. "Purchasing was inefficient" is a slide; a crew standing in a yard at 7am is a story, and it is the beat the whole pitch opens on.',
  },
  {
    id: 'builtWhileEmployed',
    ask: 'Was the first system built while working there, or afterwards — and with whose knowledge?',
    whyItMatters: 'Easy to state ambiguously by accident, and a question with an unclear answer is the one a judge remembers.',
  },
  {
    id: 'relationshipToday',
    ask: 'What is the relationship now: employee, contractor, former employee, family?',
    whyItMatters: 'A judge may ask, and vagueness here is far more damaging than any answer. It also decides whether Lippolis is a customer or a favour, which the market beat depends on.',
  },
]);

export const FIELD_IDS = Object.freeze(FIELDS.map((f) => f.id));

/**
 * One filled-in form.
 *
 * A field is `{ value, confirmedBy, confirmedAt }` or absent. `confirmedBy` is
 * a person's name because these are somebody's memories, and a memory with no
 * owner is a draft.
 */
export function founderStory(input = {}) {
  const fields = {};
  for (const f of FIELD_IDS) {
    const v = input[f];
    if (v === null || v === undefined || v === '') { fields[f] = null; continue; }
    if (typeof v !== 'object' || !v.value) {
      throw new Error(
        `founder story field "${f}" is a bare value. Say who confirmed it and when:\n` +
        `  ${f}: { value: '...', confirmedBy: 'Jack Daly', confirmedAt: '2026-09-05' }`);
    }
    if (!v.confirmedBy || !v.confirmedAt) {
      throw new Error(`founder story field "${f}" has no confirmedBy/confirmedAt — an unconfirmed founder fact is the one thing that must not be said out loud`);
    }
    fields[f] = Object.freeze({ value: v.value, confirmedBy: v.confirmedBy, confirmedAt: v.confirmedAt });
  }

  const confirmed = FIELD_IDS.filter((f) => fields[f]);
  return Object.freeze({
    fields: Object.freeze(fields),
    confirmed: Object.freeze(confirmed),
    outstanding: Object.freeze(FIELD_IDS.filter((f) => !fields[f])),
    complete: confirmed.length === FIELD_IDS.length,
    // THE ONE THING THIS CHANGES. Not a band — a prohibition.
    mayTellTheIncident: Boolean(fields.incident),
  });
}

export function founderStoryFacts(story) {
  return Object.freeze({
    founderStory: Object.freeze({
      confirmed: story.confirmed.length,
      total: FIELD_IDS.length,
      outstanding: story.outstanding,
      complete: story.complete,
      mayTellTheIncident: story.mayTellTheIncident,
    }),
  });
}
