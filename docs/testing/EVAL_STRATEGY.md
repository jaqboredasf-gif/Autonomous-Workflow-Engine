# Eval Strategy — AWE MVP (2026-07-17)

Harness controls runtime behavior; evals measure quality over time. MVP eval
system = fixtures + ground-truth labels + two runners. No ML platform.

## Dataset

- `fixtures/emails/*.json` — 12 fixture emails (RISKS edge cases).
- `fixtures/emails/labels.json` — ground truth per fixture: expected
  classification, emergency flag, keyword-net expectation, ground-truth
  county/zip extraction, expected territory verdict, expected terminal status,
  duplicate-of link, missing-info flag. Labels are the single source of
  expected behavior; changing a label is a reviewed decision, not a test fix.
- Growth rule: every real misclassification found later becomes a new fixture +
  label before it is fixed (regression corpus grows from real failures).

## Runner 1 — baseline deterministic eval (BUILT, in regression)

`scripts/eval-intake.sh` — no model calls; evaluates the deterministic safety
layer against labels on every regression run.

| Metric | Gate | Why |
|---|---|---|
| Keyword-net recall on fixtures labeled keyword_net_expected=true | = 100% (hard fail) | deterministic net is the safety floor; a labeled-catchable miss is a regression |
| Keyword-net false positives on fixtures labeled false | = 0 (hard fail) | false-positive bias is allowed in PATTERN DESIGN, but known-clean fixtures must stay clean |
| Territory verdict vs expected (ground-truth county/zip inputs) | = 100% (hard fail) | string-match domain; any mismatch is a code regression |

Hard fail = nonzero exit = regression.sh failure.

## Runner 2 — classification eval (task B2)

Split into **2A (deterministic, in regression)** and **2B (live, paid, on-demand)**.
Both drive the SAME domain service (`scripts/lib/classification.mjs`) through an
injected model adapter (`scripts/lib/model-adapters.mjs`); only the adapter differs.

- **Runner 2A — `scripts/eval-classification.sh`** — fixture adapter replays
  recorded model outputs (`fixtures/emails/model_recorded.json`) at the model
  boundary. No API key, no model network. Everything else is real: keyword-net
  union, budget/retry, fail-closed, live-DB persistence, and the deterministic
  Verify Step. Regression-safe (idempotent write-back on `graph_message_id
  'fixture:<name>'`). **In `regression.sh`.**
- **Runner 2B — `scripts/eval-classification-live.sh`** — Anthropic adapter, real
  inference. Requires `ANTHROPIC_API_KEY`; exits with a clear setup error when
  absent. Reports model / calls / tokens / latency / cost / accuracy / FP / FN /
  emergency-recall / per-fixture. **NOT in regression** (nondeterministic + costs
  money). Runs at B2 acceptance and after any prompt/model/taxonomy change.

2A proves the machine is correct given good model output; **2B is the only thing
that measures classification quality.** 2A's accuracy line is a smoke check
(recorded outputs are authored to match labels), NOT a quality gate — do not read
a green 2A as "the classifier classifies well." That evidence comes only from 2B.

### classify.mjs I/O contract

`node scripts/classify.mjs --fixture <path> --adapter fixture|live [--persist]`
prints ONE JSON object: `{ fixture, prompt_version, classification, status,
urgency, emergency, keyword_net, model_emergency, confidence, extracted{...},
hallucinated_fields[], missing_info, duplicate_of, fail_closed, telemetry{...},
persisted, verify{ ok, checks{ row_updated, values_match, org_scoped,
event_present, no_duplicate_side_effect } } }`.
Exit: `0` ok · `2` persisted-but-Verify-Step-failed · `3` live adapter with no key
· `1` other error. `--selftest` prints `selftest-ok` iff the hallucination guard
flags an invented value (and passes a present one). The model can never assert
persistence: success requires `verify.ok`, computed by re-reading the DB.

### classification rules (code-enforced, never left to the model)

- **Emergency = UNION** of deterministic keyword net (`is_emergency_text`) and the
  model; the net can override the model to emergency (guarantees 100% recall).
- **Fail-closed:** unparseable model output after 1 call + ≤2 retries →
  `unknown` → `needs_review`.
