# PCC — Legacy PO Import Pipeline

**Status:** design, implementation-ready. Nothing in here is built.
**Baseline commit:** `3534cc7` (Phase A: immutable native purchasing history, migrations `0030`–`0033`).
**Next migration number:** `0034`.

---

## 0. The one sentence this document exists to protect

**Imported legacy purchase orders are second-hand evidence about a company's past, and native
purchasing history is first-hand evidence of what this system did — the two must never become
indistinguishable, and the second must never be written by the first.**

Everything below follows from that. If a decision here looks over-engineered, it is because the
alternative is a purchasing history that *looks* authoritative and is partly reconstructed.

### 0.1 What Phase A already established, that this design must obey

Read these before implementing; this design is deliberately shaped to their idioms.

| Fact | Where |
| --- | --- |
| Native history is one immutable row per request line, written once at the terminal transition | `supabase/migrations/0030_purchasing_immutable_history.sql`, `apps/purchasing/src/purchasing/domain/history.mjs` |
| The row carries **both the id and the snapshot** — the id joins to today, the snapshot stays true | `0030` header |
| Append-only is enforced by **four fences**: GRANT, RLS policy set, row trigger, TRUNCATE trigger | `0030`, `0031`, `0032` |
| A history row may not lie about who wrote it or how the request ended (`recorded_by = auth.uid()`) | `0033` |
| Tenancy is **row-local**: `org_id` on every row, `current_org_id()` policies, composite `(id, org_id)` foreign keys | `0018`, `0019`, `0030` |
| Domain rules live in `domain/*.mjs` (pure, shared by both providers); repositories never decide | `apps/purchasing/src/purchasing/domain/repositories.ts` |
| Two providers must agree byte for byte — SQLite (pilot) and Supabase (production) | `scripts/eval-purchasing-providers.mjs` |
| Normalization is stored at write time with a `NORMALIZER_VERSION`, never recomputed on read | `domain/catalog.mjs` |
| Ranking is a query, not a stored counter | `0018` §B |
| A spreadsheet is already reduced to `table -> records + problems` by a pure module | `domain/material-import.mjs` |

### 0.2 The rules this pipeline adds

1. Legacy lines live in **their own table**. `purchase_history_lines` is never written by an import.
2. Raw imported values are stored **verbatim, as text**, and are never overwritten — not by
   normalization, not by matching, not by curation.
3. An interpreted value always names the **rule version** that produced it.
4. A match to a vendor or catalog item is an **opinion**, recorded separately from the evidence, and
   revisable without touching the evidence.
5. Nothing becomes immutable until a human accepts it. Once accepted, it is immutable by the same
   four fences native history uses.
6. Re-importing the same source is a **no-op**, at three independent levels (file bytes, source row,
   line content).

---

## A. Domain model

### A.1 Entities

| Entity | Owns | Mutable? |
| --- | --- | --- |
| **Import batch** | One human-meaningful import effort ("Lippolis PO history 2019–2024"). Groups sources; the unit of review and of commitment. | Yes, until closed |
| **Source file** | One uploaded artefact and its bytes: filename, content hash, storage path, source kind, parser used. | Identity fields immutable; parse status mutable (retry) |
| **Staging row** | One row of one source, as read and as interpreted. The workbench. | Yes, until accepted |
| **Validation issue** | One problem found on a staging row by the parser or the validator. Derived, recomputed on every parse. | Recomputed (delete + rewrite) |
| **Match proposal** | A candidate association between a staging row's raw vendor/material text and a directory entity. Ranked, never applied automatically when ambiguous. | Recomputed |
| **Accepted legacy history line** | One committed historical purchase line. Raw + interpreted + provenance, frozen. | **No** |
| **Rejected row** | A staging row in a terminal `REJECTED`/`DUPLICATE` state, with a reason. Stays in staging; never promoted. | Reason editable while batch open |
| **Match decision** | A post-commit, append-only statement that a legacy line refers to vendor X / catalog item Y / job Z (or explicitly to nothing). | Append-only |
| **Provenance** | Not an entity: a set of columns denormalized onto every staging row and every accepted line — batch id, source id, content hash, source row reference, and snapshots of the filename and hash. | Immutable on accepted lines |

### A.2 Lifecycles

**Batch** — `purchase_import_batch_status`

```
OPEN ──────────► REVIEWING ──────────► COMMITTED
  │                 │  ▲                   (terminal)
  │                 │  └── add another source ──┐
  │                 └──────────────────────────►┘  (back to OPEN)
  └──────────────► ABANDONED (terminal)
                      ▲
        REVIEWING ────┘
```

* `OPEN` — sources may be added, removed, parsed, re-parsed. No staging row has been accepted.
* `REVIEWING` — at least one source parsed. Rows may be accepted (each acceptance commits that row
  immediately and irreversibly). Sources may still be added; that returns the batch to `OPEN`
  **only if no row has been committed yet**; after the first commit the batch stays `REVIEWING` and
  new sources simply add rows.
* `COMMITTED` — no staging row remains in a non-terminal state. Terminal. No source may be added.
* `ABANDONED` — closed deliberately with zero committed rows, or with committed rows left in place
  and the remainder discarded. Terminal. Reason required. Committed rows are **not** withdrawn —
  abandonment closes the workbench, it does not unmake history.

Guard: the batch status is derived from row states at close time and asserted, not trusted.

**Source** — `purchase_import_parse_status`: `PENDING → PARSED | FAILED`, `FAILED → PENDING` (retry),
`PARSED → PENDING` (re-parse). Re-parse is allowed at any time while the batch is open, and may not
touch a staging row already in `ACCEPTED`.

**Staging row** — `purchase_import_row_status`

```
PENDING ─► VALIDATED ─────────────────► ACCEPTED   (terminal, writes the legacy line)
   │  │                                    ▲
   │  └──► NEEDS_REVIEW ──► VALIDATED ─────┘
   │            │
   │            └──► REJECTED (terminal while batch open: reopen to NEEDS_REVIEW)
   └──► DUPLICATE (terminal — an identical line already exists)
```

* `PENDING` — parsed, not yet validated (a transient state within one parse run).
* `VALIDATED` — no `ERROR` issues, no ambiguity, not a duplicate. Eligible for acceptance.
* `NEEDS_REVIEW` — one or more `ERROR` issues, an ambiguous match, a soft duplicate, or a source
  kind that always requires review (`PDF_TRANSCRIPT`). **Cannot be accepted while in this state.**
* `REJECTED` — a human said no, with a reason. Never promoted. Reopenable while the batch is open.
* `DUPLICATE` — the content fingerprint already exists as an accepted legacy line, or shadows a
  native purchase order. Never promoted. Carries a pointer to what it duplicated.
* `ACCEPTED` — committed. The staging row is frozen from here (trigger), and carries
  `committed_legacy_line_id`.

**Accepted legacy line** — no lifecycle. It exists or it does not.

**Match decision** — no lifecycle. Append-only; the newest decision per `(line, target_kind)` is the
current opinion.

---

## B. Database design

One migration: `supabase/migrations/0034_purchasing_legacy_import.sql`. Mirrored, table for table,
in `apps/purchasing/src/purchasing/infrastructure/sqlite/database.ts` (the pilot store), as
`0030` was.

Money convention for this pipeline: **integer micro-dollars (`bigint`, 1 = 1e-6 USD)**. See §B.8 for
why this departs from the cents convention used elsewhere.

### B.1 `purchase_import_batches`

```sql
create type purchase_import_batch_status as enum ('OPEN','REVIEWING','COMMITTED','ABANDONED');

create table purchase_import_batches (
  id             uuid primary key default uuid_generate_v4(),
  org_id         uuid not null references orgs(id),
  label          text not null,                       -- "Lippolis PO history 2019-2024"
  purpose        text,                                -- free text, why this import exists
  status         purchase_import_batch_status not null default 'OPEN',
  closed_reason  text,                                -- required when ABANDONED
  created_at     timestamptz not null default now(),
  created_by     uuid not null references users(id),
  updated_at     timestamptz not null default now(),
  first_committed_at timestamptz,
  closed_at      timestamptz,
  closed_by      uuid references users(id),
  constraint purchase_import_batches_closed_reason
    check (status <> 'ABANDONED' or closed_reason is not null),
  unique (id, org_id)
);
create index purchase_import_batches_org_idx on purchase_import_batches(org_id, created_at desc);
```

**No counters.** Row totals, accepted counts and rejection counts are queries over
`purchase_import_staging_rows`, for the reason `0018` gives about `times_ordered`: a stored counter
drifts the first time anything writes without updating it.

### B.2 `purchase_import_sources`

```sql
create type purchase_import_source_kind as enum ('CSV','XLSX','PDF','PDF_TRANSCRIPT','JSON','MANUAL');
create type purchase_import_parse_status as enum ('PENDING','PARSED','FAILED');

create table purchase_import_sources (
  id              uuid primary key default uuid_generate_v4(),
  org_id          uuid not null references orgs(id),
  batch_id        uuid not null,
  source_kind     purchase_import_source_kind not null,
  -- Exactly what the file was called. Never cleaned up.
  filename        text not null,
  content_type    text,
  byte_size       bigint not null check (byte_size >= 0),
  -- sha256 of the RAW BYTES, lowercase hex. The identity of the artefact.
  content_sha256  text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- Private bucket 'purchasing-imports', path {org_id}/{batch_id}/{content_sha256}{ext}
  storage_path    text not null,
  -- A PDF_TRANSCRIPT points at the PDF it was transcribed from. See §D.4.
  derived_from_source_id uuid,
  parser_key      text,                       -- 'csv.v1' | 'xlsx.v1' | 'pdf-transcript.v1'
  parser_version  integer,
  parse_status    purchase_import_parse_status not null default 'PENDING',
  parse_error     text,
  parsed_at       timestamptz,
  -- What the parser SAID it emitted. A fact about a parse run, reconciled
  -- against the staging rows by a check in the review UI, never trusted as a count.
  reported_row_count integer,
  uploaded_at     timestamptz not null default now(),
  uploaded_by     uuid not null references users(id),
  -- The same bytes are the same source. Re-uploading returns this row.
  unique (org_id, content_sha256),
  unique (id, org_id)
);
create index purchase_import_sources_batch_idx on purchase_import_sources(org_id, batch_id);

alter table purchase_import_sources
  add constraint purchase_import_sources_batch_same_org
    foreign key (batch_id, org_id) references purchase_import_batches(id, org_id),
  add constraint purchase_import_sources_derived_same_org
    foreign key (derived_from_source_id, org_id) references purchase_import_sources(id, org_id);
```

**Immutable from insert** (trigger `guard_import_source_identity`): `org_id`, `batch_id`,
`source_kind`, `filename`, `content_sha256`, `storage_path`, `byte_size`, `derived_from_source_id`,
`uploaded_by`, `uploaded_at`.
**Mutable:** `parser_key`, `parser_version`, `parse_status`, `parse_error`, `parsed_at`,
`reported_row_count` — a parser retry is normal and must not require a new upload.

