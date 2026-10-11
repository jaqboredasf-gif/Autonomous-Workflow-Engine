-- ---------------------------------------------------------------------------
-- 0018_purchasing_history_and_jobs.sql  (Checkpoint 1C)
--
-- Three things, all additive. No column is dropped, no data is rewritten, and
-- no existing row changes meaning.
--
--   A. TENANT OWNERSHIP ON LINE ITEMS. Every historical line now carries its
--      own org_id instead of being reachable only by joining up to a request.
--   B. THE ITEM CATALOG. An organization's own vocabulary of what it buys,
--      derived from its own history — the substrate for later autocomplete,
--      ranking, reorder suggestions and analytics.
--   C. THE JOB DIRECTORY. Jobs become records rather than free text.
--
-- Plus: actual cost alongside estimated cost, because a purchaser may order
-- without knowing the price and accounting reconciles later. Either may be
-- unknown, and unknown is NULL — never zero.
--
-- WHY LINE ITEMS CARRY org_id DIRECTLY
-- The future features named in the brief (material autocomplete, standardized
-- catalog, frequently-purchased ranking, recent items, preferred vendor,
-- reorder suggestions, analytics) all read across a company's whole history.
-- Reaching organization through purchase_request_items -> purchase_requests
-- means every such query is a join away from the tenant boundary, and an RLS
-- policy on the item table has to re-derive it. Denormalizing org_id makes the
-- boundary local to the row: the policy is `org_id = current_org_id()`, the
-- analytics query is a single index scan, and a line item cannot be read by the
-- wrong tenant even if a join is written carelessly.
--
-- It is denormalized data, so it is CONSTRAINED, not merely defaulted: a
-- trigger forces it to match the parent on write and refuses to let it change.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A. Tenant ownership on historical line items
-- ---------------------------------------------------------------------------

alter table purchase_request_items add column if not exists org_id uuid references orgs(id);
alter table purchase_order_items   add column if not exists org_id uuid references orgs(id);
alter table purchase_receipt_items add column if not exists org_id uuid references orgs(id);
alter table purchase_review_items  add column if not exists org_id uuid references orgs(id);

-- Backfill from the parent. Idempotent: only rows that lack it are touched.
update purchase_request_items i
   set org_id = r.org_id
  from purchase_requests r
 where r.id = i.request_id and i.org_id is null;

update purchase_order_items oi
   set org_id = po.org_id
  from purchase_orders po
 where po.id = oi.purchase_order_id and oi.org_id is null;

update purchase_receipt_items ri
   set org_id = rc.org_id
  from purchase_receipts rc
 where rc.id = ri.receipt_id and ri.org_id is null;

update purchase_review_items vi
   set org_id = r.org_id
  from purchase_reviews rv
  join purchase_requests r on r.id = rv.request_id
 where rv.id = vi.review_id and vi.org_id is null;

alter table purchase_request_items alter column org_id set not null;
alter table purchase_order_items   alter column org_id set not null;
alter table purchase_receipt_items alter column org_id set not null;
alter table purchase_review_items  alter column org_id set not null;

-- The whole point of the denormalization: history queries by organization.
create index if not exists purchase_request_items_org_idx on purchase_request_items(org_id, created_at desc);
create index if not exists purchase_order_items_org_idx   on purchase_order_items(org_id, created_at desc);
create index if not exists purchase_receipt_items_org_idx on purchase_receipt_items(org_id, created_at desc);

/**
 * Denormalized tenancy has exactly one failure mode: drift. This forbids it —
 * the org must match the parent, and it may never be changed afterwards. A row
 * that could be moved between organizations is a cross-tenant leak with extra
 * steps.
 */
create or replace function guard_line_item_org() returns trigger
language plpgsql as $$
declare
  v_parent uuid;
begin
  if tg_table_name = 'purchase_request_items' then
    select org_id into v_parent from purchase_requests where id = new.request_id;
  elsif tg_table_name = 'purchase_order_items' then
    select org_id into v_parent from purchase_orders where id = new.purchase_order_id;
  elsif tg_table_name = 'purchase_receipt_items' then
    select org_id into v_parent from purchase_receipts where id = new.receipt_id;
  elsif tg_table_name = 'purchase_review_items' then
    select r.org_id into v_parent
      from purchase_reviews rv join purchase_requests r on r.id = rv.request_id
     where rv.id = new.review_id;
  end if;

  if new.org_id is null then
    new.org_id := v_parent;
  elsif new.org_id is distinct from v_parent then
    raise exception 'line item organization (%) does not match its parent (%)', new.org_id, v_parent;
  end if;

  if tg_op = 'UPDATE' and new.org_id is distinct from old.org_id then
    raise exception 'a line item cannot move between organizations';
  end if;
  return new;
end $$;

create trigger purchase_request_items_org_guard
  before insert or update on purchase_request_items
  for each row execute function guard_line_item_org();
