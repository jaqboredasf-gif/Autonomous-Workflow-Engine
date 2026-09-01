// ---------------------------------------------------------------------------
// eval-purchasing-redeployability.mjs — how much of PCC is Lippolis?
//
// This suite is a MEASUREMENT, not a gate. It asks one question against the
// real repository: if another trades business wanted what PCC does, how much
// would work as configuration and how much would need engineering?
//
// It is written to FAIL LOUDLY if a Lippolis literal reaches the universal
// layers, and to REPORT — without failing — the extraction debt that is known
// and accepted. A suite that went green while the capability was still
// hard-coded would be worse than no suite: the number is the point.
//
//   node scripts/eval-purchasing-redeployability.mjs
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'apps', 'purchasing', 'src');

const { validateProfile, extractionDebt, extractionScore, PROFILE_FIELDS } =
  await import(join(ROOT, 'capability', 'purchasing', 'profile.mjs'));
const { lippolisProfile } = await import(join(ROOT, 'capability', 'purchasing', 'profiles', 'lippolis.mjs'));
const { org002TradesProfile } = await import(join(ROOT, 'capability', 'purchasing', 'profiles', 'org-002-trades.mjs'));

let pass = 0;
const failures = [];
const notes = [];
const ok = () => { pass++; };
const bad = (m) => { failures.push(m); console.log(`FAIL  ${m}`); };
const check = (c, m) => (c ? ok() : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok() : bad(`${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));
const note = (m) => { notes.push(m); };

/** Every source file under a directory. */
function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { out.push(...sources(full)); continue; }
    if (['.ts', '.tsx', '.mjs'].includes(extname(entry))) out.push(full);
  }
  return out;
}

/**
 * Code with comments and import lines stripped — what actually executes.
 *
 * SQL line comments are stripped too. The schema in database.ts is a template
 * literal full of `--` commentary explaining the Lippolis numbering rule, and
 * counting those as coupling produced a false failure the first time this ran:
 * prose about a customer is not a dependency on one. The same mistake this
 * repository has now made three times, in three different validators.
 */
function executable(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|--|import\s)/.test(l))
    .map((l) => l.replace(/\s--\s.*$/, ''))
    .join('\n');
}

const LIPPOLIS_LITERALS = /\b(lippolis|graybar|rexel|capitol light|city electric)\b/i;
const PEOPLE = /\b(mike|rick|jose|dave|karen|luis|sam|tom|ann)\b/i;

// ---------------------------------------------------------------------------
console.log('--- the domain must contain no customer literals ----------------');

// The strongest claim in this repository, and the one worth defending in a
// test: purchasing RULES mention no customer.
{
  const domain = sources(join(SRC, 'purchasing', 'domain'));
  const offenders = domain.filter((f) => LIPPOLIS_LITERALS.test(executable(f)));
  eq(offenders.map((f) => f.replace(SRC + '/', '')), [], 'no domain module names a customer or a vendor in executable code');

  const named = domain.filter((f) => PEOPLE.test(executable(f)));
  eq(named.map((f) => f.replace(SRC + '/', '')), [], 'no domain module names a person in executable code');
}
{
  const app = sources(join(SRC, 'purchasing', 'application'));
  const offenders = app.filter((f) => LIPPOLIS_LITERALS.test(executable(f)));
  eq(offenders.map((f) => f.replace(SRC + '/', '')), [], 'no application use case names a customer');
}

// ---------------------------------------------------------------------------
console.log('--- instance data is confined to seed and bootstrap -------------');

// Vendors, people and job numbers ARE Lippolis's. They belong in fixtures and
// in the database, and nowhere else.
{
  const infra = sources(join(SRC, 'purchasing', 'infrastructure'));
  const withLiterals = infra.filter((f) => LIPPOLIS_LITERALS.test(executable(f)))
    .map((f) => f.replace(SRC + '/purchasing/infrastructure/', ''));

  // THE SCHEMA NO LONGER NAMES A CUSTOMER. `po_template_key` defaulted to
  // 'lippolis_default', so every organization ever created started on a column
  // default carrying the first customer's name. It is 'awe_default' now, and
  // 'lippolis_default' survives only as a registry ALIAS for the same layout —
  // so databases created before the change still resolve, and no new one is
  // named after somebody else's company.
  const allowed = ['seed.ts', 'bootstrap.ts'];
  const unexpected = withLiterals.filter((f) => !allowed.includes(f));
  eq(unexpected, [], 'customer literals appear only in fixtures and the bootstrap refusal message');
  if (withLiterals.length) note(`instance data confined to: ${withLiterals.join(', ')}`);

  const schema = readFileSync(join(SRC, 'purchasing', 'infrastructure', 'sqlite', 'database.ts'), 'utf8');
  check(/po_template_key\s+text not null default 'awe_default'/.test(schema),
    'the PO template column defaults to the product\'s own form, not to a customer-named one');
  check(!LIPPOLIS_LITERALS.test(executable(join(SRC, 'purchasing', 'infrastructure', 'sqlite', 'database.ts'))),
    'and the schema carries no customer literal at all');
}

// ---------------------------------------------------------------------------
console.log('--- terminology: how deep does "workshop" go? -------------------');

// The honest finding, measured rather than asserted. "Workshop" is Lippolis's
// word for the internal stock location. It is also a ROLE NAME and a RESERVED
// LOCATION in the domain, which is the coupling a second customer would meet
// first.
{
  const domain = sources(join(SRC, 'purchasing', 'domain'));
  const withWorkshop = domain.filter((f) => /WORKSHOP/.test(executable(f)))
    .map((f) => f.replace(SRC + '/purchasing/domain/', ''));
  check(withWorkshop.length > 0, 'the domain does use WORKSHOP as a vocabulary term (this is the debt)');
  note(`WORKSHOP appears in domain: ${withWorkshop.join(', ')}`);

  // It is a term of art in a closed vocabulary, not a customer literal —
  // which is why it passes the literal test above and still needs extraction.
  const roles = readFileSync(join(SRC, 'purchasing', 'domain', 'roles.mjs'), 'utf8');
  check(/WORKSHOP_APPROVER/.test(roles), 'WORKSHOP_APPROVER is a fixed role name');
  check(/SHOP_COUNTER_ROLES|WORKSHOP_LOCATION/.test(roles), 'and the workshop is a reserved location concept');
}

// ---------------------------------------------------------------------------
console.log('--- profiles: can both organizations be described? --------------');

check(validateProfile(lippolisProfile).ok, 'Lippolis is expressible as a profile');
check(validateProfile(org002TradesProfile).ok, 'and so is a second trades business');

eq(lippolisProfile.terminology.stock_location, 'workshop', 'Lippolis calls it a workshop');
eq(org002TradesProfile.terminology.stock_location, 'yard', 'the second business calls it a yard');
check(!org002TradesProfile.roles.approvers.includes('WORKSHOP_APPROVER'),
  'the second business has no workshop approver at all');
check(org002TradesProfile.purchasing.po_numbering !== lippolisProfile.purchasing.po_numbering,
  'and numbers its purchase orders differently');

{
  const secretish = { ...lippolisProfile, communications: { ...lippolisProfile.communications, smtp_password: 'x' } };
  check(!validateProfile(secretish).ok, 'a profile carrying a credential is refused');
}
{
  const incomplete = { ...lippolisProfile, purchasing: { ...lippolisProfile.purchasing, po_numbering: undefined } };
  check(!validateProfile(incomplete).ok, 'a profile omitting a required choice is refused');
  check(validateProfile(incomplete).problems.some((p) => p.path === 'purchasing.po_numbering'),
    'and the missing field is named');
}

// ---------------------------------------------------------------------------
console.log('--- extraction debt, stated rather than implied -----------------');

// The measurement. These assertions pin TODAY'S number so it cannot silently
// regress, and they are expected to be updated upward as extraction proceeds.
{
  const score = extractionScore();
  note(`profile fields honoured by the code: ${score.honoured} fully, ${score.partial} partially, ` +
    `${score.hardCoded} hard-coded, ${score.invariant} deliberately invariant (${score.percent}% of ${score.configurable} configurable fields)`);
  check(score.total === Object.keys(PROFILE_FIELDS).length, 'every profile field is scored');
  check(score.percent >= 70, `at least seventy percent of the profile is honoured or nearly so (currently ${score.percent}%)`);

  // THE ANTI-FLATTERY CHECKS, rewritten rather than removed.
  //
  // This used to be `hardCoded > 0` — "the suite admits there is still
  // hard-coded behaviour" — and it was the right instinct pinned to the wrong
  // number. Hard-coded debt is now zero, which the suite must be able to report
  // without either failing or claiming the profile is finished. So what is
  // asserted instead is the shape of the honesty:
  //
  //   1. invariants are EXCLUDED from the denominator, and counted out loud, so
  //      the percentage cannot be inflated by reclassifying debt as design;
  //   2. something is still not fully honoured, so 100% is never claimed while
  //      partial fields remain;
  //   3. an invariant is never reported as debt.
  check(score.configurable === score.total - score.invariant,
    'invariants are excluded from the denominator rather than scored as unhonoured configuration');
  check(score.invariant > 0, 'and the profile names at least one thing it deliberately will not configure');
  check(score.honoured + score.partial + score.hardCoded === score.configurable,
    'every configurable field is in exactly one state');
  check(score.percent < 100, `the profile is not claimed finished while ${score.partial} fields are only partial`);
  check(extractionDebt(lippolisProfile).every((d) => d.extractable !== 'invariant'),
    'an invariant is never reported as extraction debt — it is not work somebody forgot to do');

  const debt = extractionDebt(org002TradesProfile);
  check(debt.length > 0, 'the second business asks for things the code cannot yet honour');
  note(`org-002 would need engineering for: ${debt.map((d) => d.path).join(', ')}`);

  // The specific ones, pinned so a regression is visible.
  const paths = debt.map((d) => d.path);
  // EXTRACTED THIS SESSION. Role vocabulary was the largest debt and is now
  // organization configuration — asserted the other way round so a regression
  // would fail rather than pass quietly.
  check(!paths.includes('roles.approvers'), 'role vocabulary IS configurable (extracted)');
  check(!paths.includes('roles.orderers'), 'as are ordering roles');
  check(!paths.includes('roles.receivers'), 'and receiving roles');

  // EXTRACTED THIS SESSION, and asserted the other way round for the same
  // reason as the role fields: the profile now NAMES the numbering rule and the
  // composition root selects an implementation for it.
  check(!paths.includes('purchasing.po_numbering'), 'PO numbering IS selected by the profile (extracted)');
  // RECLASSIFIED, and asserted the other way round so the reclassification
  // cannot silently reverse. The quantity rule is a capability invariant, so it
  // is not debt; the document template is now resolved through a registry that
  // refuses a form it cannot draw, so it is not debt either.
  check(!paths.includes('purchasing.quantity_rule'),
    'the quantity rule is an INVARIANT, not debt — it is the capability, and org-002 is not owed it');
  check(PROFILE_FIELDS['purchasing.quantity_rule'].extractable === 'invariant',
    'and it says so, so nobody later "fixes" it by making it configurable');
  check(!paths.includes('documents.po_template'),
    'the document template IS resolved from configuration (extracted), and an unimplemented form is refused rather than substituted');
  check(!paths.includes('purchasing.default_fulfilment_days'),
    'the fulfilment expectation IS organization policy (extracted) — it was an assumption nothing read');
  check(!paths.includes('purchasing.po_separator'),
    'and the PO separator IS read from configuration, validated against a closed set');
}

// ---------------------------------------------------------------------------
console.log('--- the two models meet in exactly one place --------------------');

// A purchasing profile references a deployment manifest and knows nothing else
// about infrastructure. If purchasing settings started gating deployment, the
// separation would be gone.
{
  const profileSource = readFileSync(join(ROOT, 'capability', 'purchasing', 'profile.mjs'), 'utf8');
  const deploymentFields = Object.keys(PROFILE_FIELDS).filter((p) => p.startsWith('deployment.'));
  eq(deploymentFields, ['deployment.manifest_ref'], 'a profile carries exactly one deployment field: a reference');
  // Block comments stripped as well as line comments: the module's own prose
  // explains why hostnames belong in the manifest, and matching that as a leak
  // is the same false-positive mistake in miniature. `\bport\b` rather than
  // `port`, because "supports" and "important" are not infrastructure.
  const profileCode = profileSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  check(!/\b(hostname|tls|systemd|firewall|reverse.proxy)\b/i.test(profileCode),
    'and no infrastructure concepts leak into the purchasing profile');
}

console.log('');
for (const n of notes) console.log(`  note: ${n}`);
console.log('');
console.log(`redeployability checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);
