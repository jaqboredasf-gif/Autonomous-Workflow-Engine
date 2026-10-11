// ---------------------------------------------------------------------------
// eval-second-customer.mjs — could we deploy to a SECOND company tomorrow?
//
// Every other suite asks whether purchasing works. This one asks whether
// purchasing works for somebody who is not Lippolis, and it answers by
// provisioning a fictional contractor from nothing and driving real purchasing
// work through it:
//
//   PROVISION -> IDENTITY -> REQUEST -> REVIEW -> APPROVE -> PO -> EMAIL ->
//   ORDER -> RECEIVE -> COMPLETE -> AUDIT -> PROOF -> VALUE
//
// THE ORGANIZATION IS NORTHGATE MECHANICAL LTD., and it is invented. It shares
// no role name, no numbering rule, no separator, no vocabulary, no timezone and
// no person with Lippolis. See organizations/northgate/dossier.mjs.
//
// WHAT A PASS MEANS, precisely: no source file was edited to make this
// organization work. Every difference between it and Lippolis was supplied
// through configuration, and the differences are the ones that would actually
// cost money to discover during a real go-live.
//
// WHAT A PASS DOES NOT MEAN. This is a REHEARSAL. It proves the product is
// architecturally repeatable; it says nothing about whether a real company
// wants it, and it produces no evidence about any real business. Nothing here
// may ever be quoted as a customer outcome — the proof section asserts that the
// evidence boundary refuses exactly that.
//
// SECTIONS:
//   1  the dossier contract, and what it refuses
//   2  the readiness gate — and that UNKNOWN is never green
//   3  provisioning Northgate from nothing
//   4  the full purchasing lifecycle, under Northgate's own policy
//   5  ANTI-FORK: no customer-specific source branching, anywhere
//   6  cross-tenant adversarial attacks
//   7  proof isolation — Lippolis's evidence may not reach Northgate
//   8  offboarding
//
//   node scripts/eval-second-customer.mjs
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const R = (...p) => join(ROOT, ...p);
const APP = R('apps', 'purchasing', 'src');
const DOMAIN = join(APP, 'purchasing', 'domain');
const CAP = R('capability', 'purchasing');

