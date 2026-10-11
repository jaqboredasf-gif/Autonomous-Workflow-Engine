// ---------------------------------------------------------------------------
// iic-evidence.mjs — what real evidence should Jack collect next, and how does
// it get into the repository?
//
//   npm run evidence                      what is needed, per area
//   npm run evidence -- --queue           today / this week / when available
//   npm run evidence -- --snapshot        if the pitch were tomorrow, what could we say
//   npm run evidence -- --check           validate every capture file
//   npm run evidence -- --new interview   write a blank field sheet
//   npm run evidence -- --import <file>   turn one filled-in sheet into a record
//   npm run evidence -- --json
//
// THE LOOP THIS CLOSES, and the reason for one command rather than five:
//
//   REAL ACTION -> field sheet -> --import -> validated record -> claim
//   -> presentation slot -> readiness -> next action
//
// Two of those arrows are a person's work and the rest are arithmetic. Before
// this command the arithmetic existed and the two human steps did not have a
// front door, so the honest way to move `narrative.plainLanguageTests` was to
// hand-edit a JavaScript file — which is why it has been zero since the day it
// was written.
//
// IT ADDS NO EVIDENCE AND PLANS NOTHING. Every status is read from
// programs/iic-2027/narrative.mjs, every action from programs/venture/plan.mjs,
// every fact from programs/iic-2027/derive.mjs. The only thing this file
// contributes is the errand.
//
// --import and --new WRITE. Everything else is read-only.
// ---------------------------------------------------------------------------

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const flag = (k) => argv.includes(`--${k}`);

const line = (s = '') => console.log(s);
const rule = (t) => { line(''); line(t); line('-'.repeat(t.length)); };
const wrap = (s, indent = '    ', width = 74) => {
  const out = [];
  let cur = '';
  for (const w of String(s).split(/\s+/)) {
    if ((cur + ' ' + w).trim().length > width) { out.push(indent + cur.trim()); cur = w; }
    else cur += ` ${w}`;
  }
  if (cur.trim()) out.push(indent + cur.trim());
  return out.join('\n');
};

// --- the two writing modes, first, because they exit ------------------------

const TEMPLATES = Object.freeze({
  interview: 'programs/discovery/templates/interview.md',
  comprehension: 'programs/evidence/templates/comprehension.md',
  'mock-pitch': 'programs/evidence/templates/mock-pitch.md',
});

if (flag('new')) {
  const { DESTINATION } = await import(R('programs/evidence/import.mjs'));
  const kind = arg('new');
  if (!TEMPLATES[kind]) {
    console.error(`--new needs one of: ${Object.keys(TEMPLATES).join(', ')}`);
    process.exit(2);
  }
  const id = argv[argv.indexOf('--new') + 2] ?? `${kind}-${new Date().toISOString().slice(0, 10)}`;
  const dir = R(DESTINATION[kind]);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${id}.md`);
  if (existsSync(target)) { console.error(`${target} already exists. Pick another id.`); process.exit(2); }
  copyFileSync(R(TEMPLATES[kind]), target);
  line(`Field sheet written: ${target.replace(`${ROOT}/`, '')}`);
  line('');
  line('Fill it in — on a phone is fine — then:');
  line(`  npm run evidence -- --import ${target.replace(`${ROOT}/`, '')}`);
  process.exit(0);
}

if (flag('import')) {
  const { importSheet, DESTINATION } = await import(R('programs/evidence/import.mjs'));
  const path = arg('import');
  if (!path || !existsSync(path)) { console.error(`No file at ${path}`); process.exit(2); }
  const result = await importSheet(readFileSync(path, 'utf8'), { source: basename(path) });

  if (result.errors.length) {
    // NOTHING IS WRITTEN. A half-imported record looks finished, which is worse
    // than an obvious refusal.
    console.error(`Refused. ${basename(path)} was not imported and nothing was changed.\n`);
    for (const e of result.errors) console.error(`  · ${e}`);
    console.error('\nFix those lines and run it again.');
    process.exit(1);
  }

  const dir = R(DESTINATION[result.kind]);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${result.id}.json`);
  if (existsSync(out) && !flag('force')) {
    console.error(`${out.replace(`${ROOT}/`, '')} already exists. Change the id, or pass --force to replace it.`);
    process.exit(2);
  }
  writeFileSync(out, `${JSON.stringify(result.record, null, 2)}\n`);
  // The sheet is kept — it is the handwriting behind the record — and renamed
  // so the next --check does not report it as still waiting.
  const kept = `${path}.imported`;
  if (path.endsWith('.md')) renameSync(path, kept);
  line(`Imported ${result.kind} "${result.id}" -> ${out.replace(`${ROOT}/`, '')}`);
  if (path.endsWith('.md')) line(`The sheet is kept at ${kept.replace(`${ROOT}/`, '')}`);
  line('');
  line('What moved:  npm run evidence     npm run readiness     npm run plan');
  process.exit(0);
}

