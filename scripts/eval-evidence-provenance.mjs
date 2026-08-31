// ---------------------------------------------------------------------------
// eval-evidence-provenance.mjs — can a database that is not production be
// mistaken for one, in either direction?
//
// THE HOLE THIS SUITE EXISTS FOR. PCC stamps `schema_meta.environment` when a
// database is created, and the case-study reader refuses anything that does not
// say "production". That closes the READER. It left the WRITER open, and the
// writer is where the loss is:
//
//   · A production backup restored onto a laptop and started with the ordinary
//     development command runs `seed()` — ten demo accounts, one of them ADMIN,
//     all on a password printed in this repository — into a file that still
//     stamps itself production. Afterwards nothing can say which rows were the
//     company's and which were the demo cast's.
//
//   · A rehearsal database started with PCC_ENVIRONMENT=production keeps its
//     rehearsal stamp, correctly and silently. The operator believes they are
//     in production; nothing they record will ever be admissible; they find out
//     when somebody asks for the first month's figures.
//
//   · A database created before PCC_ORG_ID existed has a UUID for an org id.
//     Declaring PCC_ORG_ID=lippolis afterwards changes nothing, and every
//     baseline keyed on "lippolis" matches no execution at all.
//
// The organization NAME and the organization ID are deliberately not enough on
// their own, and this suite proves it: the rehearsal is built to carry the real
// company's name and the real org id, because it must in order to rehearse
// anything. Identity therefore rests on something the installation SAID about
// itself at creation, checked on every start.
//
// FAIL CLOSED, and the direction matters. A refusal to boot is a phone call and
// it is recoverable. Test rows inside production evidence are not.
//
// Offline. No server, no network, no build. Real schema, real migrations, real
// bootstrap, temporary files.
//
//   node scripts/eval-evidence-provenance.mjs
// ---------------------------------------------------------------------------

import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps', 'purchasing', 'src', 'purchasing', 'infrastructure');

const { openDatabase } = await import(join(APP, 'sqlite/database.ts'));
const { assertDatabaseIdentity, bootstrapDatabase, declaredEnvironment, stampedEnvironment } =
  await import(join(APP, 'bootstrap.ts'));
const { environmentOf } = await import(join(ROOT, 'proof/adapters/purchasing-sqlite.mjs'));