- **Status** (`deriveStatus`): emergency→escalated · not_a_work_request→closed ·
  unknown→needs_review · duplicate_of set→needs_review (content dupes are NEVER
  auto-closed) · missing_info→awaiting_info · county+zip both null→needs_review ·
  else new.
- **Hallucination guard:** any extracted value absent from the email body is
  reported; hard gate = 0.
- **Duplicate detection:** Jaccard ≥ 0.7 on normalized body vs earliest prior
  request from the same sender; links `duplicate_of`, routes to needs_review.

| Metric | Gate | Runner |
|---|---|---|
| Emergency recall, keyword ∪ model | = 100% (hard) | 2A + 2B |
| Work-request detection (is/isn't) | 12/12 (hard) | 2A + 2B |
| Hallucinated fields | = 0 (hard) | 2A + 2B |
| Verify-step pass rate | = 100% (hard) | 2A |
| Fail-closed fixture 11 → unknown/needs_review | required (hard) | 2A |
| Full classification accuracy | ≥ 10/12 (soft) | 2B (real signal) |
| Extraction completeness | ≥ 90% fields (soft) | 2B |
| Cost + latency per email | reported, no gate | 2B |

### B2 test evidence (2026-07-20)

Runner 2A: `passed=20 failed=0, accuracy 12/12`. All 12 fixtures classified to
label; all Verify Steps pass; emergency union catches 02/03/05 (incl. 05 where the
recorded model MISSES it); fixture 11 fails closed to unknown/needs_review;
hallucinated fields = 0. Idempotent rerun proven (01 self-heals). Regression:
`acceptance-slice3` 20/20, `eval-intake` 24/24 — no existing intake behavior broke.

### Known limitations

- **2B never executed** — no `ANTHROPIC_API_KEY` in this environment. B2 is
  *implementation complete / deterministic eval green / live evaluation pending
  credential*. Recorded as an external execution dependency, not an architecture
  blocker. B2 may NOT be called "fully evaluated" until 2B runs with a real key.
- **Duplicate detection is scoped to the fixture corpus** (`graph_message_id LIKE
  'fixture:%'`) so 2A stays deterministic and isolated from accumulated
  slice/production rows. Production scoping (all real inbound from a sender) is
  wired later at the MCP/n8n boundary.
- **Fixture 08 status deviation:** label `expected_status=duplicate`, pipeline
  produces `needs_review` (+ `duplicate_of` linked). Intentional — honors the
  locked rule that fuzzy/content duplicates are never auto-closed; a human sets
  `duplicate`. Classification (the gated field) still matches the label.

## Runner 4 — approval matrix + outbound drafts (B3, added 2026-07-26)

`scripts/eval-approval-matrix.sh` → `scripts/eval-approval-matrix.mjs`. Pure
offline (no keys, no DB, no network, no Graph), in regression. Runs the routing
engine (`scripts/lib/approval-matrix.mjs`) and draft generator
(`scripts/lib/outbound-draft.mjs`) over `fixtures/outbound/` (5 policy sets, 16
labelled cases). Hard gates: every label; determinism; **no-send** (no case may
yield approved/sent, no ok draft may claim send capability); fixture-recipient
safety (`@example.invalid`); fail-closed coverage (all 11 blocked reasons
exercised); template coverage (10/10 render clean); source purity (engine modules
contain no network/send machinery); matrix-seed parity. Evidence 2026-07-26:
`passed=314 failed=0`, coverage 11/11 and 10/10; verified non-vacuous by label
perturbation. Full contract: docs/testing/APPROVAL_MATRIX.md.

This closes two previously deferred evals: **approval-policy compliance** and
**routing accuracy** are now measured against the seeded matrix, offline.
Unsafe-send prevention remains structural (there is still no send path) but is
now asserted by an explicit gate rather than by absence alone.

## Explicitly deferred

Duplicate-detection eval beyond exact-match (fuzzy is human-confirmed in MVP),
end-to-end send prevention against a real provider (becomes a real eval at I1),
latency-to-draft SLA (needs B3+B5 end-to-end path), and **DB-side approval-gate
behavior** — the constraints, triggers and RPCs in 0015 are lint-verified only
until acceptance slice 4 runs live (TASK_BACKLOG B3-live).