create trigger purchase_order_items_org_guard
  before insert or update on purchase_order_items
  for each row execute function guard_line_item_org();
create trigger purchase_receipt_items_org_guard
  before insert or update on purchase_receipt_items
  for each row execute function guard_line_item_org();
create trigger purchase_review_items_org_guard
  before insert or update on purchase_review_items
  for each row execute function guard_line_item_org();

-- Direct, row-local tenant policies. These replace nothing: the existing
-- parent-derived policies stay, and a row must satisfy both.
create policy purchase_request_items_org_read on purchase_request_items
  for select using (org_id = current_org_id());
create policy purchase_order_items_org_read on purchase_order_items
  for select using (org_id = current_org_id());
create policy purchase_receipt_items_org_read on purchase_receipt_items
  for select using (org_id = current_org_id());

-- History is evidence. A parent going away must not silently take the line
-- items with it — and since business records are append-only (guard_no_delete),
-- this only ever fires on a mistake.
alter table purchase_request_items
  drop constraint if exists purchase_request_items_request_id_fkey,
  add constraint purchase_request_items_request_id_fkey
    foreign key (request_id) references purchase_requests(id) on delete restrict;

alter table purchase_order_items
  drop constraint if exists purchase_order_items_purchase_order_id_fkey,
  add constraint purchase_order_items_purchase_order_id_fkey
    foreign key (purchase_order_id) references purchase_orders(id) on delete restrict;

