-- ---------------------------------------------------------------------------
-- 0038 — purchase order numbers, as Lippolis actually writes them.
--
-- THE RULE, from Mike and Paul (2026-08-12):
--
--     job number + vendor + sequential number,  e.g.  1234-COOPER-1
--
-- and the sequence counts within the PAIR. Job 1234 with Cooper runs 1, 2, 3.
-- The same job with Graybar starts again at 1. Another job with Cooper starts
-- again at 1.
--
-- What was here before was a single counter per organization, formatted
-- `LE-52901`, with a documented gate refusing to generate anything until an
-- administrator supplied "the next number from the paper book". That gate was
-- protecting a real risk against the wrong model: there is no next number,
-- because there is no one sequence. The prefix, the padding and the starting
-- value were all standing in for an answer nobody had yet, and this is the
-- answer.
--
-- WHAT THIS CHANGES
--   1. purchase_vendors gains `code` — the vendor's identity INSIDE a purchase
--      order number. Derived from the name once, then frozen: renaming a vendor
--      must never renumber an order a supplier already has.
--   2. po_job_vendor_sequences — one counter per (org, job, vendor).
--   3. next_po_number_for() — allocates one, atomically.
--   4. purchase_orders gains `vendor_code`, a snapshot taken at issuance, and
--      LOSES `unique (org_id, sequence_value)`: under the real rule 1234-COOPER-1
--      and 1234-GRAYBAR-1 both carry sequence 1 and neither is a duplicate.
--   5. generate_purchase_order() builds the number from the three components.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * Renumber anything already issued. Existing purchase orders keep their
--     `po_number` exactly as sent; the permanence trigger from 0016 still
--     forbids changing one.
--   * Delete po_number_sequences. It records what an office was configured to,
--     and deleting it would erase that. Nothing allocates from it any more.
--
-- Mirrors the pilot store — the same tables, constraint and trigger exist in
-- apps/purchasing/src/purchasing/infrastructure/sqlite/database.ts, which
-- scripts/lib/validate-migration-0016.mjs holds in lockstep with this file.
-- ---------------------------------------------------------------------------

-- --- 1. the vendor's code --------------------------------------------------

alter table if exists public.purchase_vendors
  add column if not exists code text;

comment on column public.purchase_vendors.code is
  'The vendor as it appears inside a purchase order number (the COOPER in 1234-COOPER-1). Derived from the name once and then frozen: the display name may be corrected without renumbering anything already issued.';

-- `unaccent` is an extension that may not be installed. Purchase order numbers
-- must not depend on whether it is, so this is the fallback: strip the accents
-- we can name, and leave anything else to the character filter above.
create or replace function unaccent_safe(p_text text)
returns text language sql immutable as $$
  select translate(coalesce(p_text, ''),
    'ÁÀÂÄÃÅáàâäãåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇç',
    'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOooooo' || 'UUUUuuuuNnCc')
$$;

/**
 * The same derivation the domain performs (domain/po-number.mjs,
 * `normalizeVendorCode`): upper case, ampersand spelled out, everything that is
 * not a letter or a digit removed, capped at 32 characters.
 *
 * It does NOT abbreviate. "Cooper Electric Supply Co." becomes
 * COOPERELECTRICSUPPLY, not CESC — an abbreviation invented by a migration is a
 * name nobody at the company chose, printed on a supplier's paperwork. Where a
 * shorter code is wanted an administrator sets it, and that decision has a
 * person behind it.
 */
create or replace function purchasing_vendor_code(p_name text)
returns text language sql immutable as $$
  select left(
    regexp_replace(
      replace(upper(unaccent_safe(coalesce(p_name, ''))), '&', 'AND'),
      '[^A-Z0-9]', '', 'g'
    ), 32)
$$;

/**
 * Give every existing vendor a code, once.
 *
 * Ordered by creation so it is deterministic, and skipping any vendor that
 * already has one so it is idempotent — running this migration twice cannot
 * renumber anybody. A collision appends a digit rather than inventing a
 * different abbreviation: the office can see that COOPER2 is the second Cooper
 * and give it a proper code.
 */
do $$
declare
  v        record;
  v_base   text;
  v_try    text;
  v_n      integer;
