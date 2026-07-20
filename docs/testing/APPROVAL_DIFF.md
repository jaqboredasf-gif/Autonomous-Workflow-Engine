# Approval Diff & Reasoning (ADR) — offline evidence slice

Status: **offline slice COMPLETE, Runner 3 GREEN** (2026-07-20). Live migration
apply and Microsoft Graph capture are deliberately NOT in this slice — see
"Deliberately excluded" below.

The "draft-not-compose" ROI loop: the agent drafts an outbound reply, a human
approves/edits/sends it, and we capture the **difference between what was drafted
and what was actually sent**. Enough of those diffs, per category, is the evidence
a human uses to decide whether a category may graduate toward auto-send. This
slice builds only the offline substrate: the evidence schema, a pure deterministic
diff engine, labelled fixtures, and a deterministic runner. Nothing here sends,
drafts to a mailbox, or talks to any network.

---

## 1. Evidence schema — migration `0014_approval_evidence.sql`

Additive over 0001–0013. Follows every established convention: org-scoped FK,
`is_fixture` + `fixture:<key>` namespace, `created_at`/`updated_at`, RLS-first
(admin read; service-role write; **no delete policy**), events via `emit_event()`
into `integration_events`, and audit-grade immutability (no hard deletes;
corrections are new rows, same rule as `email_messages` in 0011).

**`approval_drafts`** — the AI-drafted message (evidence of what was proposed).
Immutable after insert. `draft_key` unique per org (`fixture:<name>` for fixtures)
gives idempotent capture. Columns: `subject`, `body_text`, `to_addrs`, `cc_addrs`,
`bcc_addrs`, `attachments` jsonb, `category` (graduation bucket), `model_meta`
(provenance), optional `work_request_id`.

**`approval_outcomes`** — what the human actually sent/decided, plus the recorded
diff. One final outcome per draft (`approval_outcomes_draft_uidx`). Immutable after
insert. `outcome` ∈ `sent_unchanged | sent_edited | rejected | superseded`. Stores
the full `diff` jsonb and denormalized `edit_ratio` / `material` / `edit_classes`
for cheap ledger rollups. Check constraints tie `outcome` to the evidence
(`sent_unchanged` ⇒ `material=false`; a send carries a body; a rejection does not).
On insert emits `approval.diff_recorded`, and additionally `approval.material_edit`
when `material` — the signal graduation will watch — with **no autonomous action taken**.

**`category_authority`** — per-category graduation ledger. A **human** sets
`authority_level` (`draft_only | suggest | auto`, default `draft_only`). Nothing in
the migration writes that column automatically; the counters (`sample_size`,
`unchanged_count`, `material_edit_count`) are a convenience cache a future
*reviewed* job may maintain. Graduation logic is out of scope this slice.

No-hard-delete is enforced two ways: RLS default-denies client deletes (no delete
policy exists), **and** a `before delete` trigger (`guard_no_delete`) blocks DELETE
on both evidence tables even for the service role.

---

## 2. Diff engine — `scripts/lib/approval-diff.mjs`

Pure, offline, deterministic ES module. Zero imports beyond node stdlib (in fact
zero imports at all). Same input twice ⇒ byte-identical output.

### Input / output contract

`diff(draft, sent)` returns:

```
{
  unchanged,      // bool — every compared field byte-identical (CRLF/LF aside)
  edit_ratio,     // number 0..1 — overall edit magnitude, rounded to 4 dp
  field_deltas,   // object keyed by CHANGED field only (see below)
  edit_classes,   // array from the fixed vocabulary, in canonical order
  material         // bool — is this a material edit (drives graduation evidence)
}
```

Plus two additive evidence keys: `ambiguous` (bool — more than one non-formatting
class fired) and `errors` (array; non-empty ⇒ malformed input).

Both `draft` and `sent` are plain objects. Field names are tolerant of the DB
column aliases: `body`|`body_text`, `to`|`to_addrs`, `cc`|`cc_addrs`,
`bcc`|`bcc_addrs`, `attachments`. Missing optional fields are treated as empty,
never as a delta. Attachments compare by `name`/`filename` (case-insensitive), else
by stable stringification.

**Compared fields:** `subject`, `body`, `to`, `cc`, `bcc`, `attachments`.

`field_deltas[field]` for a text field: `{changed, before, after, ratio,
formatting_only}`. For a list field: `{changed, added[], removed[]}`.

### edit_ratio

Word-level Levenshtein on formatting-normalized `subject` + `body`, plus set
distance on each list field (added+removed over union size), summed and divided by
the total comparable units. Deterministic; `0` when unchanged, `1` on malformed.

---

## 3. Material-edit rules

`material = true` iff `edit_classes` contains any class **other than
`formatting_only` or `tone`**. Rationale: material means "the AI produced something
a human had to substantively fix" — the thing that must *not* be happening before a
category graduates. Cosmetic reshaping (`formatting_only`) and polite rewording
(`tone`) are non-material by definition; a genuinely large reword instead trips
`major_rewrite` (a material class) via the ratio threshold. `unchanged` and
malformed-but-caught inputs: `unchanged` ⇒ non-material, malformed ⇒ **material**
(fail closed — a broken capture must be reviewed, never silently "unchanged").

