// ---------------------------------------------------------------------------
// pcc-verify-production.mjs — is this database fit for a real pilot?
//
// check-deployable.mjs asks whether the IMAGE is safe to ship. This asks the
// other half: whether the DATABASE the image is about to open is the company's
// own, or somebody's demonstration.
//
// WHY IT IS WORTH A SCRIPT. Every mechanism that keeps demo data out of
// production is a rule about how the database was CREATED — bootstrap.ts
// refuses to seed the pilot cast when NODE_ENV is production, the image
// contains no database, the volume is mounted rather than baked. None of that
// helps if a database created on a laptop is copied to the server, which is
// exactly what somebody does at five o'clock on the day of a pilot. This looks
// at the rows.
//
// It also reports the configuration that must be set from real company
// information and CANNOT be guessed. Purchase order numbers are job + vendor +
// a count that starts at 1 for that pair, so there is no single starting number
// to supply — but a pair the office has ALREADY written paper purchase orders
// for would start again at 1 here and collide with the office's book, and that
// cannot be undone: a number, once on a vendor's invoice, is spent.
//
//   node scripts/pcc-verify-production.mjs [--db PATH] [--strict]
//
//   --db      the database. Default: $PCC_DATABASE_PATH, then
//             $PURCHASING_DB_PATH, then the development file.
//   --strict  treat every warning as a failure. Use this in the go/no-go
//             check on the morning of the pilot.
//
// Exit 0 when the database is clean and configured, 1 when it is not. Every
// finding names what to do about it, because a check that only says "no" sends
// somebody back to a developer.
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// The same derivation the application uses, so this cannot disagree with it.
import { normalizeVendorCode } from '../apps/purchasing/src/purchasing/domain/po-number.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const STRICT = process.argv.includes('--strict');

const dbPath =
  arg('db') ??
  process.env.PCC_DATABASE_PATH ??
  process.env.PURCHASING_DB_PATH ??
  join(ROOT, 'apps', 'purchasing', '.data', 'purchasing.db');

if (!existsSync(dbPath)) {
  console.error(`pcc-verify-production: no database at ${dbPath}`);
  console.error('Set --db or PCC_DATABASE_PATH to the database you are about to put in front of people.');
  process.exit(1);
}

const problems = [];
const warnings = [];
const notes = [];
const fail = (what, fix) => problems.push({ what, fix });
const warn = (what, fix) => warnings.push({ what, fix });

const db = new DatabaseSync(dbPath, { readOnly: true });
const count = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n ?? 0);
const rows = (sql, ...args) => db.prepare(sql).all(...args);

// ---------------------------------------------------------------------------
// 1. DEMO PEOPLE. The pilot seed creates ten accounts with a password that is
//    written in this repository. bootstrap.ts refuses to create them in
//    production; a database COPIED from a laptop already has them.
// ---------------------------------------------------------------------------
const demoUsers = rows(
  `select u.full_name, u.email, (select count(*) from auth_identities a where a.user_id = u.id and a.disabled = 0) as enabled
     from users u where lower(u.email) like '%@example.invalid'`,
);
if (demoUsers.length) {
  const live = demoUsers.filter((u) => u.enabled > 0);
  fail(
    `${demoUsers.length} demonstration account(s) exist (${demoUsers.slice(0, 3).map((u) => u.email).join(', ')}${demoUsers.length > 3 ? ', …' : ''})` +
      (live.length ? ` — ${live.length} can still sign in with the published pilot password` : ''),
    'This database was created in development. Start a fresh production database (see the production pilot checklist), or disable every @example.invalid account and change its password before anybody uses this.',
  );
}

// ---------------------------------------------------------------------------
// 2. DEMO REFERENCE DATA. Invented vendors, jobs and locations. Harmless in
//    themselves; corrosive in a pilot, because Mike has to work out which of
//    his suppliers are real before he can order anything.
// ---------------------------------------------------------------------------
// SEEDED DATA IS RECOGNISED BY ITS FIXTURE MARKER, NOT BY ITS NAME.
//
// This used to match vendors against a list of names — 'Graybar Electric',
// 'City Electric Supply'. Those are the fixture's names because they are REAL
// suppliers Lippolis buys from, so the check failed the go/no-go on a correctly
// configured production database and told Jose to delete his own vendor
// directory. A check that cries wolf on the right answer is worse than no
// check: the next real finding gets waved through with it.
//
// The honest marker is the contact address. Every seeded vendor carries an
// @example.invalid ordering contact, which exists precisely so a misconfigured
// mail client has nowhere to deliver; a vendor somebody typed in has a real
// one. Vendors with no contact at all are not evidence of anything either way.
const demoVendors = rows(
  `select distinct v.name from vendors v
     join vendor_contacts c on c.vendor_id = v.id
    where lower(c.email) like '%@example.invalid'`,
);
if (demoVendors.length) {
  fail(
    `${demoVendors.length} seeded demonstration vendor(s): ${demoVendors.map((v) => v.name).join(', ')}`,
    'These carry @example.invalid ordering contacts, so they came from the development fixture rather than from the office. Remove them, or start from a fresh production database and enter the real suppliers in Administration → Vendors.',
  );
}