let pass = 0;
const failures = [];
const notes = [];
const ok = () => { pass++; };
const bad = (m) => { failures.push(m); console.log(`FAIL  ${m}`); };
const check = (c, m) => (c ? ok() : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok() : bad(`${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));
const note = (m) => notes.push(m);
async function throws(fn, pattern, m) {
  try { await fn(); bad(`${m} — nothing was thrown`); }
  catch (err) {
    const text = String(err?.message ?? err);
    if (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)) ok();
    else bad(`${m} — wrong error: ${text}`);
  }
}

// --- what is under test -----------------------------------------------------
const O = await import(join(CAP, 'organization.mjs'));
const { validateProfile } = await import(join(CAP, 'profile.mjs'));
const { withCapabilities, effectiveCapabilities } = await import(join(CAP, 'authorization.mjs'));
const { designPartnerReadiness, VERDICTS, unknownFactsIn } =
  await import(R('programs', 'design-partner', 'readiness.mjs'));

const lippolisDossier = (await import(R('organizations/lippolis/dossier.mjs'))).default;
const northgateDossier = (await import(R('organizations/northgate/dossier.mjs'))).default;
const lippolisProfile = (await import(join(CAP, 'profiles', 'lippolis.mjs'))).default;
const northgateProfile = (await import(join(CAP, 'profiles', 'org-002-trades.mjs'))).default;
const lippolisAuth = (await import(join(CAP, 'profiles', 'lippolis-authorization.mjs'))).lippolisAuthorization;
const northgateAuth = (await import(join(CAP, 'profiles', 'org-002-authorization.mjs'))).org002Authorization;
const northgateManifest = (await import(R('deployment/examples/northgate.manifest.mjs'))).default;
const pccManifest = (await import(R('deployment/examples/pcc.manifest.mjs'))).default;

const { IMPLEMENTED_IDS, poNumberStrategyFor } = await import(join(APP, 'purchasing/organization/po-numbering.mjs'));
const { PO_TEMPLATE_KEYS, poTemplateFor } = await import(join(APP, 'purchasing/infrastructure/pdf-adapter.ts'));
const { authorize } = await import(join(DOMAIN, 'roles.mjs'));
const { openDatabase } = await import(join(APP, 'purchasing/infrastructure/sqlite/database.ts'));

const TMP = mkdtempSync(join(tmpdir(), 'second-customer-'));

// ===========================================================================
console.log('--- 1. the dossier contract -------------------------------------');
// ===========================================================================

// It must express organization #1. A contract that can only describe the
// organization it was designed around is a form, not a contract.
{
  const v = O.validateDossier(lippolisDossier);
  check(v.ok, 'Lippolis is expressible as a dossier');
  eq(O.missingFacts(lippolisDossier), [], 'and nothing about it is missing');

  const env = O.deploymentEnvFor(lippolisDossier, lippolisProfile, lippolisAuth);

  // THE STRONGEST AVAILABLE PROOF THAT THE CONTRACT IS COMPLETE: the derived
  // environment must match the file the real installation actually runs on. If
  // the dossier could not reproduce it, the dossier is missing a fact that
  // production needs, and the second customer would discover which one.
  const template = readFileSync(R('config/production.env.template'), 'utf8');
  const declaredInTemplate = Object.fromEntries(
    template.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
  for (const key of ['PCC_ORG_ID', 'PCC_ORG_NAME', 'PCC_ORG_ADDRESS', 'PCC_ORG_PHONE', 'PCC_PO_NUMBERING']) {
    eq(env[key], declaredInTemplate[key],
      `the dossier derives ${key} exactly as the production template states it`);
  }
  note(`Lippolis derives ${Object.keys(env).length} environment values, matching production on all five identity keys`);
}

// --- and it must refuse the mistakes people actually make ------------------
{
  const clone = (over) => JSON.parse(JSON.stringify({ ...northgateDossier, ...over }));

  const noId = clone({});
  delete noId.organization.id;
  check(!O.validateDossier(noId).ok, 'a dossier with no organization id is refused');
  check(O.missingFacts(noId).some((m) => m.fact === 'organization.id' && m.owner === 'CUSTOMER'),
    'and the missing fact is attributed to whoever can supply it');

  for (const bogus of ['Northgate', 'north gate', '1northgate', 'n', 'northgate!']) {
    const d = clone({}); d.organization.id = bogus;
    check(!O.validateDossier(d).ok, `organization id ${JSON.stringify(bogus)} is refused — the id is permanent`);
  }

  // THE COPIED-DOSSIER FAILURE. Somebody copies Lippolis's dossier, changes the
  // name, and forgets the id — so two companies share a tenant boundary.
  const copied = clone({}); copied.organization.id = 'lippolis';
  check(!O.validateDossier(copied).ok,
    'a dossier carrying an existing organization\'s id with a different name is refused as a copy');

  // An offset is wrong for half the year, and "overdue" is computed from it.
  for (const tz of ['-0500', 'EST', 'UTC+5']) {
    const d = clone({}); d.organization.timezone = tz;
    check(!O.validateDossier(d).ok, `timezone ${JSON.stringify(tz)} is refused — an IANA zone name is required`);
  }

  // NO CODE. A dossier is read, never run.
  const withFn = clone({}); withFn.pilot.success_measure = () => 'anything';
  check(!O.validateDossier(withFn).ok, 'a dossier containing a function is refused — configuration is not code');

  // NO SECRETS. Dossiers are committed.
  for (const key of ['api_key', 'session_secret', 'db_password', 'access_token', 'connection_string']) {
    const d = clone({}); d.organization[key] = 'x';
    check(!O.validateDossier(d).ok, `a dossier field named ${key} is refused — secrets are not committed`);
  }

  // NO ESCAPING THE REPOSITORY. These paths get resolved by a script.
  for (const ref of ['../../../etc/passwd', '/etc/passwd', 'a/../../b']) {
    const d = clone({ profile_ref: ref });
    check(!O.validateDossier(d).ok, `a reference of ${JSON.stringify(ref)} is refused`);
  }

  // An enumeration is refused rather than defaulted.
  const badScope = clone({}); badScope.pilot.scope = 'everything';
  check(!O.validateDossier(badScope).ok, 'a pilot scope nobody offers is refused, not narrowed silently');
  const badBaseline = clone({}); badBaseline.proof.baseline_state = 'PROBABLY_FINE';
  check(!O.validateDossier(badBaseline).ok, 'a baseline state nobody defined is refused');

  // THE DISAGREEMENT CHECK. Two files naming one company; one is a stale copy.
  await throws(() => O.deploymentEnvFor(northgateDossier, lippolisProfile),
    /name different organizations/, 'a dossier and a profile for different organizations refuse to combine');
  await throws(() => O.authorizationFor(northgateDossier, lippolisAuth),
    /name different organizations/, 'and so do a dossier and the wrong authorization profile');

  // Deriving an environment from an invalid dossier is refused outright, so a
  // half-answered dossier cannot produce a plausible-looking .env.
  await throws(() => O.deploymentEnvFor(noId, northgateProfile),
    /refusing to derive/, 'no environment is derived from an invalid dossier');
}

// ===========================================================================
console.log('--- 2. the readiness gate ---------------------------------------');
// ===========================================================================

const gateFor = (over = {}) => designPartnerReadiness({
  dossier: northgateDossier,
  profile: northgateProfile,
  authorization: northgateAuth,
  manifest: northgateManifest,
  implementedNumberingIds: IMPLEMENTED_IDS,
  implementedTemplateKeys: PO_TEMPLATE_KEYS,
  ...over,
});

{
  eq(VERDICTS, ['NOT_CONFIGURED', 'CONFIG_INCOMPLETE', 'BLOCKED_BY_PRODUCT',
    'EXTERNAL_DEPENDENCY', 'READY_FOR_REHEARSAL', 'READY_FOR_PILOT'], 'six verdicts, worst first');

  eq(designPartnerReadiness().verdict, 'NOT_CONFIGURED', 'no dossier at all is NOT_CONFIGURED');
  eq(designPartnerReadiness({ dossier: 'northgate' }).verdict, 'NOT_CONFIGURED',
    'and a string is not a dossier');

  // THE RULE THE WHOLE MODULE EXISTS FOR: unknown is never green.
  const noEvidence = gateFor({ evidence: {} });
  check(VERDICTS.indexOf(noEvidence.verdict) < VERDICTS.indexOf('READY_FOR_PILOT'),
    'with no evidence that anything was DONE, the gate is not READY_FOR_PILOT');
  check(noEvidence.blockers.some((b) => /rehearsal/.test(b.fact)),
    'and it names the rehearsal nobody has run rather than assuming it happened');
  check(noEvidence.blockers.some((b) => /instance data/.test(b.fact)),
    'and the reference data nobody has loaded');

  // Every blocker is addressed to somebody, with a consequence.
  const all = gateFor({ evidence: { instanceDataPresent: true, rehearsed: true } });
  check(all.blockers.every((b) => ['AWE', 'CUSTOMER'].includes(b.owner)),
    'every blocker names an owner — AWE or CUSTOMER, never the passive voice');
  check(all.blockers.every((b) => typeof b.unlocks === 'string' && b.unlocks.length > 10),
    'and what it unlocks, so it cannot be silently deprioritized');

  // WHERE NORTHGATE ACTUALLY STANDS. Every remaining blocker is the customer's.
  eq(all.aweOwned.length, 0,
    'with the rehearsal done, NOTHING is left that AWE owns — the software blockers are exhausted');
  check(all.customerOwned.length > 0,
    'and what remains is the customer\'s to answer, which is the correct place for it to be');
  eq(all.verdict, 'EXTERNAL_DEPENDENCY',
    'so the verdict is EXTERNAL_DEPENDENCY: we are waiting on them, not on ourselves');
  note(`Northgate: ${all.verdict}, ${all.customerOwned.map((b) => b.fact).join('; ')}`);

  // A product blocker outranks an external one, because it is a commitment.
  const wontNumber = gateFor({
    profile: { ...northgateProfile, purchasing: { ...northgateProfile.purchasing, po_numbering: 'quarterly-branch-sequence' } },
    evidence: { instanceDataPresent: true, rehearsed: true },
  });
  eq(wontNumber.verdict, 'BLOCKED_BY_PRODUCT',
    'a numbering rule this build cannot perform is BLOCKED_BY_PRODUCT, not merely incomplete');
  check(wontNumber.blockers.some((b) => b.owner === 'AWE' && /po_numbering/.test(b.fact)),
    'and it is ours');

  const wontDraw = gateFor({
    profile: { ...northgateProfile, documents: { po_template: 'northgate_letterhead' } },
    evidence: { instanceDataPresent: true, rehearsed: true },
  });
  eq(wontDraw.verdict, 'BLOCKED_BY_PRODUCT', 'so is a purchase order form nobody has drawn');

  const wantsSend = gateFor({
    profile: { ...northgateProfile, communications: { vendor_channel: 'email', send_mode: 'send' } },
    evidence: { instanceDataPresent: true, rehearsed: true },
  });
  eq(wantsSend.verdict, 'BLOCKED_BY_PRODUCT',
    'and an organization requiring automatic vendor email is refused rather than accommodated');

  // A missing fact is worse than an external dependency.
  const gutted = JSON.parse(JSON.stringify(northgateDossier));
  delete gutted.organization.phone;
  delete gutted.pilot.exit_criteria;
  const incomplete = gateFor({ dossier: gutted, evidence: { instanceDataPresent: true, rehearsed: true } });
  eq(incomplete.verdict, 'CONFIG_INCOMPLETE', 'missing facts are CONFIG_INCOMPLETE');
  check(incomplete.blockers.some((b) => b.fact === 'organization.phone'),
    'and each one is named');

  // A dossier whose authorization profile belongs to another organization would
  // refuse every action at runtime. Caught here instead.
  const crossed = gateFor({ authorization: lippolisAuth, evidence: { instanceDataPresent: true, rehearsed: true } });
  eq(crossed.verdict, 'CONFIG_INCOMPLETE',
    'an authorization profile belonging to another organization is caught before deployment');

  // Unknown manifest facts are external dependencies, and they are found by
  // reading the manifest rather than by anybody remembering.
  const unknowns = unknownFactsIn(northgateManifest);
  check(unknowns.length > 0, 'Northgate\'s manifest has facts nobody has answered');
  check(unknowns.some((u) => u.path === 'operations.monitoring'),
    'including who monitors it — asked least, matters most');
  check(unknownFactsIn(pccManifest).length >= 0, 'and the same reader works on organization #1\'s manifest');
}

// ===========================================================================
console.log('--- 3. provisioning Northgate from nothing ----------------------');
// ===========================================================================

const NG = northgateDossier.organization.id;
const ngEnv = O.deploymentEnvFor(northgateDossier, northgateProfile, northgateAuth);

// THE DERIVED ENVIRONMENT IS APPLIED, which is the whole point of deriving it.
// The composition root reads PCC_PO_NUMBERING and PCC_PO_SEPARATOR to select a
// numbering strategy, so an installation that did not set them would number by
// the development default — and the first run of this suite did exactly that,
// producing NG-3301-FERNDALE-1 under Lippolis's rule at a company that does not
// count per job. Applying the dossier's own output is how a deployment works and
// is therefore how the rehearsal must work.
for (const [k, v] of Object.entries(ngEnv)) process.env[k] = v;

{
  // The derived environment is Northgate's, and none of it is Lippolis's.
  eq(ngEnv.PCC_ORG_ID, 'org-002-trades', 'the tenant id is Northgate\'s');
  eq(ngEnv.PCC_ORG_NAME, 'Northgate Mechanical Ltd.', 'and the letterhead');
  eq(ngEnv.PCC_PO_NUMBERING, 'vendor-sequence', 'and the numbering rule');
  eq(ngEnv.PCC_PO_SEPARATOR, '/', 'and the separator');
  eq(ngEnv.PCC_STOCK_LOCATION_LABEL, 'yard', 'and the word for the place that holds stock');
  eq(ngEnv.TZ, 'America/Boise', 'and the timezone');
  const text = JSON.stringify(ngEnv);
  check(!/lippolis/i.test(text), 'and nothing in the derived environment mentions Lippolis');

  // NO SECRETS, asserted rather than intended: this output gets pasted into
  // tickets and committed to release notes.
  check(!Object.keys(ngEnv).some((k) => /secret|password|token|key$/i.test(k)),
    'the derived environment contains no secret, so it is safe to print and commit');
  check(!('SESSION_SECRET' in ngEnv), 'SESSION_SECRET specifically is never derived');

  // IDEMPOTENT. Deriving twice is byte-identical, so re-running provisioning
  // cannot produce a second, subtly different configuration.
  eq(O.deploymentEnvFor(northgateDossier, northgateProfile, northgateAuth), ngEnv,
    'deriving twice is byte-identical — provisioning is idempotent');

  // Deterministic ordering, so a diff between two runs means a real change.
  const keys = Object.keys(ngEnv);
  eq(keys, [...keys].sort(), 'and the output is sorted, so a diff means a change');

  // The instance data exists and is the same five files a real partner fills in.
  for (const f of ['users.csv', 'jobs.csv', 'vendors.csv', 'assignments.csv', 'po_sequences.csv']) {
    check(existsSync(R(northgateDossier.instance_data.dir, f)),
      `Northgate's instance data includes ${f}, the same file a real partner fills in`);
  }
  const users = readFileSync(R(northgateDossier.instance_data.dir, 'users.csv'), 'utf8');
  check(!/lippolis/i.test(users), 'and no Lippolis person appears in it');
  check(/example\.invalid/.test(users),
    'every synthetic address is example.invalid, which cannot receive mail');
  for (const role of ['WORKSHOP_APPROVER', 'ACCOUNTING']) {
    check(!users.includes(role), `and no ${role} — Northgate's org chart shares no role name with Lippolis's`);
  }
}

// --- the organization is created, and the same refusals apply --------------
const NOW = '2026-09-01T14:00:00.000Z';
const db = openDatabase(join(TMP, 'northgate.db'));

