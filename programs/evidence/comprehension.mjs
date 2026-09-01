// ---------------------------------------------------------------------------
// comprehension.mjs — can a normal person say what AWE is, after hearing it once?
//
// THE WEAKEST BEAT IN THE PITCH, and the cheapest one to move. Two of the eight
// published judging criteria — idea articulation and overall impression — are
// pure narrative, so half the remaining marks are won by being understood. And
// unlike every other gap in this repository, this one needs no deployment, no
// customer and no permission: it needs five people and ten minutes each.
//
// WHAT IS BEING TESTED, precisely, because the wrong version of this test is
// worse than no test:
//
//   NOT recall.       Whether they can repeat the sentence is a memory test and
//                     tells us nothing. A person who parrots it back word for
//                     word and cannot say what the company does has failed.
//   NOT approval.     "That sounds great" is politeness. It is not recorded and
//                     there is no field for it.
//   MENTAL MODEL.     Whether, in their OWN words, four ideas survived the
//                     journey from our sentence into their head.
//
// THE FOUR CONCEPTS are the four things the canonical sentence is carrying, and
// they are named in narrative.mjs where the sentence lives. A test that scored
// wording rather than concepts would reward polish and punish paraphrase, which
// is exactly backwards: a person who says "it does the office paperwork by
// itself, following your rules" has understood AWE better than one who recites
// "moving information between people, paper, email and software".
//
// NO STATISTICS. Five people is five people. Nothing here computes a
// confidence interval, a percentage of a population, or a significance, and the
// summary sentence is written so it cannot be misread as one: "four of the five
// people asked", never "80% of people".
//
// PURE: no clock, no randomness, no I/O. Records are loaded by the caller.
// ---------------------------------------------------------------------------

/**
 * The four ideas the sentence has to carry.
 *
 * Each has a `survives` note describing what a person saying it in their own
 * words sounds like, because the founder scoring the test is the person least
 * able to hear their own sentence, and a rule they have to interpret in the
 * moment is a rule that drifts toward the answer they wanted.
 */
export const CONCEPTS = Object.freeze([
  {
    id: 'business_operations_work',
    label: 'This is about a business\'s routine operational work',
    survives: 'they name office work, paperwork, admin, orders, approvals — something a business does every day. ' +
      'NOT "it helps businesses", NOT "productivity".',
  },
  {
    id: 'execution_not_advice',
    label: 'It DOES the work; it does not advise, suggest or answer',
    survives: 'a verb of doing: does it, handles it, runs it, sends it, files it. ' +
      'If they say it "helps you", "tells you" or "gives you insights", this concept did not survive — and that is the ' +
      'single most important failure this test can find, because it is the one thing that separates AWE from every ' +
      'assistant the listener has already met.',
  },
  {
    id: 'company_rules',
    label: 'It works under the company\'s own rules',
    survives: 'rules, permissions, approvals, "the way that company does it", "it can\'t just do anything". ' +
      'NOT "it\'s safe", NOT "it has guardrails" — those are our words for it, not theirs.',
  },
  {
    id: 'reduced_human_handling',
    label: 'People stop having to carry the work',
    survives: 'they name somebody who no longer does something: "so nobody has to type it", "the office manager ' +
      'doesn\'t have to chase it". NOT "it saves time" on its own, which is what everything claims.',
  },
]);

export const CONCEPT_IDS = Object.freeze(CONCEPTS.map((c) => c.id));

/** How one concept fared. */
export const CONCEPT_OUTCOMES = Object.freeze(['PRESENT', 'GARBLED', 'ABSENT']);

/** One person's result. */
export const VERDICTS = Object.freeze(['NOT_TESTED', 'CONFUSING', 'PARTIALLY_UNDERSTOOD', 'CLEAR']);

/**
 * How close the listener is to the project.
 *
 * AWE_INSIDER IS REFUSED, not down-weighted. Anybody who has helped build this,
 * heard the pitch before, or been talked at about it over dinner cannot be
 * surprised by the sentence, and one such record in a sample of five would move
 * the only number that says whether the explanation works.
 */
