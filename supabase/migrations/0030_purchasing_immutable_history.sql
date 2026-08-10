-- ---------------------------------------------------------------------------
-- 0030_purchasing_immutable_history.sql — BR-012, made structural.
--
-- WHAT WAS WRONG
--
-- `purchase_line_history` (0018) was a VIEW over live entities. That was the
-- right shape for the thing it was built for — a projection that cannot drift
-- from its source — and the wrong shape entirely for HISTORY, for reasons that
-- only become visible once a company has been using the system for a year:
--
--   * it resolved `vendor_id` at READ time. Rename "Graybar" to "Graybar
--     Electric Co." and every historical row silently changed who the material
--     was bought from. Same for a re-described material, a renamed job, a user
--     whose name was corrected.
--   * it INNER JOINed purchase_orders, so a request that was CANCELLED or
--     REJECTED — never becoming an order — was invisible. History that only
--     records the purchases that succeeded is a sales brochure.
--   * it carried no approver, no received timestamp, no completed timestamp,
--     and collapsed damaged / backordered / written-off into a single
--     `received_qty`. Lead time cannot be computed from it, and "what actually
--     arrived" cannot be answered.
--
-- BR-012 says completed purchasing activity becomes immutable evidence. A view
-- whose contents change when somebody edits a vendor is not evidence, and no
-- amount of columns added to it would make it evidence. So this replaces it.
--
-- WHAT THIS DOES
--
--   1. drops the view
--   2. creates `purchase_history_lines` — one row per REQUEST LINE, written
--      ONCE, when the request reaches a terminal state
--   3. makes the row immutable: an INSERT policy and NOTHING ELSE, plus
--      guard_no_delete() and a guard that refuses UPDATE outright
--   4. keeps the tenant boundary local to the row (org_id + RLS + composite
--      foreign keys), exactly as 0018/0019 established
--
-- THE RULE THE COLUMNS ENCODE: THE ID **AND** THE SNAPSHOT.
--   the id      keeps the row joinable to whatever the entity is called today
--   the snapshot keeps the row true about what was bought at the time
-- Both are present for the same thing on purpose. Neither is derived from the
-- other on read, because the point is that they are allowed to disagree: when
-- they do, the id says "this is that vendor" and the snapshot says "and this is
-- what they were called when we bought it".
--
-- THE WRITE POINT is application/history.ts, called from the three use cases
-- that end a request (complete, cancel, reject). It is NOT a trigger: the same
-- rule would then have to exist in plpgsql here and in JavaScript for the local
-- provider, and two copies of a rule are two rules. domain/history.mjs builds
-- the rows; both providers only write them.
--
-- CANCELLATION AND REJECTION — the policy, decided here and stated in the two
-- other places it matters (domain/history.mjs, docs/PURCHASING_HISTORY_AND_
-- CATALOG.md):
--
--   1. A cancelled or rejected request IS recorded, with `terminal_state` and
--      the reason given. "We asked for this and were refused" is exactly the
--      fact a manager reconstructing a decision needs, and it is the fact the
--      old view threw away.
--   2. Whether a row counts toward money and timing follows from the FACTS on
--      the row rather than from its label:
--        * pricing requires `ordered_at is not null and ordered_qty > 0` — the
--          line actually reached a vendor. A REJECTED request can never satisfy
--          this (the transition graph makes ORDERED unreachable from REJECTED),
--          so it is excluded by construction, not by a special case.
--        * a request CANCELLED AFTER it was placed did commit money at a real
--          price, so it IS price evidence and counts.
--        * lead time requires `ordered_at` and `received_at` both present.
--          A line that never arrived reports nothing — never a zero.
--   3. Demand is a different question from purchase. Every row is demand;
--      only ordered rows are purchases. A read model that conflates the two
--      lets a rejected request inflate a frequency count, which is how an
--      analytics screen starts lying quietly.
--
-- Additive apart from the view it replaces. No existing table is altered
-- destructively and no row changes meaning.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A. The view goes.
--
-- Nothing in the application reads it: the item catalogue reads line items, and
-- from this migration onward it reads the table below instead. Dropping it is
-- the point of the exercise — leaving it would leave a second, contradictory
-- answer to "what did we buy", and the wrong one is the one that looks
-- authoritative because it is called `history`.
-- ---------------------------------------------------------------------------