**Deletable** only while the batch is `OPEN` **and** the source has produced no `ACCEPTED` row
(trigger `guard_import_source_delete`). Deleting a source deletes its staging rows (cascade); it
never touches a committed legacy line.

### B.3 `purchase_import_staging_rows`

The workbench. Three bands of columns: **raw** (verbatim text), **interpreted** (typed, versioned),
**review** (state and decisions).

```sql
create type purchase_import_row_status as enum
  ('PENDING','VALIDATED','NEEDS_REVIEW','REJECTED','DUPLICATE','ACCEPTED');

create type purchase_import_date_precision as enum ('DAY','MONTH','YEAR','UNKNOWN');

create table purchase_import_staging_rows (
  id                 uuid primary key default uuid_generate_v4(),
  org_id             uuid not null references orgs(id),
  batch_id           uuid not null,
  source_id          uuid not null,

  -- --- where this row came from, precisely enough to go back and look -------
  source_row_ordinal integer not null check (source_row_ordinal >= 1),
  -- {sheet, row} | {page, line, snippet} | {recordIndex}
  source_row_ref     jsonb not null,

  -- --- RAW. Verbatim text, exactly as read. NEVER rewritten. ----------------
  -- The whole original row, keyed by its ORIGINAL header text.
  raw                jsonb not null,
  raw_po_number      text,
  raw_po_date        text,
  raw_vendor_name    text,
  raw_material_description text,
  raw_manufacturer   text,
  raw_part_number    text,
  raw_unit           text,
  raw_quantity       text,
  raw_unit_price     text,
  raw_extended_price text,
  raw_job_number     text,
  raw_requester      text,
  raw_line_number    text,
  raw_notes          text,
  -- sha256 of the canonical JSON of `raw`. Makes re-parse a no-op.
  raw_row_hash       text not null check (raw_row_hash ~ '^[0-9a-f]{64}$'),

  -- --- INTERPRETED. Typed, and stamped with the rules that produced it. -----
  interpretation_version integer not null,
  normalizer_version     integer not null,
  normalized_description text,
  normalized_vendor_name text,
  po_number              text,
  job_number             text,
  unit                   text,
  quantity               numeric(14,3) check (quantity is null or quantity >= 0),
  unit_cost_micros       bigint check (unit_cost_micros is null or unit_cost_micros >= 0),
  extended_cost_micros   bigint check (extended_cost_micros is null or extended_cost_micros >= 0),
  ordered_on             date,
  date_precision         purchase_import_date_precision not null default 'UNKNOWN',
  -- Which identical-looking line on this PO this is (1-based). See §C.2.
  occurrence_index       integer not null default 1 check (occurrence_index >= 1),
  -- sha256 over the canonical fingerprint tuple. See §C.1.
  content_fingerprint    text check (content_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_version    integer,

  -- --- MATCHING. The chosen proposal, if any. Never applied when ambiguous. --
  matched_vendor_id       uuid,
  matched_catalog_item_id uuid,
  matched_job_id          uuid,
  matched_requester_id    uuid,
  match_basis             text,   -- 'human_confirmed' | 'exact_normalized' | null

  -- --- REVIEW ---------------------------------------------------------------
  status             purchase_import_row_status not null default 'PENDING',
  duplicate_of_legacy_line_id uuid,
  duplicate_of_staging_row_id uuid,
  shadows_native_request_id   uuid,
  decision_note      text,
  decided_at         timestamptz,
  decided_by         uuid references users(id),
  committed_legacy_line_id uuid,
  -- Optimistic concurrency: two reviewers on one batch. See §I.14.
  version            integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- One staging row per source row. This is what makes re-parse idempotent.
  unique (org_id, source_id, source_row_ordinal),
  unique (id, org_id),
  constraint purchase_import_staging_rows_rejected_reason
    check (status <> 'REJECTED' or decision_note is not null),
  constraint purchase_import_staging_rows_accepted_line
    check ((status = 'ACCEPTED') = (committed_legacy_line_id is not null))
);

create index purchase_import_staging_rows_batch_idx  on purchase_import_staging_rows(org_id, batch_id, status);
create index purchase_import_staging_rows_source_idx on purchase_import_staging_rows(org_id, source_id, source_row_ordinal);
create index purchase_import_staging_rows_fp_idx     on purchase_import_staging_rows(org_id, content_fingerprint);
create index purchase_import_staging_rows_po_idx     on purchase_import_staging_rows(org_id, po_number);
```

Composite foreign keys (all `(x_id, org_id) references t(id, org_id)`): `batch_id`, `source_id`,
`matched_vendor_id → purchase_vendors`, `matched_catalog_item_id → purchase_item_catalog`,
`matched_job_id → purchase_jobs`, `duplicate_of_legacy_line_id → purchase_history_legacy_lines`,
`committed_legacy_line_id → purchase_history_legacy_lines`,
`duplicate_of_staging_row_id → purchase_import_staging_rows`,
`shadows_native_request_id → purchase_requests`. `matched_requester_id → users(id)` (users are not
org-keyed by composite in this schema; the application checks `orgId` — same treatment
`purchase_history_lines.requestor_id` gets).

The references between staging rows and legacy lines are **mutually circular** — the line points at
the staging row it came from, the staging row points at the line it produced. That is legal without
deferral because the legacy side is null on insert: create the staging row, insert the line, then
set `committed_legacy_line_id`. The commit RPC does exactly that, in one transaction. Both
constraints must be added with `alter table` **after** both tables exist; declaring them inline
fails on the first table.

**Frozen on `ACCEPTED`** (trigger `guard_staging_row_frozen`): every column except nothing. Once a
row is `ACCEPTED`, no `UPDATE` is permitted at all; a mistake is corrected by the correction policy
in §E.6, not by editing the workbench.

**Mutable while not accepted:** everything. Re-parse overwrites the raw and interpreted bands
when `raw_row_hash` changes, and leaves `status`/`decision_note` intact only when the hash is
unchanged (§I.12).

### B.4 `purchase_import_row_issues`

```sql
create type purchase_import_issue_severity as enum ('ERROR','WARNING','INFO');

create table purchase_import_row_issues (
  id             uuid primary key default uuid_generate_v4(),
  org_id         uuid not null references orgs(id),
  staging_row_id uuid not null,
  severity       purchase_import_issue_severity not null,
  code           text not null,        -- see §D.6 for the closed vocabulary
  field          text,                 -- the raw field it concerns, when it concerns one
  message        text not null,
  detected_by    text not null,        -- 'parser' | 'interpreter' | 'validator' | 'dedupe'
  rule_version   integer not null,
  created_at     timestamptz not null default now()
);
-- An expression key needs a unique INDEX, not a table constraint: one issue of a
-- given code per field per row, with a null field treated as its own slot.
create unique index purchase_import_row_issues_key
  on purchase_import_row_issues(org_id, staging_row_id, code, coalesce(field, ''));
create index purchase_import_row_issues_row_idx on purchase_import_row_issues(org_id, staging_row_id);
```

Issues are **derived**, not evidence: they are deleted and rewritten on every parse/validate run.
`for all` write policy scoped to the organization and `import.review` — this is the one table in the
pipeline where DELETE is legitimate, and the migration says so in a comment so a later reader does
not "fix" it.

### B.5 `purchase_import_match_proposals`

```sql
create type purchase_import_match_target as enum ('VENDOR','CATALOG_ITEM','JOB');

create table purchase_import_match_proposals (
  id             uuid primary key default uuid_generate_v4(),
  org_id         uuid not null references orgs(id),
  staging_row_id uuid not null,
  target_kind    purchase_import_match_target not null,
  -- NULL means "propose creating a new one" or "propose no match".
  target_id      uuid,
  proposed_label text not null,           -- what the target is called today
  method         text not null,           -- 'exact_normalized'|'alias'|'prefix'|'fuzzy'|'manual'
  score          numeric(5,4) not null check (score >= 0 and score <= 1),
  rank           integer not null check (rank >= 1),
  rule_version   integer not null,
  created_at     timestamptz not null default now(),
  unique (org_id, staging_row_id, target_kind, rank)
);
create index purchase_import_match_proposals_row_idx
  on purchase_import_match_proposals(org_id, staging_row_id, target_kind, rank);
```

Derived, like issues: recomputed whenever the row or the directory changes. Never the record of a
decision — the decision is `staging_row.matched_*` before commit and
`purchase_legacy_match_decisions` after.

### B.6 `purchase_history_legacy_lines` — the immutable accepted record

```sql
create table purchase_history_legacy_lines (
  id                 uuid primary key default uuid_generate_v4(),
  org_id             uuid not null references orgs(id),

  -- --- provenance: ids AND snapshots, the 0030 rule ------------------------
  batch_id           uuid not null,
  source_id          uuid not null,
  staging_row_id     uuid not null,
  source_kind        purchase_import_source_kind not null,   -- SNAPSHOT
  source_filename    text not null,                          -- SNAPSHOT
  source_content_sha256 text not null,                       -- SNAPSHOT
  source_row_ref     jsonb not null,                         -- SNAPSHOT
  source_row_ordinal integer not null,                       -- SNAPSHOT

  imported_at        timestamptz not null default now(),
  -- Who uploaded the file (snapshot from the source row).
  imported_by        uuid not null references users(id),
  -- Who accepted this line. Forced to auth.uid() by policy — the 0033 rule.
  accepted_by        uuid not null references users(id),
  accepted_at        timestamptz not null default now(),

  -- --- RAW. Verbatim. This is the evidence. --------------------------------
  raw                jsonb not null,
  raw_po_number      text,
  raw_po_date        text,
  raw_vendor_name    text,
  raw_material_description text not null,
  raw_manufacturer   text,
  raw_part_number    text,
  raw_unit           text,
  raw_quantity       text,
  raw_unit_price     text,
  raw_extended_price text,
  raw_job_number     text,
  raw_requester      text,
  raw_line_number    text,
  raw_notes          text,
  raw_row_hash       text not null,

  -- --- INTERPRETED. Frozen, and stamped with the rules that produced it. ----
  interpretation_version integer not null,
  normalizer_version     integer not null,
  normalized_description text not null,
  normalized_vendor_name text,
  po_number              text,
  job_number             text,
  unit                   text,
  quantity               numeric(14,3),
  unit_cost_micros       bigint,
  extended_cost_micros   bigint,
  ordered_on             date,
  date_precision         purchase_import_date_precision not null,
  occurrence_index       integer not null default 1,
  content_fingerprint    text not null check (content_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_version    integer not null,

  -- --- MATCH AS OF COMMIT. Nullable, and null is an honest answer. ---------
  vendor_id          uuid,
  catalog_item_id    uuid,
  job_id             uuid,
  requester_user_id  uuid references users(id),
  match_basis        text,        -- 'human_confirmed' | 'exact_normalized' | null

  constraint purchase_history_legacy_lines_qty_sane
    check (quantity is null or quantity >= 0),
  constraint purchase_history_legacy_lines_cost_sane
    check ((unit_cost_micros is null or unit_cost_micros >= 0)
       and (extended_cost_micros is null or extended_cost_micros >= 0)),
  -- A line with no description is not evidence of anything.
  constraint purchase_history_legacy_lines_has_description
    check (btrim(raw_material_description) <> '' and btrim(normalized_description) <> ''),
  -- HARD DEDUPE, at the strongest place it can be stated.
  unique (org_id, content_fingerprint),
  -- One line per staging row: commit is idempotent under retry.
  unique (org_id, staging_row_id),
  unique (id, org_id)
);

create index purchase_history_legacy_lines_material_idx on purchase_history_legacy_lines(org_id, normalized_description);
create index purchase_history_legacy_lines_vendor_idx   on purchase_history_legacy_lines(org_id, vendor_id);
create index purchase_history_legacy_lines_date_idx     on purchase_history_legacy_lines(org_id, ordered_on desc);
create index purchase_history_legacy_lines_po_idx       on purchase_history_legacy_lines(org_id, po_number);
create index purchase_history_legacy_lines_batch_idx    on purchase_history_legacy_lines(org_id, batch_id);
create index purchase_history_legacy_lines_job_idx      on purchase_history_legacy_lines(org_id, job_number);
```