// --- everything else reads --------------------------------------------------

const { deriveFacts } = await import(R('programs/iic-2027/derive.mjs'));
const { mergeFacts, DECLARED } = await import(R('programs/iic-2027/facts.mjs'));
const N = await import(R('programs/iic-2027/narrative.mjs'));
const A = await import(R('programs/iic-2027/artifacts.mjs'));
const { assessClaims } = await import(R('programs/venture/claims.mjs'));
const S = await import(R('programs/evidence/status.mjs'));

const warnings = [];
const derived = await deriveFacts({ db: arg('db'), org: arg('org'), warn: (m) => warnings.push(m) });
const facts = mergeFacts(derived, DECLARED);
const narrative = N.assessNarrative(facts);
const claims = assessClaims(facts);
const status = S.evidenceStatus({ narrative, claims, facts });
const queue = S.founderQueue(status, { facts });
const snapshot = S.pitchSnapshot({ facts, claims, narrative, demoTier: A.bestDemoTier(facts) });

if (flag('json')) {
  console.log(JSON.stringify({ status, queue, snapshot, evidence: facts.evidence, warnings }, null, 2));
  process.exit(0);
}
for (const w of warnings) console.error(`NOTE: ${w}\n`);

// --- --check ---------------------------------------------------------------

if (flag('check')) {
  const problems = facts.evidence?.problems ?? [];
  const unimported = facts.evidence?.unimported ?? [];
  line('EVIDENCE CHECK');
  line('========================================================================');
  rule('capture files that did not validate');
  if (!problems.length) line('    none. Every record on disk was accepted.');
  for (const p of problems) { line(`    ${p.file}`); line(wrap(p.reason, '        ')); }
  rule('field sheets waiting to be imported');
  if (!unimported.length && !(facts.discovery?.unimported ?? 0)) line('    none.');
  for (const f of unimported) line(`    programs/evidence/records/${f}    npm run evidence -- --import ...`);
  if (facts.discovery?.unimported) line(`    ${facts.discovery.unimported} interview sheet(s) in programs/discovery/interviews/`);
  rule('founder story');
  const fs_ = facts.founderStory ?? {};
  line(`    ${fs_.confirmed ?? 0} of ${fs_.total ?? 5} facts confirmed`);
  if ((fs_.outstanding ?? []).length) line(`    outstanding: ${fs_.outstanding.join(', ')}`);
  line('');
  line(problems.length ? 'FAILED — fix the files above.' : 'OK');
  process.exit(problems.length ? 1 : 0);
}

// --- --snapshot ------------------------------------------------------------

if (flag('snapshot')) {
  line('IF THE PITCH WERE TOMORROW');
  line('========================================================================');
  line(wrap('Regenerated from the same facts as everything else. Nothing here is stored, ' +
    'so it cannot drift from the evidence.', ''));

  rule(`SUPPORTED — say these (${snapshot.supported.length})`);
  if (!snapshot.supported.length) line('    nothing is fully supported yet');
  for (const c of snapshot.supported) { line(`    ${c.claim}`); line(wrap(c.because, '        ')); }

  rule(`PARTIAL — say these WITH the caveat (${snapshot.partial.length})`);
  for (const c of snapshot.partial) { line(`    [${c.grade}] ${c.claim}`); line(wrap(c.because, '        ')); }

  rule(`UNSUPPORTED — do not say these (${snapshot.unsupported.length})`);
  for (const c of snapshot.unsupported) { line(`    ${c.claim}`); line(wrap(c.because, '        ')); }

  rule('BEST DEMONSTRATION AVAILABLE');
  line(`    ${snapshot.bestDemo?.what ?? 'none'}`);
  if (snapshot.bestDemo?.why) line(wrap(snapshot.bestDemo.why, '        '));

  rule('BEST PROOF AVAILABLE');
  if (!snapshot.bestProof.length) line('    nothing is REAL yet');
  for (const p of snapshot.bestProof) line(`    ${p.label}\n${wrap(p.value, '        ')}`);

  rule('BIGGEST WEAKNESS');
  if (snapshot.biggestWeakness) {
    line(`    ${snapshot.biggestWeakness.title} — ${snapshot.biggestWeakness.status}`);
    line(wrap(snapshot.biggestWeakness.why, '        '));
  }

  rule('WHAT WE MUST NOT CLAIM');
  for (const m of snapshot.mustNotClaim) {
    line(`    ✗ ${m.say.split('\n')[0]}`);
    line(wrap(`retired by: ${m.until}`, '        '));
  }
  line('');
  line('For the errand: npm run evidence -- --queue');
  process.exit(0);
}

// --- --queue ---------------------------------------------------------------

