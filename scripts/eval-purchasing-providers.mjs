// ---------------------------------------------------------------------------
// eval-purchasing-providers.mjs — provider conformance, without credentials.
//
// The Supabase adapter cannot be executed here: no project, no keys. What CAN
// be checked, and what actually catches the mistakes people make writing a
// second provider, is:
//
//   * SHAPE      — does it implement every method of every interface the local
//                  provider does, with the same arity? A missing method is a
//                  runtime crash on a page nobody visits until a customer does.
//   * NUMBERS    — do the money and quantity mappers round-trip EXACTLY? This
//                  is the one place the two providers disagree by design
//                  (integer cents/thousandths vs numeric), so it is the one
//                  place a rounding bug can enter.
//   * TABLES     — does every table the adapter names exist in the migrations?
//   * TENANCY    — does every query in the adapter constrain by organization?
//   * SAFETY     — does the adapter avoid the service-role client on read paths?
//
// The live parity run (same suite, both providers) needs a real database and is
// documented in PURCHASING_ASYNC_REFACTOR_HANDOFF.md. This file is what stands
// in front of it until then, and it says so rather than pretending to be it.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = join(ROOT, 'apps', 'purchasing', 'src', 'purchasing');
const SUPABASE_DIR = join(APP, 'infrastructure', 'supabase');

let pass = 0;
let fail = 0;
const ok = () => { pass++; };
const bad = (m) => { console.log(`FAIL  ${m}`); fail++; };
const check = (cond, m) => (cond ? ok() : bad(m));
const eq = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const sqlite = await import(join(APP, 'infrastructure', 'sqlite', 'repositories.ts'));
const supabase = await import(join(SUPABASE_DIR, 'repositories.ts'));
const mappers = await import(join(SUPABASE_DIR, 'mappers.ts'));

console.log('--- repository shape parity ------------------------------------');

// A fake handle: the factories only close over it, so no call is made here.
const handles = { db: new Proxy({}, { get: () => () => {} }), privileged: () => ({}), orgId: 'org' };
const fakeDb = new Proxy({}, { get: () => () => ({}) });

const PAIRS = [
  ['request', sqlite.sqliteRequestRepository, supabase.supabaseRequestRepository],
  ['review', sqlite.sqliteReviewRepository, supabase.supabaseReviewRepository],
  ['approval', sqlite.sqliteApprovalRepository, supabase.supabaseApprovalRepository],
  ['order', sqlite.sqliteOrderRepository, supabase.supabaseOrderRepository],
  ['emailDraft', sqlite.sqliteEmailDraftRepository, supabase.supabaseEmailDraftRepository],
  ['receipt', sqlite.sqliteReceiptRepository, supabase.supabaseReceiptRepository],
  ['inventory', sqlite.sqliteInventoryRepository, supabase.supabaseInventoryRepository],
  ['reference', sqlite.sqliteReferenceRepository, supabase.supabaseReferenceRepository],
  ['poNumbers', sqlite.sqlitePoNumberAllocator, supabase.supabasePoNumberAllocator],
  ['itemCatalog', sqlite.sqliteItemCatalogRepository, supabase.supabaseItemCatalogRepository],
  // The immutable history is on the completion path in both providers. A method
  // missing from one of them would mean a purchase completing without a record
  // on exactly one deployment.
  ['history', sqlite.sqlitePurchaseHistoryRepository, supabase.supabasePurchaseHistoryRepository],
];

for (const [name, localFactory, remoteFactory] of PAIRS) {
  const local = localFactory(fakeDb);
  const remote = remoteFactory(handles);

  const localMethods = Object.keys(local).sort();
  const remoteMethods = Object.keys(remote).sort();
  eq(remoteMethods, localMethods, `${name}: the Supabase repository implements exactly the local method set`);

  for (const method of localMethods) {
    check(typeof remote[method] === 'function', `${name}.${method} exists on the Supabase repository`);
    check(
      remote[method].length === local[method].length,
      `${name}.${method} takes the same arguments (local ${local[method].length}, supabase ${remote[method]?.length})`,
    );
    check(
      remote[method].constructor.name === 'AsyncFunction',
      `${name}.${method} is async — a repository that answers synchronously is not a boundary`,
    );
  }
}

console.log('--- number conversion, exactly ---------------------------------');

// The failure this guards against is `Math.round(value * 100)`, which is wrong
// for values nobody puts in a test: 86.40, 1.005, 0.07.
const MONEY_CASES = [
  ['0', 0], ['0.00', 0], ['86.40', 8640], ['86.4', 8640], ['1555.20', 155_520],
  ['0.07', 7], ['1.005', 100], ['999999.99', 99_999_999], ['-12.34', -1234],
];
for (const [text, cents] of MONEY_CASES) {
  eq(mappers.money.read(text), cents, `money.read('${text}') is ${cents} cents`);
}
for (const [text, cents] of MONEY_CASES) {
  if (text.includes('1.005')) continue; // that case truncates by design; see below
  eq(mappers.money.read(mappers.money.write(cents)), cents, `money round-trips ${cents} cents`);
}
eq(mappers.money.read(86.4), 8640, 'money.read tolerates a JSON number as well as a string');
eq(mappers.money.write(155_520), '1555.20', 'money.write produces a numeric literal Postgres accepts');