Composite foreign keys for `batch_id`, `source_id`, `staging_row_id`, `vendor_id`,
`catalog_item_id`, `job_id`.

**Deliberately absent, and why**

| Not here | Why |
| --- | --- |
| `request_id`, `request_item_id`, `purchase_order_id` | There was no PCC request. A legacy line is not a request line and must not be joinable as one. |
| `terminal_state`, `outcome`, `received_qty`, `damaged_qty` | PCC never received this material. Inventing `RECEIVED` because a PO exists is exactly the fabrication rule 3 forbids. If a legacy export genuinely carries a received quantity, it goes in `raw` and gets its own column in a **later** migration, named `raw_received_qty` and interpreted `reported_received_qty`, never `received_qty`. |
| `approver_id`, `recorded_by` | No approval happened here. `accepted_by` is the person who accepted the *import*, and the column name says so. |
| Anything derived (frequency, last price) | Ranking is a query. |

### B.7 `purchase_legacy_match_decisions` — matching after the record is frozen

```sql
create table purchase_legacy_match_decisions (
  id             uuid primary key default uuid_generate_v4(),
  org_id         uuid not null references orgs(id),
  legacy_line_id uuid not null,
  target_kind    purchase_import_match_target not null,
  -- NULL is a real answer: "this vendor is not in our directory and never will be".
  target_id      uuid,
  basis          text not null,      -- 'human_confirmed' | 'bulk_human_confirmed'
  note           text,
  decided_at     timestamptz not null default now(),
  decided_by     uuid not null references users(id),
  unique (id, org_id)
);
create index purchase_legacy_match_decisions_current_idx
  on purchase_legacy_match_decisions(org_id, legacy_line_id, target_kind, decided_at desc);
```

Append-only, same four fences. This is how rule 9 (immutable after commitment) and requirement F
(matching may happen later) coexist: **the evidence is frozen; the opinion about what it refers to
is a separate, versioned, append-only stream.** The current opinion is the newest decision per
`(legacy_line_id, target_kind)`, falling back to the `*_id` columns frozen at commit.

### B.8 Money: why micro-dollars here and cents everywhere else

Native purchasing stores `numeric(12,2)` in Postgres and integer **cents** in the domain, because a
PCC purchase order is priced in cents. Historical construction-supply pricing is not: wire, conduit
and fittings are quoted per C (hundred) and per M (thousand) at four decimal places, and rounding
`$0.1234/ft` to `$0.12/ft` is a 3% error introduced by the importer on the exact material where
price intelligence matters most.

**Decision.** Legacy interpreted prices are `bigint` micro-dollars (1e-6 USD). Exact for four
decimals, exact for `/C` and `/M` conversions, and integer — so no float ever touches a price.
The union read model (§G) exposes **micros on both sides**, converting native
`numeric(12,2)` cents to micros (`cents * 10000`), so there is exactly one comparison scale. A
mapper `microsToCents(micros, rounding)` exists for display and is never used to store.

The raw text is stored regardless, so even a micros bug loses nothing.

### B.9 Storage

Private bucket `purchasing-imports`. Object path `{org_id}/{batch_id}/{content_sha256}{ext}` —
the org prefix is what the storage policy keys on, following the `0005` idiom. Original PDFs are
kept forever alongside their transcripts; the transcript is a *derived source*, and being able to
open the page a line came from is the point of the whole provenance chain.

### B.10 Immutability summary

| Table | Immutable | When |
| --- | --- | --- |
| `purchase_import_batches` | `id`, `org_id`, `created_by`, `created_at` | always |
| | everything | on `COMMITTED`/`ABANDONED` |
| `purchase_import_sources` | identity band (§B.2) | always |
| | everything | when the source has an `ACCEPTED` row |
| `purchase_import_staging_rows` | nothing | while not `ACCEPTED` |
| | everything | on `ACCEPTED` |
| `purchase_import_row_issues` | nothing — derived, recomputed | — |
| `purchase_import_match_proposals` | nothing — derived, recomputed | — |
| `purchase_history_legacy_lines` | **everything** | from insert |
| `purchase_legacy_match_decisions` | **everything** | from insert |

---

## C. Deduplication

Three independent levels. Each one alone is insufficient; together they make "import the same
history twice" a no-op rather than a corruption.

### C.1 Level 1 — the artefact: `content_sha256`

`unique (org_id, content_sha256)` on sources. Uploading byte-identical content returns the existing
source row with a `duplicate_source` notice, and creates **nothing**. This catches the most common
real failure — someone re-uploads the same PDF, or the same export lands in two batches.

It catches nothing else: an export re-run tomorrow has different bytes and the same content.

### C.2 Level 2 — the line: `content_fingerprint`

```
fingerprint_v1 = sha256( join('\x1f', [
  'v1',
  org_id,
  upper(trim(po_number))                 or '',
  normalized_description,                          -- domain/catalog.mjs, stored version
  upper(unit)                            or '',
  to_fixed(quantity, 3)                  or '',    -- '12.000'
  unit_cost_micros::text                 or '',
  to_char(ordered_on,'YYYY-MM-DD')       or '',
  normalized_vendor_name                 or '',
  occurrence_index::text
]) )
```

`unique (org_id, content_fingerprint)` on `purchase_history_legacy_lines` — a hard duplicate is
**unrepresentable**, not merely detected, so two reviewers racing on two overlapping exports cannot
both win.

**`occurrence_index`** exists because a real PO can legitimately carry the same material twice (two
lines, two job phases). It is the 1-based ordinal of identical fingerprint-tuples *within the same
PO number*, computed deterministically from the interpreted rows sorted by
`(raw_line_number when numeric, source_row_ordinal)`. Because it is computed from PO content rather
than from file position, two different files containing the same PO produce the same indices — so
duplicates across files still collide, and genuine repeats still survive.

Blank fields do not defeat it: they contribute `''`, which is itself a distinguishing fact, and a
row missing enough fields to make the fingerprint meaningless (no PO number **and** no date **and**
no price) is forced to `NEEDS_REVIEW` by validation code `insufficient_identity`.

`fingerprint_version` is stored so a future v2 rule can be introduced without re-clustering the
past — the same reason `normalizer_version` exists.

### C.3 Level 3 — the source row: `raw_row_hash` + `(source_id, source_row_ordinal)`

Re-parsing a source upserts on `(org_id, source_id, source_row_ordinal)`. If `raw_row_hash` is
unchanged, the raw band is left alone and only the interpreted band is recomputed — which preserves
a reviewer's decisions across a parser upgrade. If the hash changed (a different parser read the
file differently), the row's review state resets to `PENDING` and the previous decision is recorded
as an `INFO` issue (`review_reset_on_reparse`) rather than silently discarded.

### C.4 Soft duplicates — warned, never auto-resolved

| Situation | Code | Behaviour |
| --- | --- | --- |
| Same `(po_number, normalized_description)` as another staging row, differing qty/price/date | `soft_duplicate_conflict` | Both rows → `NEEDS_REVIEW`, each pointing at the other |
| Same `(po_number, normalized_description)` as an accepted legacy line, differing price | `price_conflict_with_history` | `NEEDS_REVIEW`, with both prices shown |
| Same `po_number` as a **native** `purchase_history_lines.po_number` | `shadows_native_history` | `DUPLICATE`, and native wins by default. A reviewer may override to `NEEDS_REVIEW` → accept only with a written reason, which is stored in `decision_note` and copied to the line's `raw` under `_override`. |
| Same fingerprint as another row **in the same batch** | `duplicate_in_batch` | The lowest `(source_row_ordinal, source_id)` stays `VALIDATED`; the rest → `DUPLICATE` with a pointer. Nothing is deleted. |

### C.5 Two source files containing the same PO line

The answer differs by whether the two files *agree*:

* **Byte-identical files** → level 1: second upload creates nothing.
* **Different files, identical line content** → level 2: the second staging row is `DUPLICATE`,
  pointing at the accepted line from the first. The provenance of the accepted line names the file
  it actually came from; the duplicate staging row remains as the record that the other file also
  contained it. Nothing is lost.
* **Different files, conflicting content** (same PO + material, different price or quantity) →
  level C.4: both go to `NEEDS_REVIEW` and a human picks, with both source references in front of
  them. **The importer never picks.** Choosing silently between two contradictory accounts of a
  purchase is exactly how an intelligence feature ends up quietly wrong.

---

## D. The parser boundary

### D.1 Shape

```
bytes/text  ──►  PARSER (format-aware, infrastructure)  ──►  ParseOutput
                                                              │  strings only
ParseOutput ──►  INTERPRETER (pure, domain)             ──►  Interpreted + Issue[]
Interpreted ──►  VALIDATOR (pure, domain)               ──►  Issue[]
Interpreted ──►  DEDUPE (pure fingerprint + repo probe) ──►  status
```

Three boundaries, three modules, one rule each:

* **Parser** knows the *format* and nothing about purchasing. It emits strings.
* **Interpreter** knows purchasing and nothing about formats. It is pure and versioned.
* **Validator** decides whether a row may be accepted. Pure.

This mirrors `domain/material-import.mjs`, which already keeps XLSX/CSV decoding out of the rules.

### D.2 Parser contract