if (flag('queue')) {
  line('JACK — IIC EVIDENCE QUEUE');
  line('========================================================================');
  line(wrap('Bucketed by who has to say yes, not by a date this file invented. ' +
    'Everything here needs a person; none of it needs more code.', ''));

  const show = (title, tasks, note) => {
    rule(title);
    if (note) line(wrap(note, '    '));
    if (!tasks.length) { line('    nothing'); return; }
    for (const t of tasks) {
      line('');
      line(`  ▸ ${t.what}`);
      line(`      why        ${t.why}`);
      line(`      unlocks    ${t.unlocks.join(', ')}${t.unlocksClaims.length ? `  (claims: ${t.unlocksClaims.join(', ')})` : ''}`);
      line(`      time       ${t.minutes ? `about ${t.minutes} minutes` : 'no extra time — it rides on another conversation'}`);
      line(`      write it   ${t.capture}`);
      line(`      then       ${t.then}`);
    }
  };
  show('TODAY — needs nobody\'s permission', queue.today);
  show('THIS WEEK — needs one appointment, which can be made today', queue.thisWeek);
  show('WHEN AVAILABLE — waiting on somebody else\'s decision', queue.whenAvailable,
    'Not schedulable. Listed so it is not mistaken for something that is being neglected.');
  line('');
  line('Start a capture: npm run evidence -- --new interview');
  process.exit(0);
}

// --- the default view -------------------------------------------------------

const MARK = { STRONG: '████', INFERRED: '██··', PARTIAL: '█···', NOT_READY: '····' };

line('IIC EVIDENCE STATUS');
line('========================================================================');
line(wrap('What real evidence is missing, and the physical act that would supply it. ' +
  'Statuses are the presentation beats\' own; actions are the venture planner\'s own. ' +
  'This command computes neither.', ''));

for (const a of status) {
  line('');
  line(`${MARK[a.status] ?? '····'}  ${a.label}`);
  line(`      status   ${a.status}`);
  line(wrap(a.why, '      '));
  if (a.needed.length) {
    line('      needed');
    for (const n of a.needed) line(`        · ${n.what}${n.slot ? `  [${n.slot}]` : ''}`);
  }
  if (a.nextAction) { line('      next action'); line(wrap(a.nextAction, '        ')); }
  for (const b of a.blocked) line(`      blocked  ${b.claim} waits on ${b.blockedBy.join(', ')}`);
}

const ev = facts.evidence ?? {};
rule('what the records currently say');
line(`    comprehension    ${ev.comprehension?.verdict ?? 'NOT_TESTED'} — ${ev.comprehension?.clear ?? 0} clear of ${ev.comprehension?.tested ?? 0} tested` +
  (ev.comprehension?.remainingToFirstSample ? `, ${ev.comprehension.remainingToFirstSample} to the first sample of 5` : ''));
if (ev.comprehension?.weakestConcept) line(`                     weakest idea: ${ev.comprehension.weakestConcept}`);
for (const r of ev.comprehension?.regressions ?? []) line(`                     REGRESSION: ${r.from} -> ${r.to}, ${r.was} became ${r.now}`);
line(`    interviews       ${facts.discovery?.externalInterviews ?? 0} external across ${facts.discovery?.externalOrganizations ?? 0} organization(s)`);
line(`    repeated pain    ${facts.discovery?.repeatedPatterns ?? 0} pattern(s) named independently by two outside organizations`);
line(`    alternatives     ${ev.alternatives?.analysed ?? 0} analysed from customer testimony` +
  (ev.alternatives?.adequate?.length ? `; ADEQUATE ALREADY: ${ev.alternatives.adequate.join(', ')}` : ''));
line(`    unit of sale     ${ev.unitOfSale?.verdict ?? 'NOT_ASKED'}${ev.unitOfSale?.candidate ? ` — leading candidate "${ev.unitOfSale.candidate}"` : ''}`);
for (const [k, v] of Object.entries(ev.unitOfSale?.findings ?? {})) {
  if (v.length) line(`                     ${k}: ${v.join(', ')}`);
}
line(`    mock pitches     ${ev.mockPitch?.mockPitches ?? 0} with listener evidence, ${ev.mockPitch?.rehearsals ?? 0} delivered`);
for (const r of ev.mockPitch?.repeatedConfusion ?? []) line(`                     ${r.count} listeners lost at: ${r.text}`);
line(`    founder story    ${facts.founderStory?.confirmed ?? 0} of ${facts.founderStory?.total ?? 5} facts confirmed`);
if ((ev.problems ?? []).length) line(`    PROBLEMS         ${ev.problems.length} capture file(s) did not validate — npm run evidence -- --check`);
if ((ev.unimported ?? []).length || facts.discovery?.unimported) {
  line(`    WAITING          ${(ev.unimported?.length ?? 0) + (facts.discovery?.unimported ?? 0)} field sheet(s) written and not imported`);
}

line('');
line('The errand:   npm run evidence -- --queue');
line('The pitch:    npm run evidence -- --snapshot');
line('The company:  npm run plan');
