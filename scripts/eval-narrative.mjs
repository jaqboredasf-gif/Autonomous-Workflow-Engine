// ---------------------------------------------------------------------------
// eval-narrative.mjs — can the presentation flatter itself?
//
// The narrative architecture has exactly one job that matters: to tell the
// truth about what could honestly be said on stage today. Every way it could
// fail is a way of feeling better than the evidence warrants, so that is what
// this suite attacks:
//
//   REHEARSAL AS TRACTION   a synthetic second company must never make the
//                           repeatability beat STRONG. This is the single most
//                           expensive lie available to this project, because the
//                           rehearsal produces exactly the shape of a real
//                           result.
//   ARCHITECTURE AS PROOF   code that CAN do something is not somebody having
//                           done it, and a beat resting on it caps below STRONG.
//   PAPERWORK AS PROGRESS   writing this directory must not move the company
//                           scorecard by a single band. If it did, the act of
//                           preparing a pitch would look like building a
//                           company, which is the failure this whole repository
//                           is organised against.
//   OPTIONAL AS REQUIRED    a beat must not look healthy because of evidence it
//                           did not need.
//   DRIFT                   every slot must name a claim that exists, every beat
//                           a criterion that exists, and no number may be
//                           computed here that is computed anywhere else.
//
//   node scripts/eval-narrative.mjs
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = await import(join(ROOT, 'programs/iic-2027/narrative.mjs'));
const A = await import(join(ROOT, 'programs/iic-2027/artifacts.mjs'));
const C = await import(join(ROOT, 'programs/venture/claims.mjs'));
const R = await import(join(ROOT, 'programs/iic-2027/readiness.mjs'));
const D = await import(join(ROOT, 'programs/iic-2027/derive.mjs'));
const F = await import(join(ROOT, 'programs/iic-2027/facts.mjs'));