// Jobs live in `purchase_jobs` — the directory the application actually reads
// and writes. `jobs` is the older seed-only table, still consulted as a
// fallback, so both are checked. Checking only `jobs` reported "no active jobs"
// on every real installation, because nothing has written that table since the
// directory screens were built.
const demoJobNumbers = ['24-118', '24-203', '25-007'];
const placeholders = demoJobNumbers.map(() => '?').join(',');
const demoJobs = [
  ...rows(`select job_number from purchase_jobs where job_number in (${placeholders})`, ...demoJobNumbers),
  ...rows(`select job_number from jobs where job_number in (${placeholders})`, ...demoJobNumbers),
];
if (demoJobs.length) {
  const names = [...new Set(demoJobs.map((j) => j.job_number))];
  fail(
    `${names.length} seeded demonstration job(s): ${names.join(', ')}`,
    'Remove them, or start fresh and enter the real job numbers in Administration → Jobs.',
  );
}

const demoEmail = count("select count(*) as n from vendor_contacts where lower(email) like '%@example.invalid'");
if (demoEmail) {
  fail(
    `${demoEmail} vendor contact(s) carry @example.invalid addresses`,
    'These exist so a misconfigured mail client has nowhere to deliver. Replace them with the real ordering contacts before anybody drafts a vendor email.',
  );
}

// ---------------------------------------------------------------------------
// 3. DEMO TRAFFIC. Requests and purchase orders raised while proving the
//    thing works. A pilot that opens on somebody else's twelve requests is a
//    pilot Mike does not trust on the first morning.
// ---------------------------------------------------------------------------
const requestCount = count('select count(*) as n from purchase_requests');
const orderCount = count('select count(*) as n from purchase_orders');
if (requestCount > 0 || orderCount > 0) {
  warn(
    `the database already holds ${requestCount} request(s) and ${orderCount} purchase order(s)`,
    'If this is a fresh pilot, it should hold none. If you are migrating a running pilot, this is expected — say so deliberately rather than discovering it.',
  );
}

// ---------------------------------------------------------------------------
// 4. PURCHASE ORDER NUMBERING. What still needs a human answer, and what
//    no longer does.
//
// A number is job + vendor + a sequence that counts from 1 for that pair. There
// is no company-wide starting number to supply and nothing to configure, so the
// old "the sequence is still the placeholder" failure is gone with the thing it
// guarded.
//
// What remains is narrower and cannot be answered from inside the database:
// for a job and vendor the office has ALREADY written purchase orders for by
// hand, PCC counting from 1 would issue a number the vendor already holds.
// That is declared per pair in Administration, and this reports which pairs
// have been declared and which have not — a warning, not a failure, because
// only the office knows which pairs have paper behind them.
// ---------------------------------------------------------------------------
const uncoded = rows("select name from vendors where is_active = 1 and (code is null or trim(code) = '')");
if (uncoded.length) {
  fail(
    `${uncoded.length} active vendor(s) have no purchase order code: ${uncoded.map((v) => v.name).join(', ')}`,
    'A purchase order number is built from the vendor code, so an order to one of these would be refused. Open Administration → Vendors and give each one a code.',
  );
}

const duplicateCodes = rows(
  "select upper(code) as code, count(*) as n from vendors where code is not null and trim(code) <> '' group by upper(code) having count(*) > 1",
);
for (const dup of duplicateCodes) {
  fail(
    `two or more vendors share the purchase order code ${dup.code}`,
    'A purchase order number would not say which vendor it went to. Give one of them a different code in Administration → Vendors before any order is raised.',
  );
}

// CODES NOBODY HAS CHOSEN. A code identical to the one PCC derives from the
// name has never been looked at by the office — GRAYBARELECTRIC rather than the
// GRAYBAR they actually write. Both are valid identifiers and neither is wrong;
// the point is that the office should see them before they are printed on a
// supplier's paperwork, because after the first order they are fixed.
//
// Detected by re-deriving rather than by a flag: a flag would record that
// somebody opened the screen, and this records that they changed their mind or
// deliberately kept it.
const derivedCodes = rows("select name, code from vendors where is_active = 1 and code is not null and trim(code) <> '' ")
  .filter((v) => String(v.code).toUpperCase() === normalizeVendorCode(v.name));