begin
  for v in
    select id, org_id, name from public.purchase_vendors
     where code is null or btrim(code) = ''
     order by created_at, id
  loop
    v_base := coalesce(nullif(purchasing_vendor_code(v.name), ''), 'VENDOR');
    v_try  := v_base;
    v_n    := 1;
    while exists (
      select 1 from public.purchase_vendors
       where org_id = v.org_id and upper(code) = v_try
    ) loop
      v_n := v_n + 1;
      v_try := left(v_base, 32 - length(v_n::text)) || v_n::text;
    end loop;
    update public.purchase_vendors set code = v_try where id = v.id;
  end loop;
end $$;

-- Two vendors sharing a code would make 1234-COOPER-2 ambiguous about who it
-- was sent to.
create unique index if not exists purchase_vendors_org_code_idx
  on public.purchase_vendors (org_id, upper(code));

-- --- 2. the sequence, per (org, job, vendor) -------------------------------

create table if not exists public.po_job_vendor_sequences (
  org_id         uuid not null references public.orgs(id) on delete cascade,
  -- The NORMALIZED job segment — what appears in the number — so "24-118" and
  -- "24-118 " share one counter rather than issuing two orders called the same
  -- thing.
  job_number     text not null,
  vendor_id      uuid not null references public.purchase_vendors(id),
  vendor_code    text not null,
  next_value     bigint not null default 1,
  -- Set only when an administrator declared where this pair's PAPER sequence
  -- had already reached. NULL means PCC started it at 1 because PCC has issued
  -- nothing for it.
  initialized_at timestamptz,
  initialized_by uuid references public.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (org_id, job_number, vendor_id),
  check (next_value > 0)
);

comment on table public.po_job_vendor_sequences is
  'One purchase order counter per (organization, job, vendor). The Lippolis rule: 1234-COOPER-1, 1234-COOPER-2, 1234-GRAYBAR-1, 5678-COOPER-1.';

-- A pair's counter may only move FORWARD. Winding one back re-issues a number a
-- vendor already has on an invoice.
create or replace function guard_po_pair_sequence_forward() returns trigger
language plpgsql as $$
begin
  if new.next_value < old.next_value then
    raise exception 'a PO sequence can only move forward (% -> %); issued numbers are permanent',
      old.next_value, new.next_value;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists po_job_vendor_sequences_forward_only on public.po_job_vendor_sequences;
create trigger po_job_vendor_sequences_forward_only
  before update on public.po_job_vendor_sequences
  for each row execute function guard_po_pair_sequence_forward();

/** The same normalization the domain performs, for the job segment. */
create or replace function purchasing_job_segment(p_job text)
returns text language sql immutable as $$
  select btrim(
    regexp_replace(
      regexp_replace(upper(unaccent_safe(coalesce(p_job, ''))), '[^A-Z0-9-]', '', 'g'),
      '-{2,}', '-', 'g'
    ), '-')
$$;

/**
 * next_po_number_for() — allocate the next number for one job and one vendor.
 *
 * ONE STATEMENT. The insert-or-increment is a single upsert with a RETURNING
 * clause, so there is no window between reading the counter and advancing it:
 * two approvers pressing Approve in the same second serialize on the row, and
 * the losing one gets the next value rather than the same one. It must be
 * called INSIDE the transaction that writes the purchase_orders row, so the
 * bump and the row that consumes it commit together or not at all.
 *
 * A pair nothing has been issued against starts at 1 — the insert writes the
 * counter already advanced to 2 and returns 1.
 */
create or replace function next_po_number_for(p_org uuid, p_job text, p_vendor uuid)
returns table (po_number text, sequence_value bigint)
language plpgsql security definer as $$
declare
  v_job   text := purchasing_job_segment(p_job);
  v_code  text;
  v_seq   bigint;
begin
  if v_job is null or v_job = '' then
    raise exception 'a purchase order number is built from the job number, and this request has none';
  end if;

  select upper(code) into v_code from public.purchase_vendors where id = p_vendor and org_id = p_org;
  if v_code is null or v_code = '' then
    raise exception 'vendor % has no purchase order code, and a purchase order number is built from one', p_vendor;
  end if;

  insert into public.po_job_vendor_sequences (org_id, job_number, vendor_id, vendor_code, next_value)
  values (p_org, v_job, p_vendor, v_code, 2)
  on conflict (org_id, job_number, vendor_id) do update
    set next_value = po_job_vendor_sequences.next_value + 1,
        vendor_code = excluded.vendor_code
  returning po_job_vendor_sequences.next_value - 1 into v_seq;

  po_number := v_job || '-' || v_code || '-' || v_seq::text;
  sequence_value := v_seq;
  return next;