drop view if exists purchase_line_history;

-- ---------------------------------------------------------------------------
-- B. The immutable record.
-- ---------------------------------------------------------------------------

create type purchase_history_terminal_state as enum ('COMPLETED', 'CANCELLED', 'REJECTED');

-- What became of an ordered line, as one coarse label. The QUANTITIES beside it
-- are the truth; this is the word a person reads first. An exception outranks a
-- completion (see domain/history.mjs receiptOutcome), because a line that was
-- fully received AND had a damaged unit is a line something went wrong on.
create type purchase_history_outcome as enum (
  'NOT_ORDERED',
  'WRITTEN_OFF',
  'DAMAGED',
  'BACKORDERED',
  'NOT_RECEIVED',
  'PARTIALLY_RECEIVED',
  'RECEIVED'
);

create table purchase_history_lines (
  id                        uuid primary key default uuid_generate_v4(),
  org_id                    uuid not null references orgs(id),

  -- --- how it ended --------------------------------------------------------
  terminal_state            purchase_history_terminal_state not null,
  -- The cancellation or rejection reason, verbatim. Null for a completion.
  terminal_reason           text,
  recorded_at               timestamptz not null default now(),
  recorded_by               uuid not null references users(id),

  -- --- identifiers, so the row stays joinable to current data ---------------
  request_id                uuid not null references purchase_requests(id),
  request_number            text not null,                    -- SNAPSHOT
  request_item_id           uuid not null references purchase_request_items(id),
  line_no                   integer not null,
  purchase_order_id         uuid references purchase_orders(id),
  po_number                 text,                             -- SNAPSHOT
  purchase_order_item_id    uuid references purchase_order_items(id),
  -- The directory row, when the job was in the directory at the time. The
  -- NUMBER is the record; the directory is only what the UI offered.
  job_id                    uuid references purchase_jobs(id),
  job_number                text not null,                    -- SNAPSHOT
  catalog_item_id           uuid references purchase_item_catalog(id),

  -- --- what was bought, described as it was described THEN ------------------
  normalized_description    text not null,
  -- The normalizer in force when this row was written. History must not
  -- re-cluster because somebody improved a regex; this records which rules
  -- produced the key beside it.
  normalizer_version        integer not null,
  requested_description     text not null,                    -- SNAPSHOT
  -- What the purchase order said, substitutes included. Null when the line
  -- never became an order line.
  ordered_description       text,                             -- SNAPSHOT
  unit                      text not null,
  requested_qty             numeric(14,3) not null,
  ordered_qty               numeric(14,3) not null default 0,

  -- --- who it was bought from, as they were called THEN ---------------------
  vendor_id                 uuid references purchase_vendors(id),
  -- THE FIELD THE VIEW GOT WRONG. This is the name on the purchase order.
  vendor_name               text,                             -- SNAPSHOT
  -- Nothing writes this yet; it arrives with the Phase B catalog import. It is
  -- in the row from the start because a column added later is a column that is
  -- null for all of history.
  vendor_part_number        text,                             -- SNAPSHOT

  -- --- money. NULL is unknown, and unknown is not zero ----------------------
  estimated_unit_cost       numeric(12,2),
  estimated_line_total      numeric(12,2),
  actual_unit_cost          numeric(12,2),
  actual_line_total         numeric(12,2),

  -- --- people, as they were named THEN --------------------------------------
  requestor_id              uuid not null references users(id),
  requestor_name            text,                             -- SNAPSHOT
  approver_id               uuid references users(id),
  approver_name             text,                             -- SNAPSHOT

  -- --- the timeline ---------------------------------------------------------
  requested_at              timestamptz,
  -- When the PO DOCUMENT was produced, which is not when the order was placed.
  -- The old view used the first and called it `ordered_at`; lead-time maths
  -- needs the second. Both are kept so neither has to be guessed.
  po_generated_at           timestamptz,
  ordered_at                timestamptz,
  received_at               timestamptz,
  completed_at              timestamptz,

  -- --- what became of it ----------------------------------------------------
  received_qty              numeric(14,3) not null default 0,
  damaged_qty               numeric(14,3) not null default 0,
  backordered_qty           numeric(14,3) not null default 0,
  written_off_qty           numeric(14,3) not null default 0,
  outcome                   purchase_history_outcome not null,

  constraint purchase_history_lines_quantities_sane check (
    requested_qty >= 0 and ordered_qty >= 0 and received_qty >= 0
    and damaged_qty >= 0 and backordered_qty >= 0 and written_off_qty >= 0
  ),
  constraint purchase_history_lines_costs_sane check (
    (estimated_unit_cost  is null or estimated_unit_cost  >= 0) and
    (estimated_line_total is null or estimated_line_total >= 0) and
    (actual_unit_cost     is null or actual_unit_cost     >= 0) and
    (actual_line_total    is null or actual_line_total    >= 0)
  ),
  -- A line that never became an order has no vendor snapshot obligation, but a
  -- line that WAS ordered must say who from. A purchase with no vendor name is
  -- the exact hole this migration exists to close.
  constraint purchase_history_lines_ordered_names_vendor check (
    ordered_at is null or ordered_qty = 0 or vendor_name is not null
  ),

  -- One row per request line, forever. This is also what makes the write
  -- idempotent: a retried completion inserts nothing the second time.
  unique (org_id, request_id, request_item_id)
);