```ts
// domain/legacy-import.mjs exports the SHAPE constants; infrastructure implements.

type ParseInput = {
  sourceKind: 'CSV' | 'XLSX' | 'PDF_TRANSCRIPT' | 'JSON';
  filename: string;
  bytes?: Uint8Array;          // XLSX
  text?: string;               // CSV / JSON, already decoded
  transcript?: TranscribedDocument;   // PDF_TRANSCRIPT (§D.4)
  hints?: {
    delimiter?: string;
    sheet?: string;
    headerRowIndex?: number;   // 0-based; when a sheet has a title band above the header
    columnMap?: Record<string, string>;  // canonical field -> original header, a human override
  };
};

type RawRow = {
  ordinal: number;                       // 1-based, stable, per source
  ref: { sheet?: string; row?: number; page?: number; line?: number; snippet?: string };
  cells: Record<string, string>;         // ORIGINAL header text -> verbatim cell text
  fields: Partial<Record<LegacyField, string>>;   // best-effort assignment; ALL strings
};

type LegacyField =
  | 'poNumber' | 'poDate' | 'vendorName' | 'description' | 'manufacturer' | 'partNumber'
  | 'unit' | 'quantity' | 'unitPrice' | 'extendedPrice' | 'jobNumber' | 'requester'
  | 'lineNumber' | 'notes';

type ParseOutput = {
  parserKey: string;            // 'csv.v1'
  parserVersion: number;
  columnMap: Record<string, string | null>;   // canonical field -> header used (null = unmapped)
  unmappedHeaders: string[];
  rows: RawRow[];
  diagnostics: Issue[];         // source-level, not row-level
};
```

**Parser rules, non-negotiable:**

1. **Strings only.** No numbers, no dates, no booleans, no `null` standing in for zero. Coercion is
   the interpreter's job and it must be versioned.
2. **Never drop a row.** A row it cannot understand is emitted with `fields: {}`, its `cells`
   populated, and an `ERROR` diagnostic. `material-import.mjs` already states why: an import that
   quietly skips 40 of 900 lines is worse than one that fails.
3. **Never invent a row.** Merged cells, repeated PO headers and continuation lines are resolved by
   *copying forward what the file states* (and marking `_carried_forward: true` in `cells`), never
   by inferring a value that does not appear.
4. **`cells` is complete.** Every column of the source row appears, keyed by the original header
   (or `col_3` when there is no header). This is what makes `raw` reconstructible.
5. **Deterministic.** Same bytes → same `ParseOutput`, byte for byte. Tested by fixture hash.

Column-alias mapping reuses and extends `COLUMN_ALIASES` from `domain/material-import.mjs`; the PO
fields (`poNumber`, `poDate`, `jobNumber`, `requester`, `lineNumber`, `extendedPrice`) are new
entries in a sibling `PO_COLUMN_ALIASES`.

### D.3 Interpreter contract

```ts
interpretLegacyRow(raw: RawRow, opts: { orgId, today }) => {
  interpreted: {
    interpretationVersion: number;   // INTERPRETATION_VERSION, bumped when rules change output
    normalizerVersion: number;       // from catalog.mjs
    normalizedDescription: string | null;
    normalizedVendorName: string | null;
    poNumber: string | null;
    jobNumber: string | null;
    unit: string | null;             // normalizeUnit(), extended with /C and /M
    quantity: number | null;
    unitCostMicros: number | null;
    extendedCostMicros: number | null;
    orderedOn: string | null;        // ISO date
    datePrecision: 'DAY'|'MONTH'|'YEAR'|'UNKNOWN';
  };
  issues: Issue[];
}
```

Interpreter rules:

* **Unknown is `null`, never zero.** Same rule `parseMoneyCents` already follows.
* **A partial date is a partial date.** `"2019"` → `ordered_on = null`, `date_precision = 'YEAR'`,
  plus `raw_po_date` intact and an `INFO` issue. It never becomes `2019-01-01`.
  (Open question §M.4: whether a `YEAR`-precision line should be date-anchored for charting.)
* **Ambiguous dates are refused, not guessed.** `03/04/2019` with no other evidence in the source →
  `ERROR date_ambiguous`, `NEEDS_REVIEW`, and the batch offers a source-level "these dates are
  D/M/Y" hint that re-interprets the whole source at once.
* **Price consistency is checked, not corrected.** If `quantity * unitPrice` differs from
  `extendedPrice` by more than one cent, emit `WARNING price_arithmetic_mismatch` and keep **both**
  raw values and both interpreted values. Never back-solve a unit price from an extended price
  unless the unit price is absent — and when it does, `match_basis`-style provenance is recorded as
  an `INFO` issue `unit_price_derived`.
* **Per-C / per-M pricing.** `unit` of `C`/`M` with a price is stored as the price **as quoted**,
  with the unit; the read model divides. Rewriting `$120/C` to `$1.20/ea` at import time would
  destroy the fact that the vendor quoted per hundred.

### D.4 PDFs

**OCR internals are out of scope.** The design instead makes the transcript a first-class,
hashed, reviewable artefact:

1. The PDF is uploaded as a source with `source_kind = 'PDF'`. It is stored and hashed. It is
   **never parsed** by PCC and produces no staging rows.
2. A transcript is produced *outside* the commit path — by a person, a vision model, or a vendor
   tool — as a JSON document conforming to `TranscribedDocument`, and uploaded as a **second**
   source with `source_kind = 'PDF_TRANSCRIPT'` and `derived_from_source_id` pointing at the PDF.
3. `pdf-transcript.v1` parses that JSON. Every row's `ref` carries `{page, line, snippet}`.
4. **Every `PDF_TRANSCRIPT` row starts in `NEEDS_REVIEW`, unconditionally.** A transcription is a
   claim about a document, and no claim about a document becomes evidence without a human who
   looked at both. The review screen shows the snippet and links to the PDF page.

```ts
type TranscribedDocument = {
  schema: 'pcc.legacy-po.transcript.v1';
  sourceFilename: string;      // the PDF this describes
  sourceSha256: string;        // MUST equal the PDF source's hash — checked at upload
  transcriber: string;         // free text: who or what produced it
  transcribedAt: string;
  pages: Array<{
    page: number;
    header?: Partial<Record<LegacyField, { text: string; confidence?: number }>>;
    lines: Array<{
      line: number;
      snippet: string;                                   // the verbatim text of the line
      fields: Partial<Record<LegacyField, { text: string; confidence?: number }>>;
    }>;
  }>;
};
```

The `sourceSha256` check is what stops a transcript being silently attached to a different PDF.

### D.5 Where raw survives

Raw text is written **three** times on purpose, and each copy has a different job:

| Copy | Job |
| --- | --- |
| The file, in Storage | The artefact. Re-parseable forever. |
| `staging_rows.raw` (+ the `raw_*` columns) | The workbench's account of what the parser read. |
| `legacy_lines.raw` (+ the `raw_*` columns) | The evidence, frozen. Survives the batch being abandoned, the source being deleted, and the parser being rewritten. |

Denormalizing raw onto the accepted line is deliberate. A committed record whose raw values are only
reachable through a mutable staging row is a mutable record wearing an immutable name — the same
defect `0030` fixed for the view.

### D.6 Issue code vocabulary (closed set, in `domain/legacy-import.mjs`)

```
ERROR:    no_description | unreadable_row | quantity_unparseable | price_unparseable
          | date_ambiguous | insufficient_identity | negative_quantity
          | transcript_hash_mismatch | column_map_missing_required
WARNING:  soft_duplicate_conflict | duplicate_in_batch | price_conflict_with_history
          | price_arithmetic_mismatch | unit_unrecognised | vendor_ambiguous
          | material_ambiguous | job_not_in_directory | requester_not_a_user
          | missing_po_number | missing_job_number | future_dated | very_old
WARNING:  shadows_native_history
INFO:     date_precision_reduced | unit_price_derived | value_carried_forward
          | unmapped_columns | review_reset_on_reparse | vendor_matched_exact
```

`ERROR` blocks acceptance. `WARNING` forces `NEEDS_REVIEW` but can be accepted by a human. `INFO`
is recorded and does not gate.

---

## E. Staging and review workflow

### E.1 The flow

```
1  CREATE BATCH        label + purpose                        [reversible: abandon]
2  UPLOAD SOURCE       hash, store, dedupe by hash            [reversible while OPEN]
3  PARSE               ParseOutput -> staging rows            [reversible: re-parse]
4  INTERPRET           typed values + rule versions           [reversible: re-parse]
5  VALIDATE            issues -> VALIDATED | NEEDS_REVIEW     [reversible]
6  DEDUPE SCAN         fingerprints -> DUPLICATE              [reversible]
7  MATCH PROPOSE       ranked vendor / catalog proposals      [reversible]
8  HUMAN REVIEW        fix mapping, confirm matches, reject   [reversible]
9  ACCEPT (COMMIT)     write legacy lines                     ** IRREVERSIBLE **
10 CLOSE BATCH         COMMITTED or ABANDONED                 ** IRREVERSIBLE **
```

### E.2 Steps 1–3, in detail

* **Upload** computes sha256 client-side-or-server-side (server is authoritative), stores the object
  under `{org_id}/{batch_id}/{sha}`, inserts the source. On hash collision within the org, no insert:
  return the existing source and a `duplicate_source` notice naming the batch it is already in.
* **Parse** runs the format adapter, then upserts staging rows in one unit of work per source. A
  parse never partially applies: either every row of the source is upserted, or none is
  (`ctx.uow.run` locally; a single `parse_purchase_import_source()` RPC on Supabase).
* **A parse that throws** sets `parse_status = 'FAILED'` with the message and leaves prior staging
  rows untouched. Retry is a button, not a re-upload.

### E.3 The review screen (what it must show)

Per row: raw values on the left, interpreted values on the right, issues under both, source
reference (sheet/row or page/line + snippet) always visible, and — where a match is proposed — the
top three candidates with their scores and methods.

Per batch: counts by status, the unmapped-header list, a column-mapping editor that re-interprets
the whole source, and a "date format for this source" control.

Bulk actions permitted: accept all `VALIDATED`; reject all with a given issue code; apply one vendor
match to every row with the same `normalized_vendor_name`. Bulk **acceptance of `NEEDS_REVIEW` rows
is not permitted** — that is the one action that would make the review theatre.

### E.4 Acceptance (the irreversible step)

One server-side operation per batch of rows, on Supabase a single RPC
`commit_purchase_import_rows(p_batch_id uuid, p_row_ids uuid[])`, mirroring the existing
`AtomicOperations` idiom (`record_purchase_decision`, `record_receipt`). It:

1. takes a transaction-scoped advisory lock on the batch (`pg_advisory_xact_lock(hashtextextended(batch_id::text, 0))`);
2. re-reads each row `for update` and re-checks: status is `VALIDATED`, no `ERROR` issue,
   fingerprint not already present, batch not closed;
3. inserts the legacy lines;
4. sets `status = 'ACCEPTED'`, `committed_legacy_line_id`, `decided_by`, `decided_at`;
5. sets `batch.first_committed_at` if unset;
6. returns `{committed, skipped, conflicts[]}`.

Step 2 is a re-check, not the only check — the application checked already. Defence in depth, the
same rationale `ports.ts` gives for the atomic RPCs.

The local provider does the same inside `ctx.uow.run`, which serializes.

### E.5 Reversible vs irreversible