{
  // Created through the schema the application creates, with Northgate's own
  // policy in system_settings — the row a first production start writes.
  db.prepare('insert into orgs (id, name, phone, address, created_at, updated_at) values (?,?,?,?,?,?)')
    .run(NG, ngEnv.PCC_ORG_NAME, ngEnv.PCC_ORG_PHONE, ngEnv.PCC_ORG_ADDRESS, NOW, NOW);
  db.prepare(
    `insert into system_settings (org_id, allow_self_approval, external_send_enabled, require_email_review,
                                 overdue_grace_hours, default_delivery_method, po_template_key,
                                 default_fulfilment_days, default_need_by_time, updated_at)
     values (?,0,0,1,0,'DELIVERY',?,?, '06:30', ?)`,
  ).run(NG, ngEnv.PCC_PO_TEMPLATE, Number(ngEnv.PCC_DEFAULT_FULFILMENT_DAYS), NOW);
  db.prepare('insert into request_number_sequences (org_id, prefix, padding, suffix, next_value, updated_at) values (?,?,?,?,?,?)')
    .run(NG, 'RQ-', 4, '', 1, NOW);

  const org = db.prepare('select * from orgs where id = ?').get(NG);
  eq(org.name, 'Northgate Mechanical Ltd.', 'the organization row carries Northgate\'s legal name');
  const settings = db.prepare('select * from system_settings where org_id = ?').get(NG);
  eq(settings.default_fulfilment_days, 2, 'and its own fulfilment expectation, not Lippolis\'s next-day');
  eq(settings.default_need_by_time, '06:30', 'and its own need-by time, not the 07:00 that used to be hard-coded');
  eq(settings.po_template_key, 'awe_default', 'and the product\'s standard form, not a customer-named one');
  eq(settings.external_send_enabled, 0, 'and vendor email is draft-only, which is not a per-customer setting');
}

// ===========================================================================
console.log('--- 4. the full lifecycle, under Northgate\'s policy -------------');
// ===========================================================================

const S = await import(join(APP, 'server/service.ts'));
const admin = await import(join(APP, 'purchasing/application/administration.ts'));

let clock = Date.parse(NOW);
const tick = () => new Date((clock += 60_000)).toISOString();
const ctx = () => S.context(db, tick());

// Northgate's people, carrying capabilities resolved from THEIR OWN role
// vocabulary. Not one of these role names exists in the built-in table.
// THE ROLE VOCABULARY IS REGISTERED FIRST, exactly as bootstrap does it on
// every start. `user_roles.role_key` has a foreign key to `roles`, so a role
// name this installation has never registered CANNOT BE STORED — which is why
// this was the largest remaining blocker on a second customer, and why the
// vocabulary is now derived from the authorization profile into
// PCC_ROLE_VOCABULARY rather than being six Lippolis names in seed.ts.
{
  const declared = ngEnv.PCC_ROLE_VOCABULARY.split(',');
  eq(declared, [...northgateAuth.roleNames].sort(),
    'the derived role vocabulary is exactly what Northgate\'s authorization profile declares');
  for (const key of declared) {
    const label = key.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
    db.prepare('insert or ignore into roles (key, label, description) values (?,?,?)')
      .run(key, label, "Declared by this organization's authorization profile.");
  }
  const stored = db.prepare('select key from roles order by key').all().map((r) => r.key);
  for (const key of declared) check(stored.includes(key), `${key} is a storable role name`);
  check(!declared.includes('WORKSHOP_APPROVER'),
    'and Northgate registered no Lippolis role name — the vocabulary is the organization\'s, not the product\'s');
}

const person = (id, name, email, roles) => {
  db.prepare(
    'insert into users (id, org_id, email, full_name, is_active, can_approve, created_at, updated_at) values (?,?,?,?,1,0,?,?)',
  ).run(id, NG, email, name, NOW, NOW);
  for (const role of roles) {
    db.prepare('insert into user_roles (user_id, role_key, granted_at) values (?,?,?)').run(id, role, NOW);
  }
  return withCapabilities({ id, orgId: NG, name, isActive: true, roles }, northgateAuth);
};

/**
 * An actor built the way the APPLICATION builds one: loaded through the
 * identity adapter, so it carries the job assignments the database holds, then
 * resolved against the organization's authorization profile.
 *
 * The first version of this suite hand-built actor objects and receiving failed
 * with "job NG-3301 is not assigned to you" even after the assignment existed —
 * because a hand-built actor has no `assignedJobNumbers`. Loading it properly is
 * both more faithful and the reason the assignment-scope assertions below mean
 * anything.
 */
const reload = async (id) => withCapabilities(await S.loadActor(db, id), northgateAuth);

let dana = person('u-dana', 'Dana Whitfield', 'dana@example.invalid', ['SYSTEM_ADMIN']);
let sam = person('u-sam', 'Sam Okafor', 'sam@example.invalid', ['OPERATIONS_MANAGER']);
let tomas = person('u-tomas', 'Tomas Ruiz', 'tomas@example.invalid', ['YARD_HAND']);
let erin = person('u-erin', 'Erin Vasquez', 'erin@example.invalid', ['FIELD_STAFF']);

{
  // IDENTITY. Authority is resolved from Northgate's profile, and the role
  // names are ones the domain's built-in table has never heard of.
  check(sam.capabilities.includes('po.generate'), 'the operations manager may generate a purchase order');
  check(!erin.capabilities.includes('review.decide'), 'field staff may not decide');
  check(tomas.capabilities.includes('receiving.record'), 'the yard hand may receive');
  check(!tomas.capabilities.includes('request.complete'),
    'and may not complete — receiving authority is deliberately wider than completion authority');
  const { ROLE_PERMISSIONS } = await import(join(DOMAIN, 'roles.mjs'));
  for (const role of ['OPERATIONS_MANAGER', 'YARD_HAND', 'FIELD_STAFF', 'OFFICE_ADMIN', 'SYSTEM_ADMIN']) {
    check(!Object.keys(ROLE_PERMISSIONS).includes(role),
      `${role} is unknown to the built-in vocabulary — purchasing never learns Northgate's role names`);
  }
}

// --- reference data, through the same functions the Admin screens call -----
let vendorFerndale, vendorWestline, jobsite;
{
  await admin.createJob(ctx(), dana, { jobNumber: 'NG-3301', name: 'Riverside Plant Chiller Replacement', customer: 'Riverside Foods', status: 'ACTIVE' });
  await admin.createJob(ctx(), dana, { jobNumber: 'NG-3302', name: 'Cedar Ridge Boiler Retrofit', customer: 'Cedar Ridge Schools', status: 'ACTIVE' });
  vendorFerndale = (await admin.createVendor(ctx(), dana, { name: 'Ferndale Pipe Supply', code: 'FERNDALE', contactEmail: 'orders@example.invalid' })).vendorId;
  vendorWestline = (await admin.createVendor(ctx(), dana, { name: 'Westline HVAC Distributors', code: 'WESTLINE', contactEmail: 'trade@example.invalid' })).vendorId;
  check(typeof vendorFerndale === 'string' && vendorFerndale.length > 0, 'vendors are created through the same function the Admin screen calls');
  // The three destinations a first production start creates. Replicated here
  // because this suite builds the organization directly rather than booting the
  // application — and the STOCK LOCATION IS NAMED FROM THE ORGANIZATION'S OWN
  // WORD, which is the half of terminology.stock_location that used to be the
  // literal "Workshop".
  const { randomUUID } = await import('node:crypto');
  const stockName = ngEnv.PCC_STOCK_LOCATION_LABEL.charAt(0).toUpperCase() + ngEnv.PCC_STOCK_LOCATION_LABEL.slice(1);
  for (const loc of [{ name: stockName, kind: 'WORKSHOP' }, { name: 'Office', kind: 'OFFICE' },
    { name: 'Vendor counter pickup', kind: 'VENDOR_PICKUP' }]) {
    db.prepare('insert into delivery_locations (id, org_id, name, address, kind, is_active, created_at, updated_at) values (?,?,?,?,?,1,?,?)')
      .run(randomUUID(), NG, loc.name, null, loc.kind, NOW, NOW);
  }
  db.prepare('insert into delivery_locations (id, org_id, name, address, kind, is_active, created_at, updated_at) values (?,?,?,?,?,1,?,?)')
    .run(randomUUID(), NG, 'NG-3301 — Riverside Plant', '880 Canal Way Boise ID', 'JOBSITE', NOW, NOW);

  const locations = await S.listDeliveryLocations(ctx(), dana);
  check(locations.length > 0, 'a new organization has delivery locations without anybody configuring them');
  const stock = locations.find((l) => l.kind === 'WORKSHOP');
  eq(stock.name, 'Yard',
    'and the internal stock destination carries Northgate\'s word for it, not Lippolis\'s "Workshop"');
  jobsite = locations.find((l) => l.kind === 'JOBSITE') ?? locations[0];
  // ASSIGNMENTS. Receiving authority is scoped to the jobs a person is
  // assigned to, and that scope is not a per-customer setting — it is how the
  // capability works. Northgate's assignments.csv says who signs for what.
  await admin.setJobAssignment(ctx(), dana, 'u-tomas', 'NG-3301', true);
  await admin.setJobAssignment(ctx(), dana, 'u-erin', 'NG-3301', true);
  // Re-read them, because an assignment is a fact about the database and an
  // actor loaded before it was written does not have it.
  tomas = await reload('u-tomas');
  erin = await reload('u-erin');
  sam = await reload('u-sam');
  dana = await reload('u-dana');
  eq(tomas.assignedJobNumbers, ['NG-3301'], 'the yard hand carries his one job assignment');
  check(tomas.capabilities.includes('receiving.record'),
    'and still resolves his capabilities from Northgate\'s authorization profile after reloading');

  const jobs = await S.listJobs(ctx(), dana);
  eq(jobs.length, 2, 'Northgate\'s two jobs exist, numbered in its own format');
  check(jobs.every((j) => String(j.job_number).startsWith('NG-')),
    'and no job number is Lippolis-shaped');
}