create index purchase_history_lines_org_idx      on purchase_history_lines(org_id, ordered_at desc);
create index purchase_history_lines_material_idx on purchase_history_lines(org_id, normalized_description);
create index purchase_history_lines_vendor_idx   on purchase_history_lines(org_id, vendor_id);
create index purchase_history_lines_request_idx  on purchase_history_lines(org_id, request_id);

comment on table purchase_history_lines is
  'IMMUTABLE purchasing history: one row per request line, written once when the '
  'request reaches a terminal state (COMPLETED, CANCELLED, REJECTED). Every *_name, '
  '*_number and *_description column is a SNAPSHOT taken at that moment and kept '
  'beside the corresponding id — renaming a vendor, a material or a job changes the '
  'entity and never this row. Append-only by policy and by trigger (BR-012): a '
  'correction is a new request, never an edit. Derived intelligence (autocomplete '
  'ranking, last price, observed lead time) is computed FROM this table and never '
  'written back into it.';

comment on column purchase_history_lines.vendor_name is
  'The vendor name as the purchase order carried it. The predecessor view resolved '
  'this through vendor_id at read time, so a rename rewrote history; that is the '
  'defect this column exists to prevent.';

comment on column purchase_history_lines.ordered_at is
  'When the order was actually placed with the vendor (purchase_requests.ordered_at), '
  'NOT when the PO document was generated — that is po_generated_at. Lead time is '
  'received_at - ordered_at and is reported only when both are present.';

comment on column purchase_history_lines.terminal_state is
  'COMPLETED, CANCELLED or REJECTED. Cancelled and rejected requests ARE recorded. '
  'Whether a row informs price or lead time follows from the facts on the row '
  '(ordered_at present, ordered_qty > 0), not from this label — see the header.';

-- ---------------------------------------------------------------------------
-- C. Tenancy. Same shape as every other purchasing table: org_id on the row,
--    RLS on, policies scoped by current_org_id(), and composite (id, org_id)
--    references so a cross-organization pointer is unrepresentable.
-- ---------------------------------------------------------------------------