| Operation | Reversible? | How / why not |
| --- | --- | --- |
| Create batch | Yes | Abandon it |
| Upload source | Yes, while `OPEN` and no accepted rows | Delete source (cascades staging rows, leaves the stored object) |
| Parse / re-parse | Yes | Re-runs; accepted rows untouchable |
| Edit column mapping, date-format hint | Yes | Triggers re-interpretation |
| Edit interpreted value by hand | Yes, until accepted | Recorded as an issue `INFO manual_override` with old and new |
| Propose / confirm a match | Yes, until accepted | Overwrites `matched_*` |
| Reject a row | Yes, while batch open | Back to `NEEDS_REVIEW` |
| **Accept a row** | **No** | Writes an immutable line. The four fences refuse UPDATE and DELETE. |
| **Close batch** | **No** | Terminal by trigger |
| Change a match after commit | Yes — and it does not touch the record | New `purchase_legacy_match_decisions` row |

### E.6 Correcting an accepted line

There is no edit and no delete. The policy, stated once here because people will ask:

1. **A wrong match** — record a new match decision. The evidence was never wrong.
2. **A wrong interpretation** (misread price, wrong date) — the raw text is right and the
   interpretation is wrong: fix the interpreter, bump `INTERPRETATION_VERSION`, and re-import the
   source into a **new batch**. The new line has a different fingerprint (its interpreted values
   differ), so it inserts; the old line is superseded by an explicit
   `purchase_legacy_import_supersessions` row — *deferred to milestone 2G, not built in 2A*, and
   until it exists, the read model shows both and the reviewer's `decision_note` explains.
3. **A line that should never have been imported** (wrong company's data, a quote mistaken for a PO)
   — the only sanctioned removal path is an admin-run migration, reviewed like any other, with the
   reason in the migration header. This is intentionally as hard as removing native history.

---

## F. Matching strategy

### F.1 What matching is, and is not

Matching produces a **pointer from evidence to a current directory entity**. It never changes the
evidence. `raw_vendor_name = "GRAYBAR ELECT."` stays `"GRAYBAR ELECT."` whether or not it is matched
to the vendor now called "Graybar Electric Company, Inc."

### F.2 Candidate generation (`domain/legacy-match.mjs`, pure)

Given raw text and the organization's directory rows (supplied by the repository — the domain does
no I/O), produce ranked proposals:

| Tier | Method | Score | Auto-apply? |
| --- | --- | --- | --- |
| 0 | `exact_normalized` — normalized forms are equal and **exactly one** candidate matches | 1.0 | **Yes** |
| 1 | `alias` — matches a curated alias exactly, exactly one candidate | 0.9 | No |
| 2 | `prefix` | 0.7 | No |
| 3 | `fuzzy` — trigram / token overlap above 0.55 | score | No |

**The only auto-applied tier is 0, and only when the match is unique.** Two candidates at tier 0
(two vendors normalizing to the same name — which is itself a directory defect) is
`vendor_ambiguous`, `NEEDS_REVIEW`, no auto-apply. This is rule 6, made mechanical.

Vendor normalization for matching is a *separate* function from material normalization: it strips
corporate suffixes (`inc`, `llc`, `co`, `corp`, `company`, `ltd`, `&`, `and`) and punctuation. That
key is stored as `normalized_vendor_name` and participates in the fingerprint, so it too gets a
version (`VENDOR_NORMALIZER_VERSION`).

Material matching reuses `normalizeDescription` from `catalog.mjs` unchanged — the same key the
catalog clusters native history under, which is what makes legacy and native lines land on the same
catalog entry at all.

### F.3 Creating directory entries from imports

Permitted, never automatic. The review screen may offer "create vendor «GRAYBAR ELECT.»" as a
proposal with `target_id = null`. Accepting it creates a `purchase_vendors` row through the existing
`reference.createVendor` use case (so the normal permission, audit and validation apply) and then
matches to it. Jobs likewise, through `reference.createJob`.

Rule: **importing never creates a directory entry as a side effect of committing a line.** A line
with no vendor match commits with `vendor_id = null`, which is an honest statement.

### F.4 Match-assist later, without corrupting evidence

The design leaves room for a better matcher (embedding similarity, a model, a vendor-catalog feed)
because nothing about matching is baked into the evidence:

* proposals are a derived table, recomputed at will;
* the applied match is a *pointer column* plus an append-only decision stream;
* every decision carries `basis`, `decided_by`, `decided_at` and `note` — so "which of these matches
  did a human actually look at" is answerable forever;
* a future bulk re-matcher writes `basis = 'bulk_human_confirmed'` only for matches a human approved
  in bulk, and `'model_suggested'` proposals never become decisions without one.

The audit question that must stay answerable: *for any legacy line, who said it refers to this
vendor, when, and on what basis?* The decision table answers it by construction.

---

## G. Read model

### G.1 The union view

```sql
create view purchase_history_unified as
select 'NATIVE'::text as origin, ... from purchase_history_lines
union all
select 'LEGACY'::text as origin, ... from purchase_history_legacy_lines l
  left join lateral (
    select target_id from purchase_legacy_match_decisions d
     where d.org_id = l.org_id and d.legacy_line_id = l.id and d.target_kind = 'VENDOR'
     order by d.decided_at desc limit 1
  ) vd on true
  ...
;

-- REQUIRED, and in exactly this form. `scripts/eval-purchasing-isolation.mjs`
-- matches the statement `alter view <name> set (security_invoker = on)` — the
-- inline `with (...)` spelling passes Postgres and FAILS the suite, and a view
-- without it runs as its owner, which bypasses RLS entirely (0019 §1).
alter view purchase_history_unified set (security_invoker = on);
```

**Common columns** (the contract other code reads):

```
origin              'NATIVE' | 'LEGACY'
line_id             uuid
org_id              uuid
normalized_description, normalizer_version
description_shown   requested/ordered description (native) | raw_material_description (legacy)
unit
quantity            ordered_qty (native) | quantity (legacy)
unit_cost_micros    round(coalesce(actual,estimated)*1e6) (native) | unit_cost_micros (legacy)
cost_basis          'ACTUAL' | 'ESTIMATED' | 'LEGACY_QUOTED' | null
vendor_id           vendor_id | effective legacy vendor decision
vendor_name_shown   vendor_name (native) | raw_vendor_name (legacy)
catalog_item_id     catalog_item_id | effective legacy catalog decision
job_number
po_number
occurred_on         ordered_at::date (native) | ordered_on (legacy)
date_precision      'DAY' (native) | legacy date_precision
is_purchase         wasActuallyOrdered (native) | true (legacy: a PO is a purchase)
is_price_evidence   native: ordered and priced | legacy: unit_cost_micros is not null and quantity > 0
provenance          jsonb: {requestId,...} | {batchId, sourceId, filename, sha256, rowRef}
```

**What the view resolves at read time, and why that is allowed here.** Only the *match opinion*
(vendor/catalog/job decision). Every value that is *evidence* is a stored snapshot on both sides.
This is the exact inverse of the defect `0030` removed: there, the snapshot was resolved at read
time; here, the opinion is — and an opinion is supposed to be current.

### G.2 Derived intelligence

All of it is a query. Nothing is stored.

| Feature | Rule |
| --- | --- |
| **Frequency** | `score = nativeOrderedCount + LEGACY_WEIGHT * legacyLineCount`, `LEGACY_WEIGHT = 0.5`, a named constant in `domain/history-intelligence.mjs`. Legacy counts less because a legacy row is one line on one document, unverified by receiving. |
| **Demand vs purchase** | Unchanged from `history.mjs`: native rows count as demand always and as purchase only when actually ordered. Every legacy row is a purchase (a PO existed) and is **not** demand evidence for the request funnel, because there was no PCC request. Reports that count "requests raised" must filter `origin = 'NATIVE'`. |
| **Last vendor** | Most recent **native** ordered line wins whenever one exists in the same `normalized_description`. Legacy answers only when native is silent. The answer always carries `origin` and `occurred_on`, and the UI must render both ("last bought from Graybar — imported history, Mar 2021"). |
| **Price observations** | A list, never a single blended average across origins. Each observation carries `origin`, `occurred_on`, `date_precision`, `cost_basis`, `unit_cost_micros`. When both exist, native and legacy are reported as two series. A single "last price" answer prefers the most recent native `ACTUAL`, then native `ESTIMATED`, then legacy. |
| **Common units** | Mode over the union; ties broken toward native. A unit seen only in legacy is offered but flagged. |
| **Common quantities** | Mode over the union, rounded to the nearest sensible step; native-only when native has ≥ 5 observations. |
| **Autocomplete** | `rankMaterialMatches` in `catalog.mjs` is unchanged in shape; `timesRequested` becomes the blended score above and a new `originMix: {native, legacy}` field rides along so the control can show "· 42 past orders (38 imported)". |
| **Vendor–material relationships** | Union, with the same weighting. A vendor's materials list shows imported associations distinctly. |

**When native is preferred, stated once:** whenever native and legacy both answer the *same question
about the same material*, native wins — it is first-hand, it went through receiving, and its prices
have an invoice behind them. Legacy widens coverage; it never overrules.

**A hard UI rule:** legacy data may never silently pre-fill a field that commits money (a unit price
on a new PO) without displaying its origin and date. Suggesting is fine; suggesting *anonymously*
is how a 2019 price becomes a 2026 purchase order.

### G.3 Repository surface

New port, both providers, following `PurchaseHistoryRepository`:

```ts
export interface LegacyHistoryRepository {
  record(lines: LegacyHistoryLineRecord[], now: string): Promise<{ inserted: number; skipped: number }>;
  forBatch(orgId: Id, batchId: Id, options?): Promise<LegacyHistoryLineRecord[]>;
  listForOrg(orgId: Id, options?: { limit?, normalizedDescription?, vendorId?, poNumber? }): Promise<LegacyHistoryLineRecord[]>;
  findByFingerprint(orgId: Id, fingerprints: string[]): Promise<Array<{ fingerprint: string; id: Id }>>;
  recordMatchDecision(decision: LegacyMatchDecisionRecord): Promise<void>;
  matchDecisionsFor(orgId: Id, legacyLineIds: Id[]): Promise<LegacyMatchDecisionRecord[]>;
}

export interface UnifiedHistoryRepository {
  list(orgId: Id, options?: { origin?: 'NATIVE'|'LEGACY'; normalizedDescription?; vendorId?; since?; limit? }): Promise<UnifiedHistoryRow[]>;
  materialProfile(orgId: Id, normalizedDescription: string): Promise<MaterialProfile>;  // §G.2 answers, per material
}
```

`record` is idempotent by `(orgId, staging_row_id)` and by `(orgId, content_fingerprint)`, and must
not raise on a duplicate — the same contract `PurchaseHistoryRepository.record` already has, for the
same reason.

---

## H. Security and RLS

### H.1 New permissions

Added to `PERMISSIONS` in `domain/roles.mjs` **and** inserted into `purchasing_role_permissions` in
migration `0034` — both, because `purchasing_can()` reads the table and the application reads the
module, and a permission in only one place is enforced in only one place.

