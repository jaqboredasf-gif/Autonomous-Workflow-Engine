-- ---------------------------------------------------------------------------
-- 0014_approval_evidence.sql  (Task ADR — Approval Diff & Reasoning, offline slice)
--
-- Evidence substrate for the "draft-not-compose" ROI loop: capture what the AI
-- DRAFTED (approval_drafts) and what the human actually SENT (approval_outcomes),
-- store the deterministic offline diff between them, and keep a per-category
-- ledger (category_authority) that a HUMAN uses to decide graduation. This
-- migration is EVIDENCE ONLY. It contains ZERO autonomous-send logic and ZERO
-- authority-graduation logic — no trigger ever changes an authority_level, and
-- nothing here sends, drafts to a mailbox, or talks to Microsoft Graph. Graph
-- Sent-Items subscription and draft->sent matching are the deliberate task AFTER
-- this one (SESSION_HANDOFF 2026-07-20).
--
-- Additive only. Touches nothing in 0001-0013. Follows the established idioms:
-- org-scoped FK, is_fixture + 'fixture:<key>' namespace, timestamps, RLS-first
-- (admin read; service-role writes; NO delete policy), integration_events via
-- emit_event(), and audit-grade immutability (no hard deletes; corrections are
-- new rows, never edits — same rule as email_messages in 0011).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- The fixed edit-classification vocabulary the offline diff engine
-- (scripts/lib/approval-diff.mjs) may assign. Kept in lockstep with that engine
-- and docs/testing/APPROVAL_DIFF.md — adding a class is a reviewed schema change.
create type approval_edit_class as enum
  ('formatting_only', 'tone', 'factual_correction', 'missing_information',
   'recipient_correction', 'scheduling', 'pricing', 'attachment',
   'compliance', 'major_rewrite');

-- What the human did with the AI draft.
create type approval_outcome_kind as enum
  ('sent_unchanged', 'sent_edited', 'rejected', 'superseded');

-- Human-set autonomy level per category. Automation NEVER writes this column —
-- it is the graduation decision, and graduation is out of scope this slice.
create type approval_authority_level as enum
  ('draft_only', 'suggest', 'auto');

-- ---------------------------------------------------------------------------
-- approval_drafts — the AI-drafted outbound message. Audit-grade evidence of
-- what the agent PROPOSED; immutable after insert (guard below). No send of any
-- kind is implied by a row existing here. Ingestion is service-role only
-- (fixtures now, real capture later) — no client insert policy on purpose.
-- ---------------------------------------------------------------------------

create table approval_drafts (
  id               uuid primary key default uuid_generate_v4(),
  org_id           uuid not null references orgs(id) on delete cascade,
  -- Optional link to the request the draft answers; fixtures need not link.
  work_request_id  uuid references work_requests(id),
  -- Graduation bucket (e.g. 'out_of_territory_decline', 'service_call_confirm').
  -- Free text on purpose: the category vocabulary is owned by category_authority
  -- rows a human curates, not by a hard enum here.
  category         text not null,
  -- Deterministic idempotency key. Fixtures use 'fixture:<name>' exactly like
  -- email_messages.graph_message_id, so re-ingest of a fixture is a no-op.
  draft_key        text not null,
  subject          text,
  body_text        text,
  to_addrs         text[] not null default '{}',
  cc_addrs         text[] not null default '{}',
  bcc_addrs        text[] not null default '{}',
  attachments      jsonb  not null default '[]'::jsonb,
  -- Provenance of the draft (adapter, model, prompt version) — evidence, not logic.
  model_meta       jsonb  not null default '{}'::jsonb,
  is_fixture       boolean not null default false,
  created_at       timestamptz not null default now(),
  -- Only fixtures may carry a synthetic key without real provenance; every row
  -- still has SOME draft_key (enforced not null above) for idempotent capture.
  check (category <> '')
);

-- Re-capture of the same draft is a unique violation (23505) — same idempotency
-- idiom as email_messages_graph_id_key.
create unique index approval_drafts_key_uidx
  on approval_drafts(org_id, draft_key);