end $$;

/**
 * initialize_po_sequence() — declare where a pair's PAPER sequence stood.
 *
 * The one place a counter may be set rather than advanced, and the most
 * consequential thing an administrator can do to numbering: it decides which
 * number the next real supplier receives. So it refuses to land on or below a
 * sequence PCC has already ISSUED (read from the orders, not from the counter),
 * refuses to move an existing counter backwards, and records who did it.
 */
create or replace function initialize_po_sequence(p_org uuid, p_job text, p_vendor uuid, p_next bigint)
returns bigint language plpgsql security definer as $$
declare
  v_job    text := purchasing_job_segment(p_job);
  v_code   text;
  v_issued bigint;
  v_uid    uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'setting a purchase order sequence requires an authenticated human';
  end if;
  if p_org is distinct from current_org_id() then
    raise exception 'cross-org purchase order sequence refused';
  end if;
  if not purchasing_can(v_uid, 'admin.po_config') then
    raise exception 'user % does not hold admin.po_config', v_uid;
  end if;
  if p_next is null or p_next < 1 then
    raise exception 'the next purchase order number must be 1 or greater';
  end if;

  select upper(code) into v_code from public.purchase_vendors where id = p_vendor and org_id = p_org;
  if v_code is null or v_code = '' then
    raise exception 'vendor % has no purchase order code', p_vendor;
  end if;

  select coalesce(max(sequence_value), 0) into v_issued
    from public.purchase_orders
   where org_id = p_org and purchasing_job_segment(job_number) = v_job and vendor_id = p_vendor;

  if p_next <= v_issued then
    raise exception 'PCC has already issued sequence % for this job and vendor; the next number must be at least %',
      v_issued, v_issued + 1;
  end if;

  insert into public.po_job_vendor_sequences
    (org_id, job_number, vendor_id, vendor_code, next_value, initialized_at, initialized_by)
  values (p_org, v_job, p_vendor, v_code, p_next, now(), v_uid)
  on conflict (org_id, job_number, vendor_id) do update
    set next_value = excluded.next_value,
        vendor_code = excluded.vendor_code,
        initialized_at = coalesce(po_job_vendor_sequences.initialized_at, excluded.initialized_at),
        initialized_by = excluded.initialized_by;

  return p_next;
end $$;

-- --- 3. the purchase order row ---------------------------------------------

alter table if exists public.purchase_orders
  add column if not exists vendor_code text;

comment on column public.purchase_orders.vendor_code is
  'The vendor code AS AT ISSUANCE. A snapshot, not a join: with job_number and sequence_value these are the three components po_number was built from, so the identifier stays explainable after a vendor is renamed.';

-- The sequence is unique WITHIN its pair, not across the organization. The old
-- constraint would refuse 1234-GRAYBAR-1 because 1234-COOPER-1 exists.
alter table if exists public.purchase_orders
  drop constraint if exists purchase_orders_org_id_sequence_value_key;

create unique index if not exists purchase_orders_pair_sequence_idx
  on public.purchase_orders (org_id, job_number, vendor_id, sequence_value);

-- Backfill the snapshot for orders issued under the old scheme. Their
-- `po_number` is untouched — it is what the supplier received — this only
-- records which vendor code was in force, so the column is not a hole.
update public.purchase_orders o
   set vendor_code = v.code
  from public.purchase_vendors v
 where v.id = o.vendor_id and o.vendor_code is null;

-- --- 4. issuing an order uses the pair's counter ---------------------------

create or replace function generate_purchase_order(p_request uuid)
returns table (purchase_order_id uuid, po_number text) language plpgsql security definer as $$
declare
  r          purchase_requests%rowtype;
  v_uid      uuid := auth.uid();
  v_existing purchase_orders%rowtype;
  v_vendors  uuid[];
  v_seq      record;
  v_po       uuid;
  v_total    numeric(12,2);
  v_contact  uuid;
  v_code     text;