export const RELATIONSHIPS = Object.freeze([
  'STRANGER',
  'ACQUAINTANCE',
  'FAMILY',
  'COLLEAGUE',
  'INDUSTRY_INSIDER',   // works in construction or trades; understands the domain, not the product
  'AWE_INSIDER',        // refused
]);

/**
 * One plain-language test.
 *
 * `restatement` is REQUIRED and is the whole record. Everything else is scoring;
 * that field is the evidence, and six months later it is the only part anybody
 * can check the scoring against.
 */
export function comprehensionTest({
  id, at, person, background, relationship,
  explanationVersion, delivery = 'SPOKEN',
  restatement, verbatimEcho = false,
  concepts = {}, questions = [], confusions = [], notes = null,
}) {
  if (!id || !at || !person || !background || !relationship) {
    throw new Error('a comprehension test needs an id, a date, who was asked (initials are enough), their background and their relationship to AWE');
  }
  if (!RELATIONSHIPS.includes(relationship)) {
    throw new Error(`unknown relationship ${JSON.stringify(relationship)}. One of: ${RELATIONSHIPS.join(', ')}`);
  }
  if (relationship === 'AWE_INSIDER') {
    throw new Error(
      `comprehension test ${id} was run on somebody inside the project. That is not a test of the explanation, ` +
      'it is a test of whether they remember it. Ask somebody who has not heard of AWE.');
  }
  if (!explanationVersion) {
    throw new Error(
      `comprehension test ${id} does not say which version of the explanation was used. Without it a revision ` +
      'that made the sentence worse is indistinguishable from a run of unlucky listeners.');
  }
  if (!restatement || !String(restatement).trim()) {
    throw new Error(
      `comprehension test ${id} records no restatement. What they said back, in their words, IS the evidence — ` +
      'a scored test with no words under it cannot be checked by anybody, including you in three months.');
  }

  const scored = {};
  for (const c of CONCEPT_IDS) {
    const v = concepts[c] ?? 'ABSENT';
    if (!CONCEPT_OUTCOMES.includes(v)) {
      throw new Error(`comprehension test ${id}: concept ${c} is ${JSON.stringify(v)}. One of: ${CONCEPT_OUTCOMES.join(', ')}`);
    }
    scored[c] = v;
  }

  // A PARROT IS NOT A PASS. If the person repeated the sentence rather than
  // restating it, nothing can be concluded about their mental model, so every
  // concept is forced to GARBLED and the verdict falls out as CONFUSING. This
  // is the one place the record overrides what the founder typed, and it is
  // deliberate: "they said it back perfectly" is the most flattering possible
  // result and the least informative.
  const effective = verbatimEcho
    ? Object.fromEntries(CONCEPT_IDS.map((c) => [c, 'GARBLED']))
    : scored;

  const present = CONCEPT_IDS.filter((c) => effective[c] === 'PRESENT');
  const garbled = CONCEPT_IDS.filter((c) => effective[c] === 'GARBLED');

  return Object.freeze({
    id, at, person, background, relationship, explanationVersion, delivery,
    restatement: String(restatement).trim(),
    verbatimEcho,
    concepts: Object.freeze(scored),
    effectiveConcepts: Object.freeze(effective),
    conceptsPresent: Object.freeze(present),
    conceptsGarbled: Object.freeze(garbled),
    questions: Object.freeze([...questions]),
    confusions: Object.freeze([...confusions]),
    notes,
    ...verdictOf(present, garbled, verbatimEcho),
  });
}

/**
 * The verdict, from the concepts alone.
 *
 * THE RULE, written out so it can be argued with rather than tuned:
 *
 *   CLEAR                 all four concepts survived
 *   PARTIALLY_UNDERSTOOD  execution-not-advice survived, and at least one other
 *   CONFUSING             anything else
 *
 * EXECUTION IS LOAD-BEARING. Three concepts out of four sounds like a good
 * result and is not, if the missing one is the one that says AWE does the work.
 * A listener who understood everything except that has understood a different
 * product — one that already exists, that they have already dismissed, and that
 * is what they will describe to somebody else. So it is required for anything
 * above CONFUSING, and a test asserts it.
 */