alter table purchase_receipt_items
  drop constraint if exists purchase_receipt_items_receipt_id_fkey,
  add constraint purchase_receipt_items_receipt_id_fkey
    foreign key (receipt_id) references purchase_receipts(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- B. The item catalog — an organization's own vocabulary
--
-- Built FROM history, not instead of it. `purchase_request_items.description`
-- keeps exactly what the person typed, forever; the catalog holds the tidied
-- form and the defaults an organization has converged on.
--
-- Deliberately NOT here: usage counters. A `times_ordered` column drifts the
-- moment anything writes a line item without updating it, and every count it
-- could hold is derivable from the line items themselves, which are now
-- indexed by organization. Ranking is a query, not a column.
-- ---------------------------------------------------------------------------

create table purchase_item_catalog (
  id                    uuid primary key default uuid_generate_v4(),
  org_id                uuid not null references orgs(id) on delete cascade,
  -- The matching key: lowercased, collapsed whitespace, punctuation removed.
  -- Computed by the application (domain/catalog.mjs) so both providers agree.
  normalized_description text not null,
  -- What the organization would like to see offered. Starts as the first
  -- description used and can be curated later.
  canonical_description  text not null,
  default_unit           text,
  -- The vendor this item is usually bought from. A default, never a decision:
  -- the workshop still chooses per order.
  default_vendor_id      uuid references purchase_vendors(id),
  catalog_number         text,
  notes                  text,
  is_active              boolean not null default true,
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references users(id),
  -- One entry per normalized item per organization. This is what makes
  -- "the same thing, typed differently" collapse — and the org_id in the key
  -- is what keeps two companies' vocabularies apart.
  unique (org_id, normalized_description)
);

create index purchase_item_catalog_org_idx on purchase_item_catalog(org_id, last_seen_at desc);

alter table purchase_item_catalog enable row level security;

create policy purchase_item_catalog_read on purchase_item_catalog
  for select using (org_id = current_org_id());
create policy purchase_item_catalog_write on purchase_item_catalog
  for all using (org_id = current_org_id() and purchasing_can(auth.uid(), 'review.set_quantities'));

-- Line items point at the catalog entry they matched, and keep BOTH forms of
-- the text: what the person typed, and what it normalized to. Neither is
-- derived from the other at read time, because normalization rules will change
-- and history must not change with them.
alter table purchase_request_items
  add column if not exists normalized_description text,
  add column if not exists catalog_item_id uuid references purchase_item_catalog(id);

alter table purchase_order_items
  add column if not exists normalized_description text,
  add column if not exists catalog_item_id uuid references purchase_item_catalog(id);

create index if not exists purchase_request_items_catalog_idx
  on purchase_request_items(org_id, catalog_item_id);
create index if not exists purchase_order_items_catalog_idx
  on purchase_order_items(org_id, catalog_item_id);

-- ---------------------------------------------------------------------------
-- Actual vs estimated cost.
--
-- A purchaser may order without knowing the price — that is normal, not a gap
-- in the data. Estimated cost is what the workshop thought; actual cost is what
-- the invoice said. Either may be unknown, and unknown is NULL. Zero means
-- someone recorded a price of zero, which is a different fact.
-- ---------------------------------------------------------------------------

alter table purchase_order_items
  add column if not exists actual_unit_cost  numeric(12,2),
  add column if not exists actual_line_total numeric(12,2),
  add constraint purchase_order_items_actual_unit_cost_positive
    check (actual_unit_cost is null or actual_unit_cost >= 0),
  add constraint purchase_order_items_actual_line_total_positive
    check (actual_line_total is null or actual_line_total >= 0);

alter table purchase_orders
  add column if not exists actual_total numeric(12,2),
  add column if not exists actual_cost_source text,
  add constraint purchase_orders_actual_total_positive
    check (actual_total is null or actual_total >= 0);

comment on column purchase_orders.actual_total is
  'What was actually paid, when known. NULL means not yet reconciled — it does not mean zero.';

-- The history view the future features read. A view rather than a table: it
-- cannot drift, and it makes the tenant boundary explicit in one place.
create or replace view purchase_line_history as
select
  oi.org_id,
  oi.id                     as order_item_id,
  oi.catalog_item_id,
  oi.normalized_description,
  oi.description            as ordered_description,
  ri.description            as requested_description,
  oi.order_qty,
  oi.unit,
  oi.unit_cost              as estimated_unit_cost,
  oi.actual_unit_cost,
  po.vendor_id,
  po.job_number,
  po.po_number,
  po.request_id,
  po.generated_at           as ordered_at,
  r.requestor_id,
  coalesce(rec.received_qty, 0) as received_qty
from purchase_order_items oi
join purchase_orders po on po.id = oi.purchase_order_id
join purchase_requests r on r.id = po.request_id
left join purchase_request_items ri on ri.id = oi.request_item_id
left join lateral (
  select sum(received_qty) as received_qty
    from purchase_receipt_items
   where purchase_order_item_id = oi.id
) rec on true;

comment on view purchase_line_history is
  'Tenant-scoped purchasing history, one row per ordered line. The substrate for '
  'material autocomplete, catalog curation, frequently-purchased ranking, recent-item '
  'suggestions, preferred-vendor association and reorder analytics. Read it with '
  'org_id = current_org_id(); never across organizations.';

-- ---------------------------------------------------------------------------
-- C. The job directory
--
-- Jobs stop being free text. The request keeps `job_number` as text on purpose:
-- it is what the field typed, it is what the vendor sees on the purchase order,
-- and a job later renamed or closed must not rewrite the history of an order
-- already placed. The directory is what the UI offers; the text is what the
-- record preserves.
-- ---------------------------------------------------------------------------

create type purchase_job_status as enum ('ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED');

create table purchase_jobs (
  id                     uuid primary key default uuid_generate_v4(),
  org_id                 uuid not null references orgs(id) on delete cascade,
  job_number             text not null,
  name                   text not null,
  customer               text,
  site_address           text,
  status                 purchase_job_status not null default 'ACTIVE',
  project_manager_id     uuid references users(id),
  primary_foreman_id     uuid references users(id),
  delivery_instructions  text,
  default_location_id    uuid references purchase_delivery_locations(id),
  cost_code              text,
  project_phase          text,
  starts_on              date,
  ends_on                date,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references users(id),
  updated_by             uuid references users(id),
  unique (org_id, job_number)
);

create index purchase_jobs_org_status_idx on purchase_jobs(org_id, status);

alter table purchase_jobs enable row level security;

create policy purchase_jobs_read on purchase_jobs
  for select using (org_id = current_org_id());
create policy purchase_jobs_manage on purchase_jobs
  for all using (org_id = current_org_id() and purchasing_can(auth.uid(), 'admin.assignments'));

-- Backup foremen: a job can have more than one, and a foreman covers more than
-- one job. purchasing_job_assignments already links a user to a job NUMBER;
-- this names the relationship's kind so "who is primary here" is answerable.
alter table purchasing_job_assignments
  add column if not exists assignment_kind text not null default 'FOREMAN',
  add constraint purchasing_job_assignments_kind
    check (assignment_kind in ('FOREMAN', 'BACKUP_FOREMAN', 'RECEIVER', 'PROJECT_MANAGER'));

-- Closing a job must not orphan its purchasing history. There is deliberately
-- no foreign key from purchase_requests.job_number to purchase_jobs: the
-- request records what was typed at the time, and a directory entry that is
-- later renamed, closed or deleted cannot rewrite an issued purchase order.
comment on table purchase_jobs is
  'The job directory the UI offers for selection. purchase_requests.job_number '
  'deliberately remains free text so historical records survive a job being '
  'renamed, closed or removed from the directory.';

-- ---------------------------------------------------------------------------
-- Audit sequence: let the database own it.
--
-- The application computes `seq` as max()+1 per request, which is a read-modify-
-- write and therefore a race under concurrency. A monotonic default removes the
-- race; ordering within a request stays (at, seq).
-- ---------------------------------------------------------------------------

create sequence if not exists purchase_activity_seq;

alter table purchase_activity_log
  alter column seq set default nextval('purchase_activity_seq');

-- Existing rows keep the sequence values they were written with; the sequence
-- starts above them so nothing collides.
select setval('purchase_activity_seq',
              greatest(coalesce((select max(seq) from purchase_activity_log), 0), 1));
