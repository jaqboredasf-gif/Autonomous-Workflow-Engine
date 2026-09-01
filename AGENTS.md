# Repository Agent Rules

## Before starting

Run these. They take seconds and they are the handoff — every one of them is derived from the
repository, so none of them can be stale.

```bash
npm run plan          # what to do next, per track, and which gate we are at
npm run readiness     # where the company stands, and why each band is what it is
npm run evidence      # what real evidence is missing, and the act that would supply it
git log --oneline -15 # what the last sessions actually did
```

Read `SOURCE_OF_TRUTH.md` before touching anything a server runs.

## While working

- One major task per branch.
- Never place secrets in Git.
- Never apply live migrations without explicit approval.
- Stop when the repository, the migration history and the live state disagree.
- **Do not raise a readiness band by declaring a fact.** Every band is derived from something that
  happened. If a number needs to move, produce the artifact it names.

## Before ending

- Commit verified work. The commit message carries the *why* — a paragraph, not a subject line.
  This is where the intent of a session lives, because it cannot go stale there.
- Add a `docs/planning/DECISION_LOG.md` entry for any decision the code does not explain by itself,
  especially one that was decided *against* an obvious alternative.
- Run the suites the change touches, then the broad offline ones. Report failures as failures.

## Retired

`docs/planning/AGENT_HANDOFF.md` is **no longer maintained** and is kept only as a record of
5 August 2026. It was required to be updated every task, went four weeks without an update, and
described a branch and an objective that had both moved on. Two sources of project truth is one too
many; the commands above are the surviving one. See `DECISION_LOG.md`, 2026-09-01.