if (derivedCodes.length) {
  warn(
    `${derivedCodes.length} vendor code(s) are still exactly as PCC derived them from the name: ` +
      derivedCodes.map((v) => `${v.name} → ${v.code}`).join(', '),
    'ACTION: show these to Mike or Paul and ask whether the office writes them differently (GRAYBAR rather than GRAYBARELECTRIC). Change them in Administration → Vendors → Edit → PO code. They can be changed freely until that vendor receives its first purchase order, and NOT afterwards — the code is part of every number it carries.',
  );
}

// THE FOUR STATES A (JOB, VENDOR) PAIR CAN BE IN, kept apart on purpose. The
// dangerous one is not "no sequence set" — it is "nobody has been asked", and
// those look identical from inside the database unless the answer is recorded.
//
//   IN USE      PCC has issued numbers for it. Settled by evidence.
//   CONTINUED   an administrator declared where the office's paper sequence
//               had reached. Settled by a person.
//   NEW         an administrator declared it has no paper history. Settled by a
//               person, and the reason `declarePoPairNewAction` exists: without
//               it, "checked, and it is new" is unrecordable.
//   OPEN        neither. PCC would start it at 1, which is right if the office
//               has never written one by hand and wrong in a way that cannot be
//               undone if it has.
const pairs = rows(
  `select s.job_number, s.next_value, s.initialized_at, s.vendor_id,
          v.name as vendor_name, v.code as vendor_code,
          (select count(*) from purchase_orders o
            where o.org_id = s.org_id and o.job_number = s.job_number and o.vendor_id = s.vendor_id) as issued
     from po_job_vendor_sequences s join vendors v on v.id = s.vendor_id
    order by s.job_number, v.name`,
);

const label = (p) => `job ${p.job_number} with ${p.vendor_name} → next ${p.job_number}-${p.vendor_code}-${p.next_value}`;
const inUse      = pairs.filter((p) => Number(p.issued) > 0);
const continued  = pairs.filter((p) => Number(p.issued) === 0 && p.initialized_at && Number(p.next_value) > 1);
const declared   = pairs.filter((p) => Number(p.issued) === 0 && p.initialized_at && Number(p.next_value) === 1);
const openPairs  = pairs.filter((p) => Number(p.issued) === 0 && !p.initialized_at);

notes.push('purchase order numbering: job-vendor-sequence, counting from 1 for each job-and-vendor pair');
notes.push(`  ${inUse.length} pair(s) in use · ${continued.length} continued from paper · ${declared.length} confirmed new · ${openPairs.length} unresolved`);
for (const p of inUse)     notes.push(`  IN USE     ${label(p)} (${p.issued} issued by PCC)`);
for (const p of continued) notes.push(`  CONTINUED  ${label(p)} (from the office paper sequence)`);
for (const p of declared)  notes.push(`  NEW        ${label(p)} (office confirmed: no paper history)`);

// A pair with a counter but no declaration and no orders. Reachable when a
// sequence row was created and every order against it was later rolled back.
if (openPairs.length) {
  warn(
    `${openPairs.length} job-and-vendor pair(s) have a counter but no recorded decision: ${openPairs.map(label).join('; ')}`,
    'ACTION: for each, ask the office whether it already has purchase orders written on paper. If it does — Administration → PO numbering → set the pair to the next number. If it does not — Administration → PO numbering → "Confirm as new". Do not leave it unanswered: PCC will issue 1.',
  );
}

// THE REAL GO-LIVE QUESTION, and the one nobody can answer from the data: an
// active job PCC has never numbered anything on, and nobody has been asked
// about. Reported per JOB rather than per possible pair — the pairs a job will
// use are not knowable in advance, and listing every job × vendor combination
// would be noise that trains an operator to skip this section.
//
// A job that is settled on ANY vendor is treated as asked-about: whoever
// answered for one vendor was looking at that job's paper file.
const settledJobs = new Set(pairs.filter((p) => Number(p.issued) > 0 || p.initialized_at).map((p) => String(p.job_number)));
const unaskedJobs = rows('select job_number, name from jobs where is_active = 1 order by job_number')
  .filter((j) => !settledJobs.has(String(j.job_number)));

if (unaskedJobs.length) {
  warn(
    `${unaskedJobs.length} active job(s) have no purchase order history recorded either way: ${unaskedJobs.map((j) => j.job_number).join(', ')}`,
    'ACTION: before the first PCC order on each of these jobs, ask Mike or Paul whether the office has already written purchase orders on paper for it. If yes — Administration → PO numbering → set the pair to the next number for each vendor involved. If no — "Confirm as new" for the vendors it will use. This is not a defect: it is the one numbering fact PCC cannot derive, and a job nobody has been asked about is indistinguishable from a job with no history.',
  );
}

