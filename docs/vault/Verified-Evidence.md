---
type: verified-evidence
project: TEGG / AWE
updated: 2026-08-03
---

# Verified Evidence

Only claims backed by a run or a test. Anything not listed here is not proven.

## Test suite

- **686 tests pass, 0 skipped**, ~6 minutes (2026-08-03).
- Growth: 471 → 556 → 632 → 660 → 683 → 686 across the effort.

## Live portal runs

| what | evidence |
|---|---|
| memory persists and repairs itself | knowledge broken on purpose → contradicted → bounded rediscovery in 3 of 12 permitted actions → persisted → reused by an independent run → promoted CANDIDATE→VERIFIED |
| relocated route repaired live | route pointed at a path that does not exist; `/sales/documentation` rediscovered from the portal's own navigation |
| both inspection reports retrieved | Standard IR Report 773,899 bytes in 17.2 s; Equipment Item Problems 99,223 bytes in 17.7 s — **first successful export of either by this repository** |
| full pipeline live | T25-204, 13/13 steps, ~100 s, read-only |
| interrupt and resume | `os._exit(9)` mid-run; resumed in 0.30 s without contacting the portal (checksum-matched documents) |
| idempotent rerun | resuming a finished run: 0.14 s, `review.md` byte-identical |
| duplicate launch refused | second launch exit 4, first completed normally |
| cross-tenant refusal | exit 3, zero writes to the other tenant's history |
| second installation | clean unzip, `pip install`, live run with **no arguments**: 13/13 in 100 s |

## Estimating, verified against a real visit (T25-204)

- 13 findings; 3 priced; 10 correctly not (9 fixed on the visit, 1 where the
  report ticks neither repair nor replace).
- Confidence **LOW** with five stated reasons.
- Total decomposes: direct cost → overhead → contingency → profit → tax, each
  naming its rate and the base it applied to.
- **No vocabulary gaps** between adapter and rate card.

## Security

- 114 tracked files scanned by value: **no credential, no session token**.
- SSO hand-off URLs redacted at the boundary *and* refused by the secret screen.
- Package audited before shipping; refuses to build if a credential appears.

## Defects found and fixed (each by evidence, not review)

1. `load_or_create` replaced a corrupt or newer-schema knowledge document with
   an empty one — **observed destroying 15 records, 117,456 → 284 bytes**.
2. Run ledger persisted **live SSO session tokens** for all 121 visits.
3. Wrong-directory run leaked **1.5 MB of customer PDFs to world-readable /tmp**
   and did 90 s of live work before failing on a config file.
4. `doctor` created directories — in a command documented as changing nothing.
5. Launcher failed with **no arguments** (`set -u` + empty array on bash 3.2) —
   the documented default path.
6. `set -e` meant a failing run never explained its exit code.
7. Prose became a vocabulary token (a whole recommendation sentence treated as
   a work type).
8. **Mobilization charged against a job with no work in it** — $385 for
   attending a visit where everything was already fixed.