begin
  if v_uid is null then
    raise exception 'generating a purchase order requires an authenticated human';
  end if;

  select * into r from purchase_requests where id = p_request;
  if r.id is null then raise exception 'purchase request % not found', p_request; end if;
  if r.org_id is distinct from current_org_id() then
    raise exception 'cross-org purchase order refused (request %)', p_request;
  end if;
  if not purchasing_can(v_uid, 'po.generate') then
    raise exception 'user % does not hold po.generate', v_uid;
  end if;

  -- Idempotent: a request that already has a purchase order returns the same
  -- permanent number and burns no sequence value.
  select * into v_existing from purchase_orders where request_id = p_request;
  if v_existing.id is not null then
    purchase_order_id := v_existing.id;
    po_number := v_existing.po_number;
    return next;
    return;
  end if;

  if r.status <> 'APPROVED' then
    raise exception 'a % request cannot produce a purchase order', r.status;
  end if;

  select array_agg(distinct ri.vendor_id) into v_vendors
    from purchase_reviews rv join purchase_review_items ri on ri.review_id = rv.id
   where rv.request_id = p_request and ri.final_order_qty > 0;
  if v_vendors is null or array_length(v_vendors, 1) <> 1 or v_vendors[1] is null then
    raise exception 'this milestone issues one purchase order to one vendor';
  end if;

  select upper(code) into v_code from purchase_vendors where id = v_vendors[1];
  if v_code is null or v_code = '' then
    raise exception 'that vendor has no purchase order code, and a purchase order number is built from one';
  end if;

  select id into v_contact from purchase_vendor_contacts
   where vendor_id = v_vendors[1] order by is_primary desc limit 1;

  select coalesce(sum(ri.estimated_line_total), 0) into v_total
    from purchase_reviews rv join purchase_review_items ri on ri.review_id = rv.id
   where rv.request_id = p_request and ri.final_order_qty > 0;

  -- THE NUMBER, from this job's and this vendor's own counter, inside this
  -- transaction. Job + vendor + sequence.
  select * into v_seq from next_po_number_for(r.org_id, r.job_number, v_vendors[1]);

  insert into purchase_orders (org_id, request_id, po_number, sequence_value, vendor_id, vendor_code,
                               vendor_contact_id, job_number, approver_id, delivery_location_id,
                               delivery_method, need_by_date, need_by_time, estimated_total, notes, generated_by)
  values (r.org_id, p_request, v_seq.po_number, v_seq.sequence_value, v_vendors[1], v_code, v_contact,
          r.job_number, coalesce(r.approver_id, v_uid), r.delivery_location_id, r.delivery_method,
          r.need_by_date, r.need_by_time, v_total, r.decision_notes, v_uid)
  returning id into v_po;

  insert into purchase_order_items (purchase_order_id, line_no, request_item_id, description,
                                    substitute_description, order_qty, unit, unit_cost, line_total,
                                    expected_arrival_date)
  select v_po, row_number() over (order by i.line_no), i.id, i.description,
         ri.substitute_description, ri.final_order_qty, i.unit,
         coalesce(ri.estimated_unit_cost, 0), ri.estimated_line_total, ri.expected_arrival_date
    from purchase_request_items i
    join purchase_reviews rv on rv.request_id = i.request_id
    join purchase_review_items ri on ri.request_item_id = i.id and ri.review_id = rv.id
   where i.request_id = p_request and ri.final_order_qty > 0;

  update purchase_requests
     set status = 'PO_GENERATED', estimated_total = v_total, updated_by = v_uid
   where id = p_request;

  purchase_order_id := v_po;
  po_number := v_seq.po_number;
  return next;
end $$;

-- --- 5. tenancy ------------------------------------------------------------

alter table public.po_job_vendor_sequences enable row level security;

drop policy if exists po_pair_sequences_read on public.po_job_vendor_sequences;
create policy po_pair_sequences_read on public.po_job_vendor_sequences
  for select using (org_id = current_org_id() and purchasing_can(auth.uid(), 'po.generate'));

-- No insert/update/delete policy on purpose: the two functions above are
-- security definer and are the only way this table is written. An administrator
-- cannot reach past `initialize_po_sequence` and its refusals.

grant select on public.po_job_vendor_sequences to authenticated;
grant execute on function next_po_number_for(uuid, text, uuid) to authenticated;
grant execute on function initialize_po_sequence(uuid, text, uuid, bigint) to authenticated;
grant execute on function purchasing_vendor_code(text) to authenticated;
grant execute on function purchasing_job_segment(text) to authenticated;
grant execute on function unaccent_safe(text) to authenticated;

-- The old allocator is left in place but must not be reachable: a caller that
-- still holds it would issue a number from the retired global counter.
revoke execute on function next_po_number(uuid) from authenticated;

comment on function next_po_number(uuid) is
  'RETIRED by 0038. Purchase orders are numbered job-vendor-sequence and allocated by next_po_number_for(). Kept only so the historical migration remains readable.';