alter table purchase_history_lines add constraint purchase_history_lines_id_org_key unique (id, org_id);

-- The parents of the composite references below need the matching unique key.
-- purchase_requests, purchase_orders, purchase_vendors, purchase_item_catalog
-- and purchase_jobs already have theirs from 0019; the two line-item tables do
-- not, because nothing referenced them until now.
alter table purchase_request_items add constraint purchase_request_items_id_org_key unique (id, org_id);
alter table purchase_order_items   add constraint purchase_order_items_id_org_key   unique (id, org_id);

alter table purchase_history_lines
  drop constraint if exists purchase_history_lines_request_id_fkey,
  add constraint purchase_history_lines_request_same_org
    foreign key (request_id, org_id) references purchase_requests(id, org_id);

alter table purchase_history_lines
  drop constraint if exists purchase_history_lines_request_item_id_fkey,
  add constraint purchase_history_lines_requestitem_same_org
    foreign key (request_item_id, org_id) references purchase_request_items(id, org_id);

alter table purchase_history_lines
  drop constraint if exists purchase_history_lines_purchase_order_id_fkey,
  add constraint purchase_history_lines_order_same_org
    foreign key (purchase_order_id, org_id) references purchase_orders(id, org_id);

alter table purchase_history_lines
  drop constraint if exists purchase_history_lines_purchase_order_item_id_fkey,
  add constraint purchase_history_lines_orderitem_same_org
    foreign key (purchase_order_item_id, org_id) references purchase_order_items(id, org_id);

alter table purchase_history_lines
  drop constraint if exists purchase_history_lines_vendor_id_fkey,
  add constraint purchase_history_lines_vendor_same_org
    foreign key (vendor_id, org_id) references purchase_vendors(id, org_id);

alter table purchase_history_lines
  drop constraint if exists purchase_history_lines_job_id_fkey,
  add constraint purchase_history_lines_job_same_org
    foreign key (job_id, org_id) references purchase_jobs(id, org_id);

alter table purchase_history_lines
  drop constraint if exists purchase_history_lines_catalog_item_id_fkey,
  add constraint purchase_history_lines_catalog_same_org
    foreign key (catalog_item_id, org_id) references purchase_item_catalog(id, org_id);

alter table purchase_history_lines enable row level security;

-- READ: anyone in the organization. History is what the purchasing screens,
-- the catalogue and the future intelligence panels are built on, and there is
-- nothing in it a member of the company may not see about their own company.
create policy purchase_history_lines_read on purchase_history_lines
  for select using (org_id = current_org_id());

-- WRITE: INSERT ONLY, and only within the caller's own organization, and only
-- against a request that is already terminal. The last clause is what stops
-- history being written for a purchase that has not happened yet — a row
-- written early would have to be corrected later, and correcting it is exactly
-- what the table forbids.
create policy purchase_history_lines_insert on purchase_history_lines
  for insert with check (
    org_id = current_org_id()
    and exists (
      select 1 from purchase_requests r
       where r.id = request_id
         and r.org_id = current_org_id()
         and r.status in ('COMPLETED', 'CANCELLED', 'REJECTED')
    )
  );

-- NO UPDATE POLICY AND NO DELETE POLICY, deliberately. RLS denies what it does
-- not permit, so both statements are already refused for every non-superuser
-- caller. The triggers below say the same thing to the callers RLS does not
-- reach (the service role, a migration, a person at psql), and say it with a
-- message that explains what to do instead.

create or replace function guard_no_update() returns trigger
language plpgsql as $$
begin
  raise exception
    'this record is immutable: a correction is a new record, never an edit (%.%)',
    tg_table_schema, tg_table_name;
end $$;

create trigger purchase_history_lines_no_update
  before update on purchase_history_lines
  for each row execute function guard_no_update();

create trigger purchase_history_lines_no_delete
  before delete on purchase_history_lines
  for each row execute function guard_no_delete();