function verdictOf(present, garbled, verbatimEcho) {
  const executes = present.includes('execution_not_advice');
  if (present.length === CONCEPT_IDS.length) {
    return { verdict: 'CLEAR', why: 'all four concepts survived in their own words' };
  }
  if (executes && present.length >= 2) {
    return {
      verdict: 'PARTIALLY_UNDERSTOOD',
      why: `${present.length} of ${CONCEPT_IDS.length} concepts survived, including that AWE does the work`,
    };
  }
  if (verbatimEcho) {
    return { verdict: 'CONFUSING', why: 'they repeated the sentence rather than restating it, so nothing can be concluded about what they understood' };
  }
  if (!executes) {
    return {
      verdict: 'CONFUSING',
      why: 'they did not come away with the idea that AWE does the work — the one thing that separates it from an assistant' +
        (garbled.length ? `; garbled: ${garbled.join(', ')}` : ''),
    };
  }
  return { verdict: 'CONFUSING', why: `only ${present.length} of ${CONCEPT_IDS.length} concepts survived` };
}

/** How many people are needed before the sample says anything at all. */
export const FIRST_SAMPLE = 5;

/**
 * The sample, summarised.
 *
 * WORDED SO IT CANNOT BE MISQUOTED. `say` is the sentence to use out loud, and
 * it counts people. `mustNotSay` is the sentence somebody will reach for.
 */
export function comprehensionSummary(tests) {
  const valid = tests.filter((t) => t.relationship !== 'AWE_INSIDER');
  const clear = valid.filter((t) => t.verdict === 'CLEAR');
  const partial = valid.filter((t) => t.verdict === 'PARTIALLY_UNDERSTOOD');
  const confusing = valid.filter((t) => t.verdict === 'CONFUSING');
  const backgrounds = new Set(valid.map((t) => String(t.background).trim().toLowerCase()));

  // Which concept fails most often. The most actionable output in the file:
  // it says which clause of the sentence to rewrite.
  const failures = Object.fromEntries(CONCEPT_IDS.map((c) => [c,
    valid.filter((t) => t.effectiveConcepts[c] !== 'PRESENT').length]));
  // TIES BREAK ON WHICH IDEA MATTERS MOST, not alphabetically. When three
  // concepts fail equally often, sending somebody to rewrite the clause about
  // company rules rather than the one that says AWE does the work would be the
  // scorecard picking the least important repair by accident of spelling.
  const PRIORITY = ['execution_not_advice', ...CONCEPT_IDS.filter((c) => c !== 'execution_not_advice')];
  const weakest = CONCEPT_IDS.slice()
    .sort((a, b) => failures[b] - failures[a] || PRIORITY.indexOf(a) - PRIORITY.indexOf(b))[0] ?? null;

  const verdict = sampleVerdict({ n: valid.length, clear: clear.length, confusing: confusing.length });

  return Object.freeze({
    tested: valid.length,
    excluded: tests.length - valid.length,
    clear: clear.length,
    partiallyUnderstood: partial.length,
    confusing: confusing.length,
    distinctBackgrounds: backgrounds.size,
    conceptFailures: Object.freeze(failures),
    // Null when nothing failed. Naming a "weakest" concept out of four ties at
    // zero would send somebody to rewrite a clause that is working.
    weakestConcept: failures[weakest] > 0 ? weakest : null,
    verdict: verdict.verdict,
    why: verdict.why,
    // THE FACT THE SCORECARD READS. People who restated it CORRECTLY — which is
    // what facts.mjs has always said this number means.
    plainLanguageTests: clear.length,
    say: valid.length === 0
      ? 'Nothing. Nobody outside the project has been asked to say back what AWE is.'
      : `${clear.length} of ${valid.length} ${valid.length === 1 ? 'person' : 'people'} asked restated what AWE does correctly, in their own words, after hearing the explanation once.`,
    mustNotSay: 'Any percentage. This is a handful of people the founder knows, not a sample of anything.',
    remainingToFirstSample: Math.max(0, FIRST_SAMPLE - valid.length),
  });
}