| Permission | Meaning |
| --- | --- |
| `import.upload` | Create a batch, upload and delete sources, run a parse |
| `import.review` | Read staging rows, edit interpretation, propose and confirm matches, reject rows |
| `import.accept` | Commit rows into `purchase_history_legacy_lines`; close a batch |

Reading committed legacy history needs **no new permission**: it uses `request.read.all`, the same
permission native history and the catalog use.

Proposed role mapping:

| Role | upload | review | accept | read legacy history |
| --- | --- | --- | --- | --- |
| REQUESTOR | – | – | – | – (only via catalog suggestions) |
| FOREMAN | – | – | – | – |
| OFFICE | ✅ | ✅ | – | ✅ |
| ACCOUNTING | – | – | – | ✅ |
| WORKSHOP_APPROVER | ✅ | ✅ | ✅ | ✅ |
| ADMIN | ✅ | ✅ | ✅ | ✅ |

(Whether OFFICE should also accept is open — §M.1.)

### H.2 Policies, table by table

Every policy is `org_id = current_org_id()` **and** the relevant capability. No policy is
`using (true)`; no policy on an append-only table is `for all`.

| Table | SELECT | INSERT | UPDATE | DELETE | TRUNCATE |
| --- | --- | --- | --- | --- | --- |
| `purchase_import_batches` | org + `import.review` | org + `import.upload`, `created_by = auth.uid()` | org + `import.upload`, and only while not closed (trigger) | – | revoked |
| `purchase_import_sources` | org + `import.review` | org + `import.upload`, `uploaded_by = auth.uid()` | org + `import.upload`, parse fields only (trigger) | org + `import.upload`, only while batch `OPEN` and no accepted row (trigger) | revoked |
| `purchase_import_staging_rows` | org + `import.review` | org + `import.upload` | org + `import.review`, refused when `ACCEPTED` (trigger) | org + `import.upload`, refused when `ACCEPTED` (trigger) | revoked |
| `purchase_import_row_issues` | org + `import.review` | org + `import.review` | – | org + `import.review` (derived data) | revoked |
| `purchase_import_match_proposals` | org + `import.review` | org + `import.review` | – | org + `import.review` (derived data) | revoked |
| `purchase_history_legacy_lines` | org + `request.read.all` | org + `import.accept` + `accepted_by = auth.uid()` + the staging row is in this org and `VALIDATED` | **none** | **none** | revoked + `guard_no_truncate` |
| `purchase_legacy_match_decisions` | org + `request.read.all` | org + `import.review` + `decided_by = auth.uid()` | **none** | **none** | revoked + `guard_no_truncate` |

Grants (the outermost fence, per `0031`):

```sql
grant select, insert on public.purchase_history_legacy_lines to authenticated;
revoke update, delete on public.purchase_history_legacy_lines from authenticated, anon, service_role;
revoke all on public.purchase_history_legacy_lines from anon;
-- identical block for purchase_legacy_match_decisions
grant select, insert, update, delete on public.purchase_import_row_issues to authenticated;
grant select, insert, update, delete on public.purchase_import_match_proposals to authenticated;
grant select, insert, update, delete on public.purchase_import_staging_rows to authenticated;
grant select, insert, update, delete on public.purchase_import_sources to authenticated;
grant select, insert, update on public.purchase_import_batches to authenticated;
```

`service_role` is never granted anything on the legacy history or decision tables, for the reason
`0031` gives: it bypasses RLS, and `accepted_by` would stop meaning anything.

The INSERT policy on `purchase_history_legacy_lines` mirrors `0033`:

```sql
create policy purchase_history_legacy_lines_insert on purchase_history_legacy_lines
  for insert with check (
    org_id = current_org_id()
    and accepted_by = auth.uid()
    and purchasing_can(auth.uid(), 'import.accept')
    and exists (
      select 1 from purchase_import_staging_rows s
       where s.id = staging_row_id
         and s.org_id = current_org_id()
         and s.status = 'VALIDATED'
    )
  );
```

`0032`'s TRUNCATE default-privilege revoke already covers new tables; the four
`before truncate ... guard_no_truncate()` triggers are added explicitly for
`purchase_history_legacy_lines` and `purchase_legacy_match_decisions`.

### H.3 Storage policies

```sql
create policy purchasing_import_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'purchasing-imports'
              and (storage.foldername(name))[1] = current_org_id()::text
              and purchasing_can(auth.uid(), 'import.upload'));

create policy purchasing_import_read on storage.objects
  for select to authenticated
  using (bucket_id = 'purchasing-imports'
         and (storage.foldername(name))[1] = current_org_id()::text
         and purchasing_can(auth.uid(), 'import.review'));
```

No UPDATE and no DELETE policy: an uploaded artefact is not edited, and deleting a source deletes
the row, not the bytes. (Object retention is §M.6.)

### H.4 Can accepted legacy history ever be edited or deleted?

**No** — not by the application, not by a signed-in admin, not by `service_role`, not by
`TRUNCATE`. The only path is a reviewed migration, which is a code change with a header explaining
itself. Same standing as native history.

---

## I. Failure modes

| # | Failure | Expected behaviour |
| --- | --- | --- |
| 1 | **Same file uploaded twice** | `unique (org_id, content_sha256)` — no new source, no new rows. Response names the batch it already belongs to. |
| 2 | **Two exports overlap in date range** | Different hashes → both parse. Overlapping lines collide on `content_fingerprint`: the second is `DUPLICATE` with a pointer. Nothing double-counts. |
| 3 | **Malformed file** (not CSV, corrupt XLSX, truncated zip) | Parse fails: `parse_status = 'FAILED'`, message stored, **zero** staging rows. Upload is retained (the bytes are evidence of what was sent). Retry available. |
| 4 | **Partial parsing** (30 good rows, 12 unreadable) | All 42 rows exist. The 12 carry `ERROR unreadable_row` and sit in `NEEDS_REVIEW`. The batch cannot reach `COMMITTED` until each is accepted or rejected. Never silently skipped. |
| 5 | **Corrupted file that parses into garbage** | Validation catches it row-wise (`insufficient_identity`, `quantity_unparseable`). If more than 25% of rows carry an `ERROR`, the source is flagged `WARNING source_quality_low` at batch level and bulk-accept is disabled for that source. |
| 6 | **Wrong vendor match** | Pre-commit: reviewer changes `matched_vendor_id`. Post-commit: a new `purchase_legacy_match_decisions` row. Evidence untouched either way; the trail shows who changed what and when. |
| 7 | **Wrong material match** | Same as 6 for `CATALOG_ITEM`. Note that the *normalized description* is not a match — it is interpretation — so a wrong catalog match never re-clusters history. |
| 8 | **Missing PO number** | Allowed. `WARNING missing_po_number`, `NEEDS_REVIEW`. Fingerprint uses `''` for it. If date **and** price are also missing, `ERROR insufficient_identity` — the line cannot be deduplicated and therefore cannot be trusted not to double-count. |
| 9 | **Missing job number** | Allowed and common. `WARNING missing_job_number` only when the source elsewhere supplies job numbers (so a genuinely job-less export does not produce 4,000 warnings). Never inferred from a neighbouring line. |
| 10 | **Conflicting prices for the same PO line across sources** | `price_conflict_with_history` / `soft_duplicate_conflict` → `NEEDS_REVIEW` on both, with both values and both source references. The importer never picks. |
| 11 | **Mixed units for the same material** (`EA` vs `BOX` vs `C`) | Both are kept exactly as written. `normalizeUnit` maps known spellings; unknown → `WARNING unit_unrecognised` and the raw unit is stored as the unit. The read model **never sums quantities across different units** — `materialProfile` returns per-unit buckets. |
| 12 | **Parser retry after a parser upgrade** | Upsert by `(source_id, source_row_ordinal)`. Unchanged `raw_row_hash` → review decisions preserved, interpretation recomputed. Changed hash → row resets to `PENDING` + `INFO review_reset_on_reparse`. `ACCEPTED` rows are refused by trigger; the parse reports how many it could not touch. |
| 13 | **Interrupted import** (crash mid-commit) | Commit is one transaction/RPC. Either every named row committed or none. On retry, the `(org_id, staging_row_id)` unique key makes already-written lines skip. `{committed, skipped}` is returned so the operator sees the truth. |
| 14 | **Two users reviewing the same batch** | Row edits use optimistic `version`; a stale write fails with `conflict` and the UI re-reads. Commit takes a batch-scoped advisory lock, so two simultaneous commits serialize; the loser sees rows already `ACCEPTED` and reports them as `skipped`. |
| 15 | **A legacy PO that also exists in native history** (cutover overlap) | `shadows_native_history` → `DUPLICATE` by default. Native wins. Accepting anyway requires an explicit reason, stored. |
| 16 | **Transcript attached to the wrong PDF** | `sourceSha256` mismatch → `ERROR transcript_hash_mismatch` at upload; the source is created with `parse_status = 'FAILED'` and produces no rows. |
| 17 | **A source is deleted after rows were accepted** | Refused by trigger. Provenance must remain resolvable. |
| 18 | **Batch abandoned with some rows committed** | Allowed, requires a reason. Committed lines stay. The batch records that it was abandoned, so a later reader knows the import is incomplete rather than assuming the file was fully processed. |
| 19 | **Vendor renamed after import** | Nothing changes: `raw_vendor_name` is the evidence, `vendor_id` is the pointer. Exactly the `0030` guarantee, extended to legacy. |
| 20 | **A future-dated or absurdly old PO** (`2035`, `1974`) | `WARNING future_dated` / `WARNING very_old` → `NEEDS_REVIEW`. Not refused: a typo in a source is a fact about the source. |
| 21 | **Requester name that matches no user** | `WARNING requester_not_a_user`. `raw_requester` kept; `requester_user_id` stays null. Never auto-created. |
| 22 | **Very large file** (50k rows) | Parse is chunked and reports progress; the staging upsert is batched (1,000 rows per statement). A per-source cap (`MAX_ROWS_PER_SOURCE = 100_000`) fails the parse loudly rather than half-importing. |

---

## J. Test strategy

Nothing ships without these. They extend the existing suites rather than creating a parallel one —
`apps/purchasing` `npm test` must run them all.

### J.1 Domain tests — `scripts/eval-legacy-import.mjs` (+ `.sh`, wired into `test:unit`)

* `INTERPRETATION_VERSION` and `VENDOR_NORMALIZER_VERSION` exist and are integers.
* Interpreter: unknown → `null`, never `0`; `"$1,234.56"` → `1_234_560_000` micros; `"0.1234"` →
  `123_400`; `"12 EA"` quantity/unit split; per-C and per-M units preserved.
* Dates: `"2019"` → `null` + `YEAR`; `"03/04/2019"` → `date_ambiguous`; `"2019-03-04"` → `DAY`.
* Fingerprint: stable across runs; changes when any component changes; identical for the same line
  read from two differently-formatted sources; `occurrence_index` distinguishes genuine repeats.