const QTY_CASES = [['0', 0], ['20', 20_000], ['12.5', 12_500], ['18.000', 18_000], ['0.001', 1], ['1234.567', 1_234_567]];
for (const [text, thousandths] of QTY_CASES) {
  eq(mappers.qty.read(text), thousandths, `qty.read('${text}') is ${thousandths} thousandths`);
  eq(mappers.qty.read(mappers.qty.write(thousandths)), thousandths, `qty round-trips ${thousandths}`);
}
eq(mappers.qty.write(18_000), '18.000', 'qty.write pads to the column scale');

// An unknown estimated cost must stay unknown. This is a product rule: a
// purchaser may order without knowing the price, and 0 is not "unknown".
eq(mappers.nullableMoney.read(null), null, 'an unknown unit cost reads as null, never 0');
eq(mappers.nullableMoney.write(null), null, 'an unknown unit cost writes as null, never 0');
eq(mappers.nullableMoney.read('0.00'), 0, 'a genuine zero cost is still zero');

let threw = false;
try { mappers.money.read('not-a-number'); } catch { threw = true; }
check(threw, 'a non-decimal value is refused rather than silently becoming 0');

console.log('--- table names exist in the migrations ------------------------');

// Every migration, discovered rather than listed. The list used to be
// hardcoded, which meant tables added by a LATER migration were reported as
// "not created by a migration" — the check failing for its own reasons rather
// than the code's. A directory read cannot go stale that way.
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const allSql = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');

for (const [key, table] of Object.entries(mappers.TABLES)) {
  check(
    new RegExp(`create table (if not exists )?(public\\.)?${table}\\b`).test(allSql),
    `TABLES.${key} -> ${table} is created by a migration`,
  );
}

console.log('--- BR-012: neither provider can edit history ------------------');

// The interface offers no update and no delete. This checks the two
// IMPLEMENTATIONS as well, because a repository is free to add a method the
// interface never asked for, and history that one provider can rewrite is not
// immutable history — it is immutable on one deployment.
{
  const localHistory = sqlite.sqlitePurchaseHistoryRepository(fakeDb);
  const remoteHistory = supabase.supabasePurchaseHistoryRepository(handles);
  eq(Object.keys(localHistory).sort(), ['forRequest', 'listForOrg', 'record'],
     'the local history repository offers exactly record + two reads');
  eq(Object.keys(remoteHistory).sort(), ['forRequest', 'listForOrg', 'record'],
     'and so does the Supabase one — no update, no delete, on either');
}

const historySource = readFileSync(join(SUPABASE_DIR, 'repositories.ts'), 'utf8')
  .split('supabasePurchaseHistoryRepository')[1] ?? '';