create index approval_drafts_org_category_idx on approval_drafts(org_id, category);
create index approval_drafts_org_created_idx  on approval_drafts(org_id, created_at desc);
create index approval_drafts_work_request_idx on approval_drafts(work_request_id);

alter table approval_drafts enable row level security;

create policy approval_drafts_admin_read on approval_drafts
  for select using (org_id = current_org_id() and current_role_is('admin'));

-- ---------------------------------------------------------------------------
-- approval_outcomes — what the human actually sent (or decided), plus the
-- recorded offline diff between draft and sent. Audit-grade + immutable: the
-- outcome is the record of what happened, corrections are new rows. One final
-- outcome per draft.
-- ---------------------------------------------------------------------------

create table approval_outcomes (
  id                uuid primary key default uuid_generate_v4(),
  org_id            uuid not null references orgs(id) on delete cascade,
  approval_draft_id uuid not null references approval_drafts(id),
  outcome           approval_outcome_kind not null,
  -- Who decided; null for fixtures / system-recorded evidence.
  decided_by        uuid references users(id),
  -- The actually-sent form (null when rejected). These are EVIDENCE of what left
  -- the office; this table never causes anything to be sent.
  sent_subject      text,
  sent_body_text    text,
  sent_to_addrs     text[],
  sent_cc_addrs     text[],
  sent_bcc_addrs    text[],
  sent_attachments  jsonb,
  -- Full deterministic diff() output {unchanged, edit_ratio, field_deltas,
  -- edit_classes, material} from scripts/lib/approval-diff.mjs.
  diff              jsonb not null default '{}'::jsonb,
  -- Denormalized diff facts for cheap ledger rollups / triage queries. Kept in
  -- sync by the writer (never derived autonomously into authority).
  edit_ratio        numeric,
  material          boolean not null default false,
  edit_classes      approval_edit_class[] not null default '{}',
  is_fixture        boolean not null default false,
  created_at        timestamptz not null default now(),
  check (edit_ratio is null or (edit_ratio >= 0 and edit_ratio <= 1)),
  -- A concrete send must carry the sent body evidence; a rejection must not.
  check (outcome <> 'rejected' or sent_body_text is null),
  check (outcome not in ('sent_unchanged','sent_edited') or sent_body_text is not null),
  -- sent_unchanged means the diff agreed nothing material changed.
  check (outcome <> 'sent_unchanged' or material = false)
);

-- One final outcome per draft (idempotent re-capture is a unique violation).
create unique index approval_outcomes_draft_uidx on approval_outcomes(approval_draft_id);
create index approval_outcomes_org_created_idx on approval_outcomes(org_id, created_at desc);
create index approval_outcomes_org_material_idx on approval_outcomes(org_id, material);

alter table approval_outcomes enable row level security;

create policy approval_outcomes_admin_read on approval_outcomes
  for select using (org_id = current_org_id() and current_role_is('admin'));