---

## 4. Edit-classification rules

Deterministic heuristics over the symmetric difference of content tokens
(subject+body). Multiple classes may fire (`ambiguous` flags that).

| Class | Fires when |
|---|---|
| `formatting_only` | text changed but is identical after whitespace/case/punctuation/HTML normalization, and no list field changed. Terminal — returned alone. |
| `recipient_correction` | `to` / `cc` / `bcc` changed. |
| `attachment` | `attachments` changed. |
| `scheduling` | changed tokens contain a time, date, weekday, month, or scheduling word (`reschedule`, `appointment`, `tomorrow`, …). |
| `pricing` | changed tokens contain a currency/percent/amount or a price word (`quote`, `estimate`, `deposit`, `fee`, `discount`, …) with a number/`$`/`%`. |
| `compliance` | changed tokens contain license/insurance/permit/OSHA/liability/warranty/terms/code/contract language. |
| `missing_information` | `sent` adds ≥6 net-new tokens with added:removed ≥ 1.75 (new info, not a reword). |
| `factual_correction` | a value substitution — a changed number, or a proper-noun/address entity (sentence-initial capitals excluded) — not already claimed by `scheduling`/`pricing`. |
| `major_rewrite` | `edit_ratio ≥ 0.60`. |
| `tone` | wording moved, no content class fired, `edit_ratio < 0.50`, not a net-add. Last resort so real text edits are always labelled. |

Tunables (single source of truth in the engine): `MAJOR_RATIO=0.60`,
`TONE_MAX_RATIO=0.50`, `INFO_ADD_RATIO=1.75`.

---

## 5. Runner 3 — `scripts/eval-approval-diff.sh`

Thin wrapper over `scripts/eval-approval-diff.mjs`. **Pure offline**: no API keys,
no model calls, no database, no network, no Graph, no mailbox. It loads every
labelled fixture in `fixtures/approvals/`, runs the engine, and asserts:

- **labels** — `unchanged`, `material`, `ambiguous`, and `edit_classes` (subset by
  default, exact when `edit_classes_exact:true`); `malformed` ⇒ errors returned;
  `no_list_deltas` ⇒ no recipient/attachment deltas.
- **determinism** — `diff()` run twice is byte-identical.
- **contract** — every result has the required shape; `edit_ratio ∈ [0,1]`; all
  classes are valid.
- **coverage** — every one of the 10 edit classes appears in at least one fixture.

Clear pass/fail per assertion; nonzero exit on any failure. Wired into
`scripts/regression.sh` (safe there — it touches nothing live). Current result:
**passed=120 failed=0, 15 fixtures, edit-class coverage 10/10**.

Fixtures: one deterministic draft-vs-sent pair per edit class (01–11), plus
`12_multi_class` (recipient+pricing+attachment simultaneously), `13_ambiguous`
(scheduling+pricing), `14_malformed` (invalid `to`), `15_missing_optional`
(no cc/bcc/attachments). Ground truth in `fixtures/approvals/labels.json` — a label
change is a reviewed decision, not a test fix.

---

## 6. Migration validation

This environment has **no psql / supabase CLI / docker**, so 0014 cannot be applied
to a real Postgres here, and applying schema to the live Supabase project from an
isolated session is an irreversible outward action left to a human. Instead
`scripts/lib/validate-migration-0014.mjs` runs a deterministic **offline structural
lint** (also in regression): additive-only (no destructive statements), the three
tables with `is_fixture`/`created_at`/org-scoping/RLS/indexes, FK targets all known,
all three enums + 10 edit classes, no-delete + immutability guards, both events,
**no autonomous authority write**, no Graph/network/send in code, balanced `$$` and
parentheses. Result: **PASS**.

**Gated live-apply step (human runs, like Runner 2B for B2):**

```
source .env.acceptance && supabase db push        # or apply 0014 via the mgmt query API
```

ADR is not "schema-applied" until that runs against the live DB. Runner 3 (the
completion bar for this slice) is fully offline and does not depend on it.

---

## 7. Known limitations

- Heuristic classifier, English-only, keyword/regex driven — it will mislabel
  edits that need semantics (sarcasm, implicit meaning, domain jargon). It is
  evidence-grade, not judgment-grade; `ambiguous` marks low-confidence multi-class
  results for human eyes.
- `factual_correction` vs `tone` is the fuzziest boundary; entity detection excludes
  sentence-initial capitals but has no real NER.
- `edit_ratio` is word-Levenshtein based — reorderings read as larger edits than a
  human might feel.
- Attachment comparison is by name only (no content hashing).
- The diff engine is given an already-paired (draft, sent); it does **not** find the
  pair. Pairing is the next task.

---

## 8. Deliberately excluded (this slice)

- Microsoft Graph integration; Sent-Items subscriptions; draft→sent mailbox
  matching. (The very next isolated task.)
- Any send or draft-to-mailbox capability.
- Autonomous sending and authority-graduation logic beyond storing the offline
  evidence (`category_authority.authority_level` stays human-set, default
  `draft_only`).
- n8n workflow changes; any change to unrelated B1/B2 behavior.
- Real employee/customer data — all fixtures are synthetic.