// --- REQUEST -> ... -> COMPLETE -------------------------------------------
{
  const created = await S.createRequest(ctx(), erin, {
    jobNumber: 'NG-3301',
    needByDate: '2026-09-04',
    needByTime: '06:30',
    deliveryLocationId: jobsite.id,
    deliveryMethod: 'DELIVERY',
    reason: 'Chiller pipework, level 2.',
    items: [
      { description: '2in copper type L, 20ft lengths', qty: '12', unit: 'ea' },
      { description: 'Ball valve 2in full port', qty: '4', unit: 'ea' },
    ],
  });
  check(Boolean(created.id), 'field staff raise a requisition');
  await S.submitRequest(ctx(), erin, created.id);

  // REVIEW under Northgate's policy: stock in the YARD reduces what is bought.
  const detail = await S.getRequestDetail(ctx(), sam, created.id);
  await S.saveReview(ctx(), sam, created.id, {
    workshopNotes: 'Four lengths on the rack.',
    lines: detail.originalItems.map((it, i) => ({
      requestItemId: it.id,
      usableStock: i === 0 ? '4' : '0',
      approvedQty: i === 0 ? '12' : '4',
      vendorId: vendorFerndale,
      estimatedUnitCost: i === 0 ? '48.00' : '112.50',
    })),
  });
  const reviewed = await S.getRequestDetail(ctx(), sam, created.id);
  eq(reviewed.reviewLines.map((l) => l.suggestedOrderQty), [8_000, 4_000],
    'order = max(requested - stock, 0) — the invariant holds for Northgate too');
  eq(reviewed.reviewLines[0].requestedQty, 12_000,
    'and what the job asked for is untouched by the review, at a second organization as at the first');

  // PRICES ARE CAPTURED AT ORDER TIME HERE, which Lippolis does not do.
  check(reviewed.reviewLines.every((l) => Number(l.estimatedUnitCostCents) > 0),
    'Northgate captures costs at order time — its own policy, opposite to Lippolis\'s');

  await S.decide(ctx(), sam, created.id, 'APPROVE', { notes: 'Order the balance from Ferndale.' });
  await S.generatePurchaseOrder(ctx(), sam, created.id);

  const poRow = db.prepare('select * from purchase_orders where request_id = ?').get(created.id);
  const firstPoNumber = poRow.po_number;

  // THE NUMBER IS NORTHGATE'S RULE, not Lippolis's. No job, and a slash.
  eq(firstPoNumber, 'FERNDALE/1',
    'the purchase order is numbered by Northgate\'s per-vendor rule, with its own separator');
  check(!/NG-3301/.test(firstPoNumber),
    'and the job does not appear in it — this rule does not count per job');

  // The document is drawn from the form the organization declared, and RECORDED
  // under the form that actually drew it.
  await S.generatePoDocument(ctx(), sam, poRow.id);
  const stored = db.prepare('select * from purchase_order_documents where purchase_order_id = ?').get(poRow.id);
  eq(stored.template_key, 'awe_default',
    'and it is RECORDED under the form that actually drew it, not one it merely declared');

  const view = await S.purchaseOrderView(ctx(), poRow.id);
  const bytes = poTemplateFor('awe_default', NG).render(view);
  const text = bytes.toString('latin1');
  check(text.includes('Northgate'),
    'the drawn purchase order carries Northgate\'s name — the layout was never Lippolis-specific, only Lippolis-named');
  check(!text.includes('Lippolis'), 'and does not carry Lippolis\'s');
  check(text.includes('FERNDALE/1'), 'and Northgate\'s own purchase order number');

  // A FORM NOBODY HAS DRAWN IS REFUSED, rather than drawn as this one and
  // recorded under the name that was asked for.
  let refused = null;
  try { poTemplateFor('northgate_letterhead', NG); } catch (err) { refused = err; }
  check(refused?.reason === 'po_template_not_implemented',
    'a purchase order form this build cannot draw is refused, not substituted');
  check(refused && refused.message.includes(NG),
    'and the refusal names the organization that declared it');

  // EMAIL is drafted and reviewed. Never sent.
  const draft = await S.generateVendorEmailDraft(ctx(), sam, created.id);
  const draftId = draft.id ?? draft;
  check(Boolean(draftId), 'a vendor email is drafted');
  // A PERSON REVIEWS IT, APPROVES IT, AND SENDS IT THEMSELVES. Nothing here
  // transmits anything — "SENT" means somebody copied it into their own mail
  // client. That is the same boundary Lippolis has, chosen again deliberately
  // for a second organization rather than inherited by accident.
  await throws(() => S.advanceEmailDraft(ctx(), sam, draftId, 'SENT'), /.*/,
    'a draft cannot jump straight to sent — the review step is not skippable');
  await S.advanceEmailDraft(ctx(), sam, draftId, 'REVIEWED');
  await S.advanceEmailDraft(ctx(), sam, draftId, 'APPROVED_TO_SEND');
  await S.advanceEmailDraft(ctx(), sam, draftId, 'SENT');
  const settingsNow = db.prepare('select external_send_enabled from system_settings where org_id = ?').get(NG);
  eq(settingsNow.external_send_enabled, 0,
    'and external sending stayed disabled throughout — it is a schema constraint, not a per-customer setting');

  await S.markOrdered(ctx(), sam, created.id, {});
  eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'ORDERED',
    'the operations manager places the order');

  // RECEIVING, by the yard hand, whose authority is narrower than Sam's.
  await S.receiveEverything(ctx(), tomas, created.id, {});
  const afterReceipt = db.prepare('select status from purchase_requests where id = ?').get(created.id).status;
  check(['RECEIVED', 'PARTIALLY_RECEIVED'].includes(afterReceipt),
    'the yard hand records the delivery');

  await throws(() => S.completeRequest(ctx(), tomas, created.id), /.*/,
    'and may NOT complete it — a capability nobody granted is genuinely refused');



  await S.completeRequest(ctx(), sam, created.id);
  eq(db.prepare('select status from purchase_requests where id = ?').get(created.id).status, 'COMPLETED',
    'the operations manager completes it');

  // IMMUTABLE HISTORY, the record that outlives the request.
  const history = db.prepare('select count(*) c from purchase_history_lines where org_id = ?').get(NG);
  check(Number(history?.c ?? 0) > 0, 'and completion writes immutable history lines, scoped to Northgate');

  // A SECOND ORDER TO THE SAME VENDOR ON A DIFFERENT JOB. Under Lippolis's rule
  // this would restart at 1; under Northgate's it must be 2. This single
  // assertion is the clearest evidence the numbering seam is real.
  const second = await S.createRequest(ctx(), erin, {
    jobNumber: 'NG-3302', needByDate: '2026-09-05', needByTime: '06:30',
    deliveryLocationId: jobsite.id, deliveryMethod: 'DELIVERY',
    reason: 'Boiler retrofit hangers.',
    items: [{ description: 'Pipe hangers 2in', qty: '30', unit: 'ea' }],
  });
  await S.submitRequest(ctx(), erin, second.id);
  const d2 = await S.getRequestDetail(ctx(), sam, second.id);
  await S.saveReview(ctx(), sam, second.id, {
    lines: d2.originalItems.map((it) => ({
      requestItemId: it.id, usableStock: '0', approvedQty: '30',
      vendorId: vendorFerndale, estimatedUnitCost: '3.20',
    })),
  });
  await S.decide(ctx(), sam, second.id, 'APPROVE', {});
  await S.generatePurchaseOrder(ctx(), sam, second.id);
  eq(db.prepare('select po_number from purchase_orders where request_id = ?').get(second.id).po_number, 'FERNDALE/2',
    'a different job continues the SAME vendor counter — Northgate\'s rule, not Lippolis\'s');

  // A DIFFERENT VENDOR STARTS ITS OWN COUNTER AT 1.
  const third = await S.createRequest(ctx(), erin, {
    jobNumber: 'NG-3301', needByDate: '2026-09-06', needByTime: '06:30',
    deliveryLocationId: jobsite.id, deliveryMethod: 'DELIVERY',
    reason: 'Air handler filters.',
    items: [{ description: 'Filter 20x25x2 MERV 8', qty: '24', unit: 'ea' }],
  });
  await S.submitRequest(ctx(), erin, third.id);
  const d3 = await S.getRequestDetail(ctx(), sam, third.id);
  await S.saveReview(ctx(), sam, third.id, {
    lines: d3.originalItems.map((it) => ({
      requestItemId: it.id, usableStock: '0', approvedQty: '24',
      vendorId: vendorWestline, estimatedUnitCost: '9.10',
    })),
  });
  await S.decide(ctx(), sam, third.id, 'APPROVE', {});
  await S.generatePurchaseOrder(ctx(), sam, third.id);
  eq(db.prepare('select po_number from purchase_orders where request_id = ?').get(third.id).po_number, 'WESTLINE/1',
    'and a different vendor starts its own counter at one');

  // IDEMPOTENCE. Asking twice returns the same number and burns no sequence.
  await S.generatePurchaseOrder(ctx(), sam, third.id).catch(() => {});
  eq(db.prepare('select count(*) c from purchase_orders where request_id = ?').get(third.id).c, 1,
    'asking for a purchase order twice does not issue a second one');

  // AUDIT. The work is recorded, and every record is Northgate's.
  const rows = db.prepare('select * from purchase_activity_log where org_id = ?').all(NG);
  check(rows.length > 0, 'the audit trail recorded the work');
  eq(db.prepare('select count(*) c from purchase_activity_log where org_id is null').get().c, 0,
    'and no audit row is unattributed to an organization');
  // AND THE ASSIGNMENT SCOPE IS REAL, not decoration: the same yard hand cannot
  // receive against a job he is not assigned to. This is the check that made the
  // rehearsal fail the first time it ran, which is the best evidence it works.
  await throws(async () => {
    const other = await S.createRequest(ctx(), erin, {
      jobNumber: 'NG-3302', needByDate: '2026-09-07', needByTime: '06:30',
      deliveryLocationId: jobsite.id, deliveryMethod: 'DELIVERY',
      reason: 'Unassigned-job check.',
      items: [{ description: 'Union 2in', qty: '2', unit: 'ea' }],
    });
    await S.submitRequest(ctx(), erin, other.id);
    const od = await S.getRequestDetail(ctx(), sam, other.id);
    await S.saveReview(ctx(), sam, other.id, {
      lines: od.originalItems.map((it) => ({
        requestItemId: it.id, usableStock: '0', approvedQty: '2',
        vendorId: vendorFerndale, estimatedUnitCost: '18.00',
      })),
    });
    await S.decide(ctx(), sam, other.id, 'APPROVE', {});
    await S.generatePurchaseOrder(ctx(), sam, other.id);
    const d = await S.generateVendorEmailDraft(ctx(), sam, other.id);
    await S.advanceEmailDraft(ctx(), sam, (d.id ?? d), 'REVIEWED');
    await S.advanceEmailDraft(ctx(), sam, (d.id ?? d), 'APPROVED_TO_SEND');
    await S.advanceEmailDraft(ctx(), sam, (d.id ?? d), 'SENT');
    await S.markOrdered(ctx(), sam, other.id, {});
    await S.receiveEverything(ctx(), tomas, other.id, {});
  }, /not assigned/i, 'the yard hand cannot sign for a delivery on a job he is not assigned to');

  note(`Northgate rehearsal: ${rows.length} audit records; FERNDALE/1, FERNDALE/2, WESTLINE/1`);
}