-- ---------------------------------------------------------------------------
-- category_authority — per-category graduation ledger. A HUMAN reads the
-- evidence counters and sets authority_level. NOTHING in this migration writes
-- authority_level automatically — graduation logic is deliberately out of scope
-- (SESSION_HANDOFF: "Do not begin autonomous sending or authority graduation
-- logic beyond the offline evidence schema"). Counters are a convenience cache a
-- future reviewed job may maintain; the default level is always draft_only.
-- ---------------------------------------------------------------------------

create table category_authority (
  id                 uuid primary key default uuid_generate_v4(),
  org_id             uuid not null references orgs(id) on delete cascade,
  category           text not null,
  authority_level    approval_authority_level not null default 'draft_only',
  sample_size        int not null default 0,
  unchanged_count    int not null default 0,
  material_edit_count int not null default 0,
  last_evaluated_at  timestamptz,
  notes              text,
  is_fixture         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (category <> ''),
  check (sample_size >= 0 and unchanged_count >= 0 and material_edit_count >= 0),
  check (unchanged_count + material_edit_count <= sample_size)
);

create unique index category_authority_cat_uidx on category_authority(org_id, category);

alter table category_authority enable row level security;

create policy category_authority_admin_read on category_authority
  for select using (org_id = current_org_id() and current_role_is('admin'));

-- Humans (admin) set the authority level; automation has no policy to write it.
create policy category_authority_admin_update on category_authority
  for update using (org_id = current_org_id() and current_role_is('admin'));

-- ---------------------------------------------------------------------------
-- No hard deletes on the evidence tables. RLS already default-denies client
-- deletes (no delete policy exists), but evidence must survive even a
-- service-role mistake — so block DELETE outright. Corrections are new rows.
-- ---------------------------------------------------------------------------

create or replace function guard_no_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'approval evidence is append-only; hard deletes are forbidden (%.%)',
    tg_table_name, coalesce(old.id::text, '?');
end $$;

create trigger approval_drafts_no_delete
  before delete on approval_drafts
  for each row execute function guard_no_delete();

create trigger approval_outcomes_no_delete
  before delete on approval_outcomes
  for each row execute function guard_no_delete();

-- ---------------------------------------------------------------------------
-- Immutability guard: approval_drafts and approval_outcomes are the record of
-- what the agent proposed and what the human sent. Once written they never
-- change (same rule as email_messages in 0011). A corrected draft/outcome is a
-- new row.
-- ---------------------------------------------------------------------------

create or replace function guard_approval_draft_immutability() returns trigger
language plpgsql as $$
begin
  if row(new.org_id, new.work_request_id, new.category, new.draft_key,
          new.subject, new.body_text, new.to_addrs, new.cc_addrs, new.bcc_addrs,
          new.attachments, new.model_meta, new.is_fixture, new.created_at)
     is distinct from
     row(old.org_id, old.work_request_id, old.category, old.draft_key,
          old.subject, old.body_text, old.to_addrs, old.cc_addrs, old.bcc_addrs,
          old.attachments, old.model_meta, old.is_fixture, old.created_at)
  then
    raise exception 'approval_drafts are immutable after insert';
  end if;
  return new;
end $$;

create trigger approval_drafts_immutability
  before update on approval_drafts
  for each row execute function guard_approval_draft_immutability();

create or replace function guard_approval_outcome_immutability() returns trigger
language plpgsql as $$
begin
  raise exception 'approval_outcomes are immutable after insert (record a new row to correct)';
  return new;
end $$;

create trigger approval_outcomes_immutability
  before update on approval_outcomes
  for each row execute function guard_approval_outcome_immutability();

-- ---------------------------------------------------------------------------
-- Events (n8n contract, same emit_event spine as 0009/0011/0013). On every
-- recorded outcome: approval.diff_recorded. When the human made a MATERIAL edit:
-- approval.material_edit as well, so triage/analytics can watch the signal that
-- actually gates graduation — without any autonomous action being taken here.
-- ---------------------------------------------------------------------------

create or replace function emit_approval_outcome_events() returns trigger
language plpgsql security definer as $$
declare
  v_category text;
begin
  select category into v_category from approval_drafts where id = new.approval_draft_id;

  perform emit_event('approval.diff_recorded', 'approval_outcome', new.id, new.org_id,
    jsonb_build_object('approval_draft_id', new.approval_draft_id,
                       'category', v_category,
                       'outcome', new.outcome,
                       'material', new.material,
                       'edit_ratio', new.edit_ratio,
                       'edit_classes', to_jsonb(new.edit_classes),
                       'is_fixture', new.is_fixture));

  if new.material then
    perform emit_event('approval.material_edit', 'approval_outcome', new.id, new.org_id,
      jsonb_build_object('approval_draft_id', new.approval_draft_id,
                         'category', v_category,
                         'edit_ratio', new.edit_ratio,
                         'edit_classes', to_jsonb(new.edit_classes)));
  end if;

  return new;
end $$;

create trigger approval_outcomes_events
  after insert on approval_outcomes
  for each row execute function emit_approval_outcome_events();
