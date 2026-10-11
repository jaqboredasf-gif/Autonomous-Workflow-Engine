// ---------------------------------------------------------------------------
// artifacts.mjs — the four things that actually get submitted, as budgets.
//
// The competition asks for three milestones and then a pitch:
//
//   MILESTONE 1  a 1-minute video          verified
//   MILESTONE 2  an executive summary      verified
//   MILESTONE 3  a pitch slide deck        verified
//   THE FINAL    a four-minute pitch, then Q&A   verified for the 2nd annual
//                                                (2019); 2027 format UNKNOWN
//
// EACH ONE IS A BUDGET, and that is the only honest way to design them. Sixty
// seconds holds about 150 spoken words. Twelve beats do not fit in 150 words,
// and pretending otherwise is how a video ends up being a list of features read
// quickly. So every artifact here declares which beats it CARRIES, which it
// DROPS, and what it costs to drop them — and the drop list is the design.
//
// NOTHING HERE IS COPY. No script, no slide text, no shot list. Those are
// written from this, late, once the evidence exists — see MASTER_SPEC.md §26 for
// what must not be built yet and why. What is written now is the shape, because
// the shape is what future evidence slots into.
//
// THE RECORDING GATE is the part worth having in code. An artifact built on
// evidence that is not yet real cannot be un-submitted, and a video is the
// first thing due and the hardest to retract — it is scored twice, once as
// Milestone 1 and once as the Fan Favourite. So each artifact states the
// evidence threshold below which it should not be MADE, and `producible()`
// answers that from the same facts as everything else.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { BEATS } from './narrative.mjs';

const BEAT_IDS = new Set(BEATS.map((b) => b.id));

/**
 * @typedef {object} Artifact
 * @property {string} id
 * @property {string} name
 * @property {string} purpose      what this artifact is FOR — never "to explain AWE"
 * @property {string} budget       the hard constraint
 * @property {string[]} carries    beat ids, in the order they appear
 * @property {Array<{beat:string, why:string}>} drops   and what it costs
 * @property {object[]} structure  the segments, with their own budgets
 * @property {object} threshold    the evidence below which this should not be made
 */

