// ---------------------------------------------------------------------------
// db.ts — the pilot data plane: a real database, on the machine running the app.
//
// WHY SQLITE AND NOT SUPABASE, FOR THE PILOT
// The purchasing module ships two persistence paths against ONE data model:
//
//   * supabase/migrations/0016_purchasing_control.sql — the production path.
//     Tenant-scoped rows, RLS policies, security-definer RPCs, transition
//     triggers, next_po_number() under a row lock. Same tables, same names,
//     same constraints as below. This is where Lippolis actually runs.
//
//   * this file — the pilot path. `node:sqlite` (built into Node 24, zero
//     dependencies) so the app runs on a laptop or the workshop PC with no
//     credentials, no Docker and no network, and STILL gets: real transactions,
//     real foreign keys, real unique constraints, a real PO sequence that two
//     concurrent approvals cannot both win, and a real server boundary that the
//     browser cannot reach around.
//
// The schema below is written to be the same schema. scripts/lib/
// validate-migration-0016.mjs asserts the table and column names here and in
// the SQL migration stay in lockstep, so the pilot cannot quietly drift into a
// second data model.
//
// Money: INTEGER cents. Quantity: INTEGER thousandths. No floats, ever
// (Postgres side uses numeric(12,2) / numeric(14,3) — same values, same exactness).
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveDatabaseLocation, type LocationProbe } from './database-location.ts';
import { assignVendorCode } from '../../domain/po-number.mjs';

const DEFAULT_PATH = join(process.cwd(), '.data', 'purchasing.db');

let instance: DatabaseSync | null = null;

const REAL_FILESYSTEM: LocationProbe = {
  fileExists: (path) => existsSync(path),
  directoryExists: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  // File OR directory: `.git` is a directory in an ordinary clone and a file in
  // a worktree, and a worktree is still a checkout.
  pathExists: (path) => existsSync(path),
};

/**
 * Where the records are, decided by database-location.ts. Exported so the
 * startup preflight can ask the same question the application will ask, and
 * fail before the server is listening rather than on the first page load.
 */
export function databaseLocation(env: NodeJS.ProcessEnv = process.env) {
  return resolveDatabaseLocation(env, REAL_FILESYSTEM, DEFAULT_PATH);
}

/**
 * ROWS MUST BE PLAIN OBJECTS.
 *
 * `node:sqlite` returns each row with a NULL PROTOTYPE. That is a sensible
 * choice for a database driver — a column called `constructor` cannot collide
 * with anything — and it is fatal one layer up: React refuses to serialize a
 * null-prototype object across the server/client boundary, with
 *
 *   Only plain objects, and a few built-ins, can be passed to Client
 *   Components from Server Components. Classes or null prototypes are not
 *   supported.
 *
 * So every screen that hands rows to a client component threw a 500 as soon as
 * there was a row to hand it. `/admin?module=vendors` worked on an empty
 * installation and broke the moment somebody added their first vendor — which
 * is to say it worked in every test and would have broken on Mike's first
 * afternoon. It went unseen because the development server runs on the
 * Supabase provider, whose rows arrive as JSON.
 *
 * Fixed HERE, once, rather than at each of the several dozen call sites: a
 * repository that has to remember to reshape its rows is a repository that
 * will forget. The wrapper is applied to every connection this module opens,
 * so the test harness and the server cannot differ.
 */
function withPlainRows(db: DatabaseSync): DatabaseSync {
  const plain = (row: unknown) =>
    row && typeof row === 'object' ? { ...(row as Record<string, unknown>) } : row;
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql);
    const get = statement.get.bind(statement);
    const all = statement.all.bind(statement);
    (statement as unknown as { get: unknown }).get = (...args: unknown[]) => plain(get(...(args as [])));
    (statement as unknown as { all: unknown }).all = (...args: unknown[]) =>
      (all(...(args as [])) as unknown[]).map(plain);
    return statement;
  };
  return db;
}