/**
 * The sample verdict.
 *
 * CONFUSING WINS ON ANY CONFUSION, above the threshold, and that asymmetry is
 * on purpose. An explanation that lands for four people and loses the fifth is
 * not a working explanation; it is a working explanation for people like the
 * first four, and a judging panel is not four people like the first four.
 */
function sampleVerdict({ n, clear, confusing }) {
  if (n === 0) return { verdict: 'NOT_TESTED', why: 'nobody has been asked' };
  if (n < FIRST_SAMPLE) {
    return { verdict: 'NOT_TESTED', why: `${n} of ${FIRST_SAMPLE} people asked so far — below the first sample, one result is a person, not a signal` };
  }
  if (confusing > 0) {
    return { verdict: 'CONFUSING', why: `${confusing} of ${n} people did not come away with what AWE does` };
  }
  if (clear === n) return { verdict: 'CLEAR', why: `all ${n} people restated it correctly` };
  return { verdict: 'PARTIALLY_UNDERSTOOD', why: `${clear} of ${n} restated it fully; the rest got part of it and nobody was lost` };
}

/**
 * Did a revision of the sentence make it better or worse?
 *
 * THE FAILURE THIS EXISTS AGAINST: the sentence gets rewritten in October, the
 * next five people do worse, and because the tests are pooled the number barely
 * moves and nobody notices that the edit was the cause. Versions are compared,
 * never merged, and a version that scores worse than its predecessor is
 * reported as a regression in those words.
 */
export function byVersion(tests) {
  const m = new Map();
  for (const t of tests) {
    if (t.relationship === 'AWE_INSIDER') continue;
    const e = m.get(t.explanationVersion) ?? [];
    e.push(t);
    m.set(t.explanationVersion, e);
  }
  const rows = [...m.entries()].map(([version, ts]) => Object.freeze({
    version,
    tested: ts.length,
    clear: ts.filter((t) => t.verdict === 'CLEAR').length,
    confusing: ts.filter((t) => t.verdict === 'CONFUSING').length,
    firstTestedAt: ts.map((t) => t.at).sort()[0],
  })).sort((a, b) => a.firstTestedAt.localeCompare(b.firstTestedAt) || a.version.localeCompare(b.version));

  // Compared on the share who were lost, not on the share who were CLEAR: the
  // question a revision has to answer is whether it lost fewer people.
  const regressions = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (!prev.tested || !cur.tested) continue;
    if (cur.confusing / cur.tested > prev.confusing / prev.tested) {
      regressions.push(Object.freeze({
        from: prev.version, to: cur.version,
        was: `${prev.confusing} of ${prev.tested} lost`,
        now: `${cur.confusing} of ${cur.tested} lost`,
        note: 'the revision performed worse than the version it replaced',
      }));
    }
  }
  return Object.freeze({ rows: Object.freeze(rows), regressions: Object.freeze(regressions) });
}

/**
 * The protocol. Five steps, ten minutes, no equipment.
 *
 * STEP 3 IS THE ONE PEOPLE SKIP and it is the one that makes the test a test:
 * the gap between hearing and restating is where a mental model either formed
 * or did not. Asking immediately measures echo.
 */
export const PROTOCOL = Object.freeze([
  'Say the explanation ONCE, at normal speed. Do not repeat it, do not add an example, do not answer a question with a second version of it.',
  'Say nothing else about AWE. No "so basically", no company name, no demo.',
  'Talk about something else for two minutes. Anything.',
  'Ask: "If a friend asked you what that thing does, what would you tell them?" Write down what they say, in their words, before you score anything.',
  'Then ask what they would want to know, and what did not make sense. Write those down too — a question is the most useful thing in this test, because it names the hole.',
]);