let pass = 0;
const failures = [];
const notes = [];
const ok = () => { pass++; };
const bad = (m) => { failures.push(m); console.log(`FAIL  ${m}`); };
const check = (c, m) => (c ? ok() : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok() : bad(`${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));
const note = (m) => { notes.push(m); };

const beatOf = (a, id) => a.beats.find((b) => b.id === id);
const slotOf = (a, id) => a.slots.find((s) => s.id === id);

// ---------------------------------------------------------------------------
console.log('--- the structure holds together ---------------------------------');

{
  const claimIds = new Set(C.CLAIMS.map((c) => c.id));
  const unowned = N.SLOTS.filter((s) => !claimIds.has(s.owner));
  eq(unowned.map((s) => s.id), [],
    'every evidence slot names a claim that exists — a gap nobody owns is a gap nobody closes');

  const badClaims = N.BEATS.flatMap((b) => b.claims.filter((c) => !claimIds.has(c)).map((c) => `${b.id}:${c}`));
  eq(badClaims, [], 'every beat names claims that exist in programs/venture/claims.mjs');

  const criteria = new Set(N.JUDGING_CRITERIA);
  const badCriteria = N.BEATS.flatMap((b) => b.criteria.filter((c) => !criteria.has(c)).map((c) => `${b.id}:${c}`));
  eq(badCriteria, [], 'every beat is scored against a published judging criterion, not an invented one');

  const uncovered = N.JUDGING_CRITERIA.filter((c) => !N.BEATS.some((b) => b.criteria.includes(c)));
  eq(uncovered, [], 'every published criterion is served by at least one beat');

  const decorative = N.BEATS.filter((b) => b.criteria.length === 0);
  eq(decorative.map((b) => b.id), [], 'no beat exists that serves no criterion — that is a slide, not an argument');

  check(N.BEATS.every((b) => b.question && b.question.includes('?')),
    'every beat answers a question the audience is actually asking');
  check(N.BEATS.every((b) => b.killCondition && b.killCondition.length > 20),
    'and every beat says when to cut it, which is what stops a deck growing into a document');

  const orders = N.BEATS.map((b) => b.cutOrder);
  eq(new Set(orders).size, orders.length, 'cut order is unambiguous — two beats cannot leave at the same time');

  check(A.assertArtifactsReferenceRealBeats(), 'every artifact carries and drops beats that exist');

  // An artifact must account for every beat: carried or explicitly dropped with
  // a reason. A beat that is silently absent is a beat somebody forgot.
  for (const a of A.ARTIFACTS) {
    const accounted = new Set([...a.carries, ...a.drops.map((d) => d.beat)]);
    const missing = N.BEATS.map((b) => b.id).filter((id) => !accounted.has(id));
    eq(missing, [], `${a.id} accounts for every beat — carried, or dropped with a stated cost`);
  }
}

// ---------------------------------------------------------------------------
console.log('--- a rehearsal is not a customer --------------------------------');

{
  // THE CENTRAL TEST. This is the exact fact shape the repository produces
  // today: a synthetic second company, provisioned end to end, zero source
  // changes. It is a real engineering result and it is not a second customer.
  const rehearsed = N.assessNarrative({
    repeatability: { secondOrganizationProven: true, profileHonouredPercent: 88, externallyValidated: false },
    proof: { secondCapabilityAdapter: true, capabilityNeutral: true, architectureOperational: true },
  });
  const beat = beatOf(rehearsed, 'repeatability');
  eq(beat.status, 'INFERRED',
    'a synthetic second company cannot make the repeatability beat STRONG, however completely it was provisioned');
  check(beat.why.includes('rehearsal is not a customer'),
    'and the reason says so in words somebody would repeat out loud');
  eq(slotOf(rehearsed, 'second_organization').source, 'REHEARSAL',
    'the slot itself is labelled REHEARSAL, not merely scored lower');

  // The same facts plus one real external deployment.
  const real = N.assessNarrative({
    repeatability: { secondOrganizationProven: true, profileHonouredPercent: 88, externallyValidated: true },
    usage: { organizations: 2 },
    proof: { secondCapabilityAdapter: true, capabilityNeutral: true, architectureOperational: true },
  });
  eq(beatOf(real, 'repeatability').status, 'STRONG',
    'a REAL second organization does make it STRONG — the distinction is the evidence, not pessimism');

  // A rehearsal database must not become production usage.
  const rehearsalDb = N.assessNarrative({ usage: { executions: 0 }, proof: { evidenceEnvironment: 'rehearsal' } });
  eq(slotOf(rehearsalDb, 'production_executions').source, 'REHEARSAL',
    'a rehearsal database is reported as a rehearsal rather than as nothing — the difference matters when reading a report');
  check(!slotOf(rehearsalDb, 'production_executions').value.includes('execution(s) over'),
    'and its executions are never counted');
}

// ---------------------------------------------------------------------------
console.log('--- architecture is not proof ------------------------------------');

{
  const architectural = N.assessNarrative({
    deployment: { deployable: true, capabilities: 1 },
    proof: { architectureOperational: true, objectiveTestable: true, secondCapabilityAdapter: true, capabilityNeutral: true },
  });
  eq(slotOf(architectural, 'live_execution').source, 'ARCHITECTURE',
    'a workflow that passes end to end in the suite is ARCHITECTURE until somebody has watched it');
  eq(beatOf(architectural, 'expansion').status, 'INFERRED',
    'the vision beat rests on architecture and is capped there');

  // The headline number. It must be gated on the case-study STANDARD, not on
  // whether a value happens to be computable.
  const computableButUnpublishable = N.assessNarrative({
    proof: { caseStudyGrade: 'NOT_READY', caseStudyBlockers: ['a', 'b'], confidence: 'LOW', valuedUnits: 4, baselineMeasured: true },
  });
  eq(slotOf(computableButUnpublishable, 'hours_returned').known, false,
    'hours returned stays empty while the case-study standard refuses to publish a value, even when a number exists');

  const publishable = N.assessNarrative({
    proof: { caseStudyGrade: 'DEFENSIBLE', confidence: 'MODERATE', valuedUnits: 31, baselineMeasured: true },
  });
  eq(slotOf(publishable, 'hours_returned').source, 'REAL',
    'and it fills the moment the standard would let it be said out loud');
}

// ---------------------------------------------------------------------------
console.log('--- a beat cannot be flattered -----------------------------------');

{
  const empty = N.assessNarrative({});
  const evidential = empty.beats.filter((b) => b.slots.some((s) => s.required));
  check(evidential.every((b) => b.status === 'NOT_READY'),
    'with no facts at all, every beat that makes a checkable claim is NOT_READY');
  check(evidential.every((b) => b.why && b.why.length > 10),
    'and each says why, in a sentence rather than a verdict');

  // The close makes no checkable claim. It must not be scored as though it did,
  // and it must not be nominated as the weakest beat.
  eq(beatOf(empty, 'close').status, 'STRONG', 'a rhetorical beat is not penalised for having no evidence');
  check(beatOf(empty, 'close').why.includes('rhetorical'), 'and it is labelled rhetorical rather than proven');
  check(empty.weakest.id !== 'close', 'the close can never be the weakest beat — it has nothing to be weak about');

  // OPTIONAL SLOTS MUST NOT RAISE A BEAT. The proof beat has one optional slot
  // (evidence_traceable) which is satisfied by architecture alone; if optional
  // slots counted, the beat would improve without a single production execution.
  const optionalOnly = N.assessNarrative({ proof: { architectureOperational: true } });
  eq(beatOf(optionalOnly, 'proof').status, 'NOT_READY',
    'filling only an optional slot leaves the beat exactly where it was');
  check(slotOf(optionalOnly, 'evidence_traceable').known,
    'even though the optional slot really is filled, and is reported as such');
}

// ---------------------------------------------------------------------------
console.log('--- the gap ranking is about evidence, not polish -----------------');

{
  const a = N.assessNarrative({
    artifacts: { workflowMapped: true, bossInterviewRecorded: true },
    deployment: { deployable: true, capabilities: 1 },
    proof: { architectureOperational: true, objectiveTestable: true, secondCapabilityAdapter: true, capabilityNeutral: true },
    repeatability: { secondOrganizationProven: true, profileHonouredPercent: 88 },
  });

  const top = a.gaps[0];
  check(top.costsBeat === 'NOT_READY',
    'the first gap is one that leaves a beat unsayable, not one that leaves a beat merely caveated');

  const ranks = a.gaps.map((g) => ['NOT_READY', 'PARTIAL', 'INFERRED', 'STRONG'].indexOf(g.costsBeat));
  check(ranks.every((r, i) => i === 0 || r >= ranks[i - 1]),
    'and the whole list is ordered by what the gap costs the beat before anything else');

  check(a.gaps.every((g) => g.ownedByClaim), 'every gap names the claim that owns it, so the planner can be handed it');
  check(!Object.keys(a.gaps[0]).includes('action'),
    'and no gap proposes an action — that is the planner\'s job, and two planners eventually disagree');

  // A slot filled from REAL evidence is not a gap. A slot filled from a
  // rehearsal is.
  check(!a.gaps.some((g) => g.slot === 'workflow_before'), 'a slot filled from real evidence is not listed as a gap');
  check(a.gaps.some((g) => g.slot === 'second_organization'), 'a slot filled from a rehearsal is');
}

// ---------------------------------------------------------------------------
console.log('--- the artifacts are as strong as their weakest beat -------------');

{
  const strongEverywhere = {
    artifacts: { workflowMapped: true, bossInterviewRecorded: true },
    discovery: { interviews: 9, externalInterviews: 22, externalOrganizations: 7, repeatedPatterns: 4, designPartnerCandidates: 3 },
    deployment: { deployable: true, capabilities: 1 },
    demo: { liveDemoExists: true, backupExists: true },
    narrative: { plainLanguageTests: 5, comprehensionTested: 5, comprehensionVerdict: 'CLEAR' },
    usage: { executions: 140, activeDays: 60, organizations: 2, capabilitiesInProduction: 2 },
    proof: {
      architectureOperational: true, objectiveTestable: true, objectivesTested: 120,
      secondCapabilityAdapter: true, capabilityNeutral: true, evidenceEnvironment: 'production',
      caseStudyGrade: 'DEFENSIBLE', confidence: 'MODERATE', valuedUnits: 120, baselineMeasured: true,
    },
    repeatability: { secondOrganizationProven: true, externallyValidated: true, profileHonouredPercent: 88 },
    businessModel: { unitDefined: true, pricingTested: true },
    differentiation: { alternativesAnalysed: 3, evidencedDifference: true },
  };
  const full = N.assessNarrative(strongEverywhere);
  const arts = A.assessArtifacts(full);
  check(arts.every((x) => x.status === 'STRONG'), 'with everything real, every artifact reports STRONG');
  check(arts.every((x) => x.producible), 'and every one is producible');

  // One beat knocked out. The artifacts carrying it must fall with it — no
  // averaging, because an audience does not average.
  const oneHole = N.assessNarrative({ ...strongEverywhere, discovery: {} });
  const holed = A.assessArtifacts(oneHole);
  const summary = holed.find((x) => x.artifact === 'executive_summary');
  eq(summary.status, 'NOT_READY',
    'one broken beat drags the whole artifact to its level; eleven good sections do not average it away');

  // The video's recording gate. It is the first thing due and the hardest to
  // retract, so it refuses to be made on architecture alone.
  const noProduction = N.assessNarrative({ ...strongEverywhere, usage: {}, proof: { ...strongEverywhere.proof, evidenceEnvironment: null } });
  const video = A.assessArtifacts(noProduction).find((x) => x.artifact === 'one_minute_video');
  eq(video.producible, false, 'the one-minute video is not producible without a real production figure');
  eq(video.blockedBy, ['production_executions'], 'and it names exactly what is missing');
  check(video.fallback.includes('Do not estimate'), 'and the fallback forbids the obvious shortcut');
}

// ---------------------------------------------------------------------------
console.log('--- the demonstration degrades without lying ---------------------');

{
  eq(A.bestDemoTier({}).tier, 'BACKUP_C', 'with nothing at all, the demonstration is paper — and there always is one');
  eq(A.bestDemoTier({ deployment: { deployable: true } }).tier, 'BACKUP_A',
    'an installable artifact earns a local rehearsal, not a production demonstration');
  eq(A.bestDemoTier({ usage: { executions: 5 }, proof: { evidenceEnvironment: 'production' } }).tier, 'PRIMARY',
    'only real production usage earns the primary tier');
  eq(A.bestDemoTier({ usage: { executions: 5 }, proof: { evidenceEnvironment: 'rehearsal' }, deployment: { deployable: true } }).tier, 'BACKUP_A',
    'executions in a rehearsal database do not earn it, however many there are');
  check(A.DEMO_TIERS.every((t) => t.loses), 'every fallback states what it costs — a backup that loses nothing is not a backup, it is the plan');
}

// ---------------------------------------------------------------------------
console.log('--- writing a pitch is not building a company --------------------');

{
  // THE INVARIANT THIS WHOLE SESSION HAS TO SURVIVE. The presentation
  // architecture is a place to put evidence. If creating it moved a single band
  // on the company scorecard, then preparing to pitch would look like progress,
  // and the readiness command would have congratulated the repository for
  // writing about itself.
  const derived = await D.deriveFacts({});
  const facts = F.mergeFacts(derived, F.DECLARED);
  const assessment = R.assess(facts);

  eq(assessment.dimensions.find((d) => d.id === 'narrative').level, 0,
    'narrative readiness is still 0 — a spec is not a person who can explain it in a minute');
  eq(assessment.dimensions.find((d) => d.id === 'demo_quality').level, 0,
    'demo quality is still 0 — a demo architecture is not a demonstration');
  note(`the scorecard totals ${assessment.total}/${assessment.max} with this directory built; ` +
    'every band still rests on something outside it');

  // The derived `artifacts` group must not leak into the scored `narrative`
  // group, which is the mechanism that would break the invariant above.
  //
  // `derived.narrative` NOW EXISTS, and the invariant survives because of what
  // is in it. It is derived from programs/evidence/records/ — people who
  // restated the sentence, listeners who heard the pitch — and never from a
  // file existing. So the two groups are checked to be disjoint, and the
  // narrative group is checked to be empty on a repository where the spec
  // directory is fully built and nobody has been asked anything.
  check(derived.artifacts, 'artifact existence is derived into its own group');
  const leaked = Object.keys(derived.artifacts).filter((k) => k in (derived.narrative ?? {}));
  eq(leaked, [], 'and no artifact fact appears in the scored narrative group');
  eq(derived.narrative?.plainLanguageTests ?? 0, 0,
    'with the whole presentation architecture written and nobody asked, plain-language tests are 0');
  eq(derived.narrative?.mockPitches ?? 0, 0, 'and mock pitches are 0');
  check(derived.artifacts.narrativeArchitecture === true,
    'the architecture does report its own existence — to the presentation, which needs to know, not to the scorecard');
}

// ---------------------------------------------------------------------------
console.log('--- one source of truth ------------------------------------------');

{
  const src = readFileSync(join(ROOT, 'programs/iic-2027/narrative.mjs'), 'utf8');
  for (const forbidden of ['Date.now', 'Math.random', 'new Date(', 'readFileSync', 'existsSync']) {
    check(!src.includes(forbidden),
      `narrative.mjs contains no ${forbidden} — it reads facts, it does not gather them`);
  }

  // No slot may invent a figure. Every reading either came from the facts
  // object or is a sentence about the absence of one.
  const withFacts = N.assessNarrative({ usage: { executions: 47, activeDays: 12 }, proof: { evidenceEnvironment: 'production' } });
  check(slotOf(withFacts, 'production_executions').value.includes('47'),
    'a slot reports the number it was given');
  const withoutFacts = N.assessNarrative({});
  check(!/\d/.test(slotOf(withoutFacts, 'production_executions').value),
    'and reports no number at all when it was given none');

  // The one-sentence explanation must avoid the vocabulary that costs a judge
  // four seconds of translation. This is checkable, so it is checked.
  const banned = ['agent', 'ontology', 'kernel', 'orchestrat', 'capability graph', 'LLM', 'platform'];
  for (const [k, v] of Object.entries(N.ONE_SENTENCE)) {
    const hit = banned.find((b) => v.toLowerCase().includes(b.toLowerCase()));
    check(!hit, `ONE_SENTENCE.${k} avoids "${hit}" — the opening explanation is not the place for it`);
  }
  check(N.ONE_SENTENCE.spoken.split(/\s+/).length <= 45,
    'and the spoken version is short enough to be said in one breath and repeated by somebody else');

  // The criteria are quoted, dated, and carry their own caveat.
  check(N.CRITERIA_PROVENANCE.url && N.CRITERIA_PROVENANCE.retrieved && N.CRITERIA_PROVENANCE.caveat,
    'the judging criteria carry their source, their retrieval date and the fact that they are seven editions old');
  eq(N.JUDGING_CRITERIA.length, 8, 'eight criteria, as published');
}

// ---------------------------------------------------------------------------
console.log('');
for (const n of notes) console.log(`  note: ${n}`);
console.log('');
console.log(`narrative checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
