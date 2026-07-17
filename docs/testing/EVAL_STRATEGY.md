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

## Runner 2 — classification eval (task B2, on-demand)

`scripts/eval-classification.sh` (B2): runs the real classifier over all
fixtures, compares to labels, writes a dated report (accuracy, per-fixture
verdicts, confidence calibration, tokens + cost + latency per email).

| Metric | Gate at B2 acceptance | Notes |
|---|---|---|
| Emergency recall, keyword ∪ model | = 100% (hard) | REQUIREMENTS: AI never the only defense; union must catch 02/03/05 |
| Work-request detection (is/isn't) | 12/12 (hard) | fixture 10 must be not_a_work_request |
| Full classification accuracy | ≥ 10/12 (soft — report + review) | ambiguous fixtures (07/11/12) may legitimately be unknown |
| Extraction completeness (name/phone/address/county/zip where present in body) | ≥ 90% fields (soft) | feeds territory + routing |
| Hallucinated fields (extracted value absent from email) | = 0 (hard) | invented customer data is a money/trust risk |
| Verify-step pass rate (runner write-backs verified) | = 100% (hard) | unverified = failure by definition |
| Cost + latency per email | reported, no gate | budget data for boss ROI framing |

Gates enforced by the script's exit code. Prompt or model changes in B2+ must
re-run Runner 2 and meet gates before commit (same discipline as regression).
Runner 2 is NOT in regression.sh (nondeterministic + costs money); it runs at
B2 acceptance and after any prompt/model/taxonomy change.

## Explicitly deferred

Approval-policy compliance eval (needs B3 rows), routing accuracy (needs B3
matrix seed), duplicate-detection eval beyond exact-match (fuzzy is
human-confirmed in MVP), unsafe-send prevention eval (no send path exists —
covered structurally; becomes a real eval at I1), latency-to-draft SLA (needs
B3+B5 end-to-end path).