let pass = 0;
const failures = [];
const check = (ok, name, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
};
const eq = (a, b, name) => check(a === b, name, a === b ? '' : `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
const refuses = (fn, needle, name) => {
  let message = null;
  try { fn(); } catch (e) { message = e.message; }
  if (message === null) return check(false, name, 'it was allowed');
  return check(message.toLowerCase().includes(needle.toLowerCase()), name, `refused with: ${message}`);
};

// The real company's real details, used by the rehearsal on purpose. Every
// value below is one an attacker — or an honest rehearsal — can reproduce
// exactly. None of them is identity.
const LIPPOLIS = {
  PCC_ORG_ID: 'lippolis',
  PCC_ORG_NAME: 'Lippolis Electric, Inc.',
  PCC_ORG_ADDRESS: 'Licensed Electrical Contractor · 25 Seventh Street, Pelham, NY 10803',
  PCC_ORG_PHONE: '(914) 738-3550',
  PCC_PO_NUMBERING: 'job-vendor-sequence',
};
const prod = (extra = {}) => ({ NODE_ENV: 'production', PCC_ENVIRONMENT: 'production', ...LIPPOLIS, ...extra });

let n = 0;
const path = () => join(mkdtempSync(join(tmpdir(), 'prov-')), `p${n++}.sqlite`);
/** A database created by a real first start under the given environment. */
const installed = (env) => {
  const p = path();
  const db = openDatabase(p);
  bootstrapDatabase(db, env, '2026-08-01T09:00:00Z');
  return { db, path: p };
};

// ---------------------------------------------------------------------------
console.log('--- a production install proves what it is ------------------------');
{
  const { db } = installed(prod());
  eq(stampedEnvironment(db), 'production', 'a production first start stamps the database production');
  eq(environmentOf(db), 'production', 'and the proof reader sees the same stamp');
  const org = db.prepare('select id, name from orgs limit 1').get();
  eq(org.id, 'lippolis', 'the declared org id is the one that was written');
  check(!db.prepare(`select value from schema_meta where key = 'environment_declared_at'`).get(),
    'and nothing records a late declaration, because it was stamped at creation');
  db.close();
}

// ---------------------------------------------------------------------------
console.log('--- a rehearsal is built to look exactly like production ---------');
{
  const { db: rehearsal } = installed(prod({ PCC_ENVIRONMENT: 'rehearsal' }));
  const org = rehearsal.prepare('select id, name, address, phone from orgs limit 1').get();

  // THE POINT OF THE WHOLE FILE. Every field a reader might use to tell them
  // apart is identical, because a rehearsal that changed them would not be
  // rehearsing anything.
  eq(org.id, 'lippolis', 'the rehearsal carries the real organization id');
  eq(org.name, LIPPOLIS.PCC_ORG_NAME, 'and the real organization name');
  eq(org.address, LIPPOLIS.PCC_ORG_ADDRESS, 'and the real address that prints on a purchase order');
  eq(stampedEnvironment(rehearsal), 'rehearsal', 'only the stamp differs — which is why the stamp is the identity');
  eq(environmentOf(rehearsal), 'rehearsal', 'and the proof reader reads the stamp, not the name');
  rehearsal.close();
}

// ---------------------------------------------------------------------------
console.log('--- an unstamped database is never assumed to be production ------');
{
  const db = openDatabase(path());
  eq(stampedEnvironment(db), 'unstamped', 'a database that never declared itself is unstamped');
  eq(assertDatabaseIdentity(db, { NODE_ENV: 'production' }).environment, 'unstamped',
    'and a process that says nothing about it leaves it that way');
  eq(stampedEnvironment(db), 'unstamped', 'nothing was written to make it look declared');
  db.close();
}

// ---------------------------------------------------------------------------
console.log('--- conflicting environment identity refuses to start ------------');
{
  // Every crossing of stamp and declaration that is not the same word.
  for (const [stamp, declared] of [
    ['production', 'rehearsal'],
    ['production', 'development'],
    ['rehearsal', 'production'],
    ['rehearsal', 'development'],
    ['development', 'production'],
  ]) {
    const { db } = installed(prod({ PCC_ENVIRONMENT: stamp }));
    refuses(() => assertDatabaseIdentity(db, prod({ PCC_ENVIRONMENT: declared })),
      'created as',
      `a ${stamp} database refuses to be started as ${declared}`);
    eq(stampedEnvironment(db), stamp, `  and the ${stamp} stamp is unchanged by the attempt`);
    db.close();
  }
}

// ---------------------------------------------------------------------------
console.log('--- a rehearsal cannot be promoted to production ------------------');
{
  const { db } = installed(prod({ PCC_ENVIRONMENT: 'rehearsal' }));
  let message = '';
  try { assertDatabaseIdentity(db, prod()); } catch (e) { message = e.message; }
  check(message.includes('cannot be promoted'),
    'the refusal says the database cannot be promoted, rather than only that it disagreed');
  check(message.includes('NEW database'),
    'and names the one thing that does work — installing onto a new database');
  db.close();
}

// ---------------------------------------------------------------------------
console.log('--- a production database refuses a process that will not say so --');
{
  // THE RESTORE-ONTO-A-LAPTOP PATH. `bootstrapDatabase` branches on NODE_ENV,
  // and the development branch runs seed(). Without the identity check the
  // demo cast lands in a production-stamped file.
  const { db, path: p } = installed(prod());
  db.close();

  const copy = path();
  copyFileSync(p, copy);
  const restored = openDatabase(copy);

  refuses(() => bootstrapDatabase(restored, { NODE_ENV: 'development' }, '2026-08-02T09:00:00Z'),
    'did not declare PCC_ENVIRONMENT',
    'a restored production database refuses an ordinary development start');

  const demo = restored.prepare('select count(*) as n from orgs').get();
  eq(demo.n, 1, 'and the demo organization was never inserted beside the real one');
  const users = restored.prepare('select count(*) as n from users').get();
  eq(users.n, 0, 'and no demo user was created');

  refuses(() => bootstrapDatabase(restored, { NODE_ENV: 'development', PCC_ENVIRONMENT: 'development' }, '2026-08-02T09:00:00Z'),
    'created as "production"',
    'and refuses one that declares itself development outright');

  // The only start it accepts is the one that admits what the file is.
  const ok = bootstrapDatabase(restored, prod(), '2026-08-02T09:00:00Z');
  eq(ok.created, false, 'a restored production database starts as production and creates nothing');
  eq(ok.orgId, 'lippolis', 'and reports the organization it already had');
  restored.close();
}

// ---------------------------------------------------------------------------
console.log('--- a copied database is still the environment it was made in ----');
{
  const { db, path: p } = installed(prod({ PCC_ENVIRONMENT: 'rehearsal' }));
  db.close();
  const copy = path();
  copyFileSync(p, copy);
  const copied = openDatabase(copy);
  eq(environmentOf(copied), 'rehearsal',
    'copying a rehearsal database to a production path does not make it production');
  refuses(() => assertDatabaseIdentity(copied, prod()), 'created as',
    'and starting the copy as production refuses');
  copied.close();
}

// ---------------------------------------------------------------------------
console.log('--- the organization id is permanent -----------------------------');
{
  const { db } = installed(prod());
  refuses(() => assertDatabaseIdentity(db, prod({ PCC_ORG_ID: 'lippolis_electric' })),
    'is permanent',
    'a start that declares a different org id than the database holds refuses');
  eq(db.prepare('select id from orgs limit 1').get().id, 'lippolis',
    'and the org id in the database is untouched');
  db.close();
}
{
  // The installation that already exists: created before an id could be
  // declared, so it holds a UUID. Declaring the slug afterwards is exactly the
  // mistake that makes every baseline match nothing, and it is caught.
  const { db } = installed({ NODE_ENV: 'production', PCC_ENVIRONMENT: 'production',
    PCC_ORG_NAME: LIPPOLIS.PCC_ORG_NAME, PCC_ORG_ADDRESS: LIPPOLIS.PCC_ORG_ADDRESS,
    PCC_ORG_PHONE: LIPPOLIS.PCC_ORG_PHONE });
  const minted = db.prepare('select id from orgs limit 1').get().id;
  check(/^[0-9a-f-]{36}$/.test(minted), 'an installation that declares no id still mints a UUID');
  let message = '';
  try { assertDatabaseIdentity(db, prod()); } catch (e) { message = e.message; }
  check(message.includes(minted),
    'and a later PCC_ORG_ID=lippolis refuses, naming the id the baselines must actually use');
  db.close();
}

// ---------------------------------------------------------------------------
console.log('--- a stamp missing from an old database may be declared once ----');
{
  // The one permitted transition. Nobody ever said what this database was, so
  // the first process to say is believed — and the fact that it said so AFTER
  // creation is recorded, because a stamp adopted later is weaker evidence than
  // one written at creation and a reader is entitled to tell them apart.
  const { db } = installed({ NODE_ENV: 'production', ...LIPPOLIS });
  eq(stampedEnvironment(db), 'unstamped', 'an install that declared nothing is unstamped');

  assertDatabaseIdentity(db, prod(), '2026-08-03T09:00:00Z');
  eq(stampedEnvironment(db), 'production', 'a later start may declare it for the first time');
  eq(db.prepare(`select value from schema_meta where key = 'environment_declared_at'`).get()?.value,
    '2026-08-03T09:00:00Z',
    'and the moment it was declared is recorded, because it was not stamped at creation');

  refuses(() => assertDatabaseIdentity(db, prod({ PCC_ENVIRONMENT: 'rehearsal' })), 'created as',
    'and having declared itself once, it never changes its mind');
  db.close();
}

// ---------------------------------------------------------------------------
console.log('--- a value nobody defined is refused, not guessed ----------------');
{
  refuses(() => declaredEnvironment({ PCC_ENVIRONMENT: 'prod' }), 'must be one of',
    'PCC_ENVIRONMENT=prod is refused rather than interpreted as production');
  refuses(() => declaredEnvironment({ PCC_ENVIRONMENT: 'staging' }), 'must be one of',
    'and so is a word this system has no meaning for');
  eq(declaredEnvironment({ PCC_ENVIRONMENT: '  PRODUCTION  ' }), 'production',
    'case and surrounding space are tolerated — an environment file is typed by a person');
  eq(declaredEnvironment({}), null, 'and saying nothing is null, not a default');

  // NODE_ENV IS NOT EVIDENCE. The rehearsal sets NODE_ENV=production too,
  // because it has to in order to run the production build.
  const { db } = installed(prod({ PCC_ENVIRONMENT: 'rehearsal' }));
  eq(stampedEnvironment(db), 'rehearsal',
    'NODE_ENV=production does not make a rehearsal database production');
  db.close();

  const source = readFileSync(join(APP, 'bootstrap.ts'), 'utf8');
  const inferred = /NODE_ENV[^\n]*(production)[^\n]*environment/i.test(source);
  check(!inferred, 'and no line derives the evidence stamp from NODE_ENV');
}

// ---------------------------------------------------------------------------
console.log('--- the reader refuses what the writer let through ----------------');
{
  const cs = readFileSync(join(ROOT, 'scripts/proof-case-study.mjs'), 'utf8');
  check(cs.includes("environment !== 'production'"),
    'the case-study command refuses a database not declared production');
  check(cs.includes('allowNonproduction'), 'and reading one anyway takes an explicit flag');
  check(cs.includes('NOT EVIDENCE'), 'and labels the output when that flag is used');
}

console.log('');
console.log(`evidence provenance: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
