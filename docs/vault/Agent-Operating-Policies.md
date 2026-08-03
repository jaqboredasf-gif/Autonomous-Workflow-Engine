---
type: agent-operating-policies
project: AWE
updated: 2026-08-03
---

# Agent Operating Policies

How an agent works on an AWE project. Each policy exists because breaking it
cost something specific.

## P-1 · Validate on the default path, not the path you developed on

Every clean-room defect was on the no-argument or failure path. The launcher
worked with an argument and died without one — and the no-argument form is what
the README shows.

## P-2 · Drive real source data before believing an adapter

Fixtures agree with your assumptions by construction. Running the TEGG adapter
against a real visit immediately exposed prose being treated as vocabulary.
That defect was invisible to 23 passing tests.

## P-3 · Prefer a zero with a stated reason over a plausible number

Applies to money, counts, confidence and severity. A wrong number that looks
right is the failure mode; a missing number with an explanation is not.

## P-4 · Enforce invariants in types, not in review

"Rates must come from config" is a comment. `Provenance.may_price` is a rule.
The second survives the next person.

## P-5 · A generated value may never price, approve, or send

It may propose. Crossing from proposal to fact requires configuration, a
comparable, or a named human — and the crossing is recorded.

## P-6 · Refuse rather than recover when the file is there but unreadable

The only reason to create an empty document is that **no file exists**. Every
other failure describes a file that *is* there and holds something. "Recovery"
that overwrites it is silent data loss.

## P-7 · An unattributable value is a defect, not a detail

Every number carries where it came from, specific enough to find again. A rate
with no config key cannot be checked, so it cannot price.

## P-8 · Never let documentation transcribe what code can generate

The runbook's exit-code table is generated and a test fails if they drift.

## P-9 · Say what you did not do

Every run's output states what it did not touch. Absence of a claim is not the
same as a stated refusal.

## P-10 · Founder knowledge is technical debt

Encode into configuration, validation, documentation, reusable code or
automation — or write down why it cannot yet be encoded. "Ask Jack" is a defect
with a person's name on it.

## P-11 · Report faithfully, including your own mistakes

If a test fails, say so with the output. If a claim was verified by the person
who wrote it, say that too. The second-machine caveat is repeated in every
handoff because it is the weakest claim in the project.