// Not a warning: a pair or a job that appears AFTER go-live is ordinary
// business, and blocking on it would train people to ignore this check.
if (!openPairs.length && !unaskedJobs.length) {
  notes.push('  every active job has its purchase order history recorded, either by use or by an explicit decision');
}

// A pair whose counter has fallen at or below a number it has already issued
// would hand out that number a second time.
for (const p of rows(
  `select s.job_number, s.next_value, v.name as vendor_name,
          (select max(o.sequence_value) from purchase_orders o
            where o.org_id = s.org_id and o.job_number = s.job_number and o.vendor_id = s.vendor_id) as highest
     from po_job_vendor_sequences s join vendors v on v.id = s.vendor_id`,
)) {
  if (p.highest !== null && p.highest !== undefined && Number(p.highest) >= Number(p.next_value)) {
    fail(
      `job ${p.job_number} with ${p.vendor_name} has already issued sequence ${p.highest}, at or above its next value ${p.next_value}`,
      'The next allocation would duplicate an issued number. Set that pair forward past its highest issued value in Administration → PO numbering.',
    );
  }
}

// ---------------------------------------------------------------------------
// 5. THE PLACES AND PEOPLE A PILOT CANNOT RUN WITHOUT.
// ---------------------------------------------------------------------------
const org = rows('select name, address, phone from orgs')[0];
if (!org) {
  fail('no organization exists', 'The database is not initialized.');
} else {
  notes.push(`organization: ${org.name}`);
  if (!org.address || !org.phone) {
    warn(
      'the organization has no address or telephone number on file',
      'Both print on the purchase order that goes to the supplier. Set them in the seed configuration (PCC_ORG_ADDRESS, PCC_ORG_PHONE) or in the database.',
    );
  }
}

const workshop = count("select count(*) as n from delivery_locations where kind = 'WORKSHOP' and is_active = 1");
if (!workshop) {
  fail(
    'there is no active WORKSHOP delivery location',
    'The workshop is a first-class destination and receiving authority is granted by assignment to it. Without one, "it came to the shop" cannot be recorded.',
  );
}

// Both tables, for the same reason as above: the directory screens write
// `purchase_jobs`, and reading only the legacy table reported an empty job
// directory on a fully configured system.
const activeJobs =
  count("select count(*) as n from purchase_jobs where coalesce(status, 'ACTIVE') = 'ACTIVE'")
  + count('select count(*) as n from jobs where is_active = 1');
if (!activeJobs) {
  warn('no active jobs are on file', 'A requester types a job number freely, but the directory is what puts the job NAME and ADDRESS on the printed purchase order.');
}

const activeVendors = count('select count(*) as n from vendors where is_active = 1');
if (!activeVendors) {
  fail('no active vendors are on file', 'Purchasing cannot approve a line without a vendor. Enter the real suppliers in Administration → Vendors.');
}

const approvers = count('select count(*) as n from users where can_approve = 1 and is_active = 1');
if (!approvers) {
  fail('nobody holds approval authority', 'At least Mike, and preferably Rick as backup, must be able to approve. Administration → Users.');
}

const receivers = count(
  `select count(*) as n from user_job_assignments a join users u on u.id = a.user_id
    where u.is_active = 1 and a.job_number = 'WORKSHOP'`,
);
if (!receivers) {
  warn(
    'nobody is assigned to WORKSHOP, so nobody is designated to sign for deliveries at the shop counter',
    'Purchasing staff can receive anywhere, so this is not fatal — but if a specific person owns the counter, assign them. Administration → Users → job assignments.',
  );
}

const signIn = count('select count(*) as n from auth_identities where disabled = 0');
if (!signIn) {
  fail('no enabled sign-in credentials exist — nobody can sign in', 'Set PCC_BOOTSTRAP_ADMIN_EMAIL and PCC_BOOTSTRAP_ADMIN_PASSWORD and restart once, then invite the real users.');
}

db.close();

// ---------------------------------------------------------------------------
console.log(`pcc-verify-production: ${dbPath}`);
for (const note of notes) console.log(`  · ${note}`);
console.log('');

if (problems.length) {
  console.log(`NOT READY — ${problems.length} problem(s):\n`);
  for (const p of problems) console.log(`  ✗ ${p.what}\n    → ${p.fix}\n`);
}
if (warnings.length) {
  console.log(`${warnings.length} warning(s):\n`);
  for (const w of warnings) console.log(`  ! ${w.what}\n    → ${w.fix}\n`);
}
if (!problems.length && !warnings.length) {
  console.log('READY — no demonstration data, and every setting a pilot needs is configured.');
}

const failed = problems.length > 0 || (STRICT && warnings.length > 0);
if (!failed && problems.length === 0 && warnings.length) {
  console.log('No blocking problems. Re-run with --strict to treat the warnings above as blocking.');
}
process.exit(failed ? 1 : 0);