* Issue codes emitted are all members of the closed vocabulary.
* Status machine: every legal transition allowed, every illegal one refused with a named reason
  (mirrors the `status.mjs` test style).
* `NEEDS_REVIEW` can never be accepted; `PDF_TRANSCRIPT` rows always start in `NEEDS_REVIEW`.
* Matching: unique tier-0 auto-applies; two tier-0 candidates do not; nothing else auto-applies.
* Read model: `LEGACY_WEIGHT` applied; native preferred for last-vendor; quantities never summed
  across units; price observations never blended across origins.

### J.2 Parser contract tests — same script, over `fixtures/legacy-po/`

* Every parser satisfies the contract: strings only, no dropped rows, `cells` complete,
  deterministic (assert a hash of `ParseOutput` per fixture).
* One fixture per hazard: quoted commas, embedded newlines, a title band above the header, merged
  PO-header cells, a continuation line, a totals row, blank rows, a trailing summary block, an
  `#N/A` cell, a European decimal comma, a right-to-left minus, a 5-page PDF transcript.
* Two fixtures encoding the **same** three PO lines in different formats — CSV and XLSX — must
  produce identical fingerprints. This is the test that proves the parser boundary holds.

### J.3 Repository tests — extend `scripts/eval-purchasing-providers.mjs`

* Shape parity for `LegacyHistoryRepository`, `UnifiedHistoryRepository`, and the import
  repositories: same methods, same arity, both providers.
* Every table the Supabase adapter names exists in the migrations (the existing TABLES check).
* Every query constrains by organization (the existing tenancy check).
* Micros round-trip exactly through both mappers.
* No service-role client on any import read or write path.

### J.4 Migration + static tests — extend `scripts/eval-purchasing-isolation.mjs`

**Required, easy to forget:** add `0034_purchasing_legacy_import.sql` — and, in 2E,
`0036_purchasing_history_unified.sql` — to the `sql` file list at the top of that script. That list
is a fixed array of filenames; a table or view in a migration not on it is checked by nothing. The
script's own comment (above the `0030` entry) says exactly this.

New assertions:

* every new tenant-owned table has RLS enabled and at least one org-scoped policy;
* `purchase_history_legacy_lines` and `purchase_legacy_match_decisions` have **no** `for update`,
  `for delete` or `for all` policy;
* both are granted `select, insert` and never `update`/`delete`, and never to `service_role`;
* both carry `no_update`, `no_delete` and `no_truncate` triggers;
* the legacy INSERT policy requires `accepted_by = auth.uid()` and `import.accept`;
* **no migration ever inserts into `purchase_history_lines` from an import path** — a regex check
  that `purchase_history_lines` appears in `0034` only in read/duplicate-detection contexts;
* `purchase_history_unified` is declared `security_invoker = on`;
* the three new permissions appear in both `roles.mjs` and `purchasing_role_permissions`.

### J.5 Live RLS tests — `supabase/tests/legacy_import_isolation.sql`

Same shape as `tenant_isolation.sql` (two orgs, JWT claims, rollback at the end):

* org B cannot see org A's batches, sources, staging rows, issues, proposals, legacy lines or match
  decisions;
* org B cannot insert a staging row referencing org A's batch (composite FK), nor a legacy line
  referencing org A's staging row;
* a user with `import.review` but not `import.accept` is refused the legacy-line insert;
* a user cannot insert a legacy line with `accepted_by` set to a colleague;
* a user cannot insert a legacy line for a staging row that is not `VALIDATED`;
* UPDATE, DELETE and TRUNCATE on `purchase_history_legacy_lines` all fail — three separate
  assertions, because they fail for three different reasons;
* the **negative control**: with RLS disabled, the cross-tenant reads succeed (proving the suite
  can detect a leak).

### J.6 Dedup + idempotency tests — integration, `scripts/eval-purchasing.mjs`

* Upload the same bytes twice → one source, zero extra rows.
* Parse the same source twice → same staging row count, same ids, decisions preserved.
* Commit the same row list twice → second call reports all `skipped`, one legacy line.
* Import file A then file B where B ⊃ A → only the non-overlapping lines commit.
* Import B then A (reverse order) → same final set of lines. Order-independence is the property.
* Two concurrent commits of overlapping row lists → exactly one line per fingerprint.

### J.7 Staging-state and acceptance tests

* Every illegal transition refused with a named reason.
* `ACCEPTED` rows refuse UPDATE and DELETE in both providers.
* A batch cannot reach `COMMITTED` while a row is `PENDING`, `VALIDATED` or `NEEDS_REVIEW`.
* An abandoned batch with committed rows keeps them, and records the reason.

### J.8 Native-history non-regression

The point of the whole design, asserted mechanically:

* the full existing suite (`npm test -w purchasing`) passes unchanged;
* after a legacy import of N lines, `select count(*) from purchase_history_lines` is unchanged;
* no import code path imports `application/history.ts` or references
  `PurchaseHistoryRepository.record` (a static grep assertion, like the existing service-role
  check);
* a native completion still writes native history while a batch is mid-review;
* catalog suggestions for a material with **no** legacy data are byte-identical before and after the
  import feature exists (a golden-output test).

---

## K. Implementation plan

Each milestone is independently shippable, independently green, and ends at a stated stop.

---

### 2A — Schema and domain model

**Objective.** The tables exist, in both providers, with tenancy and immutability proven. No
parsing, no UI, no write path.

**Files**

* `supabase/migrations/0034_purchasing_legacy_import.sql` (new)
* `apps/purchasing/src/purchasing/infrastructure/sqlite/database.ts` (mirror the tables + triggers)
* `apps/purchasing/src/purchasing/domain/repositories.ts` (record types + repository interfaces,
  types only)
* `apps/purchasing/src/purchasing/domain/legacy-import.mjs` (new: statuses, transitions, issue-code
  vocabulary, `INTERPRETATION_VERSION`, field lists — pure constants and predicates, no parsing yet)
* `apps/purchasing/src/purchasing/domain/roles.mjs` (three new permissions + role mapping)
* `scripts/eval-purchasing-isolation.mjs` (add `0034` to the file list; new assertions from §J.4)
* `scripts/eval-legacy-import.mjs` + `.sh` (new; status machine and constants only)
* `apps/purchasing/package.json` (`test:legacy-import` in the `test` chain)
* `supabase/tests/legacy_import_isolation.sql` (new)
* `docs/PURCHASING_HISTORY_AND_CATALOG.md` (a new section pointing at this document)

**Acceptance criteria**

1. `supabase db reset` replays every migration from empty and succeeds.
2. `supabase/tests/legacy_import_isolation.sql` passes against local Postgres, **and its negative
   control reports leaks** when RLS is disabled.
3. `npm test -w purchasing` green, including the extended isolation and providers suites.
4. `purchase_history_lines` row count and behaviour unchanged (§J.8).
5. Every new tenant-owned table: RLS on, org-scoped policies, composite FKs, TRUNCATE revoked.
6. `purchase_history_legacy_lines` and `purchase_legacy_match_decisions` refuse UPDATE, DELETE and
   TRUNCATE from `authenticated` and from `service_role`.

**Stop.** No parser, no repository implementations beyond what the shape-parity test requires, no
route, no screen. Stop when the schema is proven and the domain constants exist.

---

### 2B — Parser contract and fixture corpus

**Objective.** `bytes → ParseOutput` for CSV, XLSX and PDF transcript, plus the interpreter and
validator, all tested against a fixture corpus. Still nothing writes to the database.

**Files**

* `apps/purchasing/src/purchasing/domain/legacy-import.mjs` (interpreter, validator, issue codes)
* `apps/purchasing/src/purchasing/domain/legacy-fingerprint.mjs` (new: canonical tuple + sha256;
  takes a hashing function so the domain stays free of `node:crypto`)
* `apps/purchasing/src/purchasing/domain/values.mjs` (new: `normalizeUnit`, money parsing, date
  parsing — **moved** out of `material-import.mjs`, which re-exports them so nothing breaks)
* `apps/purchasing/src/purchasing/infrastructure/parsers/csv.ts` (wraps existing `parseDelimited`)
* `apps/purchasing/src/purchasing/infrastructure/parsers/xlsx.ts`
* `apps/purchasing/src/purchasing/infrastructure/parsers/pdf-transcript.ts`
* `apps/purchasing/src/purchasing/infrastructure/parsers/index.ts` (registry: `sourceKind → parser`)
* `fixtures/legacy-po/**` (the corpus of §J.2)
* `scripts/eval-legacy-import.mjs` (parser contract + interpreter + fingerprint gates)

**Decision to make here, not later:** XLSX needs a dependency or a hand-rolled reader. The PDF
writer was hand-rolled for a stated reason (no npm install on a workshop PC). An XLSX *reader* is a
zip + XML parse and is a different risk. **Recommendation:** hand-roll a minimal reader
(`.xlsx` = zip + `sharedStrings.xml` + `sheet1.xml`, values only, no formulas, no styles beyond the
date-format flag) so the offline constraint holds. Fall back to a single well-scoped dependency only
if the corpus proves the hand-rolled reader inadequate — and record that in the decision log.

**Acceptance criteria**

1. Every fixture parses deterministically (hash-asserted).
2. CSV and XLSX encodings of the same three PO lines produce **identical fingerprints**.
3. No parser emits a non-string field value; no parser drops a row (asserted structurally).
4. Every issue code emitted is in the closed vocabulary.
5. `npm test -w purchasing` green.

**Stop.** No database writes, no routes, no UI.

---

### 2C — Staging and validation

**Objective.** Upload → store → parse → stage → validate → dedupe-scan, end to end, both providers.
Read-only review API. No acceptance.

**Files**

* `apps/purchasing/src/purchasing/application/imports.ts` (new use cases: `createImportBatch`,
  `uploadImportSource`, `parseImportSource`, `revalidateImportSource`, `importBatchOverview`,
  `importStagingRows`)
* `apps/purchasing/src/purchasing/infrastructure/sqlite/repositories.ts`
* `apps/purchasing/src/purchasing/infrastructure/supabase/repositories.ts` (+ `TABLES`, `mappers.ts`)
* `apps/purchasing/src/purchasing/composition.ts`, `infrastructure/supabase/context.ts` (wire the
  new repositories)
* `apps/purchasing/src/purchasing/application/ports.ts` (an `ImportStoragePort` for the bucket)
* `apps/purchasing/src/app/api/imports/**` (upload + parse routes, `requireAccess`-guarded)

**Acceptance criteria**

1. Uploading the same bytes twice creates one source (both providers).
2. Parsing twice is a no-op on staging row identity and preserves decisions.
3. Issues and proposals are recomputed, not accumulated.
4. Dedupe scan marks in-batch duplicates and native shadows correctly.
5. Cross-tenant: org B cannot read or parse org A's source, through the application and through
   PostgREST.
6. `npm test -w purchasing` green; integration suite covers §J.6 cases 1–2.

**Stop.** No accept button, no legacy-line writes.

---

