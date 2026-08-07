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
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_PATH = join(process.cwd(), '.data', 'purchasing.db');

let instance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (instance) return instance;
  const path = process.env.PURCHASING_DB_PATH ?? DEFAULT_PATH;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = WAL');
  db.exec('pragma foreign_keys = ON');
  db.exec('pragma busy_timeout = 5000');
  migrate(db);
  instance = db;
  return db;
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
  return db;
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
  created_at    text not null,
  -- A rejection or a clarification must say why.
  check (decision = 'APPROVED' or (reason is not null and length(reason) > 0))
);

create index if not exists purchase_approvals_request_idx on purchase_approvals(request_id);

-- --- purchase orders -------------------------------------------------------

create table if not exists po_number_sequences (
  org_id      text primary key references orgs(id),
  prefix      text not null default 'LE-',
  padding     integer not null default 5 check (padding between 1 and 12),
  suffix      text not null default '',
  next_value  integer not null check (next_value > 0),
  updated_at  text not null,
  updated_by  text references users(id)
);

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
  sequence_value    integer not null,
  vendor_id         text not null references vendors(id),
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
  unique (org_id, sequence_value),
  -- One live PO per request in this milestone (multi-PO splits are §21 future).
  unique (request_id)
);

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
  po_template_key        text not null default 'lippolis_default',
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
];

export const SCHEMA_VERSION = '0016-purchasing-control';

function migrate(db: DatabaseSync) {
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
  backfillLineItemOrgs(db);

  const row = db.prepare('select value from schema_meta where key = ?').get('version') as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare('insert into schema_meta (key, value) values (?, ?)').run('version', SCHEMA_VERSION);
  }
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
];