export const ARTIFACTS = Object.freeze([
  // -------------------------------------------------------------------------
  {
    id: 'one_minute_video',
    name: 'Milestone 1 — the one-minute video',
    purpose:
      'To advance, and to be watched by strangers. It is the only artifact scored twice: as a ' +
      'milestone and as the basis of the $1,000 Fan Favourite, which is decided on public ' +
      'engagement. It is due first, it is seen first, and it is the only one a judge may watch ' +
      'before deciding how interested to be in the rest.',
    budget: '60 seconds. About 150 spoken words. One idea, one proof, one image people remember.',
    carries: ['moment', 'what_awe_is', 'execution', 'proof', 'close'],
    drops: [
      { beat: 'discovery', why: 'compressed to one clause inside the opening — "the job I was doing" — rather than a beat' },
      { beat: 'before', why: 'the demonstration shows the old path faster than a description of it' },
      { beat: 'market', why: 'no external evidence exists yet; with it, this is the first beat to buy back time for' },
      { beat: 'repeatability', why: 'requires setup the format cannot afford; it is the deck\'s job' },
      { beat: 'business', why: 'nobody shares a video because of a pricing model' },
      { beat: 'expansion', why: 'a vision claim in a 60-second video with no proof behind it reads as a student overreaching' },
      { beat: 'defensibility', why: 'an answer with no question in front of it' },
    ],
    structure: [
      { at: '0–8s', segment: 'HOOK', beat: 'moment',
        mustShow: 'the real workplace, and the real artifact of the problem — the paper, the phone, the filing cabinet',
        mustNotShow: 'a stock photo, a statistic, a logo animation, the founder\'s face before the problem' },
      { at: '8–20s', segment: 'PROBLEM', beat: 'moment',
        mustShow: 'one request travelling: field to phone to office to paper to vendor. Named steps, real screens.',
        mustNotShow: 'a market-size number; a claim about "businesses everywhere" that no interview supports' },
      { at: '20–35s', segment: 'WHAT AWE IS', beat: 'what_awe_is',
        mustShow: 'ONE_SENTENCE.spoken, said once, over the product doing the thing it describes',
        mustNotShow: 'architecture, agents, any word from the prohibited list in MASTER_SPEC.md §3' },
      { at: '35–50s', segment: 'PROOF', beat: 'proof',
        mustShow: 'the strongest REAL figure that exists on the day of recording, on screen, with what it is measured against',
        mustNotShow: 'a figure the case-study standard would not publish; a rehearsal presented as production' },
      { at: '50–60s', segment: 'CLOSE', beat: 'close',
        mustShow: 'the human consequence, and the name AWE, held long enough to be read',
        mustNotShow: 'a funding ask, a QR code, a feature list' },
    ],
    threshold: {
      what: 'At least one REAL figure in the proof segment, produced by proof/ from a production database and publishable under the case-study standard.',
      why:
        'The video is the first thing anybody sees and the hardest thing to retract. A version ' +
        'recorded on architecture alone teaches its audience that AWE is a plan, and the second ' +
        'version does not get watched again. If January arrives with no production figure, the ' +
        'proof segment becomes the EXECUTION segment extended — the product doing real work, ' +
        'stated as capability rather than as result — and the video is still honest.',
      slots: ['production_executions'],
      fallback: 'Extend the execution segment to 35–50s and cut the proof claim entirely. Do not estimate.',
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'executive_summary',
    name: 'Milestone 2 — the executive summary',
    purpose:
      'To be read by somebody deciding whether this is serious, probably quickly, possibly before ' +
      'the pitch. Whether judges read it before pitching is UNKNOWN; write it as though they do.',
    budget: 'One to two pages. Every section earns its lines from the beat behind it.',
    carries: ['moment', 'discovery', 'before', 'what_awe_is', 'proof', 'market', 'repeatability', 'business', 'expansion', 'defensibility', 'close'],
    drops: [
      { beat: 'execution', why: 'a live demonstration does not survive being written down; it becomes a feature list. The proof section carries the result instead.' },
    ],
    structure: [
      { section: 'Problem', beat: 'moment', evidence: ['workflow_before', 'customer_quote'] },
      { section: 'Solution', beat: 'what_awe_is', evidence: ['plain_language_test'] },
      { section: 'Customer', beat: 'market', evidence: ['external_interviews'] },
      { section: 'Product', beat: 'before', evidence: ['governance', 'live_execution'] },
      { section: 'Validation', beat: 'proof', evidence: ['production_executions', 'objective_success', 'hours_returned'] },
      { section: 'Business model', beat: 'business', evidence: ['unit_of_sale', 'price_tested'] },
      { section: 'Differentiation', beat: 'defensibility', evidence: ['alternatives'] },
      { section: 'Go to market', beat: 'market', evidence: ['design_partner', 'repeated_pain'] },
      { section: 'Traction', beat: 'repeatability', evidence: ['second_organization', 'deployment_cost'] },
      { section: 'Vision', beat: 'expansion', evidence: ['second_capability'] },
      { section: 'Founder', beat: 'discovery', evidence: ['founder_proximity'] },
    ],
    threshold: {
      what: 'No threshold on writing it. A hard rule on its content: the summary develops NO narrative truth of its own.',
      why:
        'Every figure in it must be reachable from evidence-index.md to something a person can go ' +
        'and check, and a section whose evidence slots are empty says what is missing rather than ' +
        'filling the space. A document that quietly rounds up is the one artifact that discredits ' +
        'all the others, because it is the one a judge can re-read afterwards.',
      slots: [],
      fallback: 'Sections with empty slots shrink to a sentence naming what is not yet known. They are not deleted; an absent section reads as an oversight, a short one reads as rigour.',
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'deck',
    name: 'Milestone 3 — the pitch slide deck',
    purpose:
      'To be presented from, and to be flipped through afterwards by somebody who was not in the ' +
      'room. Those are different documents and this one has to be both, which is why every slide ' +
      'has a single takeaway that survives without the speaker.',
    budget: 'Twelve slides, one per beat, plus a title. A thirteenth slide requires a beat to be cut.',
    carries: BEATS.map((b) => b.id),
    drops: [],
    // The per-slide specification lives in DECK_SLIDES below; it is the same
    // list of beats with the presentation-craft fields attached, and it is
    // separate so that the beat definition stays about ARGUMENT and the slide
    // definition stays about CRAFT.
    structure: [],
    threshold: {
      what: 'A slide whose beat is NOT_READY carries the honest sentence, not a placeholder graphic.',
      why:
        'The deck is where bloat happens, because a slide is cheap to add and expensive to remove ' +
        'once it has been rehearsed. Every beat carries a kill condition for this reason, and the ' +
        'deck is the artifact those kill conditions are written against.',
      slots: [],
      fallback: 'Merge the weak slide into its neighbour rather than deleting the argument.',
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'final_pitch',
    name: 'The final — four minutes, then Q&A',
    purpose:
      'To win. Everything else qualifies for this. Four minutes and a Q&A is verified for the 2nd ' +
      'annual (2019) and is UNKNOWN for 2027 — confirm at the kickoff before rehearsing to it.',
    budget:
      'Four minutes. About 600 spoken words, minus whatever the demonstration takes, and the ' +
      'demonstration should take 60–75 seconds of it. That leaves roughly 450 words for eleven ' +
      'beats, which is why six of them are cut.',
    carries: ['moment', 'what_awe_is', 'execution', 'proof', 'market', 'repeatability', 'close'],
    drops: [
      { beat: 'discovery', why: 'one clause inside the opening: "I was the one carrying the paper."' },
      { beat: 'before', why: 'the demonstration shows it' },
      { beat: 'business', why: 'one sentence at the end of repeatability, unless the price has been tested' },
      { beat: 'expansion', why: 'one sentence inside the close. A vision beat costs 40 seconds and is the first thing a judge discounts.' },
      { beat: 'defensibility', why: 'held for Q&A, where it is an answer rather than a defence nobody requested' },
    ],
    structure: [
      { at: '0:00–0:35', segment: 'The moment', beat: 'moment' },
      { at: '0:35–1:00', segment: 'What AWE is', beat: 'what_awe_is' },
      { at: '1:00–2:15', segment: 'Watch it work', beat: 'execution' },
      { at: '2:15–3:00', segment: 'What it actually accomplished', beat: 'proof' },
      { at: '3:00–3:25', segment: 'Not just this company', beat: 'market' },
      { at: '3:25–3:50', segment: 'Not just this workflow', beat: 'repeatability' },
      { at: '3:50–4:00', segment: 'Close', beat: 'close' },
    ],
    threshold: {
      what: 'A rehearsed backup demonstration, and answers to the three questions that end in an admission.',
      why:
        'Whether a live demonstration is permitted at the final is UNKNOWN. A pitch whose middle ' +
        '75 seconds depends on a network it has never tested is a pitch with a coin flip in it.',
      slots: ['demo_backup'],
      fallback: 'The recorded demonstration, played, narrated live. Same story, no network.',
    },
  },
]);

/**
 * The deck, slide by slide.
 *
 * SEPARATE FROM THE BEATS ON PURPOSE. A beat is an argument; a slide is a piece
 * of craft that carries one. Keeping them in one structure meant every change
 * to a visual treatment touched the argument, and every change to the argument
 * invited somebody to redesign a slide.
 *
 * PURPOSE / TAKEAWAY / VISUAL / SPOKEN / TRANSITION are here. EVIDENCE,
 * READINESS and MISSING EVIDENCE are not: they are computed from the beat, and
 * a copy of them here would be the first thing to go stale. KILL CONDITION
 * lives on the beat, because cutting a slide means dropping an argument.
 */
export const DECK_SLIDES = Object.freeze([
  { beat: 'moment', visual: 'One photograph of the real workplace. No text but the beat\'s takeaway.',
    spoken: 'Name the business, the person, and one Tuesday.', transition: 'Hold the photo while saying "I worked there."' },
  { beat: 'discovery', visual: 'The same photograph, one detail circled — the thing the founder actually touched.',
    spoken: 'Proximity, in one sentence. No résumé.', transition: 'Cut to the workflow drawing mid-sentence.' },
  { beat: 'before', visual: 'The old workflow as a single line with six hand-offs on it. Each hand-off labelled with what a person had to do.',
    spoken: 'Walk the line once, fast. Do not explain every node.', transition: 'The line stays; AWE collapses it in the next slide.' },
  { beat: 'what_awe_is', visual: 'ONE_SENTENCE.spoken as the only text on the slide. Two lines max.',
    spoken: 'Say it once. Do not paraphrase it afterwards.', transition: 'Silence, then the product.' },
  { beat: 'execution', visual: 'The product itself, full-bleed. No device frame, no cursor highlight, no annotation.',
    spoken: 'Narrate what a person used to do at each step, not what the software is doing.', transition: 'End on the finished artifact — the purchase order.' },
  { beat: 'proof', visual: 'Three figures, large, with what each is measured against underneath it in the same size text.',
    spoken: 'Say the weakest number too, and say which one the system refuses to produce.', transition: '"Here is how you can check that." Then move on — do not dwell.' },
  { beat: 'market', visual: 'Quotes. Verbatim, attributed by role and company type, never paraphrased into a bullet.',
    spoken: 'Read one quote. Let the others be read.', transition: '"That is four companies. Here is what happens when we install it in one of them."' },
  { beat: 'repeatability', visual: 'Two organizations and two capabilities on one architecture diagram. The diagram must be readable in three seconds.',
    spoken: 'PCC is one capability. Say that sentence out loud.', transition: 'This is the reveal — hold before speaking again.' },
  { beat: 'business', visual: 'One line: who pays, for what, how much, and what evidence the price rests on.',
    spoken: 'If the price is untested, say it is untested.', transition: 'Straight into the wedge.' },
  { beat: 'expansion', visual: 'The wedge, drawn once: one workflow, one company → more workflows, more companies → adjacent trades.',
    spoken: 'Two sentences. Any more reads as speculation.', transition: 'Drop the diagram before the close.' },
  { beat: 'defensibility', visual: 'The comparison table from competitive-positioning.md, with the honest cells left honest.',
    spoken: 'Only if asked. This slide lives after the appendix divider.', transition: 'n/a — this is a Q&A slide.' },
  { beat: 'close', visual: 'Black. One sentence.',
    spoken: 'The close, then stop. Do not add "thank you, any questions" to a landed line.', transition: 'End.' },
]);

/**
 * How ready an artifact is, computed from the beats it carries.
 *
 * AN ARTIFACT IS AS STRONG AS ITS WEAKEST CARRIED BEAT, and there is no
 * averaging. Averaging is how a deck with one catastrophic slide reports as
 * "mostly ready": the audience does not average, they remember the worst
 * moment and the last one.
 */
export function artifactReadiness(artifact, narrativeAssessment) {
  const byId = new Map(narrativeAssessment.beats.map((b) => [b.id, b]));
  const carried = artifact.carries.map((id) => {
    const b = byId.get(id);
    if (!b) throw new Error(`artifact "${artifact.id}" carries an unknown beat: ${id}`);
    return b;
  });
  const RANK = { STRONG: 3, INFERRED: 2, PARTIAL: 1, NOT_READY: 0 };
  const weakest = [...carried].sort((a, b) => RANK[a.status] - RANK[b.status] || a.cutOrder - b.cutOrder)[0];

  const missing = new Set();
  for (const b of carried) for (const m of b.missing) missing.add(m);

  const thresholdSlots = artifact.threshold.slots ?? [];
  const slotById = new Map(narrativeAssessment.slots.map((s) => [s.id, s]));
  const unmetThreshold = thresholdSlots.filter((id) => (slotById.get(id)?.source ?? 'NONE') !== 'REAL');

  return Object.freeze({
    artifact: artifact.id,
    name: artifact.name,
    status: weakest.status,
    weakestBeat: weakest.id,
    because: weakest.why,
    missingSlots: Object.freeze([...missing]),
    // PRODUCIBLE is not the same as READY. The executive summary is producible
    // today and would be honest; it would also be short. The video is not,
    // because its threshold names evidence that does not exist.
    producible: unmetThreshold.length === 0,
    blockedBy: Object.freeze(unmetThreshold),
    fallback: artifact.threshold.fallback,
  });
}

/** Every artifact, assessed. */
export function assessArtifacts(narrativeAssessment) {
  return Object.freeze(ARTIFACTS.map((a) => artifactReadiness(a, narrativeAssessment)));
}

/**
 * The demonstration, in four tiers that tell the same story.
 *
 * A COMPETITION CANNOT DEPEND ON WI-FI AND LUCK. Each tier down loses something
 * real and keeps the argument, and the tier actually available today is
 * computed rather than assumed. The full design — setup, input, what is shown,
 * what is hidden, runtime — is in demo-architecture.md; what is here is the
 * fallback chain, because that is the part a program can check.
 *
 * A REHEARSAL IS LABELLED, ALWAYS. Tier 2 runs the production artifact against
 * a rehearsal database that stamps itself as one. It is shown as a rehearsal,
 * out loud, and the numbers on screen are never presented as production
 * evidence. `derive.mjs` enforces the same rule on the arithmetic; this
 * enforces it on the sentence.
 */
export const DEMO_TIERS = Object.freeze([
  {
    tier: 'PRIMARY', id: 'live_production_safe',
    what: 'The real deployed system, driven live, against production data, in read-and-draft mode.',
    needs: ['a production deployment', 'a network', 'nothing outbound leaving the building'],
    loses: 'nothing',
    available: (f) => (f.usage?.executions ?? 0) > 0 && f.proof?.evidenceEnvironment === 'production',
  },
  {
    tier: 'BACKUP_A', id: 'local_rehearsal',
    what: 'The same packaged artifact, run locally against a rehearsal database, labelled as a rehearsal out loud.',
    needs: ['a laptop', 'no network'],
    loses: 'the claim that this data is real. It is still the real product doing the real work.',
    available: (f) => Boolean(f.deployment?.deployable),
  },
  {
    tier: 'BACKUP_B', id: 'recording',
    what: 'A screen recording of the primary demonstration, narrated live rather than voiced over.',
    needs: ['a file on the machine'],
    loses: 'the audience\'s belief that it is happening now. Narrating live recovers most of it.',
    available: (f) => Boolean(f.demo?.backupExists),
  },
  {
    tier: 'BACKUP_C', id: 'static',
    what: 'Four printed screens: the request, the policy applied, the approval, the purchase order.',
    needs: ['paper'],
    loses: 'motion, and therefore the sense that the system acts. Keeps the before-and-after.',
    available: () => true,
  },
]);

/** The best demonstration tier the current facts actually support. */
export function bestDemoTier(facts) {
  return DEMO_TIERS.find((t) => t.available(facts)) ?? DEMO_TIERS[DEMO_TIERS.length - 1];
}

/** Guard: every beat referenced by an artifact exists. Called by the suite. */
export function assertArtifactsReferenceRealBeats() {
  for (const a of ARTIFACTS) {
    for (const id of a.carries) if (!BEAT_IDS.has(id)) throw new Error(`artifact "${a.id}" carries unknown beat "${id}"`);
    for (const d of a.drops) if (!BEAT_IDS.has(d.beat)) throw new Error(`artifact "${a.id}" drops unknown beat "${d.beat}"`);
    for (const s of a.structure) if (s.beat && !BEAT_IDS.has(s.beat)) throw new Error(`artifact "${a.id}" segment names unknown beat "${s.beat}"`);
  }
  for (const s of DECK_SLIDES) if (!BEAT_IDS.has(s.beat)) throw new Error(`deck slide names unknown beat "${s.beat}"`);
  return true;
}