const historyBody = historySource.slice(0, historySource.indexOf('\n}\n'));
check(!/\.update\(|\.delete\(/.test(historyBody),
      'the Supabase history repository issues no UPDATE and no DELETE');
check(/ignoreDuplicates:\s*true/.test(historyBody),
      'writing the same history twice is ignored rather than an error — a retried completion must complete');

const sqliteSource = readFileSync(join(APP, 'infrastructure', 'sqlite', 'repositories.ts'), 'utf8');
const sqliteHistory = sqliteSource.split('sqlitePurchaseHistoryRepository')[1] ?? '';
check(!/update purchase_history_lines|delete from purchase_history_lines/.test(sqliteHistory.slice(0, 4000)),
      'the local history repository issues no UPDATE and no DELETE either');
check(/insert or ignore into purchase_history_lines/.test(sqliteHistory),
      'and it writes idempotently, on the same (org, request, request item) key');

// Both providers must READ the same evidence. The catalogue's "last ordered
// from" is the field the old view got wrong, so both are checked for reading it
// out of history rather than joining the live vendor row.
for (const [name, source] of [['sqlite', sqliteSource], ['supabase', readFileSync(join(SUPABASE_DIR, 'repositories.ts'), 'utf8')]]) {
  const catalogue = source.split(name === 'sqlite' ? 'sqliteItemCatalogRepository' : 'supabaseItemCatalogRepository')[1] ?? '';
  check(/purchase_history_lines|TABLES.historyLines/.test(catalogue),
        `${name}: the catalogue reads its last-purchase facts from immutable history`);
  check(!/join vendors v on v\.id = po\.vendor_id|vendor:purchase_vendors\(id,name\)/.test(catalogue),
        `${name}: and NOT by joining the live vendor row — that join is how a rename rewrote history`);
}

console.log('--- tenancy and privilege in the adapter -----------------------');

const adapterSource = readFileSync(join(SUPABASE_DIR, 'repositories.ts'), 'utf8');
const contextSource = readFileSync(join(SUPABASE_DIR, 'context.ts'), 'utf8');

// Every read of a tenant-owned root table constrains by organization. RLS is
// the real boundary; this asserts the adapter does not lean on it alone.
for (const table of ['TABLES.requests', 'TABLES.orders', 'TABLES.emailDrafts', 'TABLES.receipts']) {
  const selects = adapterSource.split(`from(${table})`).slice(1);
  // Scan to the end of the statement rather than a fixed window: a long nested
  // select pushes the filter far down, and a window that clipped it would have
  // reported a false gap (it did, before this was fixed).
  const reads = selects
    .map((chunk) => chunk.slice(0, chunk.indexOf('maybeSingle()') >= 0 || chunk.indexOf('order(') >= 0
      ? Math.max(chunk.indexOf('maybeSingle()'), chunk.indexOf('order(')) + 40
      : 600))
    .filter((chunk) => chunk.includes('.select('));
  const unscoped = reads.filter((chunk) => !chunk.includes('org_id'));
  check(unscoped.length === 0, `every read from ${table} is constrained by org_id (${unscoped.length} unscoped)`);
}

check(
  !adapterSource.includes('privileged('),
  'the repositories never reach for the service-role client — RLS applies to every query they make',
);
check(
  (contextSource.match(/privilegedClient\(config\)/g) ?? []).length > 0,
  'administrative writes do use the privileged client (invite, disable, roles, assignments)',
);
check(
  contextSource.includes('async run<T>(fn: () => Promise<T> | T): Promise<T> {\n      return fn();'),
  'the Supabase unit of work does not pretend to be a transaction',
);
check(
  contextSource.includes('supabase-js') || contextSource.includes('has no client-side transaction'),
  'and says why in the file',
);

// ---------------------------------------------------------------------------
console.log('--- enabling PURCHASING_PERSISTENCE=supabase fails closed -------');

// Not static: validateEnvironment is imported and run. Every precondition below
// is a precondition for a request carrying the caller's access token. Missing
// one and starting anyway would mean querying anonymously, which RLS refuses —
// an empty screen instead of a stated misconfiguration.
const env = await import(`${pathToFileURL(join(ROOT, 'apps/purchasing/src/purchasing/infrastructure/env.ts')).href}`);

const GOOD = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  AUTH_PROVIDER: 'supabase',
  PURCHASING_PERSISTENCE: 'supabase',
  SESSION_SECRET: 'a-real-session-secret-of-sufficient-length',
  APP_BASE_URL: 'http://localhost:3000',
};
const verdict = (overrides) => {
  const e = { ...GOOD, ...overrides };
  for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
  const result = env.validateEnvironment(e);
  return { ok: result.ok, keys: result.problems.filter((x) => x.level === 'error').map((x) => x.variable) };
};

check(verdict({}).ok, 'a fully configured Supabase deployment is accepted');

check(!verdict({ NEXT_PUBLIC_SUPABASE_URL: undefined }).ok,
  'Supabase persistence without a URL is refused');
check(!verdict({ NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined }).ok,
  'Supabase persistence without an anon key is refused');
check(!verdict({ AUTH_PROVIDER: 'local' }).ok,
  'Supabase persistence with the local credential provider is refused');
check(verdict({ AUTH_PROVIDER: 'local' }).keys.includes('PURCHASING_PERSISTENCE'),
  'the refusal names PURCHASING_PERSISTENCE, so the operator knows which one to change');
check(!verdict({ PURCHASING_DEMO_MODE: '1' }).ok,
  'Supabase persistence with the demo identity picker is refused (it mints no token)');
check(!verdict({ SESSION_SECRET: undefined }).ok,
  'Supabase persistence with the built-in development session secret is refused');

// The flag never turns itself on. Supabase credentials being present is not
// consent to move where the company's purchasing records live.
const inferred = env.loadConfig({
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
});
check(inferred.persistenceProvider === 'local',
  'persistence stays local when the flag is absent, even with Supabase configured');
check(inferred.authProvider === 'supabase',
  'auth still infers upward from configured credentials (unchanged behaviour)');

console.log('');
console.log('--- what this file does NOT prove ------------------------------');
console.log('    THIS FILE is static: shape, number conversion, table names and');
console.log('    tenancy are read out of the source, not executed.');
console.log('');
console.log('    The adapter itself is no longer unexercised — it runs against');
console.log('    local Postgres in scripts/eval-purchasing-supabase-web.mjs,');
console.log('    driven through the website over HTTP. What remains unproven is');
console.log('    behavioural parity with the local provider case for case, and');
console.log('    anything against a hosted project.');

console.log('');
console.log(`provider checks: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