### 2D — Review and acceptance

**Objective.** The human workflow, and the one irreversible operation.

**Files**

* `apps/purchasing/src/purchasing/application/imports.ts` (`reviewStagingRow`, `rejectStagingRow`,
  `acceptStagingRows`, `closeImportBatch`)
* `supabase/migrations/0035_purchasing_import_commit_rpc.sql`
  (`commit_purchase_import_rows`, `parse_purchase_import_source`)
* `apps/purchasing/src/purchasing/application/ports.ts` (extend `AtomicOperations`)
* `apps/purchasing/src/app/imports/**` (batch list, batch detail, row review screen)
* `docs/PURCHASING_ADMIN_GUIDE.md`, `docs/PURCHASING_USER_GUIDE.md`

**Acceptance criteria**

1. Acceptance is atomic, idempotent and concurrency-safe (§J.6, §I.13, §I.14).
2. An accepted row is frozen; an accepted line refuses UPDATE/DELETE in both providers.
3. A batch cannot close while rows remain non-terminal.
4. Every acceptance and rejection is in the audit trail via `AuditPort`.
5. `npm test -w purchasing` green; live RLS suite green with its negative control.

**Stop.** Legacy history exists and is queryable by batch. It is **not** yet in the catalog,
autocomplete or any report.

---

### 2E — Union read model

**Objective.** Native + legacy, one query surface, origin always present.

**Files**

* `supabase/migrations/0036_purchasing_history_unified.sql` (the `security_invoker` view)
* `apps/purchasing/src/purchasing/infrastructure/sqlite/database.ts` (mirror view)
* `apps/purchasing/src/purchasing/domain/history-intelligence.mjs` (new: `LEGACY_WEIGHT`, blending,
  last-vendor preference, per-unit bucketing, price-observation assembly — pure)
* both `repositories.ts` (`UnifiedHistoryRepository`)
* `apps/purchasing/src/purchasing/application/history.ts` (`unifiedHistory`, `materialProfile`)
* `apps/purchasing/src/app/reports/**` (an origin filter and an origin column)

**Acceptance criteria**

1. Every unified row carries `origin`, and no consumer can obtain a row without it (asserted by the
   record type and a test that the view has no origin-less path).
2. Native-preference rules hold (§G.2), asserted in the domain suite.
3. Quantities are never summed across units.
4. Golden test: with zero legacy rows, every existing catalog/autocomplete output is byte-identical
   to before.
5. `npm test -w purchasing` green.

**Stop.** Autocomplete ranking is **not** yet changed. Only the reports surface reads the union.

---

### 2F — Match assist

**Objective.** Ranked proposals, human confirmation, post-commit decisions.

**Files**

* `apps/purchasing/src/purchasing/domain/legacy-match.mjs` (pure candidate generation and ranking)
* `apps/purchasing/src/purchasing/application/imports.ts` (`proposeMatches`, `confirmMatch`,
  `recordLegacyMatchDecision`)
* both `repositories.ts`
* `apps/purchasing/src/app/imports/**` (match UI, bulk vendor apply)

**Acceptance criteria**

1. Only unique tier-0 auto-applies; ambiguity always requires a human.
2. Post-commit re-matching writes a decision row and leaves the line byte-identical (asserted by
   comparing a row hash before and after).
3. The audit question of §F.4 is answerable from the decision table alone.
4. Bulk vendor apply cannot accept `NEEDS_REVIEW` rows as a side effect.
5. `npm test -w purchasing` green.

**Stop.** No model-based matching. No automatic directory creation.

---

### 2G — Historical intelligence integration

**Objective.** Legacy history reaches the places users actually see it, labelled.

**Files**

* `apps/purchasing/src/purchasing/infrastructure/{sqlite,supabase}/repositories.ts`
  (`ItemCatalogRepository` reads the union)
* `apps/purchasing/src/app/api/materials/suggest/route.ts` (expose `originMix`)
* `apps/purchasing/src/app/materials/page.tsx`, `vendors`, `reports`
* `docs/PURCHASING_HISTORY_AND_CATALOG.md`

**Acceptance criteria**

1. Autocomplete blends by `LEGACY_WEIGHT` and reports `originMix`.
2. No price or vendor suggestion is rendered without its origin and date.
3. Request-funnel counts still filter to `origin = 'NATIVE'`.
4. Performance: material profile for the pilot corpus under 150 ms on the Supabase provider
   (indexes from §B.6 are the reason it should be).
5. `npm test -w purchasing` green.

**Stop.** Ship. Anything beyond this (supersession records, model-assisted matching, vendor
intelligence) is a new phase with its own design.

---

## L. What to collect from Lippolis

### Required — implementation cannot be validated without these

1. **At least two structurally different exports** of the same historical period (e.g. a 2019–2021
   export and a 2021–2024 export from a different system or template). The overlap is what proves
   deduplication, and it is the single most valuable thing on this list.
2. **A line-level export**, not a header-level one: one row per material line, not one row per PO.
   Header-only data cannot support any of the intelligence features.
3. **Column meanings in writing** — a short note or a call — for every column in every export,
   including which price column is unit vs extended, and whether prices are per unit / per C / per M.
4. **Date format confirmation** — D/M/Y or M/D/Y — per export, in writing.
5. **The current vendor list** as Lippolis knows it, with the historical name variants they can
   recall ("Graybar", "Graybar Electric", "GRAYBAR ELECT."). Matching quality is bounded by this.
6. **10–20 PDF purchase orders** spanning the whole period, including at least one from each
   template/era, and at least two multi-page ones.
7. **Two or three POs whose history they know cold** — what was ordered, from whom, at what price —
   as an end-to-end correctness oracle.

### Highly useful

8. The job/project number list for the period, with names.
9. Any existing material or catalog list (feeds `material-import.mjs`, already built).
10. Known-duplicate examples: two documents they know describe the same purchase.
11. Unit-of-measure conventions actually used (`C`, `M`, `LF`, `RL`, `BX`) and what they mean there.
12. Which years they consider *reliable* — often the recent 2–3 years are clean and older data is
    not. That directly sets `LEGACY_WEIGHT` policy and possibly a date floor.
13. Requester / foreman names as they appear in the exports, mapped to current people where
    possible.
14. Whether any of these POs were cancelled, returned or never fulfilled — and how the export marks
    it, if at all.

### Optional

15. Vendor quotes and invoices (a future actual-cost reconciliation path, not this phase).
16. Freight, tax and discount lines, and how they appear (they will show up as rows; the design
    treats them as ordinary lines that a reviewer rejects or accepts).
17. Any internal notes/comments columns.
18. Preferred-vendor-by-material opinions from the purchaser — useful as a sanity check against what
    the data says, never as an input to the import.

### Minimum useful pilot dataset

**Target: ~2,000–5,000 line items across ~400–800 purchase orders, covering 24–36 months, in at
least two formats, with a deliberate overlap of at least 100 lines, plus 10–20 PDFs.**

Reasoning:

* **Frequency ranking** needs enough repetition to be meaningful: roughly 300+ distinct materials
  with the top 50 seen 5+ times each. Under ~1,500 lines, autocomplete ranking is noise.
* **Price observation** needs 3+ observations for the common materials to show a trend rather than a
  number.
* **Vendor–material association** needs enough lines per vendor: 20+ vendors with 20+ lines each.
* **Dedupe** needs a real overlap, not a synthetic one — hence the ≥100 genuinely overlapping lines.
* **Format independence** needs two formats; one format proves nothing about the parser boundary.

A **smoke dataset** of ~100 lines in one format is enough to build and validate milestones 2B–2D,
and should be requested first so implementation is not blocked waiting for the full export.

---

## M. Unresolved product questions

1. **Who may accept?** Proposed: `WORKSHOP_APPROVER` and `ADMIN` only. Should OFFICE be able to
   commit history it uploaded? (Recommendation: no for the pilot — acceptance writes permanent
   records.)
2. **Does legacy spend appear in financial reporting?** The design keeps it queryable and labelled,
   but whether "total spend with Graybar" includes imported years is a business decision with
   accounting consequences. Default proposed: **excluded from financial totals, included in
   purchasing-intelligence views**, with an explicit toggle.
3. **`LEGACY_WEIGHT = 0.5`** is a judgement, not a measurement. It should be revisited once real
   data exists; it is a named constant so that is a one-line change plus a test update.
4. **`YEAR`-precision dates** — should a 2019-only line be plotted at all, and if so where? Proposed:
   excluded from time series, included in counts and price observations with a visible precision
   badge.
5. **Retention of requester names** from legacy exports. These are personal data about people who
   may no longer work there. Proposed: keep in `raw` (it is evidence), never surface in UI beyond
   the import review screen unless matched to a current user.
6. **Retention of the uploaded artefacts.** Proposed: forever, since provenance depends on them.
   Needs a decision on storage cost and on whether an abandoned batch's objects are purged.
7. **Freight/tax/discount rows** — reject them, or import them as lines flagged non-material? They
   are real spend but not material history. Proposed: import with an issue code and a
   `is_material = false`-style interpretation flag; **deferred to a later phase**, rejected in the
   pilot.
8. **Cutover boundary.** Is there a date after which native history is authoritative and legacy
   imports should be refused outright? A hard floor would make §I.15 unnecessary.

---

## N. Summary of key architectural decisions

1. **Separate table, never the native one.** `purchase_history_legacy_lines` is its own immutable
   record. `purchase_history_lines` is never written by an import path, and a static test asserts it.
2. **Origin is structural, not a flag on a shared table.** The union happens in a read view; the
   write paths never meet.
3. **Raw text is stored three times** — artefact, staging, accepted line — because a frozen record
   that depends on a mutable one is not frozen.
4. **Every interpreted value carries the version of the rule that produced it** (`normalizer`,
   `interpretation`, `fingerprint`, `vendor normalizer`), so improving a rule never re-clusters the
   past.
5. **Dedupe at three independent levels** — file bytes, line fingerprint, source row — with the
   strongest one expressed as a unique constraint so a race cannot beat it.
6. **Matching is an opinion, stored apart from the evidence**, append-only, and revisable without
   touching a frozen line. That is what lets rule 9 (immutable) and requirement F (match later)
   both hold.
7. **The parser emits strings and never drops or invents a row.** All coercion is pure, versioned
   domain code.
8. **PDFs are stored, transcripts are separate hashed sources, and every transcript row requires a
   human.** No OCR is designed here, and none is needed to make the pipeline safe.
9. **Micro-dollars for legacy money**, because per-foot and per-C pricing is real and cents rounding
   would inject a several-percent error into exactly the prices that matter.
10. **Four fences on the accepted record**, identical to native history: grant, RLS, row trigger,
    truncate trigger — plus `accepted_by = auth.uid()` in the insert policy, the `0033` lesson.
11. **Native always wins** when both origins answer the same question; legacy widens coverage and is
    always labelled with its origin and date.
12. **Acceptance is the only irreversible step**, and it is one atomic, idempotent, lock-protected
    operation.