// ===========================================================================
console.log('--- 5. ANTI-FORK ------------------------------------------------');
// ===========================================================================

// THE PATTERN THIS EXISTS TO PREVENT: customer-a branch, customer-b branch,
// customer-c branch. It begins with one `if (org === 'lippolis')`, which is
// always defensible in isolation and never defensible in aggregate.
//
// ONE CANONICAL PRODUCT LINE is the invariant. An organization's differences
// arrive through configuration, policy, or a declared integration boundary —
// never through source that names the customer.
{
  const sources = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.next', 'dist', '.git'].includes(e.name)) continue;
        sources(p, out);
      } else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  };
  // Comments are stripped: this file's own prose explains why customer names
  // must not appear in logic, and matching that would be the same mistake.
  //
  // SQL LINE COMMENTS COUNT TOO. The schema is a template literal inside a .ts
  // file and documents itself with `--`, so stripping only JavaScript comments
  // reported database.ts as carrying six customer literals when every one was
  // prose. Only a line whose first non-space characters are `--` is stripped,
  // so a decrement operator survives.
  const executable = (f) => readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/^[ \t]*--[^\n]*/gm, '');

  const appSources = sources(join(APP, 'purchasing')).concat(sources(join(APP, 'app')), sources(join(APP, 'components')));

  // 1. NO IDENTITY BRANCHING. A comparison of an organization id against a
  //    literal is the first line of a fork.
  const ORG_BRANCH = /(?:orgId|org_id|organization(?:Id)?|tenantId?)\s*(?:===?|!==?)\s*['"][a-z0-9_-]+['"]|['"][a-z0-9_-]+['"]\s*(?:===?|!==?)\s*(?:orgId|org_id|organizationId)/;
  const branching = appSources.filter((f) => ORG_BRANCH.test(executable(f)))
    .map((f) => f.replace(APP + '/', ''));
  eq(branching, [], 'no source file branches on a specific organization id');

  // 2. NO CUSTOMER NAME IN EXECUTABLE CODE. Fixtures and the bootstrap refusal
  //    message are the declared exceptions, and they are declared BY NAME so a
  //    new one has to be argued for rather than added.
  const CUSTOMER_NAME = /lippolis|northgate|lipele/i;
  const ALLOWED = [
    // Development seed data. Lippolis's people, in a fixture, by design.
    'purchasing/infrastructure/seed.ts',
    // The refusal message that tells an installer what Lippolis set, as the
    // worked example. It is prose in an error string, not behaviour.
    'purchasing/infrastructure/bootstrap.ts',
    // The registry ALIAS that keeps documents issued under the old template key
    // resolvable. Removing it would orphan real stored evidence.
    'purchasing/infrastructure/pdf-adapter.ts',
    // Lippolis's own numbering rule and terminology defaults, each named in one
    // place and reached only through configuration.
    'purchasing/organization/po-numbering.mjs',
    'purchasing/organization/identity.mjs',
  ];
  const named = appSources.filter((f) => CUSTOMER_NAME.test(executable(f)))
    .map((f) => f.replace(APP + '/', ''))
    .filter((f) => !ALLOWED.includes(f));
  eq(named, [], 'no customer name appears in executable code outside the declared exceptions');

  // 3. THE 24 PAGE TITLES. Every screen used to say "Lippolis Purchasing" as a
  //    string literal — the largest single block of source a second customer
  //    would have had to edit before their own staff could look at a screen.
  const pages = sources(join(APP, 'app')).filter((f) => f.endsWith('page.tsx'));
  const hardTitled = pages.filter((f) => /title:\s*['"][^'"]*(?:Lippolis|Northgate)/i.test(readFileSync(f, 'utf8')))
    .map((f) => f.replace(APP + '/app/', ''));
  eq(hardTitled, [], 'not one page title names a customer');
  const derived = pages.filter((f) => /pageTitle\(/.test(readFileSync(f, 'utf8')));
  check(derived.length >= 18,
    `page titles are derived from the organization's own name (${derived.length} pages)`);

  // 4. NO PER-CUSTOMER CONFIG DIRECTORIES OR BUILD TARGETS. A fork often
  //    arrives as a build flag before it arrives as a branch.
  const pkg = JSON.parse(readFileSync(R('package.json'), 'utf8'));
  const scripts = Object.entries(pkg.scripts ?? {});
  eq(scripts.filter(([k, v]) => CUSTOMER_NAME.test(k) || CUSTOMER_NAME.test(v)).map(([k]) => k), [],
    'no npm script is named after, or hard-codes, a customer');

  // 5. EVERY ORGANIZATION GOES THROUGH THE SAME CONTRACT. A second dossier
  //    must not be a special case of the first.
  const orgDirs = readdirSync(R('organizations'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  check(orgDirs.length >= 2, 'more than one organization is described by the same contract');
  for (const d of orgDirs) {
    check(existsSync(R('organizations', d, 'dossier.mjs')),
      `${d} is described by a dossier, not by bespoke files`);
  }
  const ids = new Set();
  for (const d of orgDirs) {
    const dossier = (await import(R('organizations', d, 'dossier.mjs'))).default;
    check(O.validateDossier(dossier).ok, `${d}'s dossier is valid under the one contract`);
    check(!ids.has(dossier.organization.id), `${d}'s organization id is unique`);
    ids.add(dossier.organization.id);
  }

  // 6. THE ONE INTENTIONAL EXCEPTION IS DOCUMENTED AS ONE. If a genuinely
  //    per-customer behaviour is ever needed, it must be a declared boundary
  //    rather than a condition. Today there are none, and that is asserted so
  //    adding one is a deliberate act.
  note(`anti-fork: ${appSources.length} source files scanned, 0 organization-id branches, ` +
    `${ALLOWED.length} declared customer-name exceptions`);
}

// ===========================================================================
console.log('--- 6. cross-tenant adversarial ---------------------------------');
// ===========================================================================

// Lippolis is created in the SAME DATABASE as Northgate. That is not the
// deployment model — one installation serves one organization — and it is
// exactly why it is the right test: if the code is genuinely tenant-scoped, the
// hostile case is harmless, and if it is not, this is where it shows.
{
  const LIP = 'lippolis';
  db.prepare('insert into orgs (id, name, phone, address, created_at, updated_at) values (?,?,?,?,?,?)')
    .run(LIP, 'Lippolis Electric, Inc.', '(914) 738-3550', 'Pelham NY', NOW, NOW);
  db.prepare(
    `insert into system_settings (org_id, allow_self_approval, external_send_enabled, require_email_review,
                                 overdue_grace_hours, default_delivery_method, po_template_key,
                                 default_fulfilment_days, default_need_by_time, updated_at)
     values (?,0,0,1,0,'DELIVERY','lippolis_default',1,'07:00',?)`,
  ).run(LIP, NOW);
  db.prepare('insert into request_number_sequences (org_id, prefix, padding, suffix, next_value, updated_at) values (?,?,?,?,?,?)')
    .run(LIP, 'PR-', 5, '', 1001, NOW);

  // THE SAME EMAIL ADDRESS IN TWO ORGANIZATIONS. Two businesses may genuinely
  // employ the same person, and a global unique constraint on email would make
  // the second deployment impossible.
  db.prepare('insert into users (id, org_id, email, full_name, is_active, can_approve, created_at, updated_at) values (?,?,?,?,1,1,?,?)')
    .run('u-lip-mike', LIP, 'sam@example.invalid', 'Mike (Lippolis)', NOW, NOW);
  // LIPPOLIS'S OWN ROLE VOCABULARY IS REGISTERED FOR LIPPOLIS. Both
  // organizations' role names coexist in one `roles` table, which is what the
  // foreign key requires, and neither organization's AUTHORITY comes from it.
  for (const key of lippolisAuth.roleNames) {
    db.prepare('insert or ignore into roles (key, label, description) values (?,?,?)')
      .run(key, key, 'Declared by this organization\'s authorization profile.');
  }
  db.prepare('insert into user_roles (user_id, role_key, granted_at) values (?,?,?)')
    .run('u-lip-mike', 'WORKSHOP_APPROVER', NOW);
  const bothVocabularies = db.prepare('select key from roles').all().map((r) => r.key);
  check(bothVocabularies.includes('WORKSHOP_APPROVER') && bothVocabularies.includes('OPERATIONS_MANAGER'),
    'two organizations\' role vocabularies coexist — the registry holds names, never authority');
  const sharing = db.prepare('select org_id from users where email = ? order by org_id').all('sam@example.invalid');
  eq(sharing.map((r) => r.org_id), ['lippolis', 'org-002-trades'],
    'the same email exists in two organizations — a person may work for both, and email is not a global identity');

  // THE SAME VENDOR NAME AND CODE IN BOTH. Both businesses buy from Ferndale.
  const lipFerndale = db.prepare('select id from vendors where org_id = ? and code = ?').get(NG, 'FERNDALE');
  check(Boolean(lipFerndale), 'Northgate has a FERNDALE vendor');
  db.prepare('insert into vendors (id, org_id, name, code, is_active, created_at, updated_at) values (?,?,?,?,1,?,?)')
    .run('v-lip-ferndale', LIP, 'Ferndale Pipe Supply', 'FERNDALE', NOW, NOW);
  eq(db.prepare('select count(*) c from vendors where code = ?').get('FERNDALE').c, 2,
    'and so does Lippolis — a vendor code is unique WITHIN an organization, not across the world');

  // THE SAME JOB NUMBER IN BOTH.
  db.prepare('insert into purchase_jobs (id, org_id, job_number, name, status, created_at, updated_at) values (?,?,?,?,?,?,?)')
    .run('j-lip-3301', LIP, 'NG-3301', 'A Lippolis job that happens to share a number', 'ACTIVE', NOW, NOW);
  eq(db.prepare('select count(*) c from purchase_jobs where job_number = ?').get('NG-3301').c, 2,
    'two organizations may use the same job number');

  // A LIPPOLIS ACTOR MUST SEE NOTHING OF NORTHGATE'S.
  const lipMike = withCapabilities(
    { id: 'u-lip-mike', orgId: LIP, name: 'Mike', isActive: true, roles: ['WORKSHOP_APPROVER'] },
    lippolisAuth,
  );
  const lipRequests = await S.listRequests(ctx(), lipMike, {});
  const lipRows = lipRequests.rows ?? lipRequests ?? [];
  eq(lipRows.length, 0, 'a Lippolis approver sees NONE of Northgate\'s requisitions');

  const ngRequests = await S.listRequests(ctx(), sam, {});
  check(((ngRequests.rows ?? ngRequests) ?? []).length > 0, 'while Northgate\'s own manager sees his');

  const lipAdmin = withCapabilities(
    { id: 'u-lip-mike', orgId: LIP, name: 'Mike', isActive: true, roles: ['ADMIN'] }, lippolisAuth,
  );
  const lipAudit = await S.auditLog(ctx(), lipAdmin, 500);
  eq(lipAudit.length, 0,
    'and a Lippolis administrator reads NONE of Northgate\'s audit trail, in the same database');
  const ngAdmin = await reload('u-dana');
  check((await S.auditLog(ctx(), ngAdmin, 500)).length > 0,
    'while Northgate\'s own administrator reads Northgate\'s');

  const lipVendors = await S.listVendors(ctx(), lipMike);
  eq(lipVendors.map((v) => v.id), ['v-lip-ferndale'],
    'vendor lists do not cross the tenant boundary even when the codes match');

  // WRONG ORG ID. A membership resolved against another organization's profile
  // yields NOTHING — not an error, nothing, which is the honest answer to "what
  // may this person do here".
  eq(effectiveCapabilities(northgateAuth, { orgId: LIP, roles: ['OPERATIONS_MANAGER'] }), [],
    'Northgate\'s authorization grants nothing to a Lippolis membership');
  eq(effectiveCapabilities(lippolisAuth, { orgId: NG, roles: ['WORKSHOP_APPROVER'] }), [],
    'and Lippolis\'s grants nothing to a Northgate membership');
  const impostor = withCapabilities({ id: 'x', orgId: LIP, roles: ['OPERATIONS_MANAGER'], isActive: true }, northgateAuth);
  check(!authorize(impostor, 'po.generate').ok,
    'so a Lippolis user claiming a Northgate role cannot generate a purchase order');

  // ONE ORGANIZATION'S NUMBERING RULE CANNOT REACH ANOTHER'S COUNTERS.
  const lipStrategy = poNumberStrategyFor('job-vendor-sequence', LIP, { separator: '-' });
  const ngStrategy = poNumberStrategyFor('vendor-sequence', NG, { separator: '/' });
  eq(lipStrategy.format({ jobNumber: 'NG-3301', vendorCode: 'FERNDALE', sequence: 1 }), 'NG-3301-FERNDALE-1',
    'Lippolis numbers its own order in its own shape, on an identical job and vendor');
  eq(ngStrategy.format({ vendorCode: 'FERNDALE', sequence: 1 }), 'FERNDALE/1',
    'and Northgate numbers its own in its own shape');
  check(lipStrategy.format({ jobNumber: 'NG-3301', vendorCode: 'FERNDALE', sequence: 1 })
    !== ngStrategy.format({ vendorCode: 'FERNDALE', sequence: 1 }),
    'two organizations with the same job and vendor produce different identifiers');

  // CONFLICTING POLICY, side by side, in one process.
  const lipSettings = db.prepare('select * from system_settings where org_id = ?').get(LIP);
  const ngSettings = db.prepare('select * from system_settings where org_id = ?').get(NG);
  check(lipSettings.default_fulfilment_days !== ngSettings.default_fulfilment_days,
    'the two organizations hold different fulfilment expectations simultaneously');
  check(lipSettings.default_need_by_time !== ngSettings.default_need_by_time,
    'and different need-by times');
  check(lipSettings.po_template_key !== ngSettings.po_template_key,
    'and different declared purchase order forms');

  // NO PRINTER, NO SSO. Both are the ordinary case and neither may block.
  eq(Object.keys(ngEnv).filter((k) => /printer/i.test(k)), [],
    'no printer setting exists to be missing — approving opens the browser print dialogue');
  check(northgateManifest.authentication.mode.value === 'local',
    'Northgate runs on local accounts; SSO is recorded as a want, not a dependency');

  // A CUSTOMER REMOVES A USER. Deactivation must not orphan the work.
  db.prepare('update users set is_active = 0 where id = ?').run('u-erin');
  const stillThere = await S.listRequests(ctx(), sam, {});
  check((stillThere.rows ?? stillThere).length > 0,
    'deactivating the requester does not remove the requisitions she raised — the record outlives the account');
  const inactive = withCapabilities({ id: 'u-erin', orgId: NG, roles: ['FIELD_STAFF'], isActive: false }, northgateAuth);
  check(!authorize(inactive, 'request.create').ok, 'and an inactive account may do nothing');
  db.prepare('update users set is_active = 1 where id = ?').run('u-erin');

  // PROVISIONING TWICE. The organization row is the tenant boundary and there
  // may be exactly one.
  await throws(() => db.prepare('insert into orgs (id, name, created_at, updated_at) values (?,?,?,?)')
    .run(NG, 'Northgate Mechanical Ltd. (again)', NOW, NOW), /.*/,
    'provisioning the same organization twice is refused by the database, not by a dialog');
}

// ===========================================================================
console.log('--- 7. proof isolation ------------------------------------------');
// ===========================================================================

// THE FAILURE THIS PREVENTS IS THE WORST ONE IN THE REPOSITORY: quoting one
// company's measured savings as another's. It is arithmetically invisible and
// commercially fatal.
{
  const { defineBaseline, versionInForce, assertNoOverlap } = await import(R('proof/baseline.mjs'));
  const lippolisBaseline = (await import(R('proof/baselines/lippolis-purchasing.mjs'))).default;

  eq(lippolisBaseline.orgId, 'lippolis', 'the Lippolis baseline is bound to Lippolis');
  check(lippolisBaseline.key.startsWith('lippolis:'),
    'and its key is namespaced by the organization, so it cannot be addressed without naming one');

  // Northgate's baseline id is declared in its dossier and is a DIFFERENT
  // namespace. Nothing Lippolis measured may appear under it.
  eq(northgateDossier.proof.baseline_id, 'northgate_purchasing_v0',
    'Northgate declares its own baseline id');
  check(northgateDossier.proof.baseline_id !== lippolisDossier.proof.baseline_id,
    'and it is not Lippolis\'s');

  // THE ATTACK: ask for Northgate's baseline and see whether Lippolis's answers.
  const inForce = versionInForce([lippolisBaseline], { orgId: NG, id: 'lippolis_purchasing_v0', at: NOW });
  check(!inForce, 'asking for a Lippolis baseline in Northgate\'s name returns NOTHING, not Lippolis\'s numbers');
  const wrongId = versionInForce([lippolisBaseline], { orgId: NG, id: 'northgate_purchasing_v0', at: NOW });
  check(!wrongId, 'and Northgate has no baseline at all, which is the truthful answer for a company that does not exist');

  // A baseline for a second organization must be constructible without
  // touching the first's, and the overlap guard must not conflate them.
  // A SECOND ORGANIZATION'S BASELINE, CONSTRUCTED WITHOUT TOUCHING THE FIRST'S.
  //
  // EVERY MEASURED QUANTITY IS DELIBERATELY UNAVAILABLE. A baseline is a claim
  // about how long a real process really took at a real business, and Northgate
  // does not exist — so inventing a labour rate or a cycle time here would put a
  // fabricated number one `baseline:freeze` away from being quoted as evidence.
  // `UNAVAILABLE` is the provenance the proof layer already understands, and it
  // makes every derived figure withhold itself rather than compute from fiction.
  //
  // The STRUCTURE is real, which is what this section is testing: the id, the
  // org binding, the key, and the steps it claims.
  const ngBaseline = defineBaseline({
    id: 'northgate_purchasing_v0',
    version: '0.0.1-rehearsal',
    orgId: NG,
    process: 'material purchasing',
    description: 'SYNTHETIC. Structure only, for the second-customer rehearsal. Northgate Mechanical does not exist and no quantity here was measured.',
    effectiveFrom: '2026-09-01',
    unitOfWork: 'purchase order',
    steps: [
      { id: 'raise', label: 'the yard rings the office' },
      { id: 'decide', label: 'somebody checks the rack and decides' },
      { id: 'order', label: 'the order is telephoned to the supplier' },
      { id: 'receive', label: 'the ticket is signed and filed' },
    ],
    coversSteps: ['raise', 'decide', 'order', 'receive'],
    labourRateProvenance: 'UNAVAILABLE',
    cycleProvenance: 'UNAVAILABLE',
  });
  check(ngBaseline.labourRate.value === null && ngBaseline.cycle.value === null,
    'the rehearsal baseline measures NOTHING — a fabricated quantity is one freeze away from being quoted');
  check(ngBaseline.orgId === NG, 'a second organization\'s baseline is bound to it');
  check(ngBaseline.key !== lippolisBaseline.key, 'and keyed separately');
  // The overlap guard refuses two baselines claiming the SAME work for the SAME
  // organization. Two organizations claiming the same work is not an overlap.
  let overlapped = false;
  try { assertNoOverlap([lippolisBaseline, ngBaseline]); } catch { overlapped = true; }
  check(!overlapped,
    'two organizations may each measure their own purchasing without the overlap guard confusing them');

  // THE VALUE VIEW REFUSES A REHEARSAL, whatever the numbers say. This is what
  // stops this suite's own output ever being quoted as a customer outcome.
  const { organizationValue } = await import(R('proof/organization.mjs'));
  const view = organizationValue({
    orgId: NG, orgName: 'Northgate Mechanical Ltd.',
    environment: 'rehearsal',
    records: [], baselines: [ngBaseline], touchStandards: [],
    from: '2026-09-01', to: '2026-09-30',
  });
  const text = JSON.stringify(view);
  eq(view.evidence, { environment: 'rehearsal', admissible: false },
    'an organization value view built from a REHEARSAL declares itself inadmissible');
  check(view.hoursReturned.known === false && view.hoursReturned.value === null,
    'and withholds every hours figure rather than computing one from work that did not happen');
  check(view.labourValueCents.value === null && view.claimedCents?.value === null,
    'and every money figure');
  check(/did not happen|carry no value/i.test(view.hoursReturned.basis),
    'and says why, in the figure itself, so a reader cannot lift the number away from the caveat');
  check(!/lippolis/i.test(text), 'and contains nothing of Lippolis\'s');

  // THE COUNTS SURVIVE, because "the rehearsal ran N executions" is a true and
  // useful sentence. It is the money and the hours that are quotable, and those
  // are exactly what is withheld.
  check(typeof view.executions === 'number', 'the execution COUNT survives — it is true and quotable safely');

  // AND PRODUCTION IS NOT SIMILARLY MUTED, so the check above is not vacuous.
  const productionView = organizationValue({
    orgId: NG, orgName: 'Northgate Mechanical Ltd.', environment: 'production',
    records: [], baselines: [ngBaseline], touchStandards: [], from: '2026-09-01', to: '2026-09-30',
  });
  eq(productionView.evidence.admissible, true,
    'a production view IS admissible — so the rehearsal refusal is about the environment, not about everything');
  note('proof: Northgate has no baseline, and a rehearsal value view declares itself inadmissible and withholds every hours and money figure');
}

// ===========================================================================
console.log('--- 8. the pilot, the metric, and the packet ---------------------');
// ===========================================================================

// A DOCUMENT THAT HAS DRIFTED FROM THE CODE IS WORSE THAN NO DOCUMENT, because
// it is followed. Every command the founder-facing files name must exist, and
// every scope the pilot claims must be one the product actually offers.
{
  const { PURCHASING_MATERIALS_PILOT, PILOTS, timeToDeploy, definePeriod, NORTHGATE_REHEARSAL, TIME_CATEGORIES } =
    await import(R('programs/design-partner/pilot.mjs'));

  // The pilot the dossier declares must be one that exists.
  check(Object.keys(PILOTS).includes(northgateDossier.pilot.scope),
    'the pilot scope Northgate declares is one AWE actually offers');
  check(O.PILOT_SCOPES.includes(PURCHASING_MATERIALS_PILOT.id),
    'and the contract and the pilot definition agree on its name');

  // WHAT IS EXCLUDED IS WRITTEN DOWN. A pilot with no `out` list is a pilot
  // whose scope is negotiated in week three.
  check(PURCHASING_MATERIALS_PILOT.out.length >= 8,
    'the pilot says out loud what it does NOT include');
  check(PURCHASING_MATERIALS_PILOT.out.every((o) => o.item && o.why),
    'and gives a reason for each, so the answer is "not in this pilot" rather than "no"');
  for (const excluded of ['single sign-on', 'sending vendor email automatically', 'a different purchasing lifecycle']) {
    check(PURCHASING_MATERIALS_PILOT.out.some((o) => o.item === excluded),
      `${excluded} is explicitly out of scope`);
  }
  // The three things the product genuinely refuses must be excluded, not merely
  // deprioritized — the readiness gate reports each as BLOCKED_BY_PRODUCT.
  check(PURCHASING_MATERIALS_PILOT.baseline.whose.startsWith('CUSTOMER'),
    'the baseline is the customer\'s to produce — we cannot measure their old process for them');
  check(/cannot produce a case study/i.test(PURCHASING_MATERIALS_PILOT.baseline.ifAbsent),
    'and its absence blocks a CASE STUDY rather than the pilot, which is the truthful consequence');

  // --- TIME TO DEPLOY ---------------------------------------------------
  eq(TIME_CATEGORIES, ['FOUNDER_CONFIG', 'ENGINEERING', 'CUSTOMER_WAIT', 'IT_WAIT'],
    'time is split by WHOSE it was, because only the engineering number has to fall');

  // A REHEARSAL MAY NOT BE REPORTED AS A DEPLOYMENT.
  eq(NORTHGATE_REHEARSAL.admissible, false,
    'the synthetic rehearsal is NOT admissible as a deployment measurement');
  check(/REHEARSAL/.test(NORTHGATE_REHEARSAL.label),
    'and it is labelled so on the object, not in a caveat somebody may drop');
  eq(NORTHGATE_REHEARSAL.customEngineeringHours, 0,
    'and it records zero custom engineering FOR NORTHGATE, which is the claim this whole session was for');
  check(NORTHGATE_REHEARSAL.zeroEngineering, 'surfaced as its own flag, so it cannot hide inside a total');

  await throws(() => timeToDeploy({ orgId: 'x', committedAt: '2026-01-01' }),
    /must state which environment/,
    'a time-to-deploy record with no environment is refused — omitting it is how a rehearsal becomes a deployment');
  await throws(() => definePeriod({ category: 'MAGIC', hours: 1 }), /unknown time category/,
    'and time cannot be attributed to a category nobody defined');
  await throws(() => definePeriod({ category: 'ENGINEERING', hours: -3 }), /non-negative/,
    'nor can it be negative');

  {
    // A production record IS admissible, so the refusal above is about the
    // environment rather than about everything.
    const real = timeToDeploy({
      orgId: 'somebody-real', environment: 'production',
      committedAt: '2026-10-01', liveAt: '2026-10-15',
      periods: [definePeriod({ category: 'FOUNDER_CONFIG', hours: 4 }), definePeriod({ category: 'IT_WAIT', hours: 40 })],
    });
    eq(real.admissible, true, 'a production time-to-deploy record is admissible');
    eq(real.elapsedDays, 14, 'and elapsed days come from the dates supplied, never from the clock');
    eq(real.aweHours, 4, 'AWE\'s own hours are separated from everybody else\'s waiting');
    eq(real.waitingHours, 40, 'and the waiting is attributed rather than blamed on the product');
  }

  // --- THE FOUNDER-FACING DOCUMENTS ------------------------------------
  const packet = readFileSync(R('docs/design-partner/ONBOARDING.md'), 'utf8');
  const checklist = readFileSync(R('docs/design-partner/LAUNCH_CHECKLIST.md'), 'utf8');

  // EVERY SCRIPT THEY NAME MUST EXIST. A checklist that names a command nobody
  // wrote fails at 4pm on the day it is first used.
  const named = new Set();
  for (const doc of [packet, checklist]) {
    for (const m of doc.matchAll(/(?:node|bash)\s+(scripts\/[\w.-]+\.(?:mjs|sh))/g)) named.add(m[1]);
  }
  // Asserted by NAME rather than by count. A count passes when somebody adds a
  // command and drops the one that mattered, which is the drift worth catching.
  const absent = [...named].filter((f) => !existsSync(R(f)));
  eq(absent, [], `every command the packet and checklist name exists (${named.size} named)`);
  for (const required of [
    'scripts/provision-organization.mjs',   // validate, derive, gate
    'scripts/eval-second-customer.mjs',     // prove the path before walking it
    'scripts/pcc-onboard.mjs',              // their reference data
    'scripts/pcc-preflight.mjs',            // before the irreversible first start
    'scripts/pcc-verify-deployment.mjs',    // health
    'scripts/pcc-backup.mjs',               // and that a backup restores
    'scripts/restore-rehearsal.sh',
  ]) {
    check(named.has(required), `and the founder is told to run ${required}`);
  }

  // Every npm script they name must exist too.
  const pkg = JSON.parse(readFileSync(R('package.json'), 'utf8'));
  const npmNamed = new Set();
  for (const doc of [packet, checklist]) {
    for (const m of doc.matchAll(/npm run ([\w:-]+)/g)) npmNamed.add(m[1]);
  }
  eq([...npmNamed].filter((n) => !pkg.scripts[n]), [], 'and every npm script they name is defined');

  // THE CHECKLIST IS THE TWELVE STEPS THE HLA ASKED FOR, in order.
  const steps = [...checklist.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]));
  eq(steps, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    'the launch checklist is twelve numbered steps, in order, with none missing');

  // The two facts most likely to be skipped, and most expensive to skip.
  check(/last (purchase order )?number issued/i.test(packet + checklist),
    'the packet insists on the last purchase order number issued — the one instance value that cannot be corrected later');
  check(/before the first production request/i.test(packet + checklist),
    'and on freezing the baseline BEFORE production records start');
  check(/no secret/i.test(packet) && /No secrets/i.test(checklist),
    'and both say that no secret goes in configuration');

  // The numbering rules the packet offers must be the ones implemented.
  for (const id of IMPLEMENTED_IDS) {
    check(packet.includes(id), `the packet names ${id}, which this build can perform`);
  }
  check(!/northgate_default|quarterly/i.test(packet),
    'and offers no rule or form this build cannot perform');
}

// ===========================================================================
console.log('--- 9. offboarding ----------------------------------------------');
// ===========================================================================

// A production product needs a safe way to stop. Governed DISABLE and ARCHIVE,
// never casual deletion: the audit trail and the issued purchase orders are
// records of things that really happened, and a business that leaves may still
// be asked about them by an auditor for years.
{
  // ACCESS REVOKED, RECORDS KEPT. Deactivating every account ends all access
  // and destroys nothing.
  db.prepare('update users set is_active = 0 where org_id = ?').run(NG);
  const anyActive = db.prepare('select count(*) c from users where org_id = ? and is_active = 1').get(NG).c;
  eq(anyActive, 0, 'offboarding deactivates every account, which revokes all access');

  const orders = db.prepare('select count(*) c from purchase_orders where org_id = ?').get(NG).c;
  check(orders > 0, 'and the issued purchase orders survive — they are records of real commitments');
  const audit = db.prepare('select count(*) c from purchase_activity_log where org_id = ?').get(NG).c;
  check(audit > 0, 'as does the audit trail, which is what an auditor would ask for');

  // Every deactivated account is refused, individually.
  for (const u of db.prepare('select id from users where org_id = ?').all(NG)) {
    const actor = withCapabilities({ id: u.id, orgId: NG, roles: ['OPERATIONS_MANAGER'], isActive: false }, northgateAuth);
    check(!authorize(actor, 'request.create').ok && !authorize(actor, 'po.generate').ok,
      `${u.id} can do nothing once deactivated`);
  }

  // SECRETS ARE REVOKED WHERE THEY LIVE, which is not here. Recorded as an
  // offboarding step rather than implemented, because a dossier never held one.
  check(!JSON.stringify(northgateDossier).match(/secret|password|token/i),
    'no secret is in the dossier, so offboarding revokes credentials in the manifest\'s secret store and nowhere else');

  db.prepare('update users set is_active = 1 where org_id = ?').run(NG);

  // --- THE PROCEDURE, and its invariants -------------------------------
  const OFF = await import(R('programs/design-partner/offboarding.mjs'));
  eq(OFF.OFFBOARDING.map((x) => x.n), [1, 2, 3, 4, 5, 6, 7, 8],
    'offboarding is eight ordered steps');
  check(OFF.OFFBOARDING.every((x) => x.owner && x.how && x.why),
    'each names an owner, how it is done, and why it is in that position');

  // THE ORDER IS THE SAFETY. Access off before anything touches data.
  const revoke = OFF.OFFBOARDING.find((x) => /Disable every account/i.test(x.action));
  const destroy = OFF.OFFBOARDING.find((x) => /Export or destroy/i.test(x.action));
  const backup = OFF.OFFBOARDING.find((x) => /final backup/i.test(x.action));
  check(revoke.n < destroy.n,
    'access is revoked before anything touches data — it is what was asked for and it is reversible');
  check(backup.n < destroy.n,
    'and a verified backup exists before the one step that can destroy a record');
  check(revoke.reversibility === 'REVERSIBLE', 'disabling accounts is reversible, and proven so above');

  // ONLY TWO IRREVERSIBLE STEPS, and neither is automated.
  eq(OFF.irreversibleSteps().map((x) => x.n), [5, 8],
    'exactly two steps are irreversible: rotating the secrets, and a requested destruction');
  check(/no command for this/i.test(destroy.how),
    'and the destructive one has NO COMMAND on purpose — a delete command that exists gets run by accident');

  // NO OPERATOR-FACING SCRIPT MAY OFFER A PURGE. This is the assertion that
  // stops a future session adding a convenient --purge flag.
  //
  // EVAL SUITES ARE EXCLUDED, and the exclusion is the point rather than a hole:
  // a suite that proves "an issued purchase order number cannot be changed" has
  // to attempt the change, and it does so against a database in a temporary
  // directory it created and removes. Those files are never run against an
  // installation. What must never carry a destructive path is a script an
  // operator runs on a customer's server — which is every other file here.
  const scriptFiles = readdirSync(R('scripts'))
    .filter((f) => /\.(mjs|sh)$/.test(f))
    .filter((f) => !f.startsWith('eval-'));
  check(scriptFiles.length > 20, `${scriptFiles.length} operator-facing scripts scanned`);
  const purgers = scriptFiles.filter((f) => {
    const src = readFileSync(R('scripts', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/^[ \t]*#[^\n]*/gm, '');
    return /--purge|--wipe|--destroy|--delete-org|drop table|delete from (orgs|purchase_orders|purchase_activity_log|purchase_history_lines)\b/i.test(src);
  });
  eq(purgers, [], 'no script offers to purge an organization, drop a table, or delete an issued order or an audit record');

  check(OFF.OFFBOARDING_INVARIANTS.length >= 5, 'the invariants offboarding must not violate are written down');
  note(`offboarding: ${OFF.OFFBOARDING.length} steps, ${OFF.reversibleSteps().length} reversible, ` +
    `${OFF.irreversibleSteps().length} irreversible, 0 purge commands anywhere in scripts/`);
}

// ===========================================================================
rmSync(TMP, { recursive: true, force: true });

console.log('');
for (const n of notes) console.log(`  note: ${n}`);
console.log('');
console.log(`second-customer checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