export function getDb(): DatabaseSync {
  if (instance) return instance;
  const decision = databaseLocation();
  if (!decision.ok) {
    // Loud, and naming the variable to change. A misconfigured path is the one
    // failure that otherwise looks like success.
    throw new Error(`purchasing database: ${decision.variable} — ${decision.message}`);
  }
  const path = decision.path;
  if (decision.createDirectory && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = WAL');
  db.exec('pragma foreign_keys = ON');
  db.exec('pragma busy_timeout = 5000');
  migrate(db);
  instance = withPlainRows(db);
  return instance;
}

/** Test hook: run against a throwaway database. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL matters here too: the concurrency gate in the harness opens this same
  // file from several workers at once.
  if (path !== ':memory:') db.exec('pragma journal_mode = WAL');
  db.exec('pragma foreign_keys = ON');
  db.exec('pragma busy_timeout = 5000');
  migrate(db);
  return withPlainRows(db);
}

export function resetInstance() {
  instance = null;
}

// NOTE: there is deliberately no exported `inTransaction(db, fn)` helper.
// A synchronous wrapper around now-asynchronous repository calls commits before
// the work inside resolves — it looks like a transaction and is not one. The
// only transaction boundary is UnitOfWork.run (see composition.ts), which is
// async, nested-safe and serialized.

const SCHEMA = `
-- --- tenancy + people ------------------------------------------------------

create table if not exists orgs (
  id          text primary key,
  name        text not null,
  phone       text,
  address     text,
  created_at  text not null,
  updated_at  text not null
);

create table if not exists users (
  id            text primary key,
  org_id        text not null references orgs(id),
  full_name     text not null,
  email         text not null,
  phone         text,
  is_active     integer not null default 1 check (is_active in (0,1)),
  -- Explicit approval GRANT, separate from role: an office employee may be
  -- given approval authority without being handed the workshop role.
  can_approve   integer not null default 0 check (can_approve in (0,1)),
  -- Mike is primary, Rick is backup. Backup is not a lesser authority; it is
  -- who the queue nags first.
  is_primary_approver integer not null default 0 check (is_primary_approver in (0,1)),
  is_backup_approver  integer not null default 0 check (is_backup_approver in (0,1)),
  created_at    text not null,
  updated_at    text not null,
  created_by    text references users(id),
  updated_by    text references users(id),
  unique (org_id, email)
);

create table if not exists roles (
  key         text primary key,
  label       text not null,
  description text not null
);

create table if not exists user_roles (
  user_id     text not null references users(id),
  role_key    text not null references roles(key),
  granted_at  text not null,
  granted_by  text references users(id),
  primary key (user_id, role_key)
);

-- --- reference data --------------------------------------------------------

create table if not exists vendors (
  id          text primary key,
  org_id      text not null references orgs(id),
  name        text not null,
  -- THE VENDOR AS IT APPEARS IN A PURCHASE ORDER NUMBER (1234-COOPER-1).
  -- Derived from the name once and then frozen: the display name may be
  -- corrected, merged or re-spelled without renumbering anything already
  -- issued. Unique per organization — see the index built after migration,
  -- which is where it lives so an existing database can be upgraded into it.
  code        text,
  account_number text,
  phone       text,
  address     text,
  notes       text,
  is_active   integer not null default 1 check (is_active in (0,1)),
  created_at  text not null,
  updated_at  text not null,
  created_by  text references users(id),
  updated_by  text references users(id),
  unique (org_id, name)
);

create table if not exists vendor_contacts (
  id          text primary key,
  vendor_id   text not null references vendors(id),
  name        text not null,
  email       text not null,
  phone       text,
  is_primary  integer not null default 0 check (is_primary in (0,1)),
  created_at  text not null,
  updated_at  text not null
);

create table if not exists delivery_locations (
  id          text primary key,
  org_id      text not null references orgs(id),
  name        text not null,
  address     text,
  kind        text not null check (kind in ('JOBSITE','WORKSHOP','OFFICE','VENDOR_PICKUP')),
  is_active   integer not null default 1 check (is_active in (0,1)),
  created_at  text not null,
  updated_at  text not null,
  unique (org_id, name)
);

create table if not exists jobs (
  id          text primary key,
  org_id      text not null references orgs(id),
  job_number  text not null,
  name        text not null,
  address     text,
  is_active   integer not null default 1 check (is_active in (0,1)),
  created_at  text not null,
  unique (org_id, job_number)
);

-- --- requests --------------------------------------------------------------

create table if not exists purchase_requests (
  id                   text primary key,
  org_id               text not null references orgs(id),
  request_number       text not null,
  -- One request, one job. Enforced here AND in validateRequestDraft().
  job_number           text not null,
  requestor_id         text not null references users(id),
  status               text not null,
  need_by_date         text not null,
  need_by_time         text not null,
  delivery_location_id text not null references delivery_locations(id),
  delivery_method      text not null check (delivery_method in ('DELIVERY','PICKUP')),
  reason               text,
  notes                text,
  submitted_at         text,
  approver_id          text references users(id),
  decided_at           text,
  decision_notes       text,
  rejection_reason     text,
  clarification_question text,
  clarification_answer   text,
  vendor_id            text references vendors(id),
  estimated_total_cents integer not null default 0,
  expected_arrival_date text,
  tracking_number      text,
  tracking_carrier     text,
  ordered_at           text,
  received_at          text,
  completed_at         text,
  cancelled_at         text,
  cancel_reason        text,
  -- Optimistic-concurrency token: every write bumps it, every update checks it.
  version              integer not null default 1,
  created_at           text not null,
  updated_at           text not null,
  created_by           text not null references users(id),
  updated_by           text references users(id),
  unique (org_id, request_number)
);

create index if not exists purchase_requests_org_status_idx on purchase_requests(org_id, status);
create index if not exists purchase_requests_requestor_idx on purchase_requests(org_id, requestor_id);
create index if not exists purchase_requests_job_idx on purchase_requests(org_id, job_number);

-- The requestor's words. NEVER overwritten by a purchasing decision: everything
-- Mike or Rick enters lives on purchase_review_items, one row per line.
create table if not exists purchase_request_items (
  id            text primary key,
  request_id    text not null references purchase_requests(id),
  line_no       integer not null,
  description   text not null,
  requested_qty integer not null check (requested_qty > 0),  -- thousandths
  unit          text not null,
  stock_number  text,
  notes         text,
  created_at    text not null,
  updated_at    text not null,
  created_by    text not null references users(id),
  unique (request_id, line_no)
);

create table if not exists purchase_request_attachments (
  id           text primary key,
  request_id   text not null references purchase_requests(id),
  filename     text not null,
  content_type text,
  byte_size    integer,
  -- Pilot stores small files inline; the Supabase path uses Storage and keeps
  -- the object path here instead.
  data_base64  text,
  storage_path text,
  caption      text,
  created_at   text not null,
  created_by   text not null references users(id)
);

-- --- workshop review -------------------------------------------------------

create table if not exists purchase_reviews (
  id            text primary key,
  request_id    text not null references purchase_requests(id),
  reviewer_id   text not null references users(id),
  workshop_notes text,
  started_at    text not null,
  saved_at      text,
  created_at    text not null,
  updated_at    text not null,
  unique (request_id)
);

-- Purchasing values, one row per requested line. Six quantities live here and
-- none of them may overwrite another (§4).
create table if not exists purchase_review_items (
  id                      text primary key,
  review_id               text not null references purchase_reviews(id),
  request_item_id         text not null references purchase_request_items(id),
  usable_stock_qty        integer not null default 0,
  approved_qty            integer not null default 0,
  suggested_order_qty     integer not null default 0,
  final_order_qty         integer not null default 0,
  stock_applied_qty       integer not null default 0,
  replenishment_qty       integer not null default 0,
  vendor_id               text references vendors(id),
  estimated_unit_cost_cents integer,
  estimated_line_total_cents integer not null default 0,
  substitute_description  text,
  expected_arrival_date   text,
  line_notes              text,
  -- Set when the human overrode the calculated suggestion, with their reason.
  override_reason         text,
  created_at              text not null,
  updated_at              text not null,
  updated_by              text references users(id),
  unique (review_id, request_item_id),
  check (usable_stock_qty >= 0),
  check (approved_qty >= 0),
  check (suggested_order_qty >= 0),
  check (final_order_qty >= 0),
  check (estimated_unit_cost_cents is null or estimated_unit_cost_cents >= 0)
);

create table if not exists purchase_approvals (
  id            text primary key,
  request_id    text not null references purchase_requests(id),
  approver_id   text not null references users(id),
  decision      text not null check (decision in ('APPROVED','REJECTED','CLARIFICATION_REQUESTED')),
  decided_at    text not null,
  notes         text,
  reason        text,
  -- What the approver changed relative to the original request, frozen at the
  -- moment of decision. The approval refers to THESE numbers.
  changes_json  text not null default '[]',
  -- BR-011: approval authority is a capability, so an approver MAY decide a
  -- request they raised. That is recorded, not refused — this column is how the
  -- audit trail says the requester and the approver were the same person.
  self_approved integer not null default 0 check (self_approved in (0,1)),
  created_at    text not null,
  -- A rejection or a clarification must say why.
  check (decision = 'APPROVED' or (reason is not null and length(reason) > 0))
);

create index if not exists purchase_approvals_request_idx on purchase_approvals(request_id);

-- --- purchase orders -------------------------------------------------------

-- LEGACY. Kept so an installation that ran the placeholder scheme still has the
-- record of what it was set to; NOTHING allocates from it. The Lippolis rule is
-- one sequence per (job, vendor) pair — see po_job_vendor_sequences below.
create table if not exists po_number_sequences (
  org_id      text primary key references orgs(id),
  prefix      text not null default 'LE-',
  padding     integer not null default 5 check (padding between 1 and 12),
  suffix      text not null default '',
  next_value  integer not null check (next_value > 0),
  updated_at  text not null,
  updated_by  text references users(id)
);

-- THE PURCHASE ORDER SEQUENCE, as Lippolis actually numbers.
--
-- One counter per (organization, job, vendor). Job 1234 with Cooper counts
-- 1, 2, 3; job 1234 with Graybar starts again at 1; job 5678 with Cooper starts
-- again at 1. The primary key IS the scope, so the database cannot be persuaded
-- to keep two counters for one pair.
--
-- job_number here is the NORMALIZED segment (domain/po-number.mjs), which is
-- what appears in the number — so "24-118" and "24-118 " share one counter
-- rather than issuing two purchase orders called the same thing.
--
-- initialized_at is set only when an administrator declared where the pair's
-- paper sequence had already reached. NULL means PCC started this pair at 1
-- because PCC has issued nothing for it.
create table if not exists po_job_vendor_sequences (
  org_id          text not null references orgs(id),
  job_number      text not null,
  vendor_id       text not null references vendors(id),
  vendor_code     text not null,
  next_value      integer not null check (next_value > 0),
  initialized_at  text,
  initialized_by  text references users(id),
  created_at      text not null,
  updated_at      text not null,
  primary key (org_id, job_number, vendor_id)
);

-- A pair's counter may only move FORWARD. Winding one back would re-issue a
-- number a vendor already has on an invoice.
create trigger if not exists po_job_vendor_sequences_forward_only
before update on po_job_vendor_sequences
for each row when new.next_value < old.next_value
begin
  select raise(abort, 'a PO sequence can only move forward; issued numbers are permanent');
end;

create table if not exists request_number_sequences (
  org_id      text primary key references orgs(id),
  prefix      text not null default 'PR-',
  padding     integer not null default 5,
  suffix      text not null default '',
  next_value  integer not null check (next_value > 0),
  updated_at  text not null
);

create table if not exists purchase_orders (
  id                text primary key,
  org_id            text not null references orgs(id),
  request_id        text not null references purchase_requests(id),
  -- Permanent. There is no update path that changes it (guarded in service.ts
  -- and by a trigger on the Postgres side).
  po_number         text not null,
  -- The sequence WITHIN this order's (job, vendor) pair — 1, 2, 3 — not a
  -- company-wide counter. It is therefore NOT unique on its own, and the
  -- uniqueness that matters is the composite one below.
  sequence_value    integer not null,
  vendor_id         text not null references vendors(id),
  -- The vendor code AS AT ISSUANCE. Snapshot, not a join: renaming the vendor,
  -- or an administrator changing its code, must never alter a number a supplier
  -- already has.
  vendor_code       text,
  vendor_contact_id text references vendor_contacts(id),
  job_number        text not null,
  approver_id       text not null references users(id),
  delivery_location_id text not null references delivery_locations(id),
  delivery_method   text not null,
  need_by_date      text not null,
  need_by_time      text not null,
  estimated_total_cents integer not null default 0,
  notes             text,
  status            text not null default 'ISSUED',
  generated_at      text not null,
  generated_by      text not null references users(id),
  created_at        text not null,
  updated_at        text not null,
  unique (org_id, po_number),
  -- The sequence is unique WITHIN its pair. A single organization-wide
  -- uniqueness on the sequence value used to stand here, and was correct only
  -- while one counter served the whole company; under the real rule it would
  -- refuse 1234-GRAYBAR-1 because 1234-COOPER-1 exists.
  unique (org_id, job_number, vendor_id, sequence_value),
  -- One live PO per request in this milestone (multi-PO splits are §21 future).
  unique (request_id)
);

-- THE PURCHASE ORDER NUMBER IS PERMANENT. Not "should not change" — cannot.
--
-- Postgres has enforced this since 0016 (guard_po_number_permanent). The pilot
-- store did not, and the pilot store is what runs at Lippolis: the comment on
-- the column above claimed a guard in the service layer that was never written.
-- Nothing in the application updates these columns today, which is precisely
-- why the absence was invisible — the fence is for the change nobody has made
-- yet, on the identifier a supplier already holds.
--
-- The three components are frozen with the number they produced, so a purchase
-- order stays explainable even after the vendor is renamed or recoded and the
-- job's description changes.
create trigger if not exists purchase_orders_number_permanent
  before update of po_number, sequence_value, vendor_code, job_number, vendor_id, request_id
  on purchase_orders
  when new.po_number is not old.po_number
    or new.sequence_value is not old.sequence_value
    -- FILLING THE HOLE IS NOT CHANGING THE VALUE. Orders raised before this
    -- column existed carry NULL, and the migration records the vendor's code
    -- against them. The old-is-not-null test allows that one transition
    -- and nothing else: once a code is on the row it is frozen, and setting it
    -- back to NULL is itself a change and is refused.
    or (old.vendor_code is not null and new.vendor_code is not old.vendor_code)
    or new.job_number is not old.job_number
    or new.vendor_id is not old.vendor_id
    or new.request_id is not old.request_id
  begin
    select raise(ABORT, 'the purchase order number is permanent: job, vendor and sequence are fixed at issuance');
  end;

-- And it cannot be withdrawn by deletion either. A cancelled order keeps its
-- number: the vendor was told it, and a number that disappears is a number that
-- can be issued twice.
create trigger if not exists purchase_orders_no_delete
  before delete on purchase_orders
  begin
    select raise(ABORT, 'a purchase order cannot be deleted; its number has already been issued');
  end;

create table if not exists purchase_order_items (
  id                text primary key,
  purchase_order_id text not null references purchase_orders(id),
  line_no           integer not null,
  request_item_id   text not null references purchase_request_items(id),
  description       text not null,
  substitute_description text,
  order_qty         integer not null check (order_qty > 0),
  unit              text not null,
  unit_cost_cents   integer not null default 0,
  line_total_cents  integer not null default 0,
  expected_arrival_date text,
  created_at        text not null,
  unique (purchase_order_id, line_no)
);

create table if not exists purchase_order_documents (
  id                text primary key,
  purchase_order_id text not null references purchase_orders(id),
  kind              text not null check (kind in ('PDF','HTML')),
  filename          text not null,
  content_type      text not null,
  byte_size         integer not null,
  data_base64       text not null,
  sha256            text not null,
  generated_at      text not null,
  generated_by      text not null references users(id),
  template_key      text not null
);

-- --- email drafts ----------------------------------------------------------

create table if not exists email_templates (
  id          text primary key,
  org_id      text not null references orgs(id),
  template_key text not null,
  subject     text not null,
  body        text not null,
  is_active   integer not null default 1 check (is_active in (0,1)),
  updated_at  text not null,
  updated_by  text references users(id),
  unique (org_id, template_key)
);

create table if not exists purchase_email_drafts (
  id                text primary key,
  org_id            text not null references orgs(id),
  request_id        text not null references purchase_requests(id),
  purchase_order_id text references purchase_orders(id),
  template_key      text not null,
  status            text not null,
  subject           text not null,
  body              text not null,
  to_addrs          text not null default '[]',
  cc_addrs          text not null default '[]',
  attachments       text not null default '[]',
  -- Idempotency: composing the same message twice is a unique violation, not a
  -- second draft (0015's draft_key idiom).
  draft_key         text not null,
  generated_at      text not null,
  generated_by      text not null references users(id),
  reviewed_at       text,
  reviewed_by       text references users(id),
  approved_to_send_at text,
  approved_to_send_by text references users(id),
  sent_at           text,
  sent_marked_by    text references users(id),
  cancelled_at      text,
  failure_reason    text,
  -- Proof, in the row itself, that no transport was involved.
  external_send_enabled integer not null default 0 check (external_send_enabled = 0),
  created_at        text not null,
  updated_at        text not null,
  unique (org_id, draft_key),
  check (sent_at is null or reviewed_at is not null)
);

create index if not exists purchase_email_drafts_request_idx on purchase_email_drafts(request_id);

-- --- receiving -------------------------------------------------------------

create table if not exists purchase_receipts (
  id                text primary key,
  org_id            text not null references orgs(id),
  request_id        text not null references purchase_requests(id),
  purchase_order_id text references purchase_orders(id),
  received_date     text not null,
  received_by       text not null references users(id),
  packing_slip_number text,
  notes             text,
  is_final          integer not null default 0 check (is_final in (0,1)),
  created_at        text not null
);

create table if not exists purchase_receipt_items (
  id                text primary key,
  receipt_id        text not null references purchase_receipts(id),
  purchase_order_item_id text not null references purchase_order_items(id),
  received_qty      integer not null default 0 check (received_qty >= 0),
  damaged_qty       integer not null default 0 check (damaged_qty >= 0),
  backordered_qty   integer not null default 0 check (backordered_qty >= 0),
  written_off_qty   integer not null default 0 check (written_off_qty >= 0),
  -- Set when a human deliberately accepted more than was ordered.
  over_receipt_override integer not null default 0 check (over_receipt_override in (0,1)),
  override_reason   text,
  notes             text,
  created_at        text not null,
  check (over_receipt_override = 0 or (override_reason is not null and length(override_reason) > 0))
);

create table if not exists purchase_receipt_attachments (
  id           text primary key,
  receipt_id   text not null references purchase_receipts(id),
  filename     text not null,
  content_type text,
  byte_size    integer,
  data_base64  text,
  caption      text,
  created_at   text not null,
  created_by   text not null references users(id)
);

-- --- inventory (observation-grade, not a warehouse system) ------------------

create table if not exists inventory_observations (
  id             text primary key,
  org_id         text not null references orgs(id),
  request_id     text references purchase_requests(id),
  request_item_id text references purchase_request_items(id),
  item_description text not null,
  observed_qty   integer not null check (observed_qty >= 0),
  unit           text not null,
  observed_at    text not null,
  observed_by    text not null references users(id),
  notes          text,
  created_at     text not null
);

create table if not exists inventory_adjustments (
  id             text primary key,
  org_id         text not null references orgs(id),
  request_id     text references purchase_requests(id),
  request_item_id text references purchase_request_items(id),
  item_description text not null,
  -- Signed: negative = consumed by the job, positive = received into stock.
  delta_qty      integer not null,
  unit           text not null,
  reason         text not null check (reason in ('STOCK_APPLIED','RECEIVED','REPLENISHMENT','CORRECTION','DAMAGE')),
  adjusted_at    text not null,
  adjusted_by    text not null references users(id),
  notes          text,
  created_at     text not null
);

-- --- audit + notifications + settings --------------------------------------

create table if not exists purchase_activity_log (
  id              text primary key,
  org_id          text not null references orgs(id),
  -- Correlation id: every row touching one request carries the request id, so
  -- the timeline is one indexed read.
  request_id      text references purchase_requests(id),
  actor_id        text references users(id),
  actor_name      text,
  action          text not null,
  entity_type     text not null,
  entity_id       text,
  previous_values text,
  new_values      text,
  notes           text,
  at              text not null,
  seq             integer not null
);

create index if not exists purchase_activity_request_idx on purchase_activity_log(request_id, at, seq);
create index if not exists purchase_activity_org_idx on purchase_activity_log(org_id, at);

create table if not exists purchase_notifications (
  id           text primary key,
  org_id       text not null references orgs(id),
  request_id   text references purchase_requests(id),
  event        text not null,
  recipient_id text references users(id),
  payload      text not null default '{}',
  created_at   text not null,
  read_at      text
);

create index if not exists purchase_notifications_recipient_idx
  on purchase_notifications(recipient_id, read_at);

create table if not exists system_settings (
  org_id                 text primary key references orgs(id),
  allow_self_approval    integer not null default 0 check (allow_self_approval in (0,1)),
  external_send_enabled  integer not null default 0 check (external_send_enabled = 0),
  require_email_review   integer not null default 1 check (require_email_review = 1),
  overdue_grace_hours    integer not null default 0,
  default_delivery_method text not null default 'DELIVERY',
  po_template_key        text not null default 'awe_default',
  -- HOW SOON THIS ORGANIZATION EXPECTS MATERIAL, and what time of day it wants
  -- it. Both were assumptions rather than values: the need-by time defaulted to
  -- Lippolis's 07:00 in the form component, and the fulfilment expectation was
  -- described in the organization profile and read by nothing at all.
  --
  -- NULL fulfilment days means NO DEFAULT DATE, which is what the form has
  -- always done. So an existing installation behaves identically until somebody
  -- states the policy, and a second organization states its own.
  default_fulfilment_days integer,
  default_need_by_time   text not null default '07:00',
  updated_at             text not null,
  updated_by             text references users(id)
);

-- --- authentication (a PROVIDER table, not a purchasing domain table) -------
--
-- Credentials live here and nowhere else. purchase_* tables reference a user
-- id and never a password, exactly as they will when Supabase Auth owns
-- credentials — at which point this table simply stops being written to.

create table if not exists auth_identities (
  user_id          text primary key references users(id),
  email            text not null unique,
  -- scrypt(N=16384,r=8,p=1) with a per-identity salt. Never a plaintext
  -- password, never a reversible encryption.
  password_hash    text not null,
  salt             text not null,
  disabled         integer not null default 0 check (disabled in (0,1)),
  -- A password somebody ELSE chose. Set whenever an administrator (or the
  -- break-glass command, or the first-start bootstrap) writes a credential, and
  -- cleared only when the person themself replaces it. While it is 1 the holder
  -- may sign in and may do nothing else — see routeDecision in workspaces.mjs.
  --
  -- It belongs on the identity rather than on the user because it is a fact
  -- about the CREDENTIAL: the same person authenticating through a different
  -- provider has a different answer, and Supabase Auth owns its own.
  must_change_password integer not null default 0 check (must_change_password in (0,1)),
  reset_token      text unique,
  reset_expires_at text,
  last_sign_in_at  text,
  created_at       text not null,
  updated_at       text not null
);

-- Which job sites a foreman signs for. A delivery confirmation is scoped to
-- these rows; without one, the request is not theirs to receive.
create table if not exists user_job_assignments (
  user_id     text not null references users(id),
  job_number  text not null,
  assigned_at text not null,
  assigned_by text references users(id),
  primary key (user_id, job_number)
);

create index if not exists user_job_assignments_job_idx on user_job_assignments(job_number);

-- --- history, catalog and the job directory (mirrors migration 0018) -------
--
-- Line items carry org_id directly so an organization's purchasing history is
-- queryable — and isolated — without joining up to the parent every time. The
-- future features (autocomplete, ranking, reorder, analytics) all read across
-- history; the tenant boundary has to be on the row.

create table if not exists purchase_item_catalog (
  id                     text primary key,
  org_id                 text not null references orgs(id),
  -- Computed by domain/catalog.mjs so both providers agree byte for byte.
  normalized_description text not null,
  canonical_description  text not null,
  default_unit           text,
  default_vendor_id      text references vendors(id),
  catalog_number         text,
  notes                  text,
  is_active              integer not null default 1 check (is_active in (0,1)),
  normalizer_version     integer not null default 1,
  first_seen_at          text not null,
  last_seen_at           text not null,
  created_at             text not null,
  updated_at             text not null,
  created_by             text references users(id),
  -- Two organizations that buy the same item have two entries, and neither can
  -- see the other's. The org in the key is what keeps vocabularies apart.
  unique (org_id, normalized_description)
);

create index if not exists purchase_item_catalog_org_idx
  on purchase_item_catalog(org_id, last_seen_at desc);

create table if not exists purchase_jobs (
  id                    text primary key,
  org_id                text not null references orgs(id),
  job_number            text not null,
  name                  text not null,
  customer              text,
  site_address          text,
  status                text not null default 'ACTIVE'
    check (status in ('ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
  project_manager_id    text references users(id),
  primary_foreman_id    text references users(id),
  delivery_instructions text,
  default_location_id   text references delivery_locations(id),
  cost_code             text,
  project_phase         text,
  starts_on             text,
  ends_on               text,
  created_at            text not null,
  updated_at            text not null,
  created_by            text references users(id),
  updated_by            text references users(id),
  unique (org_id, job_number)
);

create index if not exists purchase_jobs_org_status_idx on purchase_jobs(org_id, status);

-- --- immutable purchasing history (mirrors migration 0030) -----------------
--
-- What a purchase LOOKED LIKE when it ended. Written once, at the terminal
-- transition, by application/history.ts; never updated, never deleted.
--
-- It replaces the purchase_line_history VIEW, which resolved vendor and
-- description at READ time and therefore rewrote itself whenever an entity was
-- renamed. Every *_name, *_number and *_description column here is a SNAPSHOT
-- taken at the moment the request ended, kept BESIDE the id: the id stays
-- joinable to current data, the snapshot stays true about what happened.
--
-- The triggers below are the pilot's version of the production RLS shape:
-- production has an INSERT policy and no UPDATE or DELETE policy at all, plus
-- guard_no_delete(). SQLite has no policies, so the same guarantee is written
-- as triggers that refuse the statement.

create table if not exists purchase_history_lines (
  id                        text primary key,
  org_id                    text not null references orgs(id),

  terminal_state            text not null
    check (terminal_state in ('COMPLETED','CANCELLED','REJECTED')),
  terminal_reason           text,
  recorded_at               text not null,
  recorded_by               text not null references users(id),

  request_id                text not null references purchase_requests(id),
  request_number            text not null,
  request_item_id           text not null references purchase_request_items(id),
  line_no                   integer not null,
  purchase_order_id         text references purchase_orders(id),
  po_number                 text,
  purchase_order_item_id    text references purchase_order_items(id),
  job_id                    text references purchase_jobs(id),
  job_number                text not null,
  catalog_item_id           text references purchase_item_catalog(id),

  normalized_description    text not null,
  normalizer_version        integer not null,
  requested_description     text not null,
  ordered_description       text,
  unit                      text not null,
  requested_qty             integer not null,
  ordered_qty               integer not null,

  vendor_id                 text references vendors(id),
  vendor_name               text,
  vendor_part_number        text,

  estimated_unit_cost_cents  integer,
  estimated_line_total_cents integer,
  actual_unit_cost_cents     integer,
  actual_line_total_cents    integer,

  requestor_id              text not null references users(id),
  requestor_name            text,
  approver_id               text references users(id),
  approver_name             text,

  requested_at              text,
  po_generated_at           text,
  ordered_at                text,
  received_at               text,
  completed_at              text,

  received_qty              integer not null default 0,
  damaged_qty               integer not null default 0,
  backordered_qty           integer not null default 0,
  written_off_qty           integer not null default 0,
  outcome                   text not null,

  -- One row per request line, forever. This is also what makes the write
  -- idempotent: a retried completion inserts nothing the second time.
  unique (org_id, request_id, request_item_id)
);

create index if not exists purchase_history_lines_org_idx
  on purchase_history_lines(org_id, ordered_at desc);
create index if not exists purchase_history_lines_material_idx
  on purchase_history_lines(org_id, normalized_description);
create index if not exists purchase_history_lines_vendor_idx
  on purchase_history_lines(org_id, vendor_id);

-- BR-012, enforced rather than intended: a history row cannot be edited or
-- removed. A correction is a new request, exactly as a miscounted receipt is a
-- new receipt.
create trigger if not exists purchase_history_lines_no_update
  before update on purchase_history_lines
  begin
    select raise(ABORT, 'purchasing history is immutable: a correction is a new request, never an edit');
  end;

create trigger if not exists purchase_history_lines_no_delete
  before delete on purchase_history_lines
  begin
    select raise(ABORT, 'purchasing history is append-only and cannot be deleted');
  end;

create table if not exists schema_meta (
  key   text primary key,
  value text not null
);
`;

/**
 * Columns added after the first cut. SQLite has no `add column if not exists`,
 * so each one is attempted and a duplicate-column error is the expected
 * outcome on an already-migrated database.
 */
const ADDED_COLUMNS = [
  // The organization's fulfilment expectation and its need-by time of day.
  // Previously an assumption in a form component (07:00) and a profile field
  // nothing read (fulfilment days). See the note in `system_settings`.
  'alter table system_settings add column default_fulfilment_days integer',
  "alter table system_settings add column default_need_by_time text not null default '07:00'",

  // 0018: tenant ownership directly on historical line items, so an
  // organization's history is one indexed read and cannot be joined across.
  'alter table purchase_request_items add column org_id text references orgs(id)',
  'alter table purchase_order_items add column org_id text references orgs(id)',
  'alter table purchase_receipt_items add column org_id text references orgs(id)',
  'alter table purchase_review_items add column org_id text references orgs(id)',
  // 0018: what it matched on, kept beside what the person typed. Both are
  // preserved; neither is derived from the other at read time.
  'alter table purchase_request_items add column normalized_description text',
  'alter table purchase_request_items add column catalog_item_id text references purchase_item_catalog(id)',
  'alter table purchase_order_items add column normalized_description text',
  'alter table purchase_order_items add column catalog_item_id text references purchase_item_catalog(id)',
  // 0018: actual cost beside estimated. NULL means unknown, not zero — a
  // purchaser may order without knowing the price.
  'alter table purchase_order_items add column actual_unit_cost_cents integer',
  'alter table purchase_order_items add column actual_line_total_cents integer',
  'alter table purchase_orders add column actual_total_cents integer',
  'alter table purchase_orders add column actual_cost_source text',
  // 0018: a job assignment says what kind of relationship it is.
  "alter table user_job_assignments add column assignment_kind text not null default 'FOREMAN'",
  // Set once Supabase Auth has authenticated this person: the link between the
  // credential provider's user and ours.
  "alter table users add column auth_user_id text",
  // A designated receiver may confirm deliveries for their assigned jobs.
  "alter table users add column is_delivery_receiver integer not null default 0",
  // WHEN THE OFFICE SET ITS OWN PURCHASE ORDER SEQUENCE.
  //
  // Written when the placeholder global sequence was still the numbering
  // scheme. Retained because it is a record of an act somebody performed; the
  // column no longer gates anything (see 0038 and the note on
  // po_number_sequences above).
  'alter table po_number_sequences add column initialized_at text',
  // 0038: the vendor's identifier inside a purchase order number, and the
  // snapshot of it taken when the order was issued.
  'alter table vendors add column code text',
  'alter table purchase_orders add column vendor_code text',
  // BR-011's audit stamp: the approver held the capability AND raised the
  // request. It records a fact, it does not gate one.
  //
  // MISSED WHEN IT WAS INTRODUCED. It went into SCHEMA and nowhere else, and
  // `create table if not exists` does not add a column to a table that already
  // exists — so every database created before it simply did not have it, and
  // every approval on one of those failed with "table purchase_approvals has no
  // column named self_approved". Approval is the middle of the workflow, so the
  // effect was a system that could take a request and never turn it into a
  // purchase order. Invisible to the suite, which builds each database from
  // SCHEMA and therefore always has the column.
  "alter table purchase_approvals add column self_approved integer not null default 0",
  // 0040: WHICH SINGLE ACT WROTE THIS ROW.
  //
  // The audit trail records domain events, and one thing a person does writes
  // several of them: submitting a request writes `request.submitted` four
  // times, and receiving writes a receipt and closes the request. Counting rows
  // therefore over-states human work by roughly 2.8x, and the measurement layer
  // was reduced to inferring interactions from timestamp proximity — which
  // works for a person using a browser and fails for anything faster. An
  // automated client drove a complete purchase in 271 milliseconds, and the
  // heuristic folded eleven interactions into six. That error runs in the
  // direction that FLATTERS us: fewer interactions means less human time means
  // more hours returned.
  //
  // So one identifier per purchasing context — which is built once per HTTP
  // request, and therefore once per thing a person did. Exact where the
  // heuristic was approximate, and it makes a replay indistinguishable from
  // what it is rather than indistinguishable from a fast human.
  //
  // NULLABLE, because rows written before this column exist and are not being
  // rewritten. The measurement layer falls back to the timing heuristic for
  // them and records that it did.
  'alter table purchase_activity_log add column interaction_id text',
  // 0039: a credential somebody else chose must be replaced before the account
  // can be used.
  //
  // DEFAULT 0 ON AN EXISTING DATABASE, DELIBERATELY. Every credential already
  // in a live installation was either chosen by its holder or has been in use
  // for some time; flagging them all on upgrade would meet the whole company
  // with a password-change screen on the morning of a release nobody was told
  // about. New administrative writes set it explicitly — see
  // local-auth.setPassword.
  'alter table auth_identities add column must_change_password integer not null default 0',
];

/**
 * Indexes built AFTER the column migrations, because they cover columns those
 * migrations add. `create index` on a column that does not exist yet fails, and
 * on a first-ever start the table is created by SCHEMA with the column already
 * present — so this runs in both cases and is a no-op in one of them.
 */
const LATE_INDEXES = [
  // A vendor code is the vendor's identity inside every purchase order number
  // it appears in. Two vendors sharing one would make 1234-COOPER-2 ambiguous
  // about who it was sent to. SQLite permits repeated NULLs in a unique index,
  // which is what lets an un-backfilled database reach this line.
  'create unique index if not exists vendors_org_code_idx on vendors(org_id, code)',
  'create index if not exists po_job_vendor_sequences_org_idx on po_job_vendor_sequences(org_id, job_number)',
];

export const SCHEMA_VERSION = '0040-audit-interaction-id';

function migrate(db: DatabaseSync) {
  refreshOwnedTriggers(db);
  db.exec(SCHEMA);
  for (const statement of ADDED_COLUMNS) {
    try {
      db.exec(statement);
    } catch (err) {
      // "duplicate column name" means the migration already ran. Anything else
      // is a real failure and must not be swallowed.
      if (!/duplicate column name/i.test(String((err as Error).message))) throw err;
    }
  }
  dropGlobalSequenceUniqueness(db);
  for (const statement of LATE_INDEXES) db.exec(statement);
  backfillVendorCodes(db);
  backfillOrderVendorCodes(db);
  backfillLineItemOrgs(db);
  recordSchemaVersion(db);
}

/**
 * Drop the triggers this file owns, so SCHEMA can recreate them AT THIS
 * RELEASE'S DEFINITION.
 *
 * `create trigger if not exists` is idempotent, which is what makes it safe to
 * run on every start — and it also means a trigger whose definition CHANGES is
 * never updated on a database that already has the old one. That is not a
 * theoretical concern: it bit on the development database the moment the
 * permanence fence was taught to allow one transition it had previously
 * refused. The old trigger was still there, rejected the migration's own
 * backfill, and the database came up degraded.
 *
 * Dropping first is the fix, and the window with no fence is the whole of one
 * synchronous startup step, before the server accepts a request.
 *
 * Only the triggers whose text lives in SCHEMA below. Anything else in the
 * database was not put there by this file and is not this function's to remove.
 */
function refreshOwnedTriggers(db: DatabaseSync) {
  for (const name of [
    'purchase_orders_number_permanent',
    'purchase_orders_no_delete',
    'po_job_vendor_sequences_forward_only',
    'purchase_history_lines_no_update',
    'purchase_history_lines_no_delete',
  ]) {
    db.exec(`drop trigger if exists ${name}`);
  }
}

/**
 * Retire `unique (org_id, sequence_value)` on purchase_orders.
 *
 * That constraint was inline in the CREATE TABLE, so there is no ALTER that
 * removes it: SQLite requires the table to be rebuilt. It has to go, because
 * under the real Lippolis rule the sequence is per (job, vendor) — 1234-COOPER-1
 * and 1234-GRAYBAR-1 both carry sequence 1, and the old constraint would refuse
 * the second one with a message about a duplicate purchase order that is not a
 * duplicate of anything.
 *
 * Detected structurally rather than by a version stamp: ask the database what
 * unique indexes it actually has. That makes this safe to run on every start
 * and on a database at any point in the upgrade path, including one restored
 * from a backup taken before it.
 *
 * A no-op on a fresh database, where SCHEMA already created the table without
 * it.
 */
function dropGlobalSequenceUniqueness(db: DatabaseSync) {
  const stale = (db.prepare('pragma index_list(purchase_orders)').all() as any[]).filter((index) => {
    if (!Number(index.unique)) return false;
    const columns = (db.prepare(`pragma index_info(${JSON.stringify(String(index.name))})`).all() as any[])
      .map((c) => String(c.name));
    return columns.length === 2 && columns.includes('org_id') && columns.includes('sequence_value');
  });
  if (!stale.length) return;

  // Rebuild from the database's OWN definition of the table rather than from a
  // definition written here. `sqlite_master.sql` already reflects every
  // `alter table ... add column` this file has ever applied, and it carries the
  // foreign keys and check constraints with it — reconstructing the DDL from
  // `pragma table_info` would silently drop both, which is a far worse outcome
  // than the constraint being retired.
  const original = String(
    (db.prepare("select sql from sqlite_master where type = 'table' and name = 'purchase_orders'").get() as any).sql,
  );
  // COMMENTS FIRST. The stored definition carries this file's own comments,
  // and one of them describes the constraint being retired — so a naive
  // search-and-replace rewrites the COMMENT and leaves the constraint in place,
  // producing a migration that logs success on every start and changes nothing.
  // The rebuilt table does not need the prose; it lives here, in the source.
  const withoutComments = original.replace(/^[ \t]*--[^\n]*\n/gm, '');
  const constraint = /unique\s*\(\s*org_id\s*,\s*sequence_value\s*\)/i;
  if (!constraint.test(withoutComments)) {
    throw new Error('cannot rewrite purchase_orders: the global sequence constraint was not found in its definition');
  }
  const rebuilt = withoutComments
    .replace('purchase_orders', 'purchase_orders_rebuilt')
    .replace(constraint, 'unique (org_id, job_number, vendor_id, sequence_value)');

  // Indexes AND TRIGGERS. `drop table` takes both with it, and the triggers on
  // this table are the fence that makes an issued purchase order number
  // permanent — a rebuild that silently dropped them would leave the identifier
  // unguarded, on exactly the databases being upgraded. SCHEMA recreates them
  // on the NEXT start, which is one start too late.
  const carried = (db.prepare(
    `select sql from sqlite_master
      where type in ('index', 'trigger') and tbl_name = 'purchase_orders' and sql is not null`,
  ).all() as any[]).map((row) => String(row.sql));

  const columns = (db.prepare('pragma table_info(purchase_orders)').all() as any[]).map((c) => `"${String(c.name)}"`);
  const list = columns.join(', ');

  // Foreign keys OFF for the swap: purchase_order_items, receipts, documents
  // and email drafts all reference this table, and dropping it with enforcement
  // on would either fail or cascade. The pragma cannot be changed inside a
  // transaction, so it brackets one.
  db.exec('pragma foreign_keys = OFF');
  try {
    db.exec('begin immediate');
    try {
      db.exec(rebuilt);
      db.exec(`insert into purchase_orders_rebuilt (${list}) select ${list} from purchase_orders`);
      db.exec('drop table purchase_orders');
      db.exec('alter table purchase_orders_rebuilt rename to purchase_orders');
      for (const sql of carried) db.exec(sql);
      db.exec('commit');
      console.log('[pcc] purchase order numbering migrated to one sequence per job and vendor');
    } catch (err) {
      db.exec('rollback');
      throw err;
    }
  } finally {
    db.exec('pragma foreign_keys = ON');
  }

  // The swap ran with enforcement off. If anything now dangles, this database
  // must not be served: a purchase order line pointing at nothing is exactly
  // the kind of damage that is invisible until somebody prints an order.
  const violations = db.prepare('pragma foreign_key_check').all() as any[];
  if (violations.length) {
    throw new Error(`purchase order rebuild left ${violations.length} dangling reference(s); the database was not modified further`);
  }
}

/**
 * Give every vendor the code that will stand for it inside a purchase order
 * number. Derived from the display name, deterministic, and assigned ONCE — a
 * vendor that already has one is never touched, so this is a no-op after the
 * first run and cannot renumber anybody.
 *
 * Ordered by creation so the derivation is stable: where two vendors normalize
 * to the same code, the older one keeps the plain form.
 */
function backfillVendorCodes(db: DatabaseSync) {
  const missing = db
    .prepare("select id, org_id, name from vendors where code is null or trim(code) = '' order by created_at, id")
    .all() as any[];
  if (!missing.length) return;

  const takenByOrg = new Map<string, Set<string>>();
  for (const row of db.prepare("select org_id, code from vendors where code is not null and trim(code) <> ''").all() as any[]) {
    if (!takenByOrg.has(row.org_id)) takenByOrg.set(row.org_id, new Set());
    takenByOrg.get(row.org_id)!.add(String(row.code));
  }

  const update = db.prepare('update vendors set code = ? where id = ?');
  for (const vendor of missing) {
    if (!takenByOrg.has(vendor.org_id)) takenByOrg.set(vendor.org_id, new Set());
    const taken = takenByOrg.get(vendor.org_id)!;
    const code = assignVendorCode(vendor.name, [...taken]);
    taken.add(code);
    update.run(code, vendor.id);
  }
  console.log(`[pcc] assigned purchase-order codes to ${missing.length} vendor(s)`);
}

/**
 * Fill in the vendor code on purchase orders raised before the column existed.
 *
 * Their `po_number` is untouched — it is what the supplier received, and under
 * the retired scheme it was never built from a code at all. This only records
 * which code is in force for that vendor, so the column is not a hole on half
 * the table.
 *
 * Exists because the Postgres migration does exactly this (0038) and the two
 * providers may not disagree about what a purchase order row contains. Found by
 * running the upgraded development database and reading it.
 */
function backfillOrderVendorCodes(db: DatabaseSync) {
  const filled = db.prepare(
    `update purchase_orders
        set vendor_code = (select v.code from vendors v where v.id = purchase_orders.vendor_id)
      where vendor_code is null
        and exists (select 1 from vendors v where v.id = purchase_orders.vendor_id and v.code is not null)`,
  ).run();
  if (Number(filled.changes) > 0) {
    console.log(`[pcc] recorded the vendor code on ${filled.changes} existing purchase order(s)`);
  }
}

/**
 * Stamp the version the schema has just been brought TO.
 *
 * This used to write the row only when it was absent, which is correct exactly
 * once — on the database this code created — and wrong on every database it
 * ever upgrades. The statements above are idempotent and unconditional, so an
 * existing database is migrated on every start; a version row that is only
 * inserted on creation therefore keeps naming the version the file was BORN
 * at, forever.
 *
 * That is not a cosmetic staleness. `/api/health` compares this row against
 * SCHEMA_VERSION and answers 503 when they differ, which is the right check —
 * it is how an operator learns a container is running against a database it
 * does not understand. But with an insert-only stamp, the first release that
 * bumps SCHEMA_VERSION migrates every installation correctly and then reports
 * every one of them as unhealthy, permanently, with nothing actually wrong.
 * The proxy drains a working instance, the monitoring pages somebody at 7am,
 * and the documented upgrade path (`docker compose up -d --build`, check
 * health) fails on its first real use. Nobody would find it by reading the
 * migration, because the migration works.
 *
 * So: write it after the schema is at this version, and say so in the log when
 * it moved. An upgrade is a thing that happened to the company's records, and
 * it should be visible in `docker logs` rather than inferred.
 */
function recordSchemaVersion(db: DatabaseSync) {
  const row = db.prepare('select value from schema_meta where key = ?').get('version') as
    | { value: string }
    | undefined;

  if (row?.value === SCHEMA_VERSION) return;

  db.prepare(
    `insert into schema_meta (key, value) values ('version', ?)
       on conflict(key) do update set value = excluded.value`,
  ).run(SCHEMA_VERSION);

  if (row) console.log(`[pcc] schema migrated from ${row.value} to ${SCHEMA_VERSION}`);
}

/**
 * Give existing line items their organization. Idempotent: only rows without
 * one are touched, so this is a no-op on every run after the first.
 *
 * The local store cannot express the Postgres trigger that forbids drift, so
 * the repositories set org_id from the parent on every insert and this fills in
 * the rows written before the column existed.
 */
function backfillLineItemOrgs(db: DatabaseSync) {
  db.exec(`
    update purchase_request_items set org_id = (
      select r.org_id from purchase_requests r where r.id = purchase_request_items.request_id
    ) where org_id is null;

    update purchase_order_items set org_id = (
      select po.org_id from purchase_orders po where po.id = purchase_order_items.purchase_order_id
    ) where org_id is null;

    update purchase_receipt_items set org_id = (
      select rc.org_id from purchase_receipts rc where rc.id = purchase_receipt_items.receipt_id
    ) where org_id is null;

    update purchase_review_items set org_id = (
      select r.org_id from purchase_reviews rv
        join purchase_requests r on r.id = rv.request_id
       where rv.id = purchase_review_items.review_id
    ) where org_id is null;
  `);
}

/** Table names the parity validator compares against the SQL migration. */
export const TABLES = [
  'orgs',
  'users',
  'roles',
  'user_roles',
  'vendors',
  'vendor_contacts',
  'delivery_locations',
  'jobs',
  'purchase_requests',
  'purchase_request_items',
  'purchase_request_attachments',
  'purchase_reviews',
  'purchase_review_items',
  'purchase_approvals',
  'po_number_sequences',
  'po_job_vendor_sequences',
  'request_number_sequences',
  'purchase_orders',
  'purchase_order_items',
  'purchase_order_documents',
  'email_templates',
  'purchase_email_drafts',
  'purchase_receipts',
  'purchase_receipt_items',
  'purchase_receipt_attachments',
  'inventory_observations',
  'inventory_adjustments',
  'purchase_activity_log',
  'purchase_notifications',
  'system_settings',
  'auth_identities',
  'user_job_assignments',
  'purchase_item_catalog',
  'purchase_jobs',
  'purchase_history_lines',
];
