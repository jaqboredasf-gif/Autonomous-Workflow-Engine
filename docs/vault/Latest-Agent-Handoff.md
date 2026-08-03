---
type: agent-handoff
project: TEGG / AWE
updated: 2026-08-03
commit: 737a92d
branch: claude/tegg-agent-gaps-af4ziv
---

# Latest Agent Handoff

## Where things stand

Milestone 4 of 9 complete. 11 commits, **nothing pushed**. 686 tests pass.
Working tree clean.

TEGG now prices through `awe_estimating`. The old `awe_tegg/estimate.py` is
deleted, not kept — one engine, not two.

## What was just done

- `awe_estimating/confidence.py` — deterministic confidence that never returns
  a level without reasons a person can act on.
- `review.py` rewritten: shows how the total is built, adjustment by
  adjustment, and names the rate card that priced it.
- `config/estimating.example.yaml` → `config/ratecard.example.yaml` in the
  generic schema, updated everywhere including the coworker package.
- Two defects fixed: mobilization charged against a job with no work in it;
  internal-consistency validation now catches items lost between stages.

## Immediate next step

**Run the first operator pilot.** Everything needed exists:
`dist/TEGG-Report-Tool.zip`, `START HERE.txt`, `OPERATOR_GUIDE.md`, and
`docs/PILOT_OBSERVATION.md` — which is for Jack, not the coworker.

Do not build milestone 5 before the pilot. Approval gates designed without
watching somebody use the thing will be designed for the wrong person.

## Then

- **M5** approval gates + audit trail (`awe_estimating.approval`)
- **M6** proposal + email draft — stored, never sent
- **M7** calibration — **blocked** on 5–10 historical jobs
- **M8** production rate card — **blocked** on real numbers

## Standing caveats

- Every claim in this repository was verified by the agent that wrote it. No
  second person, no second machine.
- The tool signs in as Jack's personal account. Those credentials should be
  rotated and replaced with a service account.
- The live portal username remains in git history at `HEAD:docs/QUICKSTART.md`
  and `HEAD:tests/mock_portal.py`. Cleaning it needs a history rewrite.
